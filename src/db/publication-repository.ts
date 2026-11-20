import { validateReplyMessages } from "../line/client";
import type { TerminalResultV1 } from "../line/reply-types";
import { sha256Hex } from "../shared/ids";
import type { OperationContext } from "../settings/schema";
import { serializeContext } from "./execution-context-repository";
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
  notificationCycle: number;
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
  notification_cycle: number;
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
    notificationCycle: raw.notification_cycle,
    finalizationJson: raw.finalization_json,
  };
}

export async function readPublicationJob(
  db: D1Database,
  runId: string,
): Promise<PublicationJobRow | null> {
  const raw = await db
    .prepare("SELECT * FROM publication_jobs WHERE publication_run_id = ?")
    .bind(runId)
    .first<JobRowRaw>();
  return raw ? toRow(raw) : null;
}

export async function assertPublicationGeneration(
  db: D1Database,
  runId: string,
  generation: number,
): Promise<PublicationJobRow> {
  const job = await readPublicationJob(db, runId);
  if (!job)
    throw new OperationalError(
      "publication_job_missing",
      "Publication job missing",
      false,
    );
  if (job.generation !== generation)
    throw new OperationalError(
      "publication_generation_stale",
      "Publication generation is stale",
      false,
    );
  return job;
}

export async function bindInitialPublicationCreate(
  db: D1Database, eventId: string, groupId: string, publicationDate: string | undefined,
  runId: string, generation: number, notificationCycle: number, action: "create" | "restart" = "create",
): Promise<(PublicationJobRow & { bindingCreated: boolean }) | null> {
  const result = await db.prepare(`INSERT INTO publication_regeneration_events
    (event_id, publication_run_id, generation, notification_cycle, workflow_id, action, job_json, group_id, ingress_operation)
    SELECT ?, j.publication_run_id, j.generation, j.notification_cycle, j.correlation_id, ?, json_object(
      'publication_run_id', j.publication_run_id, 'publication_date', j.publication_date, 'state', j.state, 'correlation_id', j.correlation_id,
      'google_doc_id', j.google_doc_id, 'google_doc_url', j.google_doc_url, 'temp_doc_id', j.temp_doc_id, 'validation_result_json', j.validation_result_json,
      'attempt_count', j.attempt_count, 'created_at', j.created_at, 'updated_at', j.updated_at, 'generation', j.generation,
      'successful_generation', j.successful_generation, 'notification_cycle', j.notification_cycle, 'finalization_json', j.finalization_json), ?, i.operation
    FROM publication_jobs j JOIN line_command_ingress i ON i.event_id = ?
    WHERE i.group_id = ? AND json_extract(i.operation, '$.type') = 'docs'
      AND json_extract(i.operation, '$.publicationDate') IS ?
      AND j.publication_run_id = ? AND j.generation = ? AND j.notification_cycle = ?
    ON CONFLICT(event_id) DO NOTHING`)
    .bind(eventId, action, groupId, eventId, groupId, publicationDate ?? null, runId, generation, notificationCycle).run();
  const binding = await db.prepare(`SELECT e.job_json FROM publication_regeneration_events e
    JOIN line_command_ingress i ON i.event_id = e.event_id
    WHERE e.event_id = ? AND e.action = ? AND e.group_id = ? AND i.group_id = e.group_id AND i.operation = e.ingress_operation
      AND json_extract(i.operation, '$.type') = 'docs' AND json_extract(i.operation, '$.publicationDate') IS ?
      AND e.publication_run_id = ? AND e.generation = ? AND e.notification_cycle = ?`)
    .bind(eventId, action, groupId, publicationDate ?? null, runId, generation, notificationCycle).first<{ job_json: string }>();
  return binding ? { ...toRow(JSON.parse(binding.job_json) as JobRowRaw), bindingCreated: result.meta.changes === 1 } : null;
}

export async function reopenSuccessfulJobForRegeneration(
  db: D1Database,
  clock: Clock,
  runId: string,
  expectedGeneration: number,
  trustedEventId?: string,
): Promise<(PublicationJobRow & { bindingCreated?: boolean }) | null> {
  if (trustedEventId) {
    const workflowId = publicationWorkflowId(runId, expectedGeneration + 1);
    const results = await db.batch([
      db.prepare(`UPDATE publication_jobs SET generation = generation + 1, notification_cycle = 1, state = 'locked', correlation_id = ?, temp_doc_id = NULL, validation_result_json = NULL, finalization_json = NULL, settings_context_json = NULL, attempt_count = 0, updated_at = ?
        WHERE publication_run_id = ? AND state = 'succeeded' AND generation = ? AND successful_generation = generation
        AND NOT EXISTS (SELECT 1 FROM publication_regeneration_events WHERE event_id = ?)`)
        .bind(workflowId, clock.now().toISOString(), runId, expectedGeneration, trustedEventId),
      db.prepare(`INSERT INTO publication_regeneration_events (event_id, publication_run_id, generation, notification_cycle, workflow_id, action, job_json)
        SELECT ?, publication_run_id, generation, notification_cycle, correlation_id, 'regenerate', json_object(
          'publication_run_id', publication_run_id, 'publication_date', publication_date, 'state', state, 'correlation_id', correlation_id,
          'google_doc_id', google_doc_id, 'google_doc_url', google_doc_url, 'temp_doc_id', temp_doc_id, 'validation_result_json', validation_result_json,
          'attempt_count', attempt_count, 'created_at', created_at, 'updated_at', updated_at, 'generation', generation,
          'successful_generation', successful_generation, 'notification_cycle', notification_cycle, 'finalization_json', finalization_json)
        FROM publication_jobs WHERE publication_run_id = ? AND changes() = 1`)
        .bind(trustedEventId, runId),
      db.prepare(`INSERT INTO publication_google_write_evidence (publication_run_id, generation, notification_cycle, state)
        SELECT publication_run_id, generation, notification_cycle, 'tracking'
        FROM publication_regeneration_events WHERE event_id = ? AND changes() = 1`)
        .bind(trustedEventId),
    ]);
    const binding = await db.prepare("SELECT job_json FROM publication_regeneration_events WHERE event_id = ?")
      .bind(trustedEventId).first<{ job_json: string }>();
    return binding ? { ...toRow(JSON.parse(binding.job_json) as JobRowRaw), bindingCreated: results[1]?.meta.changes === 1 } : null;
  }
  const raw = await db
    .prepare(
      `UPDATE publication_jobs
    SET generation = generation + 1, notification_cycle = 1, state = 'locked', correlation_id = ?, temp_doc_id = NULL,
        validation_result_json = NULL, finalization_json = NULL, settings_context_json = NULL, attempt_count = 0, updated_at = ?
    WHERE publication_run_id = ? AND state = 'succeeded' AND generation = ? AND successful_generation = generation
    RETURNING *`,
    )
    .bind(
      publicationWorkflowId(runId, expectedGeneration + 1),
      clock.now().toISOString(),
      runId,
      expectedGeneration,
    )
    .first<JobRowRaw>();
  return raw ? toRow(raw) : null;
}

export async function persistFinalizationIntent(
  db: D1Database,
  clock: Clock,
  runId: string,
  generation: number,
  intent: PublicationFinalizationIntent,
): Promise<void> {
  const serialized = JSON.stringify(intent);
  await db
    .prepare(
      `UPDATE publication_jobs SET finalization_json = ?, updated_at = ?
    WHERE publication_run_id = ? AND generation = ? AND finalization_json IS NULL
      AND state NOT IN ('succeeded','failed','validation_failed')`,
    )
    .bind(serialized, clock.now().toISOString(), runId, generation)
    .run();
  const job = await assertPublicationGeneration(db, runId, generation);
  if (job.finalizationJson !== serialized)
    throw new OperationalError(
      "publication_finalization_conflict",
      "Publication finalization intent conflicts",
      false,
    );
}

export async function completePublicationGeneration(
  db: D1Database,
  clock: Clock,
  runId: string,
  generation: number,
  intent: PublicationFinalizationIntent,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE publication_jobs
    SET state='succeeded',successful_generation=generation,google_doc_id=?,google_doc_url=?,
        temp_doc_id=NULL,finalization_json=NULL,updated_at=?
    WHERE publication_run_id=? AND generation=? AND finalization_json=? AND state NOT IN ('succeeded','failed','validation_failed')`,
    )
    .bind(
      intent.docId,
      intent.docUrl,
      clock.now().toISOString(),
      runId,
      generation,
      JSON.stringify(intent),
    )
    .run();
  const job = await assertPublicationGeneration(db, runId, generation);
  if (
    result.meta.changes !== 1 &&
    !(
      job.state === "succeeded" &&
      job.googleDocId === intent.docId &&
      job.googleDocUrl === intent.docUrl
    )
  ) {
    throw new OperationalError(
      "publication_finalization_conflict",
      "Publication finalization result conflicts",
      false,
    );
  }
}

export async function acquireOrResumeJob(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  correlationId: string,
): Promise<{
  job: PublicationJobRow;
  alreadySucceeded: boolean;
  ownsLock: boolean;
}> {
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
    throw new Error(
      `publication job row missing immediately after insert for ${publicationRunId}`,
    );
  }

  const job = toRow(raw);
  return {
    job,
    alreadySucceeded: job.state === "succeeded",
    ownsLock: insertResult.meta.changes === 1,
  };
}

/** A claimed date stays with its run through retries, failure, and finalization. */
export async function claimPublicationDate(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  publicationDate: string,
  generation = 1,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE OR IGNORE publication_jobs SET publication_date = ?, updated_at = ?
     WHERE publication_run_id = ? AND (publication_date IS NULL OR publication_date = ?)
       AND state NOT IN ('succeeded', 'failed') AND generation = ?`,
    )
    .bind(
      publicationDate,
      clock.now().toISOString(),
      publicationRunId,
      publicationDate,
      generation,
    )
    .run();
  return result.meta.changes === 1;
}

/** Only the trigger may reopen a failed job after confirming its Workflow can start again. */
export async function reopenFailedJobForRestart(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  correlationId: string,
  generation = 1,
  context?: OperationContext,
  notificationCycle = 1,
  event?: { id: string; groupId: string; publicationDate?: string; action: "create" | "restart" },
): Promise<boolean> {
  if (event) {
    const results = await db.batch([
      db.prepare(`UPDATE publication_jobs SET settings_context_json = CASE WHEN temp_doc_id IS NULL AND finalization_json IS NULL THEN COALESCE(?, settings_context_json) ELSE settings_context_json END, notification_cycle = notification_cycle + 1, state = 'locked', correlation_id = ?, updated_at = ?
        WHERE publication_run_id = ? AND (state = 'failed' OR (state = 'validation_failed' AND ? = 1)) AND generation = ? AND notification_cycle = ?
        AND NOT EXISTS (SELECT 1 FROM publication_regeneration_events WHERE event_id = ?)
        AND EXISTS (SELECT 1 FROM line_command_ingress WHERE event_id = ? AND group_id = ? AND json_extract(operation, '$.type') = 'docs' AND json_extract(operation, '$.publicationDate') IS ?)`)
        .bind(context ? serializeContext(context) : null, correlationId, clock.now().toISOString(), publicationRunId, context ? 1 : 0, generation, notificationCycle, event.id, event.id, event.groupId, event.publicationDate ?? null),
      db.prepare(`INSERT INTO publication_regeneration_events (event_id, publication_run_id, generation, notification_cycle, workflow_id, action, job_json, group_id, ingress_operation)
        SELECT ?, j.publication_run_id, j.generation, j.notification_cycle, j.correlation_id, ?, '{}', i.group_id, i.operation
        FROM publication_jobs j JOIN line_command_ingress i ON i.event_id = ? WHERE j.publication_run_id = ? AND changes() = 1`)
        .bind(event.id, event.action, event.id, publicationRunId),
      db.prepare(`INSERT INTO publication_google_write_evidence (publication_run_id, generation, notification_cycle, state)
        SELECT publication_run_id, generation, notification_cycle, 'tracking'
        FROM publication_regeneration_events WHERE event_id = ? AND changes() = 1`)
        .bind(event.id),
    ]);
    return results[1]?.meta.changes === 1;
  }
  const result = await db
    .prepare(
      `UPDATE publication_jobs SET settings_context_json = CASE WHEN temp_doc_id IS NULL AND finalization_json IS NULL THEN COALESCE(?, settings_context_json) ELSE settings_context_json END, notification_cycle = notification_cycle + 1, state = 'locked', correlation_id = ?, updated_at = ?
       WHERE publication_run_id = ? AND (state = 'failed' OR (state = 'validation_failed' AND ? = 1)) AND generation = ? AND notification_cycle = ?`,
    )
    .bind(
      context ? serializeContext(context) : null,
      correlationId,
      clock.now().toISOString(),
      publicationRunId,
      context ? 1 : 0,
      generation,
      notificationCycle,
    )
    .run();
  return result.meta.changes === 1;
}

export async function setJobState(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  state: PublicationJobState,
  patch?: Partial<
    Pick<
      PublicationJobRow,
      | "googleDocId"
      | "googleDocUrl"
      | "tempDocId"
      | "validationResultJson"
      | "finalizationJson"
    >
  >,
  generation = 1,
): Promise<void> {
  const nowIso = clock.now().toISOString();
  const columns: string[] = ["state = ?"];
  const values: (string | null)[] = [state];
  const patchColumns: Array<
    [
      (
        | "googleDocId"
        | "googleDocUrl"
        | "tempDocId"
        | "validationResultJson"
        | "finalizationJson"
      ),
      string,
    ]
  > = [
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

export async function incrementAttempt(
  db: D1Database,
  publicationRunId: string,
  generation = 1,
): Promise<number> {
  const raw = await db
    .prepare(
      "UPDATE publication_jobs SET attempt_count = attempt_count + 1 WHERE publication_run_id = ? AND generation = ? RETURNING attempt_count",
    )
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
    .prepare(
      "UPDATE publication_jobs SET temp_doc_id = ?, updated_at = ? WHERE publication_run_id = ? AND generation = ? AND state NOT IN ('succeeded','failed')",
    )
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
    .prepare(
      `SELECT collage_r2_key AS collageR2Key, collage_input_fingerprint AS collageInputFingerprint,
      captions_json AS captionsJson, captions_input_fingerprint AS captionsInputFingerprint
      FROM publication_product_cache WHERE publication_run_id = ? AND product_id = ?`,
    )
    .bind(publicationRunId, productId)
    .first<ProductOutputCache>();
  return (
    raw ?? {
      collageR2Key: null,
      collageInputFingerprint: null,
      captionsJson: null,
      captionsInputFingerprint: null,
    }
  );
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
    .bind(
      publicationRunId,
      productId,
      collageR2Key,
      inputFingerprint,
      nowIso,
      publicationRunId,
      generation,
    )
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
    .bind(
      publicationRunId,
      productId,
      captionsJson,
      inputFingerprint,
      nowIso,
      publicationRunId,
      generation,
    )
    .run();
  await assertPublicationGeneration(db, publicationRunId, generation);
}

/** An explicit business retry after a recorded uncertainty needs a new terminal identity. */
export async function advanceUnconfirmedPublicationRestart(db:D1Database,clock:Clock,runId:string,generation:number,notificationCycle:number):Promise<'advanced'|'not_needed'|'contended'> {
  const key=JSON.stringify(['publication',runId,generation,notificationCycle,'terminal']);
  const updated=await db.prepare(`UPDATE publication_jobs SET notification_cycle=notification_cycle+1,updated_at=?
    WHERE publication_run_id=? AND generation=? AND notification_cycle=? AND state NOT IN ('succeeded','failed','validation_failed')
      AND EXISTS(SELECT 1 FROM line_result_outbox WHERE result_key=? AND json_extract(result_json,'$.outcome')='unconfirmed')`)
    .bind(clock.now().toISOString(),runId,generation,notificationCycle,key).run();
  if(updated.meta.changes===1)return 'advanced';
  const current=await readPublicationJob(db,runId);
  return current?.generation===generation && current.notificationCycle===notificationCycle ? 'not_needed':'contended';
}

export async function admitPublicationGoogleCopy(db: D1Database, runId: string, generation: number, notificationCycle: number, workflowId: string): Promise<boolean> {
  const owner = await db.prepare(`UPDATE publication_jobs SET updated_at=updated_at
    WHERE publication_run_id=? AND generation=? AND notification_cycle=? AND correlation_id=? AND state NOT IN ('succeeded','failed','validation_failed')`).bind(runId, generation, notificationCycle, workflowId).run();
  if (!owner.meta.changes) return false;
  const result = await db.prepare(`UPDATE publication_google_write_evidence SET state='may_have_written'
    WHERE publication_run_id=? AND generation=? AND notification_cycle=? AND EXISTS
    (SELECT 1 FROM publication_jobs WHERE publication_run_id=? AND generation=? AND notification_cycle=? AND correlation_id=? AND state NOT IN ('succeeded','failed','validation_failed'))`).bind(runId, generation, notificationCycle, runId, generation, notificationCycle, workflowId).run();
  if (result.meta.changes) return true;
  const legacy = await db.prepare(`SELECT 1 FROM publication_jobs WHERE publication_run_id=? AND generation=? AND notification_cycle=? AND correlation_id=? AND state NOT IN ('succeeded','failed','validation_failed') AND NOT EXISTS (SELECT 1 FROM publication_google_write_evidence WHERE publication_run_id=? AND generation=? AND notification_cycle=?)`).bind(runId, generation, notificationCycle, workflowId, runId, generation, notificationCycle).first();
  return !!legacy;
}

export async function claimPublicationVerification(
  db: D1Database,
  attempt: { runId: string; generation: number; notificationCycle: number; groupId: string },
  observation?: { verifierId: string; status: "active" | "terminal" | "absent" | "unavailable" | "interrupted" },
): Promise<{ status: "held" } | { status: "claimed"; verifierId: string; originWorkflowId: string; contextJson: string }> {
  if (observation) {
    if (observation.status !== "interrupted" && observation.status !== "absent") return { status: "held" };
    const verifierId = `publication-verify-${crypto.randomUUID()}`;
    const row = await db.prepare(`UPDATE publication_verification_claims SET verifier_id=?
      WHERE publication_run_id=? AND generation=? AND notification_cycle=? AND group_id=? AND verifier_id=? AND completed=0
        AND EXISTS (SELECT 1 FROM publication_jobs WHERE publication_run_id=? AND generation=? AND notification_cycle=?
          AND json_extract(settings_context_json, '$.replyGroupId')=?)
      RETURNING origin_workflow_id, context_json`)
      .bind(verifierId, attempt.runId, attempt.generation, attempt.notificationCycle, attempt.groupId, observation.verifierId,
        attempt.runId, attempt.generation, attempt.notificationCycle, attempt.groupId)
      .first<{ origin_workflow_id: string; context_json: string }>();
    return row ? { status: "claimed", verifierId, originWorkflowId: row.origin_workflow_id, contextJson: row.context_json } : { status: "held" };
  }
  const key = JSON.stringify([attempt.runId, attempt.generation, attempt.notificationCycle]);
  const verifierId = `publication-verify-${await sha256Hex(new TextEncoder().encode(key))}`;
  const row = await db.prepare(`INSERT INTO publication_verification_claims
    (publication_run_id, generation, notification_cycle, group_id, origin_workflow_id, context_json, verifier_id)
    SELECT publication_run_id, generation, notification_cycle, ?, correlation_id, settings_context_json, ?
    FROM publication_jobs WHERE publication_run_id = ? AND generation = ? AND notification_cycle = ?
      AND json_extract(settings_context_json, '$.replyGroupId') = ?
    ON CONFLICT(publication_run_id, generation, notification_cycle) DO NOTHING
    RETURNING origin_workflow_id, context_json`)
    .bind(attempt.groupId, verifierId, attempt.runId, attempt.generation, attempt.notificationCycle, attempt.groupId)
    .first<{ origin_workflow_id: string; context_json: string }>();
  return row ? { status: "claimed", verifierId, originWorkflowId: row.origin_workflow_id, contextJson: row.context_json } : { status: "held" };
}

export async function completePublicationVerification(
  db: D1Database,
  attempt: { runId: string; generation: number; notificationCycle: number; groupId: string },
  verifierId: string,
  intent?: { originWorkflowId: string; contextJson: string; result: TerminalResultV1 },
): Promise<boolean> {
  if (intent) {
    const value = intent.result;
    validateReplyMessages(value.messages);
    if (typeof intent.originWorkflowId !== 'string' || !intent.originWorkflowId.trim() || typeof intent.contextJson !== 'string' ||
      value.schemaVersion !== 1 || value.kind !== 'publication' || value.runId !== attempt.runId ||
      value.generation !== attempt.generation || value.notificationCycle !== attempt.notificationCycle ||
      !['success', 'partial', 'validation_failed', 'failed', 'unconfirmed'].includes(value.outcome)) throw new Error('verification_invalid_result');
  }
  const result = await db.prepare(`UPDATE publication_verification_claims SET completed=1, result_json=?
    WHERE publication_run_id=? AND generation=? AND notification_cycle=? AND group_id=? AND verifier_id=? AND completed=0
      AND EXISTS (SELECT 1 FROM publication_jobs WHERE publication_run_id=? AND generation=? AND notification_cycle=?
        AND json_extract(settings_context_json, '$.replyGroupId')=?
        AND (? IS NULL OR (correlation_id=? AND settings_context_json=?)))
      AND result_json IS NULL AND (? IS NULL OR (origin_workflow_id=? AND context_json=?))`)
    .bind(intent ? JSON.stringify(intent.result) : null, attempt.runId, attempt.generation, attempt.notificationCycle, attempt.groupId, verifierId,
      attempt.runId, attempt.generation, attempt.notificationCycle, attempt.groupId,
      intent?.originWorkflowId ?? null, intent?.originWorkflowId ?? null, intent?.contextJson ?? null,
      intent?.originWorkflowId ?? null, intent?.originWorkflowId ?? null, intent?.contextJson ?? null).run();
  return result.meta.changes === 1;
}
