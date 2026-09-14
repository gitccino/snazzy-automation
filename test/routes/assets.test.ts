import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";
import { createAssetStore } from "../../src/import/asset-store";
import { handleGetAsset } from "../../src/routes/assets";
import { fixedClock } from "../helpers/fakes";

describe("GET /assets/:key", () => {
  it("streams the object for a valid, unexpired signature", async () => {
    const env = testEnv();
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const store = createAssetStore(env.IMAGES_BUCKET, { signingSecret: env.ASSET_URL_SIGNING_SECRET, publicBaseUrl: "https://example.workers.dev" }, clock);
    const body = new TextEncoder().encode("fake-jpeg-bytes").buffer as ArrayBuffer;
    const { r2Key } = await store.putIfAbsent(`hash-${crypto.randomUUID()}`, "jpg", body, "image/jpeg");
    const url = await store.signUrl(r2Key, 300);

    const response = await handleGetAsset(new Request(url), env, clock);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("fake-jpeg-bytes");
  });

  it("returns 403 for a missing signature", async () => {
    const env = testEnv();
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const response = await handleGetAsset(new Request("https://example.workers.dev/assets/assets%2Fhash-1.jpg"), env, clock);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
  });

  it("returns 403 for an expired signature", async () => {
    const env = testEnv();
    const store = createAssetStore(env.IMAGES_BUCKET, { signingSecret: env.ASSET_URL_SIGNING_SECRET, publicBaseUrl: "https://example.workers.dev" }, fixedClock("2026-09-01T09:00:00.000Z"));
    const { r2Key } = await store.putIfAbsent(`hash-${crypto.randomUUID()}`, "jpg", new ArrayBuffer(0), "image/jpeg");
    const url = await store.signUrl(r2Key, 60);

    const response = await handleGetAsset(new Request(url), env, fixedClock("2026-09-01T09:05:00.000Z"));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
  });

  it("returns 404 when the signature is valid but the object was never stored", async () => {
    const env = testEnv();
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const store = createAssetStore(env.IMAGES_BUCKET, { signingSecret: env.ASSET_URL_SIGNING_SECRET, publicBaseUrl: "https://example.workers.dev" }, clock);
    const url = await store.signUrl("assets/never-stored.jpg", 300);
    const response = await handleGetAsset(new Request(url), env, clock);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });

  it("returns generic 403 for malformed percent encoding in the asset path", async () => {
    const env = testEnv();
    const response = await handleGetAsset(new Request("https://example.workers.dev/assets/%?exp=1&sig=anything"), env, fixedClock("2026-09-01T09:00:00.000Z"));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
  });

  it("returns 403 when a valid signed URL has an extra exp parameter", async () => {
    const env = testEnv();
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const url = new URL(await signedStoredUrl(env, clock));
    url.searchParams.append("exp", "0");

    const response = await handleGetAsset(new Request(url), env, clock);

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
  });

  it("returns 403 when a valid signed URL has an extra sig parameter", async () => {
    const env = testEnv();
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const url = new URL(await signedStoredUrl(env, clock));
    url.searchParams.append("sig", "invalid");

    const response = await handleGetAsset(new Request(url), env, clock);

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
  });

  it("returns 403 when duplicate authorization parameters are ordered with invalid values first", async () => {
    const env = testEnv();
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const signedUrl = new URL(await signedStoredUrl(env, clock));
    const exp = signedUrl.searchParams.get("exp")!;
    const sig = signedUrl.searchParams.get("sig")!;
    const reversedDuplicates = new URL(signedUrl);
    reversedDuplicates.search = `?exp=0&exp=${exp}&sig=invalid&sig=${sig}`;

    const response = await handleGetAsset(new Request(reversedDuplicates), env, clock);

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
  });
});

async function signedStoredUrl(env: ReturnType<typeof testEnv>, clock: ReturnType<typeof fixedClock>): Promise<string> {
  const store = createAssetStore(env.IMAGES_BUCKET, { signingSecret: env.ASSET_URL_SIGNING_SECRET, publicBaseUrl: "https://example.workers.dev" }, clock);
  const { r2Key } = await store.putIfAbsent(`hash-${crypto.randomUUID()}`, "jpg", new ArrayBuffer(0), "image/jpeg");
  return store.signUrl(r2Key, 300);
}
