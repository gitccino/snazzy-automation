import { describe, expect, it } from "vitest";
import { parseSupportedLineEvents, type ParsedCommand, type SaleValues } from "../../src/line/types";

describe("LINE domain contracts", () => {
  it("keeps sold price as integer baht", () => {
    const command: ParsedCommand = { type: "soldout", productId: "A-1234", soldPrice: 1290 };
    const values: SaleValues = { inventoryStatus: "Out", soldPrice: 1290, soldAt: "2026-09-01T10:00:00.000Z", soldBy: "Mint (U1)" };
    expect(command.soldPrice).toBe(1290);
    expect(Number.isInteger(values.soldPrice)).toBe(true);
  });

  it("keeps only validated group text and postback events", () => {
    const events = parseSupportedLineEvents({ events: [
      { type: "message", webhookEventId: "e1", replyToken: "r1", source: { type: "group", groupId: "C1", userId: "U1" }, message: { type: "text", id: "m1", text: "/help" } },
      { type: "message", webhookEventId: "e2", replyToken: "r2", source: { type: "user", userId: "U1" }, message: { type: "text", id: "m2", text: "/help" } },
      { type: "postback", webhookEventId: "e3", replyToken: "r3", source: { type: "group", groupId: "C1", userId: "U1" }, postback: { data: "confirm:token-1" } },
    ] });
    expect(events.map((event) => event.webhookEventId)).toEqual(["e1", "e3"]);
  });
});
