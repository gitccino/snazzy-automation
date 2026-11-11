import type { Env } from "./env";
import type { LineClient } from "./line/client";
import { getMonthlyUsage, getUsageTotal } from "./db/usage-repository";
import { loadSettingsSnapshot } from "./settings/runtime";
import { buildCostReport, type CostReport } from "./monitoring/usage-report";
import { todayBangkokDate, type Clock } from "./shared/time";

export async function runBudgetAlarmCheck(
  env: Env & { __lineClientOverride?: LineClient },
  clock: Clock = { now: () => new Date() },
): Promise<{ sent: boolean; report: CostReport }> {
  const config = (await loadSettingsSnapshot(env)).config;
  const yearMonth = todayBangkokDate(clock).slice(0, 7);
  return {
    sent: false,
    report: buildCostReport(
      {
        ...(await getMonthlyUsage(env.DB, yearMonth)),
        r2_stored_bytes: await getUsageTotal(env.DB, "r2_bytes_added"),
      },
      config,
      yearMonth,
    ),
  };
}
export async function handleScheduled(
  _env: Env,
  _cron: string,
  _clock: Clock = { now: () => new Date() },
): Promise<void> {
  // Cron delivery can continue briefly after trigger removal; manual-only releases ignore it.
}
