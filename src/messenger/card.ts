import { shiftDay } from "./parser";
import type { Overview } from "./types";
const text = (value: string, muted = false) => ({
  type: "text",
  text: value,
  size: "xs",
  color: muted ? "#949494" : "#2C2C2C",
});
const command = (day: string, page: number) =>
  `/mess-overview ${day.split("-").reverse().join("/")} ${page}`;
const nav = (label: string, day: string, page: number) => ({
  type: "button",
  height: "sm",
  style: "link",
  action: { type: "message", label, text: command(day, page) },
});
const postback = (
  label: string,
  kind: "complete" | "quote",
  token: string,
) => ({
  type: "button",
  height: "sm",
  style: kind === "complete" ? "primary" : "link",
  ...(kind === "complete" ? { color: "#2C2C2C" } : {}),
  action: {
    type: "postback",
    label,
    data: new URLSearchParams({ messenger: kind, token }).toString(),
  },
});
export function messengerOverviewCard(
  overview: Overview,
  today: string,
): { text: string; contents: Record<string, unknown> } {
  const title =
    overview.day === today
      ? "แมสเซนเจอร์วันนี้"
      : overview.day === shiftDay(today, 1)
        ? "แมสเซนเจอร์พรุ่งนี้"
        : `แมสเซนเจอร์ ${overview.day.split("-").reverse().join("/")}`;
  const count = `${overview.total} รายการ · เสร็จแล้ว ${overview.done}`;
  const items = overview.items.slice(0, 5).map((d) => {
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Bangkok",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(d.scheduledAt));
    const tokens = overview.actions[d.id]!;
    const name =
      Array.from(d.responsibleName).slice(0, 30).join("") +
      (Array.from(d.responsibleName).length > 30 ? "…" : "");
    return {
      type: "box",
      layout: "vertical",
      paddingTop: "12px",
      paddingBottom: "12px",
      spacing: "sm",
      contents: [
        {
          type: "box",
          layout: "horizontal",
          alignItems: "center",
          contents: [
            {
              ...text(
                (d.scheduleType === "Immediate" ? "ทันที · " : "") + time,
              ),
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
              contents: [
                postback("อ้างอิง", "quote", tokens.quote),
                ...(d.status === "Done"
                  ? [
                      {
                        ...text("✓ เสร็จแล้ว"),
                        color: "#178647",
                        gravity: "center",
                        margin: "sm",
                      },
                    ]
                  : tokens.complete
                    ? [postback("เสร็จแล้ว", "complete", tokens.complete)]
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
    ...(overview.page > 1
      ? [nav("← ก่อนหน้า", overview.day, overview.page - 1)]
      : []),
    ...(overview.page < pages
      ? [nav("ถัดไป →", overview.day, overview.page + 1)]
      : []),
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
          { ...text("MESSENGER", true), size: "xxs" },
          {
            type: "text",
            text: title,
            size: "lg",
            weight: "bold",
            color: "#2C2C2C",
            margin: "xs",
            wrap: true,
          },
          {
            ...text(
              `${overview.day.split("-").reverse().join("/")} · ${count}`,
              true,
            ),
            margin: "xs",
          },
          ...(items.length
            ? items.flatMap((item) => [
                { type: "separator", margin: "sm" },
                item,
              ])
            : [
                {
                  ...text(
                    "ไม่มีรายการแมสเซนเจอร์สำหรับ" +
                      (overview.day === today
                        ? "วันนี้"
                        : overview.day.split("-").reverse().join("/")),
                    true,
                  ),
                  margin: "lg",
                  wrap: true,
                },
              ]),
          { type: "separator", margin: "sm" },
          ...(navigation.length
            ? [{ type: "box", layout: "horizontal", contents: navigation }]
            : []),
          {
            type: "box",
            layout: "horizontal",
            contents: [
              nav("วันนี้", today, 1),
              nav("พรุ่งนี้ →", shiftDay(today, 1), 1),
            ],
          },
        ],
      },
    },
  };
}
