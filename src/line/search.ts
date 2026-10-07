import { buildImportSummaryCard, buildImportSummaryMessage } from "../import/notify";
import type { InventoryClient } from "./airtable-inventory";
import { OperationalError } from "../shared/errors";
import { notFoundText } from "./messages";
import type { ParsedCommand } from "./types";
import { helpCard } from "./help-card";
import { uploadStartCard } from "./upload-card";
import { searchCard, type SearchCardReply } from "./search-card";

export type UploadTriggerResult =
  | { status: "started"; importRunId: string }
  | {
      status:
        | "already_running"
        | "sequence_not_bootstrapped"
        | "workflow_start_failed"
        | "import_trigger_failed";
    };

export type DocsTriggerResult =
  | { status: "no_runnable_run" }
  | { status: "regenerating"; publicationRunId: string; generation: number }
  | {
      status: "started" | "restarted" | "resumed" | "already_running" | "already_generated";
      publicationRunId: string;
    };

export interface ReadOnlyDeps {
  publicBaseUrl: string;
  inventory: Pick<InventoryClient, "findByProductId">;
  triggerUpload(): Promise<UploadTriggerResult>;
  triggerDocs(publicationDate?: string): Promise<DocsTriggerResult>;
}

function uploadResultReply(result: UploadTriggerResult, publicBaseUrl: string): string | SearchCardReply {
  switch (result.status) {
    case "started":
      return uploadStartCard(result.importRunId, publicBaseUrl);
    case "already_running":
      return "⚠️ มีงานนำเข้ากำลังทำงานอยู่";
    case "sequence_not_bootstrapped":
      return "⚠️ ยังเริ่มนำเข้าไม่ได้ เพราะยังไม่ได้ตั้งค่าลำดับรหัสสินค้า";
    case "workflow_start_failed":
      return "⚠️ เริ่มงานนำเข้าไม่สำเร็จ กรุณาลอง /upload อีกครั้ง";
    case "import_trigger_failed":
      return "⚠️ ระบบเริ่มงานนำเข้าขัดข้อง กรุณาลอง /upload อีกครั้ง";
  }
}

function testUploadReply(caseNumber: number | null, publicBaseUrl: string): string | SearchCardReply {
  const labels = ["เริ่มนำเข้า", "มีงานกำลังทำงาน", "ยังไม่ได้ตั้งค่าลำดับรหัส", "เริ่ม Workflow ไม่สำเร็จ", "ระบบเริ่มงานขัดข้อง", "สำเร็จทั้งหมด", "สำเร็จบางรายการ", "ล้มเหลวทั้งหมด", "ไม่มีสินค้าใหม่", "ภาพก่อนมาร์กเกอร์"];
  if (caseNumber === null) return "ตัวอย่างข้อความ /upload (ไม่มีการนำเข้าจริง)\n" + labels.map((label, index) => `/testupload ${index + 1} — ${label}`).join("\n");
  let reply: string | SearchCardReply;
  if (caseNumber <= 5) {
    const outcomes: UploadTriggerResult[] = [
      { status: "started", importRunId: "00000000-0000-4000-8000-000000000001" },
      { status: "already_running" }, { status: "sequence_not_bootstrapped" },
      { status: "workflow_start_failed" }, { status: "import_trigger_failed" },
    ];
    reply = uploadResultReply(outcomes[caseNumber - 1]!, publicBaseUrl);
  } else {
    const input = {
      result: {
        importRunId: "preview-only",
        succeededProductIds: caseNumber === 6 ? ["A-29", "A-30"] : caseNumber === 7 ? ["A-29"] : [],
        failedGroups: caseNumber === 7 || caseNumber === 8
          ? [{ groupId: "preview-group", productId: "A-30", errorCode: "airtable_verification_failed" }] : [],
      },
      orphanRange: caseNumber === 10 ? { firstApplePhotoId: "preview-first", lastApplePhotoId: "preview-last", count: 3 } : null,
      nowThaiText: "7 ตุลาคม 2569 14:30",
    };
    reply = { kind: "flex", text: buildImportSummaryMessage(input), contents: buildImportSummaryCard(input, publicBaseUrl) };
  }
  return reply;
}

function docsResultText(result: DocsTriggerResult, publicationDate?: string): string {
  switch (result.status) {
    case "regenerating":
      return `เริ่มสร้างเอกสารเวอร์ชัน v${result.generation} แล้ว ${result.publicationRunId}`;
    case "started":
      return `เริ่มสร้างเอกสารแล้ว ${result.publicationRunId}`;
    case "restarted":
      return `เริ่มสร้างเอกสารใหม่แล้ว ${result.publicationRunId}`;
    case "resumed":
      return `ทำงานสร้างเอกสารต่อแล้ว ${result.publicationRunId}`;
    case "already_running":
      return `มีงานสร้างเอกสารกำลังทำงานอยู่ ${result.publicationRunId}`;
    case "already_generated":
      return `สร้างเอกสารของ Publication Run นี้แล้ว ${result.publicationRunId}\nหากต้องการสร้างเวอร์ชันใหม่ ตั้งสถานะเป็น Ready แล้วส่งคำสั่ง /docs${publicationDate ? ` ${publicationDate.split("-").reverse().join("/")}` : ""} อีกครั้ง`;
    case "no_runnable_run":
      return publicationDate
        ? `ยังไม่มี Publication Run ที่พร้อมสำหรับวันที่ ${publicationDate.split("-").reverse().join("/")} กรุณาตั้งสถานะเป็น Ready`
        : "ยังไม่มี Publication Run ที่พร้อมวันนี้";
  }
}

export async function handleReadOnlyCommand(
  command: Extract<ParsedCommand, { type: "help" | "search" | "upload" | "testupload" | "docs" }>,
  deps: ReadOnlyDeps,
): Promise<string | SearchCardReply> {
  if (command.type === "testupload") return testUploadReply(command.caseNumber, deps.publicBaseUrl);
  if (command.type === "help") return helpCard(deps.publicBaseUrl);
  if (command.type === "search") {
    const product = await deps.inventory.findByProductId(command.productId);
    return product ? searchCard(product, deps.publicBaseUrl) : notFoundText(command.productId);
  }
  if (command.type === "upload") return uploadResultReply(await deps.triggerUpload(), deps.publicBaseUrl);
  try {
    const result = command.publicationDate
      ? await deps.triggerDocs(command.publicationDate)
      : await deps.triggerDocs();
    return docsResultText(result, command.publicationDate);
  } catch (error) {
    if (!(error instanceof OperationalError) || error.code !== "airtable_duplicate_publication_date") throw error;
    return `พบวันที่ซ้ำใน Publication Runs กรุณาแก้ให้มีเพียง 1 รอบต่อวัน แล้วลอง /docs${command.publicationDate ? ` ${command.publicationDate.split("-").reverse().join("/")}` : ""} อีกครั้ง`;
  }
}
