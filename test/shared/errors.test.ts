import { describe, expect, it } from "vitest";
import { isRetryable, OperationalError } from "../../src/shared/errors";

describe("OperationalError", () => {
  it("carries a code, message, and retryable flag", () => {
    const err = new OperationalError("ICLOUD_TIMEOUT", "request timed out", true);
    expect(err.code).toBe("ICLOUD_TIMEOUT");
    expect(err.message).toBe("request timed out");
    expect(err.retryable).toBe(true);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("isRetryable", () => {
  it("returns true for a retryable OperationalError", () => {
    expect(isRetryable(new OperationalError("ICLOUD_5XX", "server error", true))).toBe(true);
  });

  it("returns false for a non-retryable OperationalError", () => {
    expect(isRetryable(new OperationalError("ICLOUD_TOKEN_INVALID", "bad token", false))).toBe(false);
  });

  it("returns false for a plain unrelated error", () => {
    expect(isRetryable(new Error("boom"))).toBe(false);
  });
});
