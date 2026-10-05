import { expect, it, vi } from "vitest";
import {
  handleReadOnlyCommand,
  type DocsTriggerResult,
  type ReadOnlyDeps,
  type UploadTriggerResult,
} from "../../src/line/search";

function deps(
  upload: UploadTriggerResult = { status: "already_running" },
  docs: DocsTriggerResult = { status: "no_runnable_run" },
): ReadOnlyDeps {
  return {
    publicBaseUrl: "https://worker.example",
    inventory: { findByProductId: vi.fn().mockResolvedValue(null) },
    triggerUpload: vi.fn<() => Promise<UploadTriggerResult>>().mockResolvedValue(upload),
    triggerDocs: vi.fn<() => Promise<DocsTriggerResult>>().mockResolvedValue(docs),
  };
}

it("returns Thai not-found text for an unknown Product ID", async () => {
  await expect(handleReadOnlyCommand({ type: "search", productId: "A-404" }, deps()))
    .resolves.toContain("ไม่พบสินค้า A-404");
});

const uploadCases: Array<[UploadTriggerResult, string]> = [
  [{ status: "started", importRunId: "import-1" }, "เริ่มนำเข้าแล้ว import-1"],
  [{ status: "already_running" }, "มีงานนำเข้ากำลังทำงานอยู่"],
  [{ status: "sequence_not_bootstrapped" }, "ยังเริ่มนำเข้าไม่ได้ เพราะยังไม่ได้ตั้งค่าลำดับรหัสสินค้า"],
  [{ status: "workflow_start_failed" }, "เริ่มงานนำเข้าไม่สำเร็จ กรุณาลอง /upload อีกครั้ง"],
  [{ status: "import_trigger_failed" }, "ระบบเริ่มงานนำเข้าขัดข้อง กรุณาลอง /upload อีกครั้ง"],
];

it.each(uploadCases)("maps upload result %j to its Thai reply", async (result, expected) => {
  const d = deps(result);
  await expect(handleReadOnlyCommand({ type: "upload" }, d)).resolves.toBe(expected);
  expect(d.triggerUpload).toHaveBeenCalledOnce();
});

const docsCases: Array<[DocsTriggerResult, string]> = [
  [{ status: "regenerating", publicationRunId: "run-1", generation: 2 }, "เริ่มสร้างเอกสารเวอร์ชัน v2 แล้ว run-1"],
  [{ status: "started", publicationRunId: "run-1" }, "เริ่มสร้างเอกสารแล้ว run-1"],
  [{ status: "restarted", publicationRunId: "run-1" }, "เริ่มสร้างเอกสารใหม่แล้ว run-1"],
  [{ status: "resumed", publicationRunId: "run-1" }, "ทำงานสร้างเอกสารต่อแล้ว run-1"],
  [{ status: "already_running", publicationRunId: "run-1" }, "มีงานสร้างเอกสารกำลังทำงานอยู่ run-1"],
  [{ status: "already_generated", publicationRunId: "run-1" }, "สร้างเอกสารของ Publication Run นี้แล้ว run-1\nหากต้องการสร้างเวอร์ชันใหม่ ตั้งสถานะเป็น Ready แล้วส่งคำสั่ง /docs อีกครั้ง"],
  [{ status: "no_runnable_run" }, "ยังไม่มี Publication Run ที่พร้อมวันนี้"],
];

it.each(docsCases)("maps docs result %j to its Thai reply", async (result, expected) => {
  const d = deps({ status: "already_running" }, result);
  await expect(handleReadOnlyCommand({ type: "docs" }, d)).resolves.toBe(expected);
  expect(d.triggerDocs).toHaveBeenCalledOnce();
});
