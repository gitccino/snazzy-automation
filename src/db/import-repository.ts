import { z } from "zod";
import type { Clock, IdGenerator } from "../env";

export type ProductGroupState = "pending" | "importing" | "succeeded" | "failed";

export interface PhotoAssetRow {
  id: string; sourceAlbumId: string; applePhotoId: string; contentHash: string;
  r2Key: string; position: number; isMarker: boolean; importRunId: string; createdAt: string;
}

export interface ProductGroupRow {
  id: string; importRunId: string; ordinal: number; groupHash: string; state: ProductGroupState;
  productId: string | null; airtableRecordId: string | null; firstPhotoId: string; lastPhotoId: string;
  attemptCount: number; failureReason: string | null; createdAt: string; updatedAt: string;
}

export interface ImportRepository {
  createImportRun(input: { id: string; sourceAlbumId: string; trigger: "cron" | "line" | "admin" }): Promise<void>;
  hasRunningImportRun(sourceAlbumId: string): Promise<boolean>;
  markImportRunStartFailed(id: string): Promise<void>;
  getCheckpoint(sourceAlbumId: string): Promise<number | null>;
  finalizeImportRun(input: {
    id: string;
    sourceAlbumId: string;
    status: "completed" | "completed_with_failures";
    orphanPhotoCount: number;
    checkpointPosition: number;
  }): Promise<void>;
  findAssetByContentHash(contentHash: string): Promise<PhotoAssetRow | null>;
  findAssetByApplePhotoId(sourceAlbumId: string, applePhotoId: string): Promise<PhotoAssetRow | null>;
  listAssetsForAlbum(sourceAlbumId: string): Promise<PhotoAssetRow[]>;
  recordPhotoAsset(input: Omit<PhotoAssetRow, "createdAt">): Promise<void>;
  findGroupByHash(groupHash: string): Promise<ProductGroupRow | null>;
  upsertPendingGroup(input: { id: string; importRunId: string; ordinal: number; groupHash: string; firstPhotoId: string; lastPhotoId: string }): Promise<ProductGroupRow>;
  setGroupState(id: string, state: ProductGroupState, patch?: Partial<{ productId: string; airtableRecordId: string; failureReason: string | null; attemptCount: number }>): Promise<void>;
}

const PhotoAssetDbRowSchema = z.object({
  id: z.string().min(1),
  source_album_id: z.string().min(1),
  apple_photo_id: z.string().min(1),
  content_hash: z.string().min(1),
  r2_key: z.string().min(1),
  position: z.number().int().nonnegative(),
  is_marker: z.union([z.literal(0), z.literal(1)]),
  import_run_id: z.string().min(1),
  created_at: z.string().min(1),
});

const ProductGroupDbRowSchema = z.object({
  id: z.string().min(1),
  import_run_id: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  group_hash: z.string().min(1),
  state: z.enum(["pending", "importing", "succeeded", "failed"]),
  product_id: z.string().min(1).nullable(),
  airtable_record_id: z.string().min(1).nullable(),
  first_photo_id: z.string().min(1),
  last_photo_id: z.string().min(1),
  attempt_count: z.number().int().nonnegative(),
  failure_reason: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

function toAssetRow(input: unknown): PhotoAssetRow {
  const r = PhotoAssetDbRowSchema.parse(input);
  return {
    id: r.id,
    sourceAlbumId: r.source_album_id,
    applePhotoId: r.apple_photo_id,
    contentHash: r.content_hash,
    r2Key: r.r2_key,
    position: r.position,
    isMarker: r.is_marker === 1,
    importRunId: r.import_run_id,
    createdAt: r.created_at,
  };
}

function toGroupRow(input: unknown): ProductGroupRow {
  const r = ProductGroupDbRowSchema.parse(input);
  return {
    id: r.id,
    importRunId: r.import_run_id,
    ordinal: r.ordinal,
    groupHash: r.group_hash,
    state: r.state,
    productId: r.product_id,
    airtableRecordId: r.airtable_record_id,
    firstPhotoId: r.first_photo_id,
    lastPhotoId: r.last_photo_id,
    attemptCount: r.attempt_count,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createImportRepository(db: D1Database, _ids: IdGenerator, clock: Clock): ImportRepository {
  return {
    async createImportRun({ id, sourceAlbumId, trigger }) {
      await db
        .prepare(`INSERT INTO import_runs (id, source_album_id, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)`)
        .bind(id, sourceAlbumId, trigger, clock.now().toISOString())
        .run();
    },

    async hasRunningImportRun(sourceAlbumId) {
      const row = await db
        .prepare(`SELECT 1 AS present FROM import_runs WHERE source_album_id = ? AND status = 'running' LIMIT 1`)
        .bind(sourceAlbumId)
        .first<{ present: number }>();
      return row !== null;
    },

    async markImportRunStartFailed(id) {
      await db
        .prepare(
          `UPDATE import_runs
           SET status = 'start_failed', finished_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .bind(clock.now().toISOString(), id)
        .run();
    },

    async getCheckpoint(sourceAlbumId) {
      const row = await db
        .prepare(`SELECT last_position FROM import_checkpoints WHERE source_album_id = ?`)
        .bind(sourceAlbumId)
        .first<{ last_position: number }>();
      return row?.last_position ?? null;
    },

    async finalizeImportRun(input) {
      const now = clock.now().toISOString();
      const results = await db.batch([
        db.prepare(
          `UPDATE import_runs
           SET status = ?, finished_at = ?, orphan_photo_count = ?
           WHERE id = ?
             AND source_album_id = ?
             AND status = 'running'
             AND NOT EXISTS (
               SELECT 1
               FROM product_groups
               WHERE import_run_id = import_runs.id
                 AND state IN ('pending', 'importing')
             )`,
        ).bind(input.status, now, input.orphanPhotoCount, input.id, input.sourceAlbumId),
        db.prepare(
          `INSERT INTO import_checkpoints (source_album_id, last_position, updated_at)
           SELECT ?, ?, ?
           WHERE changes() = 1
           ON CONFLICT(source_album_id) DO UPDATE SET
             last_position = MAX(import_checkpoints.last_position, excluded.last_position),
             updated_at = excluded.updated_at`,
        ).bind(input.sourceAlbumId, input.checkpointPosition, now),
      ]);
      if (results[0]?.meta.changes !== 1) {
        throw new Error(`cannot finalize import run "${input.id}"`);
      }
    },

    async findAssetByContentHash(contentHash) {
      const row = await db.prepare(`SELECT * FROM photo_assets WHERE content_hash = ? LIMIT 1`).bind(contentHash).first();
      return row === null ? null : toAssetRow(row as Record<string, unknown>);
    },

    async findAssetByApplePhotoId(sourceAlbumId, applePhotoId) {
      const row = await db
        .prepare(`SELECT * FROM photo_assets WHERE source_album_id = ? AND apple_photo_id = ? LIMIT 1`)
        .bind(sourceAlbumId, applePhotoId)
        .first();
      return row === null ? null : toAssetRow(row as Record<string, unknown>);
    },

    async listAssetsForAlbum(sourceAlbumId) {
      const rows = await db
        .prepare(`SELECT * FROM photo_assets WHERE source_album_id = ? ORDER BY position ASC`)
        .bind(sourceAlbumId)
        .all();
      return rows.results.map((r) => toAssetRow(r as Record<string, unknown>));
    },

    async recordPhotoAsset(input) {
      await db
        .prepare(
          `INSERT INTO photo_assets (id, source_album_id, apple_photo_id, content_hash, r2_key, position, is_marker, import_run_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(input.id, input.sourceAlbumId, input.applePhotoId, input.contentHash, input.r2Key, input.position, input.isMarker ? 1 : 0, input.importRunId, clock.now().toISOString())
        .run();
    },

    async findGroupByHash(groupHash) {
      const row = await db.prepare(`SELECT * FROM product_groups WHERE group_hash = ? LIMIT 1`).bind(groupHash).first();
      return row === null ? null : toGroupRow(row as Record<string, unknown>);
    },

    async upsertPendingGroup(input) {
      const now = clock.now().toISOString();
      await db
        .prepare(
          `INSERT INTO product_groups (id, import_run_id, ordinal, group_hash, state, first_photo_id, last_photo_id, attempt_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?)
           ON CONFLICT(group_hash) DO UPDATE SET
             import_run_id = excluded.import_run_id,
             ordinal = excluded.ordinal,
             first_photo_id = excluded.first_photo_id,
             last_photo_id = excluded.last_photo_id,
             state = CASE
               WHEN product_groups.state = 'failed'
                 AND product_groups.import_run_id <> excluded.import_run_id
               THEN 'pending' ELSE product_groups.state END,
             product_id = CASE
               WHEN product_groups.state = 'failed'
                 AND product_groups.import_run_id <> excluded.import_run_id
               THEN NULL ELSE product_groups.product_id END,
             airtable_record_id = CASE
               WHEN product_groups.state = 'failed'
                 AND product_groups.import_run_id <> excluded.import_run_id
               THEN NULL ELSE product_groups.airtable_record_id END,
             attempt_count = CASE
               WHEN product_groups.state = 'failed'
                 AND product_groups.import_run_id <> excluded.import_run_id
               THEN 0 ELSE product_groups.attempt_count END,
             failure_reason = CASE
               WHEN product_groups.state = 'failed'
                 AND product_groups.import_run_id <> excluded.import_run_id
               THEN NULL ELSE product_groups.failure_reason END,
             updated_at = excluded.updated_at`,
        )
        .bind(input.id, input.importRunId, input.ordinal, input.groupHash, input.firstPhotoId, input.lastPhotoId, now, now)
        .run();
      const row = await db.prepare(`SELECT * FROM product_groups WHERE group_hash = ?`).bind(input.groupHash).first();
      return toGroupRow(row as Record<string, unknown>);
    },

    async setGroupState(id, state, patch = {}) {
      await db
        .prepare(
          `UPDATE product_groups SET
             state = ?,
             product_id = COALESCE(?, product_id),
             airtable_record_id = COALESCE(?, airtable_record_id),
             failure_reason = CASE WHEN ? THEN ? ELSE failure_reason END,
             attempt_count = COALESCE(?, attempt_count),
             updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          state,
          patch.productId ?? null,
          patch.airtableRecordId ?? null,
          "failureReason" in patch ? 1 : 0,
          patch.failureReason ?? null,
          patch.attemptCount ?? null,
          clock.now().toISOString(),
          id,
        )
        .run();
    },
  };
}
