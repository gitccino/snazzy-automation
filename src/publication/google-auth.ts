import { z } from "zod";
import { OperationalError } from "../shared/errors";
import type { Fetcher } from "../shared/http";
import type { Clock } from "../shared/time";

export interface GoogleServiceAccountJson {
  client_email: string;
  private_key: string;
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

const ServiceAccountSchema = z.object({
  client_email: z.string().email(),
  private_key: z.string().refine(
    (value) => value.includes("-----BEGIN PRIVATE KEY-----"),
    "private_key must be PKCS#8 PEM",
  ),
});

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

export function parseServiceAccountJson(json: string): GoogleServiceAccountJson {
  return ServiceAccountSchema.parse(JSON.parse(json));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(input: string): string {
  return base64UrlEncode(new TextEncoder().encode(input));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    binary.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function signServiceAccountJwt(
  account: GoogleServiceAccountJson,
  clock: Clock,
  scopes: string[],
): Promise<string> {
  const nowSeconds = Math.floor(clock.now().getTime() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: account.client_email,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const signingInput = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(JSON.stringify(claims))}`;
  const key = await importPrivateKey(account.private_key);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
];
const TOKEN_REFRESH_SKEW_SECONDS = 60;

export function createGoogleAuthClient(
  serviceAccountJsonText: string,
  clock: Clock,
  fetcher: Fetcher,
): AccessTokenProvider {
  const account = parseServiceAccountJson(serviceAccountJsonText);
  let cachedToken: string | null = null;
  let cachedExpiryMs = 0;

  return {
    async getAccessToken(): Promise<string> {
      const nowMs = clock.now().getTime();
      if (cachedToken && nowMs < cachedExpiryMs) {
        return cachedToken;
      }

      const jwt = await signServiceAccountJwt(account, clock, GOOGLE_SCOPES);
      const response = await fetcher("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: jwt,
        }).toString(),
      });

      if (!response.ok) {
        throw new OperationalError(
          "google_token_exchange_failed",
          `Google token exchange failed with status ${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      }

      const body = TokenResponseSchema.parse(await response.json());
      cachedToken = body.access_token;
      cachedExpiryMs = nowMs + (body.expires_in - TOKEN_REFRESH_SKEW_SECONDS) * 1_000;
      return cachedToken;
    },
  };
}
