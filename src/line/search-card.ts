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
  const background = "#D9D9D9";
  const statusColor = isIn ? "#22A559" : "#FA2C37";
  const iconUrl = (name: string) => new URL(`/line/icons/${name}.png`, publicBaseUrl).toString();
  const row = (label: string, value: string, color = ink) => ({
    type: "box", layout: "horizontal", spacing: "md",
    contents: [
      { type: "text", text: label, color: muted, size: "sm", flex: 1, wrap: true },
      { type: "text", text: value, color, size: "sm", flex: 1, align: "end", wrap: true },
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
                type: "box", layout: "vertical", flex: 1, spacing: "xs",
                contents: [
                  { type: "text", text: "รหัสสินค้า", color: muted, size: "sm" },
                  { type: "text", text: product.productId, color: ink, size: "xl", weight: "bold", wrap: true },
                ],
              },
              {
                type: "box", layout: "vertical", flex: 0, width: "48px", spacing: "xs",
                contents: [
                  { type: "image", url: iconUrl(isIn ? "in" : "out"), size: "40px", align: "center", aspectRatio: "1:1" },
                  { type: "text", text: isIn ? "IN" : "Out", size: "xs", weight: "bold", color: statusColor, align: "center" },
                ],
              },
            ],
          },
          { type: "separator", margin: "xl", color: "#949494" },
          {
            type: "box", layout: "vertical", margin: "xl", spacing: "md",
            contents: [row("สถานะ", product.inventoryStatus, statusColor), row("วันที่อัปโหลด", date)],
          },
        ],
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "16px", paddingTop: "0px", backgroundColor: background,
        contents: [{
          type: "button", style: "link", color: ink, height: "sm",
          action: { type: "uri", label: "เปิดใน Airtable", uri: product.airtableUrl },
        }],
      },
    },
  };
}
