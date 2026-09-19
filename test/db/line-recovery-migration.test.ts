import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { testEnv } from "../helpers/env";

type Migration = { name: string; queries: string[] };
const migrations = (env as unknown as { TEST_MIGRATIONS: Migration[] }).TEST_MIGRATIONS;
let fixture = 0;
async function legacyDatabase() {
  const db = testEnv().DB;
  const prefix = `migration_fixture_${fixture++}_`;
  const rename = (sql: string) => sql.replace(/\b(pending_line_commands|line_actions|line_events|line_event_replies|idx_\w+)\b/g, name => prefix + name);
  const original = migrations.find(migration => migration.name === "0003_line_inventory.sql")!;
  await db.batch(original.queries.map(query => db.prepare(rename(query))));
  const insert = async (token: string, product: string, status: "pending" | "applying") => {
    await db.prepare(`INSERT INTO ${prefix}pending_line_commands
      (token, source_event_id, apply_event_id, kind, status, requester_user_id, group_id, product_id, sold_price, before_json, after_json, expires_at, created_at)
      VALUES (?, ?, ?, 'soldout', ?, 'U1', 'C1', ?, 100, '{}', '{}', '2026-09-01T10:10:00Z', '2026-09-01T10:00:00Z')`)
      .bind(token, token, status === "applying" ? `apply-${token}` : null, status, product).run();
  };
  const migrate = () => db.batch(migrations.find(migration => migration.name === "0004_line_recovery.sql")!.queries.map(query => db.prepare(rename(query))));
  const rows = async () => (await db.prepare(`SELECT token, status, apply_event_id FROM ${prefix}pending_line_commands ORDER BY rowid`).all()).results;
  return { insert, migrate, rows };
}

it("upgrades duplicate legacy pending commands while preserving every applying owner", async () => {
  const legacy = await legacyDatabase();
  await legacy.insert("first", "A-1", "pending");
  await legacy.insert("duplicate", "A-1", "pending");
  await legacy.insert("owner", "A-2", "applying");
  await legacy.insert("blocked", "A-2", "pending");
  await legacy.migrate();
  expect(await legacy.rows()).toEqual([
    { token: "first", status: "pending", apply_event_id: null },
    { token: "duplicate", status: "expired", apply_event_id: null },
    { token: "owner", status: "applying", apply_event_id: "apply-owner" },
    { token: "blocked", status: "expired", apply_event_id: null },
  ]);
  await expect(legacy.insert("competitor", "A-2", "pending")).rejects.toThrow("UNIQUE constraint");
});

it("fails migration atomically rather than release conflicting legacy applying owners", async () => {
  const legacy = await legacyDatabase();
  await legacy.insert("owner-one", "A-1", "applying");
  await legacy.insert("owner-two", "A-1", "applying");
  await legacy.insert("pending", "A-1", "pending");
  await expect(legacy.migrate()).rejects.toThrow("UNIQUE constraint");
  expect(await legacy.rows()).toEqual([
    { token: "owner-one", status: "applying", apply_event_id: "apply-owner-one" },
    { token: "owner-two", status: "applying", apply_event_id: "apply-owner-two" },
    { token: "pending", status: "pending", apply_event_id: null },
  ]);
});
