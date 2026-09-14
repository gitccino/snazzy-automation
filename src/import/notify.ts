import type { LineClient } from "../line/client";
import type { ImportRunResult, OrphanRange } from "./types";

export function buildImportSummaryMessage(input: {
  result: ImportRunResult;
  orphanRange: OrphanRange | null;
  nowThaiText: string;
}): string {
  const { result, orphanRange, nowThaiText } = input;
  const lines = [
    `นำเข้ารูปภาพ — ${nowThaiText}`,
    `สำเร็จ ${result.succeededProductIds.length} รายการ`,
  ];

  if (result.succeededProductIds.length > 0) {
    lines.push(result.succeededProductIds.join(", "));
  }

  if (result.failedGroups.length > 0) {
    lines.push(`ล้มเหลว ${result.failedGroups.length} รายการ`);
    for (const failure of result.failedGroups) {
      const productLabel = failure.productId ?? "ไม่ทราบรหัส";
      lines.push(`- กลุ่ม ${failure.groupId} (${productLabel}): ${failure.errorCode}`);
    }
    lines.push("แก้ไขแล้วพิมพ์ /upload เพื่อลองใหม่");
  }

  if (orphanRange !== null) {
    lines.push(
      `พบรูปก่อนมาร์กเกอร์แรก ${orphanRange.count} รูป (${orphanRange.firstApplePhotoId} ถึง ${orphanRange.lastApplePhotoId}) — ยังไม่สร้างสินค้า`,
    );
  }

  return lines.join("\n");
}

export async function sendImportSummary(
  line: LineClient,
  groupId: string,
  input: {
    result: ImportRunResult;
    orphanRange: OrphanRange | null;
    nowThaiText: string;
  },
): Promise<void> {
  await line.pushMessage(groupId, buildImportSummaryMessage(input));
}
