import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { createLineRepository } from '../../src/db/line-repository';

it('records proven ingress only on the initial insert and never upgrades legacy replies', async () => {
  const db = testEnv().DB;
  const repo = createLineRepository(db, {next: () => crypto.randomUUID()}, {now: () => new Date()});
  const id = crypto.randomUUID(), legacy = crypto.randomUUID();
  const identity = {groupId:'C1', operation:'{"type":"upload"}', workflowId:'workflow', receivedAt:'2026-11-20T00:00:00Z'};
  const reply = {kind:'text' as const, text:'saved'};
  for (const eventId of [id, legacy]) await db.prepare('INSERT INTO line_command_ingress VALUES (?, ?, ?, ?, ?)').bind(eventId, identity.groupId, identity.operation, identity.workflowId, identity.receivedAt).run();
  await repo.saveEventReply(id, reply, identity);
  await repo.saveEventReply(legacy, reply);
  await repo.saveEventReply(legacy, {kind:'text', text:'replacement'}, identity);
  expect(await db.prepare('SELECT reply_json, provenance FROM line_event_replies WHERE event_id = ?').bind(id).first()).toEqual({reply_json:JSON.stringify(reply), provenance:'prepared'});
  expect(await db.prepare('SELECT reply_json, provenance FROM line_event_replies WHERE event_id = ?').bind(legacy).first()).toEqual({reply_json:JSON.stringify(reply), provenance:null});
  const mismatch = crypto.randomUUID();
  await repo.saveEventReply(mismatch, reply, identity);
  expect(await db.prepare('SELECT provenance FROM line_event_replies WHERE event_id = ?').bind(mismatch).first()).toEqual({provenance:null});
});

it('migrates legacy replies with unknown provenance', async () => {
  const { env } = await import('cloudflare:test');
  const migrations = (env as unknown as {TEST_MIGRATIONS:{name:string;queries:string[]}[]}).TEST_MIGRATIONS;
  const db = testEnv().DB;
  const table = `legacy_reply_${crypto.randomUUID().replaceAll('-', '')}`;
  await db.prepare(`CREATE TABLE ${table} (event_id TEXT PRIMARY KEY, reply_json TEXT NOT NULL)`).run();
  await db.prepare(`INSERT INTO ${table} VALUES ('old', '{}')`).run();
  const migration = migrations.find(m => m.name === '0030_line_reply_provenance.sql')!;
  await db.batch(migration.queries.map(query => db.prepare(query.replaceAll('line_event_replies', table))));
  expect(await db.prepare(`SELECT * FROM ${table}`).first()).toEqual({event_id:'old',reply_json:'{}',provenance:null});
});
