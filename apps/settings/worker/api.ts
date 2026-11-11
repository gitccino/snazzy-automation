import { parseSaveSectionRequest } from "../../../src/settings/schema";
import type { SettingsService } from "../../../src/settings/entrypoint";
export interface ApiEnv {
  SETTINGS_SERVICE: Pick<
    SettingsService,
    "get" | "saveSection" | "testConnection" | "exportConfiguration"
  >;
  SETTINGS_ORIGIN: string;
}
const statuses: Record<string, number> = {
  invalid_settings: 400,
  revision_conflict: 409,
  confirmation_required: 409,
  connection_validation_failed: 422,
  settings_unavailable: 503,
  provider_unavailable: 503,
};
export function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export async function api(request: Request, env: ApiEnv): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    if (request.method === "GET" && path === "/api/settings")
      return result(await env.SETTINGS_SERVICE.get());
    if (request.method === "GET" && path === "/api/settings/export") {
      const exported = await env.SETTINGS_SERVICE.exportConfiguration();
      if (!exported.ok) return result(exported);
      const response = json(exported.value);
      response.headers.set(
        "Content-Disposition",
        'attachment; filename="snazzy-settings.json"',
      );
      return response;
    }
    const section =
      /^\/api\/settings\/sections\/(connections|line|import|documents|advanced)$/.exec(
        path,
      );
    const write =
      (request.method === "PATCH" && section) ||
      (request.method === "POST" && path === "/api/settings/test-connection");
    if (!write) return json({ ok: false, code: "not_found" }, 404);
    if (request.headers.get("Origin") !== env.SETTINGS_ORIGIN)
      return json({ ok: false, code: "forbidden" }, 403);
    if (
      request.headers.get("content-type")?.split(";")[0]?.trim() !==
      "application/json"
    )
      return json({ ok: false, code: "invalid_settings" }, 400);
    const reader = request.body?.getReader();
    if (!reader) return json({ ok: false, code: "invalid_settings" }, 400);
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) {
        await reader.cancel();
        return json({ ok: false, code: "invalid_settings" }, 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let input;
    try {
      input = JSON.parse(new TextDecoder().decode(bytes));
      if (section) {
        input = parseSaveSectionRequest(input);
        if (input.section !== section[1]) throw new Error();
      }
    } catch {
      return json({ ok: false, code: "invalid_settings" }, 400);
    }
    return result(
      section
        ? await env.SETTINGS_SERVICE.saveSection(input)
        : await env.SETTINGS_SERVICE.testConnection(input),
    );
  } catch {
    return json({ ok: false, code: "internal_error" }, 500);
  }
}
function result(value: { ok: boolean; code?: string }) {
  return json(value, value.ok ? 200 : (statuses[value.code ?? ""] ?? 500));
}
