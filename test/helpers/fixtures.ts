import type { GroupingPhoto } from "../../src/import/grouping";

export const WEBSTREAM_FIXTURE = {
  photos: [
    {
      photoGuid: "AAAA-1111",
      dateCreated: "2026-08-31T09:00:00Z",
      batchDateCreated: "2026-08-31T09:00:00Z",
      derivatives: {
        "2048": { checksum: "chk-aaaa-2048", fileSize: "204800" },
      },
    },
    {
      photoGuid: "BBBB-2222",
      dateCreated: "2026-08-31T09:01:00Z",
      batchDateCreated: "2026-08-31T09:01:00Z",
      derivatives: {
        "2048": { checksum: "chk-bbbb-2048", fileSize: "199000" },
      },
    },
  ],
};

export const WEBASSETURLS_FIXTURE = {
  items: {
    "chk-aaaa-2048": { url_location: "cvws.icloud-content.com", url_path: "/A/aaaa?o=1&v=1&x=1&s=1&a=1&k=1&e=1" },
    "chk-bbbb-2048": { url_location: "cvws.icloud-content.com", url_path: "/B/bbbb?o=1&v=1&x=1&s=1&a=1&k=1&e=1" },
  },
};

export interface GroupingBatchOptions {
  groupSizes: number[];
  orphanPhotoCount?: number;
}

export function buildGroupingPhotos(
  options: GroupingBatchOptions,
): GroupingPhoto[] {
  const photos: GroupingPhoto[] = [];
  let position = 0;

  for (let index = 0; index < (options.orphanPhotoCount ?? 0); index += 1) {
    const id = `orphan-${index}`;
    photos.push({
      applePhotoId: id,
      position: position++,
      isMarker: false,
      r2Key: `assets/${id}.jpg`,
    });
  }

  options.groupSizes.forEach((size, groupIndex) => {
    const markerId = `marker-${groupIndex}`;
    photos.push({
      applePhotoId: markerId,
      position: position++,
      isMarker: true,
      r2Key: `assets/${markerId}.jpg`,
    });
    for (let index = 0; index < size; index += 1) {
      const id = `g${groupIndex}-p${index}`;
      photos.push({
        applePhotoId: id,
        position: position++,
        isMarker: false,
        r2Key: `assets/${id}.jpg`,
      });
    }
  });

  return photos;
}
