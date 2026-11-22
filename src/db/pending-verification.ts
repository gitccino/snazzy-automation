export type PendingVerification =
  | { kind: 'import'; runId: string; groupId: string; verifierId: string; originWorkflowId: string; contextJson: string; albumId: string }
  | { kind: 'publication'; runId: string; groupId: string; verifierId: string; originWorkflowId: string; contextJson: string; generation: number; notificationCycle: number };

const candidates = `SELECT 'import' AS kind, c.import_run_id AS runId, c.group_id AS groupId, c.verifier_id AS verifierId,
    c.origin_workflow_id AS originWorkflowId, c.context_json AS contextJson, c.source_album_id AS albumId, NULL AS generation, NULL AS notificationCycle
    FROM import_verification_claims c JOIN import_runs r ON r.id=c.import_run_id
    WHERE c.group_id=?1 AND c.completed IS NULL AND r.source_album_id=c.source_album_id AND r.trigger='line' AND r.status='running'
      AND r.settings_context_json=c.context_json AND json_valid(c.context_json) AND json_extract(c.context_json,'$.replyGroupId')=c.group_id
    UNION ALL
    SELECT 'publication', c.publication_run_id, c.group_id, c.verifier_id, c.origin_workflow_id, c.context_json, NULL, c.generation, c.notification_cycle
    FROM publication_verification_claims c JOIN publication_jobs j ON j.publication_run_id=c.publication_run_id
    WHERE c.group_id=?1 AND c.completed=0 AND j.generation=c.generation AND j.notification_cycle=c.notification_cycle
      AND j.correlation_id=c.origin_workflow_id AND j.settings_context_json=c.context_json
      AND json_valid(c.context_json) AND json_extract(c.context_json,'$.replyGroupId')=c.group_id`;

export async function selectPendingVerification(db: D1Database, groupId: string): Promise<PendingVerification | null> {
  const cursor = await db.prepare(`WITH candidates AS (${candidates})
    INSERT INTO pending_verification_cursor(group_id, claim_key)
    SELECT ?1, kind || ':' || runId FROM candidates
    ORDER BY (kind || ':' || runId <= COALESCE((SELECT claim_key FROM pending_verification_cursor WHERE group_id=?1), '')), kind, runId LIMIT 1
    ON CONFLICT(group_id) DO UPDATE SET claim_key=excluded.claim_key RETURNING claim_key`).bind(groupId).first<{claim_key:string}>();
  if (!cursor) return null;
  return db.prepare(`WITH candidates AS (${candidates}) SELECT * FROM candidates WHERE kind || ':' || runId=?2`)
    .bind(groupId, cursor.claim_key).first<PendingVerification>();
}
