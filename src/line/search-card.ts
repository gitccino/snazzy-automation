import type { InventoryProduct } from "./types";
import { searchText } from "./messages";

export interface SearchCardReply {
  kind: "flex";
  text: string;
  contents: Record<string, unknown>;
}

export function searchCard(product: InventoryProduct, publicBaseUrl: string): SearchCardReply {
  const isIn = product.inventoryStatus === "In";
  const ink = "#2C2C2C";
  const muted = "#949494";
  const background = "#FFFFFF";
  const iconUrl = (name: string) => new URL(`/line/icons/${name}-v2.png`, publicBaseUrl).toString();
  const row = (label: string, value: string) => ({
    type: "box", layout: "horizontal", spacing: "md",
    contents: [
      { type: "text", text: label, color: muted, size: "sm", flex: 1, wrap: true },
      { type: "text", text: value, color: ink, size: "sm", flex: 1, align: "end", wrap: true },
    ],
  });
  const uploadDate = product.uploadDate?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = uploadDate
    ? `${Number(uploadDate[3])}/${Number(uploadDate[2])}/${uploadDate[1]}`
    : product.uploadDate ?? "ไม่พบข้อมูล";
  return {
    kind: "flex",
    text: searchText(product),
    contents: {
      type: "bubble", size: "mega",
      ...(product.imageUrl ? {
        hero: {
          type: "image", url: product.imageUrl, size: "full", aspectRatio: "4:3", aspectMode: "cover",
        },
      } : {}),
      body: {
        type: "box", layout: "vertical", paddingAll: "24px", backgroundColor: background,
        contents: [
          {
            type: "box", layout: "horizontal", spacing: "md", alignItems: "center",
            contents: [
              { type: "image", url: iconUrl("bag"), size: "40px", aspectRatio: "1:1", flex: 0 },
              {
                type: "box", layout: "vertical", flex: 1, spacing: "none",
                contents: [
                  { type: "text", text: "รหัสสินค้า", color: muted, size: "sm" },
                  { type: "text", text: product.productId, color: ink, size: "xl", weight: "bold", wrap: true },
                ],
              },
              {
                type: "box", layout: "vertical", flex: 0, width: "48px", spacing: "xs",
                contents: [
                  { type: "image", url: iconUrl(isIn ? "in" : "out"), size: "40px", align: "center", aspectRatio: "1:1" },
                ],
              },
            ],
          },
          {
            type: "box", layout: "vertical", margin: "xl", spacing: "md",
            contents: [
              row(product.brandName ? "แบรนด์" : "รุ่น", product.brandName || product.modelName || "ไม่พบข้อมูล"),
              row("วันที่อัปโหลด", date),
            ],
          },
        ],
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "16px", paddingTop: "0px", backgroundColor: background,
        contents: [{
          type: "button", style: "primary", color: ink, height: "sm",
          action: { type: "uri", label: "เปิดใน Airtable", uri: product.airtableUrl },
        }],
      },
    },
  };
}
