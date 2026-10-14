import { describe, expect, it } from "vitest";
import {
  alreadyOutText,
  helpText,
  parseErrorText,
  searchText,
} from "../../src/line/messages";

describe("LINE Thai messages", () => {
  it("shows that legacy sold-out values are unavailable instead of inventing them", () => {
    expect(alreadyOutText({
      recordId: "r",
      productId: "A-1",
      uploadDate: null,
      airtableUrl: "https://airtable.com/r",
      inventoryStatus: "Out",
      soldPrice: null,
      soldAt: null,
      soldBy: null,
    })).toContain("ไม่พบข้อมูลเดิม");
  });

  it("gives operators an accepted sold-out command example", () => {
    expect(helpText()).toContain("/soldout A-1234 ราคา 1,290 บาท");
  });

  it("asks users to label the sale price when a sold-out command contains several amounts", () => {
    expect(parseErrorText("multiple_prices")).toBe("⚠️ พบหลายยอดเงินหรือข้อความราคาไม่ชัดเจน\nกรุณาใช้คำว่า \"ราคาขาย\" ก่อนราคาสินค้า เช่น ราคาขาย 12,000 บาท");
  });

  it("shows searchable inventory fields without sale details", () => {
    const text = searchText({
      recordId: "rec-1",
      productId: "A-1234",
      inventoryStatus: "In",
      uploadDate: null,
      soldPrice: null,
      soldAt: null,
      soldBy: null,
      airtableUrl: "https://airtable.com/rec-1",
    });

    expect(text).toContain("สินค้า A-1234");
    expect(text).toContain("สถานะ: In");
    expect(text).toContain("วันที่อัปโหลด: ไม่พบข้อมูล");
    expect(text).toContain("https://airtable.com/rec-1");
  });
});
