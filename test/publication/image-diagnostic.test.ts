import { describe, expect, it } from "vitest";
import { imageFailureGuidance } from "../../src/publication/image-diagnostic";

describe("image failure guidance", () => {
  it.each([
    ["product_image_source_changed", "รูปใน Airtable เปลี่ยน"],
    ["product_image_unresolved_preview", "คืนรูปต้นฉบับ"],
    ["product_image_original_missing", "ไม่พบรูปต้นฉบับ"],
    ["product_image_too_large", "20 MB"],
    ["product_image_format_invalid", "JPEG"],
    ["product_image_preview_invalid", "รูปตัวอย่าง"],
    ["product_image_busy", "งานอื่น"],
    ["product_image_owner_unknown", "ตรวจสอบสถานะงาน"],
  ])("retains safe guidance for %s", (code, expected) => {
    expect(imageFailureGuidance({ productId: "A-1001", position: 0, code })).toContain(expected);
  });
  it("rejects unsafe identifiers and never renders unknown codes", () => {
    expect(imageFailureGuidance({ productId: "https://private.example", position: 0, code: "product_image_too_large" })).toBeNull();
    expect(imageFailureGuidance({ productId: "A-1001", position: 0, code: "secret_token" })).not.toContain("secret_token");
    expect(imageFailureGuidance({ productId: "A-1001", position: 0, code: "constructor" })).toContain("เตรียมรูปไม่สำเร็จ");
  });
});

it('does not instruct a retry before owner review', () => {
  for (const code of ['product_image_source_changed','product_image_unresolved_preview','product_image_busy','product_image_owner_unknown','unknown']) {
    expect(imageFailureGuidance({productId:'A-1001',position:0,code})).not.toContain('/docs');
  }
});
