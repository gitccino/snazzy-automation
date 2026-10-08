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

it('preserves all legacy operation states and action linkage when adding failed status', async () => {
  const db = testEnv().DB;
  const prefix = `mutation_upgrade_${fixture++}_`;
  const rename = (sql: string) => sql.replace(/\b(pending_line_commands_recovery|pending_line_commands|line_actions|line_events|line_event_replies|line_mutation_attempts|line_product_control|idx_\w+)\b/g, name => prefix + name);
  for (const name of ['0003_line_inventory.sql', '0004_line_recovery.sql']) {
    await db.batch(migrations.find(m => m.name === name)!.queries.map(query => db.prepare(rename(query))));
  }
  for (const [i, status] of ['pending','applying','approved','rejected','expired'].entries()) {
    await db.prepare(`INSERT INTO ${prefix}pending_line_commands
      (token,source_event_id,apply_event_id,kind,status,requester_user_id,group_id,product_id,sold_price,before_json,after_json,expires_at,created_at)
      VALUES (?, ?, ?, 'soldout', ?, 'U1', 'C1', ?, 12000, '{"inventoryStatus":"In"}', '{"inventoryStatus":"Out"}', '2026-10-09T08:00:00Z', '2026-10-09T07:00:00Z')`)
      .bind(`t${i}`, `s${i}`, `a${i}`, status, `A-${i+1}`).run();
  }
  await db.prepare(`INSERT INTO ${prefix}line_actions
    (id,pending_token,group_id,product_id,kind,before_json,after_json,actor,correlation_id,created_at,reverted_by_action_id)
    VALUES ('act','t2','C1','A-3','soldout','{}','{}','Mint','corr','2026-10-09T07:00:00Z','revert-act')`).run();
  const before = (await db.prepare(`SELECT * FROM ${prefix}pending_line_commands ORDER BY rowid`).all()).results;
  await db.batch(migrations.find(m => m.name === '0008_line_mutation_recovery.sql')!.queries.map(query => db.prepare(rename(query))));
  const after = (await db.prepare(`SELECT * FROM ${prefix}pending_line_commands ORDER BY rowid`).all()).results;
  after.forEach((row, i) => expect(row).toMatchObject(before[i]!));
  expect(await db.prepare(`SELECT reverted_by_action_id,commit_seq FROM ${prefix}line_actions WHERE id = 'act'`).first()).toEqual({ reverted_by_action_id: 'revert-act', commit_seq: 1 });
  await db.prepare(`UPDATE ${prefix}pending_line_commands SET status = 'failed' WHERE token = 't1'`).run();
  expect(await db.prepare(`SELECT status FROM ${prefix}pending_line_commands WHERE token = 't1'`).first()).toEqual({status:'failed'});
  await expect(db.prepare(`UPDATE ${prefix}pending_line_commands SET status = 'applying', product_id = 'A-1' WHERE token = 't1'`).run()).rejects.toThrow('UNIQUE constraint');
});
