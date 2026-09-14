import type { Clock, Env } from "../env";
import { verifyAssetToken } from "../import/asset-store";

export async function handleGetAsset(request: Request, env: Env, clock: Clock): Promise<Response> {
  const url = new URL(request.url);
  let r2Key: string;

  try {
    r2Key = decodeURIComponent(url.pathname.replace(/^\/assets\//, ""));
  } catch (error) {
    if (error instanceof URIError) {
      return forbidden();
    }
    throw error;
  }

  const expParam = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  if (r2Key === "" || expParam === null || sig === null) {
    return forbidden();
  }

  const expiresAt = Number(expParam);
  const nowSeconds = Math.floor(clock.now().getTime() / 1000);
  const valid = await verifyAssetToken(r2Key, expiresAt, sig, env.ASSET_URL_SIGNING_SECRET, nowSeconds);
  if (!valid) {
    return forbidden();
  }

  const object = await env.IMAGES_BUCKET.get(r2Key);
  if (object === null) {
    return new Response("not found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=60");
  return new Response(object.body, { status: 200, headers });
}

function forbidden(): Response {
  return new Response("forbidden", { status: 403 });
}
