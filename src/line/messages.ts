import type { ValidationResult } from "../publication/validator";
import type { InventoryProduct, ParseErrorCode, SaleValues } from "./types";
import { formatValidationErrorSummary } from "../publication/validator";

export function buildPublicationSuccessMessage(input: {
  thaiDate: string;
  productIds: string[];
  googleDocUrl: string;
}): string {
  return [
    `วันที่: ${input.thaiDate}`,
    "การดำเนินการ: สร้างเอกสารเผยแพร่สำเร็จ",
    `จำนวนสินค้า: ${input.productIds.length}`,
    `รหัสสินค้า: ${input.productIds.join(", ")}`,
    `ลิงก์เอกสาร: ${input.googleDocUrl}`,
  ].join("\n");
}

export function buildPublicationValidationFailureMessage(input: {
  thaiDate: string;
  validation: ValidationResult;
  airtableRunUrl: string;
}): string {
  return [
    `วันที่: ${input.thaiDate}`,
    "การดำเนินการ: สร้างเอกสารเผยแพร่ล้มเหลว (ข้อมูลไม่ครบ)",
    "สินค้าที่ข้อมูลไม่ครบ:",
    formatValidationErrorSummary(input.validation),
    `ลิงก์ Airtable: ${input.airtableRunUrl}`,
    "แก้ไขข้อมูลให้ครบ ตั้งสถานะเป็น Ready แล้วส่งคำสั่ง /docs อีกครั้ง",
  ].join("\n");
}

export function buildPublicationWorkflowFailureMessage(input: {
  thaiDate: string;
  reason: string;
  airtableRunUrl: string;
}): string {
  return [
    `วันที่: ${input.thaiDate}`,
    "การดำเนินการ: สร้างเอกสารเผยแพร่ล้มเหลว",
    `สาเหตุ: ${input.reason}`,
    `ลิงก์ Airtable: ${input.airtableRunUrl}`,
    "ส่งคำสั่ง /docs เพื่อลองใหม่",
  ].join("\n");
}

const oldValue = (value: string | number | null) => value === null ? "ไม่พบข้อมูลเดิม" : String(value);

export function helpText(): string {
  return [
    "คำสั่งที่ใช้ได้",
    "/search 1234 (หรือ A1234, a1234, A-1234)",
    "/upload",
    "/docs",
    "/docs 3/10/2026 (วัน/เดือน/ปี ค.ศ.)",
    "/soldout A-1234 ราคา 1,290 บาท",
    "/revert",
  ].join("\n");
}

export function parseErrorText(code: ParseErrorCode): string {
  const messages: Record<ParseErrorCode, string> = {
    unknown_command: "ไม่รู้จักคำสั่ง ใช้ /help",
    missing_product_id: "ไม่พบรหัสสินค้า ตัวอย่าง A-1234",
    invalid_product_id: "รูปแบบรหัสไม่ถูกต้อง ใช้ A-1234, รหัส 1234 หรือ รหัสสินค้า 1234",
    multiple_product_ids: "กรุณาระบุรหัสสินค้าเพียงหนึ่งรหัส",
    missing_price: "ไม่พบราคาขาย ตัวอย่าง ราคา 1,290 บาท",
    invalid_price: "ราคาต้องเป็นจำนวนเต็มบาท เช่น THB 1,290",
    invalid_publication_date: "วันที่ไม่ถูกต้อง ใช้ /docs วัน/เดือน/ปี ค.ศ. เช่น /docs 3/10/2026",
    multiple_prices: "กรุณาระบุราคาเดียว",
  };
  return messages[code];
}

export const actorText = (displayName: string, userId: string) => `${displayName} (${userId})`;

export function searchText(product: InventoryProduct): string {
  return [
    `สินค้า ${product.productId}`,
    `สถานะ: ${product.inventoryStatus}`,
    `วันที่อัปโหลด: ${product.uploadDate ?? "ไม่พบข้อมูล"}`,
    product.airtableUrl,
  ].join("\n");
}

export const notFoundText = (productId: string) => `ไม่พบสินค้า ${productId}`;

export function alreadyOutText(product: InventoryProduct): string {
  return [
    `สินค้า ${product.productId} เป็น Out อยู่แล้ว`,
    `ราคาขาย: ${oldValue(product.soldPrice)}`,
    `ขายเมื่อ: ${oldValue(product.soldAt)}`,
    `บันทึกโดย: ${oldValue(product.soldBy)}`,
    product.airtableUrl,
  ].join("\n");
}

export function saleValuesText(values: SaleValues): string {
  return [
    `สถานะ: ${values.inventoryStatus}`,
    `ราคาขาย: ${oldValue(values.soldPrice)}`,
    `ขายเมื่อ: ${oldValue(values.soldAt)}`,
    `บันทึกโดย: ${oldValue(values.soldBy)}`,
  ].join("\n");
}
