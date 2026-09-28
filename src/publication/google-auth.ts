import { z } from "zod";
import { OperationalError } from "../shared/errors";
import type { Fetcher } from "../shared/http";
import type { Clock } from "../shared/time";

export interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

const TOKEN_REFRESH_SKEW_SECONDS = 60;

export function createGoogleAuthClient(
  credentials: GoogleOAuthCredentials,
  clock: Clock,
  fetcher: Fetcher,
): AccessTokenProvider {
  let cachedToken: string | null = null;
  let cachedExpiryMs = 0;

  return {
    async getAccessToken(): Promise<string> {
      const nowMs = clock.now().getTime();
      if (cachedToken && nowMs < cachedExpiryMs) return cachedToken;

      let response: Response;
      try {
        response = await fetcher("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            refresh_token: credentials.refreshToken,
          }).toString(),
        });
      } catch {
        throw new OperationalError(
          "google_token_exchange_transport_failed",
          "Google token exchange transport failed",
          true,
        );
      }

      if (!response.ok) {
        throw new OperationalError(
          "google_token_exchange_failed",
          `Google token exchange failed with status ${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      }

      let body: z.infer<typeof TokenResponseSchema>;
      try {
        body = TokenResponseSchema.parse(await response.json());
      } catch {
        throw new OperationalError(
          "google_token_response_invalid",
          "Google token response is invalid",
          false,
        );
      }

      cachedToken = body.access_token;
      cachedExpiryMs = nowMs + (body.expires_in - TOKEN_REFRESH_SKEW_SECONDS) * 1_000;
      return cachedToken;
    },
  };
}
