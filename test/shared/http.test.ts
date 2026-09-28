import { describe, expect, it, vi } from "vitest";
import { OperationalError } from "../../src/shared/errors";
import { safeFetch } from "../../src/shared/http";

function fakeFetcher(status: number, body = "{}") {
  return vi.fn(async () => new Response(body, { status }));
}

describe("safeFetch", () => {
  it.each([429, 500, 404, "network"] as const)("redacts iCloud URLs from %s errors without caller patterns", async (failure) => {
    const url = "https://cvws.icloud-content.com/B/private-photo?o=download&s=secret-signature&k=secret-key";
    const fetcher = failure === "network"
      ? vi.fn(async () => { throw new Error(`failed fetching ${url}`); })
      : fakeFetcher(failure);
    await expect(safeFetch(url, undefined, { fetcher })).rejects.toThrow(/\[REDACTED\]/);
    try { await safeFetch(url, undefined, { fetcher }); } catch (error) {
      expect(String(error)).not.toContain("secret-");
      expect(String(error)).not.toContain("private-photo");
    }
  });
  it("returns the response unchanged on 2xx", async () => {
    const fetcher = fakeFetcher(200, '{"ok":true}');
    const res = await safeFetch("https://example.com/a", undefined, { fetcher });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("throws a retryable OperationalError on 5xx", async () => {
    const fetcher = fakeFetcher(503);
    await expect(safeFetch("https://example.com/a", undefined, { fetcher })).rejects.toMatchObject({
      code: "HTTP_5XX",
      retryable: true,
    });
  });

  it("throws a retryable OperationalError on 429", async () => {
    const fetcher = fakeFetcher(429);
    await expect(safeFetch("https://example.com/a", undefined, { fetcher })).rejects.toMatchObject({
      code: "HTTP_429",
      retryable: true,
    });
  });

  it("throws a non-retryable OperationalError on other 4xx", async () => {
    const fetcher = fakeFetcher(404);
    await expect(safeFetch("https://example.com/a", undefined, { fetcher })).rejects.toMatchObject({
      code: "HTTP_4XX",
      retryable: false,
    });
  });

  it("never includes the raw request URL in a thrown error message", async () => {
    const fetcher = fakeFetcher(500);
    try {
      await safeFetch("https://p01-sharedstreams.icloud.com/SECRET-TOKEN/sharedstreams/webstream", undefined, {
        fetcher,
        redactUrlPatterns: [/SECRET-TOKEN/],
      });
      throw new Error("expected safeFetch to throw");
    } catch (err) {
      expect((err as OperationalError).message).not.toContain("SECRET-TOKEN");
    }
  });
});
