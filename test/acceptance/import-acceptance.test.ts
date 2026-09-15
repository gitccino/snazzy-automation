import { NonRetryableError } from "cloudflare:workflows";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testEnv } from "../helpers/env";
import { fixedClock, sequentialIdGenerator } from "../helpers/fakes";
import {
  MutableBatchSource,
  fakeMarkerDetector,
  productGroupOf,
  type BatchPhotoSpec,
} from "../helpers/import-fixtures";
import { createAuditLog } from "../../src/db/audit";
import { createImportRepository } from "../../src/db/import-repository";
import { createSequenceRepository } from "../../src/db/sequence-repository";
import type {
  AirtableProductPayload,
  AirtableProductsClient,
} from "../../src/import/airtable-products";
import { createAssetStore } from "../../src/import/asset-store";
import { sendImportSummary } from "../../src/import/notify";
import {
  downloadAndGroupSnapshot,
  finalizeImportRun,
  processProductGroupAttempt,
  recordExhaustedGroupFailure,
  type ProcessGroupDeps,
} from "../../src/import/service";
import type { ImportRunResult, ImportWorkflowParams } from "../../src/import/types";
import { runImportWorkflow } from "../../src/import/workflow";
import { OperationalError } from "../../src/shared/errors";

function retryingStep() {
  return {
    async do<T>(
      _name: string,
      optionsOrCallback: unknown,
      maybeCallback?: () => Promise<T>,
    ): Promise<T> {
      const hasOptions = typeof optionsOrCallback !== "function";
      const callback = (
        hasOptions ? maybeCallback : optionsOrCallback
      ) as () => Promise<T>;
      const retryLimit = hasOptions
        ? ((optionsOrCallback as { retries?: { limit: number } }).retries
            ?.limit ?? 0)
        : 0;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await callback();
        } catch (error) {
          if (attempt >= retryLimit || error instanceof NonRetryableError) {
            throw error;
          }
        }
      }
    },
  };
}

interface CreatedProduct {
  recordId: string;
  productId: string;
  systemGroupId: string;
  uploadDate: string;
  inventoryStatus: "In";
  productImages: Array<{ url: string; filename: string }>;
}

interface Harness {
  deps: ProcessGroupDeps;
  source: MutableBatchSource;
  created: Map<string, CreatedProduct>;
  push: ReturnType<typeof vi.fn>;
  startAndRun(
    runId: string,
    trigger: ImportWorkflowParams["trigger"],
  ): Promise<ImportRunResult>;
  resumeRun(
    runId: string,
    trigger: ImportWorkflowParams["trigger"],
  ): Promise<ImportRunResult>;
}

async function buildHarness(
  sourceAlbumId: string,
  specs: BatchPhotoSpec[],
  options: {
    firstImportCutoffDate?: string | null;
    idPrefix: string;
    createProduct?: (
      payload: AirtableProductPayload,
    ) => Promise<{ recordId: string }>;
  },
): Promise<Harness> {
  const env = testEnv();
  await env.DB.prepare("DELETE FROM sequences WHERE name = 'product_id'").run();
  const clock = fixedClock("2026-09-01T09:00:00.000Z");
  const repo = createImportRepository(
    env.DB,
    sequentialIdGenerator("row"),
    clock,
  );
  const sequences = createSequenceRepository(env.DB);
  await sequences.bootstrap("product_id", 501);
  const created = new Map<string, CreatedProduct>();
  const airtable: AirtableProductsClient = {
    async findBySystemGroupId(systemGroupId) {
      const row = created.get(systemGroupId);
      return row === undefined
        ? null
        : { recordId: row.recordId, productId: row.productId };
    },
    async createProduct(payload) {
      const response =
        options.createProduct === undefined
          ? { recordId: `rec-${payload.productId}` }
          : await options.createProduct(payload);
      created.set(payload.systemGroupId, {
        recordId: response.recordId,
        productId: payload.productId,
        systemGroupId: payload.systemGroupId,
        uploadDate: payload.uploadDate,
        inventoryStatus: "In",
        productImages: payload.productImages.map((image) => ({ ...image })),
      });
      return response;
    },
    async verifyProduct(recordId, expected) {
      const row = [...created.values()].find(
        (candidate) => candidate.recordId === recordId,
      );
      return (
        row !== undefined &&
        row.productId === expected.productId &&
        row.systemGroupId === expected.systemGroupId &&
        row.uploadDate === expected.uploadDate &&
        row.inventoryStatus === "In" &&
        row.productImages.length === expected.imageCount &&
        row.productImages.length > 0 &&
        row.productImages.every(
          (image) => image.url.length > 0 && image.filename.length > 0,
        )
      );
    },
    async deleteProduct(recordId) {
      for (const [key, row] of created) {
        if (row.recordId === recordId) {
          created.delete(key);
        }
      }
    },
  };
  const source = new MutableBatchSource(sourceAlbumId, specs);
  const push = vi.fn().mockResolvedValue(undefined);
  const deps: ProcessGroupDeps = {
    imageSource: source,
    marker: fakeMarkerDetector,
    repo,
    assets: createAssetStore(
      env.IMAGES_BUCKET,
      {
        signingSecret: "test-secret",
        publicBaseUrl: "https://example.workers.dev",
      },
      clock,
    ),
    clock,
    ids: sequentialIdGenerator(options.idPrefix),
    sourceAlbumId,
    firstImportCutoffDate: options.firstImportCutoffDate ?? null,
    sequences,
    audit: createAuditLog(
      env.DB,
      sequentialIdGenerator(`${options.idPrefix}-audit`),
      clock,
    ),
    airtable,
    productIdPrefix: "A",
    assetUrlTtlSeconds: 300,
  };

  async function resumeRun(
    runId: string,
    trigger: ImportWorkflowParams["trigger"],
  ): Promise<ImportRunResult> {
    const payload: ImportWorkflowParams = {
      importRunId: runId,
      sourceAlbumId,
      trigger,
    };
    return runImportWorkflow(deps, payload, retryingStep(), {
      retryLimit: 5,
      downloadAndGroup: () => downloadAndGroupSnapshot(deps, runId),
      processGroupAttempt: processProductGroupAttempt,
      recordExhaustedFailure: recordExhaustedGroupFailure,
      finalize: (hadFailures, orphanPhotoCount, checkpointPosition) =>
        finalizeImportRun(
          repo,
          runId,
          sourceAlbumId,
          hadFailures,
          orphanPhotoCount,
          checkpointPosition,
        ),
      notify: (result, orphanRange) =>
        sendImportSummary({ pushMessage: push }, "CtestGroup", {
          result,
          orphanRange,
          nowThaiText: "2026-09-01 16:00 ICT",
        }),
    });
  }

  return {
    deps,
    source,
    created,
    push,
    async startAndRun(runId, trigger) {
      await repo.createImportRun({ id: runId, sourceAlbumId, trigger });
      return resumeRun(runId, trigger);
    },
    resumeRun,
  };
}

async function groupStates(runId: string): Promise<
  Array<{ product_id: string | null; state: string; attempt_count: number; failure_reason: string | null }>
> {
  const rows = await testEnv()
    .DB.prepare(
      `SELECT product_id, state, attempt_count, failure_reason
       FROM product_groups WHERE import_run_id = ? ORDER BY ordinal`,
    )
    .bind(runId)
    .all<{
      product_id: string | null;
      state: string;
      attempt_count: number;
      failure_reason: string | null;
    }>();
  return rows.results;
}

async function auditActions(correlationId: string): Promise<string[]> {
  const rows = await testEnv()
    .DB.prepare(
      "SELECT action FROM audit_events WHERE correlation_id = ? ORDER BY rowid",
    )
    .bind(correlationId)
    .all<{ action: string }>();
  return rows.results.map((row) => row.action);
}

describe("import acceptance", () => {
  beforeEach(async () => {
    const db = testEnv().DB;
    await db.batch([
      db.prepare("DELETE FROM audit_events"),
      db.prepare("DELETE FROM product_groups"),
      db.prepare("DELETE FROM photo_assets"),
      db.prepare("DELETE FROM import_checkpoints"),
      db.prepare("DELETE FROM import_runs"),
      db.prepare("DELETE FROM sequences"),
    ]);
  });

  it("1. imports a 100-photo snapshot into nine deterministic Products", async () => {
    const specs = [
      ...Array.from({ length: 8 }, (_, index) => productGroupOf(10, index + 1)).flat(),
      ...productGroupOf(11, 9),
    ];
    expect(specs).toHaveLength(100);
    const harness = await buildHarness(`album-${crypto.randomUUID()}`, specs, { idPrefix: "case-1-id" });

    const result = await harness.startAndRun("case-1-run-1", "cron");

    expect(result).toEqual({
      importRunId: "case-1-run-1",
      succeededProductIds: ["A-501", "A-502", "A-503", "A-504", "A-505", "A-506", "A-507", "A-508", "A-509"],
      failedGroups: [],
    });
    expect([...harness.created.values()].map((row) => [row.productId, row.uploadDate, row.inventoryStatus, row.productImages.length])).toEqual([
      ["A-501", "2026-09-01", "In", 10], ["A-502", "2026-09-01", "In", 10], ["A-503", "2026-09-01", "In", 10],
      ["A-504", "2026-09-01", "In", 10], ["A-505", "2026-09-01", "In", 10], ["A-506", "2026-09-01", "In", 10],
      ["A-507", "2026-09-01", "In", 10], ["A-508", "2026-09-01", "In", 10], ["A-509", "2026-09-01", "In", 11],
    ]);
    expect(await groupStates("case-1-run-1")).toEqual([
      { product_id: "A-501", state: "succeeded", attempt_count: 1, failure_reason: null },
      { product_id: "A-502", state: "succeeded", attempt_count: 1, failure_reason: null },
      { product_id: "A-503", state: "succeeded", attempt_count: 1, failure_reason: null },
      { product_id: "A-504", state: "succeeded", attempt_count: 1, failure_reason: null },
      { product_id: "A-505", state: "succeeded", attempt_count: 1, failure_reason: null },
      { product_id: "A-506", state: "succeeded", attempt_count: 1, failure_reason: null },
      { product_id: "A-507", state: "succeeded", attempt_count: 1, failure_reason: null },
      { product_id: "A-508", state: "succeeded", attempt_count: 1, failure_reason: null },
      { product_id: "A-509", state: "succeeded", attempt_count: 1, failure_reason: null },
    ]);
    expect(await auditActions("case-1-run-1")).toHaveLength(18);
  });

  it("2. preserves 9, 12, and 15-photo attachment counts", async () => {
    const harness = await buildHarness(`album-${crypto.randomUUID()}`, [
      ...productGroupOf(9, 1), ...productGroupOf(12, 2), ...productGroupOf(15, 3),
    ], { idPrefix: "case-2-id" });

    const result = await harness.startAndRun("case-2-run-1", "cron");

    expect(result.succeededProductIds).toEqual(["A-501", "A-502", "A-503"]);
    expect([...harness.created.values()].map((row) => ({
      productId: row.productId,
      imageCount: row.productImages.length,
      hasReferences: row.productImages.every((image) => image.url.length > 0 && image.filename.length > 0),
    }))).toEqual([
      { productId: "A-501", imageCount: 9, hasReferences: true },
      { productId: "A-502", imageCount: 12, hasReferences: true },
      { productId: "A-503", imageCount: 15, hasReferences: true },
    ]);
  });

  it("3. applies first-run cutoff then saves explicit snapshot checkpoint", async () => {
    const harness = await buildHarness(`album-${crypto.randomUUID()}`, [
      ...productGroupOf(9, 1, "2026-08-31T23:59:59.000Z"),
      ...productGroupOf(9, 2, "2026-09-01T00:00:00.000Z"),
    ], { firstImportCutoffDate: "2026-09-01T00:00:00.000Z", idPrefix: "case-3-id" });

    const result = await harness.startAndRun("case-3-run-1", "cron");

    expect(result.succeededProductIds).toEqual(["A-501"]);
    expect(harness.created.size).toBe(1);
    expect(await harness.deps.repo.getCheckpoint(harness.source.sourceAlbumId)).toBe(20);
    expect(harness.source.downloads).toHaveLength(10);
  });

  it("4. unchanged repeated /upload downloads nothing and creates no duplicate", async () => {
    const harness = await buildHarness(`album-${crypto.randomUUID()}`, productGroupOf(9, 1), { idPrefix: "case-4-id" });
    await harness.startAndRun("case-4-run-1", "cron");

    const repeated = await harness.startAndRun("case-4-run-2", "line");

    expect(repeated).toEqual({ importRunId: "case-4-run-2", succeededProductIds: [], failedGroups: [] });
    expect([...harness.created.values()].map((row) => row.productId)).toEqual(["A-501"]);
    expect(harness.source.downloads).toHaveLength(10);
    expect(await harness.deps.repo.getCheckpoint(harness.source.sourceAlbumId)).toBe(10);
  });

  it("5. resumes the same durable run after interruption following download", async () => {
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const harness = await buildHarness(sourceAlbumId, productGroupOf(9, 1), { idPrefix: "case-5-id" });
    await harness.deps.repo.createImportRun({ id: "case-5-run-interrupted", sourceAlbumId, trigger: "cron" });
    await downloadAndGroupSnapshot(harness.deps, "case-5-run-interrupted");

    const result = await harness.resumeRun("case-5-run-interrupted", "cron");

    expect(result).toEqual({ importRunId: "case-5-run-interrupted", succeededProductIds: ["A-501"], failedGroups: [] });
    expect(harness.source.downloads).toHaveLength(10);
    const run = await testEnv().DB.prepare("SELECT status FROM import_runs WHERE id = ?").bind("case-5-run-interrupted").first<{ status: string }>();
    expect(run).toEqual({ status: "completed" });
  });

  it("6. exhausted failure leaves successful sibling intact", async () => {
    const harness = await buildHarness(`album-${crypto.randomUUID()}`, [
      ...productGroupOf(9, 1), ...productGroupOf(9, 2),
    ], { createProduct: async (payload) => {
      if (payload.productId === "A-501") throw new OperationalError("airtable_rate_limited", "rate limited", true);
      return { recordId: `rec-${payload.productId}` };
    }, idPrefix: "case-6-id" });

    const result = await harness.startAndRun("case-6-run-1", "cron");

    expect(result).toEqual({
      importRunId: "case-6-run-1", succeededProductIds: ["A-502"],
      failedGroups: [{ groupId: "case-6-id-21", productId: "A-501", errorCode: "airtable_rate_limited" }],
    });
    expect([...harness.created.values()].map((row) => row.productId)).toEqual(["A-502"]);
    expect(await groupStates("case-6-run-1")).toEqual([
      { product_id: "A-501", state: "failed", attempt_count: 6, failure_reason: "airtable_rate_limited" },
      { product_id: "A-502", state: "succeeded", attempt_count: 1, failure_reason: null },
    ]);
    expect((await auditActions("case-6-run-1")).filter((action) => action === "product_group_attempt_failed")).toHaveLength(6);
  });

  it("7. reports every exhausted group with burned Product ID and code", async () => {
    const harness = await buildHarness(`album-${crypto.randomUUID()}`, [
      ...productGroupOf(9, 1), ...productGroupOf(9, 2), ...productGroupOf(9, 3),
    ], { createProduct: async () => {
      throw new OperationalError("airtable_rate_limited", "rate limited", true);
    }, idPrefix: "case-7-id" });

    const result = await harness.startAndRun("case-7-run-1", "cron");

    expect(result).toEqual({
      importRunId: "case-7-run-1", succeededProductIds: [],
      failedGroups: [
        { groupId: "case-7-id-31", productId: "A-501", errorCode: "airtable_rate_limited" },
        { groupId: "case-7-id-32", productId: "A-502", errorCode: "airtable_rate_limited" },
        { groupId: "case-7-id-33", productId: "A-503", errorCode: "airtable_rate_limited" },
      ],
    });
    expect(await groupStates("case-7-run-1")).toEqual([
      { product_id: "A-501", state: "failed", attempt_count: 6, failure_reason: "airtable_rate_limited" },
      { product_id: "A-502", state: "failed", attempt_count: 6, failure_reason: "airtable_rate_limited" },
      { product_id: "A-503", state: "failed", attempt_count: 6, failure_reason: "airtable_rate_limited" },
    ]);
    expect((await auditActions("case-7-run-1")).filter((action) => action === "product_id_allocated")).toHaveLength(3);
  });

  it("8. later /upload resets a failed group with a fresh ID and imports its new sibling", async () => {
    let failBurnedGroup = true;
    const firstSpecs = productGroupOf(9, 1);
    const harness = await buildHarness(`album-${crypto.randomUUID()}`, firstSpecs, {
      createProduct: async (payload) => {
        if (failBurnedGroup) throw new OperationalError("airtable_timeout", "timeout", true);
        return { recordId: `rec-${payload.productId}` };
      },
      idPrefix: "case-8-id",
    });
    const first = await harness.startAndRun("case-8-run-1", "cron");
    failBurnedGroup = false;
    harness.source.setSpecs([...firstSpecs, ...productGroupOf(9, 2)]);

    const second = await harness.startAndRun("case-8-run-2", "line");

    expect(first).toEqual({
      importRunId: "case-8-run-1", succeededProductIds: [],
      failedGroups: [{ groupId: "case-8-id-11", productId: "A-501", errorCode: "airtable_timeout" }],
    });
    expect(second).toEqual({ importRunId: "case-8-run-2", succeededProductIds: ["A-502", "A-503"], failedGroups: [] });
    expect([...harness.created.values()].map((row) => row.productId)).toEqual(["A-502", "A-503"]);
    const rows = await testEnv().DB.prepare("SELECT product_id, state, attempt_count FROM product_groups WHERE import_run_id = ? ORDER BY ordinal").bind("case-8-run-2").all();
    expect(rows.results).toEqual([
      { product_id: "A-502", state: "succeeded", attempt_count: 1 },
      { product_id: "A-503", state: "succeeded", attempt_count: 1 },
    ]);
  });

  it("9. keeps Product IDs unique across three cumulative batches", async () => {
    const cumulative: BatchPhotoSpec[] = [...productGroupOf(10, 1)];
    const harness = await buildHarness(`album-${crypto.randomUUID()}`, cumulative, { idPrefix: "case-9-id" });
    const results: ImportRunResult[] = [];
    for (let batch = 1; batch <= 3; batch += 1) {
      if (batch > 1) {
        cumulative.push(...productGroupOf(10, batch));
        harness.source.setSpecs([...cumulative]);
      }
      results.push(await harness.startAndRun(`case-9-run-${batch}`, "cron"));
    }

    expect(results).toEqual([
      { importRunId: "case-9-run-1", succeededProductIds: ["A-501"], failedGroups: [] },
      { importRunId: "case-9-run-2", succeededProductIds: ["A-502"], failedGroups: [] },
      { importRunId: "case-9-run-3", succeededProductIds: ["A-503"], failedGroups: [] },
    ]);
    expect([...harness.created.values()].map((row) => row.productId)).toEqual(["A-501", "A-502", "A-503"]);
  });

  it("10. processes 500 photos and sends the exact success and failure summary", async () => {
    const specs = [
      ...Array.from({ length: 44 }, (_, index) => productGroupOf(10, index + 1)).flat(),
      ...productGroupOf(15, 45),
    ];
    expect(specs).toHaveLength(500);
    const harness = await buildHarness(`album-${crypto.randomUUID()}`, specs, {
      createProduct: async (payload) => {
        if (payload.productId === "A-502") throw new OperationalError("airtable_rate_limited", "rate limited", true);
        return { recordId: `rec-${payload.productId}` };
      },
      idPrefix: "case-10-id",
    });

    const result = await harness.startAndRun("case-10-run-500", "cron");

    const expectedSucceeded = ["A-501", "A-503", "A-504", "A-505", "A-506", "A-507", "A-508", "A-509", "A-510", "A-511", "A-512", "A-513", "A-514", "A-515", "A-516", "A-517", "A-518", "A-519", "A-520", "A-521", "A-522", "A-523", "A-524", "A-525", "A-526", "A-527", "A-528", "A-529", "A-530", "A-531", "A-532", "A-533", "A-534", "A-535", "A-536", "A-537", "A-538", "A-539", "A-540", "A-541", "A-542", "A-543", "A-544", "A-545"];
    expect(result).toEqual({
      importRunId: "case-10-run-500", succeededProductIds: expectedSucceeded,
      failedGroups: [{ groupId: "case-10-id-502", productId: "A-502", errorCode: "airtable_rate_limited" }],
    });
    expect(harness.push).toHaveBeenCalledTimes(1);
    const expectedSummary = "นำเข้ารูปภาพ — 2026-09-01 16:00 ICT\nสำเร็จ 44 รายการ\nA-501, A-503, A-504, A-505, A-506, A-507, A-508, A-509, A-510, A-511, A-512, A-513, A-514, A-515, A-516, A-517, A-518, A-519, A-520, A-521, A-522, A-523, A-524, A-525, A-526, A-527, A-528, A-529, A-530, A-531, A-532, A-533, A-534, A-535, A-536, A-537, A-538, A-539, A-540, A-541, A-542, A-543, A-544, A-545\nล้มเหลว 1 รายการ\n- กลุ่ม case-10-id-502 (A-502): airtable_rate_limited\nแก้ไขแล้วพิมพ์ /upload เพื่อลองใหม่";
    expect(harness.push).toHaveBeenCalledWith("CtestGroup", expectedSummary);
    expect([...harness.created.values()].map((row) => row.productId)).toEqual(expectedSucceeded);
  });
});
