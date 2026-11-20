export type PendingVerification =
  | { kind: 'import'; runId: string; groupId: string; verifierId: string; originWorkflowId: string; contextJson: string; albumId: string }
  | { kind: 'publication'; runId: string; groupId: string; verifierId: string; originWorkflowId: string; contextJson: string; generation: number; notificationCycle: number };

export async function selectPendingVerification(db: D1Database, groupId: string): Promise<PendingVerification | null> {
  const imported = await db.prepare(`SELECT 'import' AS kind, c.import_run_id AS runId, c.group_id AS groupId, c.verifier_id AS verifierId,
    c.origin_workflow_id AS originWorkflowId, c.context_json AS contextJson, c.source_album_id AS albumId
    FROM import_verification_claims c JOIN import_runs r ON r.id=c.import_run_id
    WHERE c.group_id=? AND c.completed IS NULL AND r.source_album_id=c.source_album_id AND r.trigger='line' AND r.status='running'
      AND r.settings_context_json=c.context_json AND json_valid(c.context_json) AND json_extract(c.context_json,'$.replyGroupId')=c.group_id
    ORDER BY c.import_run_id LIMIT 1`).bind(groupId).first<PendingVerification>();
  if (imported) return imported;
  return db.prepare(`SELECT 'publication' AS kind, c.publication_run_id AS runId, c.group_id AS groupId, c.verifier_id AS verifierId,
    c.origin_workflow_id AS originWorkflowId, c.context_json AS contextJson, c.generation, c.notification_cycle AS notificationCycle
    FROM publication_verification_claims c JOIN publication_jobs j ON j.publication_run_id=c.publication_run_id
    WHERE c.group_id=? AND c.completed=0 AND j.generation=c.generation AND j.notification_cycle=c.notification_cycle
      AND j.correlation_id=c.origin_workflow_id AND j.settings_context_json=c.context_json
      AND json_valid(c.context_json) AND json_extract(c.context_json,'$.replyGroupId')=c.group_id
    ORDER BY c.publication_run_id LIMIT 1`).bind(groupId).first<PendingVerification>();
}
