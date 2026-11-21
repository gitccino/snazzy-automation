import { FinalizationIntentSchema } from "../publication/finalization-intent";
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
        AND NOT EXISTS (SELECT 1 FROM publication_verification_claims c WHERE c.publication_run_id = publication_jobs.publication_run_id AND c.generation = publication_jobs.generation AND c.notification_cycle = publication_jobs.notification_cycle AND c.completed = 0)
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
      db.prepare(`INSERT INTO publication_google_write_evidence (publication_run_id, generation, notification_cycle, state, protocol_version)
        SELECT publication_run_id, generation, notification_cycle, 'tracking', 1
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
        AND NOT EXISTS (SELECT 1 FROM publication_verification_claims c WHERE c.publication_run_id = publication_jobs.publication_run_id AND c.generation = publication_jobs.generation AND c.notification_cycle = publication_jobs.notification_cycle AND c.completed = 0)
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
        AND NOT EXISTS (SELECT 1 FROM publication_verification_claims c WHERE c.publication_run_id = publication_jobs.publication_run_id AND c.generation = publication_jobs.generation AND c.notification_cycle = publication_jobs.notification_cycle AND c.completed = 0)
        AND NOT EXISTS (SELECT 1 FROM publication_regeneration_events WHERE event_id = ?)
        AND EXISTS (SELECT 1 FROM line_command_ingress WHERE event_id = ? AND group_id = ? AND json_extract(operation, '$.type') = 'docs' AND json_extract(operation, '$.publicationDate') IS ?)`)
        .bind(context ? serializeContext(context) : null, correlationId, clock.now().toISOString(), publicationRunId, context ? 1 : 0, generation, notificationCycle, event.id, event.id, event.groupId, event.publicationDate ?? null),
      db.prepare(`INSERT INTO publication_regeneration_events (event_id, publication_run_id, generation, notification_cycle, workflow_id, action, job_json, group_id, ingress_operation)
        SELECT ?, j.publication_run_id, j.generation, j.notification_cycle, j.correlation_id, ?, '{}', i.group_id, i.operation
        FROM publication_jobs j JOIN line_command_ingress i ON i.event_id = ? WHERE j.publication_run_id = ? AND changes() = 1`)
        .bind(event.id, event.action, event.id, publicationRunId),
      db.prepare(`INSERT INTO publication_google_write_evidence (publication_run_id, generation, notification_cycle, state, protocol_version)
        SELECT publication_run_id, generation, notification_cycle, 'tracking', 1
        FROM publication_regeneration_events WHERE event_id = ? AND changes() = 1`)
        .bind(event.id),
    ]);
    return results[1]?.meta.changes === 1;
  }
  const result = await db
    .prepare(
      `UPDATE publication_jobs SET settings_context_json = CASE WHEN temp_doc_id IS NULL AND finalization_json IS NULL THEN COALESCE(?, settings_context_json) ELSE settings_context_json END, notification_cycle = notification_cycle + 1, state = 'locked', correlation_id = ?, updated_at = ?
       WHERE publication_run_id = ? AND (state = 'failed' OR (state = 'validation_failed' AND ? = 1)) AND generation = ? AND notification_cycle = ?
       AND NOT EXISTS (SELECT 1 FROM publication_verification_claims c WHERE c.publication_run_id = publication_jobs.publication_run_id AND c.generation = publication_jobs.generation AND c.notification_cycle = publication_jobs.notification_cycle AND c.completed = 0)`,
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
      AND NOT EXISTS (SELECT 1 FROM publication_verification_claims c WHERE c.publication_run_id = publication_jobs.publication_run_id AND c.generation = publication_jobs.generation AND c.notification_cycle = publication_jobs.notification_cycle AND c.completed = 0)
      AND EXISTS(SELECT 1 FROM line_result_outbox WHERE result_key=? AND json_extract(result_json,'$.outcome')='unconfirmed')`)
    .bind(clock.now().toISOString(),runId,generation,notificationCycle,key).run();
  if(updated.meta.changes===1)return 'advanced';
  const held=await db.prepare(`SELECT 1 FROM publication_verification_claims WHERE publication_run_id=? AND generation=? AND notification_cycle=? AND completed=0`).bind(runId,generation,notificationCycle).first();
  if(held)return 'contended';
  const unconfirmed=await db.prepare("SELECT 1 FROM line_result_outbox WHERE result_key=? AND json_extract(result_json,'$.outcome')='unconfirmed'").bind(key).first();
  if(unconfirmed)return 'contended';
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
          AND json_extract(settings_context_json, '$.replyGroupId')=?
          AND correlation_id=publication_verification_claims.origin_workflow_id
          AND settings_context_json=publication_verification_claims.context_json)
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

export async function readPreGoogleFailure(
  db: D1Database,
  attempt: { runId: string; generation: number; notificationCycle: number; groupId: string },
  verifierId: string,
): Promise<{ origin_workflow_id: string; context_json: string; stage: string; failure_code: string } | null> {
  return await db.prepare(`SELECT c.origin_workflow_id, c.context_json, f.stage, f.failure_code
    FROM publication_verification_claims c
    JOIN publication_jobs j ON j.publication_run_id=c.publication_run_id AND j.generation=c.generation
      AND j.notification_cycle=c.notification_cycle AND j.correlation_id=c.origin_workflow_id AND j.settings_context_json=c.context_json
    JOIN publication_google_write_evidence e ON e.publication_run_id=c.publication_run_id AND e.generation=c.generation AND e.notification_cycle=c.notification_cycle
    JOIN workflow_feedback f ON f.kind='publication' AND f.run_id=c.publication_run_id AND f.generation=c.generation
      AND f.notification_cycle=c.notification_cycle AND f.group_id=c.group_id AND f.context_json=c.context_json
    JOIN workflow_feedback_results r ON r.kind=f.kind AND r.run_id=f.run_id AND r.generation=f.generation
      AND r.notification_cycle=f.notification_cycle AND r.group_id=f.group_id AND r.revision=0
    WHERE c.publication_run_id=? AND c.generation=? AND c.notification_cycle=? AND c.group_id=? AND c.verifier_id=? AND c.completed=0
      AND json_extract(c.context_json,'$.replyGroupId')=c.group_id
      AND length(json_extract(c.context_json,'$.settings.config.airtableBaseId'))>0
      AND length(json_extract(c.context_json,'$.settings.config.airtablePublicationRunsTableId'))>0
      AND e.protocol_version=1 AND e.state='tracking'
      AND j.state IN ('locked','validating','generating','failed') AND j.temp_doc_id IS NULL AND j.finalization_json IS NULL
      AND j.google_doc_id IS NULL AND j.google_doc_url IS NULL AND j.successful_generation=0
      AND f.stage IN ('prepare product images','prepare outputs') AND length(f.failure_code)>0
      AND json_extract(r.outcome_json,'$.stage')=f.stage AND json_extract(r.outcome_json,'$.failureCode')=f.failure_code
      AND json_extract(r.outcome_json,'$.outcome')='unconfirmed'`)
    .bind(attempt.runId, attempt.generation, attempt.notificationCycle, attempt.groupId, verifierId)
    .first<{ origin_workflow_id: string; context_json: string; stage: string; failure_code: string }>();
}

export async function readFinalizationCandidate(
  db: D1Database,
  attempt: { runId: string; generation: number; notificationCycle: number; groupId: string },
  verifierId: string,
): Promise<{ origin_workflow_id: string; context_json: string; intent: PublicationFinalizationIntent; finalizationJson: string; googleDocId: string | null } | null> {
  const row = await db.prepare(`SELECT c.origin_workflow_id, c.context_json, j.finalization_json, j.google_doc_id
    FROM publication_verification_claims c
    JOIN publication_jobs j ON j.publication_run_id=c.publication_run_id AND j.generation=c.generation
      AND j.notification_cycle=c.notification_cycle AND j.correlation_id=c.origin_workflow_id AND j.settings_context_json=c.context_json
    WHERE c.publication_run_id=? AND c.generation=? AND c.notification_cycle=? AND c.group_id=? AND c.verifier_id=? AND c.completed=0
      AND json_extract(c.context_json,'$.replyGroupId')=c.group_id
      AND length(json_extract(c.context_json,'$.settings.config.airtableBaseId'))>0
      AND length(json_extract(c.context_json,'$.settings.config.airtablePublicationRunsTableId'))>0
      AND length(json_extract(c.context_json,'$.settings.config.googleDriveFolderId'))>0
      AND length(json_extract(c.context_json,'$.settings.config.googleTemplateDocId'))>0
      AND j.finalization_json IS NOT NULL`)
    .bind(attempt.runId, attempt.generation, attempt.notificationCycle, attempt.groupId, verifierId)
    .first<{origin_workflow_id:string; context_json:string; finalization_json:string; google_doc_id:string | null}>();
  if (!row) return null;
  try {
    const intent = FinalizationIntentSchema.parse(JSON.parse(row.finalization_json));
    return intent.generation === attempt.generation && intent.docId !== row.google_doc_id ? {origin_workflow_id:row.origin_workflow_id, context_json:row.context_json, intent, finalizationJson:row.finalization_json, googleDocId:row.google_doc_id} : null;
  } catch { return null; }
}

export async function completePublicationVerification(
  db: D1Database,
  attempt: { runId: string; generation: number; notificationCycle: number; groupId: string },
  verifierId: string,
  intent?: { originWorkflowId: string; contextJson: string; result: TerminalResultV1; candidate?: { finalizationJson: string; googleDocId: string | null } },
): Promise<boolean> {
  if (intent) {
    const value = intent.result;
    validateReplyMessages(value.messages);
    if (typeof intent.originWorkflowId !== 'string' || !intent.originWorkflowId.trim() || typeof intent.contextJson !== 'string' ||
      value.schemaVersion !== 1 || value.kind !== 'publication' || value.runId !== attempt.runId ||
      value.generation !== attempt.generation || value.notificationCycle !== attempt.notificationCycle ||
      !['success', 'partial', 'validation_failed', 'failed', 'unconfirmed'].includes(value.outcome)) throw new Error('verification_invalid_result');
  }
  const update = db.prepare(`UPDATE publication_verification_claims SET completed=1, result_json=?
    WHERE publication_run_id=? AND generation=? AND notification_cycle=? AND group_id=? AND verifier_id=? AND completed=0
      AND EXISTS (SELECT 1 FROM publication_jobs WHERE publication_run_id=? AND generation=? AND notification_cycle=?
        AND json_extract(settings_context_json, '$.replyGroupId')=?
        AND (? IS NULL OR (correlation_id=? AND settings_context_json=?)))
      AND result_json IS NULL AND (? IS NULL OR (origin_workflow_id=? AND context_json=?))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM publication_jobs j WHERE j.publication_run_id=publication_verification_claims.publication_run_id
        AND j.generation=publication_verification_claims.generation AND j.notification_cycle=publication_verification_claims.notification_cycle
        AND j.finalization_json=? AND j.google_doc_id IS ?))
      AND (COALESCE(?, '') != 'failed' OR EXISTS (SELECT 1 FROM publication_jobs j
        JOIN publication_google_write_evidence e ON e.publication_run_id=j.publication_run_id AND e.generation=j.generation AND e.notification_cycle=j.notification_cycle
        JOIN workflow_feedback f ON f.kind='publication' AND f.run_id=j.publication_run_id AND f.generation=j.generation AND f.notification_cycle=j.notification_cycle AND f.group_id=publication_verification_claims.group_id AND f.context_json=j.settings_context_json
        JOIN workflow_feedback_results r ON r.kind=f.kind AND r.run_id=f.run_id AND r.generation=f.generation AND r.notification_cycle=f.notification_cycle AND r.group_id=f.group_id AND r.revision=0
        WHERE j.publication_run_id=publication_verification_claims.publication_run_id AND j.generation=publication_verification_claims.generation AND j.notification_cycle=publication_verification_claims.notification_cycle
        AND j.state IN ('locked','validating','generating','failed') AND j.temp_doc_id IS NULL AND j.finalization_json IS NULL AND j.google_doc_id IS NULL AND j.google_doc_url IS NULL AND j.successful_generation=0
        AND e.protocol_version=1 AND e.state='tracking' AND f.stage IN ('prepare product images','prepare outputs') AND length(f.failure_code)>0
        AND json_extract(r.outcome_json,'$.stage')=f.stage AND json_extract(r.outcome_json,'$.failureCode')=f.failure_code AND json_extract(r.outcome_json,'$.outcome')='unconfirmed'))`)
    .bind(intent ? JSON.stringify(intent.result) : null, attempt.runId, attempt.generation, attempt.notificationCycle, attempt.groupId, verifierId,
      attempt.runId, attempt.generation, attempt.notificationCycle, attempt.groupId,
      intent?.originWorkflowId ?? null, intent?.originWorkflowId ?? null, intent?.contextJson ?? null,
      intent?.originWorkflowId ?? null, intent?.originWorkflowId ?? null, intent?.contextJson ?? null,
      intent?.candidate?.finalizationJson ?? null, intent?.candidate?.finalizationJson ?? null, intent?.candidate?.googleDocId ?? null, intent?.result.outcome ?? null);
  if (!intent) return (await update.run()).meta.changes === 1;
  const key = JSON.stringify(['publication', attempt.runId, attempt.generation, attempt.notificationCycle, 'verification']);
  const revision = db.prepare(`INSERT INTO workflow_feedback_results(kind,run_id,generation,notification_cycle,revision,result_key,outcome_json,group_id)
    SELECT f.kind,f.run_id,f.generation,f.notification_cycle,f.revision+1,(SELECT result_key FROM workflow_feedback_results WHERE kind=f.kind AND run_id=f.run_id AND generation=f.generation AND notification_cycle=f.notification_cycle AND revision=0) || ':revision:' || (f.revision+1),
      json_object('action','verified','outcome',json_extract(c.result_json,'$.outcome'),'result',json(c.result_json)),f.group_id
    FROM publication_verification_claims c JOIN workflow_feedback_results f ON f.kind='publication' AND f.run_id=c.publication_run_id
      AND f.generation=c.generation AND f.notification_cycle=c.notification_cycle AND f.group_id=c.group_id
    WHERE c.publication_run_id=? AND c.generation=? AND c.notification_cycle=? AND c.verifier_id=? AND changes()=1
      AND f.revision=(SELECT MAX(revision) FROM workflow_feedback_results WHERE kind=f.kind AND run_id=f.run_id AND generation=f.generation AND notification_cycle=f.notification_cycle)
      AND NOT (json_extract(f.outcome_json,'$.outcome')='unconfirmed' AND json_extract(f.outcome_json,'$.action')='verify' AND json_extract(c.result_json,'$.outcome')='unconfirmed')
      `)
    .bind(attempt.runId, attempt.generation, attempt.notificationCycle, verifierId);
  const [result] = await db.batch([update, revision, db.prepare(`INSERT INTO line_result_outbox(result_key,group_id,result_json,created_at)
    SELECT ?, group_id, result_json, ? FROM publication_verification_claims c
    WHERE publication_run_id=? AND generation=? AND notification_cycle=? AND verifier_id=? AND completed=1
      AND NOT EXISTS (SELECT 1 FROM workflow_feedback_results f WHERE f.kind='publication' AND f.run_id=c.publication_run_id
        AND f.generation=c.generation AND f.notification_cycle=c.notification_cycle AND f.group_id=c.group_id)
    ON CONFLICT(result_key) DO NOTHING`)
    .bind(key, new Date().toISOString(), attempt.runId, attempt.generation, attempt.notificationCycle, verifierId)]);
  return result!.meta.changes === 1;
}

export async function admitPublicationCleanup(db: D1Database, runId: string, generation: number, notificationCycle: number, workflowId: string, docId: string): Promise<boolean> {
  const row = await db.prepare(`INSERT INTO publication_cleanup_intents (publication_run_id, generation, notification_cycle, origin_workflow_id, context_json, doc_id, saved_temp_doc)
    SELECT publication_run_id, generation, notification_cycle, correlation_id, settings_context_json, ?, CASE WHEN temp_doc_id = ? THEN 1 ELSE NULL END FROM publication_jobs
    WHERE publication_run_id=? AND generation=? AND notification_cycle=? AND correlation_id=?
      AND state NOT IN ('succeeded','failed','validation_failed') AND finalization_json IS NULL AND google_doc_id IS NOT ?
    ON CONFLICT(publication_run_id, generation, notification_cycle) DO UPDATE SET doc_id=excluded.doc_id
    WHERE publication_cleanup_intents.doc_id=excluded.doc_id AND publication_cleanup_intents.origin_workflow_id=excluded.origin_workflow_id
      AND publication_cleanup_intents.context_json IS excluded.context_json
    RETURNING doc_id`).bind(docId, docId, runId, generation, notificationCycle, workflowId, docId).first();
  return !!row;
}

export async function readPublicationCleanupCandidate(
  db: D1Database,
  attempt: {runId: string; generation: number; notificationCycle: number; groupId: string},
  verifierId: string,
  requireSavedTempDoc = true,
): Promise<{origin_workflow_id: string; context_json: string; doc_id: string; folder_id: string} | null> {
  return db.prepare(`SELECT c.origin_workflow_id, c.context_json, i.doc_id,
      json_extract(c.context_json,'$.settings.config.googleDriveFolderId') AS folder_id
    FROM publication_cleanup_intents i
    JOIN publication_verification_claims c ON c.publication_run_id=i.publication_run_id AND c.generation=i.generation
      AND c.notification_cycle=i.notification_cycle AND c.origin_workflow_id=i.origin_workflow_id AND c.context_json=i.context_json
    JOIN publication_jobs j ON j.publication_run_id=c.publication_run_id AND j.generation=c.generation
      AND j.notification_cycle=c.notification_cycle AND j.correlation_id=c.origin_workflow_id AND j.settings_context_json=c.context_json
    WHERE c.publication_run_id=? AND c.generation=? AND c.notification_cycle=? AND c.group_id=? AND c.verifier_id=? AND c.completed=0
      AND json_valid(c.context_json) AND json_extract(c.context_json,'$.replyGroupId')=c.group_id
      AND length(json_extract(c.context_json,'$.settings.config.googleDriveFolderId'))>0 AND length(i.doc_id)>0
      AND j.state IN ('locked','validating','generating','failed') AND j.finalization_json IS NULL
      AND j.google_doc_id IS NOT i.doc_id AND j.successful_generation=0 AND (? = 0 OR i.saved_temp_doc = 1)`)
    .bind(attempt.runId,attempt.generation,attempt.notificationCycle,attempt.groupId,verifierId,requireSavedTempDoc ? 1 : 0)
    .first<{origin_workflow_id:string; context_json:string; doc_id:string; folder_id:string}>();
}

export async function readPublicationCleanupReceipt(
  db: D1Database,
  attempt: {runId: string; generation: number; notificationCycle: number; groupId: string},
  verifierId: string,
): Promise<{origin_workflow_id: string; context_json: string; doc_id: string} | null> {
  return db.prepare(`SELECT c.origin_workflow_id, c.context_json, i.doc_id
    FROM publication_cleanup_intents i
    JOIN publication_verification_claims c ON c.publication_run_id=i.publication_run_id AND c.generation=i.generation
      AND c.notification_cycle=i.notification_cycle AND c.origin_workflow_id=i.origin_workflow_id AND c.context_json=i.context_json
    JOIN publication_jobs j ON j.publication_run_id=c.publication_run_id AND j.generation=c.generation
      AND j.notification_cycle=c.notification_cycle AND j.correlation_id=c.origin_workflow_id AND j.settings_context_json=c.context_json
    WHERE c.publication_run_id=? AND c.generation=? AND c.notification_cycle=? AND c.group_id=? AND c.verifier_id=? AND c.completed=0
      AND json_valid(c.context_json) AND json_extract(c.context_json,'$.replyGroupId')=c.group_id
      AND length(i.doc_id)>0 AND i.saved_temp_doc=1 AND length(i.dispatch_verifier_id)>0 AND i.deletion_acknowledged=1
      AND j.state IN ('locked','validating','generating','failed') AND j.finalization_json IS NULL
      AND j.google_doc_id IS NOT i.doc_id AND j.successful_generation=0`)
    .bind(attempt.runId,attempt.generation,attempt.notificationCycle,attempt.groupId,verifierId)
    .first<{origin_workflow_id:string; context_json:string; doc_id:string}>();
}

export async function claimPublicationCleanupDispatch(
  db: D1Database,
  attempt: {runId: string; generation: number; notificationCycle: number; groupId: string},
  verifierId: string,
  docId: string,
): Promise<boolean> {
  const row = await db.prepare(`UPDATE publication_cleanup_intents AS i SET dispatch_verifier_id=?
    WHERE i.publication_run_id=? AND i.generation=? AND i.notification_cycle=?
      AND i.doc_id=? AND i.dispatch_verifier_id IS NULL AND i.saved_temp_doc=1 AND length(i.doc_id)>0
      AND EXISTS (SELECT 1 FROM publication_verification_claims c
        JOIN publication_jobs j ON j.publication_run_id=c.publication_run_id AND j.generation=c.generation
          AND j.notification_cycle=c.notification_cycle AND j.correlation_id=c.origin_workflow_id AND j.settings_context_json=c.context_json
        WHERE c.publication_run_id=i.publication_run_id AND c.generation=i.generation AND c.notification_cycle=i.notification_cycle
          AND c.origin_workflow_id=i.origin_workflow_id AND c.context_json=i.context_json
          AND c.group_id=? AND c.verifier_id=? AND c.completed=0
          AND json_valid(c.context_json) AND json_extract(c.context_json,'$.replyGroupId')=c.group_id
          AND length(json_extract(c.context_json,'$.settings.config.googleDriveFolderId'))>0
          AND j.state IN ('locked','validating','generating','failed') AND j.finalization_json IS NULL
          AND j.google_doc_id IS NOT i.doc_id AND j.successful_generation=0)
    RETURNING dispatch_verifier_id`).bind(verifierId,attempt.runId,attempt.generation,attempt.notificationCycle,docId,attempt.groupId,verifierId).first();
  return !!row;
}

export async function recordPublicationCleanupReceipt(
  db: D1Database,
  receipt: {runId: string; generation: number; notificationCycle: number; groupId: string; verifierId: string; docId: string; acknowledged: boolean},
): Promise<boolean> {
  if (receipt.acknowledged !== true) return false;
  const row = await db.prepare(`UPDATE publication_cleanup_intents AS i SET deletion_acknowledged=1
    WHERE i.publication_run_id=? AND i.generation=? AND i.notification_cycle=? AND i.doc_id=? AND i.dispatch_verifier_id=?
      AND EXISTS (SELECT 1 FROM publication_verification_claims c WHERE c.publication_run_id=i.publication_run_id
        AND c.generation=i.generation AND c.notification_cycle=i.notification_cycle AND c.group_id=?
        AND c.origin_workflow_id=i.origin_workflow_id AND c.context_json IS i.context_json)
    RETURNING deletion_acknowledged`)
    .bind(receipt.runId,receipt.generation,receipt.notificationCycle,receipt.docId,receipt.verifierId,receipt.groupId).first();
  return !!row;
}
