import { env } from "cloudflare:test";
import { expect, it, vi, beforeEach } from "vitest";
import {
  getOverview,
  registerDelivery,
  handleMessengerAction,
} from "../../src/messenger/service";
import { createMessengerRepository } from "../../src/messenger/repository";
import type { Delivery, MessengerDeps } from "../../src/messenger/types";
import { connection, delivery, input } from "./fixtures";
beforeEach(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  await db.batch([
    db.prepare("DELETE FROM messenger_write_intents"),
    db.prepare("DELETE FROM messenger_action_tokens"),
  ]);
});
export function setup(initial: Delivery[] = []) {
  const rows = structuredClone(initial);
  let seq = 0;
  const api = {
    findProduct: vi.fn(async () => ({ recordId: "recProduct" })),
    findBySourceEvent: vi.fn(
      async (e: string) => rows.find((d) => d.sourceEventId === e) ?? null,
    ),
    findDuplicate: vi.fn(
      async (g: string, _day: string, p: string) =>
        rows.find((d) => d.sourceGroupId === g && d.productId === p) ?? null,
    ),
    get: vi.fn(async (r: string) =>
      structuredClone(rows.find((d) => d.recordId === r) ?? null),
    ),
    list: vi.fn(async () => structuredClone(rows)),
    create: vi.fn(async (d: typeof input) => {
      const row = {
        ...d,
        recordId: "recNew",
        status: "Pending" as const,
        completedAt: null,
        completedByUserId: null,
        completedByName: null,
      };
      rows.push(row);
      return structuredClone(row);
    }),
    complete: vi.fn(
      async (r: string, c: { at: string; userId: string; name: string }) => {
        const d = rows.find((d) => d.recordId === r)!;
        Object.assign(d, {
          status: "Done",
          completedAt: c.at,
          completedByUserId: c.userId,
          completedByName: c.name,
        });
        return structuredClone(d);
      },
    ),
  };
  const policy = {
    allowedGroupIds: ["C1"],
    completionUserIds: ["book"],
    connection,
  };
  const deps: MessengerDeps = {
    connection,
    airtable: api,
    repo: createMessengerRepository((env as unknown as { DB: D1Database }).DB),
    clock: { now: () => new Date("2026-11-14T04:00:00Z") },
    ids: { next: () => `token-${++seq}` },
    profile: vi.fn(async () => ({ displayName: "เจ" })),
    currentPolicy: async () => policy,
  };
  return { rows, api, deps, policy };
}
const command = {
  type: "mess-register" as const,
  productId: "A-2",
  scheduledAt: input.scheduledAt,
  scheduleType: "Scheduled" as const,
};
const source = {
  eventId: "e1",
  messageId: "m1",
  timestamp: Date.parse(input.registeredAt),
  quoteToken: "private-quote",
  groupId: "C1",
  userId: "staff",
};
it("registers sender identity and does not duplicate a redelivered event", async () => {
  const { deps, rows, api } = setup();
  await registerDelivery(command, source, deps);
  await registerDelivery(command, source, deps);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    responsibleUserId: "staff",
    responsibleName: "เจ",
    registeredAt: input.registeredAt,
  });
  expect(api.create).toHaveBeenCalledTimes(1);
});
it("reconciles timeout-after-success without another create", async () => {
  const { deps, api, rows } = setup();
  api.create.mockImplementationOnce(async (d) => {
    rows.push({ ...delivery, ...d });
    throw new Error("timeout");
  });
  await registerDelivery(command, source, deps);
  await registerDelivery(command, source, deps);
  expect(api.create).toHaveBeenCalledTimes(1);
});
it("does not retry an ambiguous create even when reconciliation finds nothing", async () => {
  const { deps, api } = setup();
  api.create.mockRejectedValue(new Error("timeout"));
  expect(await registerDelivery(command, source, deps)).toMatchObject({
    kind: "text",
    text: expect.stringContaining("ยังยืนยัน"),
  });
  await registerDelivery(command, source, deps);
  expect(api.create).toHaveBeenCalledTimes(1);
});
it("fails profile lookup before writes", async () => {
  const { deps, api } = setup();
  deps.profile = async () => {
    throw new Error("profile unavailable");
  };
  await expect(registerDelivery(command, source, deps)).rejects.toThrow();
  expect(api.create).not.toHaveBeenCalled();
});
it("retains Done among Pending in chronological order and computes all page totals", async () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({
    ...delivery,
    id: `d${i}`,
    recordId: `r${i}`,
    productId: `A-${i + 1}`,
    status: i % 2 === 0 ? ("Done" as const) : ("Pending" as const),
    completedAt: i % 2 === 0 ? "2026-11-14T03:00:00Z" : null,
    completedByUserId: i % 2 === 0 ? "book" : null,
    completedByName: i % 2 === 0 ? "Book" : null,
  }));
  const { deps } = setup(rows.reverse());
  const result = await getOverview("2026-11-14", 1, "C1", deps);
  expect(result).toMatchObject({
    kind: "overview",
    overview: { total: 7, done: 4 },
  });
  if (result.kind === "overview")
    expect(result.overview.items.map((d) => d.productId)).toEqual([
      "A-1",
      "A-2",
      "A-3",
      "A-4",
      "A-5",
    ]);
});
it("marks done only once and keeps it in every fresh overview including all-Done days", async () => {
  const { deps, api, rows } = setup([delivery]);
  const view = await getOverview("2026-11-14", 1, "C1", deps);
  if (view.kind !== "overview") throw new Error();
  const action = {
    kind: "complete" as const,
    token: view.overview.actions[delivery.id]!.complete!,
  };
  await Promise.all([
    handleMessengerAction(action, { groupId: "C1", userId: "book" }, deps),
    handleMessengerAction(action, { groupId: "C1", userId: "book" }, deps),
  ]);
  expect(api.complete).toHaveBeenCalledTimes(1);
  expect(rows[0]!.completedByUserId).toBe("book");
  const fresh = await getOverview("2026-11-14", 1, "C1", deps);
  expect(fresh).toMatchObject({
    kind: "overview",
    overview: { total: 1, done: 1, items: [{ status: "Done" }] },
  });
});
it("rejects old-card revoked users, cross-group actions and changed connections", async () => {
  const { deps, api, policy } = setup([delivery]);
  const v = await getOverview("2026-11-14", 1, "C1", deps);
  if (v.kind !== "overview") throw new Error();
  const action = {
    kind: "complete" as const,
    token: v.overview.actions[delivery.id]!.complete!,
  };
  policy.completionUserIds = [];
  expect(
    await handleMessengerAction(
      action,
      { groupId: "C1", userId: "book" },
      deps,
    ),
  ).toMatchObject({ kind: "text" });
  policy.completionUserIds = ["book"];
  await handleMessengerAction(action, { groupId: "C2", userId: "book" }, deps);
  policy.connection = { ...connection, baseId: "other" };
  await handleMessengerAction(action, { groupId: "C1", userId: "book" }, deps);
  expect(api.complete).not.toHaveBeenCalled();
});
it("quotes only the bound source task and notices missing quote tokens", async () => {
  const { deps, rows } = setup([delivery]);
  const v = await getOverview("2026-11-14", 1, "C1", deps);
  if (v.kind !== "overview") throw new Error();
  const action = {
    kind: "quote" as const,
    token: v.overview.actions[delivery.id]!.quote,
  };
  expect(
    await handleMessengerAction(
      action,
      { groupId: "C1", userId: "staff" },
      deps,
    ),
  ).toMatchObject({ kind: "quote", quoteToken: "private-quote" });
  rows[0]!.quoteToken = null;
  expect(
    await handleMessengerAction(
      action,
      { groupId: "C1", userId: "staff" },
      deps,
    ),
  ).toMatchObject({ kind: "text", text: expect.stringContaining("A-2") });
});
it("does not consume the sole dispatch when authorization is revoked before writing", async () => {
  const { deps, api, policy } = setup([delivery]);
  const view = await getOverview("2026-11-14", 1, "C1", deps);
  if (view.kind !== "overview") throw new Error();
  const action = {
    kind: "complete" as const,
    token: view.overview.actions[delivery.id]!.complete!,
  };
  let checks = 0;
  deps.currentPolicy = async () => ({
    ...policy,
    completionUserIds: ++checks === 2 ? [] : ["book"],
  });
  await handleMessengerAction(action, { groupId: "C1", userId: "book" }, deps);
  expect(api.complete).not.toHaveBeenCalled();
  deps.currentPolicy = async () => policy;
  await handleMessengerAction(action, { groupId: "C1", userId: "book" }, deps);
  expect(api.complete).toHaveBeenCalledTimes(1);
});
it("reports a confirmed save even when overview refresh fails", async () => {
  const { deps, api } = setup([delivery]);
  const view = await getOverview("2026-11-14", 1, "C1", deps);
  if (view.kind !== "overview") throw new Error();
  api.list.mockRejectedValue(new Error("offline"));
  expect(
    await handleMessengerAction(
      {
        kind: "complete",
        token: view.overview.actions[delivery.id]!.complete!,
      },
      { groupId: "C1", userId: "book" },
      deps,
    ),
  ).toMatchObject({
    kind: "text",
    text: expect.stringContaining("บันทึกสถานะเสร็จแล้ว"),
  });
});
it("recovers only by reading after a process interrupted between claim and dispatch response", async () => {
  const { deps, api } = setup();
  const { intent } = await deps.repo.claimRegistration({
    delivery: input,
    connection,
    day: "2026-11-14",
  });
  await deps.repo.beginDispatch(intent.id);
  await registerDelivery(command, source, deps);
  expect(api.create).not.toHaveBeenCalled();
});

it("rejects a provider duplicate outside the requested group instead of leaking its task", async () => {
  const { deps, api } = setup();
  api.findDuplicate.mockResolvedValue({
    ...delivery,
    sourceGroupId: "other",
    productId: "A-999",
  });
  await expect(registerDelivery(command, source, deps)).rejects.toThrow(
    "scope",
  );
  expect(api.create).not.toHaveBeenCalled();
});
