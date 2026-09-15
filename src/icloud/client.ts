import { z } from "zod";
import { discoverHost } from "./token";
import type { AlbumSnapshot, ImageSource, SourcePhoto } from "./types";
import { OperationalError } from "../shared/errors";
import { safeFetch, type Fetcher } from "../shared/http";
import { sha256Hex } from "../shared/ids";

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

export function deriveSourceAlbumId(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}

export function createICloudClient(token: string, fetcher: Fetcher): ImageSource {
  const redact = [new RegExp(token, "g")];
  const sourceAlbumIdPromise = deriveSourceAlbumId(token);

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

    const photos: SourcePhoto[] = webstream.photos.map((photo, index) => {
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
        position: webstream.photos.length - 1 - index,
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
