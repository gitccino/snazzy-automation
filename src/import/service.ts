import type { Clock, IdGenerator } from "../env";
import type { ImportRepository } from "../db/import-repository";
import type { SequenceRepository } from "../db/sequence-repository";
import type { AuditLog } from "../db/audit";
import type { AlbumSnapshot, ImageSource, SourcePhoto } from "../icloud/types";
import { OperationalError } from "../shared/errors";
import { sha256Hex } from "../shared/ids";
import { todayBangkokDate } from "../shared/time";
import { AIRTABLE_PREVIEW_VARIANT, type AssetStore } from "./asset-store";
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

async function verifyKnownAirtableProduct(
  airtable: AirtableProductsClient,
  recordId: string,
  expected: Parameters<AirtableProductsClient["verifyProduct"]>[1],
): Promise<void> {
  let verified: boolean;
  try {
    verified = await airtable.verifyProduct(recordId, expected);
  } catch (error) {
    if (
      !(error instanceof OperationalError) ||
      error.code !== "airtable_verify_invalid_response"
    ) {
      throw error;
    }
    await deleteInvalidAirtableProduct(airtable, recordId);
    throw new OperationalError(
      "airtable_verification_failed",
      "Airtable Product verification returned a malformed row",
      true,
    );
  }
  if (verified) return;
  await deleteInvalidAirtableProduct(airtable, recordId);
  throw new OperationalError(
    "airtable_verification_failed",
    "Airtable Product verification failed",
    true,
  );
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

  let ignoring = false;
  const groupingPhotos: GroupingPhoto[] = [];
  for (const photo of [...eligiblePhotos].sort((a, b) => a.position - b.position)) {
    const asset = await deps.repo.findAssetByApplePhotoId(deps.sourceAlbumId, photo.applePhotoId);
    let bytes: ArrayBuffer | undefined;
    const loadBytes = async () => bytes ??= await (await deps.imageSource.download(photo)).arrayBuffer();
    const markerKind = asset?.markerKind ?? await deps.marker.detect(await loadBytes());
    if (markerKind === "product_start") ignoring = false;
    if (markerKind === "ignore_start") ignoring = true;
    let r2Key = asset?.r2Key ?? null;
    if (asset === null || (!ignoring && r2Key === null)) {
      const contentHash = await sha256Hex(await loadBytes());
      if (asset !== null && contentHash !== asset.contentHash) {
        throw new OperationalError("photo_asset_content_changed", "Skipped photo bytes changed before storage", false);
      }
      if (!ignoring) {
        const existingByHash = await deps.repo.findAssetByContentHash(contentHash);
        r2Key = existingByHash?.r2Key ?? (await deps.assets.putIfAbsent(
          contentHash, extensionFor(photo.mediaType), await loadBytes(), photo.mediaType,
        )).r2Key;
      }
      if (asset === null) {
        await deps.repo.recordPhotoAsset({
          id: deps.ids.next(), sourceAlbumId: deps.sourceAlbumId,
          applePhotoId: photo.applePhotoId, contentHash, r2Key, position: photo.position,
          isMarker: markerKind === "product_start", markerKind, importRunId,
        });
      } else {
        await deps.repo.setAssetR2Key(deps.sourceAlbumId, photo.applePhotoId, r2Key!);
      }
    }
    groupingPhotos.push({ applePhotoId: photo.applePhotoId, position: photo.position,
      markerKind, isMarker: markerKind === "product_start", r2Key });
  }
  const { groups, orphanPhotos } = groupByMarkers(groupingPhotos);

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
        .filter((photo) => photo.markerKind === "none")
        .map((photo) => {
          if (photo.r2Key === null) {
            throw new OperationalError("invalid_asset_key", "Product photo has no stored original", false);
          }
          return { applePhotoId: photo.applePhotoId, r2Key: photo.r2Key };
        }),
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
  if (current.state === "succeeded") {
    if (current.productId === null) {
      throw new OperationalError(
        "product_group_missing_product_id",
        "Succeeded Product group is missing its Product ID",
        false,
      );
    }
    return { outcome: "succeeded", productId: current.productId };
  }
  const intendedUploadDate = todayBangkokDate({
    now: () => new Date(current.createdAt),
  });

  let productId = current.productId;
  try {
    if (group.attachablePhotos.length < 4) {
      throw new OperationalError("insufficient_product_photos", "A product requires at least four photos", false);
    }
    if (productId === null) {
      const nextNumber = await deps.sequences.allocateNext("product_id");
      productId = `${deps.productIdPrefix}-${nextNumber}`;
      await deps.audit.record({
        correlationId: importRunId,
        actor: "system:import",
        action: "product_id_allocated",
        beforeValue: null,
        afterValue: productId,
      });
      await deps.repo.setGroupState(group.groupRowId, "importing", {
        productId,
      });
    }

    await deps.repo.setGroupState(group.groupRowId, "importing", {
      attemptCount: current.attemptCount + 1,
      failureReason: null,
    });

    const existing = await deps.airtable.findBySystemGroupId(group.groupId);
    if (existing !== null) {
      await verifyKnownAirtableProduct(
        deps.airtable,
        existing.recordId,
        {
          productId: existing.productId,
          systemGroupId: group.groupId,
          uploadDate: intendedUploadDate,
          imageCount: group.attachablePhotos.length,
        },
      );
      await deps.audit.record({
        correlationId: importRunId,
        actor: "system:import",
        action: "product_group_succeeded",
        beforeValue: "importing",
        afterValue: existing.productId,
      });
      await deps.repo.setGroupState(group.groupRowId, "succeeded", {
        productId: existing.productId,
        airtableRecordId: existing.recordId,
        failureReason: null,
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
            AIRTABLE_PREVIEW_VARIANT,
          ),
          filename: photo.r2Key.slice("assets/".length),
        };
      }),
    );
    const created = await deps.airtable.createProduct({
      productId,
      systemGroupId: group.groupId,
      uploadDate: intendedUploadDate,
      productImages,
    });
    await deps.repo.setGroupState(group.groupRowId, "importing", {
      airtableRecordId: created.recordId,
    });
    await verifyKnownAirtableProduct(deps.airtable, created.recordId, {
      productId,
      systemGroupId: group.groupId,
      uploadDate: intendedUploadDate,
      imageCount: group.attachablePhotos.length,
    });
    await deps.audit.record({
      correlationId: importRunId,
      actor: "system:import",
      action: "product_group_succeeded",
      beforeValue: "importing",
      afterValue: productId,
    });
    await deps.repo.setGroupState(group.groupRowId, "succeeded", {
      productId,
      airtableRecordId: created.recordId,
      failureReason: null,
    });
    return { outcome: "succeeded", productId };
  } catch (error) {
    const operational = operationalizeGroupError(error);
    try {
      await deps.audit.record({
        correlationId: importRunId,
        actor: "system:import",
        action: "product_group_attempt_failed",
        beforeValue: productId,
        afterValue: operational.code,
      });
    } catch (auditError) {
      throw new OperationalError(
        "product_group_attempt_failed",
        auditError instanceof Error
          ? auditError.message
          : "Product group attempt-failure audit failed",
        true,
      );
    }
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
  if (current?.state === "succeeded") {
    return { productId: current.productId, errorCode };
  }
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
