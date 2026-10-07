import type { Clock } from "../env";
import { recordUsage } from "../db/usage-repository";
import { todayBangkokDate } from "../shared/time";

export interface AssetPutResult {
  r2Key: string;
  created: boolean;
}

export const AIRTABLE_PREVIEW_VARIANT = "airtable-preview-v1";
export type AssetVariant = typeof AIRTABLE_PREVIEW_VARIANT;

export interface AssetStore {
  putIfAbsent(contentHash: string, extension: string, body: ArrayBuffer, contentType: string): Promise<AssetPutResult>;
  signUrl(r2Key: string, ttlSeconds: number, variant?: AssetVariant): Promise<string>;
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isFiniteInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value);
}

export function createAssetStore(bucket: R2Bucket, config: { signingSecret: string; publicBaseUrl: string }, clock: Clock, db?: D1Database): AssetStore {
  return {
    async putIfAbsent(contentHash, extension, body, contentType) {
      const r2Key = `assets/${contentHash}.${extension}`;
      const created = await bucket.put(r2Key, body, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType },
      });
      if (created === null) return { r2Key, created: false };
      if (db) {
        // ponytail: best-effort metrics; add a durable outbox when billing-grade accuracy is required.
        try {
          await recordUsage(db, "r2_bytes_added", body.byteLength, todayBangkokDate(clock));
        } catch {
          console.warn("Usage metric recording failed");
        }
      }
      return { r2Key, created: true };
    },

    async signUrl(r2Key, ttlSeconds, variant) {
      if (!isFiniteInteger(ttlSeconds) || ttlSeconds <= 0) {
        throw new RangeError("ttlSeconds must be a positive finite integer");
      }
      if (variant !== undefined && variant !== AIRTABLE_PREVIEW_VARIANT) {
        throw new RangeError("unsupported asset variant");
      }
      const expiresAt = Math.floor(clock.now().getTime() / 1000) + ttlSeconds;
      const payload = `${r2Key}:${expiresAt}${variant ? `:${variant}` : ""}`;
      const signature = await hmacHex(config.signingSecret, payload);
      const url = new URL(`/assets/${encodeURIComponent(r2Key)}`, config.publicBaseUrl);
      url.searchParams.set("exp", String(expiresAt));
      url.searchParams.set("sig", signature);
      if (variant) url.searchParams.set("variant", variant);
      return url.toString();
    },
  };
}

export async function verifyAssetToken(
  r2Key: string,
  expiresAtEpochSeconds: number,
  signatureHex: string,
  signingSecret: string,
  nowEpochSeconds: number,
  variant?: AssetVariant,
): Promise<boolean> {
  if (variant !== undefined && variant !== AIRTABLE_PREVIEW_VARIANT) return false;
  if (!isFiniteInteger(expiresAtEpochSeconds) || !isFiniteInteger(nowEpochSeconds)) {
    return false;
  }
  if (nowEpochSeconds > expiresAtEpochSeconds) {
    return false;
  }
  const expected = await hmacHex(signingSecret, `${r2Key}:${expiresAtEpochSeconds}${variant ? `:${variant}` : ""}`);
  if (expected.length !== signatureHex.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signatureHex.charCodeAt(i);
  }
  return diff === 0;
}
