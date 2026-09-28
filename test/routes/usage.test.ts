import { describe, expect, it } from "vitest";
import { recordUsage } from "../../src/db/usage-repository";
import { handleUsage } from "../../src/routes/usage";
import { createTestEnv, testEnv } from "../helpers/env";

describe("GET /usage", () => {
  it.each([undefined, "Bearer wrong-token"])("rejects %s before reading D1 or config", async (authorization) => {
    const env = { ADMIN_ROUTE_TOKEN: "admin-secret" } as ReturnType<typeof testEnv>;
    const response = await handleUsage(
      new Request("https://worker.example/usage", { headers: authorization ? { authorization } : undefined }),
      env,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("returns the monthly report and all-time retained R2 bytes for the exact admin bearer", async () => {
    const env = { ...testEnv(), ...createTestEnv() } as ReturnType<typeof testEnv>;
    await recordUsage(env.DB, "claude_input_tokens", 1_000, "2026-09-01");
    await recordUsage(env.DB, "r2_bytes_added", 2_000, "2026-08-31");

    const response = await handleUsage(
      new Request("https://worker.example/usage", {
        headers: { authorization: `Bearer ${env.ADMIN_ROUTE_TOKEN}` },
      }),
      env,
      { now: () => new Date("2026-09-02T01:00:00.000Z") },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      yearMonth: "2026-09",
      overBudget: false,
      breakdown: { r2Usd: (2_000 / (1024 * 1024 * 1024)) * 0.015 },
    });
  });
});
