import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config";
import { buildCostReport } from "../../src/monitoring/usage-report";

describe("buildCostReport", () => {
  it("estimates USD and THB cost from token and retained-byte counters", () => {
    const report = buildCostReport(
      {
        claude_input_tokens: 1_000_000,
        claude_output_tokens: 200_000,
        r2_stored_bytes: 5 * 1024 * 1024 * 1024,
      },
      {
        monthlyBudgetThb: 1000,
        usdToThbRate: 36,
        claudeInputPriceUsdPerMtok: 5,
        claudeOutputPriceUsdPerMtok: 25,
        r2PriceUsdPerGbMonth: 0.015,
      } as AppConfig,
      "2026-09",
    );

    expect(report).toMatchObject({
      yearMonth: "2026-09",
      estimatedUsd: 10.075,
      estimatedThb: 362.7,
      overBudget: false,
      breakdown: { claudeInputUsd: 5, claudeOutputUsd: 5, r2Usd: 0.075 },
    });
  });

  it("flags a report over the configured THB ceiling", () => {
    const report = buildCostReport(
      { claude_input_tokens: 50_000, claude_output_tokens: 20_000, r2_stored_bytes: 200 * 1024 * 1024 },
      {
        monthlyBudgetThb: 10,
        usdToThbRate: 36,
        claudeInputPriceUsdPerMtok: 5,
        claudeOutputPriceUsdPerMtok: 25,
        r2PriceUsdPerGbMonth: 0.015,
      } as AppConfig,
      "2026-09",
    );

    expect(report.overBudget).toBe(true);
  });
});
