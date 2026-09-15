import type { Clock } from "../shared/time";

export type PublicationJobState =
  | "locked"
  | "validating"
  | "validation_failed"
  | "generating"
  | "succeeded"
  | "failed";

export interface PublicationJobRow {
  publicationRunId: string;
  state: PublicationJobState;
  correlationId: string;
  googleDocId: string | null;
  googleDocUrl: string | null;
  tempDocId: string | null;
  validationResultJson: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductOutputCache {
  collageR2Key: string | null;
  captionsJson: string | null;
}

interface JobRowRaw {
  publication_run_id: string;
  state: PublicationJobState;
  correlation_id: string;
  google_doc_id: string | null;
  google_doc_url: string | null;
  temp_doc_id: string | null;
  validation_result_json: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}

function toRow(raw: JobRowRaw): PublicationJobRow {
  return {
    publicationRunId: raw.publication_run_id,
    state: raw.state,
    correlationId: raw.correlation_id,
    googleDocId: raw.google_doc_id,
    googleDocUrl: raw.google_doc_url,
    tempDocId: raw.temp_doc_id,
    validationResultJson: raw.validation_result_json,
    attemptCount: raw.attempt_count,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export async function acquireOrResumeJob(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  correlationId: string,
): Promise<{ job: PublicationJobRow; alreadySucceeded: boolean }> {
  const nowIso = clock.now().toISOString();
  await db
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
  return { job, alreadySucceeded: job.state === "succeeded" };
}

export async function setJobState(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  state: PublicationJobState,
  patch?: Partial<Pick<PublicationJobRow, "googleDocId" | "googleDocUrl" | "tempDocId" | "validationResultJson">>,
): Promise<void> {
  const nowIso = clock.now().toISOString();
  await db
    .prepare(
      `UPDATE publication_jobs
       SET state = ?,
           google_doc_id = COALESCE(?, google_doc_id),
           google_doc_url = COALESCE(?, google_doc_url),
           temp_doc_id = COALESCE(?, temp_doc_id),
           validation_result_json = COALESCE(?, validation_result_json),
           updated_at = ?
       WHERE publication_run_id = ?`,
    )
    .bind(
      state,
      patch?.googleDocId ?? null,
      patch?.googleDocUrl ?? null,
      patch?.tempDocId ?? null,
      patch?.validationResultJson ?? null,
      nowIso,
      publicationRunId,
    )
    .run();
}

export async function incrementAttempt(db: D1Database, publicationRunId: string): Promise<number> {
  await db
    .prepare("UPDATE publication_jobs SET attempt_count = attempt_count + 1 WHERE publication_run_id = ?")
    .bind(publicationRunId)
    .run();
  const raw = await db
    .prepare("SELECT attempt_count FROM publication_jobs WHERE publication_run_id = ?")
    .bind(publicationRunId)
    .first<{ attempt_count: number }>();
  return raw?.attempt_count ?? 0;
}

export async function setTempDocId(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  tempDocId: string | null,
): Promise<void> {
  await db
    .prepare("UPDATE publication_jobs SET temp_doc_id = ?, updated_at = ? WHERE publication_run_id = ?")
    .bind(tempDocId, clock.now().toISOString(), publicationRunId)
    .run();
}

export async function getProductCache(
  db: D1Database,
  publicationRunId: string,
  productId: string,
): Promise<ProductOutputCache> {
  const raw = await db
    .prepare("SELECT collage_r2_key, captions_json FROM publication_product_cache WHERE publication_run_id = ? AND product_id = ?")
    .bind(publicationRunId, productId)
    .first<{ collage_r2_key: string | null; captions_json: string | null }>();
  return { collageR2Key: raw?.collage_r2_key ?? null, captionsJson: raw?.captions_json ?? null };
}

export async function putProductCollage(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  productId: string,
  collageR2Key: string,
): Promise<void> {
  const nowIso = clock.now().toISOString();
  await db
    .prepare(
      `INSERT INTO publication_product_cache (publication_run_id, product_id, collage_r2_key, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (publication_run_id, product_id)
       DO UPDATE SET collage_r2_key = excluded.collage_r2_key, updated_at = excluded.updated_at`,
    )
    .bind(publicationRunId, productId, collageR2Key, nowIso)
    .run();
}

export async function putProductCaptions(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  productId: string,
  captionsJson: string,
): Promise<void> {
  const nowIso = clock.now().toISOString();
  await db
    .prepare(
      `INSERT INTO publication_product_cache (publication_run_id, product_id, captions_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (publication_run_id, product_id)
       DO UPDATE SET captions_json = excluded.captions_json, updated_at = excluded.updated_at`,
    )
    .bind(publicationRunId, productId, captionsJson, nowIso)
    .run();
}
