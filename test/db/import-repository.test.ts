import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";
import { createImportRepository } from "../../src/db/import-repository";
import { fixedClock, sequentialIdGenerator } from "../helpers/fakes";

function repo() {
  return createImportRepository(testEnv().DB, sequentialIdGenerator("row"), fixedClock("2026-09-01T09:00:00.000Z"));
}

describe("import-repository", () => {
  it("creates a running import run and reports it as running", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();
    await r.createImportRun({ id: runId, sourceAlbumId: albumId, trigger: "cron" });
    expect(await r.hasRunningImportRun(albumId)).toBe(true);
    await r.finalizeImportRun({
      id: runId,
      sourceAlbumId: albumId,
      status: "completed",
      orphanPhotoCount: 0,
      checkpointPosition: 42,
    });
    expect(await r.hasRunningImportRun(albumId)).toBe(false);
    expect(await r.getCheckpoint(albumId)).toBe(42);
  });

  it("marks a running import run as start_failed", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();
    await r.createImportRun({ id: runId, sourceAlbumId: albumId, trigger: "cron" });

    await r.markImportRunStartFailed(runId);

    expect(await r.hasRunningImportRun(albumId)).toBe(false);
  });

  it("terminalizes a failed workflow run without advancing its checkpoint", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();
    await r.createImportRun({
      id: runId,
      sourceAlbumId: albumId,
      trigger: "cron",
    });

    await r.failImportRun({
      id: runId,
      sourceAlbumId: albumId,
      failureReason: "icloud_invalid_webstream_response",
    });

    expect(await r.hasRunningImportRun(albumId)).toBe(false);
    expect(await r.getCheckpoint(albumId)).toBeNull();
    expect(
      await testEnv()
        .DB.prepare(
          `SELECT status, failure_reason, checkpoint_position
           FROM import_runs WHERE id = ?`,
        )
        .bind(runId)
        .first(),
    ).toEqual({
      status: "completed_with_failures",
      failure_reason: "icloud_invalid_webstream_response",
      checkpoint_position: null,
    });
  });

  it("does not let a stale workflow failure overwrite a completed run", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();
    await r.createImportRun({
      id: runId,
      sourceAlbumId: albumId,
      trigger: "cron",
    });
    await r.finalizeImportRun({
      id: runId,
      sourceAlbumId: albumId,
      status: "completed",
      orphanPhotoCount: 0,
      checkpointPosition: 42,
    });

    await expect(
      r.failImportRun({
        id: runId,
        sourceAlbumId: albumId,
        failureReason: "icloud_invalid_webstream_response",
      }),
    ).rejects.toThrow(/cannot fail import run/);

    expect(await r.getCheckpoint(albumId)).toBe(42);
    expect(
      await testEnv()
        .DB.prepare(
          `SELECT status, failure_reason, checkpoint_position
           FROM import_runs WHERE id = ?`,
        )
        .bind(runId)
        .first(),
    ).toEqual({
      status: "completed",
      failure_reason: null,
      checkpoint_position: 42,
    });
  });

  it("refuses finalization and checkpoint advancement while a group is non-terminal", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();
    await r.createImportRun({ id: runId, sourceAlbumId: albumId, trigger: "cron" });
    await r.upsertPendingGroup({
      id: crypto.randomUUID(), importRunId: runId, ordinal: 0, groupHash: `hash-${crypto.randomUUID()}`,
      firstPhotoId: "apple-1", lastPhotoId: "apple-2",
    });

    await expect(r.finalizeImportRun({
      id: runId, sourceAlbumId: albumId, status: "completed", orphanPhotoCount: 0, checkpointPosition: 42,
    })).rejects.toThrow(/cannot finalize import run/);
    expect(await r.hasRunningImportRun(albumId)).toBe(true);
    expect(await r.getCheckpoint(albumId)).toBeNull();
  });

  it("refuses stale, mismatched, and already-finished finalization without moving a checkpoint", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();
    await r.createImportRun({ id: runId, sourceAlbumId: albumId, trigger: "cron" });

    await expect(r.finalizeImportRun({
      id: runId, sourceAlbumId: `${albumId}-wrong`, status: "completed", orphanPhotoCount: 0, checkpointPosition: 42,
    })).rejects.toThrow(/cannot finalize import run/);
    expect(await r.getCheckpoint(`${albumId}-wrong`)).toBeNull();
    await expect(r.finalizeImportRun({
      id: crypto.randomUUID(), sourceAlbumId: albumId, status: "completed", orphanPhotoCount: 0, checkpointPosition: 42,
    })).rejects.toThrow(/cannot finalize import run/);
    expect(await r.getCheckpoint(albumId)).toBeNull();

    await r.finalizeImportRun({
      id: runId, sourceAlbumId: albumId, status: "completed", orphanPhotoCount: 0, checkpointPosition: 42,
    });
    await expect(r.finalizeImportRun({
      id: runId, sourceAlbumId: albumId, status: "completed", orphanPhotoCount: 0, checkpointPosition: 99,
    })).rejects.toThrow(/cannot finalize import run/);
    expect(await r.getCheckpoint(albumId)).toBe(42);
  });

  it("accepts an identical terminal finalization retry after the first batch committed", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();
    const finalization = {
      id: runId,
      sourceAlbumId: albumId,
      status: "completed_with_failures" as const,
      orphanPhotoCount: 2,
      checkpointPosition: 42,
    };
    await r.createImportRun({
      id: runId,
      sourceAlbumId: albumId,
      trigger: "cron",
    });

    await r.finalizeImportRun(finalization);
    await expect(r.finalizeImportRun(finalization)).resolves.toBeUndefined();

    expect(await r.getCheckpoint(albumId)).toBe(42);
  });

  it("rejects a conflicting terminal finalization retry without moving the checkpoint", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();
    await r.createImportRun({
      id: runId,
      sourceAlbumId: albumId,
      trigger: "cron",
    });
    await r.finalizeImportRun({
      id: runId,
      sourceAlbumId: albumId,
      status: "completed",
      orphanPhotoCount: 0,
      checkpointPosition: 42,
    });

    await expect(
      r.finalizeImportRun({
        id: runId,
        sourceAlbumId: albumId,
        status: "completed_with_failures",
        orphanPhotoCount: 1,
        checkpointPosition: 99,
      }),
    ).rejects.toThrow(/cannot finalize import run/);

    expect(await r.getCheckpoint(albumId)).toBe(42);
  });

  it("keeps checkpoints monotonic across completed runs", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    const firstRunId = crypto.randomUUID();
    await r.createImportRun({ id: firstRunId, sourceAlbumId: albumId, trigger: "cron" });
    await r.finalizeImportRun({
      id: firstRunId, sourceAlbumId: albumId, status: "completed", orphanPhotoCount: 0, checkpointPosition: 42,
    });
    const secondRunId = crypto.randomUUID();
    await r.createImportRun({ id: secondRunId, sourceAlbumId: albumId, trigger: "line" });
    await r.finalizeImportRun({
      id: secondRunId, sourceAlbumId: albumId, status: "completed", orphanPhotoCount: 0, checkpointPosition: 7,
    });

    expect(await r.getCheckpoint(albumId)).toBe(42);
  });

  it("rejects a second running import for the same album at the database boundary", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    await r.createImportRun({ id: crypto.randomUUID(), sourceAlbumId: albumId, trigger: "cron" });

    await expect(
      r.createImportRun({ id: crypto.randomUUID(), sourceAlbumId: albumId, trigger: "line" }),
    ).rejects.toThrow();
  });

  it("records a photo asset and finds it by apple photo id and by content hash", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();
    await r.createImportRun({ id: runId, sourceAlbumId: albumId, trigger: "cron" });
    await r.recordPhotoAsset({
      id: crypto.randomUUID(), sourceAlbumId: albumId, applePhotoId: "apple-1",
      contentHash: "hash-1", r2Key: "assets/hash-1.jpg", position: 1, isMarker: false, markerKind: "none", importRunId: runId,
    });

    const byApple = await r.findAssetByApplePhotoId(albumId, "apple-1");
    expect(byApple?.r2Key).toBe("assets/hash-1.jpg");
    const byHash = await r.findAssetByContentHash("hash-1");
    expect(byHash?.applePhotoId).toBe("apple-1");
  });

  it("upsertPendingGroup is idempotent by group hash and preserves existing state", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();
    await r.createImportRun({ id: runId, sourceAlbumId: albumId, trigger: "cron" });
    const groupHash = `hash-${crypto.randomUUID()}`;

    const first = await r.upsertPendingGroup({ id: crypto.randomUUID(), importRunId: runId, ordinal: 0, groupHash, firstPhotoId: "apple-1", lastPhotoId: "apple-9" });
    expect(first.state).toBe("pending");

    await r.setGroupState(first.id, "succeeded", { productId: "A-501", airtableRecordId: "rec123" });
    await r.finalizeImportRun({
      id: runId,
      sourceAlbumId: albumId,
      status: "completed",
      orphanPhotoCount: 0,
      checkpointPosition: 9,
    });
    const secondRunId = crypto.randomUUID();
    await r.createImportRun({ id: secondRunId, sourceAlbumId: albumId, trigger: "line" });

    const second = await r.upsertPendingGroup({ id: crypto.randomUUID(), importRunId: secondRunId, ordinal: 0, groupHash, firstPhotoId: "apple-1", lastPhotoId: "apple-9" });
    expect(second.id).toBe(first.id);
    expect(second.state).toBe("succeeded");
    expect(second.productId).toBe("A-501");
  });

  it("setGroupState updates failureReason and attemptCount independently", async () => {
    const r = repo();
    const runId = crypto.randomUUID();
    await r.createImportRun({ id: runId, sourceAlbumId: `album-${crypto.randomUUID()}`, trigger: "cron" });
    const group = await r.upsertPendingGroup({ id: crypto.randomUUID(), importRunId: runId, ordinal: 0, groupHash: `hash-${crypto.randomUUID()}`, firstPhotoId: "apple-1", lastPhotoId: "apple-2" });

    await r.setGroupState(group.id, "failed", { failureReason: "airtable_timeout", attemptCount: 1 });
    const failed = await r.findGroupByHash(group.groupHash);
    expect(failed).toMatchObject({ state: "failed", failureReason: "airtable_timeout", attemptCount: 1 });
  });

  it("preserves failureReason when setGroupState omits it", async () => {
    const r = repo();
    const runId = crypto.randomUUID();
    await r.createImportRun({ id: runId, sourceAlbumId: `album-${crypto.randomUUID()}`, trigger: "cron" });
    const group = await r.upsertPendingGroup({ id: crypto.randomUUID(), importRunId: runId, ordinal: 0, groupHash: `hash-${crypto.randomUUID()}`, firstPhotoId: "apple-1", lastPhotoId: "apple-2" });
    await r.setGroupState(group.id, "failed", { failureReason: "airtable_timeout" });

    await r.setGroupState(group.id, "failed", { attemptCount: 2 });

    expect(await r.findGroupByHash(group.groupHash)).toMatchObject({ failureReason: "airtable_timeout", attemptCount: 2 });
  });

  it("clears failureReason only when setGroupState explicitly receives null", async () => {
    const r = repo();
    const runId = crypto.randomUUID();
    await r.createImportRun({ id: runId, sourceAlbumId: `album-${crypto.randomUUID()}`, trigger: "cron" });
    const group = await r.upsertPendingGroup({ id: crypto.randomUUID(), importRunId: runId, ordinal: 0, groupHash: `hash-${crypto.randomUUID()}`, firstPhotoId: "apple-1", lastPhotoId: "apple-2" });
    await r.setGroupState(group.id, "failed", { failureReason: "airtable_timeout" });

    await r.setGroupState(group.id, "failed", { failureReason: null });

    expect(await r.findGroupByHash(group.groupHash)).toMatchObject({ failureReason: null });
  });

  it("resets an exhausted group only when a later import run sees the same group hash", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    const firstRunId = crypto.randomUUID();
    const secondRunId = crypto.randomUUID();
    const groupHash = `hash-${crypto.randomUUID()}`;
    await r.createImportRun({
      id: firstRunId,
      sourceAlbumId: albumId,
      trigger: "cron",
    });

    const first = await r.upsertPendingGroup({
      id: crypto.randomUUID(),
      importRunId: firstRunId,
      ordinal: 0,
      groupHash,
      firstPhotoId: "m1",
      lastPhotoId: "p9",
    });
    await r.setGroupState(first.id, "failed", {
      productId: "TASK13-A-501",
      airtableRecordId: "rec-partial",
      failureReason: "airtable_rate_limited",
      attemptCount: 6,
    });

    const sameRun = await r.upsertPendingGroup({
      id: crypto.randomUUID(),
      importRunId: firstRunId,
      ordinal: 0,
      groupHash,
      firstPhotoId: "m1",
      lastPhotoId: "p9",
    });
    expect(sameRun).toMatchObject({
      id: first.id,
      state: "failed",
      productId: "TASK13-A-501",
      airtableRecordId: "rec-partial",
      attemptCount: 6,
    });

    await r.finalizeImportRun({
      id: firstRunId,
      sourceAlbumId: albumId,
      status: "completed_with_failures",
      orphanPhotoCount: 0,
      checkpointPosition: 9,
    });
    await r.createImportRun({
      id: secondRunId,
      sourceAlbumId: albumId,
      trigger: "line",
    });

    const retried = await r.upsertPendingGroup({
      id: crypto.randomUUID(),
      importRunId: secondRunId,
      ordinal: 1,
      groupHash,
      firstPhotoId: "m1-new",
      lastPhotoId: "p9-new",
    });

    expect(retried).toMatchObject({
      id: first.id,
      importRunId: secondRunId,
      ordinal: 1,
      firstPhotoId: "m1-new",
      lastPhotoId: "p9-new",
      state: "pending",
      productId: null,
      airtableRecordId: null,
      attemptCount: 0,
      failureReason: null,
    });
  });
});

it("persists skipped metadata and only reuses real R2 objects by hash", async () => {
  const r = repo();
  const sourceAlbumId = `album-${crypto.randomUUID()}`;
  const importRunId = crypto.randomUUID();
  const hash = crypto.randomUUID();
  await r.createImportRun({ id: importRunId, sourceAlbumId, trigger: "line" });
  await r.recordPhotoAsset({ id: crypto.randomUUID(), sourceAlbumId,
    applePhotoId: "ignored", contentHash: hash, r2Key: null,
    markerKind: "none", position: 1, isMarker: false, importRunId });
  expect((await r.findAssetByApplePhotoId(sourceAlbumId, "ignored"))?.r2Key).toBeNull();
  expect(await r.findAssetByContentHash(hash)).toBeNull();
  await r.recordPhotoAsset({ id: crypto.randomUUID(), sourceAlbumId,
    applePhotoId: "stored", contentHash: hash, r2Key: `assets/${hash}.jpg`,
    markerKind: "none", position: 2, isMarker: false, importRunId });
  expect((await r.findAssetByContentHash(hash))?.applePhotoId).toBe("stored");
  await r.setAssetR2Key(sourceAlbumId, "ignored", `assets/${hash}.jpg`);
  expect((await r.findAssetByApplePhotoId(sourceAlbumId, "ignored"))?.r2Key).toBe(`assets/${hash}.jpg`);
  await expect(r.setAssetR2Key(sourceAlbumId, "missing", "assets/missing.jpg")).rejects.toThrow();
});

it.each([[1, "product_start"], [0, "none"]] as const)("reads old-worker rows with is_marker %s as %s", async (flag, kind) => {
  const r = repo();
  const sourceAlbumId = `album-${crypto.randomUUID()}`;
  const importRunId = crypto.randomUUID();
  await r.createImportRun({ id: importRunId, sourceAlbumId, trigger: "line" });
  await testEnv().DB.prepare(`INSERT INTO photo_assets (id, source_album_id, apple_photo_id, content_hash, r2_key, position, is_marker, import_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), sourceAlbumId, "legacy", crypto.randomUUID(), "assets/legacy.jpg", 1, flag, importRunId, "2026-10-08T00:00:00Z").run();
  expect((await r.findAssetByApplePhotoId(sourceAlbumId, "legacy"))?.markerKind).toBe(kind);
});
