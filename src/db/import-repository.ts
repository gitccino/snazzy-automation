import { computeGroupHash, groupByMarkers } from "../import/grouping";
import { importWorkflowId } from "../shared/ids";
import { validateReplyMessages } from "../line/client";
import type { TerminalResultV1 } from "../line/reply-types";
import { z } from "zod";
import type { OrphanRange } from "../import/types";
import type { MarkerKind } from "../import/marker";
import type { Clock, IdGenerator } from "../env";

export type ProductGroupState = "pending" | "importing" | "succeeded" | "failed";

export interface PhotoAssetRow {
  id: string; sourceAlbumId: string; applePhotoId: string; contentHash: string;
  markerKind: MarkerKind; r2Key: string | null; position: number; isMarker: boolean; importRunId: string; createdAt: string;
}

export interface ProductGroupRow {
  id: string; importRunId: string; ordinal: number; groupHash: string; state: ProductGroupState;
  productId: string | null; airtableRecordId: string | null; firstPhotoId: string; lastPhotoId: string;
  attemptCount: number; failureReason: string | null; createdAt: string; updatedAt: string;
}

export type ScanPhoto = { applePhotoId: string; position: number; captureAt: string | null; mediaType: "image/jpeg" };

export type GroupingOutcome = { countedIgnoreMarkerIds?: string[]; ignoredGroupCount: number; orphanRange: OrphanRange | null; checkpointPosition: number };
export type GroupingEvidence = GroupingOutcome & ({ version: 1; savedCheckpoint: number | null; firstImportCutoffDate: string | null } | { version?: never });

export interface ImportRepository {
  countedIgnoreMarkerIds(albumId: string, excludeRunId: string): Promise<string[]>;
  recordGroupingEvidence(id: string, scan: ScanPhoto[], evidence: GroupingOutcome & { version: 1; savedCheckpoint: number | null; firstImportCutoffDate: string | null }): Promise<GroupingEvidence>;
  claimImportScan(id: string): Promise<boolean>;
  getImportScan(id: string): Promise<ScanPhoto[] | "incomplete" | null>;
  completeImportScan(id: string, photos: ScanPhoto[]): Promise<void>;
  createImportRun(input: { id: string; sourceAlbumId: string; trigger: "cron" | "line" | "admin" }): Promise<void>;
  hasRunningImportRun(sourceAlbumId: string): Promise<boolean>;
  markImportRunStartFailed(id: string): Promise<void>;
  failImportRun(input: {
    id: string;
    sourceAlbumId: string;
    failureReason: string;
    lineResult?: { readonly groupId: string; readonly result: Readonly<TerminalResultV1> };
  }): Promise<void>;
  getCheckpoint(sourceAlbumId: string): Promise<number | null>;
  finalizeImportRun(input: {
    id: string;
    sourceAlbumId: string;
    status: "completed" | "completed_with_failures";
    orphanPhotoCount: number;
    checkpointPosition: number;
    lineResult?: { readonly groupId: string; readonly result: Readonly<TerminalResultV1> };
  }): Promise<void>;
  findAssetByContentHash(contentHash: string): Promise<PhotoAssetRow | null>;
  findAssetByApplePhotoId(sourceAlbumId: string, applePhotoId: string): Promise<PhotoAssetRow | null>;
  listAssetsForAlbum(sourceAlbumId: string): Promise<PhotoAssetRow[]>;
  setAssetR2Key(sourceAlbumId: string, applePhotoId: string, r2Key: string): Promise<void>;
  recordPhotoAsset(input: Omit<PhotoAssetRow, "createdAt">): Promise<void>;
  findGroupByHash(groupHash: string): Promise<ProductGroupRow | null>;
  findConfirmedOverlap(sourceAlbumId: string, groupHash: string, photoIds: string[]): Promise<boolean>;
  upsertPendingGroup(input: { id: string; importRunId: string; ordinal: number; groupHash: string; firstPhotoId: string; lastPhotoId: string; photos?: Array<{ applePhotoId: string; r2Key: string | null }> }): Promise<ProductGroupRow>;
  claimAirtableCreate(input: { groupId: string; productId: string; baseId: string; tableId: string }): Promise<"acquired" | "existing" | "conflict">;
  setGroupState(id: string, state: ProductGroupState, patch?: Partial<{ productId: string | null; airtableRecordId: string; failureReason: string | null; attemptCount: number }>): Promise<void>;
}

const PhotoAssetDbRowSchema = z.object({
  id: z.string().min(1),
  source_album_id: z.string().min(1),
  apple_photo_id: z.string().min(1),
  content_hash: z.string().min(1),
  r2_key: z.string().min(1).nullable(),
  marker_kind: z.enum(["product_start", "ignore_start", "none"]).nullable(),
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
    markerKind: r.marker_kind ?? (r.is_marker === 1 ? "product_start" : "none"),
    isMarker: (r.marker_kind ?? (r.is_marker === 1 ? "product_start" : "none")) === "product_start",
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

async function countedIgnoreMarkerIds(db: D1Database, albumId: string, excludeRunId: string): Promise<string[]> {
  const rows = await db.prepare(`SELECT DISTINCT j.value AS id FROM import_runs r, json_each(CASE WHEN json_valid(r.grouping_evidence_json) THEN r.grouping_evidence_json ELSE '{}' END, '$.countedIgnoreMarkerIds') j
    WHERE r.source_album_id=? AND r.id<>? AND r.status IN ('completed','completed_with_failures') AND r.failure_reason IS NULL AND j.type='text'`).bind(albumId, excludeRunId).all<{id:string}>();
  return rows.results.map(row => row.id);
}

export function createImportRepository(db: D1Database, _ids: IdGenerator, clock: Clock): ImportRepository {
  return {
    countedIgnoreMarkerIds: (albumId, excludeRunId) => countedIgnoreMarkerIds(db, albumId, excludeRunId),
    async recordGroupingEvidence(id, scan, evidence) {
      const row = await db.prepare(`UPDATE import_runs SET grouping_evidence_json = COALESCE(grouping_evidence_json, ?)
        WHERE id = ? AND (status = 'running' OR (status IN ('completed','completed_with_failures') AND grouping_evidence_json IS NOT NULL)) AND scan_evidence_json = ? RETURNING grouping_evidence_json`)
        .bind(JSON.stringify(evidence), id, JSON.stringify(scan)).first<{grouping_evidence_json: string}>();
      if (!row) {
        const terminal = await db.prepare(`SELECT grouping_evidence_json FROM import_runs WHERE id=? AND status IN ('completed','completed_with_failures') AND scan_evidence_json=?`).bind(id, JSON.stringify(scan)).first<{grouping_evidence_json:string | null}>();
        if (!terminal) throw new Error("Import grouping evidence claim lost");
        return terminal.grouping_evidence_json ? JSON.parse(terminal.grouping_evidence_json) as GroupingEvidence : evidence;
      }
      return JSON.parse(row.grouping_evidence_json) as GroupingEvidence;
    },
    async claimImportScan(id) {
      const result = await db.prepare("UPDATE import_runs SET scan_evidence_json = ? WHERE id = ? AND scan_evidence_json IS NULL").bind('"incomplete"', id).run();
      return result.meta.changes === 1;
    },
    async getImportScan(id) {
      const row = await db.prepare("SELECT scan_evidence_json FROM import_runs WHERE id = ?").bind(id).first<{ scan_evidence_json: string | null }>();
      if (!row) throw new Error("Import run not found");
      if (row.scan_evidence_json === null) return null;
      return z.union([z.literal("incomplete"), z.array(z.object({ applePhotoId: z.string().min(1), position: z.number().int().nonnegative(), captureAt: z.string().nullable(), mediaType: z.literal("image/jpeg") }))]).parse(JSON.parse(row.scan_evidence_json));
    },
    async completeImportScan(id, photos) {
      const result = await db.prepare("UPDATE import_runs SET scan_evidence_json = ? WHERE id = ? AND scan_evidence_json = ?").bind(JSON.stringify(photos), id, '"incomplete"').run();
      if (result.meta.changes !== 1) throw new Error("Import scan claim lost");
    },
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

    async failImportRun(input) {
      const notice = input.lineResult;
      const key = JSON.stringify(["import", input.id, 1, 1, "terminal"]);
      const json = notice ? JSON.stringify(notice.result) : null;
      if (notice) {
        const value = notice.result;
        validateReplyMessages(value.messages);
        if (!notice.groupId.trim() || value.schemaVersion !== 1 || value.kind !== "import" || value.runId !== input.id || value.generation !== 1 || value.notificationCycle !== 1 || value.outcome !== "failed") throw new Error("import_invalid_result");
      }
      const now = clock.now().toISOString();
      const results = await db.batch([
        db.prepare(`UPDATE import_runs SET status='completed_with_failures', finished_at=?, failure_reason=?
          WHERE id=? AND source_album_id=? AND status='running'
          AND (? IS NULL OR json_extract(settings_context_json, '$.replyGroupId')=?)`)
          .bind(now, input.failureReason, input.id, input.sourceAlbumId, notice?.groupId ?? null, notice?.groupId ?? null),
        ...(notice ? [db.prepare(`INSERT INTO line_result_outbox(result_key,group_id,result_json,created_at)
          SELECT ?,?,?,? WHERE changes()=1
          ON CONFLICT(result_key) DO UPDATE SET group_id = CASE
            WHEN group_id=excluded.group_id AND result_json=excluded.result_json THEN group_id ELSE NULL END`)
          .bind(key, notice.groupId, json, now)] : []),
      ]);
      if (results[0]?.meta.changes !== 1) {
        const terminal = await db.prepare(`SELECT 1 FROM import_runs WHERE id=? AND source_album_id=?
          AND status='completed_with_failures' AND failure_reason=? AND checkpoint_position IS NULL
          AND (? IS NULL OR json_extract(settings_context_json, '$.replyGroupId')=?)`)
          .bind(input.id, input.sourceAlbumId, input.failureReason, notice?.groupId ?? null, notice?.groupId ?? null).first();
        if (!terminal || (notice && !await db.prepare('SELECT 1 FROM line_result_outbox WHERE result_key=? AND group_id=? AND result_json=?').bind(key, notice.groupId, json).first())) {
          throw new Error(`cannot fail import run "${input.id}"`);
        }
      }
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
      const notice = input.lineResult;
      if (notice) {
        const value = notice.result;
        validateReplyMessages(value.messages);
        if (!notice.groupId.trim() || value.schemaVersion !== 1 || value.kind !== "import" || value.runId !== input.id || value.generation !== 1 || value.notificationCycle !== 1 || value.outcome !== (input.status === "completed" ? "success" : "partial")) throw new Error("import_invalid_result");
      }
      const terminalKey = JSON.stringify(["import", input.id, 1, 1, "terminal"]);
      const legacy = notice && await db.prepare("SELECT 1 FROM line_result_outbox WHERE result_key=? AND group_id=? AND json_extract(result_json, '$.outcome')='unconfirmed'").bind(terminalKey, notice.groupId).first();
      const key = legacy ? JSON.stringify(["import", input.id, 1, 1, "terminal-summary"]) : terminalKey;
      const json = notice ? JSON.stringify(notice.result) : null;
      const results = await db.batch([
        db.prepare(
          `UPDATE import_runs
           SET status = ?, finished_at = ?, orphan_photo_count = ?,
               checkpoint_position = ?, failure_reason = NULL
           WHERE id = ?
             AND source_album_id = ?
             AND status = 'running'
             AND (? IS NULL OR json_extract(settings_context_json, '$.replyGroupId') = ?)
             AND NOT EXISTS (
               SELECT 1
               FROM product_groups
               WHERE import_run_id = import_runs.id
                 AND state IN ('pending', 'importing')
             )`,
        ).bind(
          input.status,
          now,
          input.orphanPhotoCount,
          input.checkpointPosition,
          input.id,
          input.sourceAlbumId,
          notice?.groupId ?? null, notice?.groupId ?? null,
        ),
        db.prepare(
          `INSERT INTO import_checkpoints (source_album_id, last_position, updated_at)
           SELECT ?, ?, ?
           WHERE changes() = 1
           ON CONFLICT(source_album_id) DO UPDATE SET
             last_position = MAX(import_checkpoints.last_position, excluded.last_position),
             updated_at = excluded.updated_at`,
        ).bind(input.sourceAlbumId, input.checkpointPosition, now),
        ...(notice ? [db.prepare(`INSERT INTO line_result_outbox(result_key,group_id,result_json,created_at)
          SELECT ?, ?, ?, ? WHERE changes() = 1
          ON CONFLICT(result_key) DO UPDATE SET group_id = CASE
            WHEN group_id = excluded.group_id AND result_json = excluded.result_json THEN group_id ELSE NULL END`)
          .bind(key, notice.groupId, json, now)] : []),
      ]);
      if (results[0]?.meta.changes !== 1) {
        const terminal = await db
          .prepare(
            `SELECT 1 AS identical
             FROM import_runs
             WHERE id = ?
               AND source_album_id = ?
               AND status = ?
               AND orphan_photo_count = ?
               AND checkpoint_position = ?
               AND failure_reason IS NULL`,
          )
          .bind(
            input.id,
            input.sourceAlbumId,
            input.status,
            input.orphanPhotoCount,
            input.checkpointPosition,
          )
          .first<{ identical: number }>();
        if (terminal === null || (notice && !await db.prepare(`SELECT 1 FROM line_result_outbox
          WHERE result_key=? AND group_id=? AND result_json=? AND EXISTS
          (SELECT 1 FROM import_runs WHERE id=? AND json_extract(settings_context_json, '$.replyGroupId')=?)
          AND EXISTS (SELECT 1 FROM import_checkpoints WHERE source_album_id=? AND last_position>=?)`)
          .bind(key, notice.groupId, json, input.id, notice.groupId, input.sourceAlbumId, input.checkpointPosition).first())) {
          throw new Error(`cannot finalize import run "${input.id}"`);
        }
      }
    },

    async findAssetByContentHash(contentHash) {
      const row = await db.prepare(`SELECT * FROM photo_assets WHERE content_hash = ? AND r2_key IS NOT NULL LIMIT 1`).bind(contentHash).first();
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

    async setAssetR2Key(sourceAlbumId, applePhotoId, r2Key) {
      const result = await db.prepare(`UPDATE photo_assets SET r2_key = ? WHERE source_album_id = ? AND apple_photo_id = ?`).bind(r2Key, sourceAlbumId, applePhotoId).run();
      if (result.meta.changes !== 1) throw new Error("Cached photo asset missing during R2 promotion");
    },

    async recordPhotoAsset(input) {
      await db
        .prepare(
          `INSERT INTO photo_assets (id, source_album_id, apple_photo_id, content_hash, r2_key, position, is_marker, marker_kind, import_run_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(input.id, input.sourceAlbumId, input.applePhotoId, input.contentHash, input.r2Key, input.position, input.markerKind === "product_start" ? 1 : 0, input.markerKind, input.importRunId, clock.now().toISOString())
        .run();
    },

    async findGroupByHash(groupHash) {
      const row = await db.prepare(`SELECT * FROM product_groups WHERE group_hash = ? LIMIT 1`).bind(groupHash).first();
      return row === null ? null : toGroupRow(row as Record<string, unknown>);
    },

    async findConfirmedOverlap(sourceAlbumId, groupHash, photoIds) {
      const row = await db.prepare(`SELECT 1 FROM product_groups g
        JOIN import_runs r ON r.id = g.import_run_id
        WHERE r.source_album_id = ? AND g.state = 'succeeded' AND g.group_hash <> ?
          AND (g.first_photo_id IN (SELECT value FROM json_each(?)) OR g.last_photo_id IN (SELECT value FROM json_each(?)) OR EXISTS (
            SELECT 1 FROM product_group_image_members m
            WHERE m.group_id = g.id AND m.apple_photo_id IN (SELECT value FROM json_each(?))
          )) LIMIT 1`).bind(sourceAlbumId, groupHash, JSON.stringify(photoIds), JSON.stringify(photoIds), JSON.stringify(photoIds)).first();
      return row !== null;
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
                 AND NOT EXISTS (SELECT 1 FROM airtable_create_claims WHERE group_id = product_groups.id)
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
      const row = toGroupRow(await db.prepare(`SELECT * FROM product_groups WHERE group_hash = ?`).bind(input.groupHash).first());
      if (input.photos?.length) {
        const wanted = input.photos.map(photo => ({ apple_photo_id: photo.applePhotoId, r2_key: photo.r2Key }));
        const readMembers = async () => (await db.prepare("SELECT apple_photo_id, r2_key FROM product_group_image_members WHERE group_id = ? ORDER BY ordinal")
          .bind(row.id).all<{ apple_photo_id: string; r2_key: string | null }>()).results;
        const existing = await readMembers();
        if (!existing.length) await db.batch(input.photos.map((photo, ordinal) => db.prepare("INSERT INTO product_group_image_members (group_id, ordinal, apple_photo_id, r2_key) VALUES (?, ?, ?, ?) ON CONFLICT(group_id, ordinal) DO NOTHING")
          .bind(row.id, ordinal, photo.applePhotoId, photo.r2Key)));
        if (JSON.stringify(await readMembers()) !== JSON.stringify(wanted)) throw new Error("Product group image membership changed");
      }
      return row;
    },

    async claimAirtableCreate(input) {
      const result = await db.prepare(`INSERT INTO airtable_create_claims (group_id, product_id, base_id, table_id)
        SELECT id, product_id, ?, ? FROM product_groups WHERE id = ? AND product_id = ?
        ON CONFLICT(group_id) DO NOTHING`)
        .bind(input.baseId, input.tableId, input.groupId, input.productId).run();
      if (result.meta.changes === 1) return "acquired";
      const existing = await db.prepare(`SELECT 1 FROM airtable_create_claims
        WHERE group_id = ? AND product_id = ? AND base_id = ? AND table_id = ?`)
        .bind(input.groupId, input.productId, input.baseId, input.tableId).first();
      return existing ? "existing" : "conflict";
    },

    async setGroupState(id, state, patch = {}) {
      const result = await db
        .prepare(
          `UPDATE product_groups SET
             state = ?,
             product_id = COALESCE(?, product_id),
             airtable_record_id = COALESCE(?, airtable_record_id),
             failure_reason = CASE WHEN ? THEN ? ELSE failure_reason END,
             attempt_count = COALESCE(?, attempt_count),
             updated_at = ?
           WHERE id = ? AND (? IS NULL OR NOT EXISTS (
             SELECT 1 FROM airtable_create_claims WHERE group_id = product_groups.id AND product_id <> ?
           ))`,
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
          patch.productId ?? null,
          patch.productId ?? null,
        )
        .run();
      if (result.meta.changes === 0 && patch.productId != null) {
        const claim = await db.prepare("SELECT product_id FROM airtable_create_claims WHERE group_id = ?").bind(id).first<{ product_id: string }>();
        if (claim && claim.product_id !== patch.productId) throw new Error("Cannot change claimed product ID");
      }
    },
  };
}

/** Read recorded evidence only while the original LINE run still owns its album. */
export async function readImportVerificationEvidence(db: D1Database, runId: string, workflowId: string, groupId: string) {
  if (!runId || !groupId || importWorkflowId(runId) !== workflowId) return null;
  const row = await db.prepare(`SELECT r.source_album_id, r.settings_context_json, r.scan_evidence_json,
    (SELECT count(*) FROM product_groups WHERE import_run_id=r.id AND state='pending') AS pending,
    (SELECT count(*) FROM product_groups WHERE import_run_id=r.id AND state='importing') AS importing,
    (SELECT count(*) FROM product_groups WHERE import_run_id=r.id AND state='succeeded') AS succeeded,
    (SELECT count(*) FROM product_groups WHERE import_run_id=r.id AND state='failed') AS failed
    FROM import_runs r WHERE r.id=? AND r.trigger='line' AND r.status='running'
      AND json_valid(r.settings_context_json) AND json_extract(r.settings_context_json, '$.replyGroupId')=?`)
    .bind(runId, groupId).first<{source_album_id: string; settings_context_json: string; scan_evidence_json: string | null; pending: number; importing: number; succeeded: number; failed: number}>();
  if (!row) return null;
  let scan: 'incomplete' | 'complete';
  try {
    const value: unknown = row.scan_evidence_json === null ? null : JSON.parse(row.scan_evidence_json);
    const parsed = z.union([z.literal('incomplete'), z.array(z.object({ applePhotoId: z.string().min(1), position: z.number().int().nonnegative(), captureAt: z.string().nullable(), mediaType: z.literal('image/jpeg') }))]).safeParse(value);
    if (!parsed.success) return null;
    scan = parsed.data === 'incomplete' ? 'incomplete' : 'complete';
  } catch { return null; }
  return { sourceAlbumId: row.source_album_id, contextJson: row.settings_context_json, scan, groups: { pending: row.pending, importing: row.importing, succeeded: row.succeeded, failed: row.failed } };
}

/** Reconstruct a no-product grouping only from the owning claim's captured inputs. */
export async function readImportVerificationGroupingCandidate(db: D1Database, runId: string, verifierId: string) {
  const row = await db.prepare(`SELECT r.source_album_id, r.scan_evidence_json, r.grouping_evidence_json
    FROM import_verification_claims v JOIN import_runs r ON r.id=v.import_run_id
    WHERE v.import_run_id=? AND v.verifier_id=? AND v.completed IS NULL AND v.origin_workflow_id=?
      AND r.source_album_id=v.source_album_id AND r.status='running' AND r.trigger='line'
      AND r.settings_context_json=v.context_json AND json_valid(v.context_json)
      AND json_extract(v.context_json,'$.replyGroupId')=v.group_id
      AND NOT EXISTS (SELECT 1 FROM product_groups g WHERE g.import_run_id=r.id)`)
    .bind(runId, verifierId, importWorkflowId(runId)).first<{source_album_id:string; scan_evidence_json:string; grouping_evidence_json:string}>();
  if (!row) return null;
  const photoSchema = z.object({applePhotoId:z.string().min(1), position:z.number().int().nonnegative(), captureAt:z.string().nullable(), mediaType:z.literal('image/jpeg')});
  const factsSchema = z.object({version:z.literal(1), savedCheckpoint:z.number().int().nonnegative().nullable(), firstImportCutoffDate:z.string().nullable(), countedIgnoreMarkerIds:z.array(z.string().min(1)).optional(), ignoredGroupCount:z.number().int().nonnegative(), checkpointPosition:z.number().int(), orphanRange:z.object({firstApplePhotoId:z.string(),lastApplePhotoId:z.string(),count:z.number().int().positive()}).nullable()});
  let scan: z.infer<typeof photoSchema>[], facts: z.infer<typeof factsSchema>;
  try { scan = z.array(photoSchema).nonempty().parse(JSON.parse(row.scan_evidence_json)); facts = factsSchema.parse(JSON.parse(row.grouping_evidence_json)); } catch { return null; }
  if (new Set(scan.map(p => p.applePhotoId)).size !== scan.length || new Set(scan.map(p => p.position)).size !== scan.length) return null;
  const checkpoint = await db.prepare('SELECT last_position FROM import_checkpoints WHERE source_album_id=?').bind(row.source_album_id).first<{last_position:number}>();
  if ((checkpoint?.last_position ?? null) !== facts.savedCheckpoint) return null;
  const eligible = scan.filter(p => facts.firstImportCutoffDate === null || (p.captureAt !== null && p.captureAt >= facts.firstImportCutoffDate)).sort((a,b) => a.position-b.position);
  const photos = [];
  const countedBefore = new Set(await countedIgnoreMarkerIds(db, row.source_album_id, runId));
  const countedIds: string[] = [];
  let markerId = '', ignoredGroupCount = 0, uncounted = false;
  for (const photo of eligible) {
    const assets = (await db.prepare('SELECT * FROM photo_assets WHERE source_album_id=? AND apple_photo_id=?').bind(row.source_album_id, photo.applePhotoId).all()).results;
    if (assets.length !== 1) return null;
    const parsed = PhotoAssetDbRowSchema.safeParse(assets[0]);
    if (!parsed.success) return null;
    const asset = toAssetRow(parsed.data);
    if (parsed.data.marker_kind === null || parsed.data.is_marker !== (parsed.data.marker_kind === 'product_start' ? 1 : 0)) return null;
    if (asset.markerKind === 'product_start') uncounted = false;
    if (asset.markerKind === 'ignore_start') { markerId = photo.applePhotoId; uncounted = photo.position > (facts.savedCheckpoint ?? -1) && (!facts.countedIgnoreMarkerIds || !countedBefore.has(markerId)); }
    if (asset.markerKind === 'none' && uncounted) { ignoredGroupCount++; countedIds.push(markerId); uncounted = false; }
    photos.push({applePhotoId:photo.applePhotoId, position:photo.position, markerKind:asset.markerKind, isMarker:asset.isMarker, r2Key:asset.r2Key});
  }
  const {groups, orphanPhotos} = groupByMarkers(photos);
  const orphanRange = orphanPhotos.length ? {firstApplePhotoId:orphanPhotos[0]!.applePhotoId,lastApplePhotoId:orphanPhotos[orphanPhotos.length-1]!.applePhotoId,count:orphanPhotos.length} : null;
  const checkpointPosition = scan.reduce((max,p) => Math.max(max,p.position), facts.savedCheckpoint ?? -1);
  if (groups.length || (facts.countedIgnoreMarkerIds && JSON.stringify(countedIds) !== JSON.stringify(facts.countedIgnoreMarkerIds)) || ignoredGroupCount !== facts.ignoredGroupCount || checkpointPosition !== facts.checkpointPosition || JSON.stringify(orphanRange) !== JSON.stringify(facts.orphanRange)) return null;
  return {...facts, scanEvidenceJson:row.scan_evidence_json, groupingEvidenceJson:row.grouping_evidence_json, photos};
}

/** Read only complete candidate identities belonging to the active verifier and captured target. */
export async function readImportVerificationCandidates(db: D1Database, runId: string, verifierId: string) {
  const rows = await db.prepare(`SELECT g.id, g.group_hash, g.product_id, g.airtable_record_id, g.created_at, r.source_album_id
    FROM import_verification_claims v JOIN import_runs r ON r.id=v.import_run_id
    JOIN product_groups g ON g.import_run_id=r.id
    JOIN airtable_create_claims c ON c.group_id=g.id AND c.product_id=g.product_id
      AND c.base_id=json_extract(v.context_json, '$.settings.config.airtableBaseId')
      AND c.table_id=json_extract(v.context_json, '$.settings.config.airtableProductsTableId')
    WHERE v.import_run_id=? AND v.verifier_id=? AND v.completed IS NULL
      AND v.origin_workflow_id=? AND r.source_album_id=v.source_album_id AND r.status='running' AND r.trigger='line'
      AND r.settings_context_json=v.context_json AND json_valid(v.context_json)
      AND json_extract(v.context_json, '$.replyGroupId')=v.group_id
      AND length(g.product_id)>0 AND length(g.airtable_record_id)>0`)
    .bind(runId, verifierId, importWorkflowId(runId)).all<{id:string; group_hash:string; product_id:string; airtable_record_id:string; created_at:string; source_album_id:string}>();
  const candidates = [];
  for (const row of rows.results) {
    const members = (await db.prepare(`SELECT ordinal, apple_photo_id, r2_key FROM product_group_image_members WHERE group_id=? ORDER BY ordinal`)
      .bind(row.id).all<{ordinal:number; apple_photo_id:string; r2_key:string | null}>()).results;
    if (!members.length || members.some((m, i) => m.ordinal !== i || !m.apple_photo_id || !m.r2_key)) continue;
    if (await computeGroupHash(row.source_album_id, members.map(m => ({applePhotoId:m.apple_photo_id}))) !== row.group_hash) continue;
    candidates.push({groupId:row.id, productId:row.product_id, recordId:row.airtable_record_id, groupHash:row.group_hash, createdAt:row.created_at, members});
  }
  return candidates;
}

/** Admit one verifier only while the captured LINE run owns the album lock. */
export async function claimImportVerification(db: D1Database, input: { runId: string; albumId: string; workflowId: string; groupId: string; contextJson: string }): Promise<boolean> {
  if (!input.runId || input.workflowId !== importWorkflowId(input.runId)) return false;
  const result = await db.prepare(`INSERT INTO import_verification_claims
    (import_run_id, source_album_id, origin_workflow_id, group_id, context_json, verifier_id)
    SELECT id, source_album_id, ?, ?, settings_context_json, ? FROM import_runs
    WHERE id=? AND source_album_id=? AND trigger='line' AND status='running'
      AND settings_context_json=?
      AND json_valid(settings_context_json) AND json_extract(settings_context_json, '$.replyGroupId')=?
    ON CONFLICT DO NOTHING`)
    .bind(input.workflowId, input.groupId, `import-verification-${input.runId}`, input.runId, input.albumId, input.contextJson, input.groupId).run();
  return result.meta.changes === 1;
}

export async function renewImportVerification(db: D1Database, input: { runId: string; albumId: string; workflowId: string; groupId: string; contextJson: string }, previousId: string): Promise<string | null> {
  const verifierId = `import-verification-${crypto.randomUUID()}`;
  const row = await db.prepare(`UPDATE import_verification_claims SET verifier_id=?
    WHERE import_run_id=? AND source_album_id=? AND origin_workflow_id=? AND group_id=? AND context_json=? AND verifier_id=? AND completed IS NULL
      AND EXISTS (SELECT 1 FROM import_runs r WHERE r.id=import_verification_claims.import_run_id AND r.source_album_id=import_verification_claims.source_album_id AND r.trigger='line' AND r.status='running' AND r.settings_context_json=import_verification_claims.context_json AND json_valid(r.settings_context_json) AND json_extract(r.settings_context_json,'$.replyGroupId')=import_verification_claims.group_id)
    RETURNING verifier_id`).bind(verifierId, input.runId, input.albumId, input.workflowId, input.groupId, input.contextJson, previousId).first();
  return row ? verifierId : null;
}

export async function completeImportVerification(
  db: D1Database,
  input: { runId: string; albumId: string; workflowId: string; groupId: string; contextJson: string },
  verifierId: string,
  result: TerminalResultV1,
  empty = false,
  grouping?: NonNullable<Awaited<ReturnType<typeof readImportVerificationGroupingCandidate>>>,
): Promise<boolean> {
  validateReplyMessages(result.messages);
  if (!input.runId || !input.groupId || input.workflowId !== importWorkflowId(input.runId) || !verifierId ||
    result.schemaVersion !== 1 || result.kind !== 'import' || result.runId !== input.runId ||
    result.generation !== 1 || result.notificationCycle !== 1 || ((empty || grouping) && result.outcome !== 'success') ||
    !['success', 'partial', 'validation_failed', 'failed', 'unconfirmed'].includes(result.outcome)) throw new Error('verification_invalid_result');
  const update = db.prepare(`UPDATE import_verification_claims SET completed=1, result_json=?
    WHERE import_run_id=? AND source_album_id=? AND origin_workflow_id=? AND group_id=? AND context_json=? AND verifier_id=?
      AND completed IS NULL AND result_json IS NULL
      AND EXISTS (SELECT 1 FROM import_runs r WHERE r.id=import_verification_claims.import_run_id
        AND r.source_album_id=import_verification_claims.source_album_id AND r.trigger='line' AND r.status='running'
        AND r.settings_context_json=import_verification_claims.context_json AND json_valid(r.settings_context_json)
        AND json_extract(r.settings_context_json,'$.replyGroupId')=import_verification_claims.group_id
        ${empty ? `AND CASE WHEN json_valid(r.scan_evidence_json) THEN json_type(r.scan_evidence_json)='array' AND json_array_length(r.scan_evidence_json)=0 ELSE 0 END
        AND NOT EXISTS (SELECT 1 FROM product_groups g WHERE g.import_run_id=r.id)
        AND NOT EXISTS (SELECT 1 FROM photo_assets a WHERE a.import_run_id=r.id)` : ''}
        ${grouping ? `AND r.scan_evidence_json=? AND r.grouping_evidence_json=?
        AND (SELECT last_position FROM import_checkpoints WHERE source_album_id=r.source_album_id) IS ?
        AND NOT EXISTS (SELECT 1 FROM product_groups g WHERE g.import_run_id=r.id)
        AND NOT EXISTS (SELECT 1 FROM product_groups g JOIN import_runs gr ON gr.id=g.import_run_id JOIN json_each(?) p ON g.first_photo_id=json_extract(p.value,'$.applePhotoId') OR g.last_photo_id=json_extract(p.value,'$.applePhotoId') OR EXISTS (SELECT 1 FROM product_group_image_members m WHERE m.group_id=g.id AND m.apple_photo_id=json_extract(p.value,'$.applePhotoId')) WHERE gr.source_album_id=r.source_album_id)
        AND NOT EXISTS (SELECT 1 FROM json_each(?) p WHERE NOT EXISTS (SELECT 1 FROM photo_assets a
          WHERE a.source_album_id=r.source_album_id AND a.apple_photo_id=json_extract(p.value,'$.applePhotoId')
            AND a.marker_kind=json_extract(p.value,'$.markerKind') AND a.is_marker=json_extract(p.value,'$.isMarker')
            AND a.r2_key IS json_extract(p.value,'$.r2Key'))) ` : ''})`)
    .bind(JSON.stringify(result), input.runId, input.albumId, input.workflowId, input.groupId, input.contextJson, verifierId, ...(grouping ? [grouping.scanEvidenceJson, grouping.groupingEvidenceJson, grouping.savedCheckpoint, JSON.stringify(grouping.photos), JSON.stringify(grouping.photos)] : []));
  const insert = db.prepare(`INSERT INTO line_result_outbox(result_key,group_id,result_json,created_at)
    SELECT ?, group_id, result_json, ? FROM import_verification_claims
    WHERE import_run_id=? AND verifier_id=? AND changes()=1
    ON CONFLICT(result_key) DO UPDATE SET group_id=CASE WHEN group_id=excluded.group_id AND result_json=excluded.result_json THEN group_id ELSE NULL END`)
    .bind(JSON.stringify(['import', input.runId, 1, 1, 'verification']), new Date().toISOString(), input.runId, verifierId);
  const terminal = db.prepare(`UPDATE import_runs SET status='completed', finished_at=?, orphan_photo_count=?,
    checkpoint_position=(SELECT last_position FROM import_checkpoints WHERE source_album_id=import_runs.source_album_id), failure_reason=NULL
    WHERE id=? AND changes()=1`).bind(new Date().toISOString(), grouping?.orphanRange?.count ?? 0, input.runId);
  const [updated] = await db.batch(empty || grouping ? [update, terminal, insert] : [update, insert]);
  return updated!.meta.changes === 1;
}

export async function completeEmptyImportVerification(
  db: D1Database, input: { runId: string; albumId: string; workflowId: string; groupId: string; contextJson: string },
  verifierId: string, result: TerminalResultV1,
): Promise<boolean> {
  return completeImportVerification(db, input, verifierId, result, true);
}
