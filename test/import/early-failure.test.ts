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
  for (const override of [{trustedEventId:'foreign'}, {replyGroupId:'foreign'}, {trigger:'cron'}, {importRunId:'stale'}]) await expect(run(override)).rejects.toBe(error);
  expect((await env.DB.prepare('SELECT * FROM line_result_outbox WHERE group_id=?').bind(groupId).all()).results).toHaveLength(0);
});
