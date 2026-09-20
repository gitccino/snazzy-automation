import { describe, expect, it, vi } from "vitest";
import { handleHealth } from "../../src/routes/health";
import type { Env } from "../../src/env";
import { createTestEnv, testEnv } from "../helpers/env";

function configuredEnv(): Env {
  return { ...testEnv(), ...createTestEnv() } as Env;
}

function airtableProducts(productIds: string[]) {
  return vi.fn().mockResolvedValue(Response.json({ records: productIds.map((productId, index) => ({
    id: `rec-${index}`, fields: { "Product ID": productId },
  })) }));
}

describe("GET /health", () => {
  it("returns only boolean state and a code before Product ID bootstrap", async () => {
    const env = configuredEnv();
    await env.DB.prepare("DELETE FROM sequences WHERE name = 'product_id'").run();
    const response = await handleHealth(env, airtableProducts([]));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, importRunning: false, code: "sequence_not_bootstrapped" });
  });

  it("reports running imports when Airtable has reached D1's next Product ID", async () => {
    const env = configuredEnv();
    await env.DB.prepare("DELETE FROM sequences WHERE name = 'product_id'").run();
    await env.DB.prepare("DELETE FROM import_runs WHERE id = 'health-run'").run();
    await env.DB.prepare("INSERT INTO sequences (name, next_value, bootstrapped_at) VALUES ('product_id', 501, '2026-09-01T00:00:00.000Z')").run();
    await env.DB.prepare("INSERT INTO import_runs (id, source_album_id, trigger, status, started_at) VALUES ('health-run', 'album', 'cron', 'running', '2026-09-01T00:00:00.000Z')").run();
    const response = await handleHealth(env, airtableProducts(["A-501"]));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, importRunning: true, code: "sequence_drift" });
  });

  it("is healthy when D1 remains ahead of Airtable", async () => {
    const env = configuredEnv();
    await env.DB.prepare("DELETE FROM sequences WHERE name = 'product_id'").run();
    await env.DB.prepare("DELETE FROM import_runs WHERE id = 'health-run'").run();
    await env.DB.prepare("INSERT INTO sequences (name, next_value, bootstrapped_at) VALUES ('product_id', 502, '2026-09-01T00:00:00.000Z')").run();
    const response = await handleHealth(env, airtableProducts(["A-501"]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, importRunning: false });
  });
});
