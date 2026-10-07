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
    ["/soldout ❤️ แมส 14.30 ❤️\n\nปลายทาง\n\n[ชื่อ]\n[ที่อยู่]\n[เบอร์]\n\n❤️รหัสสินค้า A-14❤️\nUsed like new\n\n[รายละเอียดสินค้า] 14000 บาท", { type: "soldout", productId: "A-14", soldPrice: 14000 }],
    ["/soldout ❤️A-14❤️ ราคาขาย 14000 ค่าแมส 82 บาท", { type: "soldout", productId: "A-14", soldPrice: 14000 }],
    ["/soldout\n" + String.raw`❤️ แมส 14.30 ❤️\n\nปลายทาง\n\n[ชื่อ]\n[ที่อยู่]\n[เบอร์]\n\n❤️รหัสสินค้า A-14❤️\nUsed like new\n\n[รายละเอียดสินค้า] 14000 บาท`, { type: "soldout", productId: "A-14", soldPrice: 14000 }],
  ])("parses %s", (text, expected) => expect(parseLineCommand(text)).toEqual({ ok: true, command: expected }));

  it.each([
    ["/soldout thb 1290", "missing_product_id"],
    ["/soldout A01234 thb 1290", "invalid_product_id"],
    ["/soldout A 1234 thb 1290", "invalid_product_id"],
    ["/soldout A-1-2 thb 1290", "invalid_product_id"],
    ["/soldout A-1.2 thb 1290", "invalid_product_id"],
    ["/soldout ❤️รหัสสินค้า A-1❤️4❤️ 14000 บาท", "invalid_product_id"],
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

 it("parses report dates/pages and rejects impossible dates or unsafe pages", () => {
  expect(parseLineCommand("/report")).toEqual({ ok: true, command: { type: "report", page: 1 } });
  expect(parseLineCommand(" /report 7/10/2026 2 ")).toEqual({ ok: true, command: { type: "report", reportDate: "2026-10-07", page: 2 } });
  expect(parseLineCommand("/report 29/2/2028")).toEqual({ ok: true, command: { type: "report", reportDate: "2028-02-29", page: 1 } });
  for (const input of ["/report 29/2/2026", "/report 31/4/2026", "/report 7/10/0000", "/report 7/10/2026 0", "/report 7/10/2026 -1", "/report 7/10/2026 1.5", "/report 7/10/2026 9007199254740992", "/report 7/10/2026 2 extra", "/report 2"]) {
    expect(parseLineCommand(input)).toEqual({ ok: false, code: "invalid_report_command" });
  }
});
