import { describe, expect, it } from "vitest";
import {
  getMonthlyUsage,
  getUsageTotal,
  recordUsage,
} from "../../src/db/usage-repository";
import { testEnv } from "../helpers/env";

describe("usage-repository", () => {
  it("accumulates same-day same-metric writes instead overwriting", async () => {
    const db = testEnv().DB;
    await recordUsage(db, "claude_input_tokens", 1200, "2026-09-01");
    await recordUsage(db, "claude_input_tokens", 800, "2026-09-01");

    const monthly = await getMonthlyUsage(db, "2026-09");

    expect(monthly.claude_input_tokens).toBe(2000);
  });

  it("keeps metrics different months separate", async () => {
    const db = testEnv().DB;
    await recordUsage(db, "r2_bytes_added", 5_000_000, "2026-08-31");
    await recordUsage(db, "r2_bytes_added", 3_000_000, "2026-09-01");

    const august = await getMonthlyUsage(db, "2026-08");
    const september = await getMonthlyUsage(db, "2026-09");

    expect(august.r2_bytes_added).toBe(5_000_000);
    expect(september.r2_bytes_added).toBe(3_000_000);
    expect(await getUsageTotal(db, "r2_bytes_added")).toBe(8_000_000);
  });
});
