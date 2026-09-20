import { describe, expect, it, vi } from "vitest";
import {
  computeGroupHash,
  groupByMarkers,
} from "../../src/import/grouping";
import type {
  PersistedGroup,
  ProcessGroupDeps,
} from "../../src/import/service";
import { runImportWorkflow } from "../../src/import/workflow";
import { buildGroupingPhotos } from "../helpers/fixtures";
import { retryingStep } from "../helpers/workflow-step";

function forwardedDeps(): ProcessGroupDeps {
  return Object.create(null) as ProcessGroupDeps;
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

    const hashes = await Promise.all(
      grouped.groups.map(({ photos: groupPhotos }) =>
        computeGroupHash("album-1", groupPhotos)),
    );
    expect(new Set(hashes).size).toBe(hashes.length);

    const pendingGroups: PersistedGroup[] = grouped.groups.map(
      (group, index) => ({
        groupId: hashes[index]!,
        groupRowId: `row-${index}`,
        ordinal: group.ordinal,
        markerPhotoId: group.photos[0]!.applePhotoId,
        attachablePhotos: group.photos
          .filter(({ isMarker }) => !isMarker)
          .map(({ applePhotoId, r2Key }) => ({ applePhotoId, r2Key })),
      }),
    );
    const notify = vi.fn().mockResolvedValue(undefined);
    const result = await runImportWorkflow(
      forwardedDeps(),
      {
        importRunId: `run-${batch.name}`,
        sourceAlbumId: "album-1",
        trigger: "admin",
      },
      retryingStep(),
      {
        retryLimit: 5,
        downloadAndGroup: async () => ({
          pendingGroups,
          orphanRange: grouped.orphanPhotos.length === 0
            ? null
            : {
                firstApplePhotoId: grouped.orphanPhotos[0]!.applePhotoId,
                lastApplePhotoId: grouped.orphanPhotos.at(-1)!.applePhotoId,
                count: grouped.orphanPhotos.length,
              },
          checkpointPosition: photos.at(-1)!.position,
        }),
        recordRunFailure: vi.fn(),
        processGroupAttempt: async (_deps, group) => ({
          outcome: "succeeded",
          productId: `A-${1001 + group.ordinal}`,
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
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
