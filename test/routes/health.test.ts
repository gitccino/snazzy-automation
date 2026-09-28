import { describe, expect, it, vi } from "vitest";
import { handleHealth } from "../../src/routes/health";
import type { Env } from "../../src/env";
import { createTestEnv, testEnv } from "../helpers/env";

function configuredEnv(): Env {
  return { ...testEnv(), ...createTestEnv({ AIRTABLE_TOKEN: crypto.randomUUID() }) } as Env;
}

function airtableProducts(productIds: string[]) {
  return vi.fn().mockResolvedValue(Response.json({ records: productIds.map((productId, index) => ({
    id: `rec-${index}`, fields: { "Product ID": productId },
  })) }));
}

describe("GET /health", () => {
  it("bounds and shares concurrent/repeated probes, then refreshes after 30 seconds", async () => {
    const env = configuredEnv();
    await env.DB.prepare("DELETE FROM sequences WHERE name = 'product_id'").run();
    await env.DB.prepare("INSERT INTO sequences (name, next_value, bootstrapped_at) VALUES ('product_id', 502, '2026-09-01')").run();
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json({ records: [] }))
      .mockResolvedValueOnce(Response.json({ records: [], offset: "ignored-page" }));
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    try {
      const responses = await Promise.all(Array.from({ length: 8 }, () => handleHealth(env, fetcher)));
      expect(responses.every((response) => response.status === 200)).toBe(true);
      await handleHealth({ ...env }, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await env.DB.prepare("INSERT INTO import_runs (id, source_album_id, trigger, status, started_at) VALUES ('cached-health-run', 'album', 'cron', 'running', '2026-09-01')").run();
      expect(await (await handleHealth(env, fetcher)).json()).toMatchObject({ ok: true, importRunning: true });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const url = new URL(String(fetcher.mock.calls[0]![0]));
      expect(url.searchParams.get("maxRecords")).toBe("1");
      expect(url.searchParams.get("pageSize")).toBe("1");
      expect(url.searchParams.get("filterByFormula")).toBe('IF(REGEX_MATCH({Product ID}&"", "^A-[0-9]+$"), VALUE(MID({Product ID}, 3, LEN({Product ID}))) >= 502, 0)');
      now.mockReturnValue(130_001);
      await handleHealth(env, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
      await env.DB.prepare("DELETE FROM import_runs WHERE id = 'cached-health-run'").run();
    }
  });

  it("caches failures and invalidates the result when the D1 sequence advances", async () => {
    const env = configuredEnv();
    await env.DB.prepare("DELETE FROM sequences WHERE name = 'product_id'").run();
    await env.DB.prepare("INSERT INTO sequences (name, next_value, bootstrapped_at) VALUES ('product_id', 502, '2026-09-01')").run();
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
    expect((await handleHealth(env, fetcher)).status).toBe(503);
    expect(await (await handleHealth(env, fetcher)).json()).toMatchObject({ code: "airtable_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await env.DB.prepare("UPDATE sequences SET next_value = 503 WHERE name = 'product_id'").run();
    await handleHealth(env, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["", "B-999", "A-nope", "A-501", "A-999suffix"])("does not flag invalid or lower ID %s as drift", async (id) => {
    const env = configuredEnv();
    await env.DB.prepare("DELETE FROM sequences WHERE name = 'product_id'").run();
    await env.DB.prepare("INSERT INTO sequences (name, next_value, bootstrapped_at) VALUES ('product_id', 502, '2026-09-01')").run();
    expect((await handleHealth(env, airtableProducts([id]))).status).toBe(200);
  });

  it.each(["A-502", "A-000502", "A-1000"])("flags numeric ID %s at or above the sequence", async (id) => {
    const env = configuredEnv();
    await env.DB.prepare("DELETE FROM sequences WHERE name = 'product_id'").run();
    await env.DB.prepare("INSERT INTO sequences (name, next_value, bootstrapped_at) VALUES ('product_id', 502, '2026-09-01')").run();
    expect(await (await handleHealth(env, airtableProducts([id]))).json()).toMatchObject({ code: "sequence_drift" });
  });
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
