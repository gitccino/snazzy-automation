import { describe, expect, it } from "vitest";
import { discoverHost } from "../../src/icloud/token";
import { createScriptedFetcher } from "../helpers/fakes";

describe("discoverHost", () => {
  it("uses the default host when the first response succeeds directly", async () => {
    const { fetcher, calls } = createScriptedFetcher([{ status: 200, body: "{}" }]);
    const result = await discoverHost("TOKEN-ABC", fetcher);
    expect(result.host).toBe("p01-sharedstreams.icloud.com");
    expect(result.attempts).toBe(1);
    expect(calls[0]!.input).toContain("p01-sharedstreams.icloud.com");
  });

  it("retries once against the host named by X-Apple-MMe-Host when redirected", async () => {
    const { fetcher, calls } = createScriptedFetcher([
      { status: 330, headers: { "x-apple-mme-host": "p07-sharedstreams.icloud.com" } },
      { status: 200, body: "{}" },
    ]);
    const result = await discoverHost("TOKEN-ABC", fetcher);
    expect(result.host).toBe("p07-sharedstreams.icloud.com");
    expect(result.attempts).toBe(2);
    expect(calls[1]!.input).toContain("p07-sharedstreams.icloud.com");
  });

  it("throws a non-retryable OperationalError when redirected without a target host", async () => {
    const { fetcher } = createScriptedFetcher([{ status: 330, headers: {} }]);
    await expect(discoverHost("TOKEN-ABC", fetcher)).rejects.toMatchObject({
      code: "ICLOUD_HOST_DISCOVERY_FAILED",
      retryable: false,
    });
  });

  it("never includes the raw token in a thrown error message", async () => {
    const { fetcher } = createScriptedFetcher([{ status: 500 }]);
    try {
      await discoverHost("SUPER-SECRET-TOKEN", fetcher);
      throw new Error("expected discoverHost to throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("SUPER-SECRET-TOKEN");
    }
  });
});
