import { requireAccess, type AccessEnv } from "./access";
import { api, json, type ApiEnv } from "./api";
export interface Env extends AccessEnv, ApiEnv {
  ASSETS: Fetcher;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      await requireAccess(request, env);
    } catch {
      return json({ ok: false, code: "unauthorized" }, 401);
    }
    if (new URL(request.url).pathname.startsWith("/api/"))
      return api(request, env);
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "same-origin");
    response.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return response;
  },
};
