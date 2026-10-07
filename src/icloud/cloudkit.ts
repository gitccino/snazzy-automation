import { z } from "zod";
import type { AlbumSnapshot, ImageSource, SourcePhoto } from "./types";
import { OperationalError } from "../shared/errors";
import { safeFetch, type Fetcher } from "../shared/http";

const ZoneSchema = z.object({
  zoneName: z.string().min(1),
  ownerRecordName: z.string().min(1),
  zoneType: z.literal("REGULAR_CUSTOM_ZONE"),
});
const ResolveSchema = z.object({
  results: z.array(z.object({
    zoneID: ZoneSchema,
    databaseScope: z.literal("SHARED"),
    anonymousPublicAccess: z.object({ token: z.string().min(1), databasePartition: z.string().min(1) }),
  })).length(1),
});
const RecordSchema = z.object({
  recordName: z.string().min(1),
  recordType: z.enum(["CPLAsset", "CPLMaster"]),
  fields: z.record(z.string(), z.object({ value: z.unknown() })),
});
const QuerySchema = z.object({
  records: z.array(RecordSchema),
  continuationMarker: z.string().min(1).optional(),
});
const AssetFieldsSchema = z.object({
  masterRef: z.object({ value: z.object({ recordName: z.string().min(1) }) }),
  assetDate: z.object({ value: z.number().int().min(0).max(8640000000000000) }),
});
const MasterFieldsSchema = z.object({
  resJPEGMedRes: z.object({ value: z.object({ downloadURL: z.string().min(1) }) }).optional(),
  resOriginalRes: z.object({ value: z.object({ downloadURL: z.string().min(1) }) }).optional(),
  resOriginalFileType: z.object({ value: z.string() }).optional(),
  dataClassType: z.object({ value: z.literal(1) }).optional(),
});

function fail(code: string, message: string, retryable = false): never {
  throw new OperationalError(code, message, retryable);
}

function appleUrl(value: string, kind: "partition" | "asset"): URL {
  let url: URL;
  try { url = new URL(value); } catch {
    return fail(`icloud_invalid_${kind === "partition" ? "partition" : "asset_url"}`, "iCloud returned an invalid service URL");
  }
  const allowed = kind === "partition"
    ? /^(?:p\d+-)?ckdatabasews\.icloud\.com(?:\.cn)?$/
    : /^(?:[a-z0-9-]+\.)*icloud-content\.com$/;
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !allowed.test(url.hostname)
    || (kind === "partition" && (url.pathname !== "/" || url.search))) {
    fail(`icloud_invalid_${kind === "partition" ? "partition" : "asset_url"}`, "iCloud returned an invalid service URL");
  }
  return url;
}

export function createCloudKitClient(
  sharingKey: string,
  fetcher: Fetcher,
  sourceAlbumIdPromise: Promise<string>,
): ImageSource {
  async function request(url: URL, init: RequestInit): Promise<Response> {
    // Workers supports manual/follow; reject redirects without forwarding credentials.
    const response = await safeFetch(url.toString(), { ...init, redirect: "manual" }, { fetcher });
    if (response.status >= 300 && response.status < 400) {
      fail("icloud_unexpected_redirect", "iCloud returned an unexpected redirect");
    }
    return response;
  }

  async function post(url: URL, body: unknown): Promise<unknown> {
    const response = await request(url, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://photos.icloud.com" },
      body: JSON.stringify(body),
    });
    let data: unknown;
    try { data = await response.json(); } catch {
      return fail("icloud_invalid_cloudkit_response", "iCloud returned invalid JSON");
    }
    const error = z.object({ serverErrorCode: z.string() }).safeParse(data);
    if (error.success) {
      const code = error.data.serverErrorCode;
      if (["AUTHENTICATION_FAILED", "AUTHENTICATION_REQUIRED", "ACCESS_DENIED", "NOT_AUTHORIZED"].includes(code)) {
        fail("icloud_public_access_required", "iCloud album requires valid public access");
      }
      fail("icloud_cloudkit_unavailable", "iCloud could not complete the album request",
        ["THROTTLED", "TRY_AGAIN_LATER", "INTERNAL_ERROR", "SERVICE_UNAVAILABLE"].includes(code));
    }
    return data;
  }

  function endpoint(host: string, scope: string, operation: string, token?: string): URL {
    const url = new URL(`/database/1/com.apple.photos.cloud/production/${scope}/records/${operation}`, host);
    url.searchParams.set("sharing_url_key", sharingKey);
    url.searchParams.set("remapEnums", "true");
    url.searchParams.set("getCurrentSyncToken", "true");
    if (token) url.searchParams.set("publicAccessAuthToken", token);
    return url;
  }

  async function getSnapshot(): Promise<AlbumSnapshot> {
    const sourceAlbumId = await sourceAlbumIdPromise;
    const raw = await post(endpoint("https://ckdatabasews.icloud.com", "public", "resolve"), {
      shortGUIDs: [{ value: sharingKey }],
    });
    // Minimal resolutions expose metadata even when the album cannot be read anonymously.
    const minimal = z.object({ results: z.array(z.object({
      requireAppleLogin: z.boolean().optional(),
      anonymousPublicAccess: z.unknown().optional(),
    })) }).safeParse(raw);
    if (minimal.success && minimal.data.results.length === 1) {
      const result = minimal.data.results[0]!;
      if (result.requireAppleLogin || !result.anonymousPublicAccess) {
        fail("icloud_public_access_required", "Enable access to this album for anyone with its link");
      }
    }
    const parsed = ResolveSchema.safeParse(raw);
    if (!parsed.success) fail("icloud_invalid_resolve_response", "iCloud returned an invalid album resolution");
    const resolved = parsed.data.results[0]!;
    const access = resolved.anonymousPublicAccess;
    const partition = appleUrl(access.databasePartition, "partition");
    const records = new Map<string, z.infer<typeof RecordSchema>>();
    const cursors = new Set<string>();
    let continuationMarker: string | undefined;
    do {
      const body = await post(endpoint(partition.origin, "shared", "query", access.token), {
        zoneID: resolved.zoneID,
        query: {
          recordType: "CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted",
          filterBy: [{ fieldName: "direction", comparator: "EQUALS", fieldValue: { value: "ASCENDING", type: "STRING" } }],
        },
        resultsLimit: 100,
        ...(continuationMarker ? { continuationMarker } : {}),
      });
      const page = QuerySchema.safeParse(body);
      if (!page.success) fail("icloud_invalid_query_response", "iCloud returned invalid photo records");
      for (const record of page.data.records) records.set(record.recordName, record);
      continuationMarker = page.data.continuationMarker;
      if (continuationMarker) {
        if (cursors.has(continuationMarker)) fail("icloud_invalid_pagination", "iCloud repeated a photo pagination cursor");
        cursors.add(continuationMarker);
      }
    } while (continuationMarker);

    const photos: SourcePhoto[] = [];
    for (const record of records.values()) {
      if (record.recordType !== "CPLAsset") continue;
      const asset = AssetFieldsSchema.safeParse(record.fields);
      if (!asset.success) fail("icloud_invalid_query_response", "iCloud returned invalid photo metadata");
      const master = records.get(asset.data.masterRef.value.recordName);
      const fields = MasterFieldsSchema.safeParse(master?.fields);
      if (master?.recordType !== "CPLMaster" || !fields.success) {
        fail("icloud_missing_asset_url", "iCloud omitted a JPEG photo resource or returned unsupported media");
      }
      // Small JPEGs can have an original resource without a medium derivative.
      const downloadURL = fields.data.resJPEGMedRes?.value.downloadURL
        ?? (fields.data.resOriginalFileType?.value === "public.jpeg"
          ? fields.data.resOriginalRes?.value.downloadURL : undefined);
      if (!downloadURL) {
        fail("icloud_missing_asset_url", "iCloud omitted a JPEG photo resource or returned unsupported media");
      }
      const derivativeUrl = appleUrl(downloadURL, "asset").toString();
      photos.push({
        sourceAlbumId,
        applePhotoId: record.recordName,
        position: 0,
        captureAt: new Date(asset.data.assetDate.value).toISOString(),
        derivativeUrl,
        mediaType: "image/jpeg",
      });
    }
    // Apple may return newest first despite ASCENDING; never use raw record order for markers.
    photos.sort((a, b) => a.captureAt!.localeCompare(b.captureAt!) || a.applePhotoId.localeCompare(b.applePhotoId));
    if (photos.some((photo, index) => index > 0 && photo.captureAt === photos[index - 1]!.captureAt)) {
      fail("icloud_ambiguous_photo_order", "Album photos share a capture timestamp; marker order cannot be established safely");
    }
    photos.forEach((photo, index) => { photo.position = index; });
    return { sourceAlbumId, fetchedAt: new Date().toISOString(), photos };
  }

  async function download(photo: SourcePhoto): Promise<Response> {
    const url = appleUrl(photo.derivativeUrl, "asset");
    return request(url, {});
  }

  return { getSnapshot, download };
}
