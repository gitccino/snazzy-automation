import type { Clock, Env } from "../env";
import { AIRTABLE_PREVIEW_VARIANT, verifyAssetToken } from "../import/asset-store";

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

  const expParams = url.searchParams.getAll("exp");
  const sigParams = url.searchParams.getAll("sig");
  const variantParams = url.searchParams.getAll("variant");
  if (r2Key === "" || expParams.length !== 1 || sigParams.length !== 1
    || variantParams.length > 1
    || (variantParams.length === 1 && variantParams[0] !== AIRTABLE_PREVIEW_VARIANT)) {
    return forbidden();
  }

  const expiresAt = Number(expParams[0]);
  const variant = variantParams.length === 1 ? AIRTABLE_PREVIEW_VARIANT : undefined;
  const nowSeconds = Math.floor(clock.now().getTime() / 1000);
  const valid = await verifyAssetToken(r2Key, expiresAt, sigParams[0]!, env.ASSET_URL_SIGNING_SECRET, nowSeconds, variant);
  if (!valid) {
    return forbidden();
  }

  const object = await env.IMAGES_BUCKET.get(r2Key);
  if (object === null) {
    return new Response("not found", { status: 404 });
  }

  if (variant === AIRTABLE_PREVIEW_VARIANT) {
    const output = await env.IMAGES.input(object.body)
      .transform({ width: 1200, height: 1200, fit: "scale-down" })
      .output({ format: "image/jpeg", quality: 80 });
    const preview = output.response();
    if (!preview.ok || preview.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "image/jpeg") {
      return new Response("image preview unavailable", { status: 502 });
    }
    return new Response(preview.body, { headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=60",
    } });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=60");
  return new Response(object.body, { status: 200, headers });
}

function forbidden(): Response {
  return new Response("forbidden", { status: 403 });
}
