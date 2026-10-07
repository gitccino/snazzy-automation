import { OperationalError } from "../shared/errors";
import type { SearchCardReply } from "./search-card";
import type { DailySaleProduct } from "./types";

const text = (value: string, muted = false) => ({ type: "text", text: value, color: muted ? "#949494" : "#2C2C2C", size: "sm", wrap: true });

export function dailySalesReportCard(products: DailySaleProduct[], reportDate: string, page: number, isToday: boolean): SearchCardReply | string {
  const displayDate = reportDate.split("-").reverse().join("/");
  const pageCount = Math.max(1, Math.ceil(products.length / 10));
  if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) return `⚠️ ไม่พบหน้าที่เลือก กรุณาส่ง /report ${displayDate} เพื่อดูหน้าแรก`;
  let total = 0;
  for (const product of products) {
    total += product.soldPrice;
    if (!Number.isSafeInteger(product.soldPrice) || product.soldPrice <= 0 || !Number.isSafeInteger(total)) {
      throw new OperationalError("sales_report_invalid_total", "Invalid daily sales total", false);
    }
  }
  const sorted = [...products].sort((a, b) => {
    const dateOrder = new Date(a.soldAt).getTime() - new Date(b.soldAt).getTime();
    const aId = a.productId.slice(2), bId = b.productId.slice(2);
    return dateOrder || aId.length - bId.length || aId.localeCompare(bId) || a.recordId.localeCompare(b.recordId);
  });
  // ponytail: cap displayed brand/model names at 80 code points; full names remain in Airtable.
  const name = (value: string | null) => {
    const points = Array.from(value?.trim() || "ไม่พบข้อมูล");
    return points.length > 80 ? points.slice(0, 80).join("") + "…" : points.join("");
  };
  const money = (value: number) => `${value.toLocaleString("en-US")} บาท`;
  const title = `สรุปยอดขายของวันที่ ${displayDate}`;
  const count = `ขายแล้ว ${products.length} รายการ`;
  const revenue = `ยอดขายรวม ${money(total)}`;
  const rows = sorted.slice((page - 1) * 10, page * 10).map(product => ({
    type: "box", layout: "horizontal", spacing: "md", alignItems: "flex-start",
    contents: [
      { type: "box", layout: "vertical", spacing: "xs", flex: 3, contents: [
        { ...text(product.productId), weight: "bold" },
        { ...text(`${name(product.brandName)} · ${name(product.modelName)}`, true), size: "xs" },
      ] },
      { ...text(money(product.soldPrice)), weight: "bold", align: "end", flex: 2 },
    ],
  }));
  const buttons = [];
  for (const [target, label] of [[page - 1, "หน้าก่อนหน้า"], [page + 1, "หน้าถัดไป"]] as const) {
    if (target >= 1 && target <= pageCount) buttons.push({ type: "button", style: "secondary", height: "sm", action: { type: "message", label, text: `/report ${displayDate} ${target}` } });
  }
  return {
    kind: "flex", text: `${title}\n${count}\n${revenue}`,
    contents: {
      type: "bubble", size: "giga",
      body: { type: "box", layout: "vertical", paddingAll: "24px", backgroundColor: "#FFFFFF", contents: [
        { ...text("/report", true), size: "xs" },
        { ...text(title), size: "lg", weight: "bold" },
        { type: "box", layout: "vertical", margin: "xl", spacing: "md", contents: rows.length ? rows : [text(isToday ? "ไม่มีรายการขายในวันนี้" : "ไม่มีรายการขายในวันที่เลือก", true)] },
        { type: "separator", margin: "xl" },
        { ...text(count, true), size: "xs", margin: "lg" },
        { ...text(revenue), size: "lg", weight: "bold", margin: "sm" },
        ...(pageCount > 1 ? [{ ...text(`หน้า ${page}/${pageCount}`, true), size: "xs", margin: "md" }] : []),
      ] },
      ...(buttons.length ? { footer: { type: "box", layout: "horizontal", spacing: "md", paddingAll: "16px", paddingTop: "0px", backgroundColor: "#FFFFFF", contents: buttons } } : {}),
    },
  };
}
