import { describe, expect, it } from "vitest";
import { createTestEnv, testEnv } from "./helpers/env";

describe("project skeleton", () => {
  it("boots the test harness and reads a test env", () => {
    const env = createTestEnv();
    expect(env.ICLOUD_SHARED_ALBUM_TOKEN).toBe("TEST-TOKEN-ABC123");
  });

  it("exposes the configured Images binding to the publication Worker", () => {
    expect(testEnv().IMAGES).toBeDefined();
    expect(testEnv().IMAGES).toHaveProperty("input", expect.any(Function));
  });
});
