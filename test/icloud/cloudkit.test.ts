import { describe, expect, it } from "vitest";
import { createICloudClient, deriveSourceAlbumId } from "../../src/icloud/client";
import { groupByMarkers } from "../../src/import/grouping";
import { redactText } from "../../src/shared/logger";
import type { Fetcher } from "../../src/shared/http";

const albumUrl = "https://photos.icloud.com/shared/album/NEW-ALBUM-KEY";
const zoneID = { zoneName: "album-zone", ownerRecordName: "owner", zoneType: "REGULAR_CUSTOM_ZONE" };
const resolved = {
  results: [{
    zoneID,
    databaseScope: "SHARED",
    anonymousPublicAccess: { token: "TEMP-ACCESS-SECRET", databasePartition: "https://p180-ckdatabasews.icloud.com" },
  }],
};

function master(id: string) {
  return {
    recordType: "CPLMaster", recordName: id,
    fields: { resJPEGMedRes: { value: { downloadURL: `https://cvws.icloud-content.com/${id}.jpg?s=private` } } },
  };
}

function asset(id: string, masterId: string, date: number) {
  return {
    recordType: "CPLAsset", recordName: id,
    fields: { masterRef: { value: { recordName: masterId } }, assetDate: { value: date } },
  };
}

// External Apple HTTP is replaced; source mapping and marker grouping run unchanged.
function appleFetcher(pages: unknown[], resolveBody: unknown = resolved): Fetcher {
  let page = 0;
  return async (input, init) => {
    // Exercise Worker request validation before replacing Apple's external HTTP.
    expect(new Request(input, init).redirect).toBe("manual");
    const url = new URL(String(input));
    if (url.pathname.endsWith("/records/resolve")) {
      expect(url.hostname).toBe("ckdatabasews.icloud.com");
      expect(url.searchParams.get("sharing_url_key")).toBe("NEW-ALBUM-KEY");
      expect(JSON.parse(String(init?.body))).toEqual({ shortGUIDs: [{ value: "NEW-ALBUM-KEY" }] });
      return Response.json(resolveBody);
    }
    if (url.pathname.endsWith("/records/query")) {
      expect(url.hostname).toBe("p180-ckdatabasews.icloud.com");
      expect(url.searchParams.get("publicAccessAuthToken")).toBe("TEMP-ACCESS-SECRET");
      const body = JSON.parse(String(init?.body));
      expect(body.zoneID).toEqual(zoneID);
      expect(body.query.recordType).toBe("CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted");
      expect(body.continuationMarker).toBe(page === 0 ? undefined : "next-page");
      const result = pages[page++];
      if (result === undefined) throw new Error("Unexpected extra page request");
      return Response.json(result);
    }
    if (url.hostname === "cvws.icloud-content.com") {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "application/octet-stream" } });
    }
    throw new Error("Unexpected endpoint");
  };
}

describe("iOS 27 ImageSource compatibility", () => {
  it("joins records across pages, orders markers before products, and downloads JPEGs", async () => {
    const client = createICloudClient(albumUrl, appleFetcher([
      { records: [master("master-product"), asset("product", "master-product", 1790762460000)], continuationMarker: "next-page" },
      { records: [master("master-marker"), asset("marker", "master-marker", 1790762400000)] },
    ]));
    const snapshot = await client.getSnapshot();
    expect(snapshot.sourceAlbumId).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.photos).toMatchObject([
      { applePhotoId: "marker", position: 0, captureAt: "2026-09-30T10:00:00.000Z", mediaType: "image/jpeg" },
      { applePhotoId: "product", position: 1, captureAt: "2026-09-30T10:01:00.000Z", mediaType: "image/jpeg" },
    ]);
    expect(snapshot.photos[0]!.sourceAlbumId).toBe(snapshot.sourceAlbumId);
    const groups = groupByMarkers(snapshot.photos.map(photo => ({
      ...photo, isMarker: photo.applePhotoId === "marker", r2Key: photo.applePhotoId,
    })));
    expect(groups.orphanPhotos).toEqual([]);
    expect(groups.groups[0]!.photos.map(photo => photo.applePhotoId)).toEqual(["marker", "product"]);
    const image = await client.download(snapshot.photos[0]!);
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([0xff, 0xd8, 0xff]);
  });

  it("refreshes public access credentials for each snapshot", async () => {
    let resolves = 0;
    const fetcher: Fetcher = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/resolve")) {
        return Response.json({ results: [{ ...resolved.results[0], anonymousPublicAccess: {
          ...resolved.results[0]!.anonymousPublicAccess, token: `temporary-${++resolves}`,
        } }] });
      }
      if (url.searchParams.get("publicAccessAuthToken") !== `temporary-${resolves}`) {
        return Response.json({ serverErrorCode: "AUTHENTICATION_FAILED" });
      }
      return Response.json({ records: [] });
    };
    const client = createICloudClient(albumUrl, fetcher);
    expect((await client.getSnapshot()).photos).toEqual([]);
    expect((await client.getSnapshot()).photos).toEqual([]);
    expect(resolves).toBe(2);
  });

  it("keeps album identity stable across URL formatting and separate from legacy tokens", async () => {
    expect(await deriveSourceAlbumId("https://www.icloud.com/sharedalbum/#TOKEN-XYZ")).toBe(
      "3447794384db61d5cd68a9ee046c489845550d1ea100612136598c82b3f9e2ef",
    );
    expect(await deriveSourceAlbumId(` ${albumUrl}/ `)).toBe(await deriveSourceAlbumId(albumUrl));
    expect(await deriveSourceAlbumId(albumUrl)).not.toBe(await deriveSourceAlbumId("NEW-ALBUM-KEY"));
  });

  it("routes legacy URLs through the existing sharedstreams client", async () => {
    const client = createICloudClient("https://www.icloud.com/sharedalbum/#TOKEN-XYZ", async input => {
      if (!String(input).includes("/TOKEN-XYZ/sharedstreams/")) return new Response("bad token", { status: 400 });
      return Response.json(String(input).endsWith("webasseturls") ? { items: {} } : { photos: [] });
    });
    expect((await client.getSnapshot()).sourceAlbumId).toBe("3447794384db61d5cd68a9ee046c489845550d1ea100612136598c82b3f9e2ef");
  });

  it.each([
    "https://evil.example/shared/album/NEW-ALBUM-KEY",
    "https://photos.icloud.com.evil.example/shared/album/NEW-ALBUM-KEY",
    "http://photos.icloud.com/shared/album/NEW-ALBUM-KEY",
    "https://user:pass@photos.icloud.com/shared/album/NEW-ALBUM-KEY",
    "https://photos.icloud.com/shared/album/",
    "https://photos.icloud.com/shared/album/NEW-ALBUM-KEY?unexpected=secret",
    "https://photos.icloud.com:444/shared/album/NEW-ALBUM-KEY",
  ])("rejects invalid album configuration: %s", async input => {
    await expect(deriveSourceAlbumId(input)).rejects.toMatchObject({ code: "icloud_invalid_album_source", retryable: false });
  });

  it.each([
    [{ results: [{ requireAppleLogin: true }] }, "icloud_public_access_required"],
    [{ results: [{ ...resolved.results[0], anonymousPublicAccess: undefined }] }, "icloud_public_access_required"],
    [{ results: [{ ...resolved.results[0], anonymousPublicAccess: { token: "secret", databasePartition: "https://evil.example" } }] }, "icloud_invalid_partition"],
    [{ results: [{ ...resolved.results[0], databaseScope: "PRIVATE" }] }, "icloud_invalid_resolve_response"],
    [{ results: [] }, "icloud_invalid_resolve_response"],
  ])("rejects unusable resolve responses", async (body, code) => {
    const client = createICloudClient(albumUrl, appleFetcher([], body));
    await expect(client.getSnapshot()).rejects.toMatchObject({ code, retryable: false });
  });

  it.each([
    [{ records: "broken" }, "icloud_invalid_query_response", false],
    [{ records: [asset("product", "absent-master", 1790762400000)] }, "icloud_missing_asset_url", false],
    [{ serverErrorCode: "AUTHENTICATION_FAILED", reason: "TEMP-ACCESS-SECRET" }, "icloud_public_access_required", false],
    [{ serverErrorCode: "THROTTLED" }, "icloud_cloudkit_unavailable", true],
    [{ records: [{ serverErrorCode: "UNKNOWN_ITEM" }] }, "icloud_invalid_query_response", false],
  ])("fails safely on incomplete or errored photo responses", async (body, code, retryable) => {
    const client = createICloudClient(albumUrl, appleFetcher([body]));
    await expect(client.getSnapshot()).rejects.toMatchObject({ code, retryable });
  });

  it("rejects repeated pagination cursors instead of importing an incomplete album", async () => {
    const client = createICloudClient(albumUrl, appleFetcher([
      { records: [], continuationMarker: "next-page" },
      { records: [], continuationMarker: "next-page" },
    ]));
    await expect(client.getSnapshot()).rejects.toMatchObject({ code: "icloud_invalid_pagination", retryable: false });
  });

  it("rejects image URLs outside Apple's CDN", async () => {
    const record = master("master-product");
    record.fields.resJPEGMedRes.value.downloadURL = "https://evil.example/image.jpg";
    const client = createICloudClient(albumUrl, appleFetcher([{ records: [record, asset("product", "master-product", 1790762400000)] }]));
    await expect(client.getSnapshot()).rejects.toMatchObject({ code: "icloud_invalid_asset_url", retryable: false });
  });

  it("rejects tied capture times instead of inventing marker order", async () => {
    const client = createICloudClient(albumUrl, appleFetcher([{ records: [
      master("master-marker"), master("master-product"),
      asset("marker", "master-marker", 1790762400000), asset("product", "master-product", 1790762400000),
    ] }]));
    await expect(client.getSnapshot()).rejects.toMatchObject({ code: "icloud_ambiguous_photo_order", retryable: false });
  });

  it("deduplicates repeated records without changing existing positions when new photos arrive", async () => {
    const oldRecords = [master("master-marker"), asset("marker", "master-marker", 1790762400000)];
    const before = await createICloudClient(albumUrl, appleFetcher([{ records: oldRecords }])).getSnapshot();
    const after = await createICloudClient(albumUrl, appleFetcher([
      { records: oldRecords, continuationMarker: "next-page" },
      { records: [...oldRecords, master("master-product"), asset("product", "master-product", 1790762460000)] },
    ])).getSnapshot();
    expect(after.photos).toHaveLength(2);
    expect(after.photos[0]).toEqual(before.photos[0]);
    expect(after.photos[1]).toMatchObject({ applePhotoId: "product", position: 1 });
  });

  it("does not leak sharing keys or temporary tokens in HTTP errors", async () => {
    const client = createICloudClient(albumUrl, async input => String(input).includes("/resolve")
      ? Response.json(resolved) : new Response("private body", { status: 500 }));
    const error = await client.getSnapshot().catch(error => error as Error);
    expect(error).toMatchObject({ code: "HTTP_5XX", retryable: true });
    if (!(error instanceof Error)) throw new Error("Expected an HTTP error");
    expect(error.message).not.toContain("TEMP-ACCESS-SECRET");
    expect(error.message).not.toContain("NEW-ALBUM-KEY");
    expect(redactText(`failed ${albumUrl} ?sharing_url_key=NEW-ALBUM-KEY&publicAccessAuthToken=TEMP-ACCESS-SECRET`)).not.toMatch(/NEW-ALBUM-KEY|TEMP-ACCESS-SECRET/);
  });

  it.each([301, 302, 303, 307, 308])("rejects HTTP %s without forwarding album credentials", async status => {
    let calls = 0;
    const client = createICloudClient(albumUrl, async (input, init) => {
      expect(new Request(input, init).redirect).toBe("manual");
      calls++;
      return new Response(null, { status, headers: { location: "https://evil.example/?publicAccessAuthToken=secret" } });
    });
    await expect(client.getSnapshot()).rejects.toMatchObject({ code: "icloud_unexpected_redirect", retryable: false });
    expect(calls).toBe(1);
  });

  it("rejects a redirected JPEG download", async () => {
    const client = createICloudClient(albumUrl, async (input, init) => {
      expect(new Request(input, init).redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "https://evil.example/image.jpg" } });
    });
    await expect(client.download({
      sourceAlbumId: "album", applePhotoId: "photo", position: 0, captureAt: null,
      derivativeUrl: "https://cvws.icloud-content.com/photo.jpg?s=private", mediaType: "image/jpeg",
    })).rejects.toMatchObject({ code: "icloud_unexpected_redirect", retryable: false });
  });
});
