import { z } from "zod";

const reasons: Record<string, string> = {
  product_image_source_changed: "รูปใน Airtable เปลี่ยนระหว่างเตรียม กรุณาตรวจสอบรูปแล้วลอง /docs อีกครั้ง",
  product_image_unresolved_preview: "รูปตัวอย่างยังจับคู่ต้นฉบับไม่ได้ กรุณาคืนรูปต้นฉบับใน Airtable แล้วลอง /docs อีกครั้ง",
  product_image_original_missing: "ไม่พบรูปต้นฉบับใน R2 กรุณาตรวจสอบรูปสินค้า",
  product_image_too_large: "ไฟล์รูปใหญ่เกิน 20 MB กรุณาใช้ JPEG ขนาดไม่เกิน 20 MB",
  product_image_format_invalid: "ไฟล์รูปต้องเป็น JPEG",
  product_image_preview_invalid: "สร้างรูปตัวอย่างไม่ได้ กรุณาตรวจสอบไฟล์ JPEG",
  product_image_busy: "มีงานอื่นกำลังเตรียมรูปสินค้า กรุณาลอง /docs อีกครั้ง",
  product_image_owner_unknown: "ตรวจสอบสถานะงานเตรียมรูปไม่ได้ กรุณาลอง /docs อีกครั้ง",
};

const schema = z.object({ productId: z.string().max(100).regex(/^A-\d+$/), position: z.number().int().nonnegative().max(999).nullable(), code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/) });
export type ImageDiagnostic = z.infer<typeof schema>;
export function parseImageDiagnostic(value: unknown): ImageDiagnostic | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export function imageFailureGuidance(value: unknown): string | null {
  const diagnostic = parseImageDiagnostic(value);
  if (!diagnostic) return null;
  const { productId, position, code } = diagnostic;
  return `${productId}${position === null ? "" : `: รูปที่ ${position + 1}`} — ${(Object.hasOwn(reasons, code) ? reasons[code] : undefined) ?? "เตรียมรูปไม่สำเร็จ กรุณาตรวจสอบ Airtable แล้วลอง /docs อีกครั้ง"}`;
}
