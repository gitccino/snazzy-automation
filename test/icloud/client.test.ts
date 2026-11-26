import { describe, expect, it } from "vitest";
import { createICloudClient, deriveSourceAlbumId } from "../../src/icloud/client";
import { groupByMarkers } from "../../src/import/grouping";
import { WEBASSETURLS_FIXTURE, WEBSTREAM_FIXTURE } from "../helpers/fixtures";

function scriptedFetcher(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  let call = 0;
  return async () => {
    const next = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    return new Response(next.body === undefined ? undefined : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers ?? {},
    });
  };
}

describe("deriveSourceAlbumId", () => {
  it("returns the known stable SHA-256 identity without exposing the token", async () => {
    const sourceAlbumId = await deriveSourceAlbumId("TOKEN-XYZ");
    expect(sourceAlbumId).toBe("3447794384db61d5cd68a9ee046c489845550d1ea100612136598c82b3f9e2ef");
    expect(sourceAlbumId).not.toContain("TOKEN-XYZ");
  });
});

describe("createICloudClient.getSnapshot", () => {
  it("assigns chronological positions to a newest-first marker and product", async () => {
    const webstream = {
      photos: [
        {
          photoGuid: "PRODUCT-NEWER",
          dateCreated: "2026-09-01T09:01:00Z",
          derivatives: { "2048": { checksum: "chk-product" } },
        },
        {
          photoGuid: "MARKER-OLDER",
          dateCreated: "2026-09-01T09:00:00Z",
          derivatives: { "2048": { checksum: "chk-marker" } },
        },
      ],
    };
    const assetUrls = {
      items: {
        "chk-product": {
          url_location: "cvws.icloud-content.com",
          url_path: "/product",
        },
        "chk-marker": {
          url_location: "cvws.icloud-content.com",
          url_path: "/marker",
        },
      },
    };
    const client = createICloudClient(
      "TOKEN-XYZ",
      scriptedFetcher([
        { status: 200, body: webstream },
        { status: 200, body: webstream },
        { status: 200, body: assetUrls },
      ]),
    );

    const snapshot = await client.getSnapshot();

    expect(
      snapshot.photos.map(({ applePhotoId, position }) => ({
        applePhotoId,
        position,
      })),
    ).toEqual([
      { applePhotoId: "PRODUCT-NEWER", position: 1 },
      { applePhotoId: "MARKER-OLDER", position: 0 },
    ]);
    const grouped = groupByMarkers(
      snapshot.photos.map((photo) => ({
        applePhotoId: photo.applePhotoId,
        position: photo.position,
        isMarker: photo.applePhotoId === "MARKER-OLDER",
        r2Key: `assets/${photo.applePhotoId}.jpg`,
      })),
    );
    expect(grouped.orphanPhotos).toEqual([]);
    expect(grouped.groups[0]?.photos.map((photo) => photo.applePhotoId)).toEqual([
      "MARKER-OLDER",
      "PRODUCT-NEWER",
    ]);
  });

  it("returns ordered SourcePhotos with resolved derivative URLs", async () => {
    const fetcher = scriptedFetcher([
      { status: 200, body: WEBSTREAM_FIXTURE },
      { status: 200, body: WEBSTREAM_FIXTURE },
      { status: 200, body: WEBASSETURLS_FIXTURE },
    ]);
    const client = createICloudClient("TOKEN-XYZ", fetcher);
    const snapshot = await client.getSnapshot();

    expect(snapshot.sourceAlbumId).toBe("3447794384db61d5cd68a9ee046c489845550d1ea100612136598c82b3f9e2ef");
    expect(snapshot.sourceAlbumId).not.toContain("TOKEN-XYZ");
    expect(snapshot.photos).toHaveLength(2);
    expect(snapshot.photos[0]).toMatchObject({
      applePhotoId: "AAAA-1111",
      position: 0,
      mediaType: "image/jpeg",
    });
    expect(snapshot.photos[0]!.derivativeUrl).toBe(
      "https://cvws.icloud-content.com/A/aaaa?o=1&v=1&x=1&s=1&a=1&k=1&e=1"
    );
    expect(snapshot.photos[1]!.applePhotoId).toBe("BBBB-2222");
  });

  async function readLegacy(ids: string[], dates: Array<string | null | undefined>) {
    const photos = ids.map((photoGuid, i) => ({photoGuid, dateCreated: dates[i], derivatives: {"2048": {checksum: photoGuid}}}));
    return createICloudClient("TOKEN-XYZ", scriptedFetcher([
      {status: 200, body: {photos}}, {status: 200, body: {photos}},
      {status: 200, body: {items: Object.fromEntries(ids.map(id => [id, {url_location: "cvws.icloud-content.com", url_path: `/${id}`}]))}},
    ])).getSnapshot();
  }

  it("recovers product and ignore boundaries from shuffled capture instants without changing strings", async () => {
    const ids = ["old-marker", "old-1", "old-2", "old-3", "old-4", "new-marker", "new-1", "new-2", "new-3", "new-4", "ignore", "ignored-1", "ignored-2", "ignored-3", "ignored-4"];
    const dates = ids.map((_, i) => `2026-09-01T09:00:${String(i).padStart(2, "0")}Z`);
    dates[1] = "2026-09-01T16:00:01+07:00";
    dates[2] = "2026-09-01T09:00:02.0001Z";
    dates[3] = "2026-09-01T09:00:02.0002Z";
    const results = [];
    for (const order of [[5, 3, 12, 0, 14, 2, 10, 8, 1, 6, 13, 4, 9, 11, 7], [14, 0, 8, 1, 7, 10, 4, 11, 2, 12, 3, 13, 5, 9, 6]]) {
      const snapshot = await readLegacy(order.map(i => ids[i]!), order.map(i => dates[i]!));
      expect([...snapshot.photos].sort((a,b) => a.position-b.position).map(p => p.applePhotoId)).toEqual(ids);
      expect(snapshot.photos.find(p => p.applePhotoId === "old-1")?.captureAt).toBe(dates[1]);
      const grouped = groupByMarkers(snapshot.photos.map(p => ({...p, isMarker: p.applePhotoId.endsWith("marker"), markerKind: p.applePhotoId === "ignore" ? "ignore_start" as const : p.applePhotoId.endsWith("marker") ? "product_start" as const : "none" as const, r2Key: p.applePhotoId})));
      expect(grouped.groups.map(g => g.photos.map(p => p.applePhotoId))).toEqual([ids.slice(0,5), ids.slice(5,10)]);
      expect(grouped.ignoredPhotos.map(p => p.applePhotoId)).toEqual(ids.slice(10));
      expect(grouped.orphanPhotos).toEqual([]);
      results.push(grouped);
    }
    expect(results[0]).toEqual(results[1]);
  });

  it.each([null, undefined, "bad-date", "2026-02-30T09:00:00Z", "2026-09-01T09:00:00"])("rejects unusable capture time %s", async date => {
    await expect(readLegacy(["marker"], [date])).rejects.toMatchObject({code: "icloud_invalid_photo_order", retryable: false});
  });

  it.each(["2026-09-01T09:00:00.000Z", "2026-09-01T16:00:00+07:00"])("rejects tied instants %s", async date => {
    await expect(readLegacy(["marker", "photo"], ["2026-09-01T09:00:00Z", date])).rejects.toMatchObject({code: "icloud_ambiguous_photo_order", retryable: false});
  });

  it("accepts an empty snapshot", async () => {
    expect((await readLegacy([], [])).photos).toEqual([]);
  });

  it("requests webasseturls using photoGuids, not checksums", async () => {
    const webassetBodies: unknown[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("webasseturls")) {
        webassetBodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
        return new Response(JSON.stringify(WEBASSETURLS_FIXTURE), { status: 200 });
      }
      return new Response(JSON.stringify(WEBSTREAM_FIXTURE), { status: 200 });
    };
    const client = createICloudClient("TOKEN-XYZ", fetcher);
    await client.getSnapshot();
    expect(webassetBodies).toEqual([{ photoGuids: ["AAAA-1111", "BBBB-2222"] }]);
  });

  it("rejects malformed iCloud response bodies without exposing them", async () => {
    const client = createICloudClient(
      "TOKEN-XYZ",
      scriptedFetcher([{ status: 200, body: { photos: "not-an-array" } }]),
    );
    await expect(client.getSnapshot()).rejects.toMatchObject({
      code: "icloud_invalid_webstream_response",
      retryable: false,
    });
  });

  it("keeps existing positions stable when a newer webstream photo is prepended", async () => {
    const prependedPhoto = {
      photoGuid: "CCCC-3333",
      dateCreated: "2026-08-31T09:02:00Z",
      derivatives: { "2048": { checksum: "chk-cccc-2048" } },
    };
    const expandedWebstream = {
      photos: [prependedPhoto, ...WEBSTREAM_FIXTURE.photos],
    };
    const expandedAssetUrls = {
      items: {
        "chk-cccc-2048": {
          url_location: "cvws.icloud-content.com",
          url_path: "/C/cccc",
        },
        ...WEBASSETURLS_FIXTURE.items,
      },
    };
    const clientBefore = createICloudClient(
      "TOKEN-XYZ",
      scriptedFetcher([
        { status: 200, body: WEBSTREAM_FIXTURE },
        { status: 200, body: WEBSTREAM_FIXTURE },
        { status: 200, body: WEBASSETURLS_FIXTURE },
      ]),
    );
    const clientAfter = createICloudClient(
      "TOKEN-XYZ",
      scriptedFetcher([
        { status: 200, body: expandedWebstream },
        { status: 200, body: expandedWebstream },
        { status: 200, body: expandedAssetUrls },
      ]),
    );

    const [before, after] = await Promise.all([
      clientBefore.getSnapshot(),
      clientAfter.getSnapshot(),
    ]);

    expect(
      before.photos.map(({ applePhotoId, position }) => ({
        applePhotoId,
        position,
      })),
    ).toEqual([
      { applePhotoId: "AAAA-1111", position: 0 },
      { applePhotoId: "BBBB-2222", position: 1 },
    ]);
    expect(
      after.photos.map(({ applePhotoId, position }) => ({
        applePhotoId,
        position,
      })),
    ).toEqual([
      { applePhotoId: "CCCC-3333", position: 2 },
      { applePhotoId: "AAAA-1111", position: 0 },
      { applePhotoId: "BBBB-2222", position: 1 },
    ]);
  });
});

describe("createICloudClient.download", () => {
  it("streams the photo's derivative URL through fetch and returns the Response", async () => {
    let requestedUrl = "";
    const fetcher = async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 });
    };
    const client = createICloudClient("TOKEN-XYZ", fetcher);
    const response = await client.download({
      sourceAlbumId: "3447794384db61d5cd68a9ee046c489845550d1ea100612136598c82b3f9e2ef",
      applePhotoId: "AAAA-1111",
      position: 0,
      captureAt: null,
      derivativeUrl: "https://cvws.icloud-content.com/A/aaaa?sig=1",
      mediaType: "image/jpeg",
    });
    expect(requestedUrl).toBe("https://cvws.icloud-content.com/A/aaaa?sig=1");
    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();
  });
});
