import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  createGoogleAuthClient,
  parseServiceAccountJson,
  signServiceAccountJwt,
} from "../../src/publication/google-auth";
import type { Fetcher } from "../../src/shared/http";

let privateKeyPem: string;
let publicKeyDer: ArrayBuffer;

beforeAll(() => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privateKeyPem = privateKey;
  const body = publicKey
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  publicKeyDer = Uint8Array.from(atob(body), (character) => character.charCodeAt(0)).buffer;
});

function base64UrlDecode(segment: string): string {
  const padded = segment
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(segment.length / 4) * 4, "=");
  return atob(padded);
}

describe("parseServiceAccountJson", () => {
  it("extracts and validates client_email and PKCS#8 private_key", () => {
    const result = parseServiceAccountJson(JSON.stringify({
      client_email: "svc@example.iam.gserviceaccount.com",
      private_key: privateKeyPem,
    }));

    expect(result).toEqual({
      client_email: "svc@example.iam.gserviceaccount.com",
      private_key: privateKeyPem,
    });
  });

  it("rejects malformed secret JSON at the configuration boundary", () => {
    expect(() => parseServiceAccountJson(JSON.stringify({
      client_email: "not-an-email",
      private_key: "not-a-key",
    }))).toThrow();
  });
});

describe("signServiceAccountJwt", () => {
  it("produces a JWT with correct header, claims, and a verifiable RS256 signature", async () => {
    const clock = { now: () => new Date("2026-09-01T05:00:00.000Z") };
    const jwt = await signServiceAccountJwt(
      { client_email: "svc@example.iam.gserviceaccount.com", private_key: privateKeyPem },
      clock,
      ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/documents"],
    );

    const [headerB64, claimsB64, signatureB64] = jwt.split(".");
    if (!headerB64 || !claimsB64 || !signatureB64) {
      throw new Error("JWT must contain three segments");
    }
    const header = JSON.parse(base64UrlDecode(headerB64));
    const claims = JSON.parse(base64UrlDecode(claimsB64));

    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims.iss).toBe("svc@example.iam.gserviceaccount.com");
    expect(claims.scope).toBe("https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claims.iat).toBe(1788238800);
    expect(claims.exp).toBe(1788242400);

    const publicKey = await crypto.subtle.importKey(
      "spki",
      publicKeyDer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signingInput = `${headerB64}.${claimsB64}`;
    const signatureBytes = Uint8Array.from(base64UrlDecode(signatureB64), (character) => character.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      signatureBytes,
      new TextEncoder().encode(signingInput),
    );

    expect(valid).toBe(true);
  });
});

describe("createGoogleAuthClient", () => {
  it("exchanges the signed JWT for an access token and caches it until near expiry", async () => {
    const clock = { now: () => new Date("2026-09-01T05:00:00.000Z") };
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "token-1",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );
    const client = createGoogleAuthClient(
      JSON.stringify({ client_email: "svc@example.iam.gserviceaccount.com", private_key: privateKeyPem }),
      clock,
      fetcher,
    );

    const first = await client.getAccessToken();
    const second = await client.getAccessToken();

    expect(first).toBe("token-1");
    expect(second).toBe("token-1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refreshes the token once it expires", async () => {
    let currentTime = new Date("2026-09-01T05:00:00.000Z");
    const clock = { now: () => currentTime };
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token-1", expires_in: 60 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token-2", expires_in: 3600 }), { status: 200 }));
    const client = createGoogleAuthClient(
      JSON.stringify({ client_email: "svc@example.iam.gserviceaccount.com", private_key: privateKeyPem }),
      clock,
      fetcher,
    );

    const first = await client.getAccessToken();
    currentTime = new Date("2026-09-01T05:02:00.000Z");
    const second = await client.getAccessToken();

    expect(first).toBe("token-1");
    expect(second).toBe("token-2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [429, true],
    [400, false],
  ])(
    "classifies token endpoint status %i with retryable=%s",
    async (status, retryable) => {
      const clock = { now: () => new Date("2026-09-01T05:00:00.000Z") };
      const fetcher = vi.fn<Fetcher>().mockResolvedValue(new Response(null, { status }));
      const client = createGoogleAuthClient(
        JSON.stringify({ client_email: "svc@example.iam.gserviceaccount.com", private_key: privateKeyPem }),
        clock,
        fetcher,
      );

      await expect(client.getAccessToken()).rejects.toMatchObject({
        code: "google_token_exchange_failed",
        retryable,
      });
    },
  );
});
