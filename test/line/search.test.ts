import { OperationalError } from "../../src/shared/errors";
import { parseLineCommand } from "../../src/line/parser";
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
    clock: { now: () => new Date("2026-10-06T17:00:00Z") },
    publicBaseUrl: "https://worker.example",
    inventory: { listSalesForDay: vi.fn().mockResolvedValue([]), findByProductId: vi.fn().mockResolvedValue(null) },
    triggerUpload: vi.fn<() => Promise<UploadTriggerResult>>().mockResolvedValue(upload),
    triggerDocs: vi.fn<() => Promise<DocsTriggerResult>>().mockResolvedValue(docs),
  };
}

it("returns Thai not-found text for an unknown Product ID", async () => {
  await expect(handleReadOnlyCommand({ type: "search", productId: "A-404" }, deps()))
    .resolves.toContain("ไม่พบสินค้า A-404");
});

const uploadCases: Array<[UploadTriggerResult, string]> = [
  [{ status: "started", importRunId: "import-1" }, "เริ่มการนำเข้าสินค้า\nimport-1"],
  [{ status: "already_running" }, "⚠️ มีงานนำเข้ากำลังทำงานอยู่"],
  [{ status: "sequence_not_bootstrapped" }, "⚠️ ยังเริ่มนำเข้าไม่ได้ เพราะยังไม่ได้ตั้งค่าลำดับรหัสสินค้า"],
  [{ status: "workflow_start_failed" }, "⚠️ เริ่มงานนำเข้าไม่สำเร็จ กรุณาลอง /upload อีกครั้ง"],
  [{ status: "import_trigger_failed" }, "⚠️ ระบบเริ่มงานนำเข้าขัดข้อง กรุณาลอง /upload อีกครั้ง"],
];

it.each(uploadCases)("maps upload result %j to its Thai reply", async (result, expected) => {
  const d = deps(result);
  const reply = await handleReadOnlyCommand({ type: "upload" }, d);
  if (result.status === "started") {
    expect(reply).toMatchObject({
      kind: "flex", text: expected,
      contents: {
        type: "bubble",
        body: { contents: [
          { contents: [
            { type: "image", url: "https://worker.example/line/icons/image-v1.png" },
            { contents: [{ text: "/upload" }, { text: "เริ่มการนำเข้าสินค้า", weight: "bold" }] },
          ] },
          { type: "text", text: "import-1", wrap: true },
        ] },
      },
    });
  } else {
    expect(reply).toBe(expected);
  }
  expect(d.triggerUpload).toHaveBeenCalledOnce();
});

const docsCases: Array<[DocsTriggerResult, string]> = [
  [{ status: "regenerating", publicationRunId: "run-1", generation: 2 }, "เริ่มสร้างเอกสารเวอร์ชัน v2 แล้ว run-1"],
  [{ status: "started", publicationRunId: "run-1" }, "เริ่มสร้างเอกสารแล้ว run-1"],
  [{ status: "restarted", publicationRunId: "run-1" }, "เริ่มสร้างเอกสารใหม่แล้ว run-1"],
  [{ status: "resumed", publicationRunId: "run-1" }, "ทำงานสร้างเอกสารต่อแล้ว run-1"],
  [{ status: "already_running", publicationRunId: "run-1" }, "⚠️ มีงานสร้างเอกสารกำลังทำงานอยู่ run-1"],
  [{ status: "already_generated", publicationRunId: "run-1" }, "⚠️ สร้างเอกสารของ Publication Run นี้แล้ว run-1\nหากต้องการสร้างเวอร์ชันใหม่ ตั้งสถานะเป็น Ready แล้วส่งคำสั่ง /docs อีกครั้ง"],
  [{ status: "no_runnable_run" }, "⚠️ ยังไม่มี Publication Run ที่พร้อมวันนี้"],
];

it.each(docsCases)("maps docs result %j to its Thai reply", async (result, expected) => {
  const d = deps({ status: "already_running" }, result);
  const reply = await handleReadOnlyCommand({ type: "docs" }, d);
  if (["started", "regenerating", "restarted", "resumed"].includes(result.status)) {
    expect(reply).toMatchObject({ kind: "flex", text: expected, contents: { type: "bubble" } });
    expect(JSON.stringify(reply)).toContain('"text":"/docs"');
    expect(JSON.stringify(reply)).toContain("/line/icons/doc-v1.png");
  } else expect(reply).toBe(expected);
  expect(d.triggerDocs).toHaveBeenCalledOnce();
});

it("previews every upload case without invoking a pipeline or inventory lookup", async () => {
  const d = deps();
  for (const suffix of ["", " 0", " 11", " abc", ...Array.from({ length: 10 }, (_, index) => ` ${index + 1}`)]) {
    const parsed = parseLineCommand(`/testupload${suffix}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.command.type !== "testupload") throw new Error("Expected preview command");
    const reply = await handleReadOnlyCommand(parsed.command, d);
    const text = typeof reply === "string" ? reply : reply.text;
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("ตัวอย่าง /testupload");
    if (typeof reply !== "string") expect(JSON.stringify(reply.contents)).not.toContain("ตัวอย่าง /testupload");
  }
  expect(d.triggerUpload).not.toHaveBeenCalled();
  expect(d.triggerDocs).not.toHaveBeenCalled();
  expect(d.inventory.findByProductId).not.toHaveBeenCalled();
});

it("previews search cards and errors without reading inventory or running pipelines", async () => {
  const d = deps();
  for (const suffix of ["", " 0", " 10", " abc", ...Array.from({ length: 9 }, (_, index) => ` ${index + 1}`)]) {
    const parsed = parseLineCommand(`/testsearch${suffix}`);
    if (!parsed.ok || parsed.command.type !== "testsearch") throw new Error("Expected search preview");
    const reply = await handleReadOnlyCommand(parsed.command, d);
    if (parsed.command.caseNumber === null) {
      expect(reply).toMatchObject({ kind: "flex", contents: { type: "bubble" } });
    } else if (parsed.command.caseNumber <= 5) {
      expect(reply).toMatchObject({ kind: "flex", contents: { type: "bubble" } });
      if (typeof reply === "string") throw new Error("Expected card");
      expect(Boolean(reply.contents.hero)).toBe(parsed.command.caseNumber !== 3);
      if (parsed.command.caseNumber === 4) expect(JSON.stringify(reply.contents)).toContain("Classic Card Holder");
      if (parsed.command.caseNumber === 5) expect(JSON.stringify(reply.contents)).toContain("ไม่พบข้อมูล");
    } else expect(typeof reply).toBe("string");
  }
  expect(d.inventory.findByProductId).not.toHaveBeenCalled();
  expect(d.triggerUpload).not.toHaveBeenCalled();
  expect(d.triggerDocs).not.toHaveBeenCalled();
});

it("previews soldout cases with safe confirmation buttons and no pipeline calls", async () => {
  const d = deps();
  for (const suffix of ["", " 0", " 17", " abc", ...Array.from({ length: 16 }, (_, index) => ` ${index + 1}`)]) {
    const parsed = parseLineCommand(`/testsoldout${suffix}`);
    if (!parsed.ok || parsed.command.type !== "testsoldout") throw new Error("Expected soldout preview");
    const reply = await handleReadOnlyCommand(parsed.command, d);
    if (parsed.command.caseNumber === null || parsed.command.caseNumber <= 3) {
      expect(reply).toMatchObject({ kind: "flex" });
      if (typeof reply === "string") throw new Error("Expected Flex card");
      if (parsed.command.caseNumber === 1) {
        const card = JSON.stringify(reply.contents);
        expect(card).not.toContain('"type":"postback"');
        expect(card).toContain('"text":"/testsoldout 2"');
        expect(card).toContain('"text":"/testsoldout 4"');
      }
    } else expect(typeof reply).toBe("string");
  }
  expect(d.inventory.findByProductId).not.toHaveBeenCalled();
  expect(d.triggerUpload).not.toHaveBeenCalled();
  expect(d.triggerDocs).not.toHaveBeenCalled();
});

it("previews all docs replies without invoking workflows or inventory reads", async () => {
  const d = deps();
  for (const suffix of ["", " 0", " 14", " abc", ...Array.from({ length: 13 }, (_, index) => ` ${index + 1}`)]) {
    const parsed = parseLineCommand(`/testdocs${suffix}`);
    if (!parsed.ok || parsed.command.type !== "testdocs") throw new Error("Expected docs preview");
    const reply = await handleReadOnlyCommand(parsed.command, d);
    if (parsed.command.caseNumber === null || parsed.command.caseNumber <= 4 || parsed.command.caseNumber >= 11) expect(reply).toMatchObject({ kind: "flex", contents: { type: "bubble" } });
    else expect(typeof reply).toBe("string");
    expect(reply).not.toBe("");
  }
  expect(d.triggerDocs).not.toHaveBeenCalled();
  expect(d.triggerUpload).not.toHaveBeenCalled();
  expect(d.inventory.findByProductId).not.toHaveBeenCalled();
});

it("routes daily reports with Bangkok dates and no pipeline calls", async () => {
  const d = deps();
  await expect(handleReadOnlyCommand({ type: "report", page: 1 }, d)).resolves.toMatchObject({ kind: "flex" });
  expect(d.inventory.listSalesForDay).toHaveBeenLastCalledWith("2026-10-07");
  d.clock = { now: () => new Date("2026-10-06T16:59:59.999Z") };
  await handleReadOnlyCommand({ type: "report", page: 1 }, d);
  expect(d.inventory.listSalesForDay).toHaveBeenLastCalledWith("2026-10-06");
  await handleReadOnlyCommand({ type: "report", reportDate: "2026-01-01", page: 1 }, d);
  expect(d.inventory.listSalesForDay).toHaveBeenLastCalledWith("2026-01-01");
  const reply = await handleReadOnlyCommand({ type: "report", reportDate: "2026-01-01", page: 2 }, d);
  expect(reply).toContain("/report 01/01/2026");
  expect(d.inventory.findByProductId).not.toHaveBeenCalled();
  expect(d.triggerUpload).not.toHaveBeenCalled(); expect(d.triggerDocs).not.toHaveBeenCalled();
});

it.each(["airtable_inventory_report_invalid_record", "sales_report_invalid_total", "airtable_inventory_report_failed", "airtable_inventory_invalid_response", "airtable_inventory_report_invalid_response"])("maps report failure %s to warning instead of zero revenue", async code => {
  const d = deps();
  vi.mocked(d.inventory.listSalesForDay).mockRejectedValue(new OperationalError(code, "private diagnostic", false));
  const reply = await handleReadOnlyCommand({ type: "report", page: 1 }, d);
  expect(reply).toContain("⚠️"); expect(reply).not.toContain("0 บาท"); expect(reply).not.toContain("private diagnostic");
  expect(reply).toContain(["airtable_inventory_report_invalid_record", "sales_report_invalid_total"].includes(code) ? "ข้อมูลการขาย" : "ดึงข้อมูลยอดขาย");
});

it("does not swallow unexpected programming errors in reports", async () => {
  const d = deps();
  vi.mocked(d.inventory.listSalesForDay).mockRejectedValue(new Error("unexpected"));
  await expect(handleReadOnlyCommand({ type: "report", page: 1 }, d)).rejects.toThrow("unexpected");
});
