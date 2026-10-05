import { describe, expect, it } from "vitest";
import { parseLineCommand } from "../../src/line/parser";

describe("parseLineCommand", () => {
  it.each([
    ["/help", { type: "help" }],
    [" /upload ", { type: "upload" }],
    ["/docs", { type: "docs" }],
    ["/revert", { type: "revert" }],
    ["/search A-1234", { type: "search", productId: "A-1234" }],
    ["/soldout A-1234 thb 1290", { type: "soldout", productId: "A-1234", soldPrice: 1290 }],
    ["/soldout รหัส 1234 THB 1,290", { type: "soldout", productId: "A-1234", soldPrice: 1290 }],
    ["/soldout รหัสสินค้า 1234 ราคา 1,290 บาท", { type: "soldout", productId: "A-1234", soldPrice: 1290 }],
  ])("parses %s", (text, expected) => expect(parseLineCommand(text)).toEqual({ ok: true, command: expected }));

  it.each([
    ["/soldout thb 1290", "missing_product_id"],
    ["/soldout A01234 thb 1290", "invalid_product_id"],
    ["/soldout A 1234 thb 1290", "invalid_product_id"],
    ["/soldout A-1-2 thb 1290", "invalid_product_id"],
    ["/soldout A-1.2 thb 1290", "invalid_product_id"],
    ["/soldout A-1 A-02 thb 1290", "invalid_product_id"],
    ["/soldout A-1 รหัส 02 thb 1290", "invalid_product_id"],
    ["/soldout รหัสสินค้า 1.2 thb 1290", "invalid_product_id"],
    ["/search A-1-2", "invalid_product_id"],
    ["/search A-1 A-02", "invalid_product_id"],
    ["/search A-1xyz", "invalid_product_id"],
    ["/soldout A-1 A-2 thb 1290", "multiple_product_ids"],
    ["/soldout A-1", "missing_price"],
    ["/soldout A-1 thb 12.50", "invalid_price"],
    ["/soldout A-1 thb 0", "invalid_price"],
    ["/soldout A-1 thb 100foo", "invalid_price"],
    ["/soldout A-1 ราคา 100xxx", "invalid_price"],
    ["/soldout A-1 THB 100 บาทfoo", "multiple_prices"],
    ["/soldout A-1 THB 100-200", "invalid_price"],
    ["/soldout A-1 thb 100 ราคา 200", "multiple_prices"],
    ["/soldout-extra A-1 thb 100", "unknown_command"],
    ["/unknown", "unknown_command"],
  ])("rejects %s", (text, code) => expect(parseLineCommand(text)).toEqual({ ok: false, code }));
});
