import type Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../config";
import type { AssetStore } from "../import/asset-store";
import type { Fetcher } from "../shared/http";
import type { Clock } from "../shared/time";
import { OperationalError } from "../shared/errors";
import {
  acquireOrResumeJob, claimPublicationDate, getProductCache, putProductCaptions, putProductCollage,
  setJobState, setTempDocId, type PublicationJobRow,
} from "../db/publication-repository";
import {
  loadRunById, markRunFailed, markRunGenerated, markRunGenerating,
  markRunNeedsCorrection, updateProductCollage,
} from "./airtable-runs";
import { generateCollage, collageR2Key, collageInputFingerprint, type ImagesBinding } from "./collage";
import { captionInputFingerprint, planCaptionBatches, requestCaptionBatch, toCaptionRequestProducts } from "./captions";
import { createGoogleAuthClient, type GoogleOAuthCredentials } from "./google-auth";
import {
  copyTemplate, deleteDocument, fillTemplate, finalizeDocument,
  findTemporaryDocument, verifyDocumentContainsProducts, type DocProductContent,
} from "./google-docs";
import type { PublicationProduct, PublicationResult, PublicationRun } from "./types";
import { formatValidationErrorSummary, validateRunCompleteness, type ValidationResult } from "./validator";
import {
  buildPublicationSuccessMessage, buildPublicationValidationFailureMessage,
  buildPublicationWorkflowFailureMessage,
} from "../line/messages";

export interface PublicationServiceDeps {
  db: D1Database;
  assets: AssetStore;
  bucket: R2Bucket;
  images: ImagesBinding;
  fetcher: Fetcher;
  anthropic: Pick<Anthropic, "messages">;
  clock: Clock;
  config: AppConfig;
  airtableToken: string;
  googleOAuthCredentials: GoogleOAuthCredentials;
  notify(text: string): Promise<void>;
}

export interface ValidatedPublication {
  run: PublicationRun;
  thaiDate: string;
}

export interface PreparedProductOutput {
  product: PublicationProduct;
  collageR2Key: string;
  captionDrafts: [string, string, string];
}

export interface PreparedPublication extends ValidatedPublication {
  outputs: PreparedProductOutput[];
}

export type ValidationStageOutcome =
  | { kind: "valid"; value: ValidatedPublication }
  | { kind: "already_succeeded"; result: PublicationResult }
  | { kind: "validation_failed"; thaiDate: string; validation: ValidationResult };

type StageJob = Pick<PublicationJobRow, "state" | "tempDocId" | "googleDocId" | "googleDocUrl">;

// Ownership is established by validatePublication. Subsequent stages are internal
// durable steps; reading their job must never acquire a new lock or create a row.
async function readJob(deps: PublicationServiceDeps, runId: string): Promise<StageJob> {
  const job = await deps.db.prepare(`SELECT state, temp_doc_id AS tempDocId,
    google_doc_id AS googleDocId, google_doc_url AS googleDocUrl
    FROM publication_jobs WHERE publication_run_id = ?`).bind(runId).first<StageJob>();
  if (!job) throw new OperationalError("publication_job_missing", "Publication job is missing", false);
  return job;
}

function requireActiveJob(job: StageJob): void {
  if (job.state === "succeeded" || job.state === "failed" || job.state === "validation_failed") {
    throw new OperationalError("publication_job_terminal", `Publication job is ${job.state}`, false);
  }
}

function publicationResult(runId: string, job: StageJob, productIds: string[]): PublicationResult {
  if (!job.googleDocId || !job.googleDocUrl) {
    throw new OperationalError("publication_result_missing", "Successful publication job has no document result", false);
  }
  return { publicationRunId: runId, googleDocId: job.googleDocId, googleDocUrl: job.googleDocUrl, productIds };
}

function thaiDate(isoDate: string): string {
  return new Intl.DateTimeFormat("th-TH-u-ca-buddhist-nu-latn", {
    timeZone: "Asia/Bangkok", day: "numeric", month: "long", year: "numeric",
  }).format(new Date(`${isoDate}T12:00:00.000Z`));
}

function airtableRunUrl(config: AppConfig, runId: string): string {
  return `https://airtable.com/${config.airtableBaseId}/${config.airtablePublicationRunsTableId}/${runId}`;
}

function cachedDrafts(value: string | null): [string, string, string] | null {
  if (!value) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (Array.isArray(parsed) && parsed.length === 3 && parsed.every(draft =>
    typeof draft === "string" && draft === draft.trim() && draft.length > 0 &&
    draft.length <= 400 && /[ก-๙]/.test(draft),
  )) return [parsed[0], parsed[1], parsed[2]];
  return null;
}

export async function validatePublication(
  deps: PublicationServiceDeps,
  publicationRunId: string,
  correlationId: string,
): Promise<ValidationStageOutcome> {
  const acquired = await acquireOrResumeJob(deps.db, deps.clock, publicationRunId, correlationId);
  if (!acquired.alreadySucceeded) {
    if (acquired.job.state === "failed") {
      throw new OperationalError("publication_job_terminal", "Publication job is failed", false);
    }
    // A retried durable step uses the original owner's correlation ID. Only the
    // atomic INSERT winner establishes that identity; contenders cannot change it.
    if (!acquired.ownsLock && acquired.job.correlationId !== correlationId) {
      throw new OperationalError("publication_job_locked", "Publication job is owned by another workflow", false);
    }
  }
  const run = await loadRunById(deps.fetcher, deps.config, deps.airtableToken, publicationRunId);
  if (acquired.alreadySucceeded) {
    return { kind: "already_succeeded", result: publicationResult(publicationRunId, acquired.job, run.products.map(p => p.productId)) };
  }
  const displayDate = thaiDate(run.publicationDate);
  await setJobState(deps.db, deps.clock, publicationRunId, "validating");
  const validation = validateRunCompleteness(run.products);
  if (!validation.valid) {
    await setJobState(deps.db, deps.clock, publicationRunId, "validation_failed", { validationResultJson: JSON.stringify(validation) });
    await markRunNeedsCorrection(deps.fetcher, deps.config, deps.airtableToken, publicationRunId, formatValidationErrorSummary(validation));
    return { kind: "validation_failed", thaiDate: displayDate, validation };
  }
  if (!await claimPublicationDate(deps.db, deps.clock, publicationRunId, run.publicationDate)) {
    throw new OperationalError("publication_date_conflict", "Publication date is already claimed or differs from this run's claim", false);
  }
  await setJobState(deps.db, deps.clock, publicationRunId, "validating", { validationResultJson: null });
  return { kind: "valid", value: { run, thaiDate: displayDate } };
}

export async function notifyPublicationValidationFailure(
  deps: PublicationServiceDeps,
  publicationRunId: string,
  displayDate: string,
  validation: ValidationResult,
): Promise<void> {
  await deps.notify(buildPublicationValidationFailureMessage({
    thaiDate: displayDate, validation, airtableRunUrl: airtableRunUrl(deps.config, publicationRunId),
  }));
}

async function ensureCollage(deps: PublicationServiceDeps, runId: string, product: PublicationProduct): Promise<string> {
  const cache = await getProductCache(deps.db, runId, product.productId);
  const inputFingerprint = await collageInputFingerprint(product.orderedImageKeys);
  if (cache.collageR2Key && cache.collageInputFingerprint === inputFingerprint) return cache.collageR2Key;
  const [first, second, third, fourth] = product.orderedImageKeys;
  if (!first || !second || !third || !fourth) throw new Error(`four ordered images required for ${product.productId}`);
  const bytes = await generateCollage(deps.bucket, deps.images, [first, second, third, fourth]);
  const key = collageR2Key(product.productId);
  await deps.bucket.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  await putProductCollage(deps.db, deps.clock, runId, product.productId, key, inputFingerprint);
  return key;
}

async function captionsForProducts(deps: PublicationServiceDeps, runId: string, products: PublicationProduct[]): Promise<Map<string, [string, string, string]>> {
  const result = new Map<string, [string, string, string]>();
  const missing: PublicationProduct[] = [];
  const fingerprints = new Map<string, string>();
  for (const product of products) {
    const cache = await getProductCache(deps.db, runId, product.productId);
    const inputFingerprint = await captionInputFingerprint(product, deps.config.claudeModel);
    fingerprints.set(product.productId, inputFingerprint);
    const drafts = cache.captionsInputFingerprint === inputFingerprint ? cachedDrafts(cache.captionsJson) : null;
    if (drafts) result.set(product.productId, drafts);
    else missing.push(product);
  }
  const batches = await planCaptionBatches(deps.anthropic, deps.config.claudeModel, toCaptionRequestProducts(missing), deps.config.claudeRequestInputTokenLimit);
  const unresolved: string[] = [];
  for (const batch of batches) {
    const generated = await requestCaptionBatch(
      deps.anthropic,
      deps.config.claudeModel,
      batch,
      { db: deps.db, clock: deps.clock },
    );
    // Commit valid work before another batch can throw or return incomplete data.
    for (const item of generated.captions) {
      await putProductCaptions(deps.db, deps.clock, runId, item.productId, JSON.stringify(item.drafts), fingerprints.get(item.productId)!);
      result.set(item.productId, item.drafts);
    }
    unresolved.push(...generated.missingProductIds);
  }
  if (unresolved.length > 0) throw new Error(`caption generation incomplete for ${unresolved.join(", ")}`);
  return result;
}

export async function preparePublicationOutputs(deps: PublicationServiceDeps, validated: ValidatedPublication): Promise<PreparedPublication> {
  const runId = validated.run.airtableRunId;
  requireActiveJob(await readJob(deps, runId));
  await setJobState(deps.db, deps.clock, runId, "generating");
  await markRunGenerating(deps.fetcher, deps.config, deps.airtableToken, runId);
  const captions = await captionsForProducts(deps, runId, validated.run.products);
  const outputs: PreparedProductOutput[] = [];
  for (const product of validated.run.products) {
    const drafts = captions.get(product.productId);
    if (!drafts) throw new Error(`captions missing for ${product.productId}`);
    outputs.push({ product, collageR2Key: await ensureCollage(deps, runId, product), captionDrafts: drafts });
  }
  return { ...validated, outputs };
}

export async function ensureTemporaryDocument(deps: PublicationServiceDeps, prepared: PreparedPublication): Promise<string> {
  const runId = prepared.run.airtableRunId;
  const job = await readJob(deps, runId);
  requireActiveJob(job);
  if (job.tempDocId) return job.tempDocId;
  const tokens = createGoogleAuthClient(deps.googleOAuthCredentials, deps.clock, deps.fetcher);
  const discovered = await findTemporaryDocument(deps.fetcher, tokens, deps.config.googleDriveFolderId, runId);
  const docId = discovered ?? await copyTemplate(deps.fetcher, tokens, deps.config.googleTemplateDocId, deps.config.googleDriveFolderId, runId, `Publication ${prepared.run.publicationDate} (in progress)`);
  await setTempDocId(deps.db, deps.clock, runId, docId);
  return docId;
}

export async function fillAndVerifyDocument(deps: PublicationServiceDeps, prepared: PreparedPublication, tempDocId: string): Promise<void> {
  requireActiveJob(await readJob(deps, prepared.run.airtableRunId));
  const tokens = createGoogleAuthClient(deps.googleOAuthCredentials, deps.clock, deps.fetcher);
  const products: DocProductContent[] = [];
  for (const output of prepared.outputs) {
    const signedUrl = await deps.assets.signUrl(output.collageR2Key, 900);
    await updateProductCollage(deps.fetcher, deps.config, deps.airtableToken, output.product.airtableRecordId, signedUrl);
    products.push({
      productId: output.product.productId, conditionType: output.product.conditionType,
      description: output.product.description, lineSquarePrice: output.product.lineSquarePrice,
      igPrice: output.product.igPrice, captionDrafts: output.captionDrafts, collageImageUrl: signedUrl,
    });
  }
  await fillTemplate(deps.fetcher, tokens, tempDocId, prepared.thaiDate, products);
  const verification = await verifyDocumentContainsProducts(deps.fetcher, tokens, tempDocId, prepared.outputs.map(o => o.product.productId));
  if (!verification.ok) throw new Error(`generated document missing Product IDs: ${verification.missingProductIds.join(", ")}`);
}

export async function finalizePublication(deps: PublicationServiceDeps, prepared: PreparedPublication, tempDocId: string): Promise<PublicationResult> {
  const runId = prepared.run.airtableRunId;
  const job = await readJob(deps, runId);
  const productIds = prepared.outputs.map(o => o.product.productId);
  if (job.state === "succeeded") return publicationResult(runId, job, productIds);
  requireActiveJob(job);
  const tokens = createGoogleAuthClient(deps.googleOAuthCredentials, deps.clock, deps.fetcher);
  const url = await finalizeDocument(deps.fetcher, tokens, tempDocId, `Publication ${prepared.run.publicationDate}`);
  await markRunGenerated(deps.fetcher, deps.config, deps.airtableToken, runId, url, deps.clock.now().toISOString());
  await setJobState(deps.db, deps.clock, runId, "succeeded", { googleDocId: tempDocId, googleDocUrl: url, tempDocId });
  return { publicationRunId: runId, googleDocId: tempDocId, googleDocUrl: url, productIds };
}

export async function notifyPublicationSuccess(deps: PublicationServiceDeps, prepared: PreparedPublication, result: PublicationResult): Promise<void> {
  await deps.notify(buildPublicationSuccessMessage({ thaiDate: prepared.thaiDate, productIds: result.productIds, googleDocUrl: result.googleDocUrl }));
}

/** Called only by the owning Workflow after exhaustion, with a sanitized human-readable reason. */
export async function failPublicationAfterExhaustion(
  deps: PublicationServiceDeps,
  publicationRunId: string,
  reason: string,
  displayDate: string | null,
): Promise<void> {
  const job = await readJob(deps, publicationRunId);
  if (job.state === "succeeded") return;
  // Only a generating job could have created a copy. Validation failures must
  // not initiate Google discovery; a failed row already completed its cleanup.
  if (job.state !== "failed" && (job.tempDocId || job.state === "generating")) {
    const tokens = createGoogleAuthClient(deps.googleOAuthCredentials, deps.clock, deps.fetcher);
    const docId = job.tempDocId ?? await findTemporaryDocument(deps.fetcher, tokens, deps.config.googleDriveFolderId, publicationRunId);
    if (docId) {
      await deleteDocument(deps.fetcher, tokens, docId);
      await setTempDocId(deps.db, deps.clock, publicationRunId, null);
    }
  }
  await setJobState(deps.db, deps.clock, publicationRunId, "failed");
  await markRunFailed(deps.fetcher, deps.config, deps.airtableToken, publicationRunId, reason);
  await deps.notify(buildPublicationWorkflowFailureMessage({
    thaiDate: displayDate ?? "ไม่สามารถอ่านวันที่รายการได้", reason,
    airtableRunUrl: airtableRunUrl(deps.config, publicationRunId),
  }));
}
