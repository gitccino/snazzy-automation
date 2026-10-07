import { expect, it } from "vitest";
import { dailySalesReportCard } from "../../src/line/report-card";
import type { DailySaleProduct } from "../../src/line/types";

const products: DailySaleProduct[] = Array.from({ length: 11 }, (_, i) => ({
  recordId: `rec${i + 1}`, productId: `A-${i + 1}`, brandName: "CHANEL", modelName: "Classic",
  soldPrice: 100, soldAt: "2026-10-07T07:00:00Z",
}));

it("paginates in numeric ID order and keeps complete daily totals and explicit navigation dates", () => {
  const reversed = [...products].reverse();
  const first = dailySalesReportCard(reversed, "2026-10-07", 1, true);
  const second = dailySalesReportCard(reversed, "2026-10-07", 2, true);
  const json = JSON.stringify(first);
  expect(json).toContain("/report 07/10/2026 2");
  expect(json.indexOf('"text":"A-2"')).toBeLessThan(json.indexOf('"text":"A-10"'));
  expect(JSON.stringify(second)).toContain("A-11");
  expect(JSON.stringify(second)).toContain("1,100 บาท");
  expect(JSON.stringify(second)).toContain("11 รายการ");
  expect(JSON.stringify(second)).toContain("/report 07/10/2026 1");
  expect(reversed[0]!.productId).toBe("A-11");
});

it("renders zero sales, missing names, long names, and invalid pages safely", () => {
  expect(JSON.stringify(dailySalesReportCard([], "2026-10-07", 1, true))).toContain("ไม่มีรายการขายในวันนี้");
  expect(JSON.stringify(dailySalesReportCard([], "2026-10-07", 1, false))).toContain("ไม่มีรายการขายในวันที่เลือก");
  expect(JSON.stringify(dailySalesReportCard([], "2026-10-07", 1, true))).toContain("0 บาท");
  const product = { ...products[0]!, brandName: null, modelName: "ก💚".repeat(100) };
  const json = JSON.stringify(dailySalesReportCard([product], "2026-10-07", 1, true));
  expect(json).toContain("ไม่พบข้อมูล"); expect(json).toContain("…");
  expect(json).not.toContain(product.modelName);
  expect(new TextEncoder().encode(json).length).toBeLessThan(30000);
  expect(dailySalesReportCard(products, "2026-10-07", 3, true)).toContain("/report 07/10/2026");
});

it("rejects unsafe totals and invalid prices", () => {
  expect(() => dailySalesReportCard([{ ...products[0]!, soldPrice: Number.MAX_SAFE_INTEGER }, products[1]!], "2026-10-07", 1, true)).toThrow("Invalid daily sales total");
  expect(() => dailySalesReportCard([{ ...products[0]!, soldPrice: 0 }], "2026-10-07", 1, true)).toThrow("Invalid daily sales total");
});
