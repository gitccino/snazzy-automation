import type { MarkerKind } from "./marker";
import { sha256Hex } from "../shared/ids";

export interface GroupingPhoto {
  applePhotoId: string;
  position: number;
  isMarker: boolean;
  markerKind?: MarkerKind;
  r2Key: string | null;
}

export interface GroupedProduct {
  ordinal: number;
  markerPhotoId: string;
  photos: GroupingPhoto[];
}

export interface GroupingResult {
  groups: GroupedProduct[];
  orphanPhotos: GroupingPhoto[];
  ignoredPhotos: GroupingPhoto[];
}

export function groupByMarkers(photos: GroupingPhoto[]): GroupingResult {
  const groups: GroupedProduct[] = [], orphanPhotos: GroupingPhoto[] = [], ignoredPhotos: GroupingPhoto[] = [];
  let currentMarkerPhotoId: string | null = null;
  let currentPhotos: GroupingPhoto[] = [];
  let ignoring = false;
  const flush = () => {
    if (currentMarkerPhotoId !== null) groups.push({ ordinal: groups.length, markerPhotoId: currentMarkerPhotoId, photos: currentPhotos });
    currentMarkerPhotoId = null;
    currentPhotos = [];
  };
  for (const photo of [...photos].sort((a, b) => a.position - b.position)) {
    const kind = photo.markerKind ?? (photo.isMarker ? "product_start" : "none");
    if (kind === "product_start") {
      flush(); ignoring = false; currentMarkerPhotoId = photo.applePhotoId; currentPhotos = [photo];
    } else if (kind === "ignore_start") {
      flush(); ignoring = true; ignoredPhotos.push(photo);
    } else if (ignoring) ignoredPhotos.push(photo);
    else if (currentMarkerPhotoId !== null) currentPhotos.push(photo);
    else orphanPhotos.push(photo);
  }
  flush();
  return { groups, orphanPhotos, ignoredPhotos };

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
