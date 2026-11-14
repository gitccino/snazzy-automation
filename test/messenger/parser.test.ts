import { expect, it } from "vitest";
import {
  parseMessengerCommand,
  sanitizeMessengerEvent,
} from "../../src/messenger/parser";
import { parseSupportedLineEvents } from "../../src/line/types";
const ts = Date.parse("2026-11-13T16:59:00Z");
it.each([
  [
    "/mess\nพรุ่งนี้ 14:00 A-12977\n065 663 5369 (เจ)",
    "2026-11-14T07:00:00.000Z",
    "Scheduled",
  ],
  ["/mess แมสเลยค่า A-2", "2026-11-13T16:59:00.000Z", "Immediate"],
  ["/mess วันนี้ 09:00 A-10", "2026-11-13T02:00:00.000Z", "Scheduled"],
])(
  "resolves schedule from original event: %s",
  (text, scheduledAt, scheduleType) => {
    expect(parseMessengerCommand(text, ts)).toMatchObject({
      ok: true,
      command: { type: "mess-register", scheduledAt, scheduleType },
    });
  },
);
it("resolves tomorrow across year boundary", () => {
  expect(
    parseMessengerCommand(
      "/mess พรุ่งนี้ 14:00 A-2",
      Date.parse("2026-12-31T16:59:00Z"),
    ),
  ).toMatchObject({ command: { scheduledAt: "2027-01-01T07:00:00.000Z" } });
});
it.each([
  "/mess A-1",
  "/mess วันนี้ A-1",
  "/mess วันนี้ 24:00 A-1",
  "/mess วันนี้ 14:60 A-1",
  "/mess แมสเลย A-1 A-2",
  "/mess แมสเลย วันนี้ 14:00 A-1",
  "/mess แมสเลย A-0",
  "/mess แมสเลย A-9007199254740992",
  "/mess-overview 31/2/2026",
  "/mess-overview 14/11/2026 0",
  "/mess-overview 14/11/2026 9007199254740992",
  "/mess พรุ่งนี้ 14:00 วันนี้ A-1",
])("rejects invalid/ambiguous input %s", (text) => {
  expect(parseMessengerCommand(text, ts)).toEqual({
    ok: false,
    code: "invalid_messenger_command",
  });
});
it("does not default a missing event timestamp", () =>
  expect(parseMessengerCommand("/mess แมสเลย A-1", NaN)).toMatchObject({
    ok: false,
  }));
it.each([
  ["/mess-overview", "2026-11-13", 1],
  ["/mess-overview 2", "2026-11-13", 2],
])("parses overview %s", (text, day, page) =>
  expect(parseMessengerCommand(text, ts)).toEqual({
    ok: true,
    command: { type: "mess-overview", day, page },
  }),
);
it.each([
  "/mess\nแมสเลย A-1\n065 663 5369\nSTAY Hotel",
  "/mess\ninvalid\n065 663 5369\nSTAY Hotel",
])("removes pasted text before durable handoff %s", (text) => {
  const [event] = parseSupportedLineEvents({
    events: [
      {
        type: "message",
        timestamp: ts,
        webhookEventId: "e",
        replyToken: "r",
        source: { type: "group", groupId: "g", userId: "u" },
        message: { type: "text", id: "m", text, quoteToken: "private-token" },
      },
    ],
  });
  const safe = sanitizeMessengerEvent(event!);
  expect(JSON.stringify(safe)).not.toMatch(/065|STAY|invalid\\n/);
  expect(safe).toMatchObject({
    timestamp: ts,
    message: { id: "m", text: "/mess", quoteToken: "private-token" },
    messenger: { ok: expect.any(Boolean) },
  });
});
it("ignores other commands", () =>
  expect(parseMessengerCommand("/docs", ts)).toBeNull());

it.each([
  ["/mess 14:30 A-12977", "2026-11-13T16:59:00Z", "2026-11-13T07:30:00.000Z"],
  [
    "/mess\n14:30 A-12977\n065 663 5369\nSTAY Hotel",
    "2026-11-13T17:01:00Z",
    "2026-11-14T07:30:00.000Z",
  ],
])(
  "defaults a bare time to the original event Bangkok day: %s",
  (text, received, scheduledAt) => {
    expect(parseMessengerCommand(text, Date.parse(received))).toEqual({
      ok: true,
      command: {
        type: "mess-register",
        productId: "A-12977",
        scheduledAt,
        scheduleType: "Scheduled",
      },
    });
  },
);
it.each([
  "/mess 24:00 A-1",
  "/mess 14:60 A-1",
  "/mess 14:30 15:00 A-1",
  "/mess 14:30 พรุ่งนี้ 14:00 A-1",
  "/mess A-1\nappointment 14:30",
])("rejects invalid or ambiguous bare times: %s", (text) => {
  expect(parseMessengerCommand(text, ts)).toMatchObject({ ok: false });
});

it.each([
  "/mess-overview tomorrow",
  "/mess-overview 14/11/2026",
  "/mess-overview 14/11/2026 2",
  "/mess-overview 0",
  "/mess-overview 9007199254740992",
])("does not allow selecting another overview day: %s", (text) =>
  expect(parseMessengerCommand(text, ts)).toMatchObject({ ok: false }),
);
