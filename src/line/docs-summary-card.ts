import type { SearchCardReply } from "./search-card";
import { buildPublicationSuccessMessage, buildPublicationValidationFailureMessage, buildPublicationWorkflowFailureMessage } from "./messages";

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
      contents: [{ type: "button", style: "primary", color: "#2C2C2C", height: "sm", action: { type: "uri", label: buttonLabel, uri } }],
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
    [{ ...text("สาเหตุ"), weight: "bold" }, { ...text(input.reason, true), size: "xs" }, { ...text("ส่งคำสั่ง /docs เพื่อลองใหม่", true), size: "xs" }],
    "เปิดใน Airtable", input.airtableRunUrl, publicBaseUrl,
  ) };
}
