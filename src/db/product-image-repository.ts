import { z } from "zod";
import type { Clock } from "../shared/time";
import { OperationalError } from "../shared/errors";

const snapshotSchema = z.array(z.object({ id: z.string().min(1), filename: z.string().min(1) }));
const replacementSchema = z.array(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("retain"), attachmentId: z.string().min(1), filename: z.string().min(1) }),
  z.object({ kind: z.literal("preview"), sourceAttachmentId: z.string().min(1), r2Key: z.string().min(1), filename: z.string().min(1) }),
]));
export type AttachmentSnapshot = z.infer<typeof snapshotSchema>;
export type ImageReplacement = z.infer<typeof replacementSchema>[number];
export type ImagePreparationState = "preparing" | "replacing" | "ready" | "failed" | "conflicted";
export interface ImageOwner { recordId: string; workflowId: string; generation: number }
export interface ImagePreparation extends ImageOwner {
  state: ImagePreparationState; snapshot: AttachmentSnapshot; fingerprint: string;
  intent: ImageReplacement[] | null; safeError: string | null;
}
export interface OriginalImage {
  recordId: string; attachmentId: string; attachmentKind: "source" | "preview"; originalFilename: string;
  contentHash: string; r2Key: string; mediaType: "image/jpeg"; byteLength: number;
  previewFilename: string; variant: "airtable-preview-v1";
}
const operationSchema = z.object({
  record_id: z.string(), owner_workflow_id: z.string(), generation: z.number().int().positive(),
  state: z.enum(["preparing", "replacing", "ready", "failed", "conflicted"]),
  snapshot_json: z.string(), fingerprint: z.string(), intent_json: z.string().nullable(), safe_error: z.string().nullable(),
});
const originalSchema = z.object({
  record_id: z.string(), attachment_id: z.string(), attachment_kind: z.enum(["source", "preview"]),
  original_filename: z.string(), content_hash: z.string(), r2_key: z.string(),
  media_type: z.literal("image/jpeg"), byte_length: z.number().int().positive(),
  preview_filename: z.string(), variant: z.literal("airtable-preview-v1"),
});
const changed = () => new OperationalError("product_image_owner_changed", "Product image preparation owner changed", true);
const ownerValues = (owner: ImageOwner) => [owner.recordId, owner.workflowId, owner.generation];
const ownerPredicate = "record_id = ? AND owner_workflow_id = ? AND generation = ? AND state IN ('preparing','replacing')";

export async function readImagePreparation(db: D1Database, recordId: string): Promise<ImagePreparation | null> {
  const row = await db.prepare("SELECT * FROM product_image_preparations WHERE record_id = ?").bind(recordId).first();
  if (!row) return null;
  const value = operationSchema.parse(row);
  return { recordId: value.record_id, workflowId: value.owner_workflow_id, generation: value.generation,
    state: value.state, snapshot: snapshotSchema.parse(JSON.parse(value.snapshot_json)), fingerprint: value.fingerprint,
    intent: value.intent_json === null ? null : replacementSchema.parse(JSON.parse(value.intent_json)), safeError: value.safe_error };
}

// The caller must verify a predecessor's terminal workflow status before passing it here.
export async function claimImagePreparation(db: D1Database, clock: Clock, recordId: string, workflowId: string,
  snapshot: AttachmentSnapshot, fingerprint: string, observed: ImagePreparation | null): Promise<ImageOwner | null> {
  const generation = (observed?.generation ?? 0) + 1;
  const input = [workflowId, generation, JSON.stringify(snapshotSchema.parse(snapshot)), fingerprint, clock.now().toISOString()];
  const result = observed
    ? await db.prepare(`UPDATE product_image_preparations SET owner_workflow_id = ?, generation = ?, snapshot_json = ?, fingerprint = ?, updated_at = ?, state = 'preparing', intent_json = NULL, safe_error = NULL
        WHERE record_id = ? AND owner_workflow_id = ? AND generation = ? AND state = ?`)
      .bind(...input, recordId, observed.workflowId, observed.generation, observed.state).run()
    : await db.prepare(`INSERT INTO product_image_preparations (owner_workflow_id, generation, snapshot_json, fingerprint, updated_at, record_id, state)
        VALUES (?, ?, ?, ?, ?, ?, 'preparing') ON CONFLICT(record_id) DO NOTHING`).bind(...input, recordId).run();
  return result.meta.changes === 1 ? { recordId, workflowId, generation } : null;
}

export async function assertImageOwner(db: D1Database, owner: ImageOwner): Promise<void> {
  if (!await db.prepare(`SELECT 1 FROM product_image_preparations WHERE ${ownerPredicate}`).bind(...ownerValues(owner)).first()) throw changed();
}

export async function findOriginalImage(db: D1Database, recordId: string, attachmentId: string): Promise<OriginalImage | null> {
  const row = await db.prepare("SELECT * FROM product_image_originals WHERE record_id = ? AND attachment_id = ?").bind(recordId, attachmentId).first();
  if (!row) return null;
  const v = originalSchema.parse(row);
  return { recordId: v.record_id, attachmentId: v.attachment_id, attachmentKind: v.attachment_kind,
    originalFilename: v.original_filename, contentHash: v.content_hash, r2Key: v.r2_key, mediaType: v.media_type,
    byteLength: v.byte_length, previewFilename: v.preview_filename, variant: v.variant };
}

export async function saveOriginalImage(db: D1Database, clock: Clock, owner: ImageOwner, image: OriginalImage): Promise<void> {
  if (image.recordId !== owner.recordId) throw changed();
  await assertImageOwner(db, owner);
  const old = await findOriginalImage(db, image.recordId, image.attachmentId);
  if (old) {
    if (JSON.stringify(old) !== JSON.stringify(image)) throw new OperationalError("product_image_mapping_conflict", "Original image mapping differs", false);
    return;
  }
  const result = await db.prepare(`INSERT INTO product_image_originals
    (record_id, attachment_id, attachment_kind, original_filename, content_hash, r2_key, media_type, byte_length, preview_filename, variant, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM product_image_preparations WHERE ${ownerPredicate}`)
    .bind(image.recordId, image.attachmentId, image.attachmentKind, image.originalFilename, image.contentHash, image.r2Key, image.mediaType,
      image.byteLength, image.previewFilename, image.variant, clock.now().toISOString(), ...ownerValues(owner)).run();
  if (result.meta.changes !== 1) throw changed();
}

export async function persistImageIntent(db: D1Database, clock: Clock, owner: ImageOwner, intent: ImageReplacement[]): Promise<void> {
  const value = JSON.stringify(replacementSchema.parse(intent));
  const result = await db.prepare(`UPDATE product_image_preparations SET intent_json = ?, state = 'replacing', updated_at = ?
    WHERE ${ownerPredicate} AND (intent_json IS NULL OR intent_json = ?)`)
    .bind(value, clock.now().toISOString(), ...ownerValues(owner), value).run();
  if (result.meta.changes !== 1) throw changed();
}

export async function completeImagePreparation(db: D1Database, clock: Clock, owner: ImageOwner,
  aliases: Array<{ sourceAttachmentId: string; previewAttachmentId: string }>): Promise<void> {
  await assertImageOwner(db, owner);
  for (const alias of aliases) {
    const source = await findOriginalImage(db, owner.recordId, alias.sourceAttachmentId);
    const old = await findOriginalImage(db, owner.recordId, alias.previewAttachmentId);
    if (!source || (old && (old.r2Key !== source.r2Key || old.attachmentKind !== 'preview'))) {
      throw new OperationalError("product_image_mapping_conflict", "Preview image mapping differs", false);
    }
  }
  const statements = aliases.map(alias => db.prepare(`INSERT INTO product_image_originals
    (record_id, attachment_id, attachment_kind, original_filename, content_hash, r2_key, media_type, byte_length, preview_filename, variant, created_at)
    SELECT m.record_id, ?, 'preview', m.original_filename, m.content_hash, m.r2_key, m.media_type, m.byte_length, m.preview_filename, m.variant, ?
    FROM product_image_originals m JOIN product_image_preparations p ON p.record_id = m.record_id
    WHERE m.record_id = ? AND m.attachment_id = ? AND p.owner_workflow_id = ? AND p.generation = ? AND p.state IN ('preparing','replacing')
    ON CONFLICT(record_id, attachment_id) DO NOTHING`)
    .bind(alias.previewAttachmentId, clock.now().toISOString(), owner.recordId, alias.sourceAttachmentId, owner.workflowId, owner.generation));
  statements.push(db.prepare(`UPDATE product_image_preparations SET state = 'ready', safe_error = NULL, updated_at = ? WHERE ${ownerPredicate}`)
    .bind(clock.now().toISOString(), ...ownerValues(owner)));
  const results = await db.batch(statements);
  if (results.at(-1)?.meta.changes !== 1) throw changed();
}

export async function failImagePreparation(db: D1Database, clock: Clock, owner: ImageOwner,
  state: "failed" | "conflicted", safeError: string): Promise<void> {
  const result = await db.prepare(`UPDATE product_image_preparations SET state = ?, safe_error = ?, updated_at = ? WHERE ${ownerPredicate}`)
    .bind(state, safeError, clock.now().toISOString(), ...ownerValues(owner)).run();
  if (result.meta.changes !== 1) throw changed();
}

export async function findImportedOriginal(db: D1Database, recordId: string, filename: string): Promise<{ contentHash: string; r2Key: string } | null> {
  if (!/^[a-f0-9]{64}\.jpg$/.test(filename)) return null;
  const row = await db.prepare(`SELECT a.content_hash, a.r2_key FROM product_groups g
    JOIN import_runs run ON run.id = g.import_run_id
    JOIN photo_assets first ON first.apple_photo_id = g.first_photo_id AND first.source_album_id = run.source_album_id
    JOIN photo_assets last ON last.apple_photo_id = g.last_photo_id AND last.source_album_id = first.source_album_id
    JOIN photo_assets a ON a.source_album_id = first.source_album_id AND a.position BETWEEN first.position AND last.position
    WHERE g.airtable_record_id = ? AND g.state = 'succeeded' AND a.marker_kind = 'none' AND a.r2_key = ?
    LIMIT 1`)
    .bind(recordId, `assets/${filename}`).first<{ content_hash: string; r2_key: string }>();
  return row ? { contentHash: row.content_hash, r2Key: row.r2_key } : null;
}
