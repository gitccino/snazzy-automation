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
    unknown_command: "⚠️ ไม่รู้จักคำสั่ง ใช้ /help",
    missing_product_id: "⚠️ ไม่พบรหัสสินค้า",
    invalid_product_id: "⚠️ รูปแบบรหัสไม่ถูกต้อง",
    multiple_product_ids: "⚠️ กรุณาระบุรหัสสินค้าเพียงหนึ่งรหัส",
    missing_price: "⚠️ ไม่พบราคาขาย",
    invalid_price: "⚠️ รูปแบบราคาขายไม่ถูกต้อง",
    invalid_publication_date: "วันที่ไม่ถูกต้อง ใช้ /docs วัน/เดือน/ปี ค.ศ. เช่น /docs 3/10/2026",
    multiple_prices: "⚠️ พบหลายยอดเงินหรือข้อความราคาไม่ชัดเจน",
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

export const notFoundText = (productId: string) => `⚠️ ไม่พบสินค้า ${productId}`;

export function alreadyOutText(product: InventoryProduct): string {
  const soldAt = product.soldAt ? new Date(product.soldAt) : null;
  const hasDate = soldAt !== null && Number.isFinite(soldAt.getTime());
  const date = hasDate ? new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok", day: "numeric", month: "numeric", year: "2-digit",
  }).format(soldAt).replace(/^0/, "").replace(/\/0(\d)\//, "/$1/") : null;
  const time = hasDate ? new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(soldAt) : null;
  const soldBy = product.soldBy?.replace(/\s+\(U[0-9a-f]{32}\)$/i, "") ?? null;
  return [
    `สินค้า ${product.productId} เป็น Out อยู่แล้ว`,
    `ราคาขาย ${product.soldPrice === null ? oldValue(null) : `${product.soldPrice.toLocaleString("en-US")} บาท`}`,
    date && time ? `ขายเมื่อวันที่ ${date} เวลา ${time}` : `ขายเมื่อวันที่ ${oldValue(null)}`,
    `บันทึกโดย ${oldValue(soldBy)}`,
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
