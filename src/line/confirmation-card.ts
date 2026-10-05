import type { CommandReply } from "./soldout";
import type { SaleValues } from "./types";

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
  const saleDetails = (title: string, values: SaleValues) => {
    const soldAt = values.soldAt ? new Date(values.soldAt) : null;
    const dateTime = soldAt && Number.isFinite(soldAt.getTime())
      ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Bangkok", day: "numeric", month: "numeric", year: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).format(soldAt).replace(/^0/, "").replace(/\/0(\d)\//, "/$1/").replace(", ", " เวลา ")
      : "ไม่พบข้อมูลเดิม";
    const seller = values.soldBy?.trim().replace(/\s+\(U[0-9a-f]{32}\)$/i, "") || "ไม่พบข้อมูลเดิม";
    return {
      type: "box", layout: "vertical", margin: "xl", spacing: "sm",
      contents: [
        { type: "text", text: title, color: ink, size: "sm", weight: "bold" },
        row("สถานะ", values.inventoryStatus),
        row("ราคาขาย", values.soldPrice === null ? "ไม่พบข้อมูลเดิม" : `${values.soldPrice.toLocaleString("en-US")} บาท`),
        row("ขายเมื่อ", dateTime),
        row("บันทึกโดย", seller),
      ],
    };
  };
  return {
    type: "bubble", size: "mega",
    body: {
      type: "box", layout: "vertical", paddingAll: "24px", backgroundColor: background,
      contents: [
        {
          type: "box", layout: "horizontal", spacing: "md", alignItems: "center",
          contents: [
            { type: "image", url: new URL("/line/icons/check-v1.png", publicBaseUrl).toString(), size: "40px", aspectRatio: "1:1", flex: 0 },
            reply.sale || reply.revert ? {
              type: "box", layout: "vertical", spacing: "none", flex: 1,
              contents: [
                { type: "text", text: reply.revert ? "/revert" : "/soldout", color: muted, size: "xs" },
                { type: "text", text: reply.revert ? "ยืนยันการย้อนกลับ" : "ยืนยันการขาย", color: ink, size: "lg", weight: "bold", wrap: true },
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
        ...(reply.revert ? [
          {
            type: "box", layout: "vertical", margin: "xl",
            contents: [row("รหัสสินค้า", reply.revert.productId)],
          },
          saleDetails("จาก", reply.revert.before),
          saleDetails("เป็น", reply.revert.after),
        ] : []),
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
