import type { Env, Fetcher } from "../env";
import { hasAirtableSequenceDrift, sequenceState } from "./setup";

// ponytail: 30-second single-flight cache per isolate; use shared storage if global probe limiting is needed.
let driftCache: { key: string; expiresAt: number; result: Promise<boolean | null> } | undefined;

export async function handleHealth(env: Env, fetcher: Fetcher = fetch.bind(globalThis)): Promise<Response> {
  const running = await env.DB.prepare("SELECT COUNT(*) AS count FROM import_runs WHERE status = 'running'").first<{ count: number }>();
  const importRunning = (running?.count ?? 0) > 0;
  const sequence = await sequenceState(env);
  if (!sequence?.bootstrapped) return Response.json({ ok: false, importRunning, code: "sequence_not_bootstrapped" }, { status: 503 });
  const key = JSON.stringify([env.APP_CONFIG_JSON, env.AIRTABLE_TOKEN, sequence.nextValue]);
  if (!driftCache || driftCache.key !== key || driftCache.expiresAt <= Date.now()) {
    driftCache = {
      key, expiresAt: Date.now() + 30_000,
      result: hasAirtableSequenceDrift(env, fetcher, sequence.nextValue).catch(() => null),
    };
  }
  const drift = await driftCache.result;
  if (drift === null) {
    return Response.json({ ok: false, importRunning, code: "airtable_unavailable" }, { status: 503 });
  }
  if (drift) return Response.json({ ok: false, importRunning, code: "sequence_drift" }, { status: 503 });
  return Response.json({ ok: true, importRunning });
}
