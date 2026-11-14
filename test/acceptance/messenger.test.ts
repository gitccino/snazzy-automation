import { afterEach, expect, it, vi } from "vitest";
import { handleLineRoute } from "../../src/routes/line";
import { loadSettingsSnapshot } from "../../src/settings/runtime";
import { LineCommandWorkflow } from "../../src/line/command-workflow";
import type { Env } from "../../src/env";
import type { SupportedLineEvent } from "../../src/line/types";
import { createTestEnv, testEnv } from "../helpers/env";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("registers through sanitized Workflow handoff and retains completed items after a failed reply", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-14T04:00:00Z"));
  const book = "U" + "a".repeat(32),
    staff = "U" + "b".repeat(32),
    group = "CtestGroup";
  const config = JSON.parse(createTestEnv().APP_CONFIG_JSON);
  Object.assign(config, {
    AIRTABLE_MESSENGER_DELIVERIES_TABLE_ID: "tblMess",
    MESSENGER_COMPLETION_USER_IDS: [book],
  });
  const tasks: { id: string; fields: Record<string, any> }[] = [],
    sent: any[] = [],
    queue: any[] = [];
  let failSend = false;
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (raw, init) => {
      const url = new URL(String(raw)),
        body = init?.body ? JSON.parse(String(init.body)) : null;
      if (url.hostname === "api.airtable.com") {
        if (url.pathname.endsWith("/tblProducts"))
          return Response.json({
            records: [{ id: "recProduct", fields: { "Product ID": "A-2" } }],
          });
        if (init?.method === "POST") {
          const row = { id: `rec${tasks.length + 1}`, fields: body.fields };
          tasks.push(row);
          return Response.json(row);
        }
        const record = tasks.find((d) => url.pathname.endsWith("/" + d.id));
        if (init?.method === "PATCH") {
          Object.assign(record!.fields, body.fields);
          return Response.json(record);
        }
        if (record) return Response.json(record);
        const formula = url.searchParams.get("filterByFormula") ?? "";
        let found = tasks.filter((d) => {
          for (const key of [
            "Source Event ID",
            "Source Group ID",
            "Product ID",
          ]) {
            const m = new RegExp("\\{" + key + "\\}='([^']+)'").exec(formula);
            if (m && d.fields[key] !== m[1]) return false;
          }
          const day = /(\d{4}-\d{2}-\d{2})T00:00:00\+07:00/.exec(formula)?.[1];
          return (
            !day ||
            new Date(Date.parse(d.fields["Scheduled At"]) + 7 * 3600_000)
              .toISOString()
              .slice(0, 10) === day
          );
        });
        if (found.length > 1 && !url.searchParams.has("offset"))
          return Response.json({
            records: found.slice(0, 1),
            offset: "second",
          });
        if (url.searchParams.has("offset")) found = found.slice(1);
        return Response.json({ records: found });
      }
      if (url.pathname.includes("/member/"))
        return Response.json({
          userId: url.pathname.split("/").at(-1),
          displayName: url.pathname.endsWith(book) ? "Book" : "เจ",
        });
      if (url.hostname === "api.line.me") {
        if (failSend) {
          failSend = false;
          throw new Error("simulated response loss");
        }
        sent.push(body);
        return Response.json({});
      }
      throw new Error("Unexpected external request");
    });
  const env = {
    ...testEnv(),
    ...createTestEnv(),
    LINE_CHANNEL_SECRET: "test-secret",
    CONFIGURATION_MODE: "legacy",
    APP_CONFIG_JSON: JSON.stringify(config),
    LINE_COMMAND_WORKFLOW: {
      createBatch: async (batch: unknown[]) => {
        queue.push(...batch);
        return [];
      },
    },
  } as unknown as Env;
  let n = 0;
  const step = {
    do: async (_name: string, a: any, b?: any) => (b ?? a)(),
    sleep: async () => {},
  };
  async function command(
    text: string,
    userId = staff,
    otherGroup = group,
    eventId?: string,
  ) {
    const id = eventId ?? `event-${++n}`;
    const event = {
      type: "message",
      timestamp: Date.parse("2026-11-14T01:00:00Z"),
      webhookEventId: id,
      replyToken: "reply-" + id,
      source: { type: "group", groupId: otherGroup, userId },
      message: {
        type: "text",
        id: "m-" + id,
        text,
        quoteToken: "private-quote",
      },
    };
    const body = new TextEncoder().encode(JSON.stringify({ events: [event] }));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.LINE_CHANNEL_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = btoa(
      String.fromCharCode(
        ...new Uint8Array(await crypto.subtle.sign("HMAC", key, body)),
      ),
    );
    const response = await handleLineRoute(
      new Request("https://worker/line/webhook", {
        method: "POST",
        headers: { "x-line-signature": sig },
        body,
      }),
      env,
      { waitUntil() {} } as any,
    );
    expect(response.status).toBe(200);
    while (queue.length) {
      const item = queue.shift();
      expect(JSON.stringify(item.params)).not.toMatch(
        /065 663 5369|STAY Hotel/,
      );
      await run(item.params.event, item.params.context, id);
    }
  }
  async function run(event: SupportedLineEvent, context: any, id: string) {
    return LineCommandWorkflow.prototype.run.call(
      { env } as unknown as LineCommandWorkflow,
      { payload: { event, context }, instanceId: id } as any,
      step as any,
    );
  }
  await command(
    "/mess\nแมสเลยค่า A-2\n065 663 5369 (เจ)\nSTAY Hotel",
    staff,
    group,
    "first",
  );
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.fields).toMatchObject({
    "Responsible Name": "เจ",
    Status: "Pending",
  });
  await command("/mess\nแมสเลยค่า A-2", staff, group, "first");
  expect(tasks).toHaveLength(1);
  await command("/mess พรุ่งนี้ 14:00 A-2");
  expect(tasks).toHaveLength(2);
  await command("/mess วันนี้ 13:00 A-10");
  expect(tasks).toHaveLength(3);
  await command("/mess-overview");
  const flex = sent.at(-1).messages[0];
  expect(flex.type).toBe("flex");
  function findComplete(v: any): string | undefined {
    if (v?.action?.data?.includes("messenger=complete")) return v.action.data;
    if (v && typeof v === "object")
      for (const value of Object.values(v)) {
        const found = findComplete(value);
        if (found) return found;
      }
    return undefined;
  }
  const data = findComplete(flex)!;
  expect(data).toBeTruthy();
  const context = {
    settings: await loadSettingsSnapshot(env),
    replyGroupId: group,
  };
  const postback = (userId: string, id: string): SupportedLineEvent => ({
    type: "postback",
    webhookEventId: id,
    replyToken: "reply-" + id,
    source: { type: "group", groupId: group, userId },
    postback: { data },
  });
  await run(postback(staff, "denied"), context, "denied");
  expect(tasks[0]!.fields.Status).toBe("Pending");
  failSend = true;
  await run(postback(book, "complete"), context, "complete");
  expect(tasks[0]!.fields.Status).toBe("Done");
  const completedAt = tasks[0]!.fields["Completed At"];
  await run(postback(book, "again"), context, "again");
  expect(tasks[0]!.fields["Completed At"]).toBe(completedAt);
  await command("/mess-overview");
  expect(JSON.stringify(sent.at(-1))).toContain("✓ เสร็จสิ้น");
  expect(JSON.stringify(sent.at(-1))).toContain("A-2");
  const secondData = findComplete(sent.at(-1).messages[0])!;
  expect(secondData).toBeTruthy();
  const second = postback(book, "second-completion");
  if (second.type === "postback") second.postback.data = secondData;
  await run(second, context, "second-completion");
  await command("/mess-overview");
  expect(JSON.stringify(sent.at(-1))).toContain("2 รายการ · เสร็จสิ้น 2");
  expect(JSON.stringify(sent.at(-1))).toContain("A-10");
  // Airtable edits are authoritative; old cards cannot complete a reopened cycle.
  Object.assign(tasks[0]!.fields, {
    Status: "Pending",
    "Scheduled At": "2026-11-14T08:00:00Z",
    "Responsible Name": "Edited staff",
  });
  delete tasks[0]!.fields["Completed At"];
  delete tasks[0]!.fields["Completed By User ID"];
  delete tasks[0]!.fields["Completed By Name"];
  await run(
    postback(book, "stale-after-reopen"),
    context,
    "stale-after-reopen",
  );
  expect(JSON.stringify(sent.at(-1))).toContain("ข้อมูลรายการเปลี่ยนแล้ว");
  expect(tasks[0]!.fields.Status).toBe("Pending");
  await command("/mess-overview");
  expect(JSON.stringify(sent.at(-1))).toContain("Edited staff");
  expect(JSON.stringify(sent.at(-1))).toContain("15:00");
  const reopened = postback(book, "reopened");
  if (reopened.type === "postback")
    reopened.postback.data = findComplete(sent.at(-1).messages[0])!;
  vi.setSystemTime(new Date("2026-11-14T05:00:00Z"));
  await run(reopened, context, "reopened");
  expect(tasks[0]!.fields).toMatchObject({
    Status: "Done",
    "Completed At": "2026-11-14T05:00:00.000Z",
    "Responsible Name": "Edited staff",
    "Scheduled At": "2026-11-14T08:00:00Z",
  });
  expect(tasks[0]!.fields["Completed At"]).not.toBe(completedAt);
  await command(
    "/mess\nรหัส A-12676\n🛵 แมส 14.30 ค่าแมสปลายทาง\n065 663 5369\nSTAY Hotel",
  );
  expect(tasks.at(-1)!.fields).toMatchObject({
    "Product ID": "A-12676",
    "Scheduled At": "2026-11-14T07:30:00.000Z",
    "Schedule Type": "Scheduled",
    "Responsible Name": "เจ",
    Status: "Pending",
  });
  const before = sent.length;
  await command("/mess-overview", staff, "C-other");
  expect(sent.length).toBe(before);
  expect(
    tasks.every(
      (d) => !("Inventory Status" in d.fields) && !("Sold Price" in d.fields),
    ),
  ).toBe(true);
  expect(JSON.stringify(tasks)).not.toMatch(/065 663 5369|STAY Hotel/);
  expect(fetcher).toHaveBeenCalled();
});
