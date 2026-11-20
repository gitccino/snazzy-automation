import { expect, it, vi } from 'vitest';
import { ImportWorkflow } from '../../src/import/workflow';
import { createLineReplyRepository } from '../../src/db/line-reply-repository';
import { createLineClient } from '../../src/line/client';
import { deliverEventReply } from '../../src/line/reply-delivery';
import { createTestEnv, testEnv } from '../helpers/env';
import { loadSettingsSnapshot } from '../../src/settings/runtime';

it('replays an ambiguous finalization and delivers the committed result once', async () => {
  const env = { ...testEnv(), ...createTestEnv() }, db = env.DB;
  const runId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const context = { settings: await loadSettingsSnapshot(env), replyGroupId: groupId };
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json) VALUES (?,?,'line','running','now',?)").bind(runId,runId,JSON.stringify(context)).run();
  const groupIdRow = crypto.randomUUID();
  await db.prepare("INSERT INTO product_groups(id,import_run_id,ordinal,group_hash,state,product_id,airtable_record_id,first_photo_id,last_photo_id,created_at,updated_at) VALUES (?,?,1,?,'succeeded','A-501','rec1','p1','p2','now','now')").bind(groupIdRow,runId,groupIdRow).run();
  const sequenceBefore = await db.prepare('SELECT * FROM sequences ORDER BY name').all();
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const cache = new Map<string, unknown>([['settings-context', context], ['download-and-group', { pendingGroups: [{groupRowId:groupIdRow}], orphanRange: null, checkpointPosition: 7 }], [`process-group-${groupIdRow}`, {outcome:'succeeded',productId:'A-501'}]]);
  let crash = true;
  const step = { do: async (name: string, ...args: any[]) => {
    if (cache.has(name)) return cache.get(name);
    const value = await args.at(-1)();
    if (name === 'finalize-checkpoint' && crash) { crash = false; throw new Error('lost response'); }
    cache.set(name, value); return value;
  }};
  const run = () => ImportWorkflow.prototype.run.call({env} as any, {payload:{importRunId:runId,sourceAlbumId:runId,trigger:'line'}} as any, step as any);
  await expect(run()).rejects.toThrow('lost response');
  await run();
  const rows = await db.prepare('SELECT result_json FROM line_result_outbox WHERE group_id=?').bind(groupId).all<{result_json:string}>();
  expect(rows.results).toHaveLength(1);
  expect(JSON.parse(rows.results[0]!.result_json).outcome).toBe('success');
  const clock = { now: () => new Date() }, repo = createLineReplyRepository(db,clock), requests: any[] = [];
  const line = createLineClient({channelAccessToken:'x',fetch:async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return Response.json({}); }});
  const input = {eventId:crypto.randomUUID(),groupId,workflowId:'wf',receivedAt:clock.now().toISOString(),replyToken:'fresh',commandReply:null,drainQueue:true,publicBaseUrl:'https://example.workers.dev'};
  const deps = {repo,line,clock,isGroupAllowed:async()=>true};
  await deliverEventReply(input,deps);
  await deliverEventReply({...input,eventId:crypto.randomUUID()},deps);
  expect(requests).toHaveLength(1);
  expect(requests[0].messages).toHaveLength(1);
  expect((await db.prepare('SELECT * FROM product_groups WHERE import_run_id=?').bind(runId).all()).results).toHaveLength(1);
  expect(await db.prepare('SELECT * FROM sequences ORDER BY name').all()).toEqual(sequenceBefore);
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});
