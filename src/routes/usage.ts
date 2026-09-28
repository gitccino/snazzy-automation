import { parseConfig } from "../config";
import { getMonthlyUsage, getUsageTotal } from "../db/usage-repository";
import type { Env } from "../env";
import { buildCostReport } from "../monitoring/usage-report";
import { verifyAdminBearer } from "../shared/admin-auth";
import { todayBangkokDate, type Clock } from "../shared/time";

export async function handleUsage(
  request: Request,
  env: Env,
  clock: Clock = { now: () => new Date() },
): Promise<Response> {
  if (!await verifyAdminBearer(request, env.ADMIN_ROUTE_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const yearMonth = todayBangkokDate(clock).slice(0, 7);
  const usage = {
    ...await getMonthlyUsage(env.DB, yearMonth),
    r2_stored_bytes: await getUsageTotal(env.DB, "r2_bytes_added"),
  };
  return Response.json(buildCostReport(usage, parseConfig(env.APP_CONFIG_JSON), yearMonth));
}
