import type { AppConfig } from "../config";

export interface CostReport {
  yearMonth: string;
  estimatedUsd: number;
  estimatedThb: number;
  overBudget: boolean;
  breakdown: Record<string, number>;
}

export function buildCostReport(
  usage: Record<string, number>,
  config: AppConfig,
  yearMonth: string,
): CostReport {
  const claudeInputUsd = ((usage.claude_input_tokens ?? 0) / 1_000_000) * config.claudeInputPriceUsdPerMtok;
  const claudeOutputUsd = ((usage.claude_output_tokens ?? 0) / 1_000_000) * config.claudeOutputPriceUsdPerMtok;
  const r2Usd = ((usage.r2_stored_bytes ?? 0) / (1024 * 1024 * 1024)) * config.r2PriceUsdPerGbMonth;
  const estimatedUsd = claudeInputUsd + claudeOutputUsd + r2Usd;
  const estimatedThb = estimatedUsd * config.usdToThbRate;

  return {
    yearMonth,
    estimatedUsd,
    estimatedThb,
    overBudget: estimatedThb > config.monthlyBudgetThb,
    breakdown: { claudeInputUsd, claudeOutputUsd, r2Usd },
  };
}
