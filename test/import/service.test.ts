import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";
import { fixedClock, sequentialIdGenerator } from "../helpers/fakes";
import { createImportRepository } from "../../src/db/import-repository";
import { createAssetStore } from "../../src/import/asset-store";
import {
  downloadAndGroupSnapshot,
  type ImportServiceDeps,
} from "../../src/import/service";
import type {
  AlbumSnapshot,
  ImageSource,
  SourcePhoto,
} from "../../src/icloud/types";
import type { MarkerDetector } from "../../src/import/marker";

function sourcePhoto(id: string, position: number): SourcePhoto {
  return {
    sourceAlbumId: "album-1",
    applePhotoId: id,
    position,
    captureAt: null,
    derivativeUrl: `https://icloud.example/${id}.jpg`,
    mediaType: "image/jpeg",
  };
}

function stubImageSource(
  snapshot: AlbumSnapshot,
  markerIds: Set<string>,
): ImageSource {
  return {
    async getSnapshot() {
      return snapshot;
    },
    async download(photo) {
      const label = markerIds.has(photo.applePhotoId) ? "marker" : "product";
      return new Response(
        new TextEncoder().encode(`${label}-${photo.applePhotoId}`),
        { headers: { "content-type": "image/jpeg" } },
      );
    },
  };
}

function stubMarker(): MarkerDetector {
  return {
    async detect(bytes) {
      return new TextDecoder().decode(bytes).startsWith("marker-");
    },
  };
}

async function buildDeps(
  sourceAlbumId: string,
  snapshot: AlbumSnapshot,
  markerIds: Set<string>,
): Promise<ImportServiceDeps> {
  const env = testEnv();
  const clock = fixedClock("2026-09-01T09:00:00.000Z");
  return {
    imageSource: stubImageSource(snapshot, markerIds),
    marker: stubMarker(),
    repo: createImportRepository(env.DB, sequentialIdGenerator("row"), clock),
    assets: createAssetStore(
      env.IMAGES_BUCKET,
      {
        signingSecret: "test-secret",
        publicBaseUrl: "https://example.workers.dev",
      },
      clock,
    ),
    clock,
    ids: sequentialIdGenerator(`${sourceAlbumId}-id`),
    sourceAlbumId,
    firstImportCutoffDate: null,
  };
}

describe("downloadAndGroupSnapshot", () => {
  it("downloads new photos, groups them, and excludes the marker from attachablePhotos", async () => {
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const importRunId = crypto.randomUUID();
    const snapshot: AlbumSnapshot = {
      sourceAlbumId,
      fetchedAt: "2026-09-01T08:00:00.000Z",
      photos: [
        sourcePhoto("m1", 1),
        sourcePhoto("p1", 2),
        sourcePhoto("p2", 3),
      ].map((photo) => ({ ...photo, sourceAlbumId })),
    };
    const deps = await buildDeps(sourceAlbumId, snapshot, new Set(["m1"]));
    await deps.repo.createImportRun({
      id: importRunId,
      sourceAlbumId,
      trigger: "cron",
    });

    const outcome = await downloadAndGroupSnapshot(deps, importRunId);

    expect(outcome.orphanRange).toBeNull();
    expect(outcome.checkpointPosition).toBe(3);
    expect(outcome.pendingGroups).toHaveLength(1);
    expect(outcome.pendingGroups[0]).toMatchObject({
      ordinal: 0,
      markerPhotoId: "m1",
      attachablePhotos: [
        { applePhotoId: "p1" },
        { applePhotoId: "p2" },
      ],
    });

    const stored = await deps.repo.listAssetsForAlbum(sourceAlbumId);
    expect(stored).toHaveLength(3);
    expect(stored.find((row) => row.applePhotoId === "m1")?.isMarker).toBe(
      true,
    );
  });

  it("skips photos already recorded for this album from a previous run", async () => {
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const previousRunId = crypto.randomUUID();
    const importRunId = crypto.randomUUID();
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const env = testEnv();
    const repo = createImportRepository(
      env.DB,
      sequentialIdGenerator("row"),
      clock,
    );
    await repo.createImportRun({
      id: previousRunId,
      sourceAlbumId,
      trigger: "cron",
    });
    await repo.recordPhotoAsset({
      id: "existing-1",
      sourceAlbumId,
      applePhotoId: "m1",
      contentHash: "hash-m1",
      r2Key: "assets/hash-m1.jpg",
      position: 1,
      isMarker: true,
      importRunId: previousRunId,
    });
    await repo.finalizeImportRun({
      id: previousRunId,
      sourceAlbumId,
      status: "completed",
      orphanPhotoCount: 0,
      checkpointPosition: 1,
    });

    const snapshot: AlbumSnapshot = {
      sourceAlbumId,
      fetchedAt: "2026-09-01T09:00:00.000Z",
      photos: [
        { ...sourcePhoto("m1", 1), sourceAlbumId },
        { ...sourcePhoto("p1", 2), sourceAlbumId },
      ],
    };
    const deps: ImportServiceDeps = {
      imageSource: stubImageSource(snapshot, new Set(["m1"])),
      marker: stubMarker(),
      repo,
      assets: createAssetStore(
        env.IMAGES_BUCKET,
        {
          signingSecret: "test-secret",
          publicBaseUrl: "https://example.workers.dev",
        },
        clock,
      ),
      clock,
      ids: sequentialIdGenerator(`${sourceAlbumId}-id`),
      sourceAlbumId,
      firstImportCutoffDate: null,
    };
    await repo.createImportRun({
      id: importRunId,
      sourceAlbumId,
      trigger: "cron",
    });

    await downloadAndGroupSnapshot(deps, importRunId);

    const stored = await repo.listAssetsForAlbum(sourceAlbumId);
    expect(stored.map((row) => row.applePhotoId)).toEqual(["m1", "p1"]);
  });

  it("reports photos before the first marker as an orphan range", async () => {
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const importRunId = crypto.randomUUID();
    const snapshot: AlbumSnapshot = {
      sourceAlbumId,
      fetchedAt: "2026-09-01T09:00:00.000Z",
      photos: [
        { ...sourcePhoto("stray1", 1), sourceAlbumId },
        { ...sourcePhoto("stray2", 2), sourceAlbumId },
        { ...sourcePhoto("m1", 3), sourceAlbumId },
        { ...sourcePhoto("p1", 4), sourceAlbumId },
      ],
    };
    const deps = await buildDeps(sourceAlbumId, snapshot, new Set(["m1"]));
    await deps.repo.createImportRun({
      id: importRunId,
      sourceAlbumId,
      trigger: "cron",
    });

    const outcome = await downloadAndGroupSnapshot(deps, importRunId);

    expect(outcome.orphanRange).toEqual({
      firstApplePhotoId: "stray1",
      lastApplePhotoId: "stray2",
      count: 2,
    });
    expect(outcome.pendingGroups).toHaveLength(1);
  });

  it("reuses one R2 object for identical product bytes under different Apple photo IDs", async () => {
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const importRunId = crypto.randomUUID();
    const snapshot: AlbumSnapshot = {
      sourceAlbumId,
      fetchedAt: "2026-09-01T09:00:00.000Z",
      photos: [
        { ...sourcePhoto("m1", 1), sourceAlbumId },
        { ...sourcePhoto("p1", 2), sourceAlbumId },
        { ...sourcePhoto("dup", 3), sourceAlbumId },
      ],
    };
    const imageSource: ImageSource = {
      async getSnapshot() {
        return snapshot;
      },
      async download(photo) {
        const body =
          photo.applePhotoId === "m1"
            ? "marker-m1"
            : "identical-product-bytes";
        return new Response(new TextEncoder().encode(body), {
          headers: { "content-type": "image/jpeg" },
        });
      },
    };
    const env = testEnv();
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const repo = createImportRepository(
      env.DB,
      sequentialIdGenerator("row"),
      clock,
    );
    await repo.createImportRun({ id: importRunId, sourceAlbumId, trigger: "cron" });
    const deps: ImportServiceDeps = {
      imageSource,
      marker: stubMarker(),
      repo,
      assets: createAssetStore(
        env.IMAGES_BUCKET,
        {
          signingSecret: "test-secret",
          publicBaseUrl: "https://example.workers.dev",
        },
        clock,
      ),
      clock,
      ids: sequentialIdGenerator(`${sourceAlbumId}-id`),
      sourceAlbumId,
      firstImportCutoffDate: null,
    };

    const outcome = await downloadAndGroupSnapshot(deps, importRunId);

    const stored = await repo.listAssetsForAlbum(sourceAlbumId);
    expect(stored).toHaveLength(3);
    expect(stored.find((row) => row.applePhotoId === "p1")?.r2Key).toBe(
      "assets/f287728a412fd6e2b865147a09fc1dc97b78406db4a339712a1cf25e4862407b.jpg",
    );
    expect(stored.find((row) => row.applePhotoId === "dup")?.r2Key).toBe(
      "assets/f287728a412fd6e2b865147a09fc1dc97b78406db4a339712a1cf25e4862407b.jpg",
    );
    expect(outcome.pendingGroups[0]?.attachablePhotos).toHaveLength(2);
  });

  it("applies FIRST_IMPORT_CUTOFF_DATE when no checkpoint exists", async () => {
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const importRunId = crypto.randomUUID();
    const snapshot: AlbumSnapshot = {
      sourceAlbumId,
      fetchedAt: "2026-09-01T09:00:00.000Z",
      photos: [
        {
          ...sourcePhoto("old", 1),
          sourceAlbumId,
          captureAt: "2026-08-31T23:59:59.000Z",
        },
        {
          ...sourcePhoto("m1", 2),
          sourceAlbumId,
          captureAt: "2026-09-01T00:00:00.000Z",
        },
        {
          ...sourcePhoto("p1", 3),
          sourceAlbumId,
          captureAt: "2026-09-01T00:01:00.000Z",
        },
      ],
    };
    const deps = await buildDeps(sourceAlbumId, snapshot, new Set(["m1"]));
    deps.firstImportCutoffDate = "2026-09-01T00:00:00.000Z";
    await deps.repo.createImportRun({
      id: importRunId,
      sourceAlbumId,
      trigger: "cron",
    });

    const outcome = await downloadAndGroupSnapshot(deps, importRunId);

    expect(
      (await deps.repo.listAssetsForAlbum(sourceAlbumId)).map(
        (row) => row.applePhotoId,
      ),
    ).toEqual(["m1", "p1"]);
    expect(outcome.pendingGroups).toHaveLength(1);
    expect(outcome.checkpointPosition).toBe(3);
  });

  it("rejects a snapshot whose safe album digest differs from the Workflow payload", async () => {
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const importRunId = crypto.randomUUID();
    const snapshot: AlbumSnapshot = {
      sourceAlbumId: "different-album-digest",
      fetchedAt: "2026-09-01T09:00:00.000Z",
      photos: [],
    };
    const deps = await buildDeps(sourceAlbumId, snapshot, new Set());
    await deps.repo.createImportRun({
      id: importRunId,
      sourceAlbumId,
      trigger: "cron",
    });

    await expect(
      downloadAndGroupSnapshot(deps, importRunId),
    ).rejects.toMatchObject({
      code: "source_album_identity_mismatch",
      retryable: false,
    });
  });

  it("keeps the cutoff as a lower bound while finding a prepended pair after checkpoint", async () => {
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const firstRunId = crypto.randomUUID();
    const firstSnapshot: AlbumSnapshot = {
      sourceAlbumId,
      fetchedAt: "2026-09-01T08:00:00.000Z",
      photos: [
        {
          ...sourcePhoto("historical", 1),
          sourceAlbumId,
          captureAt: "2026-08-31T23:59:59.000Z",
        },
        {
          ...sourcePhoto("m-old", 2),
          sourceAlbumId,
          captureAt: "2026-09-01T00:00:00.000Z",
        },
        {
          ...sourcePhoto("p-old", 3),
          sourceAlbumId,
          captureAt: "2026-09-01T00:01:00.000Z",
        },
      ],
    };
    const firstDeps = await buildDeps(
      sourceAlbumId,
      firstSnapshot,
      new Set(["m-old"]),
    );
    firstDeps.firstImportCutoffDate = "2026-09-01T00:00:00.000Z";
    await firstDeps.repo.createImportRun({
      id: firstRunId,
      sourceAlbumId,
      trigger: "cron",
    });
    const firstOutcome = await downloadAndGroupSnapshot(firstDeps, firstRunId);
    expect(firstOutcome.pendingGroups).toHaveLength(1);
    await firstDeps.repo.setGroupState(
      firstOutcome.pendingGroups[0]!.groupRowId,
      "succeeded",
    );
    await firstDeps.repo.finalizeImportRun({
      id: firstRunId,
      sourceAlbumId,
      status: "completed",
      orphanPhotoCount: 0,
      checkpointPosition: firstOutcome.checkpointPosition,
    });

    const secondRunId = crypto.randomUUID();
    const secondSnapshot: AlbumSnapshot = {
      sourceAlbumId,
      fetchedAt: "2026-09-01T09:00:00.000Z",
      photos: [
        {
          ...sourcePhoto("m-new", 1),
          sourceAlbumId,
          captureAt: "2026-09-01T00:02:00.000Z",
        },
        {
          ...sourcePhoto("p-new", 2),
          sourceAlbumId,
          captureAt: "2026-09-01T00:03:00.000Z",
        },
        {
          ...sourcePhoto("historical", 3),
          sourceAlbumId,
          captureAt: "2026-08-31T23:59:59.000Z",
        },
        {
          ...sourcePhoto("m-old", 4),
          sourceAlbumId,
          captureAt: "2026-09-01T00:00:00.000Z",
        },
        {
          ...sourcePhoto("p-old", 5),
          sourceAlbumId,
          captureAt: "2026-09-01T00:01:00.000Z",
        },
      ],
    };
    const secondImageSource: ImageSource = {
      async getSnapshot() {
        return secondSnapshot;
      },
      async download(photo) {
        if (photo.applePhotoId === "historical") {
          throw new Error("historical pre-cutoff photo was downloaded");
        }
        if (photo.applePhotoId === "m-old" || photo.applePhotoId === "p-old") {
          throw new Error(`old photo was downloaded: ${photo.applePhotoId}`);
        }
        const label = photo.applePhotoId === "m-new" ? "marker" : "product";
        return new Response(
          new TextEncoder().encode(`${label}-${photo.applePhotoId}`),
          { headers: { "content-type": "image/jpeg" } },
        );
      },
    };
    const secondDeps: ImportServiceDeps = {
      ...firstDeps,
      imageSource: secondImageSource,
      ids: sequentialIdGenerator(`${sourceAlbumId}-second-id`),
    };
    await secondDeps.repo.createImportRun({
      id: secondRunId,
      sourceAlbumId,
      trigger: "cron",
    });

    const secondOutcome = await downloadAndGroupSnapshot(
      secondDeps,
      secondRunId,
    );

    expect(secondOutcome.checkpointPosition).toBe(5);
    expect(secondOutcome.pendingGroups).toHaveLength(1);
    expect(secondOutcome.pendingGroups[0]).toMatchObject({
      ordinal: 0,
      markerPhotoId: "m-new",
      attachablePhotos: [{ applePhotoId: "p-new" }],
    });
    expect(
      (await secondDeps.repo.listAssetsForAlbum(sourceAlbumId))
        .map((row) => row.applePhotoId)
        .sort(),
    ).toEqual(["m-new", "m-old", "p-new", "p-old"]);
  });

  it("rejects adjacent markers before persisting any product groups", async () => {
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const importRunId = crypto.randomUUID();
    const snapshot: AlbumSnapshot = {
      sourceAlbumId,
      fetchedAt: "2026-09-01T09:00:00.000Z",
      photos: [
        { ...sourcePhoto("m1", 1), sourceAlbumId },
        { ...sourcePhoto("p1", 2), sourceAlbumId },
        { ...sourcePhoto("m2", 3), sourceAlbumId },
        { ...sourcePhoto("m3", 4), sourceAlbumId },
        { ...sourcePhoto("p3", 5), sourceAlbumId },
      ],
    };
    const deps = await buildDeps(
      sourceAlbumId,
      snapshot,
      new Set(["m1", "m2", "m3"]),
    );
    await deps.repo.createImportRun({
      id: importRunId,
      sourceAlbumId,
      trigger: "cron",
    });

    await expect(
      downloadAndGroupSnapshot(deps, importRunId),
    ).rejects.toMatchObject({
      code: "empty_product_group",
      retryable: false,
    });
    const groupCount = await testEnv()
      .DB.prepare(
        "SELECT COUNT(*) AS count FROM product_groups WHERE import_run_id = ?",
      )
      .bind(importRunId)
      .first<{ count: number }>();
    expect(groupCount).toEqual({ count: 0 });
  });
});
