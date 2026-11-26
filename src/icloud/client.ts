import { z } from "zod";
import { discoverHost } from "./token";
import type { AlbumSnapshot, ImageSource, SourcePhoto } from "./types";
import { OperationalError } from "../shared/errors";
import { safeFetch, type Fetcher } from "../shared/http";
import { sha256Hex } from "../shared/ids";
import { createCloudKitClient } from "./cloudkit";

const DerivativesSchema = z.record(
  z.string(),
  z.object({ checksum: z.string().min(1) }),
).refine((value) => Object.keys(value).length > 0);
const WebstreamPhotoSchema = z.object({
  photoGuid: z.string().min(1),
  dateCreated: z.string().nullable().optional(),
  derivatives: DerivativesSchema,
});
const WebstreamResponseSchema = z.object({
  photos: z.array(WebstreamPhotoSchema),
});
const WebAssetUrlsResponseSchema = z.object({
  items: z.record(
    z.string(),
    z.object({
      url_location: z.string().min(1),
      url_path: z.string().min(1),
    }),
  ),
});
type WebstreamPhoto = z.infer<typeof WebstreamPhotoSchema>;

async function parseICloudJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  code: string,
): Promise<T> {
  try {
    return schema.parse(await response.json());
  } catch {
    throw new OperationalError(
      code,
      "iCloud returned a malformed response",
      false,
    );
  }
}

function pickBestDerivativeChecksum(photo: WebstreamPhoto): string {
  const keys = Object.keys(photo.derivatives).map(Number).sort((a, b) => b - a);
  const bestKey = String(keys[0]);
  return photo.derivatives[bestKey]!.checksum;
}

function captureOrder(photos: WebstreamPhoto[]): Map<WebstreamPhoto, number> {
  const ordered = photos.map(photo => {
    const capture = photo.dateCreated;
    if (!capture || !z.iso.datetime({ offset: true }).safeParse(capture).success) {
      throw new OperationalError("icloud_invalid_photo_order", "Album photos need valid capture timestamps with UTC offsets; marker order cannot be established safely", false);
    }
    // Compare fractional seconds exactly, including precision beyond JavaScript milliseconds.
    const fraction = /\.(\d+)/.exec(capture)?.[1]?.replace(/0+$/, "") ?? "";
    const second = Date.parse(capture.replace(/\.\d+/, ""));
    if (!Number.isFinite(second)) {
      throw new OperationalError("icloud_invalid_photo_order", "Album capture timestamps cannot establish marker order safely", false);
    }
    return { photo, second, fraction };
  });
  const compare = (a: typeof ordered[number], b: typeof ordered[number]) => a.second - b.second ||
    a.fraction.padEnd(Math.max(a.fraction.length, b.fraction.length), "0").localeCompare(b.fraction.padEnd(Math.max(a.fraction.length, b.fraction.length), "0"));
  ordered.sort(compare);
  if (ordered.some((entry, i) => i > 0 && compare(entry, ordered[i - 1]!) === 0)) {
    throw new OperationalError("icloud_ambiguous_photo_order", "Album photos share a capture timestamp; marker order cannot be established safely", false);
  }
  return new Map(ordered.map(({photo}, position) => [photo, position]));
}

function parseAlbumSource(input: string): { key: string; cloudKit: boolean } {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]+$/.test(value)) return { key: value, cloudKit: false };
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search) throw new Error();
    if (["photos.icloud.com", "photos.icloud.com.cn"].includes(url.hostname) && !url.hash) {
      const match = /^\/shared\/album\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
      if (match) return { key: match[1]!, cloudKit: true };
    }
    if (["www.icloud.com", "icloud.com"].includes(url.hostname) && /^\/sharedalbum\/?$/.test(url.pathname)) {
      const key = url.hash.slice(1);
      if (/^[A-Za-z0-9_-]+$/.test(key)) return { key, cloudKit: false };
    }
  } catch { /* Report a redacted configuration error below. */ }
  throw new OperationalError("icloud_invalid_album_source", "Use a legacy album token or a supported iCloud shared album URL", false);
}

export async function deriveSourceAlbumId(input: string): Promise<string> {
  const { key, cloudKit } = parseAlbumSource(input);
  return sha256Hex(new TextEncoder().encode(cloudKit ? `icloud27:${key}` : key));
}

export function createICloudClient(input: string, fetcher: Fetcher): ImageSource {
  const { key: token, cloudKit } = parseAlbumSource(input);
  const sourceAlbumIdPromise = deriveSourceAlbumId(input);
  if (cloudKit) return createCloudKitClient(token, fetcher, sourceAlbumIdPromise);
  const redact = [new RegExp(token, "g")];

  async function getSnapshot(): Promise<AlbumSnapshot> {
    const sourceAlbumId = await sourceAlbumIdPromise;
    const { host } = await discoverHost(token, fetcher);

    const webstreamRes = await safeFetch(
      `https://${host}/${token}/sharedstreams/webstream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ streamCtag: null }),
      },
      { fetcher, redactUrlPatterns: redact }
    );
    const webstream = await parseICloudJson(
      webstreamRes,
      WebstreamResponseSchema,
      "icloud_invalid_webstream_response",
    );
    const positions = captureOrder(webstream.photos);
    const photoGuids = webstream.photos.map((photo) => photo.photoGuid);

    const assetUrlsRes = await safeFetch(
      `https://${host}/${token}/sharedstreams/webasseturls`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ photoGuids }),
      },
      { fetcher, redactUrlPatterns: redact }
    );
    const assetUrls = await parseICloudJson(
      assetUrlsRes,
      WebAssetUrlsResponseSchema,
      "icloud_invalid_asset_urls_response",
    );

    const photos: SourcePhoto[] = webstream.photos.map((photo) => {
      const checksum = pickBestDerivativeChecksum(photo);
      const asset = assetUrls.items[checksum];
      if (!asset) {
        throw new OperationalError(
          "icloud_missing_asset_url",
          `iCloud omitted derivative ${checksum}`,
          false,
        );
      }
      return {
        sourceAlbumId,
        applePhotoId: photo.photoGuid,
        position: positions.get(photo)!,
        captureAt: photo.dateCreated ?? null,
        derivativeUrl: `https://${asset.url_location}${asset.url_path}`,
        mediaType: "image/jpeg",
      };
    });

    return { sourceAlbumId, fetchedAt: new Date().toISOString(), photos };
  }

  async function download(photo: SourcePhoto): Promise<Response> {
    return safeFetch(photo.derivativeUrl, undefined, { fetcher, redactUrlPatterns: redact });
  }

  return { getSnapshot, download };
}
