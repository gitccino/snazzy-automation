import type { Env } from "./env";
import { handleGetAsset } from "./routes/assets";
import { handleUploadTrigger } from "./routes/upload";
import { verifyAdminBearer } from "./shared/admin-auth";

export async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
    return handleGetAsset(request, env, { now: () => new Date() });
  }
  if (request.method === "POST" && url.pathname === "/upload") {
    if (!(await verifyAdminBearer(request, env.ADMIN_ROUTE_TOKEN))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return handleUploadTrigger(env, "admin");
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}
