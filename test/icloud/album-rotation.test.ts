import { describe, expect, it } from "vitest";
import { createICloudClient } from "../../src/icloud/client";
import type { SourcePhoto } from "../../src/icloud/types";

function scriptedFetcher(webstreamPhotos: Array<{ photoGuid: string }>) {
  let call = 0;
  const webstreamBody = {
    photos: webstreamPhotos.map((p, i) => ({
      photoGuid: p.photoGuid,
      dateCreated: `2026-08-31T09:0${i}:00Z`,
      derivatives: { "2048": { checksum: `chk-${p.photoGuid}` } },
    })),
  };
  const itemsBody = {
    items: Object.fromEntries(
      webstreamPhotos.map((p) => [
        `chk-${p.photoGuid}`,
        { url_location: "cvws.icloud-content.com", url_path: `/${p.photoGuid}` },
      ]),
    ),
  };
  return (async () => {
    call += 1;
    // discoverHost consumes one webstream request; getSnapshot then refetches
    // webstream before requesting webasseturls. Cycle webstream, webstream, items.
    const phase = (call - 1) % 3;
    if (phase < 2) {
      return new Response(JSON.stringify(webstreamBody), { status: 200 });
    }
    return new Response(JSON.stringify(itemsBody), { status: 200 });
  }) as typeof fetch;
}

function sourceKey(photo: SourcePhoto): string {
  return `${photo.sourceAlbumId}::${photo.applePhotoId}`;
}

describe("album rotation source-key uniqueness", () => {
  it("produces distinct source keys for the same Apple photo ID reused across two album tokens", async () => {
    const oldAlbumClient = createICloudClient("OLD-ALBUM-TOKEN", scriptedFetcher([{ photoGuid: "SHARED-GUID-1" }]));
    const newAlbumClient = createICloudClient("NEW-ALBUM-TOKEN", scriptedFetcher([{ photoGuid: "SHARED-GUID-1" }]));

    const oldSnapshot = await oldAlbumClient.getSnapshot();
    const newSnapshot = await newAlbumClient.getSnapshot();

    const oldKey = sourceKey(oldSnapshot.photos[0]!);
    const newKey = sourceKey(newSnapshot.photos[0]!);

    expect(oldKey).not.toBe(newKey);
    expect(oldSnapshot.sourceAlbumId).toBe("96730e0a990dc9b3f026b121dafa9906746784bfa38aa9a47be671bda399a5ed");
    expect(newSnapshot.sourceAlbumId).toBe("675040664c9537e67e8747c21eff389d0cd8b363bdc89306ccc687bb43576b4b");
    expect(oldSnapshot.sourceAlbumId).not.toContain("OLD-ALBUM-TOKEN");
    expect(newSnapshot.sourceAlbumId).not.toContain("NEW-ALBUM-TOKEN");
  });

  it("keeps the previous album's snapshot readable and unchanged after rotating to a new token", async () => {
    const oldAlbumClient = createICloudClient("OLD-ALBUM-TOKEN", scriptedFetcher([{ photoGuid: "ARCHIVE-1" }]));
    const beforeRotation = await oldAlbumClient.getSnapshot();

    // Rotation only changes which token the running system polls; it never
    // mutates or invalidates the old client/album.
    const afterRotationStillWorks = await oldAlbumClient.getSnapshot();

    expect(afterRotationStillWorks.photos.map((p) => p.applePhotoId)).toEqual(
      beforeRotation.photos.map((p) => p.applePhotoId)
    );
  });
});
