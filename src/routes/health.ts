import type { Env, Fetcher } from "../env";
import { maximumAirtableProductNumber, sequenceState } from "./setup";

export async function handleHealth(env: Env, fetcher: Fetcher = fetch.bind(globalThis)): Promise<Response> {
  const running = await env.DB.prepare("SELECT COUNT(*) AS count FROM import_runs WHERE status = 'running'").first<{ count: number }>();
  const importRunning = (running?.count ?? 0) > 0;
  const sequence = await sequenceState(env);
  if (!sequence?.bootstrapped) return Response.json({ ok: false, importRunning, code: "sequence_not_bootstrapped" }, { status: 503 });
  try {
    if ((await maximumAirtableProductNumber(env, fetcher)) >= sequence.nextValue) {
      return Response.json({ ok: false, importRunning, code: "sequence_drift" }, { status: 503 });
    }
  } catch {
    return Response.json({ ok: false, importRunning, code: "airtable_unavailable" }, { status: 503 });
  }
  return Response.json({ ok: true, importRunning });
}
