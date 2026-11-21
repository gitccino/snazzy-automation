import { NonRetryableError } from "cloudflare:workflows";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, testEnv } from "../helpers/env";
import { fixedClock, sequentialIdGenerator } from "../helpers/fakes";
import {
  MutableBatchSource,
  fakeMarkerDetector,
  productGroupOf,
  type BatchPhotoSpec,
} from "../helpers/import-fixtures";
import { createAuditLog } from "../../src/db/audit";
import { claimImportVerification, createImportRepository } from "../../src/db/import-repository";
import { createSequenceRepository } from "../../src/db/sequence-repository";
import type {
  AirtableProductPayload,
  AirtableProductsClient,
} from "../../src/import/airtable-products";
import { createAssetStore } from "../../src/import/asset-store";
import { buildImportSummaryCard, buildImportSummaryMessage, sendImportSummary } from "../../src/import/notify";
import {
  downloadAndGroupSnapshot,
  finalizeImportRun,
  processProductGroupAttempt,
  recordExhaustedGroupFailure,
  type ProcessGroupDeps,
} from "../../src/import/service";
import type { ImportRunResult, ImportWorkflowParams } from "../../src/import/types";
import { ImportWorkflow, runImportWorkflow } from "../../src/import/workflow";
import { handleUploadTrigger } from "../../src/routes/upload";
import { handleLineRoute } from "../../src/routes/line";
import { LineCommandWorkflow } from "../../src/line/command-workflow";
import type { Env } from "../../src/env";
import type { WorkflowStep } from "cloudflare:workers";
import * as icloud from "../../src/icloud/client";
import * as marker from "../../src/import/marker";
import * as products from "../../src/import/airtable-products";
import { deriveSourceAlbumId } from "../../src/icloud/client";
import { importWorkflowId, sha256Hex } from "../../src/shared/ids";
import { computeGroupHash } from "../../src/import/grouping";
import { inspectImportGroup } from "../../src/db/import-owner-inspection";
import { routeRequest } from "../../src/router";
import { captureOperationContext } from "../../src/settings/runtime";
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
  runPayload(payload: ImportWorkflowParams): Promise<ImportRunResult>;
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
    contextJson?: string;
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
    airtableBaseId: "base",
    airtableTableId: "table",
    assetUrlTtlSeconds: 300,
  };

  async function resumeRun(
    runId: string,
    trigger: ImportWorkflowParams["trigger"],
    capturedPayload?: ImportWorkflowParams,
  ): Promise<ImportRunResult> {
    const payload: ImportWorkflowParams = capturedPayload ?? {
      importRunId: runId,
      sourceAlbumId,
      trigger,
    };
    return runImportWorkflow(deps, payload, retryingStep(), {
      retryLimit: 5,
      downloadAndGroup: () => downloadAndGroupSnapshot(deps, runId),
      recordRunFailure: (failureReason) =>
        repo.failImportRun({ id: runId, sourceAlbumId, failureReason }),
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
        sendImportSummary({
          pushMessage: push,
          sendReplyMessages: async () => ({requestId:null}),
      replyFlex: async () => undefined,
          replyQuotedText: async () => undefined, replyText: async () => undefined,
          replyButtons: async () => undefined,
          getGroupMemberProfile: async () => ({
            userId: "unused",
            displayName: "unused",
          }),
        }, "CtestGroup", {
          result,
          orphanRange,
          nowThaiText: "2026-09-01 16:00 ICT",
        }, "https://worker.example"),
    });
  }

  return {
    deps,
    source,
    created,
    push,
    async startAndRun(runId, trigger) {
      await repo.createImportRun({ id: runId, sourceAlbumId, trigger });
      if (options.contextJson) await env.DB.prepare("UPDATE import_runs SET settings_context_json=? WHERE id=?").bind(options.contextJson, runId).run();
      return resumeRun(runId, trigger);
    },
    resumeRun,
    runPayload: (payload) => resumeRun(payload.importRunId, payload.trigger, payload),
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
      db.prepare("DELETE FROM import_verification_claims"),
      db.prepare("DELETE FROM audit_events"),
      db.prepare("DELETE FROM airtable_create_claims"),
      db.prepare("DELETE FROM product_group_image_members"),
      db.prepare("DELETE FROM product_groups"),
      db.prepare("DELETE FROM photo_assets"),
      db.prepare("DELETE FROM import_checkpoints"),
      db.prepare("DELETE FROM import_runs"),
      db.prepare("DELETE FROM sequences"),
    ]);
  });

  it("holds an unresolved group absent from a later album scan for owner review", async () => {
    const album = crypto.randomUUID();
    const harness = await buildHarness(album, [...productGroupOf(9, 1), ...productGroupOf(3, 2)], { idPrefix: album, contextJson: JSON.stringify({ replyGroupId: null, settings: { config: { airtableBaseId: "base", airtableProductsTableId: "table" } } }) });
    const first = await harness.startAndRun(crypto.randomUUID(), "admin");
    const unresolved = first.failedGroups[0]!;
    expect(first.succeededProductIds).toEqual(["A-501"]);
    expect(unresolved.errorCode).toBe("insufficient_product_photos");
    harness.source.setSpecs(productGroupOf(9, 1));
    const later = await harness.startAndRun(crypto.randomUUID(), "admin");
    expect(later.failedGroups).toEqual([expect.objectContaining({groupId: unresolved.groupId, errorCode: "historical_group_unavailable"})]);
    const summary = { result: later, orphanRange: null, nowThaiText: "now" };
    expect(buildImportSummaryMessage(summary)).toContain("รายการเดิมรอเจ้าของตรวจสอบ 1 รายการ");
    expect(buildImportSummaryMessage(summary)).not.toContain("พิมพ์ /upload");
    expect(JSON.stringify(buildImportSummaryCard(summary, "https://example.com"))).toContain("รายการเดิมรอเจ้าของตรวจสอบ 1 รายการ");
    expect(harness.created.size).toBe(1);
    const again = await harness.startAndRun(crypto.randomUUID(), "admin");
    expect(again.failedGroups).toEqual(later.failedGroups);
    harness.source.setSpecs([...productGroupOf(9, 1), ...productGroupOf(3, 2)]);
    const present = await harness.startAndRun(crypto.randomUUID(), "admin");
    expect(present.failedGroups).toHaveLength(1);
    expect(present.failedGroups[0]).toMatchObject({ groupId: unresolved.groupId, errorCode: "insufficient_product_photos" });
    harness.source.setSpecs(productGroupOf(9, 1));
    await harness.deps.repo.setGroupState(unresolved.groupId, "succeeded", { productId: "A-999" });
    expect((await harness.startAndRun(crypto.randomUUID(), "admin")).failedGroups).toEqual([]);
  });

  it("only surfaces historical holds to the captured owner and target", async () => {
    const album = crypto.randomUUID(), original = crypto.randomUUID();
    const harness = await buildHarness(album, productGroupOf(3, 1), { idPrefix: album });
    const first = await harness.startAndRun(original, "line");
    const context = (group: string, base = "base") => JSON.stringify({ replyGroupId: group, settings: { config: { airtableBaseId: base, airtableProductsTableId: "table" } } });
    await testEnv().DB.prepare("UPDATE import_runs SET settings_context_json=? WHERE id=?").bind(context("owner"), original).run();
    const read = async (trigger: "line" | "admin", value: string | null, sourceAlbumId = album) => {
      const id = crypto.randomUUID();
      await harness.deps.repo.createImportRun({ id, sourceAlbumId, trigger });
      await testEnv().DB.prepare("UPDATE import_runs SET settings_context_json=? WHERE id=?").bind(value, id).run();
      const holds = await harness.deps.repo.listHistoricalHolds(id);
      await testEnv().DB.prepare("UPDATE import_runs SET status='completed' WHERE id=?").bind(id).run();
      return holds;
    };
    expect(await read("line", context("owner"))).toEqual([expect.objectContaining({ groupId: first.failedGroups[0]!.groupId })]);
    expect(await read("line", context("foreign"))).toEqual([]);
    expect(await read("line", context("owner", "other"))).toEqual([]);
    expect(await read("line", context("owner"), crypto.randomUUID())).toEqual([]);
    expect(await read("admin", context("owner"))).toEqual([]);
    expect(await read("line", null)).toEqual([]);
  });

  it("inspects and repairs a seeded historical group before a fresh signed upload and queued reply", async () => {
    const id = crypto.randomUUID(), owner = `Cowner-${id}`, token = `token-${id}`;
    const album = await deriveSourceAlbumId(token), runId = crypto.randomUUID(), groupId = crypto.randomUUID();
    const photos = ["marker", "a", "b", "c", "d"], bytes = new Uint8Array([255, 216, 255, 4]);
    const hash = await sha256Hex(bytes), groupHash = await computeGroupHash(album, photos.map(applePhotoId => ({ applePhotoId })));
    const config = JSON.parse(createTestEnv().APP_CONFIG_JSON);
    config.LINE_ALLOWED_GROUP_ID = owner;
    const commands: any[] = [], business: any[] = [], replies: any[] = [];
    const harness = await buildHarness(album, [], { idPrefix: id });
    const local = { ...testEnv(), ...createTestEnv(), ICLOUD_SHARED_ALBUM_TOKEN: token, LINE_CHANNEL_SECRET: "secret", APP_CONFIG_JSON: JSON.stringify(config),
      IMAGES_BUCKET: { get: async () => ({ arrayBuffer: async () => bytes.buffer }) },
      IMAGES: { input: () => ({ transform: () => ({ output: async () => ({ response: () => new Response(bytes, { headers: { "content-type": "image/jpeg" } }) }) }) }) },
      LINE_COMMAND_WORKFLOW: { createBatch: async (items: any[]) => { commands.push(...items); return []; }, get: async () => ({ status: async () => ({ status: "running" }) }) },
      IMPORT_WORKFLOW: { createBatch: async (items: any[]) => { business.push(...items); return []; }, get: async () => ({ status: async () => ({ status: "running" }) }) },
    } as unknown as Env;
    const db = local.DB, context = JSON.stringify(await captureOperationContext(local, owner));
    await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json) VALUES(?,?,'line','completed_with_failures','2026-09-01T09:00:00.000Z',?)").bind(runId, album, context).run();
    await db.prepare("INSERT INTO product_groups(id,import_run_id,ordinal,group_hash,state,product_id,first_photo_id,last_photo_id,created_at,updated_at) VALUES(?,?,0,?,'failed','A-501','marker','d','now','now')").bind(groupId, runId, groupHash).run();
    for (const [i, photo] of photos.entries()) {
      await db.prepare("INSERT INTO product_group_image_members VALUES(?,?,?,?)").bind(groupId, i, photo, photo).run();
      await db.prepare("INSERT INTO photo_assets(id,source_album_id,apple_photo_id,content_hash,r2_key,position,is_marker,import_run_id,created_at) VALUES(?,?,?,?,?,?,?,?,'now')").bind(crypto.randomUUID(), album, photo, hash, photo, i, i === 0 ? 1 : 0, runId).run();
    }
    await db.prepare("INSERT INTO audit_events VALUES(?,?,'system:import','product_id_allocated',NULL,'A-501','now')").bind(crypto.randomUUID(), runId).run();
    await db.prepare("INSERT INTO airtable_create_claims VALUES(?,'A-501','appTest','tblProducts')").bind(groupId).run();
    const probe = crypto.randomUUID();
    await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json) VALUES(?,?,'line','completed','2026-09-01T09:00:00.000Z',?)").bind(probe, album, context).run();
    const input = { runId, groupId, ownerGroupId: owner, baseId: "appTest", tableId: "tblProducts", recordId: "rec", actor: "operator", reason: "verified", apply: true };
    const inspect = (group = owner, base = "appTest") => inspectImportGroup(db, runId, group, groupId, base, "tblProducts");
    const resolve = (tokenValue: string) => routeRequest(new Request("https://worker/admin/import-owner-resolution", { method: "POST", headers: { authorization: `Bearer ${tokenValue}` }, body: JSON.stringify(input) }), local, {} as ExecutionContext);
    vi.spyOn(icloud, "createICloudClient").mockReturnValue(harness.source);
    vi.spyOn(marker, "createMarkerDetector").mockReturnValue(fakeMarkerDetector);
    vi.spyOn(products, "createAirtableProductsClient").mockReturnValue(harness.deps.airtable);
    const create = vi.spyOn(harness.deps.airtable, "createProduct");
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(init?.method ?? "GET").toMatch(/^(GET|POST)$/);
      if (String(url).startsWith("https://api.airtable.com/")) { expect(init?.method ?? "GET").toBe("GET"); return Response.json({ fields: { "Product ID": "A-501", "System Group ID": groupHash, "Product Images": photos.slice(1).map(photo => ({ id: photo, filename: "x.jpg", url: "https://v5.airtableusercontent.com/private" })) } }); }
      if (String(url).startsWith("https://v5.airtableusercontent.com/")) { expect(init?.method ?? "GET").toBe("GET"); return new Response(bytes, { headers: { "content-type": "image/jpeg" } }); }
      if (String(url).includes("/member/")) return Response.json({ userId: "U1", displayName: "Tester" });
      if (!String(url).endsWith("/message/reply")) throw new Error(`unexpected fetch ${url}`);
      replies.push(JSON.parse(String(init?.body))); return Response.json({});
    });
    const step = retryingStep() as unknown as WorkflowStep;
    const admit = async (eventId: string, text: string) => {
      const body = JSON.stringify({ events: [{ type: "message", webhookEventId: eventId, replyToken: `reply-${eventId}`, source: { type: "group", groupId: owner, userId: "U1" }, message: { type: "text", id: `m-${eventId}`, text } }] });
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
      expect((await handleLineRoute(new Request("https://app/line/webhook", { method: "POST", headers: { "x-line-signature": signature }, body }), local, {} as ExecutionContext)).status).toBe(200);
      return LineCommandWorkflow.prototype.run.call({ env: local } as unknown as LineCommandWorkflow, { payload: commands.at(-1).params, instanceId: commands.at(-1).id } as any, step);
    };
    try {
      expect(await inspect("foreign")).toBeNull(); expect(await inspect(owner, "foreign")).toBeNull();
      expect(await inspect()).toMatchObject({ runId, group: { id: groupId, state: "failed", productId: "A-501" }, createClaim: { base_id: "appTest", table_id: "tblProducts" } });
      expect((await harness.deps.repo.listHistoricalHolds(probe)).some(hold => hold.groupId === groupId)).toBe(true);
      expect((await resolve("wrong")).status).toBe(401); expect(provider).not.toHaveBeenCalled();
      expect((await resolve("test-admin-route-token")).status).toBe(200);
      expect((await resolve("test-admin-route-token")).status).toBe(409);
      expect(await inspect()).toMatchObject({ group: { state: "succeeded", airtableRecordId: "rec" } });
      expect((await harness.deps.repo.listHistoricalHolds(probe)).some(hold => hold.groupId === groupId)).toBe(false);
      expect(await db.prepare("SELECT actor, reason FROM import_owner_group_resolutions WHERE group_id=?").bind(groupId).first()).toEqual({ actor: "operator", reason: "verified" });
      const event = crypto.randomUUID(); await admit(event, "/upload");
      expect(business).toHaveLength(1);
      const result = await ImportWorkflow.prototype.run.call({ env: local } as unknown as ImportWorkflow, { payload: business[0].params, instanceId: business[0].id } as any, step) as ImportRunResult;
      expect(result.failedGroups).toEqual([]); expect(result.succeededProductIds).toEqual([]);
      expect(create).not.toHaveBeenCalled();
      expect(await db.prepare("SELECT state FROM line_result_outbox WHERE group_id=?").bind(owner).first()).toEqual({ state: "pending" });
      await ImportWorkflow.prototype.run.call({ env: local } as unknown as ImportWorkflow, { payload: business[0].params, instanceId: business[0].id } as any, step);
      expect(create).not.toHaveBeenCalled();
      const fresh = crypto.randomUUID(); await admit(fresh, "hello");
      expect(JSON.stringify(replies.at(-1).messages)).not.toContain(groupId);
      expect(replies.at(-1).replyToken).toBe(`reply-${fresh}`);
      expect(await db.prepare("SELECT state FROM line_result_outbox WHERE group_id=?").bind(owner).first()).toEqual({ state: "accepted" });
      const count = replies.length; await admit(fresh, "hello"); expect(replies).toHaveLength(count); expect(business).toHaveLength(1); expect(create).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });

  it("delivers the generated import once after lost creation and start responses", async () => {
    const id = crypto.randomUUID(), group = `Cimport-${id}`, other = `Cother-${id}`, token = `token-${id}`;
    const album = await deriveSourceAlbumId(token);
    const harness = await buildHarness(album, productGroupOf(9, 1), { idPrefix: id });
    const commands: any[] = [], business: any[] = [], replies: any[] = [];
    let created = false;
    const config = JSON.parse(createTestEnv().APP_CONFIG_JSON);
    config.LINE_ALLOWED_GROUP_ID = group;
    const local = { ...testEnv(), ...createTestEnv(), ICLOUD_SHARED_ALBUM_TOKEN: token, LINE_CHANNEL_SECRET: "secret", APP_CONFIG_JSON: JSON.stringify(config),
      LINE_COMMAND_WORKFLOW: { createBatch: async (items: any[]) => { commands.push(...items); return []; }, get: async () => ({ status: async () => ({ status: "running" }) }) },
      IMPORT_WORKFLOW: { createBatch: async (items: any[]) => { business.push(...items); created = true; throw new Error("creation response lost"); }, get: async () => { if (!created) throw new Error("instance.not_found"); return { status: async () => ({ status: "running" }) }; } },
    } as unknown as Env;
    const step = retryingStep() as unknown as WorkflowStep;
    vi.spyOn(icloud, "createICloudClient").mockReturnValue(harness.source);
    vi.spyOn(marker, "createMarkerDetector").mockReturnValue(fakeMarkerDetector);
    vi.spyOn(products, "createAirtableProductsClient").mockReturnValue(harness.deps.airtable);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("/member/")) return Response.json({ userId: "U1", displayName: "Tester" });
      if (!String(url).endsWith("/message/reply")) throw new Error(`unexpected fetch ${url}`);
      replies.push(JSON.parse(String(init?.body)));
      if (replies.length === 1) throw new Error("start response lost");
      return Response.json({});
    });
    const admit = async (eventId: string, text: string, groupId = group) => {
      const body = JSON.stringify({ events: [{ type: "message", webhookEventId: eventId, replyToken: `reply-${eventId}`, source: { type: "group", groupId, userId: "U1" }, message: { type: "text", id: `m-${eventId}`, text } }] });
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
      expect((await handleLineRoute(new Request("https://app/line/webhook", { method: "POST", headers: { "x-line-signature": signature }, body }), local, {} as ExecutionContext)).status).toBe(200);
    };
    const runCommand = (item: any) => LineCommandWorkflow.prototype.run.call({ env: local } as unknown as LineCommandWorkflow, { payload: item.params, instanceId: item.id } as any, step);
    try {
      await admit(id, "/upload");
      expect(await runCommand(commands[0])).toEqual({ status: "uncertain" });
      await admit(id, "/upload");
      expect(await runCommand(commands[1])).toEqual({ status: "duplicate" });
      expect(business).toHaveLength(1);
      expect(business[0].params).toMatchObject({ sourceAlbumId: album, trigger: "line", trustedEventId: id, replyGroupId: group });
      const result = await ImportWorkflow.prototype.run.call({ env: local } as unknown as ImportWorkflow, { payload: business[0].params, instanceId: business[0].id } as any, step);
      expect(result).toMatchObject({ succeededProductIds: ["A-501"], failedGroups: [] });
      expect(harness.created.size).toBe(1);
      expect(await local.DB.prepare("SELECT status FROM import_runs WHERE id=?").bind(business[0].params.importRunId).first()).toEqual({ status: "completed" });
      expect(await local.DB.prepare("SELECT COUNT(*) AS count FROM line_result_outbox WHERE group_id=?").bind(group).first()).toEqual({ count: 1 });
      await admit(id, "/upload"); expect(await runCommand(commands[2])).toEqual({ status: "duplicate" });
      expect(replies).toHaveLength(1);
      config.LINE_ALLOWED_GROUP_ID = other; local.APP_CONFIG_JSON = JSON.stringify(config);
      await admit(crypto.randomUUID(), "hello", other); await runCommand(commands[3]);
      expect(replies).toHaveLength(1);
      config.LINE_ALLOWED_GROUP_ID = group; local.APP_CONFIG_JSON = JSON.stringify(config);
      const fresh = crypto.randomUUID();
      await admit(fresh, "hello"); expect(await runCommand(commands[4])).toEqual({ status: "accepted" });
      expect(replies).toHaveLength(2);
      expect(replies[1].replyToken).toBe(`reply-${fresh}`);
      expect(JSON.stringify(replies[1].messages)).toContain("A-501");
      await admit(fresh, "hello"); await runCommand(commands[5]);
      expect(replies).toHaveLength(2); expect(business).toHaveLength(1); expect(harness.created.size).toBe(1);
    } finally { vi.restoreAllMocks(); }
  });


  it.each(["none", "recording", "legacy", "finalization", "uncached-finalization", "transaction", "legacy-terminal"])("delivers a mixed upload summary with interruption: %s", async (mode) => {
    const interrupt = mode !== "none" && mode !== "legacy-terminal";
    const id = crypto.randomUUID(), group = `Cimport-${id}`, other = `Cother-${id}`, token = `token-${id}`;
    const album = await deriveSourceAlbumId(token);
    const harness = await buildHarness(album, [...productGroupOf(9, 1), { id: "ignored", markerKind: "ignore_start" }, { id: "ignored-photo" }, ...productGroupOf(9, 2), ...productGroupOf(3, 3)], { idPrefix: id, createProduct: async payload => { if (payload.productId === "A-502") throw new OperationalError("airtable_response_lost", "lost", true); return { recordId: `rec-${payload.productId}` }; } });
    const createProduct = vi.spyOn(harness.deps.airtable, "createProduct");
    const commands: any[] = [], business: any[] = [], replies: any[] = [];
    let created = false;
    const config = JSON.parse(createTestEnv().APP_CONFIG_JSON);
    config.LINE_ALLOWED_GROUP_ID = group;
    const local = { ...testEnv(), ...createTestEnv(), ICLOUD_SHARED_ALBUM_TOKEN: token, LINE_CHANNEL_SECRET: "secret", APP_CONFIG_JSON: JSON.stringify(config),
      LINE_COMMAND_WORKFLOW: { createBatch: async (items: any[]) => { commands.push(...items); return []; }, get: async () => ({ status: async () => ({ status: "running" }) }) },
      IMPORT_WORKFLOW: { createBatch: async (items: any[]) => { business.push(...items); created = true; throw new Error("creation response lost"); }, get: async () => { if (!created) throw new Error("instance.not_found"); return { status: async () => ({ status: "running" }) }; } },
    } as unknown as Env;
    const r2Put = vi.spyOn(local.IMAGES_BUCKET, "put");
    const underlyingStep = retryingStep();
    const completed = new Map<string, unknown>();
    const failed = new Map<string, unknown>();
    let interrupted = false;
    const step = { async do(name: string, options: any, callback?: any) {
      if (completed.has(name)) return completed.get(name);
      if (failed.has(name)) throw failed.get(name);
      if (interrupt && mode !== "transaction" && !interrupted && (mode.includes("finalization") ? name === "finalize-checkpoint" : name.startsWith("record-failed-group-"))) { interrupted = true; throw new Error("recording interrupted"); }
      try {
        const result = await underlyingStep.do(name, options, callback);
        completed.set(name, result);
        return result;
      } catch (error) { if (name.startsWith("process-group-")) failed.set(name, error); throw error; }
    } } as unknown as WorkflowStep;
    vi.spyOn(icloud, "createICloudClient").mockReturnValue(harness.source);
    vi.spyOn(marker, "createMarkerDetector").mockReturnValue(fakeMarkerDetector);
    vi.spyOn(products, "createAirtableProductsClient").mockReturnValue(harness.deps.airtable);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("/member/")) return Response.json({ userId: "U1", displayName: "Tester" });
      if (!String(url).endsWith("/message/reply")) throw new Error(`unexpected fetch ${url}`);
      replies.push(JSON.parse(String(init?.body)));
      if (replies.length === 1) throw new Error("start response lost");
      return Response.json({});
    });
    const admit = async (eventId: string, text: string, groupId = group) => {
      const body = JSON.stringify({ events: [{ type: "message", webhookEventId: eventId, replyToken: `reply-${eventId}`, source: { type: "group", groupId, userId: "U1" }, message: { type: "text", id: `m-${eventId}`, text } }] });
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
      expect((await handleLineRoute(new Request("https://app/line/webhook", { method: "POST", headers: { "x-line-signature": signature }, body }), local, {} as ExecutionContext)).status).toBe(200);
    };
    const runCommand = (item: any) => LineCommandWorkflow.prototype.run.call({ env: local } as unknown as LineCommandWorkflow, { payload: item.params, instanceId: item.id } as any, underlyingStep as unknown as WorkflowStep);
    try {
      await admit(id, "/upload");
      expect(await runCommand(commands[0])).toEqual({ status: "uncertain" });
      await admit(id, "/upload");
      expect(await runCommand(commands[1])).toEqual({ status: "duplicate" });
      expect(business).toHaveLength(1);
      expect(business[0].params).toMatchObject({ sourceAlbumId: album, trigger: "line", trustedEventId: id, replyGroupId: group });
      const runImport = () => ImportWorkflow.prototype.run.call({ env: local } as unknown as ImportWorkflow, { payload: business[0].params, instanceId: business[0].id } as any, step);
      if (interrupt) {
        if (mode === "transaction") await local.DB.exec("CREATE TRIGGER test_checkpoint_failure BEFORE INSERT ON import_checkpoints BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END");
        await expect(runImport()).rejects.toThrow(mode === "transaction" ? "checkpoint failure" : "recording interrupted");
        if (mode === "transaction") await local.DB.exec("DROP TRIGGER test_checkpoint_failure");
        expect(await local.DB.prepare("SELECT COUNT(*) AS count FROM line_result_outbox WHERE group_id=?").bind(group).first()).toEqual({ count: 1 });
        if (mode.includes("finalization") || mode === "transaction") {
          expect(await local.DB.prepare("SELECT last_position FROM import_checkpoints WHERE source_album_id=?").bind(album).first()).toBeNull();
          expect(await local.DB.prepare("SELECT status FROM import_runs WHERE id=?").bind(business[0].params.importRunId).first()).toEqual({ status: "running" });
          expect(await groupStates(business[0].params.importRunId)).toHaveLength(3);
        }
        if (mode === "uncached-finalization" || mode === "transaction") { completed.clear(); failed.clear(); }
        if (mode === "legacy") {
          const runId = business[0].params.importRunId;
          await local.DB.prepare("UPDATE line_result_outbox SET result_key=? WHERE group_id=?").bind(JSON.stringify(["import", runId, 1, 1, "terminal"]), group).run();
          completed.delete("persist-import-failure");
          interrupted = false;
          await expect(runImport()).rejects.toThrow("recording interrupted");
          expect(await local.DB.prepare("SELECT COUNT(*) AS count FROM line_result_outbox WHERE group_id=?").bind(group).first()).toEqual({ count: 1 });
        }
      }
      const putsBeforeReplay = r2Put.mock.calls.length;
      const result = await runImport() as ImportRunResult;
      if (mode === "uncached-finalization" || mode === "transaction") {
        expect(r2Put).toHaveBeenCalledTimes(putsBeforeReplay);
        completed.clear(); failed.clear();
      }
      await runImport();
      expect(result).toMatchObject({ succeededProductIds: ["A-501"], ignoredGroupCount: 1, failedGroups: [
        { productId: "A-502", errorCode: "airtable_create_unconfirmed" },
        { productId: null, errorCode: "insufficient_product_photos" },
      ] });
      const ref = result.failedGroups[1]!.groupId;
      expect(await groupStates(business[0].params.importRunId)).toEqual([
        { product_id: "A-501", state: "succeeded", attempt_count: 1, failure_reason: null },
        { product_id: "A-502", state: "failed", attempt_count: 2, failure_reason: "airtable_create_unconfirmed" },
        { product_id: null, state: "failed", attempt_count: 0, failure_reason: "insufficient_product_photos" },
      ]);
      expect(harness.created.size).toBe(1);
      const checkpoint = await local.DB.prepare("SELECT last_position FROM import_checkpoints WHERE source_album_id=?").bind(album).first<{last_position:number}>();
      expect(checkpoint?.last_position).toBeGreaterThanOrEqual(0);
      const unresolved = await local.DB.prepare("SELECT group_hash FROM product_groups WHERE id=?").bind(result.failedGroups[0]!.groupId).first<{group_hash:string}>();
      expect(await harness.deps.repo.findGroupByHash(unresolved!.group_hash)).toMatchObject({ state: "failed", productId: "A-502" });
      expect(createProduct).toHaveBeenCalledTimes(2);
      expect((await auditActions(business[0].params.importRunId)).filter(action => action === "product_id_allocated")).toHaveLength(2);
      expect(await local.DB.prepare("SELECT status FROM import_runs WHERE id=?").bind(business[0].params.importRunId).first()).toEqual({ status: "completed_with_failures" });
      expect(await local.DB.prepare("SELECT COUNT(*) AS count FROM line_result_outbox WHERE group_id=?").bind(group).first()).toEqual({ count: interrupt ? 2 : 1 });
      await admit(id, "/upload"); expect(await runCommand(commands[2])).toEqual({ status: "duplicate" });
      expect(replies).toHaveLength(1);
      config.LINE_ALLOWED_GROUP_ID = other; local.APP_CONFIG_JSON = JSON.stringify(config);
      await admit(crypto.randomUUID(), "hello", other); await runCommand(commands[3]);
      expect(replies).toHaveLength(1);
      config.LINE_ALLOWED_GROUP_ID = group; local.APP_CONFIG_JSON = JSON.stringify(config);
      const fresh = crypto.randomUUID();
      await admit(fresh, "hello"); expect(await runCommand(commands[4])).toEqual({ status: "accepted" });
      expect(replies).toHaveLength(2);
      expect(replies[1].replyToken).toBe(`reply-${fresh}`);
      if (interrupt) {
        expect(JSON.stringify(replies[1].messages)).toContain("ยังยืนยันผลการนำเข้าสินค้าไม่ได้");
        await admit(crypto.randomUUID(), "hello"); await runCommand(commands[5]);
      }
      const summary = JSON.stringify(replies.at(-1).messages);
      expect(summary).toContain("A-501");
      expect(summary).toContain("A-502");
      expect(summary).toContain(`อ้างอิง ${ref}`);
      expect(summary).toContain("ข้ามสินค้าซ้ำ 1 รายการ");
      expect(summary).toContain("สำเร็จ 1 รายการ");
      expect(summary).toContain("ล้มเหลว 2 รายการ");
      expect(summary).toContain("กรุณาให้เจ้าของตรวจสอบ");
      expect(summary).toContain("รายการที่แก้ไขแล้ว");
      if (mode === "legacy-terminal") {
        const runId = business[0].params.importRunId;
        await local.DB.prepare("INSERT INTO line_result_outbox(result_key,group_id,result_json,created_at) SELECT ?,group_id,result_json,created_at FROM line_result_outbox WHERE group_id=?").bind(`later-${id}`, group).run();
        const before = await local.DB.prepare("SELECT * FROM line_result_outbox WHERE group_id=? ORDER BY sequence").bind(group).all();
        const receipt = await local.DB.prepare("SELECT * FROM line_reply_dispatches WHERE event_id=?").bind(fresh).first();
        // The old workflow rendered at execution time, which could differ from the run start.
        await local.DB.prepare("UPDATE import_runs SET started_at='2020-01-01T00:00:00.000Z' WHERE id=?").bind(runId).run();
        completed.clear(); failed.clear();
        await runImport();
        expect((await local.DB.prepare("SELECT * FROM line_result_outbox WHERE group_id=? ORDER BY sequence").bind(group).all()).results).toEqual(before.results);
        expect(await local.DB.prepare("SELECT * FROM line_reply_dispatches WHERE event_id=?").bind(fresh).first()).toEqual(receipt);
        await admit(crypto.randomUUID(), "hello"); await runCommand(commands.at(-1));
        expect(replies).toHaveLength(3);
        expect((await local.DB.prepare("SELECT state FROM line_result_outbox WHERE group_id=? ORDER BY sequence").bind(group).all()).results).toEqual([{state: "accepted"}, {state: "accepted"}]);
      }
      await admit(fresh, "hello"); await runCommand(commands.at(-1));
      expect(replies).toHaveLength(interrupt || mode === "legacy-terminal" ? 3 : 2); expect(business).toHaveLength(1); expect(harness.created.size).toBe(1);
    } finally { vi.restoreAllMocks(); }
  });

  it("holds a lost create response when replay cannot find the row", async () => {
    const create = vi.fn(async () => { throw new OperationalError("airtable_response_lost", "response lost", true); });
    const harness = await buildHarness(`album-${crypto.randomUUID()}`, productGroupOf(9, 1), { idPrefix: "lost-id", createProduct: create });
    const result = await harness.startAndRun("lost-run", "cron");
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.failedGroups).toEqual([expect.objectContaining({ productId: "A-501", errorCode: "airtable_create_unconfirmed" })]);
    expect(await groupStates("lost-run")).toEqual([expect.objectContaining({ product_id: "A-501", state: "failed" })]);
    expect(JSON.stringify(harness.push.mock.calls)).toContain("กรุณาให้เจ้าของตรวจสอบ");
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
    expect(harness.source.downloads).toEqual([
      "g2-marker",
      "g2-photo-0",
      "g2-photo-1",
      "g2-photo-2",
      "g2-photo-3",
      "g2-photo-4",
      "g2-photo-5",
      "g2-photo-6",
      "g2-photo-7",
      "g2-photo-8",
    ]);
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

  it("verifies an ignored run before admitting a fresh LINE upload", async () => {
    const env = { ...testEnv(), ...createTestEnv() };
    const album = await deriveSourceAlbumId(env.ICLOUD_SHARED_ALBUM_TOKEN);
    const old = [{ id: "old-ignore", markerKind: "ignore_start" as const }, { id: "old-photo" }];
    const harness = await buildHarness(album, old, { idPrefix: "verified-ignore" });
    const db = env.DB, runId = crypto.randomUUID(), owner = "CtestGroup";
    const context = await captureOperationContext(env, owner);
    const contextJson = JSON.stringify(context);
    const scan = old.map((photo, i) => ({ applePhotoId: photo.id, position: i + 1, captureAt: null, mediaType: "image/jpeg" }));
    const facts = { version: 1, savedCheckpoint: null, firstImportCutoffDate: null, ignoredGroupCount: 1, orphanRange: null, checkpointPosition: 2 };
    await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json,scan_evidence_json,grouping_evidence_json) VALUES(?,?,'line','running','now',?,?,?)").bind(runId, album, contextJson, JSON.stringify(scan), JSON.stringify(facts)).run();
    for (const [i, photo] of old.entries()) await db.prepare("INSERT INTO photo_assets(id,source_album_id,apple_photo_id,content_hash,position,is_marker,marker_kind,import_run_id,created_at) VALUES(?,?,?,?,?,0,?,?,'now')").bind(crypto.randomUUID(), album, photo.id, crypto.randomUUID(), i + 1, i === 0 ? 'ignore_start' : 'none', runId).run();
    expect(await claimImportVerification(db, { runId, albumId: album, workflowId: importWorkflowId(runId), groupId: owner, contextJson })).toBe(true);
    let captured: ImportWorkflowParams | undefined;
    env.IMPORT_WORKFLOW = { get: async () => ({ status: async () => ({ status: "errored" }) }), createBatch: async (batch: Array<{ params: ImportWorkflowParams }>) => { captured = batch[0]?.params; return []; } } as never;
    const verify = () => ImportWorkflow.prototype.run.call({ env } as never, { instanceId: `import-verification-${runId}`, payload: { kind: "verification", importRunId: runId } } as never, retryingStep() as never);
    await verify();
    await verify();
    const verified = await db.prepare("SELECT group_id,result_json FROM line_result_outbox WHERE group_id=?").bind(owner).all<{ group_id: string; result_json: string }>();
    expect(verified.results).toHaveLength(1);
    expect(JSON.parse(verified.results[0]!.result_json).messages[0].text).toContain("ข้ามสินค้าซ้ำ 1");
    harness.source.setSpecs([...productGroupOf(9, 1), ...old]);
    const response = await handleUploadTrigger(env, "line", "fresh-upload", context, "fresh-event");
    expect(response.status).toBe(202);
    expect(captured).toMatchObject({ importRunId: "fresh-upload", sourceAlbumId: album, replyGroupId: owner, trustedEventId: "fresh-event" });
    const result = await harness.runPayload(captured!);
    expect(result.succeededProductIds).toEqual(["A-501"]);
    expect(result.ignoredGroupCount).toBe(1);
    expect(result.failedGroups).toEqual([]);
    expect([...harness.created.values()].map(row => row.productId)).toEqual(["A-501"]);
    const group = await db.prepare("SELECT import_run_id,first_photo_id,last_photo_id FROM product_groups WHERE product_id=?").bind("A-501").first();
    expect(group).toEqual({ import_run_id: "fresh-upload", first_photo_id: "g1-marker", last_photo_id: "g1-photo-8" });
    await harness.runPayload(captured!);
    expect(harness.created.size).toBe(1);
    expect((await db.prepare("SELECT group_id FROM line_result_outbox WHERE group_id=?").bind(owner).all()).results).toHaveLength(1);
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

  it("holds an inserted photo that changes a confirmed group's membership", async () => {
    const original = productGroupOf(9, 1);
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const harness = await buildHarness(sourceAlbumId, original, { idPrefix: "membership-insert" });
    await harness.deps.repo.createImportRun({ id: "membership-original", sourceAlbumId, trigger: "cron" });
    await downloadAndGroupSnapshot(harness.deps, "membership-original");
    harness.source.setSpecs([...original.slice(0, 2), { id: "inserted-photo" }, ...original.slice(2), ...productGroupOf(9, 2)]);

    await harness.resumeRun("membership-original", "cron");
    expect(harness.created.size).toBe(1);
    const result = await harness.startAndRun("membership-new", "line");
    expect(result.succeededProductIds).toEqual(["A-502"]);
    expect(result.failedGroups).toEqual([{ groupId: expect.any(String), productId: null, errorCode: "confirmed_group_membership_changed" }]);
    expect(harness.created.size).toBe(2);
    expect(await harness.deps.repo.getCheckpoint(sourceAlbumId)).toBe(21);
    const summary = harness.push.mock.calls.at(-1)!;
    expect(summary[1]).toContain(`อ้างอิง ${result.failedGroups[0]!.groupId}`);
    expect(summary[1]).toContain("กรุณาให้เจ้าของตรวจสอบ");
    expect(JSON.stringify(summary[2])).toContain(result.failedGroups[0]!.groupId);
    expect(await groupStates("membership-new")).toEqual(expect.arrayContaining([
      expect.objectContaining({ product_id: null, state: "failed", failure_reason: "confirmed_group_membership_changed" }),
      expect.objectContaining({ product_id: "A-502", state: "succeeded" }),
    ]));
    const replay = await harness.resumeRun("membership-new", "line");
    expect(replay.failedGroups).toEqual(result.failedGroups);
    expect(harness.created.size).toBe(2);
    harness.source.setSpecs([...original, ...productGroupOf(9, 2), ...productGroupOf(9, 3)]);
    const resolved = await harness.startAndRun("membership-resolved", "line");
    expect(resolved.succeededProductIds).toEqual(["A-503"]);
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
      failedGroups: [{ groupId: "case-6-id-21", productId: "A-501", errorCode: "airtable_create_unconfirmed" }],
    });
    expect([...harness.created.values()].map((row) => row.productId)).toEqual(["A-502"]);
    expect(await groupStates("case-6-run-1")).toEqual([
      { product_id: "A-501", state: "failed", attempt_count: 2, failure_reason: "airtable_create_unconfirmed" },
      { product_id: "A-502", state: "succeeded", attempt_count: 1, failure_reason: null },
    ]);
    expect((await auditActions("case-6-run-1")).filter((action) => action === "product_group_attempt_failed")).toHaveLength(2);
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
        { groupId: "case-7-id-31", productId: "A-501", errorCode: "airtable_create_unconfirmed" },
        { groupId: "case-7-id-32", productId: "A-502", errorCode: "airtable_create_unconfirmed" },
        { groupId: "case-7-id-33", productId: "A-503", errorCode: "airtable_create_unconfirmed" },
      ],
    });
    expect(await groupStates("case-7-run-1")).toEqual([
      { product_id: "A-501", state: "failed", attempt_count: 2, failure_reason: "airtable_create_unconfirmed" },
      { product_id: "A-502", state: "failed", attempt_count: 2, failure_reason: "airtable_create_unconfirmed" },
      { product_id: "A-503", state: "failed", attempt_count: 2, failure_reason: "airtable_create_unconfirmed" },
    ]);
    expect((await auditActions("case-7-run-1")).filter((action) => action === "product_id_allocated")).toHaveLength(3);
  });

  it("8. later /upload holds the claimed group and imports its new sibling", async () => {
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
      failedGroups: [{ groupId: "case-8-id-11", productId: "A-501", errorCode: "airtable_create_unconfirmed" }],
    });
    expect(second).toEqual({ importRunId: "case-8-run-2", succeededProductIds: ["A-502"], failedGroups: [{ groupId: "case-8-id-11", productId: "A-501", errorCode: "airtable_create_unconfirmed" }] });
    expect([...harness.created.values()].map((row) => row.productId)).toEqual(["A-502"]);
    const rows = await testEnv().DB.prepare("SELECT product_id, state, attempt_count FROM product_groups WHERE import_run_id = ? ORDER BY ordinal").bind("case-8-run-2").all();
    expect(rows.results).toEqual([
      { product_id: "A-501", state: "failed", attempt_count: 1 },
      { product_id: "A-502", state: "succeeded", attempt_count: 1 },
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
      failedGroups: [{ groupId: "case-10-id-502", productId: "A-502", errorCode: "airtable_create_unconfirmed" }],
    });
    expect(harness.push).toHaveBeenCalledTimes(1);
    const expectedSummary = "นำเข้ารูปภาพ — 2026-09-01 16:00 ICT\nสำเร็จ 44 รายการ\nA-501, A-503, A-504, A-505, A-506, A-507, A-508, A-509, A-510, A-511, A-512, A-513, A-514, A-515, A-516, A-517, A-518, A-519, A-520, A-521, A-522, A-523, A-524, A-525, A-526, A-527, A-528, A-529, A-530, A-531, A-532, A-533, A-534, A-535, A-536, A-537, A-538, A-539, A-540, A-541, A-542, A-543, A-544, A-545\nล้มเหลว 1 รายการ\n- A-502: ไม่สามารถยืนยันการสร้างสินค้าใน Airtable กรุณาให้เจ้าของตรวจสอบ";
    expect(harness.push).toHaveBeenCalledWith("CtestGroup", expectedSummary, expect.objectContaining({ type: "bubble" }));
    expect([...harness.created.values()].map((row) => row.productId)).toEqual(expectedSucceeded);
  });
});
