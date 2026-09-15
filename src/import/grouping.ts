import { sha256Hex } from "../shared/ids";

export interface GroupingPhoto {
  applePhotoId: string;
  position: number;
  isMarker: boolean;
  r2Key: string;
}

export interface GroupedProduct {
  ordinal: number;
  markerPhotoId: string;
  photos: GroupingPhoto[];
}

export interface GroupingResult {
  groups: GroupedProduct[];
  orphanPhotos: GroupingPhoto[];
}

export function groupByMarkers(photos: GroupingPhoto[]): GroupingResult {
  const sorted = [...photos].sort((a, b) => a.position - b.position);
  const firstMarkerIndex = sorted.findIndex((photo) => photo.isMarker);

  if (firstMarkerIndex === -1) {
    return { groups: [], orphanPhotos: sorted };
  }

  const orphanPhotos = sorted.slice(0, firstMarkerIndex);
  const groups: GroupedProduct[] = [];
  let currentMarkerPhotoId: string | null = null;
  let currentPhotos: GroupingPhoto[] = [];

  for (const photo of sorted.slice(firstMarkerIndex)) {
    if (photo.isMarker) {
      if (currentMarkerPhotoId !== null) {
        groups.push({
          ordinal: groups.length,
          markerPhotoId: currentMarkerPhotoId,
          photos: currentPhotos,
        });
      }

      currentMarkerPhotoId = photo.applePhotoId;
      currentPhotos = [photo];
      continue;
    }

    currentPhotos.push(photo);
  }

  if (currentMarkerPhotoId !== null) {
    groups.push({
      ordinal: groups.length,
      markerPhotoId: currentMarkerPhotoId,
      photos: currentPhotos,
    });
  }

  return { groups, orphanPhotos };
}

export async function computeGroupHash(
  sourceAlbumId: string,
  photos: GroupingPhoto[],
): Promise<string> {
  const payload = JSON.stringify([
    sourceAlbumId,
    photos.map((photo) => photo.applePhotoId),
  ]);
  return sha256Hex(new TextEncoder().encode(payload));
}
