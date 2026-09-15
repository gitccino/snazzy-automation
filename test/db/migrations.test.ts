import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";

describe("0001_initial migration", () => {
  it("creates every import-scope table", async () => {
    const env = testEnv();
    const rows = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
    ).all<{ name: string }>();
    const names = rows.results.map((r) => r.name);
    for (const table of ["sequences", "import_runs", "import_checkpoints", "photo_assets", "product_groups", "audit_events"]) {
      expect(names).toContain(table);
    }
  });

  it("allows one photo_assets row per (source_album_id, apple_photo_id)", async () => {
    const env = testEnv();
    const runId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO import_runs (id, source_album_id, trigger, status, started_at) VALUES (?, 'album-1', 'cron', 'running', '2026-09-01T00:00:00.000Z')`
    ).bind(runId).run();
    await env.DB.prepare(
      `INSERT INTO photo_assets (id, source_album_id, apple_photo_id, content_hash, r2_key, position, is_marker, import_run_id, created_at)
       VALUES (?, 'album-1', 'apple-1', 'hash-1', 'assets/hash-1.jpg', 1, 0, ?, '2026-09-01T00:00:00.000Z')`
    ).bind(crypto.randomUUID(), runId).run();
    await expect(
      env.DB.prepare(
        `INSERT INTO photo_assets (id, source_album_id, apple_photo_id, content_hash, r2_key, position, is_marker, import_run_id, created_at)
         VALUES (?, 'album-1', 'apple-1', 'hash-2', 'assets/hash-2.jpg', 2, 0, ?, '2026-09-01T00:00:00.000Z')`
      ).bind(crypto.randomUUID(), runId).run()
    ).rejects.toThrow();
  });
});
