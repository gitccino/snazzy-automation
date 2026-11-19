import {
  preparePublicationImages,
  ProductImagePreparationFailure,
} from "./product-images";
import Anthropic from "@anthropic-ai/sdk";
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
import { readPublicationJob } from '../db/publication-repository';
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
import type { PublicationResult, PublicationWorkflowParams } from "./types";
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
  params: PublicationWorkflowParams,
  step: WorkflowStep,
  deps: PublicationServiceDeps,
  instanceId?: string,
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
  async function recordFailure(reason:string,displayDate:string|null,originalError:unknown) {
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
    await recordFailure("Unable to finalize the publication.",null,error);
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
    await recordFailure("Unable to read or validate publication data.",null,error);
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
    failureReason = "Unable to prepare publication images and captions.";
    prepared = await step.do("prepare outputs", retries, () =>
      workflowCall(failureReason, () =>
        preparePublicationOutputs(deps, imagePrepared),
      ),
    );
    failureReason = "Unable to create the temporary Google document.";
    const tempDocId = await step.do("ensure temporary document", retries, () =>
      workflowCall(failureReason, () =>
        ensureTemporaryDocument(deps, prepared),
      ),
    );
    failureReason = "Unable to fill or verify the Google document.";
    await step.do("fill and verify document", retries, () =>
      workflowCall(failureReason, () =>
        fillAndVerifyDocument(deps, prepared, tempDocId),
      ),
    );
    failureReason = "Unable to finalize the publication.";
    result = await step.do("finalize publication", retries, () =>
      workflowCall(failureReason, () =>
        finalizePublication(deps, prepared, tempDocId),
      ),
    );
  } catch (error) {
    if (isContenderRejection(error)) throw error;
    await recordFailure(failureReason,validation.value.thaiDate,error);
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
    const generation = event.payload.generation ?? 1;
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
    const context = await step.do(
      "settings-context",
      { retries: { limit: 0, delay: "1 second" } },
      () => resolvePublicationContext(this.env, event.payload),
    );
    const identity=await step.do('notification-identity',{retries:{limit:0,delay:'1 second'}},async()=>{
      const job=await readPublicationJob(this.env.DB,event.payload.publicationRunId);
      if(!job || job.generation!==generation)throw new NonRetryableError('Publication identity unavailable','publication_generation_stale');
      return {runId:event.payload.publicationRunId,generation,notificationCycle:job.notificationCycle};
    });
    return runPublicationWorkflow(
      event.payload,
      step,
      depsFor(this.env, { now: () => new Date() }, context,identity),
      event.instanceId,
    );
  }
}
