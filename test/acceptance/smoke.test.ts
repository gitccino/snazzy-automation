import { describe, expect, it, vi } from "vitest";
import { runSmokeChecks, signLineBodyForSmoke } from "../../scripts/smoke-test";

const names = [
  "d1_migrations", "r2_access", "asset_delivery", "images_binding",
  "airtable_schema", "sequence_consistency", "line_webhook_config",
  "google_template_access", "claude_credential", "icloud_phase_zero", "cron_timezone",
];
const checks = names.map((name) => ({ name, ok: true, detail: "ready" }));
const base = "https://worker.example";

function fakeFetch(setup = { ok: true, checks }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/health") return Response.json({ ok: true });
    if (path === "/setup" && !new Headers(init?.headers).has("authorization"))
      return Response.json({ error: "unauthorized" }, { status: 401 });
    if (path === "/setup") {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin");
      return Response.json(setup, { status: setup.ok ? 200 : 503 });
    }
    if (path === "/usage") {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin");
      return Response.json({ yearMonth: "2026-09", estimatedUsd: 0, estimatedThb: 0, overBudget: false, breakdown: {} });
    }
    if (path === "/line/webhook") {
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ events: [] }));
      expect(new Headers(init?.headers).get("x-line-signature"))
        .toBe(await signLineBodyForSmoke("line-secret", String(init?.body)));
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected route ${path}`);
  });
}

describe("runSmokeChecks", () => {
  it("checks health, auth rejection, all setup checks, usage, and signed empty LINE event", async () => {
    const fetcher = fakeFetch();
    const result = await runSmokeChecks(base, "admin", "line-secret", fetcher as typeof fetch);
    expect(result.passed).toBe(true);
    expect(result.steps.map((step) => step.name)).toEqual(["health", "setup_auth", "setup", "usage", "line_signature"]);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it.each([
    ["missing", { ok: true, checks: checks.slice(1) }, "d1_migrations"],
    ["failed", { ok: true, checks: checks.map((check) => check.name === "claude_credential" ? { ...check, ok: false, detail: "missing" } : check) }, "claude_credential"],
  ])("stops on %s setup check even with ok true", async (_case, setup, failedName) => {
    const fetcher = fakeFetch(setup);
    const result = await runSmokeChecks(base, "admin", "line-secret", fetcher as typeof fetch);
    expect(result.passed).toBe(false);
    expect(result.steps.at(-1)?.name).toBe("setup");
    expect(result.steps.at(-1)?.detail).toContain(failedName);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
