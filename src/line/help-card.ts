import type { SearchCardReply } from "./search-card";

export function helpCard(publicBaseUrl: string): SearchCardReply {
  const commands = [
    ["/soldout", "ตัด Stock"],
    ["/search", "ตรวจเช็คสินค้า"],
    ["/revert", "ย้อนคำสั่งก่อนหน้า"],
    ["/upload", "ย้ายภาพขึ้น Airtable"],
    ["/docs", "ดึงข้อมูลไปสร้าง google doc"],
  ];
  return commandListCard(publicBaseUrl, "/help", "คำสั่งที่ใช้ได้", "help-v1", commands);
}

export function commandListCard(publicBaseUrl: string, commandLabel: string, title: string, icon: string, commands: string[][]): SearchCardReply {
  return {
    kind: "flex",
    text: [title, ...commands.map(([command, description]) => `${command}: ${description}`)].join("\n"),
    contents: {
      type: "bubble", size: "giga",
      body: {
        type: "box", layout: "vertical", paddingAll: "24px", backgroundColor: "#FFFFFF",
        contents: [
          {
            type: "box", layout: "horizontal", spacing: "md", alignItems: "center",
            contents: [
              { type: "image", url: new URL(`/line/icons/${icon}.png`, publicBaseUrl).toString(), size: "40px", aspectRatio: "1:1", flex: 0 },
              {
                type: "box", layout: "vertical", spacing: "none", flex: 1,
                contents: [
                  { type: "text", text: commandLabel, color: "#949494", size: "xs" },
                  { type: "text", text: title, color: "#2C2C2C", size: "lg", weight: "bold", wrap: true },
                ],
              },
            ],
          },
          {
            type: "box", layout: "vertical", margin: "xl", spacing: "md",
            contents: commands.map(([command, description]) => ({
              type: "box", layout: "horizontal", spacing: "md",
              contents: [
                { type: "text", text: command, color: "#2C2C2C", size: "sm", weight: "bold", flex: 2, wrap: true },
                { type: "text", text: description, color: "#949494", size: "sm", flex: 4, align: "end", wrap: true },
              ],
            })),
          },
        ],
      },
    },
  };
}
