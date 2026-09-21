import type { Env } from "./env";
import { handleGetAsset } from "./routes/assets";
import { handleDocsRoute } from "./routes/docs";
import { handleLineRoute } from "./routes/line";
import { handleHealth } from "./routes/health";
import { handleBootstrapSequence, handleSetup } from "./routes/setup";
import { handleUploadTrigger } from "./routes/upload";
import { handleUsage } from "./routes/usage";
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
  if (request.method === "POST" && url.pathname === "/docs") {
    return handleDocsRoute(request, env);
  }
  if (request.method === "POST" && url.pathname === "/line/webhook") {
    return handleLineRoute(request, env);
  }
  if (request.method === "GET" && url.pathname === "/health") {
    return handleHealth(env);
  }
  if (request.method === "GET" && url.pathname === "/usage") {
    return handleUsage(request, env);
  }
  if (request.method === "GET" && url.pathname === "/setup") {
    return handleSetup(request, env);
  }
  if (request.method === "POST" && url.pathname === "/setup/bootstrap-sequence") {
    return handleBootstrapSequence(request, env);
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}
