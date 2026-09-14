import type { Clock, IdGenerator } from "../env";
import type { ImportRepository } from "../db/import-repository";
import type { SequenceRepository } from "../db/sequence-repository";
import type { AuditLog } from "../db/audit";
import type { AlbumSnapshot, ImageSource, SourcePhoto } from "../icloud/types";
import { OperationalError } from "../shared/errors";
import { sha256Hex } from "../shared/ids";
import { todayBangkokDate } from "../shared/time";
import type { AssetStore } from "./asset-store";
import type { AirtableProductsClient } from "./airtable-products";
import {
  computeGroupHash,
  groupByMarkers,
  type GroupingPhoto,
} from "./grouping";
import type { MarkerDetector } from "./marker";
import type { OrphanRange } from "./types";

export interface ImportServiceDeps {
  imageSource: ImageSource;
  marker: MarkerDetector;
  repo: ImportRepository;
  assets: AssetStore;
  clock: Clock;
  ids: IdGenerator;
  sourceAlbumId: string;
  firstImportCutoffDate: string | null;
}

export interface PersistedGroup {
  groupId: string;
  groupRowId: string;
  ordinal: number;
  markerPhotoId: string;
  attachablePhotos: Array<{ applePhotoId: string; r2Key: string }>;
}

export interface DownloadAndGroupOutcome {
  pendingGroups: PersistedGroup[];
  orphanRange: OrphanRange | null;
  checkpointPosition: number;
}

export interface ProcessGroupDeps extends ImportServiceDeps {
  sequences: SequenceRepository;
  audit: AuditLog;
  airtable: AirtableProductsClient;
  productIdPrefix: string;
  assetUrlTtlSeconds: number;
}

export interface ProcessGroupOutcome {
  outcome: "succeeded";
  productId: string;
}

function operationalizeGroupError(error: unknown): OperationalError {
  return error instanceof OperationalError
    ? error
    : new OperationalError(
        "product_group_attempt_failed",
        error instanceof Error ? error.message : "Product group attempt failed",
        true,
      );
}

async function deleteInvalidAirtableProduct(
  airtable: AirtableProductsClient,
  recordId: string,
): Promise<void> {
  try {
    await airtable.deleteProduct(recordId);
  } catch (cleanupError) {
    throw new OperationalError(
      "airtable_cleanup_failed",
      cleanupError instanceof Error
        ? cleanupError.message
        : "Airtable partial-row cleanup failed",
      true,
    );
  }
}

function extensionFor(mediaType: SourcePhoto["mediaType"]): string {
  return mediaType === "image/jpeg" ? "jpg" : "bin";
}

export async function downloadAndGroupSnapshot(
  deps: ImportServiceDeps,
  importRunId: string,
): Promise<DownloadAndGroupOutcome> {
  const snapshot: AlbumSnapshot = await deps.imageSource.getSnapshot();
  if (snapshot.sourceAlbumId !== deps.sourceAlbumId) {
    throw new OperationalError(
      "source_album_identity_mismatch",
      "Snapshot album identity changed",
      false,
    );
  }

  const savedCheckpoint = await deps.repo.getCheckpoint(deps.sourceAlbumId);
  const firstImportCutoffDate = deps.firstImportCutoffDate;
  const eligiblePhotos =
    firstImportCutoffDate === null
      ? snapshot.photos
      : snapshot.photos.filter(
          (photo) =>
            photo.captureAt !== null &&
            photo.captureAt >= firstImportCutoffDate,
        );

  for (const photo of eligiblePhotos) {
    const alreadyRecorded = await deps.repo.findAssetByApplePhotoId(
      deps.sourceAlbumId,
      photo.applePhotoId,
    );
    if (alreadyRecorded !== null) {
      continue;
    }

    const response = await deps.imageSource.download(photo);
    const bytes = await response.arrayBuffer();
    const contentHash = await sha256Hex(bytes);
    const isMarker = await deps.marker.detect(bytes);
    const existingByHash = await deps.repo.findAssetByContentHash(contentHash);
    const r2Key =
      existingByHash?.r2Key ??
      (
        await deps.assets.putIfAbsent(
          contentHash,
          extensionFor(photo.mediaType),
          bytes,
          photo.mediaType,
        )
      ).r2Key;

    await deps.repo.recordPhotoAsset({
      id: deps.ids.next(),
      sourceAlbumId: deps.sourceAlbumId,
      applePhotoId: photo.applePhotoId,
      contentHash,
      r2Key,
      position: photo.position,
      isMarker,
      importRunId,
    });
  }

  const allAssets = await deps.repo.listAssetsForAlbum(deps.sourceAlbumId);
  const assetsByApplePhotoId = new Map(
    allAssets.map((asset) => [asset.applePhotoId, asset]),
  );
  const groupingPhotos: GroupingPhoto[] = eligiblePhotos.map((photo) => {
    const asset = assetsByApplePhotoId.get(photo.applePhotoId)!;
    return {
      applePhotoId: photo.applePhotoId,
      position: photo.position,
      isMarker: asset.isMarker,
      r2Key: asset.r2Key,
    };
  });
  const { groups, orphanPhotos } = groupByMarkers(groupingPhotos);
  if (groups.some((group) => !group.photos.some((photo) => !photo.isMarker))) {
    throw new OperationalError(
      "empty_product_group",
      "A marker must be followed by at least one product photo",
      false,
    );
  }

  const pendingGroups: PersistedGroup[] = [];
  for (const group of groups) {
    const groupHash = await computeGroupHash(deps.sourceAlbumId, group.photos);
    const row = await deps.repo.upsertPendingGroup({
      id: deps.ids.next(),
      importRunId,
      ordinal: group.ordinal,
      groupHash,
      firstPhotoId: group.photos[0]!.applePhotoId,
      lastPhotoId: group.photos[group.photos.length - 1]!.applePhotoId,
    });
    if (row.state === "succeeded") {
      continue;
    }
    pendingGroups.push({
      groupId: groupHash,
      groupRowId: row.id,
      ordinal: group.ordinal,
      markerPhotoId: group.markerPhotoId,
      attachablePhotos: group.photos
        .filter((photo) => !photo.isMarker)
        .map((photo) => ({
          applePhotoId: photo.applePhotoId,
          r2Key: photo.r2Key,
        })),
    });
  }

  const orphanRange: OrphanRange | null =
    orphanPhotos.length === 0
      ? null
      : {
          firstApplePhotoId: orphanPhotos[0]!.applePhotoId,
          lastApplePhotoId: orphanPhotos[orphanPhotos.length - 1]!.applePhotoId,
          count: orphanPhotos.length,
        };
  const checkpointPosition = snapshot.photos.reduce(
    (highest, photo) => Math.max(highest, photo.position),
    savedCheckpoint ?? -1,
  );

  return { pendingGroups, orphanRange, checkpointPosition };
}

export async function processProductGroupAttempt(
  deps: ProcessGroupDeps,
  group: PersistedGroup,
  importRunId: string,
): Promise<ProcessGroupOutcome> {
  const current = await deps.repo.findGroupByHash(group.groupId);
  if (current === null) {
    throw new OperationalError(
      "product_group_missing",
      "Product group row is missing",
      false,
    );
  }

  let productId = current.productId;
  if (productId === null) {
    const nextNumber = await deps.sequences.allocateNext("product_id");
    productId = `${deps.productIdPrefix}-${nextNumber}`;
    await deps.repo.setGroupState(group.groupRowId, "importing", { productId });
    await deps.audit.record({
      correlationId: importRunId,
      actor: "system:import",
      action: "product_id_allocated",
      beforeValue: null,
      afterValue: productId,
    });
  }

  await deps.repo.setGroupState(group.groupRowId, "importing", {
    attemptCount: current.attemptCount + 1,
    failureReason: null,
  });

  try {
    const existing = await deps.airtable.findBySystemGroupId(group.groupId);
    if (existing !== null) {
      const existingVerified = await deps.airtable.verifyProduct(
        existing.recordId,
        group.attachablePhotos.length,
      );
      if (!existingVerified) {
        await deleteInvalidAirtableProduct(deps.airtable, existing.recordId);
        throw new OperationalError(
          "airtable_verification_failed",
          "Airtable Product verification failed",
          true,
        );
      }
      await deps.repo.setGroupState(group.groupRowId, "succeeded", {
        productId: existing.productId,
        airtableRecordId: existing.recordId,
        failureReason: null,
      });
      await deps.audit.record({
        correlationId: importRunId,
        actor: "system:import",
        action: "product_group_succeeded",
        beforeValue: "importing",
        afterValue: existing.productId,
      });
      return { outcome: "succeeded", productId: existing.productId };
    }
    const productImages = await Promise.all(
      group.attachablePhotos.map(async (photo) => {
        if (!/^assets\/[A-Za-z0-9._-]+$/.test(photo.r2Key)) {
          throw new OperationalError(
            "invalid_asset_key",
            `Cannot expose malformed asset key for ${photo.applePhotoId}`,
            false,
          );
        }
        return {
          url: await deps.assets.signUrl(
            photo.r2Key,
            deps.assetUrlTtlSeconds,
          ),
          filename: photo.r2Key.slice("assets/".length),
        };
      }),
    );
    const created = await deps.airtable.createProduct({
      productId,
      systemGroupId: group.groupId,
      uploadDate: todayBangkokDate(deps.clock),
      productImages,
    });
    await deps.repo.setGroupState(group.groupRowId, "importing", {
      airtableRecordId: created.recordId,
    });
    if (
      !(await deps.airtable.verifyProduct(
        created.recordId,
        group.attachablePhotos.length,
      ))
    ) {
      await deleteInvalidAirtableProduct(deps.airtable, created.recordId);
      throw new OperationalError(
        "airtable_verification_failed",
        "Airtable Product verification failed",
        true,
      );
    }
    await deps.repo.setGroupState(group.groupRowId, "succeeded", {
      productId,
      airtableRecordId: created.recordId,
      failureReason: null,
    });
    await deps.audit.record({
      correlationId: importRunId,
      actor: "system:import",
      action: "product_group_succeeded",
      beforeValue: "importing",
      afterValue: productId,
    });
    return { outcome: "succeeded", productId };
  } catch (error) {
    const operational = operationalizeGroupError(error);
    await deps.audit.record({
      correlationId: importRunId,
      actor: "system:import",
      action: "product_group_attempt_failed",
      beforeValue: productId,
      afterValue: operational.code,
    });
    throw operational;
  }
}

export async function recordExhaustedGroupFailure(
  deps: Pick<ProcessGroupDeps, "repo" | "audit">,
  group: PersistedGroup,
  importRunId: string,
  error: unknown,
): Promise<{ productId: string | null; errorCode: string }> {
  const current = await deps.repo.findGroupByHash(group.groupId);
  const errorCode =
    error instanceof OperationalError
      ? error.code
      : error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.name)
        ? error.name
        : "unknown_error";
  await deps.repo.setGroupState(group.groupRowId, "failed", {
    failureReason: errorCode,
  });
  await deps.audit.record({
    correlationId: importRunId,
    actor: "system:import",
    action: "product_group_failed",
    beforeValue: "importing",
    afterValue: errorCode,
  });
  return { productId: current?.productId ?? null, errorCode };
}

export async function finalizeImportRun(
  repo: ImportRepository,
  importRunId: string,
  sourceAlbumId: string,
  hadFailures: boolean,
  orphanPhotoCount: number,
  checkpointPosition: number,
): Promise<void> {
  await repo.finalizeImportRun({
    id: importRunId,
    sourceAlbumId,
    status: hadFailures ? "completed_with_failures" : "completed",
    orphanPhotoCount,
    checkpointPosition,
  });
}
