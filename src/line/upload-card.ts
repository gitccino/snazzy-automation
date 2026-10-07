import type { SearchCardReply } from "./search-card";

export function uploadStartCard(importRunId: string, publicBaseUrl: string): SearchCardReply {
  return startCard(importRunId, publicBaseUrl, "/upload", "เริ่มการนำเข้าสินค้า");
}

export function docsStartCard(publicationRunId: string, publicBaseUrl: string, title = "เริ่มสร้างเอกสารแล้ว"): SearchCardReply {
  return startCard(publicationRunId, publicBaseUrl, "/docs", title);
}

function startCard(runId: string, publicBaseUrl: string, command: string, title: string): SearchCardReply {
  return {
    kind: "flex",
    text: `${title}\n${runId}`,
    contents: {
      type: "bubble", size: "mega",
      body: {
        type: "box", layout: "vertical", paddingAll: "24px", backgroundColor: "#FFFFFF",
        contents: [
          {
            type: "box", layout: "horizontal", spacing: "md", alignItems: "center",
            contents: [
              { type: "image", url: new URL(command === "/docs" ? "/line/icons/doc-v1.png" : "/line/icons/image-v1.png", publicBaseUrl).toString(), size: "40px", aspectRatio: "1:1", flex: 0 },
              {
                type: "box", layout: "vertical", spacing: "none", flex: 1,
                contents: [
                  { type: "text", text: command, color: "#949494", size: "xs" },
                  { type: "text", text: title, color: "#2C2C2C", size: "sm", weight: "bold", wrap: true },
                ],
              },
            ],
          },
          { type: "text", text: runId, color: "#949494", size: "xxs", margin: "xl", wrap: true },
        ],
      },
    },
  };
}
