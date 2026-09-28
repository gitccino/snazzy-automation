import { describe, expect, it, vi } from "vitest";
import { createICloudClient } from "../../src/icloud/client";
import { createLogger } from "../../src/shared/logger";

describe("iCloud client logging never leaks the token or derivative URLs", () => {
  it("keeps the token out of a logger call made after a client error", async () => {
    const token = "TOP-SECRET-ALBUM-TOKEN";
    const failingFetcher = async () => new Response("boom", { status: 500 });
    const client = createICloudClient(token, failingFetcher);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger({ correlationId: "corr-1" });

    let caught: Error | undefined;
    try {
      await client.getSnapshot();
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    logger.error("icloud snapshot failed", { icloudAlbumToken: token, reason: caught!.message });

    const loggedLine = spy.mock.calls[0]![0] as string;
    expect(loggedLine).not.toContain(token);
    expect(caught!.message).not.toContain(token);
    spy.mockRestore();
  });

  it("redacts derivative signed URLs embedded in logged error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger({ correlationId: "corr-embedded" });
    const albumToken = "A1b2C3d4Token";
    const signature = "abcdef123456";

    logger.error("download failed", {
      reason:
        `https://p1-sharedstreams.icloud.com/${albumToken}/asset.jpg ` +
        `https://worker.example/assets/x.jpg?X-Amz-Signature=${signature}`,
    });

    const line = String(spy.mock.calls[0]![0]);
    expect(line).not.toContain(albumToken);
    expect(line).not.toContain(signature);
    expect(line).toContain("[REDACTED]");
    spy.mockRestore();
  });
});
