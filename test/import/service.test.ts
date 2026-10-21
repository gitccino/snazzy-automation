import { describe, expect, it, vi } from "vitest";
import { NonRetryableError } from "cloudflare:workflows";
import { testEnv } from "../helpers/env";
import { fixedClock, sequentialIdGenerator } from "../helpers/fakes";
import { createImportRepository } from "../../src/db/import-repository";
import { createSequenceRepository } from "../../src/db/sequence-repository";
import { createAuditLog } from "../../src/db/audit";
import { AIRTABLE_PREVIEW_VARIANT, createAssetStore } from "../../src/import/asset-store";
import type { AirtableProductsClient } from "../../src/import/airtable-products";
import {
  downloadAndGroupSnapshot,
  finalizeImportRun,
  processProductGroupAttempt,
  recordExhaustedGroupFailure,
  type ImportServiceDeps,
  type PersistedGroup,
  type ProcessGroupDeps,
} from "../../src/import/service";
import type {
  AlbumSnapshot,
  ImageSource,
  SourcePhoto,
} from "../../src/icloud/types";
import type { MarkerDetector } from "../../src/import/marker";
import { OperationalError } from "../../src/shared/errors";

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
      return new TextDecoder().decode(bytes).startsWith("marker-") ? "product_start" : "none";
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

function fakeAirtable(
  overrides: Partial<AirtableProductsClient> = {},
): AirtableProductsClient {
  return {
    findBySystemGroupId: async () => null,
    createProduct: async () => ({ recordId: "rec-created" }),
    verifyProduct: async () => true,
    deleteProduct: async () => {},
    ...overrides,
  };
}

async function buildProcessDeps(
  airtableOverrides: Partial<AirtableProductsClient> = {},
  groupHash = `task13-group-${crypto.randomUUID()}`,
): Promise<{ deps: ProcessGroupDeps; group: PersistedGroup }> {
  const env = testEnv();
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM product_groups WHERE group_hash LIKE 'task13-group-%'",
    ),
    env.DB.prepare("DELETE FROM sequences WHERE name = 'product_id'"),
  ]);
  const clock = fixedClock("2026-09-01T09:00:00.000Z");
  const repo = createImportRepository(
    env.DB,
    sequentialIdGenerator("row"),
    clock,
  );
  const sequences = createSequenceRepository(env.DB);
  await sequences.bootstrap("product_id", 501);
  const sourceAlbumId = `album-${crypto.randomUUID()}`;
  const importRunId = `run-${crypto.randomUUID()}`;
  await repo.createImportRun({
    id: importRunId,
    sourceAlbumId,
    trigger: "cron",
  });
  const row = await repo.upsertPendingGroup({
    id: crypto.randomUUID(),
    importRunId,
    ordinal: 0,
    groupHash,
    firstPhotoId: "m1",
    lastPhotoId: "p4",
  });
  return {
    deps: {
      imageSource: {} as ImageSource,
      marker: {} as MarkerDetector,
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
      ids: sequentialIdGenerator("id"),
      sourceAlbumId,
      firstImportCutoffDate: null,
      sequences,
      audit: createAuditLog(
        env.DB,
        sequentialIdGenerator(`audit-${crypto.randomUUID()}`),
        clock,
      ),
      airtable: fakeAirtable(airtableOverrides),
      productIdPrefix: "A",
      assetUrlTtlSeconds: 300,
    },
    group: {
      groupId: groupHash,
      groupRowId: row.id,
      ordinal: 0,
      markerPhotoId: "m1",
      attachablePhotos: [
        { applePhotoId: "p1", r2Key: "assets/p1.jpg" },
        { applePhotoId: "p2", r2Key: "assets/p2.jpg" },
        { applePhotoId: "p3", r2Key: "assets/p3.jpg" },
        { applePhotoId: "p4", r2Key: "assets/p4.jpg" },
      ],
    },
  };
}

async function auditRows(correlationId: string): Promise<
  Array<{
    actor: string;
    action: string;
    before_value: string | null;
    after_value: string | null;
  }>
> {
  const result = await testEnv()
    .DB.prepare(
      `SELECT actor, action, before_value, after_value
       FROM audit_events
       WHERE correlation_id = ?
       ORDER BY rowid`,
    )
    .bind(correlationId)
    .all<{
      actor: string;
      action: string;
      before_value: string | null;
      after_value: string | null;
    }>();
  return result.results;
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
      markerKind: "product_start",
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

  it("persists adjacent markers as incomplete groups", async () => {
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

    const result = await downloadAndGroupSnapshot(deps, importRunId);
    expect(result.pendingGroups.map(group => group.attachablePhotos.length)).toEqual([1, 0, 1]);
    const groupCount = await testEnv()
      .DB.prepare(
        "SELECT COUNT(*) AS count FROM product_groups WHERE import_run_id = ?",
      )
      .bind(importRunId)
      .first<{ count: number }>();
    expect(groupCount).toEqual({ count: 3 });
  });
});

describe("processProductGroupAttempt", () => {
  it("short-circuits a group that is already succeeded", async () => {
    const { deps, group } = await buildProcessDeps({
      findBySystemGroupId: async () => {
        throw new Error("a terminal group must not call Airtable");
      },
      createProduct: async () => {
        throw new Error("a terminal group must not create an Airtable row");
      },
      verifyProduct: async () => {
        throw new Error("a terminal group must not be verified again");
      },
      deleteProduct: async () => {
        throw new Error("a terminal group must not delete an Airtable row");
      },
    });
    await deps.repo.setGroupState(group.groupRowId, "succeeded", {
      productId: "A-501",
      airtableRecordId: "rec-terminal",
    });

    await expect(
      processProductGroupAttempt(deps, group, "run-terminal"),
    ).resolves.toEqual({ outcome: "succeeded", productId: "A-501" });
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "succeeded",
      productId: "A-501",
      airtableRecordId: "rec-terminal",
      attemptCount: 0,
    });
    expect(await auditRows("run-terminal")).toEqual([]);
  });

  it("rejects a missing persisted group as non-retryable", async () => {
    const { deps, group } = await buildProcessDeps();
    group.groupId = `missing-${crypto.randomUUID()}`;
    group.groupRowId = `missing-${crypto.randomUUID()}`;

    await expect(
      processProductGroupAttempt(deps, group, "run-correlation"),
    ).rejects.toMatchObject({
      code: "product_group_missing",
      retryable: false,
    });
  });

  it("persists one Product ID and attempt before surfacing a retryable create failure", async () => {
    const { deps, group } = await buildProcessDeps({
      createProduct: async () => {
        throw new OperationalError(
          "airtable_rate_limited",
          "rate limited",
          true,
        );
      },
    });

    await expect(
      processProductGroupAttempt(deps, group, "run-correlation"),
    ).rejects.toMatchObject({
      code: "airtable_rate_limited",
      retryable: true,
    });
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "importing",
      productId: "A-501",
      attemptCount: 1,
      failureReason: null,
    });
    expect(await auditRows("run-correlation")).toEqual([
      {
        actor: "system:import",
        action: "product_id_allocated",
        before_value: null,
        after_value: "A-501",
      },
      {
        actor: "system:import",
        action: "product_group_attempt_failed",
        before_value: "A-501",
        after_value: "airtable_rate_limited",
      },
    ]);
  });

  it("burns but does not assign a Product ID when its allocation audit fails", async () => {
    const { deps, group } = await buildProcessDeps();
    const realAudit = deps.audit;
    let allocationAuditAttempts = 0;
    deps.audit = {
      record: async (entry) => {
        if (
          entry.action === "product_id_allocated" &&
          allocationAuditAttempts++ === 0
        ) {
          throw new Error("allocation audit unavailable");
        }
        await realAudit.record(entry);
      },
    };

    await expect(
      processProductGroupAttempt(deps, group, "run-allocation-audit"),
    ).rejects.toMatchObject({
      code: "product_group_attempt_failed",
      message: "allocation audit unavailable",
      retryable: true,
    });
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "pending",
      productId: null,
      attemptCount: 0,
      failureReason: null,
    });

    await expect(
      processProductGroupAttempt(deps, group, "run-allocation-audit"),
    ).resolves.toEqual({ outcome: "succeeded", productId: "A-502" });
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "succeeded",
      productId: "A-502",
      attemptCount: 1,
    });
    expect(await auditRows("run-allocation-audit")).toEqual([
      {
        actor: "system:import",
        action: "product_group_attempt_failed",
        before_value: "A-501",
        after_value: "product_group_attempt_failed",
      },
      {
        actor: "system:import",
        action: "product_id_allocated",
        before_value: null,
        after_value: "A-502",
      },
      {
        actor: "system:import",
        action: "product_group_succeeded",
        before_value: "importing",
        after_value: "A-502",
      },
    ]);
  });

  it("operationalizes an attempt-failure audit outage for Workflow retry", async () => {
    const { deps, group } = await buildProcessDeps({
      createProduct: async () => {
        throw new OperationalError(
          "airtable_rate_limited",
          "rate limited",
          true,
        );
      },
    });
    const realAudit = deps.audit;
    deps.audit = {
      record: async (entry) => {
        if (entry.action === "product_group_attempt_failed") {
          throw new Error("attempt failure audit unavailable");
        }
        await realAudit.record(entry);
      },
    };

    await expect(
      processProductGroupAttempt(deps, group, "run-attempt-audit"),
    ).rejects.toMatchObject({
      code: "product_group_attempt_failed",
      message: "attempt failure audit unavailable",
      retryable: true,
    });
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "importing",
      productId: "A-501",
      attemptCount: 1,
    });
    expect(await auditRows("run-attempt-audit")).toEqual([
      {
        actor: "system:import",
        action: "product_id_allocated",
        before_value: null,
        after_value: "A-501",
      },
    ]);
  });

  it("reuses the Product ID on a Workflow retry and records success", async () => {
    let createCalls = 0;
    const { deps, group } = await buildProcessDeps({
      createProduct: async () => {
        createCalls += 1;
        if (createCalls === 1) {
          throw new OperationalError(
            "airtable_rate_limited",
            "rate limited",
            true,
          );
        }
        return { recordId: "rec-ok" };
      },
    });

    await expect(
      processProductGroupAttempt(deps, group, "run-retry"),
    ).rejects.toMatchObject({ code: "airtable_rate_limited" });
    await expect(
      processProductGroupAttempt(deps, group, "run-retry"),
    ).resolves.toEqual({ outcome: "succeeded", productId: "A-501" });

    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "succeeded",
      productId: "A-501",
      airtableRecordId: "rec-ok",
      attemptCount: 2,
    });
    expect(await auditRows("run-retry")).toEqual([
      {
        actor: "system:import",
        action: "product_id_allocated",
        before_value: null,
        after_value: "A-501",
      },
      {
        actor: "system:import",
        action: "product_group_attempt_failed",
        before_value: "A-501",
        after_value: "airtable_rate_limited",
      },
      {
        actor: "system:import",
        action: "product_group_succeeded",
        before_value: "importing",
        after_value: "A-501",
      },
    ]);
  });

  it("keeps verified success importing until its audit succeeds, then recovers on retry", async () => {
    let findCalls = 0;
    let createCalls = 0;
    const { deps, group } = await buildProcessDeps({
      findBySystemGroupId: async () => {
        findCalls += 1;
        return findCalls === 1
          ? null
          : { recordId: "rec-audit-recovery", productId: "A-501" };
      },
      createProduct: async () => {
        createCalls += 1;
        return { recordId: "rec-audit-recovery" };
      },
    });
    const realAudit = deps.audit;
    let successAuditAttempts = 0;
    deps.audit = {
      record: async (entry) => {
        if (
          entry.action === "product_group_succeeded" &&
          successAuditAttempts++ === 0
        ) {
          throw new Error("success audit unavailable");
        }
        await realAudit.record(entry);
      },
    };

    await expect(
      processProductGroupAttempt(deps, group, "run-success-audit"),
    ).rejects.toMatchObject({
      code: "product_group_attempt_failed",
      message: "success audit unavailable",
      retryable: true,
    });
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "importing",
      productId: "A-501",
      airtableRecordId: "rec-audit-recovery",
      attemptCount: 1,
    });

    await expect(
      processProductGroupAttempt(deps, group, "run-success-audit"),
    ).resolves.toEqual({ outcome: "succeeded", productId: "A-501" });
    expect(createCalls).toBe(1);
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "succeeded",
      productId: "A-501",
      airtableRecordId: "rec-audit-recovery",
      attemptCount: 2,
    });
    expect(await auditRows("run-success-audit")).toEqual([
      {
        actor: "system:import",
        action: "product_id_allocated",
        before_value: null,
        after_value: "A-501",
      },
      {
        actor: "system:import",
        action: "product_group_attempt_failed",
        before_value: "A-501",
        after_value: "product_group_attempt_failed",
      },
      {
        actor: "system:import",
        action: "product_group_succeeded",
        before_value: "importing",
        after_value: "A-501",
      },
    ]);
  });

  it("submits the complete Airtable payload with signed photo URLs", async () => {
    let submittedPayload:
      | Parameters<AirtableProductsClient["createProduct"]>[0]
      | null = null;
    const verificationCalls: Array<{
      recordId: string;
      expected: Parameters<AirtableProductsClient["verifyProduct"]>[1];
    }> = [];
    const signingCalls: Array<{ r2Key: string; ttlSeconds: number; variant?: string }> = [];
    const { deps, group } = await buildProcessDeps(
      {
        createProduct: async (payload) => {
          submittedPayload = payload;
          return { recordId: "rec-payload" };
        },
        verifyProduct: async (recordId, expected) => {
          verificationCalls.push({ recordId, expected });
          return true;
        },
      },
      "task13-group-payload-contract",
    );
    deps.assets = {
      putIfAbsent: async () => {
        throw new Error("putIfAbsent is outside the Product creation boundary");
      },
      signUrl: async (r2Key, ttlSeconds, variant) => {
        signingCalls.push({ r2Key, ttlSeconds, variant });
        if (r2Key === "assets/p1.jpg") {
          return "https://assets.example/signed-p1.jpg?ttl=300";
        }
        if (r2Key === "assets/p2.jpg") {
          return "https://assets.example/signed-p2.jpg?ttl=300";
        }
        return `https://assets.example/signed-${r2Key.slice(7)}?ttl=300`;
      },
    };

    await processProductGroupAttempt(deps, group, "run-payload");

    expect(signingCalls).toEqual([
      { r2Key: "assets/p1.jpg", ttlSeconds: 300, variant: AIRTABLE_PREVIEW_VARIANT },
      { r2Key: "assets/p2.jpg", ttlSeconds: 300, variant: AIRTABLE_PREVIEW_VARIANT },
      { r2Key: "assets/p3.jpg", ttlSeconds: 300, variant: AIRTABLE_PREVIEW_VARIANT },
      { r2Key: "assets/p4.jpg", ttlSeconds: 300, variant: AIRTABLE_PREVIEW_VARIANT },
    ]);
    expect(submittedPayload).toEqual({
      productId: "A-501",
      systemGroupId: "task13-group-payload-contract",
      uploadDate: "2026-09-01",
      productImages: [
        {
          url: "https://assets.example/signed-p1.jpg?ttl=300",
          filename: "p1.jpg",
        },
        {
          url: "https://assets.example/signed-p2.jpg?ttl=300",
          filename: "p2.jpg",
        },
        { url: "https://assets.example/signed-p3.jpg?ttl=300", filename: "p3.jpg" },
        { url: "https://assets.example/signed-p4.jpg?ttl=300", filename: "p4.jpg" },
      ],
    });
    expect(verificationCalls).toEqual([
      {
        recordId: "rec-payload",
        expected: {
          productId: "A-501",
          systemGroupId: "task13-group-payload-contract",
          uploadDate: "2026-09-01",
          imageCount: 4,
        },
      },
    ]);
  });

  it("keeps the persisted Upload Date when Bangkok midnight passes between creation and verification", async () => {
    let submittedUploadDate: string | null = null;
    const verifiedUploadDates: string[] = [];
    const { deps, group } = await buildProcessDeps({
      createProduct: async (payload) => {
        submittedUploadDate = payload.uploadDate;
        return { recordId: "rec-midnight" };
      },
      verifyProduct: async (_recordId, expected) => {
        verifiedUploadDates.push(expected.uploadDate);
        return true;
      },
    });
    const times = [
      "2026-09-01T16:59:59.000Z",
      "2026-09-01T17:00:01.000Z",
    ];
    let clockRead = 0;
    deps.clock = {
      now: () => new Date(times[Math.min(clockRead++, times.length - 1)]!),
    };

    await processProductGroupAttempt(deps, group, "run-midnight");

    expect(submittedUploadDate).toBe("2026-09-01");
    expect(verifiedUploadDates).toEqual(["2026-09-01"]);
  });

  it("rejects a malformed asset key before exposing it to Airtable", async () => {
    const { deps, group } = await buildProcessDeps();
    group.attachablePhotos[0] = {
      applePhotoId: "p1",
      r2Key: "assets/../secret.jpg",
    };

    await expect(
      processProductGroupAttempt(deps, group, "run-invalid-key"),
    ).rejects.toMatchObject({
      code: "invalid_asset_key",
      retryable: false,
    });
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "importing",
      productId: "A-501",
      attemptCount: 1,
    });
    expect(await auditRows("run-invalid-key")).toEqual([
      {
        actor: "system:import",
        action: "product_id_allocated",
        before_value: null,
        after_value: "A-501",
      },
      {
        actor: "system:import",
        action: "product_group_attempt_failed",
        before_value: "A-501",
        after_value: "invalid_asset_key",
      },
    ]);
  });

  it("deletes a newly created invalid Airtable row and remains retryable", async () => {
    let deletedRecordId: string | null = null;
    const { deps, group } = await buildProcessDeps({
      verifyProduct: async () => false,
      deleteProduct: async (recordId) => {
        deletedRecordId = recordId;
      },
    });

    await expect(
      processProductGroupAttempt(deps, group, "run-compensation"),
    ).rejects.toMatchObject({
      code: "airtable_verification_failed",
      retryable: true,
    });
    expect(deletedRecordId).toBe("rec-created");
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "importing",
      productId: "A-501",
      airtableRecordId: "rec-created",
      attemptCount: 1,
    });
    expect(await auditRows("run-compensation")).toEqual([
      {
        actor: "system:import",
        action: "product_id_allocated",
        before_value: null,
        after_value: "A-501",
      },
      {
        actor: "system:import",
        action: "product_group_attempt_failed",
        before_value: "A-501",
        after_value: "airtable_verification_failed",
      },
    ]);
  });

  it("deletes a newly created row whose verification response is definitely malformed", async () => {
    const deletedRecordIds: string[] = [];
    const { deps, group } = await buildProcessDeps({
      verifyProduct: async () => {
        throw new OperationalError(
          "airtable_verify_invalid_response",
          "Airtable returned a malformed verify response",
          false,
        );
      },
      deleteProduct: async (recordId) => {
        deletedRecordIds.push(recordId);
      },
    });

    await expect(
      processProductGroupAttempt(deps, group, "run-malformed-created"),
    ).rejects.toMatchObject({
      code: "airtable_verification_failed",
      retryable: true,
    });

    expect(deletedRecordIds).toEqual(["rec-created"]);
    expect(await auditRows("run-malformed-created")).toEqual([
      {
        actor: "system:import",
        action: "product_id_allocated",
        before_value: null,
        after_value: "A-501",
      },
      {
        actor: "system:import",
        action: "product_group_attempt_failed",
        before_value: "A-501",
        after_value: "airtable_verification_failed",
      },
    ]);
  });

  it("surfaces newly created row cleanup failure as retryable", async () => {
    const { deps, group } = await buildProcessDeps({
      verifyProduct: async () => false,
      deleteProduct: async () => {
        throw new Error("delete unavailable");
      },
    });

    await expect(
      processProductGroupAttempt(deps, group, "run-cleanup-failure"),
    ).rejects.toMatchObject({
      code: "airtable_cleanup_failed",
      message: "delete unavailable",
      retryable: true,
    });
    expect(await auditRows("run-cleanup-failure")).toEqual([
      {
        actor: "system:import",
        action: "product_id_allocated",
        before_value: null,
        after_value: "A-501",
      },
      {
        actor: "system:import",
        action: "product_group_attempt_failed",
        before_value: "A-501",
        after_value: "airtable_cleanup_failed",
      },
    ]);
  });

  it("verifies and adopts a response-lost Airtable row before recording success", async () => {
    const verificationCalls: Array<{
      recordId: string;
      expected: {
        productId: string;
        systemGroupId: string;
        uploadDate: string;
        imageCount: number;
      };
    }> = [];
    const { deps, group } = await buildProcessDeps(
      {
        findBySystemGroupId: async () => ({
          recordId: "rec-existing",
          productId: "A-777",
        }),
        createProduct: async () => {
          throw new Error("recovery must not create another Airtable row");
        },
        verifyProduct: async (recordId, expected) => {
          verificationCalls.push({ recordId, expected });
          return true;
        },
      },
      "task13-group-recovery",
    );
    await deps.repo.setGroupState(group.groupRowId, "importing", {
      productId: "A-501",
    });

    await expect(
      processProductGroupAttempt(deps, group, "run-recovery"),
    ).resolves.toEqual({ outcome: "succeeded", productId: "A-777" });

    expect(verificationCalls).toEqual([
      {
        recordId: "rec-existing",
        expected: {
          productId: "A-777",
          systemGroupId: "task13-group-recovery",
          uploadDate: "2026-09-01",
          imageCount: 4,
        },
      },
    ]);
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "succeeded",
      productId: "A-777",
      airtableRecordId: "rec-existing",
      attemptCount: 1,
    });
    expect(await auditRows("run-recovery")).toEqual([
      {
        actor: "system:import",
        action: "product_group_succeeded",
        before_value: "importing",
        after_value: "A-777",
      },
    ]);
  });

  it("recovers a response-lost row after Bangkok midnight using its original persisted Upload Date", async () => {
    let existing: { recordId: string; productId: string } | null = null;
    const createdUploadDates: string[] = [];
    const verifiedUploadDates: string[] = [];
    const { deps, group } = await buildProcessDeps({
      findBySystemGroupId: async () => existing,
      createProduct: async (payload) => {
        createdUploadDates.push(payload.uploadDate);
        existing = {
          recordId: "rec-response-lost-midnight",
          productId: payload.productId,
        };
        throw new OperationalError(
          "airtable_response_lost",
          "Airtable response was lost after creation",
          true,
        );
      },
      verifyProduct: async (_recordId, expected) => {
        verifiedUploadDates.push(expected.uploadDate);
        return true;
      },
    });
    let now = "2026-09-01T16:59:59.000Z";
    deps.clock = { now: () => new Date(now) };

    await expect(
      processProductGroupAttempt(deps, group, "run-midnight-recovery"),
    ).rejects.toMatchObject({
      code: "airtable_response_lost",
      retryable: true,
    });
    now = "2026-09-01T17:00:01.000Z";

    await expect(
      processProductGroupAttempt(deps, group, "run-midnight-recovery"),
    ).resolves.toEqual({ outcome: "succeeded", productId: "A-501" });
    expect(createdUploadDates).toEqual(["2026-09-01"]);
    expect(verifiedUploadDates).toEqual(["2026-09-01"]);
  });

  it("deletes an invalid response-lost recovery candidate and retries", async () => {
    let deletedRecordId: string | null = null;
    const { deps, group } = await buildProcessDeps({
      findBySystemGroupId: async () => ({
        recordId: "rec-existing",
        productId: "A-501",
      }),
      verifyProduct: async () => false,
      deleteProduct: async (recordId) => {
        deletedRecordId = recordId;
      },
    });
    await deps.repo.setGroupState(group.groupRowId, "importing", {
      productId: "A-501",
    });

    await expect(
      processProductGroupAttempt(deps, group, "run-invalid-recovery"),
    ).rejects.toMatchObject({
      code: "airtable_verification_failed",
      retryable: true,
    });

    expect(deletedRecordId).toBe("rec-existing");
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "importing",
      productId: "A-501",
      airtableRecordId: null,
      attemptCount: 1,
    });
    expect(await auditRows("run-invalid-recovery")).toEqual([
      {
        actor: "system:import",
        action: "product_group_attempt_failed",
        before_value: "A-501",
        after_value: "airtable_verification_failed",
      },
    ]);
  });

  it("deletes a recovered row whose verification response is definitely malformed", async () => {
    const deletedRecordIds: string[] = [];
    const { deps, group } = await buildProcessDeps({
      findBySystemGroupId: async () => ({
        recordId: "rec-malformed-recovery",
        productId: "A-501",
      }),
      verifyProduct: async () => {
        throw new OperationalError(
          "airtable_verify_invalid_response",
          "Airtable returned a malformed verify response",
          false,
        );
      },
      deleteProduct: async (recordId) => {
        deletedRecordIds.push(recordId);
      },
    });
    await deps.repo.setGroupState(group.groupRowId, "importing", {
      productId: "A-501",
    });

    await expect(
      processProductGroupAttempt(deps, group, "run-malformed-recovery"),
    ).rejects.toMatchObject({
      code: "airtable_verification_failed",
      retryable: true,
    });

    expect(deletedRecordIds).toEqual(["rec-malformed-recovery"]);
    expect(await auditRows("run-malformed-recovery")).toEqual([
      {
        actor: "system:import",
        action: "product_group_attempt_failed",
        before_value: "A-501",
        after_value: "airtable_verification_failed",
      },
    ]);
  });

  it("classifies invalid recovery candidate cleanup failure as retryable", async () => {
    const { deps, group } = await buildProcessDeps({
      findBySystemGroupId: async () => ({
        recordId: "rec-existing",
        productId: "A-501",
      }),
      verifyProduct: async () => false,
      deleteProduct: async () => {
        throw new Error("recovery delete unavailable");
      },
    });
    await deps.repo.setGroupState(group.groupRowId, "importing", {
      productId: "A-501",
    });

    await expect(
      processProductGroupAttempt(deps, group, "run-recovery-cleanup"),
    ).rejects.toMatchObject({
      code: "airtable_cleanup_failed",
      message: "recovery delete unavailable",
      retryable: true,
    });
    expect(await auditRows("run-recovery-cleanup")).toEqual([
      {
        actor: "system:import",
        action: "product_group_attempt_failed",
        before_value: "A-501",
        after_value: "airtable_cleanup_failed",
      },
    ]);
  });

  it("preserves a recovery verification error without deleting an unknown-validity row", async () => {
    const deletedRecordIds: string[] = [];
    const { deps, group } = await buildProcessDeps({
      findBySystemGroupId: async () => ({
        recordId: "rec-unknown-validity",
        productId: "A-501",
      }),
      verifyProduct: async () => {
        throw new OperationalError(
          "airtable_verify_failed",
          "verification unavailable",
          true,
        );
      },
      deleteProduct: async (recordId) => {
        deletedRecordIds.push(recordId);
      },
    });
    await deps.repo.setGroupState(group.groupRowId, "importing", {
      productId: "A-501",
    });

    await expect(
      processProductGroupAttempt(deps, group, "run-verify-error"),
    ).rejects.toMatchObject({
      code: "airtable_verify_failed",
      message: "verification unavailable",
      retryable: true,
    });
    expect(deletedRecordIds).toEqual([]);
    expect(await auditRows("run-verify-error")).toEqual([
      {
        actor: "system:import",
        action: "product_group_attempt_failed",
        before_value: "A-501",
        after_value: "airtable_verify_failed",
      },
    ]);
  });

  it("operationalizes an unknown recovery verification error for Workflow retry", async () => {
    const deletedRecordIds: string[] = [];
    const { deps, group } = await buildProcessDeps({
      findBySystemGroupId: async () => ({
        recordId: "rec-unknown-error",
        productId: "A-501",
      }),
      verifyProduct: async () => {
        throw new Error("verification transport offline");
      },
      deleteProduct: async (recordId) => {
        deletedRecordIds.push(recordId);
      },
    });
    await deps.repo.setGroupState(group.groupRowId, "importing", {
      productId: "A-501",
    });

    await expect(
      processProductGroupAttempt(deps, group, "run-unknown-verify-error"),
    ).rejects.toMatchObject({
      code: "product_group_attempt_failed",
      message: "verification transport offline",
      retryable: true,
    });
    expect(deletedRecordIds).toEqual([]);
    expect(await auditRows("run-unknown-verify-error")).toEqual([
      {
        actor: "system:import",
        action: "product_group_attempt_failed",
        before_value: "A-501",
        after_value: "product_group_attempt_failed",
      },
    ]);
  });
});

describe("recordExhaustedGroupFailure", () => {
  it("does not downgrade a group that already reached succeeded", async () => {
    const { deps, group } = await buildProcessDeps();
    await deps.repo.setGroupState(group.groupRowId, "succeeded", {
      productId: "A-501",
      airtableRecordId: "rec-terminal",
      attemptCount: 2,
    });

    const result = await recordExhaustedGroupFailure(
      deps,
      group,
      "run-late-exhaustion",
      new OperationalError("airtable_rate_limited", "rate limited", true),
    );

    expect(result).toEqual({
      productId: "A-501",
      errorCode: "airtable_rate_limited",
    });
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "succeeded",
      productId: "A-501",
      airtableRecordId: "rec-terminal",
      attemptCount: 2,
      failureReason: null,
    });
    expect(await auditRows("run-late-exhaustion")).toEqual([]);
  });

  it("marks failed only after Workflow gives up and preserves the burned Product ID", async () => {
    const { deps, group } = await buildProcessDeps();
    await deps.repo.setGroupState(group.groupRowId, "importing", {
      productId: "A-501",
      attemptCount: 6,
    });

    const result = await recordExhaustedGroupFailure(
      deps,
      group,
      "run-exhausted",
      new OperationalError("airtable_rate_limited", "rate limited", true),
    );

    expect(result).toEqual({
      productId: "A-501",
      errorCode: "airtable_rate_limited",
    });
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "failed",
      productId: "A-501",
      attemptCount: 6,
      failureReason: "airtable_rate_limited",
    });
    expect(await auditRows("run-exhausted")).toEqual([
      {
        actor: "system:import",
        action: "product_group_failed",
        before_value: "importing",
        after_value: "airtable_rate_limited",
      },
    ]);
  });

  it("recovers the operational code from NonRetryableError.name", async () => {
    const { deps, group } = await buildProcessDeps();
    const wrapped = new NonRetryableError(
      "Product group row is missing",
      "product_group_missing",
    );

    const result = await recordExhaustedGroupFailure(
      deps,
      group,
      "run-non-retryable",
      wrapped,
    );

    expect(result).toEqual({
      productId: null,
      errorCode: "product_group_missing",
    });
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "failed",
      productId: null,
      failureReason: "product_group_missing",
    });
    expect(await auditRows("run-non-retryable")).toEqual([
      {
        actor: "system:import",
        action: "product_group_failed",
        before_value: "importing",
        after_value: "product_group_missing",
      },
    ]);
  });
});

describe("finalizeImportRun", () => {
  it.each([
    { hadFailures: false, expectedStatus: "completed" },
    { hadFailures: true, expectedStatus: "completed_with_failures" },
  ])(
    "stores $expectedStatus and advances the checkpoint atomically",
    async ({ hadFailures, expectedStatus }) => {
      const env = testEnv();
      const clock = fixedClock("2026-09-01T09:00:00.000Z");
      const repo = createImportRepository(
        env.DB,
        sequentialIdGenerator("row"),
        clock,
      );
      const sourceAlbumId = `album-${crypto.randomUUID()}`;
      const importRunId = `run-${crypto.randomUUID()}`;
      await repo.createImportRun({
        id: importRunId,
        sourceAlbumId,
        trigger: "cron",
      });

      await finalizeImportRun(
        repo,
        importRunId,
        sourceAlbumId,
        hadFailures,
        3,
        42,
      );

      expect(
        await env.DB.prepare(
          `SELECT status, orphan_photo_count
           FROM import_runs
           WHERE id = ?`,
        )
          .bind(importRunId)
          .first(),
      ).toEqual({
        status: expectedStatus,
        orphan_photo_count: 3,
      });
      expect(await repo.getCheckpoint(sourceAlbumId)).toBe(42);
    },
  );
});


describe("ignore marker storage and minimum photos", () => {
  async function setup(ids: string[]) {
    const sourceAlbumId = `ignore-${crypto.randomUUID()}`;
    const snapshot: AlbumSnapshot = { sourceAlbumId, fetchedAt: "2026-10-08T00:00:00Z",
      photos: ids.map((id, index) => ({ ...sourcePhoto(id, index + 1), sourceAlbumId })) };
    const deps = await buildDeps(sourceAlbumId, snapshot, new Set(["m1", "m2"]));
    const download = deps.imageSource.download;
    deps.imageSource.download = async photo => new Response(`${new TextDecoder().decode(await (await download(photo)).arrayBuffer())}:${sourceAlbumId}`);
    const runId = crypto.randomUUID();
    await deps.repo.createImportRun({ id: runId, sourceAlbumId, trigger: "line" });
    deps.marker.detect = async bytes => {
      const label = new TextDecoder().decode(bytes);
      return label.startsWith("product-ignore") ? "ignore_start" : label.startsWith("marker-") ? "product_start" : "none";
    };
    return { deps, runId, snapshot };
  }

  it("stores only product sections and retries cached ignore markers without downloading", async () => {
    const { deps, runId } = await setup(["m1", "p1", "p2", "p3", "p4", "ignore", "extra", "m2", "q1", "q2", "q3", "q4"]);
    const put = vi.spyOn(deps.assets, "putIfAbsent");
    const download = vi.spyOn(deps.imageSource, "download");
    const first = await downloadAndGroupSnapshot(deps, runId);
    expect(first.pendingGroups.map(g => g.attachablePhotos.map(p => p.applePhotoId)))
      .toEqual([["p1", "p2", "p3", "p4"], ["q1", "q2", "q3", "q4"]]);
    expect((await deps.repo.findAssetByApplePhotoId(deps.sourceAlbumId, "extra"))?.r2Key).toBeNull();
    expect(await deps.repo.findAssetByApplePhotoId(deps.sourceAlbumId, "ignore")).toMatchObject({ markerKind: "ignore_start", r2Key: null });
    expect(put).toHaveBeenCalledTimes(10);
    put.mockClear(); download.mockClear();
    await downloadAndGroupSnapshot(deps, runId);
    expect(put).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
  });

  it("keeps newly appended photos ignored after a cached ignore marker", async () => {
    const { deps, runId, snapshot } = await setup(["ignore", "extra"]);
    expect(await downloadAndGroupSnapshot(deps, runId)).toMatchObject({ pendingGroups: [], orphanRange: null });
    snapshot.photos.push({ ...sourcePhoto("appended", 3), sourceAlbumId: deps.sourceAlbumId });
    await finalizeImportRun(deps.repo, runId, deps.sourceAlbumId, false, 0, 2);
    const nextRun = crypto.randomUUID();
    await deps.repo.createImportRun({ id: nextRun, sourceAlbumId: deps.sourceAlbumId, trigger: "line" });
    const put = vi.spyOn(deps.assets, "putIfAbsent");
    expect(await downloadAndGroupSnapshot(deps, nextRun)).toMatchObject({ pendingGroups: [], orphanRange: null });
    expect(put).not.toHaveBeenCalled();
    expect((await deps.repo.findAssetByApplePhotoId(deps.sourceAlbumId, "appended"))?.r2Key).toBeNull();
  });

  it.each([false, true])("promotes skipped originals only if downloaded bytes match (changed=%s)", async changed => {
    const { deps, runId, snapshot } = await setup(["ignore", "extra"]);
    await downloadAndGroupSnapshot(deps, runId);
    snapshot.photos = ["m1", "p1", "p2", "p3", "extra"].map((id, index) => ({ ...sourcePhoto(id, index + 1), sourceAlbumId: deps.sourceAlbumId }));
    // The source references the same mutable snapshot and preserves original bytes.
    // m1 is already recognized by setup's marker IDs.
    if (changed) {
      const download = deps.imageSource.download;
      deps.imageSource.download = photo => photo.applePhotoId === "extra" ? Promise.resolve(new Response("changed")) : download(photo);
      await expect(downloadAndGroupSnapshot(deps, runId)).rejects.toMatchObject({ code: "photo_asset_content_changed", retryable: false });
      expect((await deps.repo.findAssetByApplePhotoId(deps.sourceAlbumId, "extra"))?.r2Key).toBeNull();
    } else {
      const result = await downloadAndGroupSnapshot(deps, runId);
      expect(result.pendingGroups[0]?.attachablePhotos.map(p => p.applePhotoId)).toContain("extra");
      expect((await deps.repo.findAssetByApplePhotoId(deps.sourceAlbumId, "extra"))?.r2Key).toEqual(expect.any(String));
    }
  });

  it.each([0, 1, 2, 3])("fails %s-photo products without allocating IDs or creating Airtable rows", async count => {
    const { deps, group } = await buildProcessDeps();
    group.attachablePhotos = Array.from({ length: count }, (_, i) => ({ applePhotoId: `p${i}`, r2Key: `assets/p${i}.jpg` }));
    const allocate = vi.spyOn(deps.sequences, "allocateNext");
    const create = vi.spyOn(deps.airtable, "createProduct");
    const error = await processProductGroupAttempt(deps, group, "minimum-run").catch(error => error);
    expect(error).toMatchObject({ code: "insufficient_product_photos", retryable: false });
    expect(allocate).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    await recordExhaustedGroupFailure(deps, group, "minimum-run", error);
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({ state: "failed", productId: null, failureReason: "insufficient_product_photos" });
  });
});
