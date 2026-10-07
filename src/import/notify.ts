import type { LineClient } from "../line/client";
import type { ImportRunResult, OrphanRange } from "./types";

interface ImportSummaryInput {
  result: ImportRunResult;
  orphanRange: OrphanRange | null;
  nowThaiText: string;
}

function failureReason(errorCode: string): string {
  if (errorCode === "airtable_rate_limited") return "Airtable จำกัดจำนวนคำขอชั่วคราว";
  if (errorCode === "airtable_verification_failed") return "ข้อมูลหรือภาพสินค้าใน Airtable ยังไม่ครบ";
  if (errorCode === "airtable_cleanup_failed") return "ต้องตรวจสอบข้อมูลที่บันทึกค้างไว้ใน Airtable";
  if (errorCode.startsWith("airtable_")) return "บันทึกหรือตรวจสอบข้อมูลใน Airtable ไม่สำเร็จ";
  return "ระบบนำเข้ารายการนี้ไม่สำเร็จ";
}

export function buildImportSummaryMessage(input: ImportSummaryInput): string {
  const { result, orphanRange, nowThaiText } = input;
  const lines = [
    `นำเข้ารูปภาพ — ${nowThaiText}`,
    result.succeededProductIds.length === 0 && result.failedGroups.length === 0 && orphanRange === null
      ? "ไม่มีสินค้าใหม่ให้นำเข้า"
      : `สำเร็จ ${result.succeededProductIds.length} รายการ`,
  ];

  if (result.succeededProductIds.length > 0) {
    lines.push(result.succeededProductIds.join(", "));
  }

  if (result.failedGroups.length > 0) {
    lines.push(`ล้มเหลว ${result.failedGroups.length} รายการ`);
    for (const [index, failure] of result.failedGroups.entries()) {
      const productLabel = failure.productId ?? `รายการที่ ${index + 1} (ยังไม่มีรหัสสินค้า)`;
      lines.push(`- ${productLabel}: ${failureReason(failure.errorCode)}`);
    }
    lines.push("แก้ไขแล้วพิมพ์ /upload เพื่อลองใหม่");
  }

  if (orphanRange !== null) {
    lines.push(
      `พบภาพ ${orphanRange.count} ภาพก่อนมาร์กเกอร์แรก — เพิ่มมาร์กเกอร์ก่อนภาพสินค้า แล้วลอง /upload อีกครั้ง`,
    );
  }

  return lines.join("\n");
}

export function buildImportSummaryCard(input: ImportSummaryInput, publicBaseUrl: string): Record<string, unknown> {
  const { result, orphanRange, nowThaiText } = input;
  const succeeded = result.succeededProductIds.length;
  const failed = result.failedGroups.length;
  const needsAttention = failed > 0 || orphanRange !== null;
  const title = needsAttention
    ? succeeded > 0 ? "นำเข้าสำเร็จบางรายการ" : failed > 0 ? "นำเข้าไม่สำเร็จ" : "ยังไม่มีสินค้าที่นำเข้าได้"
    : succeeded > 0 ? "นำเข้าสินค้าสำเร็จ"
    : "ไม่มีสินค้าใหม่ให้นำเข้า";
  const icon = needsAttention ? "alert-v1" : succeeded ? "check-green-v2" : "image-v1";
  const text = (value: string, color = "#2C2C2C", size = "sm") => ({
    type: "text", text: value, color, size, wrap: true,
  });
  const contents: Record<string, unknown>[] = [
    {
      type: "box", layout: "horizontal", spacing: "md", alignItems: "center",
      contents: [
        { type: "image", url: new URL(`/line/icons/${icon}.png`, publicBaseUrl).toString(), size: "40px", aspectRatio: "1:1", flex: 0 },
        {
          type: "box", layout: "vertical", spacing: "none", flex: 1,
          contents: [text("/upload", "#949494", "xs"), { ...text(title, "#2C2C2C", "lg"), weight: "bold" }],
        },
      ],
    },
    { ...text(nowThaiText, "#949494", "xs"), margin: "lg" },
    {
      type: "box", layout: "horizontal", margin: "xl", spacing: "md",
      contents: [
        { type: "box", layout: "vertical", flex: 1, contents: [text("สำเร็จ", "#949494"), { ...text(`${succeeded} รายการ`, succeeded ? "#22A559" : "#949494", "xl"), weight: "bold" }] },
        { type: "box", layout: "vertical", flex: 1, contents: [text("ไม่สำเร็จ", "#949494"), { ...text(`${failed} รายการ`, failed ? "#FA2C37" : "#949494", "xl"), weight: "bold" }] },
      ],
    },
  ];
  if (succeeded) {
    // ponytail: keep one card compact; paginate if users need full large-run lists in LINE.
    const ids = result.succeededProductIds.slice(0, 40).join(", ");
    contents.push({
      type: "box", layout: "vertical", margin: "xl", spacing: "sm",
      contents: [text("สินค้าที่นำเข้าแล้ว", "#949494"), text(ids + (succeeded > 40 ? `\nและอีก ${succeeded - 40} รายการ` : ""))],
    });
  }
  if (failed) {
    contents.push({
      type: "box", layout: "vertical", margin: "xl", spacing: "md",
      contents: [
        { ...text("รายการที่ต้องตรวจสอบ"), weight: "bold" },
        ...result.failedGroups.slice(0, 10).map((failure, index) => ({
          type: "box", layout: "vertical", spacing: "xs",
          contents: [
            { ...text(failure.productId ?? `รายการที่ ${index + 1} (ยังไม่มีรหัสสินค้า)`), weight: "bold" },
            text(failureReason(failure.errorCode), "#949494", "xs"),
          ],
        })),
        ...(failed > 10 ? [text(`และอีก ${failed - 10} รายการที่ไม่สำเร็จ`, "#949494")] : []),
      ],
    });
    contents.push({ ...text("ตรวจสอบรายการที่ไม่สำเร็จ แล้วพิมพ์ /upload เพื่อลองใหม่", "#949494", "xs"), margin: "xl" });
  }
  if (orphanRange) {
    contents.push({ ...text(`พบภาพ ${orphanRange.count} ภาพก่อนมาร์กเกอร์แรก\nเพิ่มมาร์กเกอร์ก่อนภาพสินค้า แล้วลอง /upload อีกครั้ง`, "#949494", "xs"), margin: "xl" });
  }
  return {
    type: "bubble", size: "mega",
    body: { type: "box", layout: "vertical", paddingAll: "24px", backgroundColor: "#FFFFFF", contents },
  };
}

export async function sendImportSummary(
  line: LineClient,
  groupId: string,
  input: ImportSummaryInput,
  publicBaseUrl: string,
): Promise<void> {
  await line.pushMessage(
    groupId,
    buildImportSummaryMessage(input),
    buildImportSummaryCard(input, publicBaseUrl),
  );
}
