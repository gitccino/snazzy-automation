import { expect, it } from "vitest";
import { testEnv } from "../helpers/env";
import { acquireOrResumeJob, bindInitialPublicationCreate, readPublicationJob, reopenFailedJobForRestart, reopenSuccessfulJobForRegeneration, setJobState } from "../../src/db/publication-repository";

const db = testEnv().DB;
const clock = { now: () => new Date("2026-11-20T00:00:00Z") };
const evidence = (id: string) => db.prepare("SELECT generation, notification_cycle, state, protocol_version FROM publication_google_write_evidence WHERE publication_run_id = ? ORDER BY generation, notification_cycle").bind(id).all();

it("tracks only guarded new LINE admissions, preserving unknown legacy creates and replays", async () => {
  const id = crypto.randomUUID(), create = crypto.randomUUID(), restart = crypto.randomUUID(), regen = crypto.randomUUID();
  for (const event of [create, restart]) await db.prepare("INSERT INTO line_command_ingress VALUES (?, ?, ?, ?, ?)").bind(event, "group", '{"type":"docs"}', "command", "now").run();
  await acquireOrResumeJob(db, clock, id, "owner");
  await bindInitialPublicationCreate(db, create, "group", undefined, id, 1, 1);
  await bindInitialPublicationCreate(db, create, "group", undefined, id, 1, 1);
  expect((await evidence(id)).results).toEqual([]);
  await setJobState(db, clock, id, "failed");
  const event = { id: restart, groupId: "group", action: "restart" as const };
  expect(await reopenFailedJobForRestart(db, clock, id, "owner", 1, undefined, 1, event)).toBe(true);
  expect(await reopenFailedJobForRestart(db, clock, id, "owner", 1, undefined, 1, event)).toBe(false);
  expect((await evidence(id)).results).toEqual([{ generation: 1, notification_cycle: 2, state: "tracking", protocol_version: 1 }]);
  await setJobState(db, clock, id, "succeeded");
  expect((await reopenSuccessfulJobForRegeneration(db, clock, id, 1, regen))?.bindingCreated).toBe(true);
  expect((await reopenSuccessfulJobForRegeneration(db, clock, id, 1, regen))?.bindingCreated).toBe(false);
  expect((await evidence(id)).results).toEqual([{ generation: 1, notification_cycle: 2, state: "tracking", protocol_version: 1 }, { generation: 2, notification_cycle: 1, state: "tracking", protocol_version: 1 }]);
  // Simulate a binding admitted by the older implementation before replay.
  await db.prepare("UPDATE publication_google_write_evidence SET protocol_version = NULL WHERE publication_run_id = ? AND generation = 2").bind(id).run();
  expect((await reopenSuccessfulJobForRegeneration(db, clock, id, 1, regen))?.bindingCreated).toBe(false);
  expect((await evidence(id)).results[1]).toEqual({ generation: 2, notification_cycle: 1, state: "tracking", protocol_version: null });
});

it("rolls back admission and binding when evidence conflicts", async () => {
  const id = crypto.randomUUID(), event = crypto.randomUUID();
  await acquireOrResumeJob(db, clock, id, "owner");
  await setJobState(db, clock, id, "succeeded");
  await db.prepare("INSERT INTO publication_google_write_evidence (publication_run_id, generation, notification_cycle, state) VALUES (?, 2, 1, 'existing')").bind(id).run();
  await expect(reopenSuccessfulJobForRegeneration(db, clock, id, 1, event)).rejects.toThrow();
  expect(await readPublicationJob(db, id)).toMatchObject({ generation: 1, state: "succeeded" });
  expect(await db.prepare("SELECT event_id FROM publication_regeneration_events WHERE event_id = ?").bind(event).first()).toBeNull();
  expect((await evidence(id)).results).toEqual([{ generation: 2, notification_cycle: 1, state: "existing", protocol_version: null }]);
});

it("fences competing restart admissions to one evidence row", async () => {
  const id = crypto.randomUUID(), events = [crypto.randomUUID(), crypto.randomUUID()];
  for (const event of events) await db.prepare("INSERT INTO line_command_ingress VALUES (?, ?, ?, ?, ?)").bind(event, "group", '{"type":"docs"}', "command", "now").run();
  await acquireOrResumeJob(db, clock, id, "owner");
  await setJobState(db, clock, id, "failed");
  const results = await Promise.all(events.map(event => reopenFailedJobForRestart(db, clock, id, "owner", 1, undefined, 1, { id: event, groupId: "group", action: "restart" })));
  expect(results.filter(Boolean)).toHaveLength(1);
  expect((await evidence(id)).results).toEqual([{ generation: 1, notification_cycle: 2, state: "tracking", protocol_version: 1 }]);
});

import { env } from "cloudflare:test";

it("upgrades existing evidence without assigning a protocol version", async () => {
  const migrations = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;
  const table = `evidence_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
  const rename = (sql: string) => sql.replaceAll("publication_google_write_evidence", table);
  for (const name of ["0020_publication_google_write_evidence.sql"])
    await db.batch(migrations.find(m => m.name === name)!.queries.map(sql => db.prepare(rename(sql))));
  await db.prepare(`INSERT INTO ${table} VALUES ('old', 1, 1, 'tracking')`).run();
  await db.batch(migrations.find(m => m.name === "0021_publication_evidence_protocol.sql")!.queries.map(sql => db.prepare(rename(sql))));
  expect(await db.prepare(`SELECT state, protocol_version FROM ${table} WHERE publication_run_id='old'`).first()).toEqual({ state: "tracking", protocol_version: null });
  await db.prepare(`INSERT INTO ${table} (publication_run_id, generation, notification_cycle, state) VALUES ('later', 1, 1, 'tracking')`).run();
  expect(await db.prepare(`SELECT protocol_version FROM ${table} WHERE publication_run_id='later'`).first()).toEqual({ protocol_version: null });
});
