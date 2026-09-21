import type { Env } from "./env";
import { parseConfig } from "./config";
import { getMonthlyUsage, getUsageTotal } from "./db/usage-repository";
import { createLineClient, type LineClient } from "./line/client";
import { buildCostReport, type CostReport } from "./monitoring/usage-report";
import { handleUploadTrigger } from "./routes/upload";
import { handleDocsTrigger } from "./publication/trigger";
import { todayBangkokDate, type Clock } from "./shared/time";

type BudgetAlarmEnv = Env & { __lineClientOverride?: LineClient };

export async function runBudgetAlarmCheck(
  env: BudgetAlarmEnv,
  clock: Clock = { now: () => new Date() },
): Promise<{ sent: boolean; report: CostReport }> {
  const config = parseConfig(env.APP_CONFIG_JSON);
  const yearMonth = todayBangkokDate(clock).slice(0, 7);
  const report = buildCostReport({
    ...await getMonthlyUsage(env.DB, yearMonth),
    r2_stored_bytes: await getUsageTotal(env.DB, "r2_bytes_added"),
  }, config, yearMonth);

  if (!report.overBudget) return { sent: false, report };

  const line = env.__lineClientOverride ?? createLineClient({
    channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
    fetch: fetch.bind(globalThis),
  });
  await line.pushMessage(
    config.lineAllowedGroupId,
    `แจ้งเตือนค่าใช้จ่ายเดือน ${report.yearMonth} เกินงบประมาณ\nประมาณ ${report.estimatedThb.toFixed(0)} บาท (งบ ${config.monthlyBudgetThb.toFixed(0)} บาท)`,
  );
  return { sent: true, report };
}

export async function handleScheduled(
  env: Env,
  cron: string,
  clock: Clock = { now: () => new Date() },
): Promise<void> {
  let failureCode = "scheduled_import_failed";
  try {
    const config = parseConfig(env.APP_CONFIG_JSON);
    if (cron === "45 22 * * *") {
      failureCode = "scheduled_budget_alarm_failed";
      await runBudgetAlarmCheck(env, clock);
      return;
    }
    if (cron === config.importCron) {
      const response = await handleUploadTrigger(env, "cron");
      if (response.status !== 202 && response.status !== 409) {
        throw new Error("scheduled_import_failed");
      }
      return;
    }
    if (cron === config.publicationCron) {
      failureCode = "scheduled_publication_failed";
      await handleDocsTrigger(env, "cron", clock);
    }
  } catch {
    // A rejected waitUntil exposes the failure without logging config or upstream bodies.
    throw new Error(failureCode);
  }
}
