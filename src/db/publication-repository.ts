import type { Clock } from "../shared/time";
import { OperationalError } from "../shared/errors";
import { publicationWorkflowId } from "../publication/types";
import type { PublicationFinalizationIntent } from "../publication/types";

export type PublicationJobState =
  | "locked"
  | "validating"
  | "validation_failed"
  | "generating"
  | "succeeded"
  | "failed";

export interface PublicationJobRow {
  publicationRunId: string;
  publicationDate: string | null;
  state: PublicationJobState;
  correlationId: string;
  googleDocId: string | null;
  googleDocUrl: string | null;
  tempDocId: string | null;
  validationResultJson: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  generation: number;
  successfulGeneration: number;
  finalizationJson: string | null;
}

export interface ProductOutputCache {
  collageR2Key: string | null;
  collageInputFingerprint: string | null;
  captionsJson: string | null;
  captionsInputFingerprint: string | null;
}

interface JobRowRaw {
  publication_run_id: string;
  publication_date: string | null;
  state: PublicationJobState;
  correlation_id: string;
  google_doc_id: string | null;
  google_doc_url: string | null;
  temp_doc_id: string | null;
  validation_result_json: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  generation: number;
  successful_generation: number;
  finalization_json: string | null;
}

function toRow(raw: JobRowRaw): PublicationJobRow {
  return {
    publicationRunId: raw.publication_run_id,
    publicationDate: raw.publication_date,
    state: raw.state,
    correlationId: raw.correlation_id,
    googleDocId: raw.google_doc_id,
    googleDocUrl: raw.google_doc_url,
    tempDocId: raw.temp_doc_id,
    validationResultJson: raw.validation_result_json,
    attemptCount: raw.attempt_count,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    generation: raw.generation,
    successfulGeneration: raw.successful_generation,
    finalizationJson: raw.finalization_json,
  };
}

export async function readPublicationJob(db: D1Database, runId: string): Promise<PublicationJobRow | null> {
  const raw = await db.prepare("SELECT * FROM publication_jobs WHERE publication_run_id = ?").bind(runId).first<JobRowRaw>();
  return raw ? toRow(raw) : null;
}

export async function assertPublicationGeneration(db: D1Database, runId: string, generation: number): Promise<PublicationJobRow> {
  const job = await readPublicationJob(db, runId);
  if (!job) throw new OperationalError("publication_job_missing", "Publication job missing", false);
  if (job.generation !== generation) throw new OperationalError("publication_generation_stale", "Publication generation is stale", false);
  return job;
}

export async function reopenSuccessfulJobForRegeneration(
  db: D1Database, clock: Clock, runId: string, expectedGeneration: number,
): Promise<PublicationJobRow | null> {
  const raw = await db.prepare(`UPDATE publication_jobs
    SET generation = generation + 1, state = 'locked', correlation_id = ?, temp_doc_id = NULL,
        validation_result_json = NULL, finalization_json = NULL, attempt_count = 0, updated_at = ?
    WHERE publication_run_id = ? AND state = 'succeeded' AND generation = ? AND successful_generation = generation
    RETURNING *`).bind(publicationWorkflowId(runId, expectedGeneration + 1), clock.now().toISOString(), runId, expectedGeneration).first<JobRowRaw>();
  return raw ? toRow(raw) : null;
}

export async function persistFinalizationIntent(
  db: D1Database, clock: Clock, runId: string, generation: number, intent: PublicationFinalizationIntent,
): Promise<void> {
  const serialized = JSON.stringify(intent);
  await db.prepare(`UPDATE publication_jobs SET finalization_json = ?, updated_at = ?
    WHERE publication_run_id = ? AND generation = ? AND finalization_json IS NULL
      AND state NOT IN ('succeeded','failed','validation_failed')`)
    .bind(serialized, clock.now().toISOString(), runId, generation).run();
  const job = await assertPublicationGeneration(db, runId, generation);
  if (job.finalizationJson !== serialized) throw new OperationalError("publication_finalization_conflict", "Publication finalization intent conflicts", false);
}

export async function completePublicationGeneration(
  db: D1Database, clock: Clock, runId: string, generation: number, intent: PublicationFinalizationIntent,
): Promise<void> {
  const result = await db.prepare(`UPDATE publication_jobs
    SET state='succeeded',successful_generation=generation,google_doc_id=?,google_doc_url=?,
        temp_doc_id=NULL,finalization_json=NULL,updated_at=?
    WHERE publication_run_id=? AND generation=? AND finalization_json=? AND state NOT IN ('succeeded','failed','validation_failed')`)
    .bind(intent.docId, intent.docUrl, clock.now().toISOString(), runId, generation, JSON.stringify(intent)).run();
  const job = await assertPublicationGeneration(db, runId, generation);
  if (result.meta.changes !== 1 && !(job.state === "succeeded" && job.googleDocId === intent.docId && job.googleDocUrl === intent.docUrl)) {
    throw new OperationalError("publication_finalization_conflict", "Publication finalization result conflicts", false);
  }
}

export async function acquireOrResumeJob(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  correlationId: string,
): Promise<{ job: PublicationJobRow; alreadySucceeded: boolean; ownsLock: boolean }> {
  const nowIso = clock.now().toISOString();
  const insertResult = await db
    .prepare(
      `INSERT INTO publication_jobs (publication_run_id, state, correlation_id, attempt_count, created_at, updated_at)
       VALUES (?, 'locked', ?, 0, ?, ?)
       ON CONFLICT (publication_run_id) DO NOTHING`,
    )
    .bind(publicationRunId, correlationId, nowIso, nowIso)
    .run();

  const raw = await db
    .prepare("SELECT * FROM publication_jobs WHERE publication_run_id = ?")
    .bind(publicationRunId)
    .first<JobRowRaw>();

  if (!raw) {
    throw new Error(`publication job row missing immediately after insert for ${publicationRunId}`);
  }

  const job = toRow(raw);
  return { job, alreadySucceeded: job.state === "succeeded", ownsLock: insertResult.meta.changes === 1 };
}

/** A claimed date stays with its run through retries, failure, and finalization. */
export async function claimPublicationDate(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  publicationDate: string,
  generation = 1,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE OR IGNORE publication_jobs SET publication_date = ?, updated_at = ?
     WHERE publication_run_id = ? AND (publication_date IS NULL OR publication_date = ?)
       AND state NOT IN ('succeeded', 'failed') AND generation = ?`,
  ).bind(publicationDate, clock.now().toISOString(), publicationRunId, publicationDate, generation).run();
  return result.meta.changes === 1;
}

/** Only the trigger may reopen a failed job after confirming its Workflow can start again. */
export async function reopenFailedJobForRestart(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  correlationId: string,
  generation = 1,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE publication_jobs SET state = 'locked', correlation_id = ?, updated_at = ?
       WHERE publication_run_id = ? AND state = 'failed' AND generation = ?`,
    )
    .bind(correlationId, clock.now().toISOString(), publicationRunId, generation)
    .run();
  return result.meta.changes === 1;
}

export async function setJobState(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  state: PublicationJobState,
  patch?: Partial<Pick<PublicationJobRow, "googleDocId" | "googleDocUrl" | "tempDocId" | "validationResultJson" | "finalizationJson">>,
  generation = 1,
): Promise<void> {
  const nowIso = clock.now().toISOString();
  const columns: string[] = ["state = ?"];
  const values: (string | null)[] = [state];
  const patchColumns: Array<["googleDocId" | "googleDocUrl" | "tempDocId" | "validationResultJson" | "finalizationJson", string]> = [
    ["googleDocId", "google_doc_id"],
    ["googleDocUrl", "google_doc_url"],
    ["tempDocId", "temp_doc_id"],
    ["validationResultJson", "validation_result_json"],
    ["finalizationJson", "finalization_json"],
  ];
  for (const [key, column] of patchColumns) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
      columns.push(`${column} = ?`);
      values.push(patch[key] ?? null);
    }
  }
  if (state === "succeeded") columns.push("successful_generation = generation");
  columns.push("updated_at = ?");
  values.push(nowIso, publicationRunId, String(generation));
  await db
    .prepare(
      `UPDATE publication_jobs SET ${columns.join(", ")}
       WHERE publication_run_id = ? AND generation = ? AND state NOT IN ('succeeded', 'failed')`,
    )
    .bind(...values)
    .run();
  await assertPublicationGeneration(db, publicationRunId, generation);
}

export async function incrementAttempt(db: D1Database, publicationRunId: string, generation = 1): Promise<number> {
  const raw = await db
    .prepare("UPDATE publication_jobs SET attempt_count = attempt_count + 1 WHERE publication_run_id = ? AND generation = ? RETURNING attempt_count")
    .bind(publicationRunId, generation)
    .first<{ attempt_count: number }>();
  await assertPublicationGeneration(db, publicationRunId, generation);
  return raw?.attempt_count ?? 0;
}

export async function setTempDocId(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  tempDocId: string | null,
  generation = 1,
): Promise<void> {
  await db
    .prepare("UPDATE publication_jobs SET temp_doc_id = ?, updated_at = ? WHERE publication_run_id = ? AND generation = ? AND state NOT IN ('succeeded','failed')")
    .bind(tempDocId, clock.now().toISOString(), publicationRunId, generation)
    .run();
  await assertPublicationGeneration(db, publicationRunId, generation);
}

export async function getProductCache(
  db: D1Database,
  publicationRunId: string,
  productId: string,
): Promise<ProductOutputCache> {
  const raw = await db
    .prepare(`SELECT collage_r2_key AS collageR2Key, collage_input_fingerprint AS collageInputFingerprint,
      captions_json AS captionsJson, captions_input_fingerprint AS captionsInputFingerprint
      FROM publication_product_cache WHERE publication_run_id = ? AND product_id = ?`)
    .bind(publicationRunId, productId)
    .first<ProductOutputCache>();
  return raw ?? { collageR2Key: null, collageInputFingerprint: null, captionsJson: null, captionsInputFingerprint: null };
}

export async function putProductCollage(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  productId: string,
  collageR2Key: string,
  inputFingerprint: string,
  generation = 1,
): Promise<void> {
  const nowIso = clock.now().toISOString();
  await db
    .prepare(
      `INSERT INTO publication_product_cache (publication_run_id, product_id, collage_r2_key, collage_input_fingerprint, updated_at)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM publication_jobs WHERE publication_run_id = ? AND generation = ? AND state NOT IN ('succeeded','failed'))
       ON CONFLICT (publication_run_id, product_id)
       DO UPDATE SET collage_r2_key = excluded.collage_r2_key,
         collage_input_fingerprint = excluded.collage_input_fingerprint, updated_at = excluded.updated_at`,
    )
    .bind(publicationRunId, productId, collageR2Key, inputFingerprint, nowIso, publicationRunId, generation)
    .run();
  await assertPublicationGeneration(db, publicationRunId, generation);
}

export async function putProductCaptions(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  productId: string,
  captionsJson: string,
  inputFingerprint: string,
  generation = 1,
): Promise<void> {
  const nowIso = clock.now().toISOString();
  await db
    .prepare(
      `INSERT INTO publication_product_cache (publication_run_id, product_id, captions_json, captions_input_fingerprint, updated_at)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM publication_jobs WHERE publication_run_id = ? AND generation = ? AND state NOT IN ('succeeded','failed'))
       ON CONFLICT (publication_run_id, product_id)
       DO UPDATE SET captions_json = excluded.captions_json,
         captions_input_fingerprint = excluded.captions_input_fingerprint, updated_at = excluded.updated_at`,
    )
    .bind(publicationRunId, productId, captionsJson, inputFingerprint, nowIso, publicationRunId, generation)
    .run();
  await assertPublicationGeneration(db, publicationRunId, generation);
}
