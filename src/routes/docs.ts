import type { Env } from "../env";
import { handleDocsTrigger } from "../publication/trigger";
import { verifyAdminBearer } from "../shared/admin-auth";
import type { Clock } from "../shared/time";

export async function handleDocsRoute(
  request: Request,
  env: Env,
  clock: Clock = { now: () => new Date() },
): Promise<Response> {
  if (!await verifyAdminBearer(request, env.ADMIN_ROUTE_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await handleDocsTrigger(env, "admin", clock);
    const status = ["started", "restarted", "resumed"].includes(result.status) ? 202 : 200;
    return Response.json(result, { status });
  } catch {
    return Response.json({ status: "publication_trigger_failed" }, { status: 500 });
  }
}
