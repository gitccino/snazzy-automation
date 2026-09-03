import { describe, expect, it } from "vitest";
import { createTestEnv } from "./helpers/env";

describe("project skeleton", () => {
  it("boots the test harness and reads a test env", () => {
    const env = createTestEnv();
    expect(env.ICLOUD_SHARED_ALBUM_TOKEN).toBe("TEST-TOKEN-ABC123");
  });
});
