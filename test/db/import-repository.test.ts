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
      contentHash: "hash-1", r2Key: "assets/hash-1.jpg", position: 1, isMarker: false, importRunId: runId,
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
});
