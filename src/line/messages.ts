import type { ValidationResult } from "../publication/validator";
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
