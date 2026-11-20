import { createWorkflowFeedbackRepository } from '../db/workflow-feedback';
import { createLineReplyRepository } from '../db/line-reply-repository';
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { resolveImportContext } from "../settings/runtime";
import { createAuditLog } from "../db/audit";
import { createImportRepository, readImportVerificationEvidence, readImportVerificationCandidates, completeImportVerification, completeEmptyImportVerification } from "../db/import-repository";
import { createSequenceRepository } from "../db/sequence-repository";
import type { Env } from "../env";
import { createICloudClient } from "../icloud/client";
import { isRetryable, OperationalError } from "../shared/errors";
import { newCorrelationId } from "../shared/ids";
import { bangkokDateTimeThai, todayBangkokDate } from "../shared/time";
import { createAirtableProductsClient } from "./airtable-products";
import { createAssetStore } from "./asset-store";
import { createMarkerDetector } from "./marker";
import { buildImportSummaryMessage, buildImportSummaryCard } from "./notify";
import {
  downloadAndGroupSnapshot,
  finalizeImportRun,
  processProductGroupAttempt,
  recordExhaustedGroupFailure,
  type DownloadAndGroupOutcome,
  type PersistedGroup,
  type ProcessGroupDeps,
} from "./service";
import type { ImportRunResult, ImportWorkflowParams, ImportWorkflowPayload } from "./types";

interface WorkflowStepLike {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(
    name: string,
    options: {
      retries: { limit: number; delay: "10 seconds" | "1 second"; backoff?: "exponential" };
    },
    callback: () => Promise<T>,
  ): Promise<T>;
}

interface ImportWorkflowOperations {
  notifyFailure?(outcome:'failed'|'unconfirmed'):Promise<void>;
  retryLimit: number;
  downloadAndGroup(): Promise<DownloadAndGroupOutcome>;
  recordRunFailure(errorCode: string): Promise<void>;
  processGroupAttempt(
    deps: ProcessGroupDeps,
    group: PersistedGroup,
    importRunId: string,
  ): Promise<{ outcome: "succeeded"; productId: string }>;
  recordExhaustedFailure(
    deps: ProcessGroupDeps,
    group: PersistedGroup,
    importRunId: string,
    error: unknown,
  ): Promise<{ productId: string | null; errorCode: string }>;
  finalize(
    hadFailures: boolean,
    orphanPhotoCount: number,
    checkpointPosition: number,
    result: ImportRunResult,
    orphanRange: DownloadAndGroupOutcome["orphanRange"],
  ): Promise<void>;
  notify(
    result: ImportRunResult,
    orphanRange: DownloadAndGroupOutcome["orphanRange"],
  ): Promise<void>;
}

function durableErrorCode(error: unknown, fallback: string): string {
  if (error instanceof OperationalError) return error.code;
  return error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.name)
    ? error.name
    : fallback;
}

export async function runImportWorkflow(
  deps: ProcessGroupDeps,
  payload: ImportWorkflowParams,
  step: WorkflowStepLike,
  operations: ImportWorkflowOperations,
): Promise<ImportRunResult> {
  const retries = {
    retries: {
      limit: operations.retryLimit,
      delay: "10 seconds" as const,
      backoff: "exponential" as const,
    },
  };
  let downloadOutcome: DownloadAndGroupOutcome;
  try {
    downloadOutcome = await step.do("download-and-group", retries, async () => {
      try {
        return await operations.downloadAndGroup();
      } catch (error) {
        const code = durableErrorCode(error, "non_retryable_download_error");
        if (!isRetryable(error)) {
          const message =
            error instanceof Error
              ? error.message
              : "Non-retryable download error";
          throw new NonRetryableError(message, code);
        }
        if (error instanceof Error) error.name = code;
        throw error;
      }
    });
  } catch (error) {
    const errorCode = durableErrorCode(error, "download_and_group_failed");
    let outcome:'failed'|'unconfirmed'='failed';
    let recordingFailure:unknown;
    try { await step.do('record-download-and-group-failure', retries, () => operations.recordRunFailure(errorCode)); }
    catch(failure) { outcome='unconfirmed'; recordingFailure=failure; }
    if(operations.notifyFailure)await step.do('persist-import-failure',{retries:{limit:2,delay:'1 second'}},()=>operations.notifyFailure!(outcome));
    throw recordingFailure ?? error;
  }
  const { pendingGroups, orphanRange, checkpointPosition } = downloadOutcome;
  const succeededProductIds: string[] = [];
  const failedGroups: ImportRunResult["failedGroups"] = [...(downloadOutcome.heldGroups ?? [])];

  let result: ImportRunResult;
  try {
  for (const group of pendingGroups) {
    try {
      const outcome = await step.do(
        `process-group-${group.groupRowId}`,
        retries,
        async () => {
          try {
            return await operations.processGroupAttempt(
              deps,
              group,
              payload.importRunId,
            );
          } catch (error) {
            if (!isRetryable(error)) {
              const code =
                error instanceof OperationalError
                  ? error.code
                  : "non_retryable_group_error";
              const message =
                error instanceof Error
                  ? error.message
                  : "Non-retryable group error";
              throw new NonRetryableError(message, code);
            }
            throw error;
          }
        },
      );
      succeededProductIds.push(outcome.productId);
    } catch (error) {
      const failure = await step.do(
        `record-failed-group-${group.groupRowId}`,
        retries,
        () =>
          operations.recordExhaustedFailure(
            deps,
            group,
            payload.importRunId,
            error,
          ),
      );
      failedGroups.push({
        groupId: group.groupRowId,
        productId: failure.productId,
        errorCode: failure.errorCode,
      });
    }
  }

  result = {
    importRunId: payload.importRunId,
    succeededProductIds,
    failedGroups,
    ...(downloadOutcome.ignoredGroupCount ? { ignoredGroupCount: downloadOutcome.ignoredGroupCount } : {}),
  };
  await step.do("finalize-checkpoint", retries, () =>
    operations.finalize(
      failedGroups.length > 0,
      orphanRange?.count ?? 0,
      checkpointPosition,
      result,
      orphanRange,
    ),
  );
  } catch(error) {
    if(operations.notifyFailure)await step.do('persist-import-failure',{retries:{limit:2,delay:'1 second'}},()=>operations.notifyFailure!('unconfirmed'));
    throw error;
  }
  await step.do("send-import-summary", {retries:{limit:2,delay:"1 second"}}, () =>
    operations.notify(result, orphanRange),
  );
  return result;
}

export class ImportWorkflow extends WorkflowEntrypoint<
  Env,
  ImportWorkflowPayload
> {
  async run(
    event: WorkflowEvent<ImportWorkflowPayload>,
    step: WorkflowStep,
  ): Promise<ImportRunResult | { kind: "verification"; evidence: (NonNullable<Awaited<ReturnType<typeof readImportVerificationEvidence>>> & { candidates: Awaited<ReturnType<typeof readImportVerificationCandidates>> }) | null }> {
    if ("kind" in event.payload) {
      const runId = event.payload.importRunId;
      const evidence = await step.do("read-import-verification-evidence", async () => {
        const claim = await this.env.DB.prepare("SELECT origin_workflow_id, group_id, source_album_id, context_json FROM import_verification_claims WHERE import_run_id=? AND verifier_id=? AND completed IS NULL")
          .bind(runId, event.instanceId).first<{origin_workflow_id: string; group_id: string; source_album_id: string; context_json: string}>();
        if (!claim) return null;
        const status = (await (await this.env.IMPORT_WORKFLOW.get(claim.origin_workflow_id)).status()).status;
        if (!['complete', 'errored', 'terminated'].includes(status)) throw new Error('import_origin_not_stopped');
        const result = await readImportVerificationEvidence(this.env.DB, runId, claim.origin_workflow_id, claim.group_id);
        if (!result || result.sourceAlbumId !== claim.source_album_id || result.contextJson !== claim.context_json) return null;
        const input = {runId, albumId:claim.source_album_id, workflowId:claim.origin_workflow_id, groupId:claim.group_id, contextJson:claim.context_json};
        if (await completeEmptyImportVerification(this.env.DB, input, event.instanceId,
          {schemaVersion:1, kind:'import', runId, generation:1, notificationCycle:1, outcome:'success', messages:[{type:'text', text:'ไม่มีรูปใหม่สำหรับนำเข้า สามารถส่ง /upload อีกครั้งเมื่อมีรูปใหม่'}]})) {
          return { ...result, candidates: [] };
        }
        const candidates = await readImportVerificationCandidates(this.env.DB, runId, event.instanceId);
        const config = JSON.parse(claim.context_json)?.settings?.config;
        const verified: string[] = [];
        if (typeof config?.airtableBaseId === 'string' && typeof config?.airtableProductsTableId === 'string') {
          const airtable = createAirtableProductsClient({baseId:config.airtableBaseId, tableId:config.airtableProductsTableId, token:this.env.AIRTABLE_TOKEN, fetch:fetch.bind(globalThis)});
          for (const candidate of candidates) {
            try {
              const date = new Date(candidate.createdAt);
              if (!Number.isFinite(date.getTime())) continue;
              if (await airtable.verifyProduct(candidate.recordId, {productId:candidate.productId, systemGroupId:candidate.groupHash, uploadDate:todayBangkokDate({now:()=>date}), imageCount:candidate.members.length})) verified.push(candidate.productId);
            } catch { /* A failed read cannot confirm the row. */ }
          }
        }
        await completeImportVerification(this.env.DB, {runId, albumId:claim.source_album_id, workflowId:claim.origin_workflow_id, groupId:claim.group_id, contextJson:claim.context_json}, event.instanceId,
          {schemaVersion:1, kind:'import', runId, generation:1, notificationCycle:1, outcome:'unconfirmed', messages:[{type:'text', text:`⚠️ ยังยืนยันผลการนำเข้าไม่ได้ กรุณาตรวจสอบงานเดิมก่อนส่ง /upload ซ้ำ\n${runId}${verified.length ? `\nตรวจพบ ${verified.length} แถวที่รหัสสินค้า รหัสกลุ่ม วันที่ และจำนวนภาพตรงกับข้อมูลเดิม (ยังไม่ได้ยืนยันตัวตนภาพ)` : ""}`}]});
        return { ...result, candidates };
      });
      return { kind: "verification", evidence };
    }
    const payload = event.payload;
    let context;
    try {
      context = await step.do(
        "settings-context",
        { retries: { limit: 0, delay: "1 second" } },
        () => resolveImportContext(this.env, payload),
      );
    } catch (error) {
      const { trigger, trustedEventId, replyGroupId, importRunId } = payload;
      if (trigger === 'line' && trustedEventId && replyGroupId) {
        try {
          await step.do('setup-failure-notice', async () => {
            const attempt = { kind: 'import' as const, runId: importRunId, generation: 1, notificationCycle: 1, groupId: replyGroupId };
            if (!await createWorkflowFeedbackRepository(this.env.DB).lookupTrustedEarlyFailure(attempt, trustedEventId)) return;
            await createLineReplyRepository(this.env.DB, { now: () => new Date() }).enqueueResult({
              groupId: replyGroupId,
              resultKey: JSON.stringify(['import', importRunId, 1, 1, 'terminal']),
              result: { schemaVersion: 1, kind: 'import', runId: importRunId, generation: 1, notificationCycle: 1, outcome: 'unconfirmed', messages: [{ type: 'text', text: `⚠️ ยังยืนยันผลการนำเข้าสินค้าไม่ได้ กรุณาตรวจสอบก่อนส่ง /upload ซ้ำ\n${importRunId}` }] },
            });
          });
        } catch { /* Preserve the setup failure. */ }
      }
      throw error;
    }
    const config = context.settings.config;
    const clock = { now: () => new Date() };
    const ids = { next: () => newCorrelationId() };
    const fetcher = fetch.bind(globalThis);
    const repo = createImportRepository(this.env.DB, ids, clock);
    const deps: ProcessGroupDeps = {
      imageSource: createICloudClient(
        this.env.ICLOUD_SHARED_ALBUM_TOKEN,
        fetcher,
      ),
      marker: createMarkerDetector(this.env.IMAGES),
      repo,
      assets: createAssetStore(
        this.env.IMAGES_BUCKET,
        {
          signingSecret: this.env.ASSET_URL_SIGNING_SECRET,
          publicBaseUrl: config.publicBaseUrl,
        },
        clock,
        this.env.DB,
      ),
      clock,
      ids,
      sourceAlbumId: payload.sourceAlbumId,
      firstImportCutoffDate: config.firstImportCutoffDate,
      sequences: createSequenceRepository(this.env.DB),
      audit: createAuditLog(this.env.DB, ids, clock),
      airtable: createAirtableProductsClient({
        baseId: config.airtableBaseId,
        tableId: config.airtableProductsTableId,
        token: this.env.AIRTABLE_TOKEN,
        fetch: fetcher,
      }),
      productIdPrefix: config.productIdPrefix,
      airtableBaseId: config.airtableBaseId,
      airtableTableId: config.airtableProductsTableId,
      assetUrlTtlSeconds: 300,
    };
    const outbox=createLineReplyRepository(this.env.DB,clock);
    const notificationDate=await step.do('terminal-display-date',()=>Promise.resolve(bangkokDateTimeThai(clock)));
    const enqueue=async(outcome:'success'|'partial'|'failed'|'unconfirmed',messages:import('../line/reply-types').LineReplyMessage[])=>{
      if(!context.replyGroupId)return;
      await outbox.enqueueResult({groupId:context.replyGroupId,resultKey:JSON.stringify(['import',payload.importRunId,1,1,'terminal']),result:{schemaVersion:1,kind:'import',runId:payload.importRunId,generation:1,notificationCycle:1,outcome,messages}});
    };
    const resultKey = JSON.stringify(['import',payload.importRunId,1,1,'terminal']);
    const summaryResult = (result: ImportRunResult, orphanRange: DownloadAndGroupOutcome['orphanRange']): import('../line/reply-types').TerminalResultV1 => {
      const input = { result, orphanRange, nowThaiText: notificationDate };
      return { schemaVersion: 1, kind: 'import', runId: payload.importRunId, generation: 1, notificationCycle: 1, outcome: result.failedGroups.length ? 'partial' : 'success', messages: [{ type: 'flex', altText: buildImportSummaryMessage(input).slice(0,1500).replace(/[\uD800-\uDBFF]$/, ''), contents: buildImportSummaryCard(input, config.publicBaseUrl) }] };
    };
    return runImportWorkflow(
      deps,
      payload,
      step as unknown as WorkflowStepLike,
      {
        retryLimit: config.importRetryLimit,
        downloadAndGroup: () =>
          downloadAndGroupSnapshot(deps, payload.importRunId),
        recordRunFailure: (failureReason) =>
          repo.failImportRun({
            id: payload.importRunId,
            sourceAlbumId: payload.sourceAlbumId,
            failureReason,
          }),
        processGroupAttempt: processProductGroupAttempt,
        recordExhaustedFailure: recordExhaustedGroupFailure,
        finalize: (hadFailures, orphanPhotoCount, checkpointPosition, result, orphanRange) =>
          finalizeImportRun(
            repo,
            payload.importRunId,
            payload.sourceAlbumId,
            hadFailures,
            orphanPhotoCount,
            checkpointPosition,
            context.replyGroupId ? { groupId: context.replyGroupId, result: summaryResult(result, orphanRange) } : undefined,
          ),
        notify: async (result, orphanRange) => {
          if (!context.replyGroupId) return;
          // Replays of the old finalization step still need to persist their summary.
          const existing = await this.env.DB.prepare('SELECT 1 FROM line_result_outbox WHERE result_key=?').bind(resultKey).first();
          if (!existing) await outbox.enqueueResult({ groupId: context.replyGroupId, resultKey, result: summaryResult(result, orphanRange) });
        },
        notifyFailure: async outcome => {
          const committed = await this.env.DB.prepare("SELECT 1 FROM import_runs WHERE id=? AND status IN ('completed','completed_with_failures')").bind(payload.importRunId).first();
          if (!committed) await enqueue(outcome,[{type:'text',text:`⚠️ ยังยืนยันผลการนำเข้าสินค้าไม่ได้ กรุณาตรวจสอบก่อนส่ง /upload ซ้ำ\n${payload.importRunId}`}]);
        },
      },
    );
  }
}
