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
    text: expect.stringContaining("บันทึกสถานะเสร็จสิ้น"),
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

it.each(["connection", "group", "disabled"])(
  "rechecks registration policy after profile lookup: %s",
  async (change) => {
    const { deps, api, policy } = setup();
    deps.profile = async () => {
      if (change === "connection")
        policy.connection = { ...connection, baseId: "different" };
      if (change === "group") policy.allowedGroupIds = [];
      if (change === "disabled")
        (policy as { connection: typeof connection | null }).connection = null;
      return { displayName: "เจ" };
    };
    await registerDelivery(command, source, deps);
    expect(api.create).not.toHaveBeenCalled();
    const { intent } = await deps.repo.claimRegistration({
      delivery: input,
      connection,
      day: "2026-11-14",
    });
    expect(intent.phase).toBe("prepared");
  },
);

it("keeps a confirmed completion successful when D1 observation bookkeeping fails", async () => {
  const { deps, api } = setup([delivery]);
  const view = await getOverview("2026-11-14", 1, "C1", deps);
  if (view.kind !== "overview") throw new Error();
  deps.repo.recordObserved = async () => {
    throw new Error("D1 unavailable");
  };
  const result = await handleMessengerAction(
    { kind: "complete", token: view.overview.actions[delivery.id]!.complete! },
    { groupId: "C1", userId: "book" },
    deps,
  );
  expect(api.complete).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    kind: "overview",
    overview: { done: 1, items: [{ status: "Done" }] },
  });
});

it("recovers registration uncertainty before fallible duplicate and profile lookups", async () => {
  const { deps, api } = setup();
  const { intent } = await deps.repo.claimRegistration({
    delivery: input,
    connection,
    day: "2026-11-14",
  });
  await deps.repo.beginDispatch(intent.id);
  api.findDuplicate.mockRejectedValue(new Error("provider offline"));
  api.findBySourceEvent.mockRejectedValue(new Error("provider offline"));
  await expect(registerDelivery(command, source, deps)).resolves.toMatchObject({
    kind: "text",
    text: expect.stringContaining("ยังยืนยัน"),
  });
  expect(api.create).not.toHaveBeenCalled();
  expect(api.findDuplicate).not.toHaveBeenCalled();
});

it("preserves completion uncertainty when a re-entry reconciliation read fails", async () => {
  const { deps, api } = setup([delivery]);
  const view = await getOverview("2026-11-14", 1, "C1", deps);
  if (view.kind !== "overview") throw new Error();
  const { intent } = await deps.repo.claimCompletion({
    deliveryId: delivery.id,
    recordId: delivery.recordId,
    groupId: "C1",
    connection,
    completion: { at: "2026-11-14T04:00:00Z", userId: "book", name: "Book" },
  });
  await deps.repo.beginDispatch(intent.id);
  api.get.mockRejectedValue(new Error("provider offline"));
  await expect(
    handleMessengerAction(
      {
        kind: "complete",
        token: view.overview.actions[delivery.id]!.complete!,
      },
      { groupId: "C1", userId: "book" },
      deps,
    ),
  ).resolves.toMatchObject({
    kind: "text",
    text: expect.stringContaining("ยังยืนยัน"),
  });
  expect(api.complete).not.toHaveBeenCalled();
});

it("does not let a failed profile lookup erase an existing completion write uncertainty", async () => {
  const { deps, api } = setup([delivery]);
  const view = await getOverview("2026-11-14", 1, "C1", deps);
  if (view.kind !== "overview") throw new Error();
  const { intent } = await deps.repo.claimCompletion({
    deliveryId: delivery.id,
    recordId: delivery.recordId,
    groupId: "C1",
    connection,
    completion: { at: "2026-11-14T04:00:00Z", userId: "book", name: "Book" },
  });
  await deps.repo.beginDispatch(intent.id);
  deps.profile = async () => {
    throw new Error("profile offline");
  };
  await expect(
    handleMessengerAction(
      {
        kind: "complete",
        token: view.overview.actions[delivery.id]!.complete!,
      },
      { groupId: "C1", userId: "book" },
      deps,
    ),
  ).resolves.toMatchObject({
    kind: "text",
    text: expect.stringContaining("ยังยืนยัน"),
  });
  expect(api.complete).not.toHaveBeenCalled();
});

it("preserves uncertainty when a concurrent completion claim wins before the second read", async () => {
  const { deps, api } = setup([delivery]);
  const view = await getOverview("2026-11-14", 1, "C1", deps);
  if (view.kind !== "overview") throw new Error();
  const { intent } = await deps.repo.claimCompletion({
    deliveryId: delivery.id,
    recordId: delivery.recordId,
    groupId: "C1",
    connection,
    completion: { at: "2026-11-14T04:00:00Z", userId: "book", name: "Book" },
  });
  await deps.repo.beginDispatch(intent.id);
  // Simulate another request winning after this request's initial intent lookup.
  deps.repo.findCompletion = async () => null;
  api.get
    .mockResolvedValueOnce(delivery)
    .mockRejectedValueOnce(new Error("offline"));
  await expect(
    handleMessengerAction(
      {
        kind: "complete",
        token: view.overview.actions[delivery.id]!.complete!,
      },
      { groupId: "C1", userId: "book" },
      deps,
    ),
  ).resolves.toMatchObject({
    kind: "text",
    text: expect.stringContaining("ยังยืนยัน"),
  });
  expect(api.complete).not.toHaveBeenCalled();
});

it("still reports a different command as a duplicate when it recovers the original intent", async () => {
  const { deps, api } = setup();
  await registerDelivery(command, source, deps);
  const result = await registerDelivery(
    command,
    { ...source, eventId: "different-command" },
    deps,
  );
  expect(result).toMatchObject({
    kind: "text",
    text: expect.stringContaining("มีรายการจัดส่ง"),
  });
  expect(api.create).toHaveBeenCalledTimes(1);
});

it("refreshes today after completing a task from an older card", async () => {
  const { deps, api } = setup([delivery]);
  const v = await getOverview("2026-11-14", 1, "C1", deps);
  if (v.kind !== "overview") throw new Error();
  deps.clock.now = () => new Date("2026-11-15T01:00:00Z");
  api.list.mockResolvedValue([]);
  await handleMessengerAction(
    { kind: "complete", token: v.overview.actions[delivery.id]!.complete! },
    { groupId: "C1", userId: "book" },
    deps,
  );
  expect(api.list).toHaveBeenLastCalledWith("C1", "2026-11-15");
});

async function completionAction(deps: MessengerDeps) {
  const view = await getOverview("2026-11-14", 1, "C1", deps);
  if (view.kind !== "overview") throw new Error("Missing overview");
  return {
    kind: "complete" as const,
    token: view.overview.actions[delivery.id]!.complete!,
  };
}
const book = { groupId: "C1", userId: "book" };
it.each([false, true])(
  "completes a manually reopened delivery once, preserving history (clear metadata: %s)",
  async (clear) => {
    const { deps, rows, api } = setup([delivery]);
    const oldAction = await completionAction(deps);
    await handleMessengerAction(oldAction, book, deps);
    const first = (await deps.repo.findCompletion(
      connection,
      delivery.recordId,
    ))!;
    rows[0]!.status = "Pending";
    if (clear)
      Object.assign(rows[0]!, {
        completedAt: null,
        completedByUserId: null,
        completedByName: null,
      });
    expect(await handleMessengerAction(oldAction, book, deps)).toMatchObject({
      kind: "text",
      text: expect.stringContaining("/mess-overview"),
    });
    expect(api.complete).toHaveBeenCalledTimes(1);
    deps.clock.now = () => new Date("2026-11-14T05:00:00Z");
    const fresh = await completionAction(deps);
    await Promise.all([
      handleMessengerAction(fresh, book, deps),
      handleMessengerAction(fresh, book, deps),
    ]);
    expect(api.complete).toHaveBeenCalledTimes(2);
    expect(rows[0]).toMatchObject({
      status: "Done",
      completedAt: "2026-11-14T05:00:00.000Z",
    });
    const current = (await deps.repo.findCompletion(
      connection,
      delivery.recordId,
    ))!;
    expect(current.id).not.toBe(first.id);
    const history = await (env as unknown as { DB: D1Database }).DB.prepare(
      "SELECT phase,payload_json FROM messenger_write_intents WHERE id=?",
    )
      .bind(first.id)
      .first<{ phase: string; payload_json: string }>();
    expect(history?.phase).toBe("observed");
    expect(JSON.parse(history!.payload_json).completion).toEqual(
      first.completion,
    );
  },
);
it.each([false, true])(
  "does not confirm an uncertain save after manual Done (unrelated metadata: %s)",
  async (withMetadata) => {
    const { deps, rows, api } = setup([delivery]);
    const action = await completionAction(deps);
    api.complete.mockRejectedValue(new Error("timeout"));
    await handleMessengerAction(action, book, deps);
    rows[0]!.status = "Done";
    if (withMetadata)
      Object.assign(rows[0]!, {
        completedAt: "2026-11-14T04:00:00Z",
        completedByUserId: "other",
        completedByName: "Manual editor",
      });
    expect(await handleMessengerAction(action, book, deps)).toMatchObject({
      kind: "overview",
      overview: { done: 1 },
    });
    expect(
      (await deps.repo.findCompletion(connection, delivery.recordId))!.phase,
    ).toBe("dispatched");
    rows[0]!.status = "Pending";
    const fresh = await completionAction(deps);
    expect(await handleMessengerAction(fresh, book, deps)).toMatchObject({
      kind: "text",
      text: expect.stringContaining("ยังยืนยัน"),
    });
    expect(api.complete).toHaveBeenCalledTimes(1);
  },
);
