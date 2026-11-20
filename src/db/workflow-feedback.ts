import { lineCommandWorkflowId } from '../line/mutation-recovery';

export type FeedbackAttempt = { kind: 'import' | 'publication'; runId: string; generation: number; notificationCycle: number; groupId: string };
export type TrustedEarlyFailure = { eventId: string; context: string };
export type FeedbackStage = { stage: string; failureCode?: string | null; references?: Record<string, unknown>; repair?: Record<string, unknown>; eventId?: string | null };
export type FeedbackOutcome = FeedbackStage & { action: string; resultKey: string; outcome?: string };

export function createWorkflowFeedbackRepository(db: D1Database) {
  async function lookupTrustedEarlyFailure(a: FeedbackAttempt, eventId: string): Promise<TrustedEarlyFailure | null> {
    const workflowId = await lineCommandWorkflowId(eventId);
    const statement = a.kind === 'import'
      ? db.prepare(`SELECT i.event_id AS eventId, r.settings_context_json AS context FROM line_command_ingress i JOIN import_runs r ON r.id=i.workflow_id
          WHERE i.event_id=? AND i.group_id=? AND i.workflow_id=? AND r.id=? AND ?=1 AND ?=1 AND r.trigger='line'
          AND json_extract(i.operation,'$.type')='upload' AND json_extract(r.settings_context_json,'$.replyGroupId')=i.group_id`)
      : db.prepare(`SELECT i.event_id AS eventId, j.settings_context_json AS context FROM line_command_ingress i
          JOIN publication_regeneration_events e ON e.event_id=i.event_id JOIN publication_jobs j ON j.publication_run_id=e.publication_run_id
          WHERE i.event_id=? AND i.group_id=? AND i.workflow_id=? AND j.publication_run_id=? AND e.generation=? AND e.notification_cycle=?
          AND j.generation=e.generation AND j.notification_cycle=e.notification_cycle AND j.correlation_id=e.workflow_id
          AND e.group_id=i.group_id AND e.ingress_operation=i.operation AND json_extract(i.operation,'$.type')='docs'
          AND json_extract(j.settings_context_json,'$.replyGroupId')=i.group_id`);
    return await statement.bind(eventId,a.groupId,workflowId,a.runId,a.generation,a.notificationCycle).first<TrustedEarlyFailure>();
  }
  const owner = (a: FeedbackAttempt) => a.kind === 'publication'
    ? db.prepare(`SELECT settings_context_json AS context FROM publication_jobs WHERE publication_run_id=? AND generation=? AND notification_cycle=? AND json_extract(settings_context_json,'$.replyGroupId')=?`).bind(a.runId, a.generation, a.notificationCycle, a.groupId)
    : db.prepare(`SELECT settings_context_json AS context FROM import_runs WHERE id=? AND ?=1 AND ?=1 AND json_extract(settings_context_json,'$.replyGroupId')=?`).bind(a.runId, a.generation, a.notificationCycle, a.groupId);
  const guard = `((?='publication' AND EXISTS (SELECT 1 FROM publication_jobs WHERE publication_run_id=? AND generation=? AND notification_cycle=? AND json_extract(settings_context_json,'$.replyGroupId')=?)) OR (?='import' AND ?=1 AND ?=1 AND EXISTS (SELECT 1 FROM import_runs WHERE id=? AND json_extract(settings_context_json,'$.replyGroupId')=?)))`;
  const guardArgs = (a: FeedbackAttempt) => [a.kind,a.runId,a.generation,a.notificationCycle,a.groupId,a.kind,a.generation,a.notificationCycle,a.runId,a.groupId];
  async function stageStatement(a: FeedbackAttempt, stage: FeedbackStage) {
    const context = await owner(a).first<{context: string}>();
    if (!context) return null;
    return db.prepare(`INSERT INTO workflow_feedback(kind,run_id,generation,notification_cycle,group_id,context_json,event_id,stage,failure_code,references_json,repair_json)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}
      ON CONFLICT(kind,run_id,generation,notification_cycle) DO UPDATE SET stage=excluded.stage, failure_code=COALESCE(workflow_feedback.failure_code,excluded.failure_code), references_json=excluded.references_json, repair_json=excluded.repair_json
      WHERE workflow_feedback.group_id=excluded.group_id AND workflow_feedback.context_json=excluded.context_json AND workflow_feedback.event_id IS excluded.event_id`)
      .bind(a.kind,a.runId,a.generation,a.notificationCycle,a.groupId,context.context,stage.eventId ?? null,stage.stage,stage.failureCode ?? null,JSON.stringify(stage.references ?? {}),JSON.stringify(stage.repair ?? {}),...guardArgs(a));
  }
  async function recordStage(a: FeedbackAttempt, stage: FeedbackStage): Promise<boolean> {
    const statement = await stageStatement(a, stage);
    return statement ? ((await statement.run()).meta.changes ?? 0) > 0 : false;
  }
  async function commitOutcome(a: FeedbackAttempt, outcome: FeedbackOutcome): Promise<boolean> {
    const stage = await stageStatement(a, outcome);
    if (!stage) return false;
    const json = JSON.stringify(outcome);
    const notice = db.prepare(`INSERT INTO workflow_feedback_results(kind,run_id,generation,notification_cycle,revision,result_key,outcome_json,group_id)
      SELECT ?,?,?,?, COALESCE((SELECT MAX(revision)+1 FROM workflow_feedback_results WHERE kind=? AND run_id=? AND generation=? AND notification_cycle=?),0),
      CASE WHEN NOT EXISTS(SELECT 1 FROM workflow_feedback_results WHERE kind=? AND run_id=? AND generation=? AND notification_cycle=?) THEN ? ELSE ? || ':revision:' || (SELECT MAX(revision)+1 FROM workflow_feedback_results WHERE kind=? AND run_id=? AND generation=? AND notification_cycle=?) END, ?,?
      WHERE ${guard} AND changes() > 0 AND EXISTS(SELECT 1 FROM workflow_feedback WHERE kind=? AND run_id=? AND generation=? AND notification_cycle=? AND group_id=?)
      AND NOT EXISTS(SELECT 1 FROM workflow_feedback_results WHERE kind=? AND run_id=? AND generation=? AND notification_cycle=? AND revision=(SELECT MAX(revision) FROM workflow_feedback_results WHERE kind=? AND run_id=? AND generation=? AND notification_cycle=?) AND json_extract(outcome_json,'$.action')=? AND json_extract(outcome_json,'$.outcome') IS ?)`)
      .bind(a.kind,a.runId,a.generation,a.notificationCycle, a.kind,a.runId,a.generation,a.notificationCycle, a.kind,a.runId,a.generation,a.notificationCycle,outcome.resultKey,outcome.resultKey,a.kind,a.runId,a.generation,a.notificationCycle,json,a.groupId,...guardArgs(a),a.kind,a.runId,a.generation,a.notificationCycle,a.groupId,a.kind,a.runId,a.generation,a.notificationCycle,a.kind,a.runId,a.generation,a.notificationCycle,outcome.action,outcome.outcome ?? null);
    const [stageResult, result] = await db.batch([stage, notice]);
    if (!(stageResult!.meta.changes ?? 0)) return false;
    if ((result!.meta.changes ?? 0) > 0) return true;
    const existing = await db.prepare(`SELECT 1 FROM workflow_feedback_results WHERE kind=? AND run_id=? AND generation=? AND notification_cycle=? AND group_id=? AND json_extract(outcome_json,'$.action')=? AND json_extract(outcome_json,'$.outcome') IS ? AND revision=(SELECT MAX(revision) FROM workflow_feedback_results WHERE kind=? AND run_id=? AND generation=? AND notification_cycle=?) AND ${guard}`).bind(a.kind,a.runId,a.generation,a.notificationCycle,a.groupId,outcome.action,outcome.outcome ?? null,a.kind,a.runId,a.generation,a.notificationCycle,...guardArgs(a)).first();
    return !!existing;
  }
  const evidenceGuard = `EXISTS(SELECT 1 FROM workflow_feedback WHERE kind=? AND run_id=? AND generation=? AND notification_cycle=? AND group_id=? AND event_id IS ? AND ((kind='publication' AND context_json=(SELECT settings_context_json FROM publication_jobs WHERE publication_run_id=?)) OR (kind='import' AND context_json=(SELECT settings_context_json FROM import_runs WHERE id=?))))`;
  const evidenceArgs = (a: FeedbackAttempt, eventId: string | null) => [a.kind,a.runId,a.generation,a.notificationCycle,a.groupId,eventId,a.runId,a.runId];
  async function upsertEvidence(a: FeedbackAttempt, eventId: string | null, key: string, value: unknown): Promise<boolean> {
    const result = await db.prepare(`INSERT INTO workflow_feedback_group_evidence(kind,run_id,generation,notification_cycle,evidence_key,evidence_json)
      SELECT ?,?,?,?,?,? WHERE ${guard} AND ${evidenceGuard}
      ON CONFLICT(kind,run_id,generation,notification_cycle,evidence_key) DO UPDATE SET evidence_json=excluded.evidence_json`)
      .bind(a.kind,a.runId,a.generation,a.notificationCycle,key,JSON.stringify(value),...guardArgs(a),...evidenceArgs(a,eventId)).run();
    return (result.meta.changes ?? 0) > 0;
  }
  async function readEvidence(a: FeedbackAttempt, eventId: string | null, key: string): Promise<unknown | null> {
    const row = await db.prepare(`SELECT evidence_json FROM workflow_feedback_group_evidence WHERE kind=? AND run_id=? AND generation=? AND notification_cycle=? AND evidence_key=? AND ${guard} AND ${evidenceGuard}`)
      .bind(a.kind,a.runId,a.generation,a.notificationCycle,key,...guardArgs(a),...evidenceArgs(a,eventId)).first<{evidence_json: string}>();
    return row ? JSON.parse(row.evidence_json) : null;
  }
  async function pendingByGroup(groupId: string, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_limit');
    return (await db.prepare('SELECT * FROM workflow_feedback_results WHERE group_id=? AND materialized=0 ORDER BY rowid LIMIT ?').bind(groupId,limit).all()).results;
  }
  async function publicationHead(groupId: string) {
    return db.prepare(`SELECT o.sequence,o.result_json,f.run_id,f.generation,f.notification_cycle,f.result_key,f.outcome_json
      FROM line_result_outbox o JOIN workflow_feedback_results f ON f.result_key=o.result_key AND f.group_id=o.group_id
      WHERE o.group_id=? AND o.sequence=(SELECT MIN(sequence) FROM line_result_outbox WHERE group_id=? AND state!='accepted' AND NOT EXISTS(SELECT 1 FROM line_reply_owner_dispositions d WHERE d.sequence=line_result_outbox.sequence))
      AND o.state IN ('pending','blocked') AND f.kind='publication' AND f.revision=0`).bind(groupId,groupId).first<{sequence:number;result_json:string;run_id:string;generation:number;notification_cycle:number;result_key:string;outcome_json:string}>();
  }
  async function replaceUnsentHead(groupId: string, sequence: number, raw: string, result: unknown) {
    await db.prepare(`UPDATE line_result_outbox SET result_json=? WHERE group_id=? AND sequence=? AND result_json=? AND state='pending' AND owner_event_id IS NULL
      AND sequence=(SELECT MIN(sequence) FROM line_result_outbox WHERE group_id=? AND state!='accepted' AND NOT EXISTS(SELECT 1 FROM line_reply_owner_dispositions d WHERE d.sequence=line_result_outbox.sequence))
      AND NOT EXISTS(SELECT 1 FROM line_reply_owner_dispositions WHERE sequence=line_result_outbox.sequence)
      AND NOT EXISTS(SELECT 1 FROM line_reply_dispatches WHERE candidate_sequence=line_result_outbox.sequence)`).bind(JSON.stringify(result),groupId,sequence,raw,groupId).run();
  }
  async function replaceRejectedHead(groupId: string, sequence: number, raw: string, result: unknown) {
    await db.prepare(`UPDATE line_result_outbox SET result_json=?, state='pending', owner_event_id=NULL
      WHERE group_id=? AND sequence=? AND result_json=? AND state IN ('pending','blocked')
      AND sequence=(SELECT MIN(sequence) FROM line_result_outbox WHERE group_id=? AND state!='accepted' AND NOT EXISTS(SELECT 1 FROM line_reply_owner_dispositions d WHERE d.sequence=line_result_outbox.sequence))
      AND NOT EXISTS(SELECT 1 FROM line_reply_owner_dispositions WHERE sequence=line_result_outbox.sequence)
      AND EXISTS(SELECT 1 FROM line_reply_dispatches WHERE candidate_sequence=line_result_outbox.sequence)
      AND NOT EXISTS(SELECT 1 FROM line_reply_dispatches WHERE candidate_sequence=line_result_outbox.sequence AND (group_id!=line_result_outbox.group_id OR phase!='rejected' OR rejection_proven!=1 OR http_status IS NULL OR http_status<300 OR http_status>=500 OR disposition IS NULL OR disposition NOT IN ('retry_on_new_event','blocked_payload')))
      AND ((state='pending' AND owner_event_id IS NULL) OR (state='blocked' AND EXISTS(SELECT 1 FROM line_reply_dispatches WHERE event_id=line_result_outbox.owner_event_id AND candidate_sequence=line_result_outbox.sequence AND group_id=line_result_outbox.group_id AND phase='rejected' AND disposition='blocked_payload')))`)
      .bind(JSON.stringify(result),groupId,sequence,raw,groupId).run();
  }
  async function markMaterialized(resultKey: string, groupId: string) {
    await db.prepare(`UPDATE workflow_feedback_results SET materialized=1 WHERE result_key=? AND group_id=? AND EXISTS (SELECT 1 FROM line_result_outbox WHERE result_key=? AND group_id=?)`).bind(resultKey,groupId,resultKey,groupId).run();
  }
  async function hasOutbox(resultKey: string, groupId: string) {
    return !!await db.prepare('SELECT 1 FROM line_result_outbox WHERE result_key=? AND group_id=?').bind(resultKey,groupId).first();
  }
  return { publicationHead, replaceUnsentHead, replaceRejectedHead, markMaterialized, hasOutbox, lookupTrustedEarlyFailure, recordStage, commitOutcome, upsertEvidence, readEvidence, pendingByGroup };
}
