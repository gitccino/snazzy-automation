import { expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { prepareMessengerReply } from "../../src/messenger/line";
import { createMessengerAirtable } from "../../src/messenger/airtable";
import { createMessengerRepository } from "../../src/messenger/repository";
import { connection } from "./fixtures";
it("ignores an old persisted overview date and queries today", async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL) =>
    Response.json({ records: [] }),
  );
  const result = await prepareMessengerReply(
    {
      type: "message",
      webhookEventId: "old-overview",
      replyToken: "r",
      source: { type: "group", groupId: "C1", userId: "staff" },
      message: { type: "text", id: "m", text: "/mess-overview" },
      messenger: {
        ok: true,
        command: { type: "mess-overview", day: "2026-11-15", page: 1 },
      },
    },
    {
      connection,
      airtable: createMessengerAirtable({
        connection,
        token: "test",
        fetch: fetcher,
      }),
      repo: createMessengerRepository(
        (env as unknown as { DB: D1Database }).DB,
      ),
      clock: { now: () => new Date("2026-11-14T04:00:00Z") },
      ids: { next: () => crypto.randomUUID() },
      profile: async () => ({ displayName: "Staff" }),
      currentPolicy: async () => ({
        allowedGroupIds: ["C1"],
        completionUserIds: [],
        connection,
      }),
    },
  );
  const formula = new URL(String(fetcher.mock.calls[0]![0])).searchParams.get(
    "filterByFormula",
  );
  expect(formula).toContain("2026-11-14T00:00:00+07:00");
  expect(result).toMatchObject({
    kind: "flex",
    text: expect.stringContaining("แมสเซนเจอร์วันนี้"),
  });
});
