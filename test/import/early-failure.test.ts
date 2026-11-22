import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { ImportWorkflow } from '../../src/import/workflow';
import { lineCommandWorkflowId } from '../../src/line/mutation-recovery';

it('queues a setup failure only for the trusted LINE owner, including replay', async () => {
  const env = testEnv(), eventId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const runId = await lineCommandWorkflowId(eventId);
  await env.DB.prepare('INSERT INTO line_command_ingress VALUES (?,?,?,?,?)').bind(eventId,groupId,JSON.stringify({type:'upload'}),runId,'now').run();
  await env.DB.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json) VALUES (?,?,'line','running','now',?)").bind(runId,runId,JSON.stringify({replyGroupId:groupId})).run();
  const error = new Error('private setup detail');
  const step = {do: async (name: string, ...args: any[]) => { if (name === 'settings-context') throw error; return args.at(-1)(); }};
  const run = (overrides: Record<string, unknown> = {}) => ImportWorkflow.prototype.run.call({env} as any, {payload:{importRunId:runId,sourceAlbumId:runId,trigger:'line',trustedEventId:eventId,replyGroupId:groupId,...overrides},instanceId:`import-${runId}`} as any, step as any);
  await expect(run()).rejects.toBe(error);
  await expect(run()).rejects.toBe(error);
  const rows = await env.DB.prepare('SELECT group_id,result_json FROM line_result_outbox WHERE group_id=?').bind(groupId).all<{group_id:string;result_json:string}>();
  expect(rows.results).toHaveLength(1);
  expect(rows.results[0]!.result_json).not.toContain(error.message);
  await env.DB.prepare('DELETE FROM line_result_outbox WHERE group_id=?').bind(groupId).run();
  await env.DB.prepare('DELETE FROM workflow_feedback_results WHERE run_id=?').bind(runId).run();
  await env.DB.prepare('DELETE FROM workflow_feedback WHERE run_id=?').bind(runId).run();
  for (const override of [{trustedEventId:'foreign'}, {replyGroupId:'foreign'}, {trigger:'cron'}, {importRunId:'stale'}]) await expect(run(override)).rejects.toBe(error);
  expect((await env.DB.prepare('SELECT * FROM line_result_outbox WHERE group_id=?').bind(groupId).all()).results).toHaveLength(0);
  expect((await env.DB.prepare('SELECT * FROM workflow_feedback_results WHERE run_id=?').bind(runId).all()).results).toHaveLength(0);
});

it('repairs a setup notice after outbox insertion fails through a later LINE event', async () => {
  const { LineCommandWorkflow } = await import('../../src/line/command-workflow');
  const { createTestEnv } = await import('../helpers/env');
  const { vi } = await import('vitest');
  const group = 'CtestGroup', eventId = crypto.randomUUID(), runId = await lineCommandWorkflowId(eventId);
  const env = { ...testEnv(), ...createTestEnv() } as any;
  await env.DB.prepare('INSERT INTO line_command_ingress VALUES (?,?,?,?,?)').bind(eventId,group,JSON.stringify({type:'upload'}),runId,'now').run();
  await env.DB.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json) VALUES (?,?,'line','running','now',?)").bind(runId,runId,JSON.stringify({replyGroupId:group})).run();
  await env.DB.exec("CREATE TRIGGER fail_early_import_outbox BEFORE INSERT ON line_result_outbox BEGIN SELECT RAISE(FAIL, 'injected'); END");
  const step = {do: async (name: string, ...args: any[]) => { if (name === 'settings-context') throw new Error('private setup detail'); return args.at(-1)(); }};
  try {
    await expect(ImportWorkflow.prototype.run.call({env} as any,{payload:{importRunId:runId,sourceAlbumId:runId,trigger:'line',trustedEventId:eventId,replyGroupId:group},instanceId:`import-${runId}`} as any,step as any)).rejects.toThrow('private setup detail');
  } finally { await env.DB.exec('DROP TRIGGER fail_early_import_outbox'); }
  const intent = await env.DB.prepare('SELECT outcome_json FROM workflow_feedback_results WHERE run_id=?').bind(runId).first() as {outcome_json:string} | null;
  expect(intent).toBeTruthy();
  expect(intent!.outcome_json).not.toContain('private setup detail');
  const sent: any[] = [];
  const fetcher = vi.spyOn(globalThis,'fetch').mockImplementation(async (_url,init) => { sent.push(JSON.parse(String(init?.body))); return Response.json({}); });
  const lineStep = {do: async (_name:string, ...args:any[]) => args.at(-1)()};
  const later = crypto.randomUUID();
  try {
    const invoke = () => LineCommandWorkflow.prototype.run.call({env} as any,{instanceId:later,payload:{receivedAt:new Date().toISOString(),event:{type:'message',webhookEventId:later,replyToken:'token',source:{type:'group',groupId:group,userId:'U1'},message:{type:'text',id:'m',text:'hello'}}}} as any,lineStep as any);
    const foreign = crypto.randomUUID();
    expect(await LineCommandWorkflow.prototype.run.call({env} as any,{instanceId:foreign,payload:{receivedAt:new Date().toISOString(),event:{type:'message',webhookEventId:foreign,replyToken:'token',source:{type:'group',groupId:'foreign',userId:'U1'},message:{type:'text',id:'m',text:'hello'}}}} as any,lineStep as any)).toEqual({status:'ignored'});
    expect(sent).toHaveLength(0);
    expect(await invoke()).toEqual({status:'accepted'});
    await invoke();
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).toContain(runId);
    expect((await env.DB.prepare('SELECT * FROM line_result_outbox WHERE group_id=? AND result_key=?').bind(group,JSON.stringify(['import',runId,1,1,'terminal'])).all()).results).toHaveLength(1);
  } finally { fetcher.mockRestore(); }
});
