import { describe, expect, it, vi } from "vitest";
import { createLogger, redact } from "../../src/shared/logger";

describe("redact", () => {
  it("masks fields whose key looks secret-shaped", () => {
    const out = redact({
      icloudAlbumToken: "AbCdEf123456",
      signedUrl: "https://r2.example.com/assets/x?sig=abc",
      derivativeUrl: "https://cvws.icloud-content.com/B/foo",
      productId: "A-1234",
    });
    expect(out.icloudAlbumToken).toBe("[REDACTED]");
    expect(out.signedUrl).toBe("[REDACTED]");
    expect(out.derivativeUrl).toBe("[REDACTED]");
    expect(out.productId).toBe("A-1234");
  });

  it("leaves non-secret fields untouched", () => {
    const out = redact({ count: 12, groupId: "grp-1", ok: true });
    expect(out).toEqual({ count: 12, groupId: "grp-1", ok: true });
  });
});

describe("createLogger", () => {
  it("merges base fields, redacts, and writes one JSON line to console", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger({ correlationId: "corr-1" });
    logger.info("probe started", { icloudAlbumToken: "SECRET-TOKEN" });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(line.level).toBe("info");
    expect(line.message).toBe("probe started");
    expect(line.correlationId).toBe("corr-1");
    expect(line.icloudAlbumToken).toBe("[REDACTED]");
    spy.mockRestore();
  });
});
