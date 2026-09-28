import { describe, expect, it, vi } from "vitest";
import {
  computeGroupHash,
  groupByMarkers,
  type GroupingPhoto,
} from "../../src/import/grouping";
import {
  downloadAndGroupSnapshot,
  type ImportServiceDeps,
  type ProcessGroupDeps,
} from "../../src/import/service";
import { runImportWorkflow } from "../../src/import/workflow";
import { createImportRepository } from "../../src/db/import-repository";
import { createSequenceRepository } from "../../src/db/sequence-repository";
import { createAssetStore } from "../../src/import/asset-store";
import { testEnv } from "../helpers/env";
import { fixedClock, sequentialIdGenerator } from "../helpers/fakes";
import { buildGroupingPhotos } from "../helpers/fixtures";
import { MutableBatchSource, fakeMarkerDetector } from "../helpers/import-fixtures";
import { retryingStep } from "../helpers/workflow-step";

function forwardedDeps(): ProcessGroupDeps {
  return Object.create(null) as ProcessGroupDeps;
}

async function downloadProductionBatch(
  sourceAlbumId: string,
  photos: GroupingPhoto[],
) {
  const importRunId = `run-${crypto.randomUUID()}`;
  const env = testEnv();
  const clock = fixedClock("2026-09-01T09:00:00.000Z");
  const deps: ImportServiceDeps = {
    imageSource: new MutableBatchSource(
      sourceAlbumId,
      photos.map(({ applePhotoId, isMarker }) => ({
        id: applePhotoId,
        isMarker,
      })),
    ),
    marker: fakeMarkerDetector,
    repo: createImportRepository(
      env.DB,
      sequentialIdGenerator(`batch-${crypto.randomUUID()}`),
      clock,
    ),
    assets: createAssetStore(
      env.IMAGES_BUCKET,
      {
        signingSecret: "test-secret",
        publicBaseUrl: "https://example.workers.dev",
      },
      clock,
    ),
    clock,
    ids: sequentialIdGenerator(`batch-${crypto.randomUUID()}`),
    sourceAlbumId,
    firstImportCutoffDate: null,
  };

  await deps.repo.createImportRun({
    id: importRunId,
    sourceAlbumId,
    trigger: "admin",
  });
  return downloadAndGroupSnapshot(deps, importRunId);
}

const batches = [
  {
    name: "100 photos with minimum nine-photo products",
    groupSizes: Array(10).fill(9),
    orphanPhotoCount: 0,
  },
  {
    name: "500 photos with maximum fifteen-photo products",
    groupSizes: Array(31).fill(15),
    orphanPhotoCount: 4,
  },
  {
    name: "mixed sizes nine through fifteen",
    groupSizes: Array.from(
      { length: 20 },
      (_, index) => 9 + (index % 7),
    ),
    orphanPhotoCount: 0,
  },
  {
    name: "twelve even twelve-photo products",
    groupSizes: Array(12).fill(12),
    orphanPhotoCount: 0,
  },
  {
    name: "eight pre-marker orphan photos",
    groupSizes: Array(12).fill(12),
    orphanPhotoCount: 8,
  },
  {
    name: "100-photo boundary with one orphan",
    groupSizes: Array(9).fill(10),
    orphanPhotoCount: 1,
  },
  {
    name: "twenty-five eleven-photo products",
    groupSizes: Array(25).fill(11),
    orphanPhotoCount: 0,
  },
  {
    name: "alternating nine and fifteen photo products",
    groupSizes: Array.from(
      { length: 16 },
      (_, index) => index % 2 === 0 ? 9 : 15,
    ),
    orphanPhotoCount: 0,
  },
  {
    name: "normal twenty-two-product day",
    groupSizes: Array(22).fill(12),
    orphanPhotoCount: 0,
  },
  {
    name: "494-photo large day",
    groupSizes: Array(38).fill(12),
    orphanPhotoCount: 0,
  },
] satisfies Array<{
  name: string;
  groupSizes: number[];
  orphanPhotoCount: number;
}>;

describe.each(batches)("import batch: $name", (batch) => {
  it("preserves marker groups, stable hashes, and one Product ID per group", async () => {
    const photos = buildGroupingPhotos(batch);
    expect(photos.length).toBeGreaterThanOrEqual(100);
    expect(photos.length).toBeLessThanOrEqual(500);

    const grouped = groupByMarkers(photos);
    expect(grouped.orphanPhotos).toHaveLength(batch.orphanPhotoCount);
    expect(grouped.groups).toHaveLength(batch.groupSizes.length);
    expect(grouped.groups.map(({ photos: groupPhotos }) => groupPhotos.length))
      .toEqual(batch.groupSizes.map((size) => size + 1));

    const groupedIds = grouped.groups.flatMap(({ photos: groupPhotos }) =>
      groupPhotos.map(({ applePhotoId }) => applePhotoId));
    expect(new Set(groupedIds).size).toBe(groupedIds.length);

    const sourceAlbumId = `batch-${crypto.randomUUID()}`;
    const hashes = await Promise.all(
      grouped.groups.map(({ photos: groupPhotos }) =>
        computeGroupHash(sourceAlbumId, groupPhotos)),
    );
    expect(new Set(hashes).size).toBe(hashes.length);

    const outcome = await downloadProductionBatch(sourceAlbumId, photos);
    const markerIds = new Set(
      photos.filter(({ isMarker }) => isMarker).map(({ applePhotoId }) => applePhotoId),
    );
    expect(outcome.pendingGroups.map(({ groupId }) => groupId)).toEqual(hashes);
    expect(outcome.pendingGroups.map(({ attachablePhotos }) => attachablePhotos.length))
      .toEqual(batch.groupSizes);
    expect(
      outcome.pendingGroups.flatMap(({ attachablePhotos }) => attachablePhotos)
        .some(({ applePhotoId }) => markerIds.has(applePhotoId)),
    ).toBe(false);
    const notify = vi.fn().mockResolvedValue(undefined);
    const sequence = createSequenceRepository(testEnv().DB);
    await testEnv().DB.prepare("DELETE FROM sequences WHERE name = 'product_id'").run();
    await sequence.bootstrap("product_id", 1001);
    const result = await runImportWorkflow(
      forwardedDeps(),
      {
        importRunId: `run-${batch.name}`,
        sourceAlbumId,
        trigger: "admin",
      },
      retryingStep(),
      {
        retryLimit: 5,
        downloadAndGroup: async () => ({
          ...outcome,
        }),
        recordRunFailure: vi.fn(),
        processGroupAttempt: async (_deps, group) => ({
          outcome: "succeeded",
          productId: `A-${await sequence.allocateNext("product_id")}`,
        }),
        recordExhaustedFailure: vi.fn(),
        finalize: vi.fn().mockResolvedValue(undefined),
        notify,
      },
    );

    expect(result.failedGroups).toEqual([]);
    expect(result.succeededProductIds).toHaveLength(batch.groupSizes.length);
    expect(new Set(result.succeededProductIds).size).toBe(
      result.succeededProductIds.length,
    );
    expect(await sequence.allocateNext("product_id")).toBe(1001 + batch.groupSizes.length);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
