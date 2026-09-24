import { describe, expect, it, vi } from "vitest";
import { createGoogleAuthClient } from "../../src/publication/google-auth";
import { OperationalError } from "../../src/shared/errors";
import type { Fetcher } from "../../src/shared/http";

const credentials = {
  clientId: "oauth-client-id",
  clientSecret: "oauth-client-secret",
  refreshToken: "refresh-token",
};
const clock = { now: () => new Date("2026-09-24T05:00:00.000Z") };

describe("createGoogleAuthClient", () => {
  it("exchanges a refresh token for an access token", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), { status: 200 }),
    );
    const client = createGoogleAuthClient(credentials, clock, fetcher);

    await expect(client.getAccessToken()).resolves.toBe("access-token");
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://oauth2.googleapis.com/token");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const body = new URLSearchParams(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("oauth-client-id");
    expect(body.get("client_secret")).toBe("oauth-client-secret");
    expect(body.get("refresh_token")).toBe("refresh-token");
  });

  it("caches a token until one minute before expiry", async () => {
    let now = new Date("2026-09-24T05:00:00.000Z");
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "first", expires_in: 3600 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "second", expires_in: 3600 })));
    const client = createGoogleAuthClient(credentials, { now: () => now }, fetcher);

    expect(await client.getAccessToken()).toBe("first");
    now = new Date("2026-09-24T05:58:59.000Z");
    expect(await client.getAccessToken()).toBe("first");
    now = new Date("2026-09-24T05:59:00.000Z");
    expect(await client.getAccessToken()).toBe("second");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("sanitizes transport rejection", async () => {
    const secret = "transport-error-with-oauth-client-secret";
    const fetcher = vi.fn<Fetcher>().mockRejectedValue(new TypeError(secret));
    const client = createGoogleAuthClient(credentials, clock, fetcher);

    let error: unknown;
    try {
      await client.getAccessToken();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OperationalError);
    expect(error).toMatchObject({
      code: "google_token_exchange_transport_failed",
      retryable: true,
      message: "Google token exchange transport failed",
    });
    expect((error as Error).message).not.toContain(secret);
  });

  it.each([
    [429, true],
    [503, true],
    [400, false],
  ])("reports HTTP %i errors without response content", async (status, retryable) => {
    const secret = "response-with-oauth-client-secret-and-refresh-token";
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(new Response(secret, { status }));
    const client = createGoogleAuthClient(credentials, clock, fetcher);

    let error: unknown;
    try {
      await client.getAccessToken();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OperationalError);
    expect(error).toMatchObject({
      code: "google_token_exchange_failed",
      retryable,
      message: `Google token exchange failed with status ${status}`,
    });
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain(credentials.clientSecret);
    expect((error as Error).message).not.toContain(credentials.refreshToken);
  });

  it("treats invalid_grant as a non-retryable exchange error", async () => {
    const responseBody = JSON.stringify({ error: "invalid_grant", error_description: credentials.refreshToken });
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(
      new Response(responseBody, { status: 400 }),
    );
    const client = createGoogleAuthClient(credentials, clock, fetcher);

    let error: unknown;
    try {
      await client.getAccessToken();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OperationalError);
    expect(error).toMatchObject({
      code: "google_token_exchange_failed",
      retryable: false,
      message: "Google token exchange failed with status 400",
    });
    expect((error as Error).message).not.toContain(responseBody);
    expect((error as Error).message).not.toContain(credentials.clientSecret);
    expect((error as Error).message).not.toContain(credentials.refreshToken);
  });

  it.each([
    ["malformed JSON", "secret-malformed-response"],
    ["missing access token", JSON.stringify({ expires_in: 3600, secret: credentials.clientSecret })],
  ])("sanitizes %s token response", async (_case, responseBody) => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(new Response(responseBody, { status: 200 }));
    const client = createGoogleAuthClient(credentials, clock, fetcher);

    let error: unknown;
    try {
      await client.getAccessToken();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OperationalError);
    expect(error).toMatchObject({
      code: "google_token_response_invalid",
      retryable: false,
      message: "Google token response is invalid",
    });
    expect((error as Error).message).not.toContain(responseBody);
    expect((error as Error).message).not.toContain(credentials.clientSecret);
    expect((error as Error).message).not.toContain(credentials.refreshToken);
  });
});
