import {
  preparePublicationImages,
  ProductImagePreparationFailure,
} from "./product-images";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { resolvePublicationContext } from "../settings/runtime";
import type { OperationContext } from "../settings/schema";
import type { Env } from "../env";
import { createAssetStore } from "../import/asset-store";
import { createLineReplyRepository } from '../db/line-reply-repository';
import { readPublicationJob, completePublicationVerification, readPreGoogleFailure } from '../db/publication-repository';
import { createWorkflowFeedbackRepository } from '../db/workflow-feedback';
import { docsUnconfirmedCard } from '../line/docs-summary-card';
import type { TerminalResultV1 } from '../line/reply-types';
import { OperationalError } from "../shared/errors";
import type { Clock } from "../shared/time";
import {
  ensureTemporaryDocument,
  failPublicationAfterExhaustion,
  fillAndVerifyDocument,
  finalizePublication,
  notifyPublicationSuccess,
  notifyPublicationValidationFailure,
  preparePublicationOutputs,
  recoverPublicationFinalization,
  validatePublication,
  type PublicationServiceDeps,
} from "./service";
import type { PublicationResult, PublicationWorkflowParams, PublicationBusinessParams } from "./types";
import { publicationWorkflowId } from "./types";

function depsFor(
  env: Env,
  clock: Clock,
  context: OperationContext,
  identity:{runId:string;generation:number;notificationCycle:number},
): PublicationServiceDeps {
  const config = context.settings.config;
  const fetcher = fetch.bind(globalThis);
  let anthropic: Anthropic | undefined;
  return {
    db: env.DB,
    assets: createAssetStore(
      env.IMAGES_BUCKET,
      {
        signingSecret: env.ASSET_URL_SIGNING_SECRET,
        publicBaseUrl: config.publicBaseUrl,
      },
      clock,
      env.DB,
    ),
    bucket: env.IMAGES_BUCKET,
    images: env.IMAGES,
    fetcher,
    get anthropic() {
      return (anthropic ??= new Anthropic({
        apiKey: env.ANTHROPIC_API_KEY,
        maxRetries: 0,
      }));
    },
    clock,
    config,
    airtableToken: env.AIRTABLE_TOKEN,
    imageExecutionStatus: async (id) => {
      try {
        const status = (await (await env.PUBLICATION_WORKFLOW.get(id)).status())
          .status;
        if (["complete", "errored", "terminated"].includes(status))
          return "terminal";
        if (
          [
            "queued",
            "running",
            "paused",
            "waiting",
            "waitingForPause",
          ].includes(status)
        )
          return "active";
        return "unknown";
      } catch {
        return "unknown";
      }
    },
    googleOAuthCredentials: {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
    },
    notify: async (text, contents, outcome='success') => {
      if(!context.replyGroupId)return;
      const result:TerminalResultV1={schemaVersion:1,kind:'publication',...identity,outcome,messages:[contents?{type:'flex',altText:text.slice(0,1500).replace(/[\uD800-\uDBFF]$/,''),contents}:{type:'text',text}]};
      await createLineReplyRepository(env.DB,clock).enqueueResult({groupId:context.replyGroupId,resultKey:JSON.stringify(['publication',identity.runId,identity.generation,identity.notificationCycle,'terminal']),result});
    },
  };
}

function publicationErrorCode(error:unknown,fallback:string):string {
  const code=error instanceof OperationalError ? error.code : error instanceof Error ? error.name : '';
  return /^[a-z][a-z0-9_]{0,99}$/.test(code)?code:fallback;
}

async function workflowCall<T>(
  reason: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof OperationalError && !error.retryable) {
      // The name survives durable error serialization; custom Error fields may not.
      throw new NonRetryableError(reason, error.code);
    }
    // Durable retries and their logs must not retain raw upstream bodies or secrets.
    const safe=new Error(reason);
    safe.name=publicationErrorCode(error,'publication_stage_failed');
    throw safe;
  }
}

function isContenderRejection(error: unknown): boolean {
  const code =
    error instanceof OperationalError
      ? error.code
      : error instanceof Error
        ? error.name
        : null;
  return (
    code === "publication_job_locked" ||
    code === "publication_job_terminal" ||
    code === "publication_generation_stale"
  );
}

export async function runPublicationWorkflow(
  params: PublicationBusinessParams,
  step: WorkflowStep,
  deps: PublicationServiceDeps,
  instanceId?: string,
  feedbackIdentity?: {groupId:string;notificationCycle:number},
): Promise<PublicationResult | null> {
  const retries = {
    retries: {
      limit: deps.config.publicationRetryLimit,
      delay: "10 seconds" as const,
      backoff: "exponential" as const,
    },
    timeout: "5 minutes" as const,
  };
  const runId = params.publicationRunId;
  const generation = params.generation ?? 1;
  const generationArgs: [number?] = generation === 1 ? [] : [generation];
  const persistenceOptions={retries:{limit:2,delay:'1 second' as const},timeout:'1 minute' as const};
  async function persistPreparedNotice(name:string,render:(renderDeps:PublicationServiceDeps)=>Promise<void>) {
    const json=await step.do(`prepare ${name}`,persistenceOptions,()=>workflowCall('Unable to prepare publication notification.',async()=>{
      let notice:{text:string;contents?:Record<string,unknown>;outcome?:TerminalResultV1['outcome']}|null=null;
      await render({...deps,notify:async(text,contents,outcome)=>{notice={text,...(contents?{contents}:{}),...(outcome?{outcome}:{})};}});
      return JSON.stringify(notice);
    }));
    const notice=JSON.parse(json) as {text:string;contents?:Record<string,unknown>;outcome?:TerminalResultV1['outcome']}|null;
    if(notice)await step.do(name,persistenceOptions,()=>deps.notify(notice.text,notice.contents,notice.outcome));
  }
  async function recordFailure(stage:string,reason:string,displayDate:string|null,originalError:unknown) {
    if (params.trigger === "line" && feedbackIdentity) {
      await step.do("persist primary publication failure",persistenceOptions,async()=>{
        const job=await readPublicationJob(deps.db,runId);
        if (!job || job.generation!==generation || job.notificationCycle!==feedbackIdentity.notificationCycle || job.correlationId!==instanceId)
          throw new NonRetryableError("Publication identity unavailable","publication_generation_stale");
        if (job.state === "succeeded") return;
        const attempt={kind:"publication" as const,runId,generation,...feedbackIdentity};
        const committed=await createWorkflowFeedbackRepository(deps.db).commitOutcome(attempt,{stage,failureCode:publicationErrorCode(originalError,"publication_stage_failed"),action:"verify",outcome:"unconfirmed",references:{thaiDate:displayDate??"ไม่สามารถอ่านวันที่รายการได้",airtableRunUrl:`https://airtable.com/${deps.config.airtableBaseId}/${deps.config.airtablePublicationRunsTableId}/${runId}`,publicBaseUrl:deps.config.publicBaseUrl},resultKey:JSON.stringify(["publication",runId,generation,feedbackIdentity.notificationCycle,"terminal"])});
        if (!committed) throw new NonRetryableError("Publication identity unavailable","publication_generation_stale");
      });
    }
    type Notice={text:string;contents?:Record<string,unknown>;outcome:TerminalResultV1['outcome']};
    let noticeJson:string;
    try {
      noticeJson=await step.do('record exhausted publication failure',retries,()=>workflowCall('Unable to record the publication failure.',async()=>{
        let intent:Notice|null=null;
        await failPublicationAfterExhaustion({...deps,notify:async(text,contents)=>{intent={text,...(contents?{contents}:{}),outcome:'failed'};}},runId,reason,displayDate,...generationArgs);
        return JSON.stringify(intent);
      }));
    } catch(recordingError) {
      if(isContenderRejection(recordingError))throw recordingError;
      console.error('publication_failure_recording_unconfirmed',{runId,generation,originalCode:publicationErrorCode(originalError,'publication_stage_failed'),recordingCode:publicationErrorCode(recordingError,'failure_recording_failed')});
      noticeJson=await step.do('prepare unconfirmed publication notice',persistenceOptions,async()=>{
        if (params.trigger === 'line' && feedbackIdentity) {
          const saved=await deps.db.prepare(`SELECT outcome_json FROM workflow_feedback_results WHERE kind='publication' AND run_id=? AND generation=? AND notification_cycle=? AND group_id=? AND result_key=?`)
            .bind(runId,generation,feedbackIdentity.notificationCycle,feedbackIdentity.groupId,JSON.stringify(['publication',runId,generation,feedbackIdentity.notificationCycle,'terminal'])).first<{outcome_json:string}>();
          if (saved) {
            const fact=JSON.parse(saved.outcome_json) as {stage:string;failureCode?:string};
            const stage = fact.stage === 'prepare outputs' && fact.failureCode?.startsWith('anthropic_') ? 'สร้างคำบรรยาย' : ({'validate publication':'ตรวจสอบข้อมูล','prepare product images':'เตรียมรูปภาพ','prepare outputs':'เตรียมรูปภาพและคำบรรยาย','ensure temporary document':'สร้างเอกสาร','fill and verify document':'เขียนและตรวจสอบเอกสาร','finalize publication':'จัดเตรียมเอกสารขั้นสุดท้าย','recover finalization':'ตรวจสอบเอกสาร'} as Record<string,string>)[fact.stage] ?? 'เตรียมเอกสาร';
            return JSON.stringify({text:`ขั้นตอน${stage}ไม่สำเร็จ\nสถานะการล้างข้อมูลหรือบันทึก Airtable ยังไม่แน่นอน\nกรุณาตรวจสอบงานเดิมใน Airtable ก่อนดำเนินการต่อ\nhttps://airtable.com/${deps.config.airtableBaseId}/${deps.config.airtablePublicationRunsTableId}/${runId}`,outcome:'unconfirmed'} satisfies Notice);
          }
        }
        const card=docsUnconfirmedCard({thaiDate:displayDate??'ไม่สามารถอ่านวันที่รายการได้',airtableRunUrl:`https://airtable.com/${deps.config.airtableBaseId}/${deps.config.airtablePublicationRunsTableId}/${runId}`},deps.config.publicBaseUrl);
        return JSON.stringify({text:card.text,contents:card.contents,outcome:'unconfirmed'} satisfies Notice);
      });
    }
    const notice=JSON.parse(noticeJson) as Notice|null;
    if(notice)await step.do('persist publication failure',persistenceOptions,()=>deps.notify(notice.text,notice.contents,notice.outcome));
  }
  let recovered: Awaited<ReturnType<typeof recoverPublicationFinalization>>;
  try {
    recovered = await step.do("recover finalization", retries, () =>
      workflowCall("Unable to finalize the publication.", () =>
        recoverPublicationFinalization(deps, runId, generation),
      ),
    );
  } catch (error) {
    if (isContenderRejection(error)) throw error;
    await recordFailure("recover finalization","Unable to finalize the publication.",null,error);
    throw error;
  }
  if (recovered) {
    await persistPreparedNotice('notify publication success',renderDeps=>notifyPublicationSuccess(renderDeps,recovered,recovered.result));
    return recovered.result;
  }
  let validation: Awaited<ReturnType<typeof validatePublication>>;
  try {
    validation = await step.do("validate publication", retries, () =>
      workflowCall("Unable to read or validate publication data.", () =>
        validatePublication(
          deps,
          runId,
          publicationWorkflowId(runId, generation),
          ...generationArgs,
        ),
      ),
    );
  } catch (error) {
    if (isContenderRejection(error)) throw error;
    await recordFailure("validate publication","Unable to read or validate publication data.",null,error);
    throw error;
  }
  if (validation.kind === "already_succeeded") return validation.result;
  if (validation.kind === "validation_failed") {
    await persistPreparedNotice('notify validation failure',renderDeps=>notifyPublicationValidationFailure(renderDeps,runId,validation.thaiDate,validation.validation));
    return null;
  }

  let prepared: Awaited<ReturnType<typeof preparePublicationOutputs>>;
  let result: PublicationResult;
  // Image errors use locally constructed safe reasons; other stages use fixed reasons.
  let failureReason = "Unable to prepare product images.";
  let failureStage = "prepare product images";
  try {
    let imagePrepared;
    try {
      imagePrepared = await preparePublicationImages(
        {
          ...deps,
          executionStatus: deps.imageExecutionStatus ?? (async () => "unknown"),
        },
        validation.value,
        instanceId ?? publicationWorkflowId(runId, generation),
        step,
      );
    } catch (error) {
      if (error instanceof ProductImagePreparationFailure)
        failureReason = error.message;
      throw error;
    }
    failureStage = "prepare outputs";
    failureReason = "Unable to prepare publication images and captions.";
    prepared = await step.do("prepare outputs", retries, () =>
      workflowCall(failureReason, () =>
        preparePublicationOutputs(deps, imagePrepared),
      ),
    );
    failureStage = "ensure temporary document";
    failureReason = "Unable to create the temporary Google document.";
    const tempDocId = await step.do("ensure temporary document", retries, () =>
      workflowCall(failureReason, () =>
        ensureTemporaryDocument({ ...deps, copyOwner: instanceId && feedbackIdentity ? { workflowId: instanceId, notificationCycle: feedbackIdentity.notificationCycle } : deps.copyOwner }, prepared),
      ),
    );
    failureStage = "fill and verify document";
    failureReason = "Unable to fill or verify the Google document.";
    await step.do("fill and verify document", retries, () =>
      workflowCall(failureReason, () =>
        fillAndVerifyDocument(deps, prepared, tempDocId),
      ),
    );
    failureStage = "finalize publication";
    failureReason = "Unable to finalize the publication.";
    result = await step.do("finalize publication", retries, () =>
      workflowCall(failureReason, () =>
        finalizePublication(deps, prepared, tempDocId),
      ),
    );
  } catch (error) {
    if (isContenderRejection(error)) throw error;
    await recordFailure(failureStage,failureReason,validation.value.thaiDate,error);
    throw error;
  }
  // Notification failure must not delete or downgrade a completed document.
  await persistPreparedNotice('notify publication success',renderDeps=>notifyPublicationSuccess(renderDeps,prepared,result));
  return result;
}

export class PublicationWorkflow extends WorkflowEntrypoint<
  Env,
  PublicationWorkflowParams
> {
  async run(
    event: WorkflowEvent<PublicationWorkflowParams>,
    step: WorkflowStep,
  ): Promise<PublicationResult | null> {
    if (event.payload.kind === "verification") {
      const payload = event.payload;
      await step.do("verify-publication", async () => {
        if (event.instanceId !== payload.verifierId) return;
        const claim = await this.env.DB.prepare(`SELECT origin_workflow_id, context_json FROM publication_verification_claims
          WHERE publication_run_id=? AND generation=? AND notification_cycle=? AND group_id=? AND verifier_id=? AND completed=0`)
          .bind(payload.publicationRunId, payload.generation, payload.notificationCycle, payload.groupId, payload.verifierId)
          .first<{origin_workflow_id:string; context_json:string}>();
        const job = await readPublicationJob(this.env.DB, payload.publicationRunId);
        if (!claim || !job || job.generation !== payload.generation || job.notificationCycle !== payload.notificationCycle || job.correlationId !== claim.origin_workflow_id) return;
        const status = (await (await this.env.PUBLICATION_WORKFLOW.get(claim.origin_workflow_id)).status()).status;
        if (!["complete", "errored", "terminated"].includes(status)) throw new Error("publication_origin_not_stopped");
        const attempt = {runId:payload.publicationRunId, generation:payload.generation, notificationCycle:payload.notificationCycle, groupId:payload.groupId};
        const preGoogleFailure = await readPreGoogleFailure(this.env.DB, attempt, payload.verifierId);
        let confirmedFailed = false;
        if (preGoogleFailure) {
          try {
            const context = JSON.parse(preGoogleFailure.context_json) as OperationContext;
            const config = context.settings.config;
            const url = `https://api.airtable.com/v0/${encodeURIComponent(config.airtableBaseId)}/${encodeURIComponent(config.airtablePublicationRunsTableId)}/${encodeURIComponent(attempt.runId)}`;
            const response = await fetch(url, {headers:{Authorization:`Bearer ${this.env.AIRTABLE_TOKEN}`}});
            if (!response.ok) throw new Error('airtable_read_failed');
            const record = z.object({id:z.string(), fields:z.object({Status:z.string(), 'Google Doc URL':z.string().optional(), 'Generated At':z.string().optional()})}).parse(await response.json());
            confirmedFailed = record.id === attempt.runId && record.fields.Status === 'Failed' && !record.fields['Google Doc URL'] && !record.fields['Generated At'] && !!await readPreGoogleFailure(this.env.DB, attempt, payload.verifierId);
          } catch { /* An unavailable or inconsistent record cannot confirm the outcome. */ }
        }
        await completePublicationVerification(this.env.DB, attempt, payload.verifierId, {
          originWorkflowId:claim.origin_workflow_id, contextJson:claim.context_json,
          result:{schemaVersion:1, kind:'publication', runId:attempt.runId, generation:attempt.generation, notificationCycle:attempt.notificationCycle, outcome:confirmedFailed ? 'failed' : 'unconfirmed', messages:[{type:'text', text:confirmedFailed ? `ตรวจสอบแล้ว สถานะงานใน Airtable เป็น Failed และไม่มีเอกสารที่บันทึกไว้\n${attempt.runId}` : preGoogleFailure ? `⚠️ กรุณาตรวจสอบสถานะงานเดิมใน Airtable ก่อนส่ง /docs ซ้ำ\n${attempt.runId}` : `⚠️ ยังยืนยันผลการสร้างเอกสารไม่ได้ กรุณาตรวจสอบก่อนส่ง /docs ซ้ำ\n${attempt.runId}`}]},
        });
      });
      return null;
    }
    const payload = event.payload;
    const generation = payload.generation ?? 1;
    if (
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      (generation > 1 &&
        event.instanceId !==
          publicationWorkflowId(event.payload.publicationRunId, generation))
    ) {
      throw new NonRetryableError(
        "Invalid publication generation owner",
        "publication_generation_stale",
      );
    }
    let context;
    try {
      context = await step.do(
        "settings-context",
        { retries: { limit: 0, delay: "1 second" } },
        () => resolvePublicationContext(this.env, payload),
      );
    } catch (error) {
      try {
        await step.do('setup-failure-notice', async () => {
          const runId = event.payload.publicationRunId;
          const job = await readPublicationJob(this.env.DB, runId);
          if (!job || job.generation !== generation || job.correlationId !== event.instanceId || event.instanceId !== publicationWorkflowId(runId, generation)) return;
          const bindings = await this.env.DB.prepare('SELECT event_id, group_id FROM publication_regeneration_events WHERE publication_run_id=? AND generation=? AND notification_cycle=? AND workflow_id=?')
            .bind(runId, generation, job.notificationCycle, event.instanceId).all<{event_id:string;group_id:string | null}>();
          if (bindings.results.length !== 1 || !bindings.results[0]?.group_id) return;
          const binding = bindings.results[0];
          const attempt = {kind:'publication' as const, runId, generation, notificationCycle:job.notificationCycle, groupId:binding.group_id!};
          if (!await createWorkflowFeedbackRepository(this.env.DB).lookupTrustedEarlyFailure(attempt, binding.event_id)) return;
          const result = {schemaVersion:1,kind:'publication',runId,generation,notificationCycle:job.notificationCycle,outcome:'unconfirmed',messages:[{type:'text',text:`⚠️ ยังยืนยันผลการสร้างเอกสารไม่ได้ กรุณาตรวจสอบก่อนส่ง /docs ซ้ำ\n${runId}`}]};
          await this.env.DB.prepare(`INSERT INTO line_result_outbox(result_key,group_id,result_json,created_at)
            SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM publication_jobs j JOIN publication_regeneration_events e ON e.publication_run_id=j.publication_run_id JOIN line_command_ingress i ON i.event_id=e.event_id
              WHERE j.publication_run_id=? AND j.generation=? AND j.notification_cycle=? AND j.correlation_id=?
              AND e.event_id=? AND e.generation=j.generation AND e.notification_cycle=j.notification_cycle AND e.workflow_id=j.correlation_id
              AND e.group_id=? AND i.group_id=e.group_id AND e.ingress_operation=i.operation AND json_extract(i.operation,'$.type')='docs'
              AND json_extract(j.settings_context_json,'$.replyGroupId')=i.group_id
              AND (SELECT count(*) FROM publication_regeneration_events WHERE publication_run_id=j.publication_run_id AND generation=j.generation AND notification_cycle=j.notification_cycle AND workflow_id=j.correlation_id)=1)
            ON CONFLICT(result_key) DO NOTHING`)
            .bind(JSON.stringify(['publication',runId,generation,job.notificationCycle,'terminal']),attempt.groupId,JSON.stringify(result),new Date().toISOString(),runId,generation,job.notificationCycle,event.instanceId,binding.event_id,attempt.groupId).run();
        });
      } catch { /* Preserve the setup failure. */ }
      throw error;
    }
    const identity=await step.do('notification-identity',{retries:{limit:0,delay:'1 second'}},async()=>{
      const job=await readPublicationJob(this.env.DB,event.payload.publicationRunId);
      if(!job || job.generation!==generation || job.correlationId!==event.instanceId)throw new NonRetryableError('Publication identity unavailable','publication_generation_stale');
      return {runId:event.payload.publicationRunId,generation,notificationCycle:job.notificationCycle};
    });
    return runPublicationWorkflow(
      event.payload,
      step,
      { ...depsFor(this.env, { now: () => new Date() }, context,identity), copyOwner: { workflowId: event.instanceId, notificationCycle: identity.notificationCycle } },
      event.instanceId,
      context.replyGroupId ? {groupId:context.replyGroupId,notificationCycle:identity.notificationCycle} : undefined,
    );
  }
}
