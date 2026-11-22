import { externalBrowserUri } from "./external-browser";
import { imageFailureGuidance } from "../publication/image-diagnostic";
import type { SearchCardReply } from "./search-card";
import { buildPublicationSuccessMessage, buildPublicationValidationFailureMessage, buildPublicationWorkflowFailureMessage, publicationOwnerReviewInstruction } from "./messages";

const text = (value: string, muted = false) => ({ type: "text", text: value, color: muted ? "#949494" : "#2C2C2C", size: "sm", wrap: true });

function summaryCard(title: string, icon: string, date: string, details: Record<string, unknown>[], buttonLabel: string, uri: string, publicBaseUrl: string): Record<string, unknown> {
  return {
    type: "bubble", size: "mega",
    body: {
      type: "box", layout: "vertical", paddingAll: "24px", backgroundColor: "#FFFFFF",
      contents: [
        {
          type: "box", layout: "horizontal", spacing: "md", alignItems: "center",
          contents: [
            { type: "image", url: new URL(`/line/icons/${icon}.png`, publicBaseUrl).toString(), size: "40px", aspectRatio: "1:1", flex: 0 },
            { type: "box", layout: "vertical", spacing: "none", flex: 1, contents: [
              { ...text("/docs", true), size: "xs" }, { ...text(title), weight: "bold" },
            ] },
          ],
        },
        { ...text(date, true), size: "xs", margin: "lg" },
        { type: "box", layout: "vertical", margin: "xl", spacing: "md", contents: details },
      ],
    },
    footer: {
      type: "box", layout: "vertical", paddingAll: "16px", paddingTop: "0px", backgroundColor: "#FFFFFF",
      contents: [{ type: "button", style: "primary", color: "#2C2C2C", height: "sm", action: { type: "uri", label: buttonLabel, uri: externalBrowserUri(uri) } }],
    },
  };
}

export function docsSuccessCard(input: Parameters<typeof buildPublicationSuccessMessage>[0], publicBaseUrl: string): SearchCardReply {
  // ponytail: show 40 product IDs in one card; paginate if larger lists need full display.
  const ids = input.productIds.slice(0, 40).join(", ") + (input.productIds.length > 40 ? `\nและอีก ${input.productIds.length - 40} รายการ` : "");
  return { kind: "flex", text: buildPublicationSuccessMessage(input), contents: summaryCard(
    "สร้างเอกสารเผยแพร่สำเร็จ", "check-green-v2", input.thaiDate,
    [{ ...text(`${input.productIds.length} รายการ`), color: "#22A559", size: "xl", weight: "bold" }, text("รหัสสินค้า", true), text(ids || "ไม่พบสินค้า")],
    "เปิด Google Docs", input.googleDocUrl, publicBaseUrl,
  ) };
}

export function docsValidationFailureCard(input: Parameters<typeof buildPublicationValidationFailureMessage>[0], publicBaseUrl: string): SearchCardReply {
  const products = input.validation.productsMissingFields;
  // ponytail: show 10 incomplete products; remaining details are available in Airtable.
  const details: Record<string, unknown>[] = [
    { ...text("สินค้าที่ข้อมูลไม่ครบ"), weight: "bold" },
    ...products.slice(0, 10).map(product => ({ type: "box", layout: "vertical", spacing: "xs", contents: [
      { ...text(product.productId), weight: "bold" }, { ...text(product.missingFields.join(", "), true), size: "xs" },
    ] })),
    ...(products.length > 10 ? [text(`และอีก ${products.length - 10} รายการ — ตรวจสอบใน Airtable`, true)] : []),
    { ...text("แก้ไขข้อมูลให้ครบ ตั้งสถานะเป็น Ready แล้วส่งคำสั่ง /docs อีกครั้ง", true), size: "xs" },
  ];
  return { kind: "flex", text: buildPublicationValidationFailureMessage(input), contents: summaryCard(
    "สร้างเอกสารไม่สำเร็จ", "alert-v1", input.thaiDate, details, "เปิดใน Airtable", input.airtableRunUrl, publicBaseUrl,
  ) };
}

export function docsWorkflowFailureCard(input: Parameters<typeof buildPublicationWorkflowFailureMessage>[0], publicBaseUrl: string): SearchCardReply {
  return { kind: "flex", text: buildPublicationWorkflowFailureMessage(input), contents: summaryCard(
    "สร้างเอกสารไม่สำเร็จ", "alert-v1", input.thaiDate,
    [{ ...text("สาเหตุ"), weight: "bold" }, { ...text(input.reason, true), size: "xs" }, { ...text(publicationOwnerReviewInstruction, true), size: "xs" }],
    "เปิดใน Airtable", input.airtableRunUrl, publicBaseUrl,
  ) };
}

export function publicationFailureGuidance(stage: string, code?: string | null, imageDiagnostic?: unknown): string {
  if (stage === "prepare product images") {
    const guidance = imageFailureGuidance(imageDiagnostic);
    if (guidance) return guidance;
  }
  if (code === 'anthropic_auth_failed') return 'เชื่อมต่อ Claude ไม่สำเร็จ ให้ผู้ดูแลตรวจสอบการเชื่อมต่อ Claude';
  if (code === 'anthropic_model_failed') return 'ไม่พบหรือเข้าถึงโมเดล Claude ไม่ได้ ให้ผู้ดูแลตรวจสอบโมเดลที่ตั้งค่า';
  if (code === 'google_auth_failed') return 'เชื่อมต่อ Google ไม่สำเร็จ ให้ผู้ดูแลตรวจสอบการเชื่อมต่อบัญชี Google';
  const label = stage === 'prepare outputs' && code?.startsWith('anthropic_') ? 'สร้างคำบรรยาย' : ({'prepare product images':'เตรียมรูปภาพ','prepare outputs':'เตรียมรูปภาพและคำบรรยาย','ensure temporary document':'สร้างเอกสาร','fill and verify document':'เขียนและตรวจสอบเอกสาร','finalize publication':'จัดเตรียมเอกสารขั้นสุดท้าย'} as Record<string,string>)[stage] ?? 'ดำเนินงานเอกสาร';
  return `ขั้นตอน${label}ไม่สำเร็จ ให้ผู้ดูแลตรวจสอบงานเดิม`;
}

export function docsUnconfirmedCard(input:{thaiDate:string;airtableRunUrl:string;reason?:string},publicBaseUrl:string):SearchCardReply {
  const guidance=publicationOwnerReviewInstruction;
  return {kind:'flex',text:[`วันที่: ${input.thaiDate}`,'ยังยืนยันสถานะงานเอกสารไม่ได้',...(input.reason ? [input.reason] : []),guidance,`ลิงก์ Airtable: ${input.airtableRunUrl}`].join('\n'),contents:summaryCard(
    'ยังยืนยันสถานะงานเอกสารไม่ได้','alert-v1',input.thaiDate,
    [...(input.reason ? [text(input.reason)] : []),{...text(guidance,true),size:'xs'}],'เปิดใน Airtable',input.airtableRunUrl,publicBaseUrl,
  )};
}
