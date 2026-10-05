import type { InventoryClient } from "./airtable-inventory";
import { OperationalError } from "../shared/errors";
import { helpText, notFoundText } from "./messages";
import type { ParsedCommand } from "./types";
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

function uploadResultText(result: UploadTriggerResult): string {
  switch (result.status) {
    case "started":
      return `เริ่มนำเข้าแล้ว ${result.importRunId}`;
    case "already_running":
      return "มีงานนำเข้ากำลังทำงานอยู่";
    case "sequence_not_bootstrapped":
      return "ยังเริ่มนำเข้าไม่ได้ เพราะยังไม่ได้ตั้งค่าลำดับรหัสสินค้า";
    case "workflow_start_failed":
      return "เริ่มงานนำเข้าไม่สำเร็จ กรุณาลอง /upload อีกครั้ง";
    case "import_trigger_failed":
      return "ระบบเริ่มงานนำเข้าขัดข้อง กรุณาลอง /upload อีกครั้ง";
  }
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
  command: Extract<ParsedCommand, { type: "help" | "search" | "upload" | "docs" }>,
  deps: ReadOnlyDeps,
): Promise<string | SearchCardReply> {
  if (command.type === "help") return helpText();
  if (command.type === "search") {
    const product = await deps.inventory.findByProductId(command.productId);
    return product ? searchCard(product, deps.publicBaseUrl) : notFoundText(command.productId);
  }
  if (command.type === "upload") return uploadResultText(await deps.triggerUpload());
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
