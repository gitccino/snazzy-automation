import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { PublicationWorkflow } from '../../src/publication/workflow';
import { publicationWorkflowId } from '../../src/publication/types';
import { lineCommandWorkflowId } from '../../src/line/mutation-recovery';

it('uses the current trusted restart binding and holds ambiguous or foreign owners', async () => {
  const env = testEnv(), runId = crypto.randomUUID(), group = crypto.randomUUID(), old = crypto.randomUUID(), current = crypto.randomUUID();
  const workflowId = publicationWorkflowId(runId, 1), operation = JSON.stringify({type:'docs'});
  await env.DB.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,notification_cycle,settings_context_json) VALUES (?,'locked',?,'now','now',2,?)").bind(runId,workflowId,JSON.stringify({replyGroupId:group})).run();
  for (const [id, cycle] of [[old,1],[current,2]] as const) {
    await env.DB.prepare('INSERT INTO line_command_ingress VALUES (?,?,?,?,?)').bind(id,group,operation,await lineCommandWorkflowId(id),'now').run();
    await env.DB.prepare("INSERT INTO publication_regeneration_events(event_id,publication_run_id,generation,notification_cycle,workflow_id,action,job_json,group_id,ingress_operation) VALUES (?,?,1,?,?,'restart','{}',?,?)").bind(id,runId,cycle,workflowId,group,operation).run();
  }
  const error = new Error('private setup detail');
  const step = {do: async (name: string, ...args: any[]) => { if (name === 'settings-context') throw error; return args.at(-1)(); }};
  const run = (payload: Record<string, unknown> = {}, instanceId = workflowId) => PublicationWorkflow.prototype.run.call({env} as any,{instanceId,payload:{publicationRunId:runId,trigger:'line',trustedEventId:old,replyGroupId:'stale',...payload}} as any,step as any);
  await expect(run()).rejects.toBe(error);
  await expect(run()).rejects.toBe(error);
  let rows = (await env.DB.prepare('SELECT * FROM line_result_outbox').all<{group_id:string;result_json:string}>()).results;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.group_id).toBe(group);
  expect(rows[0]!.result_json).not.toContain(error.message);
  await env.DB.exec('DELETE FROM line_result_outbox');
  await expect(run({},'foreign')).rejects.toBe(error);
  await expect(run({trigger:'cron'})).rejects.toBe(error);
  const duplicate = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO publication_regeneration_events(event_id,publication_run_id,generation,notification_cycle,workflow_id,action,job_json,group_id,ingress_operation) VALUES (?,?,1,2,?,'restart','{}',?,?)").bind(duplicate,runId,workflowId,group,operation).run();
  await expect(run()).rejects.toBe(error);
  expect((await env.DB.prepare('SELECT * FROM line_result_outbox').all()).results).toHaveLength(0);
  await env.DB.prepare('DELETE FROM publication_regeneration_events WHERE event_id=?').bind(duplicate).run();
  await env.DB.prepare('UPDATE publication_regeneration_events SET group_id=? WHERE event_id=?').bind('foreign',current).run();
  await expect(run()).rejects.toBe(error);
  rows = (await env.DB.prepare('SELECT * FROM line_result_outbox').all()).results as typeof rows;
  expect(rows).toHaveLength(0);
});
