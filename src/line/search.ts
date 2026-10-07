import { dailySalesReportCard } from "./report-card";
import { todayBangkokDate, type Clock } from "../shared/time";
import { docsSuccessCard, docsValidationFailureCard, docsWorkflowFailureCard } from "./docs-summary-card";
import { confirmationCard } from "./confirmation-card";
import { buildImportSummaryCard, buildImportSummaryMessage } from "../import/notify";
import type { InventoryClient } from "./airtable-inventory";
import { OperationalError } from "../shared/errors";
import { notFoundText, parseErrorText, soldoutMessages } from "./messages";
import type { InventoryProduct, ParsedCommand } from "./types";
import { commandListCard, helpCard } from "./help-card";
import { docsStartCard, uploadStartCard } from "./upload-card";
import { alreadyOutCard, saleSuccessCard, searchCard, type SearchCardReply } from "./search-card";

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
  inventory: Pick<InventoryClient, "findByProductId" | "listSalesForDay">;
  clock: Clock;
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
  if (caseNumber === null) return commandListCard(publicBaseUrl, "/testupload", "ตัวอย่างข้อความ /upload", "setting-yellow-v1", labels.map((label, index) => [String(index + 1), label]));
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

function testSearchReply(caseNumber: number | null, publicBaseUrl: string): string | SearchCardReply {
  const labels = ["สินค้า In พร้อมภาพ", "สินค้า Out พร้อมภาพ", "ไม่มีภาพ", "แสดงรุ่นแทนแบรนด์", "ข้อมูลสินค้าไม่ครบ", "ไม่พบสินค้า", "ไม่พบรหัสสินค้า", "รหัสไม่ถูกต้อง", "หลายรหัสสินค้า"];
  if (caseNumber === null) return commandListCard(publicBaseUrl, "/testsearch", "ตัวอย่างข้อความ /search", "setting-yellow-v1", labels.map((label, index) => [String(index + 1), label]));
  if (caseNumber === 6) return notFoundText("A-999");
  if (caseNumber === 7) return parseErrorText("missing_product_id");
  if (caseNumber === 8) return parseErrorText("invalid_product_id");
  if (caseNumber === 9) return parseErrorText("multiple_product_ids");
  const product: InventoryProduct = {
    recordId: "preview-only", productId: "A-22", inventoryStatus: caseNumber === 2 ? "Out" : "In",
    soldPrice: caseNumber === 2 ? 12000 : null,
    soldAt: caseNumber === 2 ? "2026-10-07T07:30:00.000Z" : null,
    soldBy: caseNumber === 2 ? "S" : null,
    uploadDate: caseNumber === 5 ? null : "2026-09-26",
    airtableUrl: "https://airtable.com",
    // Use LINE's public sample image; previewing never reads real product attachments.
    imageUrl: caseNumber === 3 ? null : "https://scdn.line-apps.com/n/channel_devcenter/img/fx/01_1_cafe.png",
    brandName: caseNumber === 4 || caseNumber === 5 ? null : "CHANEL",
    modelName: caseNumber === 5 ? null : "Classic Card Holder",
  };
  return searchCard(product, publicBaseUrl);
}

function testSoldoutReply(caseNumber: number | null, publicBaseUrl: string): string | SearchCardReply {
  const labels = ["ยืนยันการขาย", "บันทึกขายสำเร็จ", "ขายแล้ว", "ยกเลิกการขาย", "ไม่พบรหัสสินค้า", "รหัสไม่ถูกต้อง", "หลายรหัสสินค้า", "ไม่พบราคาขาย", "ราคาไม่ถูกต้อง", "หลายยอดเงิน", "ไม่รู้จักคำสั่ง", "ไม่พบสินค้า", "มีคำสั่งรอยืนยัน", "คำยืนยันหมดอายุหรือถูกใช้แล้ว", "คำยืนยันราคาไม่ถูกต้อง", "ข้อมูลสินค้าเปลี่ยนแล้ว"];
  if (caseNumber === null) return commandListCard(publicBaseUrl, "/testsoldout", "ตัวอย่างข้อความ /soldout", "setting-yellow-v1", labels.map((label, index) => [String(index + 1), label]));
  const productId = "A-22";
  const soldPrice = 12000;
  if (caseNumber === 1) {
    const reply = {
      kind: "buttons" as const, sale: { productId, soldPrice },
      text: `ยืนยันขาย ${productId} ราคา ${soldPrice.toLocaleString("en-US")} บาท`,
      approveData: "preview-approve", rejectData: "preview-reject",
    };
    return { kind: "flex", text: reply.text, contents: confirmationCard(reply, publicBaseUrl, { approveText: "/testsoldout 2", rejectText: "/testsoldout 4" }) };
  }
  if (caseNumber === 2 || caseNumber === 3) {
    const product: InventoryProduct = {
      recordId: "preview-only", productId, inventoryStatus: "Out", soldPrice,
      soldAt: "2026-10-07T07:30:00.000Z", soldBy: "S", uploadDate: "2026-09-26",
      airtableUrl: "https://airtable.com",
      imageUrl: "https://scdn.line-apps.com/n/channel_devcenter/img/fx/01_1_cafe.png",
      brandName: "CHANEL", modelName: "Classic Card Holder",
    };
    return caseNumber === 2 ? saleSuccessCard(productId, soldPrice, publicBaseUrl, product) : alreadyOutCard(product, publicBaseUrl);
  }
  switch (caseNumber) {
    case 4: return soldoutMessages.cancelled(productId);
    case 5: return parseErrorText("missing_product_id");
    case 6: return parseErrorText("invalid_product_id");
    case 7: return parseErrorText("multiple_product_ids");
    case 8: return parseErrorText("missing_price");
    case 9: return parseErrorText("invalid_price");
    case 10: return parseErrorText("multiple_prices");
    case 11: return parseErrorText("unknown_command");
    case 12: return notFoundText("A-999");
    case 13: return soldoutMessages.pending(productId);
    case 14: return soldoutMessages.expired;
    case 15: return soldoutMessages.invalidConfirmationPrice;
    case 16: return soldoutMessages.changed;
    default: return testSoldoutReply(null, publicBaseUrl);
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
      return `⚠️ มีงานสร้างเอกสารกำลังทำงานอยู่ ${result.publicationRunId}`;
    case "already_generated":
      return `⚠️ สร้างเอกสารของ Publication Run นี้แล้ว ${result.publicationRunId}\nหากต้องการสร้างเวอร์ชันใหม่ ตั้งสถานะเป็น Ready แล้วส่งคำสั่ง /docs${publicationDate ? ` ${publicationDate.split("-").reverse().join("/")}` : ""} อีกครั้ง`;
    case "no_runnable_run":
      return publicationDate
        ? `⚠️ ยังไม่มี Publication Run ที่พร้อมสำหรับวันที่ ${publicationDate.split("-").reverse().join("/")} กรุณาตั้งสถานะเป็น Ready`
        : "⚠️ ยังไม่มี Publication Run ที่พร้อมวันนี้";
  }
}

function docsResultReply(result: DocsTriggerResult, publicBaseUrl: string, publicationDate?: string): string | SearchCardReply {
  const text = docsResultText(result, publicationDate);
  switch (result.status) {
    case "started":
    case "regenerating":
    case "restarted":
    case "resumed":
      return { ...docsStartCard(result.publicationRunId, publicBaseUrl, text.slice(0, -(result.publicationRunId.length + 1))), text };
    default: return text;
  }
}

function duplicatePublicationDateText(publicationDate?: string): string {
  return `⚠️ พบวันที่ซ้ำใน Publication Runs กรุณาแก้ให้มีเพียง 1 รอบต่อวัน แล้วลอง /docs${publicationDate ? ` ${publicationDate.split("-").reverse().join("/")}` : ""} อีกครั้ง`;
}

function testDocsReply(caseNumber: number | null, publicBaseUrl: string): string | SearchCardReply {
  const labels = ["เริ่มสร้างเอกสาร", "เริ่มสร้างเวอร์ชัน v2", "เริ่มสร้างใหม่", "ทำงานต่อ", "กำลังทำงานอยู่", "สร้างเอกสารแล้ว", "ไม่มีรอบพร้อมวันนี้", "ไม่มีรอบพร้อมสำหรับวันที่เลือก", "วันที่ไม่ถูกต้อง", "วันที่ซ้ำ", "สร้างเอกสารสำเร็จ", "ข้อมูลสินค้าไม่ครบ", "Workflow ล้มเหลว"];
  if (caseNumber === null) return commandListCard(publicBaseUrl, "/testdocs", "ตัวอย่างข้อความ /docs", "setting-yellow-v1", labels.map((label, index) => [String(index + 1), label]));
  const publicationRunId = "recPreviewOnly";
  const thaiDate = "7 ตุลาคม 2569";
  if (caseNumber <= 7) {
    const results: DocsTriggerResult[] = [
      { status: "started", publicationRunId },
      { status: "regenerating", publicationRunId, generation: 2 },
      { status: "restarted", publicationRunId },
      { status: "resumed", publicationRunId },
      { status: "already_running", publicationRunId },
      { status: "already_generated", publicationRunId },
      { status: "no_runnable_run" },
    ];
    return docsResultReply(results[caseNumber - 1]!, publicBaseUrl);
  }
  switch (caseNumber) {
    case 8: return docsResultText({ status: "no_runnable_run" }, "2026-10-08");
    case 9: return parseErrorText("invalid_publication_date");
    case 10: return duplicatePublicationDateText("2026-10-08");
    case 11: return docsSuccessCard({ thaiDate, productIds: ["A-29", "A-30"], googleDocUrl: "https://docs.google.com/document/" }, publicBaseUrl);
    case 12: return docsValidationFailureCard({
      thaiDate, airtableRunUrl: "https://airtable.com",
      validation: { valid: false, productsMissingFields: [{ productId: "A-30", missingFields: ["Product Images (needs at least 4)", "IG Price"] }] },
    }, publicBaseUrl);
    case 13: return docsWorkflowFailureCard({ thaiDate, reason: "Google token exchange failed with status 400", airtableRunUrl: "https://airtable.com" }, publicBaseUrl);
    default: return testDocsReply(null, publicBaseUrl);
  }
}

export async function handleReadOnlyCommand(
  command: Extract<ParsedCommand, { type: "report" | "help" | "search" | "upload" | "testupload" | "testsearch" | "testsoldout" | "testdocs" | "docs" }>,
  deps: ReadOnlyDeps,
): Promise<string | SearchCardReply> {
  if (command.type === "testupload") return testUploadReply(command.caseNumber, deps.publicBaseUrl);
  if (command.type === "testsearch") return testSearchReply(command.caseNumber, deps.publicBaseUrl);
  if (command.type === "testsoldout") return testSoldoutReply(command.caseNumber, deps.publicBaseUrl);
  if (command.type === "testdocs") return testDocsReply(command.caseNumber, deps.publicBaseUrl);
  if (command.type === "report") {
    const today = todayBangkokDate(deps.clock);
    const date = command.reportDate ?? today;
    try {
      const products = await deps.inventory.listSalesForDay(date);
      return dailySalesReportCard(products, date, command.page, date === today);
    } catch (error) {
      if (!(error instanceof OperationalError)) throw error;
      if (["airtable_inventory_report_invalid_record", "sales_report_invalid_total"].includes(error.code)) {
        return "⚠️ สรุปยอดขายไม่ได้ เพราะข้อมูลการขายใน Airtable ไม่ครบหรือไม่ถูกต้อง กรุณาตรวจสอบแล้วลอง /report อีกครั้ง";
      }
      if (!error.code.startsWith("airtable_inventory_")) throw error;
      return "⚠️ ดึงข้อมูลยอดขายไม่สำเร็จ กรุณาลอง /report อีกครั้ง";
    }
  }
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
    return docsResultReply(result, deps.publicBaseUrl, command.publicationDate);
  } catch (error) {
    if (!(error instanceof OperationalError) || error.code !== "airtable_duplicate_publication_date") throw error;
    return duplicatePublicationDateText(command.publicationDate);
  }
}
