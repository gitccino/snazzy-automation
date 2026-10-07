import { OperationalError } from "../shared/errors";
import type { SearchCardReply } from "./search-card";
import type { DailySaleProduct } from "./types";

const text = (value: string, muted = false) => ({ type: "text", text: value, color: muted ? "#949494" : "#2C2C2C", size: "sm", wrap: true });

export function dailySalesReportCard(products: DailySaleProduct[], reportDate: string, page: number, isToday: boolean, publicBaseUrl: string, navigationText?: (page: number) => string): SearchCardReply | string {
  const displayDate = reportDate.split("-").reverse().join("/");
  const pageCount = Math.max(1, Math.ceil(products.length / 10));
  if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) return `⚠️ ไม่พบหน้าที่เลือก กรุณาส่ง /report ${displayDate} เพื่อดูหน้าแรก`;
  let total = 0;
  let totalCostCents = 0;
  let missingCosts = 0;
  for (const product of products) {
    total += product.soldPrice;
    if (!Number.isSafeInteger(product.soldPrice) || product.soldPrice <= 0 || !Number.isSafeInteger(total)) {
      throw new OperationalError("sales_report_invalid_total", "Invalid daily sales total", false);
    }
    if (product.productCost == null) {
      missingCosts++;
    } else {
      const cents = Math.round(product.productCost * 100);
      totalCostCents += cents;
      if (!Number.isFinite(product.productCost) || product.productCost < 0 || !Number.isSafeInteger(cents)
        || Math.abs(product.productCost * 100 - cents) >= 0.000001 || !Number.isSafeInteger(totalCostCents)) {
        throw new OperationalError("sales_report_invalid_total", "Invalid daily product cost", false);
      }
    }
    if (!Number.isSafeInteger(total * 100)) throw new OperationalError("sales_report_invalid_total", "Invalid daily sales total", false);
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
  const money = (value: number) => `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} บาท`;
  const title = `สรุปยอดขายวันที่ ${displayDate}`;
  const count = `ขายแล้ว ${products.length} รายการ`;
  const revenue = `ยอดขายรวม ${money(total)}`;
  const margin = (profit: number, revenue: number) => `${(profit / revenue * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
  const profitColor = (profit: number) => profit > 0 ? "#1FA35A" : profit < 0 ? "#FF2939" : "#2C2C2C";
  const profitAmount = (profit: number, summary = false) => `${profit < 0 ? "ขาดทุน" : "กำไร"}${summary ? "รวม" : ""} ${money(Math.abs(profit))}`;
  const totalProfit = (total * 100 - totalCostCents) / 100;
  const costSummary = missingCosts ? "ต้นทุนรวม: ยังสรุปไม่ได้" : `ต้นทุนรวม ${money(totalCostCents / 100)}`;
  const profitSummary = missingCosts ? "กำไรรวม: ยังสรุปไม่ได้" : `${profitAmount(totalProfit, true)}${total ? ` ${margin(totalProfit, total)}` : ""}`;
  const rows = sorted.slice((page - 1) * 10, page * 10).map(product => {
    const profit = product.productCost == null ? null : (product.soldPrice * 100 - Math.round(product.productCost * 100)) / 100;
    return {
      type: "box", layout: "vertical", spacing: "xs",
      contents: [
        { type: "box", layout: "horizontal", spacing: "md", alignItems: "flex-start", contents: [
          { ...text(product.productId), weight: "bold", flex: 3 },
          { ...text(money(product.soldPrice)), weight: "bold", align: "end", flex: 2 },
        ] },
        { ...text(`${name(product.brandName)} · ${name(product.modelName)}`, true), size: "xs" },
        profit == null ? { ...text("ยังไม่ได้ระบุต้นทุน", true), size: "xs" } : {
          type: "text", size: "xs", wrap: true, contents: [
            { type: "span", text: `ต้นทุน ${money(product.productCost!)} · ${profitAmount(profit)} `, color: "#949494" },
            { type: "span", text: `(${margin(profit, product.soldPrice)})`, color: profitColor(profit) },
          ],
        },
      ],
    };
  });
  const buttons = [];
  for (const [target, label] of [[page - 1, "หน้าก่อนหน้า"], [page + 1, "หน้าถัดไป"]] as const) {
    if (target >= 1 && target <= pageCount) buttons.push({ type: "button", style: "secondary", height: "sm", action: { type: "message", label, text: navigationText ? navigationText(target) : `/report ${displayDate} ${target}` } });
  }
  return {
    kind: "flex", text: `${title}\n${count}\n${revenue}\n${costSummary}\n${profitSummary}${missingCosts ? `\n⚠️ ยังไม่ได้ระบุต้นทุน ${missingCosts} รายการ` : ""}`,
    contents: {
      type: "bubble", size: "giga",
      body: { type: "box", layout: "vertical", paddingAll: "24px", backgroundColor: "#FFFFFF", contents: [
        { type: "box", layout: "horizontal", spacing: "md", alignItems: "center", contents: [
          { type: "image", url: new URL("/line/icons/analytic-v1.png", publicBaseUrl).toString(), size: "40px", aspectRatio: "1:1", flex: 0 },
          { type: "box", layout: "vertical", spacing: "none", flex: 1, contents: [
            { ...text("/report", true), size: "xs" },
            { ...text(title), size: "lg", weight: "bold" },
          ] },
        ] },
        { type: "box", layout: "vertical", margin: "xl", spacing: "md", contents: rows.length ? rows : [text(isToday ? "ไม่มีรายการขายในวันนี้" : "ไม่มีรายการขายในวันที่เลือก", true)] },
        { type: "separator", margin: "xl" },
        { ...text(count, true), size: "xs", margin: "lg" },
        { ...text(revenue), size: "lg", weight: "bold", margin: "sm" },
        { ...text(costSummary, true), margin: "sm" },
        missingCosts || !total ? { ...text(profitSummary), size: "lg", weight: "bold", margin: "sm" } : {
          type: "box", layout: "horizontal", spacing: "sm", alignItems: "center", margin: "sm", contents: [
            { ...text(profitAmount(totalProfit, true)), size: "lg", weight: "bold", flex: 0 },
            { type: "box", layout: "horizontal", spacing: "xs", alignItems: "center", flex: 1, contents: [
              ...(totalProfit !== 0 ? [{ type: "image", url: new URL(`/line/icons/${totalProfit > 0 ? "profit" : "loss"}-v1.png`, publicBaseUrl).toString(), size: "24px", aspectRatio: "1:1", flex: 0 }] : []),
              { ...text(margin(totalProfit, total)), color: profitColor(totalProfit), size: "lg", weight: "bold", flex: 1 },
            ] },
          ],
        },
        ...(missingCosts ? [{ ...text(`⚠️ ยังไม่ได้ระบุต้นทุน ${missingCosts} รายการ`, true), size: "xs", margin: "sm" }] : []),
        ...(pageCount > 1 ? [{ ...text(`หน้า ${page}/${pageCount}`, true), size: "xs", margin: "md" }] : []),
      ] },
      ...(buttons.length ? { footer: { type: "box", layout: "horizontal", spacing: "md", paddingAll: "16px", paddingTop: "0px", backgroundColor: "#FFFFFF", contents: buttons } } : {}),
    },
  };
}
