import type { Clock, IdGenerator } from "../env";
import type { ImportRepository } from "../db/import-repository";
import type { AlbumSnapshot, ImageSource, SourcePhoto } from "../icloud/types";
import { OperationalError } from "../shared/errors";
import { sha256Hex } from "../shared/ids";
import type { AssetStore } from "./asset-store";
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
    savedCheckpoint !== null || firstImportCutoffDate === null
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
