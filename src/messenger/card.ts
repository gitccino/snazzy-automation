import type { Overview } from "./types";
import { bangkokDay } from "./parser";
const text = (value: string, muted = false) => ({
  type: "text",
  text: value,
  size: "xs",
  color: muted ? "#949494" : "#2C2C2C",
});
const command = (page: number) => `/mess-overview ${page}`;
const nav = (label: string, page: number) => ({
  type: "button",
  height: "sm",
  style: "link",
  action: { type: "message", label, text: command(page) },
});
const postback = (
  label: string,
  kind: "complete" | "quote",
  token: string,
) => ({
  type: "box",
  layout: "vertical",
  width: kind === "quote" ? "64px" : "80px",
  height: "40px",
  cornerRadius: "20px",
  backgroundColor: kind === "quote" ? "#FFFFFF" : "#F0F0F1",
  justifyContent: "center",
  alignItems: "center",
  contents: [
    {
      type: "text",
      text: label,
      size: "12px",
      flex: 0,
      align: "center",
      color: kind === "quote" ? "#535B66" : "#2C2C2C",
    },
  ],
  action: {
    type: "postback",
    label,
    data: new URLSearchParams({ messenger: kind, token }).toString(),
  },
});
export function messengerOverviewCard(
  overview: Overview,
  now: Date,
): { text: string; contents: Record<string, unknown> } {
  const today = bangkokDay(now.getTime());
  const title = "แมสเซนเจอร์วันนี้";
  const count = `${overview.total} รายการ · เสร็จสิ้น ${overview.done}`;
  const items = overview.items.slice(0, 5).map((d) => {
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Bangkok",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(d.scheduledAt));
    const overdue =
      d.status === "Pending" && Date.parse(d.scheduledAt) < now.getTime();
    const tokens = overview.actions[d.id]!;
    const name =
      Array.from(d.responsibleName).slice(0, 30).join("") +
      (Array.from(d.responsibleName).length > 30 ? "…" : "");
    return {
      type: "box",
      layout: "vertical",
      paddingTop: "10px",
      paddingBottom: "10px",
      spacing: "6px",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          alignItems: "center",
          contents: [
            {
              ...text(time + (overdue ? " · เกินกำหนด" : "")),
              color: overdue ? "#CF3030" : "#2C2C2C",
              weight: "bold",
              flex: 0,
            },
            {
              ...text(`ผู้รับผิดชอบ · ${name}`, true),
              align: "end",
              flex: 1,
              margin: "sm",
              wrap: false,
            },
          ],
        },
        {
          type: "box",
          layout: "horizontal",
          alignItems: "center",
          spacing: "sm",
          contents: [
            {
              type: "text",
              text: d.productId,
              size: "md",
              weight: "bold",
              color: "#2C2C2C",
              flex: 1,
            },
            {
              type: "box",
              layout: "horizontal",
              flex: 0,
              width: "152px",
              spacing: "8px",
              contents: [
                postback("อ้างอิง", "quote", tokens.quote),
                ...(d.status === "Done"
                  ? [
                      {
                        ...text("เสร็จสิ้น"),
                        size: "12px",
                        color: "#178647",
                        gravity: "center",
                        align: "center",
                        flex: 1,
                      },
                    ]
                  : tokens.complete
                    ? [postback("เสร็จสิ้น", "complete", tokens.complete)]
                    : []),
              ],
            },
          ],
        },
      ],
    };
  });
  const pages = Math.max(1, Math.ceil(overview.total / 5));
  const navigation = [
    ...(overview.page > 1 ? [nav("← ก่อนหน้า", overview.page - 1)] : []),
    ...(overview.page < pages ? [nav("ถัดไป →", overview.page + 1)] : []),
  ];
  return {
    text: `${title} · ${count}`,
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "18px",
        backgroundColor: "#FFFFFF",
        contents: [
          {
            type: "text",
            text: title,
            size: "lg",
            weight: "bold",
            color: "#2C2C2C",
            wrap: true,
          },
          {
            type: "box",
            layout: "horizontal",
            margin: "sm",
            spacing: "sm",
            contents: [
              { ...text(today.split("-").reverse().join("/"), true), flex: 0 },
              {
                ...text(`${overview.done}/${overview.total}`, true),
                align: "end",
                flex: 1,
                wrap: true,
              },
            ],
          },
          ...(items.length
            ? items.flatMap((item) => [
                { type: "separator", margin: "sm" },
                item,
              ])
            : [
                {
                  ...text("ไม่มีรายการแมสเซนเจอร์สำหรับวันนี้", true),
                  margin: "lg",
                  wrap: true,
                },
              ]),
          ...(navigation.length
            ? [
                { type: "separator", margin: "sm" },
                { type: "box", layout: "horizontal", contents: navigation },
              ]
            : []),
        ],
      },
    },
  };
}
