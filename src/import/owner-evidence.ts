import { computeGroupHash } from './grouping';
import { sha256Hex } from '../shared/ids';
import { downloadJpegAttachment } from '../publication/attachment-download';
import type { DownloadableProductAttachment } from '../publication/types';
import type { Fetcher } from '../shared/http';

interface Input { runId:string; ownerGroupId:string; groupId:string; baseId:string; tableId:string; recordId:string }
interface Dependencies {
  db:D1Database;
  readOriginal(key:string):Promise<ArrayBuffer | null>;
  renderPreview(bytes:ArrayBuffer):Promise<ArrayBuffer>;
  readRecord(input:Input):Promise<{productId:string;groupHash:string;attachments:DownloadableProductAttachment[]} | null>;
  fetcher:Fetcher;
}

/** Read-only evidence; callers must fence every saved value again when committing a disposition. */
export async function verifyHistoricalImportEvidence(deps:Dependencies, input:Input) {
  const held = (reason:string) => ({status:'held' as const,reason});
  const row = await deps.db.prepare(`SELECT r.source_album_id,r.status AS run_status,r.settings_context_json,g.state,g.group_hash,g.product_id,g.airtable_record_id,g.first_photo_id,g.last_photo_id,g.created_at,
    c.product_id AS claim_product,c.base_id,c.table_id FROM import_runs r JOIN product_groups g ON g.import_run_id=r.id
    LEFT JOIN airtable_create_claims c ON c.group_id=g.id WHERE r.id=? AND r.trigger='line' AND g.id=?`)
    .bind(input.runId,input.groupId).first<{source_album_id:string;run_status:string;settings_context_json:string;state:string;group_hash:string;product_id:string|null;airtable_record_id:string|null;first_photo_id:string;last_photo_id:string;created_at:string;claim_product:string|null;base_id:string|null;table_id:string|null}>();
  let context:any;
  try { context = JSON.parse(row?.settings_context_json ?? ''); } catch { return held('owner_or_target_mismatch'); }
  if (!row || context?.replyGroupId !== input.ownerGroupId || context?.settings?.config?.airtableBaseId !== input.baseId || context?.settings?.config?.airtableProductsTableId !== input.tableId) return held('owner_or_target_mismatch');
  if (!['completed','completed_with_failures','start_failed'].includes(row.run_status) || !['failed','pending','importing'].includes(row.state)) return held('run_or_group_not_eligible');
  const allocation = await deps.db.prepare("SELECT 1 FROM audit_events WHERE correlation_id=? AND actor='system:import' AND action='product_id_allocated' AND after_value=?").bind(input.runId,row.product_id).first();
  if (!allocation || !row.product_id || row.claim_product !== row.product_id || row.base_id !== input.baseId || row.table_id !== input.tableId || (row.airtable_record_id !== null && row.airtable_record_id !== input.recordId)) return held('claim_or_record_conflict');
  const members = (await deps.db.prepare(`SELECT m.ordinal,m.apple_photo_id,m.r2_key,a.content_hash,a.r2_key AS asset_key,a.is_marker,a.marker_kind
    FROM product_group_image_members m LEFT JOIN photo_assets a ON a.source_album_id=? AND a.apple_photo_id=m.apple_photo_id
    WHERE m.group_id=? ORDER BY m.ordinal`).bind(row.source_album_id,input.groupId).all<{ordinal:number;apple_photo_id:string;r2_key:string|null;content_hash:string|null;asset_key:string|null;is_marker:number|null;marker_kind:string|null}>()).results;
  if (!members.length || members.some((m,i) => m.ordinal !== i || !m.r2_key || !m.content_hash || m.asset_key !== m.r2_key || m.is_marker === null) || members[0]?.apple_photo_id !== row.first_photo_id || members.at(-1)?.apple_photo_id !== row.last_photo_id) return held('membership_missing');
  if (await computeGroupHash(row.source_album_id,members.map(m => ({applePhotoId:m.apple_photo_id}))) !== row.group_hash) return held('membership_conflict');
  const images = members.filter(m => (m.marker_kind ?? (m.is_marker ? 'product_start' : 'none')) === 'none');
  if (images.length < 4 || (members[0]!.marker_kind ?? (members[0]!.is_marker ? 'product_start' : 'none')) !== 'product_start' || images.length !== members.length - 1) return held('membership_conflict');
  try {
    const record = await deps.readRecord(input);
    if (!record || record.productId !== row.product_id || record.groupHash !== row.group_hash || record.attachments.length !== images.length) return held('candidate_conflict');
    const hashes:string[] = [];
    for (const member of members) {
      const bytes = await deps.readOriginal(member.r2_key!);
      if (!bytes) return held('original_missing');
      if (await sha256Hex(bytes) !== member.content_hash) return held('original_hash_mismatch');
      if (member === members[0]) continue;
      const preview = await deps.renderPreview(bytes);
      const attachment = await downloadJpegAttachment(deps.fetcher,record.attachments[hashes.length]!);
      const hash = await sha256Hex(preview);
      if (hash !== await sha256Hex(attachment.bytes)) return held('attachment_mismatch');
      hashes.push(hash);
    }
    return {status:'verified' as const,recordId:input.recordId, captured:{...row,members,previewHashes:hashes}};
  } catch { return held('provider_evidence_unavailable'); }
}
