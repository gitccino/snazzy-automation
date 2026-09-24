import { describe, expect, it, vi } from "vitest";
import { createLogger, redact, redactText } from "../../src/shared/logger";

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

describe("redactText", () => {
  it.each([
    "https://cvws.icloud-content.com/B/private-photo?o=download&s=secret-signature&k=secret-key",
    "https://www.icloud.com/sharedalbum/#secret-album",
    "https://icloud.com/sharedalbum/#secret-album",
  ])("redacts complete iCloud capability URLs in errors and logs: %s", (url) => {
    expect(redactText(`fetch ${url} failed`)).toBe("fetch [REDACTED] failed");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      createLogger({ endpoint: url }).error(`failed ${url}`, { detail: url });
      expect(JSON.parse(String(spy.mock.calls[0]![0]))).toMatchObject({
        endpoint: "[REDACTED]", message: "failed [REDACTED]", detail: "[REDACTED]",
      });
    } finally { spy.mockRestore(); }
  });
  it.each([
    [
      "iCloud URL",
      "fetch https://p123-sharedstreams.icloud.com/A1b2C3d4Token/00/asset.jpg",
      "A1b2C3d4Token",
    ],
    [
      "signed asset URL",
      "https://worker.example/assets/x.jpg?X-Amz-Signature=abcdef123456&X-Amz-Expires=600",
      "abcdef123456",
    ],
    [
      "HMAC signed URL",
      "https://worker.example/assets/x.jpg?sig=hmacSignature123456",
      "hmacSignature123456",
    ],
    [
      "LINE bearer token",
      "Authorization: Bearer LINE_CHANNEL_ACCESS_TOKEN_VALUE_XYZ",
      "LINE_CHANNEL_ACCESS_TOKEN_VALUE_XYZ",
    ],
    [
      "LINE raw placeholder",
      "LINE_CHANNEL_ACCESS_TOKEN_VALUE_XYZ",
      "LINE_CHANNEL_ACCESS_TOKEN_VALUE_XYZ",
    ],
    [
      "Airtable token",
      "Authorization: Bearer patABCDEF1234567890.somehash",
      "patABCDEF1234567890",
    ],
  ])("redacts %s embedded in text", (_name, input, secret) => {
    const line = redactText(input);

    expect(line).not.toContain(secret);
    expect(line).toContain("[REDACTED]");
  });

  it("sanitizes message and ordinary string fields before writing JSON", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger({ correlationId: "corr-redact" });

    logger.info("using LINE_CHANNEL_ACCESS_TOKEN_VALUE_XYZ", {
      url: "https://worker.example/assets/x.jpg?X-Amz-Signature=abcdef123456",
      signed: "https://worker.example/assets/x.jpg?sig=hmacSignature123456",
    });

    const line = String(spy.mock.calls[0]![0]);
    expect(line).not.toContain("LINE_CHANNEL_ACCESS_TOKEN_VALUE_XYZ");
    expect(line).not.toContain("abcdef123456");
    expect(line).not.toContain("hmacSignature123456");
    expect(line).toContain("[REDACTED]");
    spy.mockRestore();
  });
});
