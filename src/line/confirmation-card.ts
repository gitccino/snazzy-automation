import type { CommandReply } from "./soldout";

export function confirmationCard(
  reply: Extract<CommandReply, { kind: "buttons" }>,
  publicBaseUrl: string,
): Record<string, unknown> {
  const ink = "#2C2C2C";
  const muted = "#949494";
  const background = "#FFFFFF";
  const button = (label: string, data: string, outline = false) => {
    const action = { type: "postback", label, data, displayText: label };
    return outline ? {
      type: "box", layout: "vertical", flex: 1,
      borderWidth: "1px", borderColor: "#828282", cornerRadius: "8px",
      backgroundColor: background, action,
      contents: [{ type: "button", style: "link", color: ink, height: "sm", action }],
    } : {
      type: "button", style: "primary", color: ink, height: "sm", flex: 1, action,
    };
  };
  const row = (label: string, value: string) => ({
    type: "box", layout: "horizontal", spacing: "md",
    contents: [
      { type: "text", text: label, color: muted, size: "sm", flex: 1, wrap: true },
      { type: "text", text: value, color: ink, size: "sm", flex: 1, align: "end", wrap: true },
    ],
  });
  return {
    type: "bubble", size: "mega",
    body: {
      type: "box", layout: "vertical", paddingAll: "24px", backgroundColor: background,
      contents: [
        {
          type: "box", layout: "horizontal", spacing: "md", alignItems: "center",
          contents: [
            { type: "image", url: new URL("/line/icons/check-v1.png", publicBaseUrl).toString(), size: "40px", aspectRatio: "1:1", flex: 0 },
            reply.sale ? {
              type: "box", layout: "vertical", spacing: "none", flex: 1,
              contents: [
                { type: "text", text: "/soldout", color: muted, size: "xs" },
                { type: "text", text: "ยืนยันการขาย", color: ink, size: "lg", weight: "bold", wrap: true },
              ],
            } : { type: "text", text: reply.text, color: ink, size: "md", wrap: true, flex: 1 },
          ],
        },
        ...(reply.sale ? [{
          type: "box", layout: "vertical", margin: "xl", spacing: "md",
          contents: [
            row("รหัสสินค้า", reply.sale.productId),
            row("ราคา", `${reply.sale.soldPrice.toLocaleString("en-US")} บาท`),
          ],
        }] : []),
      ],
    },
    footer: {
      type: "box", layout: "vertical", paddingAll: "16px", paddingTop: "0px", backgroundColor: background,
      contents: [{
        type: "box", layout: "horizontal", spacing: "md",
        contents: [button("ยกเลิก", reply.rejectData, true), button("ยืนยัน", reply.approveData)],
      }],
    },
  };
}
