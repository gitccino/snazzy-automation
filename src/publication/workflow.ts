import Anthropic from "@anthropic-ai/sdk";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { parseConfig } from "../config";
import type { Env } from "../env";
import { createAssetStore } from "../import/asset-store";
import { createLineClient } from "../line/client";
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
  validatePublication,
  type PublicationServiceDeps,
} from "./service";
import type { PublicationResult, PublicationWorkflowParams } from "./types";

function depsFor(env: Env, clock: Clock): PublicationServiceDeps {
  const config = parseConfig(env.APP_CONFIG_JSON);
  const fetcher = fetch.bind(globalThis);
  const line = createLineClient({ channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN, fetch: fetcher });
  return {
    db: env.DB,
    assets: createAssetStore(env.IMAGES_BUCKET, {
      signingSecret: env.ASSET_URL_SIGNING_SECRET,
      publicBaseUrl: config.publicBaseUrl,
    }, clock),
    bucket: env.IMAGES_BUCKET,
    images: env.IMAGES,
    fetcher,
    anthropic: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 }),
    clock,
    config,
    airtableToken: env.AIRTABLE_TOKEN,
    googleServiceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON,
    notify: (text) => line.pushMessage(config.lineAllowedGroupId, text),
  };
}

async function workflowCall<T>(reason: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof OperationalError && !error.retryable) {
      // The name survives durable error serialization; custom Error fields may not.
      throw new NonRetryableError(reason, error.code);
    }
    // Durable retries and their logs must not retain raw upstream bodies or secrets.
    throw new Error(reason);
  }
}

function isContenderRejection(error: unknown): boolean {
  const code = error instanceof OperationalError
    ? error.code
    : error instanceof Error ? error.name : null;
  return code === "publication_job_locked" || code === "publication_job_terminal";
}

export async function runPublicationWorkflow(
  params: PublicationWorkflowParams,
  step: WorkflowStep,
  deps: PublicationServiceDeps,
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
  let validation: Awaited<ReturnType<typeof validatePublication>>;
  try {
    validation = await step.do("validate publication", retries, () =>
      workflowCall("Unable to read or validate publication data.", () =>
        validatePublication(deps, runId, `publication-${runId}`)),
    );
  } catch (error) {
    if (isContenderRejection(error)) throw error;
    await step.do("record exhausted publication failure", retries, () =>
      workflowCall("Unable to record the publication failure.", () =>
        failPublicationAfterExhaustion(deps, runId, "Unable to read or validate publication data.", null)),
    );
    throw error;
  }
  if (validation.kind === "already_succeeded") return validation.result;
  if (validation.kind === "validation_failed") {
    await step.do("notify validation failure", retries, () =>
      workflowCall("Unable to send the publication validation notification.", () =>
        notifyPublicationValidationFailure(deps, runId, validation.thaiDate, validation.validation)),
    );
    return null;
  }

  let prepared: Awaited<ReturnType<typeof preparePublicationOutputs>>;
  let result: PublicationResult;
  // Fixed stage reasons are the only error text passed to Airtable and LINE.
  let failureReason = "Unable to prepare publication images and captions.";
  try {
    prepared = await step.do("prepare outputs", retries, () =>
      workflowCall(failureReason, () => preparePublicationOutputs(deps, validation.value)),
    );
    failureReason = "Unable to create the temporary Google document.";
    const tempDocId = await step.do("ensure temporary document", retries, () =>
      workflowCall(failureReason, () => ensureTemporaryDocument(deps, prepared)),
    );
    failureReason = "Unable to fill or verify the Google document.";
    await step.do("fill and verify document", retries, () =>
      workflowCall(failureReason, () => fillAndVerifyDocument(deps, prepared, tempDocId)),
    );
    failureReason = "Unable to finalize the publication.";
    result = await step.do("finalize publication", retries, () =>
      workflowCall(failureReason, () => finalizePublication(deps, prepared, tempDocId)),
    );
  } catch (error) {
    if (isContenderRejection(error)) throw error;
    await step.do("record exhausted publication failure", retries, () =>
      workflowCall("Unable to record the publication failure.", () =>
        failPublicationAfterExhaustion(deps, runId, failureReason, validation.value.thaiDate)),
    );
    throw error;
  }
  // Notification failure must not delete or downgrade a completed document.
  await step.do("notify publication success", retries, () =>
    workflowCall("Unable to send the publication success notification.", () =>
      notifyPublicationSuccess(deps, prepared, result)),
  );
  return result;
}

export class PublicationWorkflow extends WorkflowEntrypoint<Env, PublicationWorkflowParams> {
  async run(
    event: WorkflowEvent<PublicationWorkflowParams>,
    step: WorkflowStep,
  ): Promise<PublicationResult | null> {
    return runPublicationWorkflow(event.payload, step, depsFor(this.env, { now: () => new Date() }));
  }
}
