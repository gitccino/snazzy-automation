/** Read a group's saved references only while it still belongs to the specified LINE run. */
export async function inspectImportGroup(db: D1Database, runId: string, ownerGroupId: string, groupId: string) {
  const rows = (await db.prepare(`SELECT r.id AS run_id, r.source_album_id, r.status AS run_status, r.started_at,
    r.settings_context_json, g.id AS group_id, g.state, g.group_hash, g.product_id, g.airtable_record_id,
    g.first_photo_id, g.last_photo_id, g.attempt_count, m.ordinal, m.apple_photo_id, m.r2_key
    FROM import_runs r JOIN product_groups g ON g.import_run_id=r.id
    LEFT JOIN product_group_image_members m ON m.group_id=g.id
    WHERE r.id=? AND r.trigger='line' AND g.id=? ORDER BY m.ordinal`)
    .bind(runId, groupId).all<{
      run_id:string; source_album_id:string; run_status:string; started_at:string; settings_context_json:string;
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
  if (!id(row.run_id) || !id(row.group_id) || !id(ownerGroupId) || !/^\d{4}-\d\d-\d\dT[0-9:.+-]+Z?$/.test(row.started_at) || context?.replyGroupId !== ownerGroupId || !id(base) || !id(table) || !reference(row.source_album_id) ||
      !reference(row.first_photo_id) || !reference(row.last_photo_id) || !reference(row.group_hash) ||
      (row.product_id !== null && !reference(row.product_id)) || (row.airtable_record_id !== null && !id(row.airtable_record_id)) ||
      rows.some(m => m.ordinal !== null && (!reference(m.apple_photo_id) || (m.r2_key !== null && !reference(m.r2_key))))) return null;
  return {runId:row.run_id, sourceAlbumId:row.source_album_id, runStatus:row.run_status, startedAt:row.started_at,
    airtableBaseId:base as string, airtableTableId:table as string,
    group:{id:row.group_id, state:row.state, hash:row.group_hash, productId:row.product_id, airtableRecordId:row.airtable_record_id,
      firstPhotoId:row.first_photo_id, lastPhotoId:row.last_photo_id, attemptCount:row.attempt_count},
    originals:rows.filter(m => m.ordinal !== null).map(m => ({ordinal:m.ordinal, applePhotoId:m.apple_photo_id, r2Key:m.r2_key}))};
}
