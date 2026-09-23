import { z } from "zod";

const expectedSetupChecks = [
  "d1_migrations", "r2_access", "asset_delivery", "images_binding",
  "airtable_schema", "sequence_consistency", "line_webhook_config",
  "google_template_access", "claude_credential", "icloud_phase_zero", "cron_timezone",
];
const setupSchema = z.object({
  ok: z.boolean(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
});
const usageSchema = z.object({
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
  estimatedUsd: z.number().nonnegative(),
  estimatedThb: z.number().nonnegative(),
  overBudget: z.boolean(),
  breakdown: z.record(z.string(), z.number()),
});

export interface SmokeStep { name: string; ok: boolean; detail: string }
export interface SmokeResult { passed: boolean; steps: SmokeStep[] }

export async function signLineBodyForSmoke(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return btoa(String.fromCharCode(...bytes));
}

export async function runSmokeChecks(baseUrl: string, adminToken: string, lineSecret: string, fetchFn: typeof fetch): Promise<SmokeResult> {
  const steps: SmokeStep[] = [];
  const stop = (): SmokeResult => ({ passed: false, steps });
  const auth = { authorization: `Bearer ${adminToken}` };

  const healthResponse = await fetchFn(`${baseUrl}/health`);
  const health = z.object({ ok: z.boolean() }).parse(await healthResponse.json());
  steps.push({ name: "health", ok: healthResponse.ok && health.ok, detail: healthResponse.ok ? "reachable" : `HTTP ${healthResponse.status}` });
  if (!steps.at(-1)!.ok) return stop();

  const unauthorized = await fetchFn(`${baseUrl}/setup`);
  steps.push({ name: "setup_auth", ok: unauthorized.status === 401, detail: `missing bearer returned HTTP ${unauthorized.status}` });
  if (!steps.at(-1)!.ok) return stop();

  const setupResponse = await fetchFn(`${baseUrl}/setup`, { headers: auth });
  const setup = setupSchema.parse(await setupResponse.json());
  const actual = new Map(setup.checks.map((check) => [check.name, check]));
  const failing = expectedSetupChecks.filter((name) => !actual.get(name)?.ok)
    .map((name) => `${name}: ${actual.get(name)?.detail ?? "missing"}`);
  if (actual.size !== expectedSetupChecks.length || setup.checks.length !== expectedSetupChecks.length)
    failing.push("unexpected or duplicate setup checks");
  steps.push({ name: "setup", ok: setupResponse.ok && setup.ok && failing.length === 0,
    detail: failing.length ? failing.join("; ") : setup.ok ? "all eleven checks ok" : `HTTP ${setupResponse.status}` });
  if (!steps.at(-1)!.ok) return stop();

  const usageResponse = await fetchFn(`${baseUrl}/usage`, { headers: auth });
  const usage = usageSchema.parse(await usageResponse.json());
  steps.push({ name: "usage", ok: usageResponse.ok, detail: usageResponse.ok ? `${usage.yearMonth}: ${usage.estimatedThb.toFixed(2)} THB` : `HTTP ${usageResponse.status}` });
  if (!steps.at(-1)!.ok) return stop();

  const body = JSON.stringify({ events: [] });
  const signature = await signLineBodyForSmoke(lineSecret, body);
  const webhookResponse = await fetchFn(`${baseUrl}/line/webhook`, {
    method: "POST", headers: { "content-type": "application/json", "x-line-signature": signature }, body,
  });
  steps.push({ name: "line_signature", ok: webhookResponse.ok, detail: webhookResponse.ok ? "signed empty event accepted" : `HTTP ${webhookResponse.status}` });
  return { passed: steps.every((step) => step.ok), steps };
}

async function main(): Promise<void> {
  const baseUrl = process.env.WORKER_BASE_URL;
  const adminToken = process.env.ADMIN_ROUTE_TOKEN;
  const lineSecret = process.env.LINE_CHANNEL_SECRET;
  if (!baseUrl || !adminToken || !lineSecret) throw new Error("WORKER_BASE_URL, ADMIN_ROUTE_TOKEN, and LINE_CHANNEL_SECRET are required");
  const result = await runSmokeChecks(baseUrl.replace(/\/$/, ""), adminToken, lineSecret, fetch);
  for (const step of result.steps) console.log(`${step.ok ? "PASS" : "FAIL"} ${step.name}: ${step.detail}`);
  console.log(result.passed ? "SMOKE TEST PASSED" : "SMOKE TEST FAILED");
  if (!result.passed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
