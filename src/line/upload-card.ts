import type { SearchCardReply } from "./search-card";

export function uploadStartCard(importRunId: string, publicBaseUrl: string): SearchCardReply {
  return {
    kind: "flex",
    text: `เริ่มการนำเข้าสินค้า\n${importRunId}`,
    contents: {
      type: "bubble", size: "mega",
      body: {
        type: "box", layout: "vertical", paddingAll: "24px", backgroundColor: "#FFFFFF",
        contents: [
          {
            type: "box", layout: "horizontal", spacing: "md", alignItems: "center",
            contents: [
              { type: "image", url: new URL("/line/icons/image-v1.png", publicBaseUrl).toString(), size: "40px", aspectRatio: "1:1", flex: 0 },
              {
                type: "box", layout: "vertical", spacing: "none", flex: 1,
                contents: [
                  { type: "text", text: "/upload", color: "#949494", size: "xs" },
                  { type: "text", text: "เริ่มการนำเข้าสินค้า", color: "#2C2C2C", size: "lg", weight: "bold", wrap: true },
                ],
              },
            ],
          },
          { type: "text", text: importRunId, color: "#949494", size: "xxs", margin: "xl", wrap: true },
        ],
      },
    },
  };
}
