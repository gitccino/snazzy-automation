import { describe, expect, it } from "vitest";
import { newCorrelationId, sha256Hex } from "../../src/shared/ids";

describe("newCorrelationId", () => {
  it("returns a unique, url-safe id each call", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-zA-Z0-9-]{16,}$/);
  });
});

describe("sha256Hex", () => {
  it("hashes known bytes to the known SHA-256 hex digest", async () => {
    const bytes = new TextEncoder().encode("snazzy");
    const digest = await sha256Hex(bytes);
    expect(digest).toBe(
      "a4953bae2278bddc7c8cd84c47a8d65694bc0e0deb142ae09fee37eefd2c1889",
    );
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces identical digests for identical bytes across calls", async () => {
    const bytes = new TextEncoder().encode("same-input");
    const first = await sha256Hex(bytes);
    const second = await sha256Hex(bytes);
    expect(first).toBe(second);
  });
});
