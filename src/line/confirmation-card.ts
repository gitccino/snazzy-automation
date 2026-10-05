import type { CommandReply } from "./soldout";

export function confirmationCard(
  reply: Extract<CommandReply, { kind: "buttons" }>,
  publicBaseUrl: string,
): Record<string, unknown> {
  const ink = "#2C2C2C";
  const background = "#D9D9D9";
  const button = (label: string, data: string, primary: boolean) => ({
    type: "box", layout: "vertical", flex: 1, height: "40px",
    cornerRadius: "12px", borderWidth: "1px", borderColor: primary ? ink : "#828282",
    backgroundColor: primary ? ink : background,
    justifyContent: "center", alignItems: "center",
    action: { type: "postback", label, data, displayText: label },
    contents: [{ type: "text", text: label, size: "md", weight: "bold", color: primary ? "#FFFFFF" : ink, flex: 0, align: "center" }],
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
          contents: [button("ยกเลิก", reply.rejectData, false), button("ยืนยัน", reply.approveData, true)],
        },
      ],
    },
  };
}
