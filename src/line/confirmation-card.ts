import type { CommandReply } from "./soldout";

export function confirmationCard(
  reply: Extract<CommandReply, { kind: "buttons" }>,
  publicBaseUrl: string,
): Record<string, unknown> {
  const ink = "#2C2C2C";
  const background = "#FFFFFF";
  const button = (label: string, data: string) => ({
    type: "button", style: "primary", color: ink, height: "sm", flex: 1,
    action: { type: "postback", label, data, displayText: label },
  });
  return {
    type: "bubble", size: "mega",
    body: {
      type: "box", layout: "vertical", paddingAll: "20px", backgroundColor: background,
      contents: [
        {
          type: "box", layout: "horizontal", spacing: "md", alignItems: "center",
          contents: [
            { type: "image", url: new URL("/line/icons/check-v1.png", publicBaseUrl).toString(), size: "40px", aspectRatio: "1:1", flex: 0 },
            { type: "text", text: reply.text, color: ink, size: "md", wrap: true, flex: 1 },
          ],
        },
        {
          type: "box", layout: "horizontal", margin: "xl", spacing: "sm",
          contents: [button("ยกเลิก", reply.rejectData), button("ยืนยัน", reply.approveData)],
        },
      ],
    },
  };
}
