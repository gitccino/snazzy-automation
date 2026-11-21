/** Read a group's saved references only while it still belongs to the specified LINE run. */
export async function inspectImportGroup(db: D1Database, runId: string, ownerGroupId: string, groupId: string, baseId: string, tableId: string) {
  const rows = (await db.prepare(`SELECT r.id AS run_id, r.source_album_id, r.status AS run_status, r.started_at,
    r.settings_context_json, r.failure_reason AS run_failure, r.checkpoint_position, g.failure_reason AS group_failure, g.id AS group_id, g.state, g.group_hash, g.product_id, g.airtable_record_id,
    g.first_photo_id, g.last_photo_id, g.attempt_count, m.ordinal, m.apple_photo_id, m.r2_key
    FROM import_runs r JOIN product_groups g ON g.import_run_id=r.id
    LEFT JOIN product_group_image_members m ON m.group_id=g.id
    WHERE r.id=? AND r.trigger='line' AND g.id=? ORDER BY m.ordinal`)
    .bind(runId, groupId).all<{
      run_id:string; source_album_id:string; run_status:string; started_at:string; settings_context_json:string; run_failure:string|null; group_failure:string|null; checkpoint_position:number|null;
      group_id:string; state:string; group_hash:string; product_id:string | null; airtable_record_id:string | null;
      first_photo_id:string; last_photo_id:string; attempt_count:number; ordinal:number | null; apple_photo_id:string | null; r2_key:string | null;
    }>()).results;
  const row = rows[0];
  if (!row) return null;
  let context: any;
  try { context = JSON.parse(row.settings_context_json); } catch { return null; }
  const base = context?.settings?.config?.airtableBaseId, table = context?.settings?.config?.airtableProductsTableId;
  const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v);
  const reference = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_./-]+$/.test(v) && !v.startsWith('//');
  if (!id(row.run_id) || !id(row.group_id) || !id(ownerGroupId) || !/^\d{4}-\d\d-\d\dT[0-9:.+-]+Z?$/.test(row.started_at) || context?.replyGroupId !== ownerGroupId || !id(base) || !id(table) || base !== baseId || table !== tableId || !reference(row.source_album_id) ||
      !reference(row.first_photo_id) || !reference(row.last_photo_id) || !reference(row.group_hash) ||
      (row.product_id !== null && !reference(row.product_id)) || (row.airtable_record_id !== null && !id(row.airtable_record_id)) ||
      rows.some(m => m.ordinal !== null && (!reference(m.apple_photo_id) || (m.r2_key !== null && !reference(m.r2_key))))) return null;
  const feedbackRows = (await db.prepare(`SELECT stage, failure_code FROM workflow_feedback WHERE kind='import' AND run_id=? AND generation=1 AND notification_cycle=1 AND group_id=? AND context_json=?`).bind(runId,ownerGroupId,row.settings_context_json).all<{stage:string;failure_code:string|null}>()).results;
  const saved = feedbackRows[0];
  const safeCode = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
  const queueHead = await inspectOwnerQueue(db, ownerGroupId);
  const claims = (await db.prepare(`SELECT product_id,base_id,table_id FROM airtable_create_claims WHERE group_id=?`).bind(groupId).all<{product_id:string;base_id:string;table_id:string}>()).results;
  const claim = claims[0];
  const verification = (await db.prepare(`SELECT origin_workflow_id,verifier_id,completed FROM import_verification_claims WHERE import_run_id=? AND group_id=? AND context_json=?`).bind(runId,ownerGroupId,row.settings_context_json).all<{origin_workflow_id:string;verifier_id:string;completed:number|null}>()).results[0];
  return {feedback:saved ? {stage:safeCode(saved.stage),failureCode:safeCode(saved.failure_code)} : null,
    queueHead,
    createClaim:claim && reference(claim.product_id) && id(claim.base_id) && id(claim.table_id) ? claim : null,
    verification:verification ? {originWorkflowId:safeCode(verification.origin_workflow_id),verifierId:safeCode(verification.verifier_id),completed:verification.completed} : null,
    runFailure:safeCode(row.run_failure), groupFailure:safeCode(row.group_failure), checkpointPosition:row.checkpoint_position,
    externalLiveness:'unknown', syncCleanup:'not recorded by this inspection',
    runId:row.run_id, sourceAlbumId:row.source_album_id, runStatus:row.run_status, startedAt:row.started_at,
    airtableBaseId:base as string, airtableTableId:table as string,
    group:{id:row.group_id, state:row.state, hash:row.group_hash, productId:row.product_id, airtableRecordId:row.airtable_record_id,
      firstPhotoId:row.first_photo_id, lastPhotoId:row.last_photo_id, attemptCount:row.attempt_count},
    originals:rows.filter(m => m.ordinal !== null).map(m => ({ordinal:m.ordinal, applePhotoId:m.apple_photo_id, r2Key:m.r2_key}))};
}

export async function inspectOwnerQueue(db: D1Database, ownerGroupId: string) {
  const safeCode = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
  const heads = (await db.prepare(`SELECT sequence,state,owner_event_id FROM line_result_outbox o WHERE group_id=? AND state!='accepted' AND NOT EXISTS(SELECT 1 FROM line_reply_owner_dispositions d WHERE d.sequence=o.sequence) ORDER BY sequence LIMIT 1`).bind(ownerGroupId).all<{sequence:number;state:string;owner_event_id:string|null}>()).results;
  const head = heads[0];
  const dispatches = head ? (await db.prepare(`SELECT event_id,workflow_id,phase,request_id,http_status,disposition,rejection_proven FROM line_reply_dispatches WHERE group_id=? AND candidate_sequence=? ORDER BY updated_at,event_id`).bind(ownerGroupId,head.sequence).all<{event_id:string;workflow_id:string;phase:string;request_id:string|null;http_status:number|null;disposition:string|null;rejection_proven:number}>()).results : [];
  return head ? {sequence:head.sequence,state:safeCode(head.state),ownerEventId:safeCode(head.owner_event_id),dispatches:dispatches.map(d => ({eventId:safeCode(d.event_id),workflowId:safeCode(d.workflow_id),phase:safeCode(d.phase),requestId:safeCode(d.request_id),httpStatus:d.http_status,disposition:safeCode(d.disposition),rejectionProven:d.rejection_proven === 1}))} : null;
}
