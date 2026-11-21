import type { verifyHistoricalImportEvidence } from '../import/owner-evidence';

type VerifiedEvidence = Extract<Awaited<ReturnType<typeof verifyHistoricalImportEvidence>>, {status:'verified'}>;
type Input = {runId:string; groupId:string; ownerGroupId:string; baseId:string; tableId:string; recordId:string; actor:string; reason:string; evidence:VerifiedEvidence};

/** Commit only the exact saved evidence that was independently verified. */
export async function resolveHistoricalImportGroup(db:D1Database, input:Input) {
  const {runId,groupId,ownerGroupId,baseId,tableId,recordId,actor,reason,evidence}=input;
  if (![runId,groupId,ownerGroupId,baseId,tableId,recordId,actor,reason].every(v => typeof v === 'string' && v.trim().length > 0 && v.length <= 500 && !v.includes('\0')) || evidence.status !== 'verified' || evidence.recordId !== recordId) return null;
  const c=evidence.captured;
  if (!c.product_id || c.claim_product !== c.product_id || c.base_id !== baseId || c.table_id !== tableId || (c.airtable_record_id !== null && c.airtable_record_id !== recordId) || c.candidate.productId !== c.product_id || c.candidate.groupHash !== c.group_hash || c.members.length < 5 || c.previewHashes.length !== c.members.length-1 || c.candidate.attachments.length !== c.previewHashes.length) return null;
  const evidenceJson=JSON.stringify(evidence);
  const read = () => db.prepare('SELECT * FROM import_owner_group_resolutions WHERE group_id=? AND run_id=? AND owner_group_id=? AND actor=? AND reason=? AND evidence_json=?').bind(groupId,runId,ownerGroupId,actor,reason,evidenceJson).first();
  const existing=await read();
  if (existing) return existing;
  await db.batch([
    db.prepare(`UPDATE product_groups SET state='succeeded',airtable_record_id=?,failure_reason=NULL,updated_at=datetime('now')
      WHERE id=? AND import_run_id=? AND state=? AND state IN ('failed','pending','importing') AND group_hash=? AND product_id=? AND airtable_record_id IS ? AND first_photo_id=? AND last_photo_id=? AND created_at=? AND updated_at=? AND attempt_count=? AND failure_reason IS ?
      AND EXISTS (SELECT 1 FROM import_runs r WHERE r.id=? AND r.trigger='line' AND r.status=? AND r.status IN ('completed','completed_with_failures','start_failed') AND r.source_album_id=? AND r.settings_context_json=? AND json_valid(r.settings_context_json) AND json_extract(r.settings_context_json,'$.replyGroupId')=? AND json_extract(r.settings_context_json,'$.settings.config.airtableBaseId')=? AND json_extract(r.settings_context_json,'$.settings.config.airtableProductsTableId')=?)
      AND EXISTS (SELECT 1 FROM audit_events WHERE correlation_id=? AND actor='system:import' AND action='product_id_allocated' AND after_value=?)
      AND EXISTS (SELECT 1 FROM airtable_create_claims WHERE group_id=? AND product_id=? AND base_id=? AND table_id=?)
      AND (SELECT count(*) FROM product_group_image_members WHERE group_id=?)=json_array_length(?)
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM product_group_image_members m JOIN photo_assets a ON a.source_album_id=? AND a.apple_photo_id=m.apple_photo_id WHERE m.group_id=? AND m.ordinal=json_extract(j.value,'$.ordinal') AND m.apple_photo_id=json_extract(j.value,'$.apple_photo_id') AND m.r2_key IS json_extract(j.value,'$.r2_key') AND a.r2_key IS json_extract(j.value,'$.asset_key') AND a.content_hash IS json_extract(j.value,'$.content_hash') AND a.is_marker IS json_extract(j.value,'$.is_marker') AND a.marker_kind IS json_extract(j.value,'$.marker_kind')))
      AND NOT EXISTS (SELECT 1 FROM import_owner_group_resolutions WHERE group_id=?)`)
      .bind(recordId,groupId,runId,c.state,c.group_hash,c.product_id,c.airtable_record_id,c.first_photo_id,c.last_photo_id,c.created_at,c.updated_at,c.attempt_count,c.failure_reason,runId,c.run_status,c.source_album_id,c.settings_context_json,ownerGroupId,baseId,tableId,runId,c.product_id,groupId,c.product_id,baseId,tableId,groupId,JSON.stringify(c.members),JSON.stringify(c.members),c.source_album_id,groupId,groupId),
    db.prepare(`INSERT INTO import_owner_group_resolutions(group_id,run_id,owner_group_id,actor,reason,evidence_json) SELECT ?,?,?,?,?,? WHERE changes()=1`).bind(groupId,runId,ownerGroupId,actor,reason,evidenceJson),
  ]);
  return read();
}
