import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";
import { createAssetStore, verifyAssetToken } from "../../src/import/asset-store";
import { fixedClock } from "../helpers/fakes";

describe("asset-store", () => {
  it("stores a new object once and reports created=true", async () => {
    const store = createAssetStore(testEnv().IMAGES_BUCKET, { signingSecret: "test-secret", publicBaseUrl: "https://example.workers.dev" }, fixedClock("2026-09-01T09:00:00.000Z"));
    const hash = `hash-${crypto.randomUUID()}`;
    const body = new TextEncoder().encode("fake-jpeg-bytes").buffer as ArrayBuffer;

    const first = await store.putIfAbsent(hash, "jpg", body, "image/jpeg");
    expect(first).toEqual({ r2Key: `assets/${hash}.jpg`, created: true });

    const second = await store.putIfAbsent(hash, "jpg", body, "image/jpeg");
    expect(second).toEqual({ r2Key: `assets/${hash}.jpg`, created: false });
  });

  it("signs a URL that verifies before expiry and rejects after expiry", async () => {
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const store = createAssetStore(testEnv().IMAGES_BUCKET, { signingSecret: "test-secret", publicBaseUrl: "https://example.workers.dev" }, clock);
    const url = await store.signUrl("assets/hash-1.jpg", 300);

    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://example.workers.dev");
    const exp = Number(parsed.searchParams.get("exp"));
    const sig = parsed.searchParams.get("sig")!;

    const validNow = Math.floor(new Date("2026-09-01T09:04:00.000Z").getTime() / 1000);
    expect(await verifyAssetToken("assets/hash-1.jpg", exp, sig, "test-secret", validNow)).toBe(true);

    const expiredNow = Math.floor(new Date("2026-09-01T09:06:00.000Z").getTime() / 1000);
    expect(await verifyAssetToken("assets/hash-1.jpg", exp, sig, "test-secret", expiredNow)).toBe(false);
  });

  it("rejects a signature for a different key", async () => {
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const store = createAssetStore(testEnv().IMAGES_BUCKET, { signingSecret: "test-secret", publicBaseUrl: "https://example.workers.dev" }, clock);
    const url = await store.signUrl("assets/hash-1.jpg", 300);
    const parsed = new URL(url);
    const exp = Number(parsed.searchParams.get("exp"));
    const sig = parsed.searchParams.get("sig")!;
    const now = Math.floor(new Date("2026-09-01T09:01:00.000Z").getTime() / 1000);
    expect(await verifyAssetToken("assets/other-key.jpg", exp, sig, "test-secret", now)).toBe(false);
  });
});
