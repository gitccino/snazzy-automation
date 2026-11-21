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
  await expect(run({trigger:'cron'})).rejects.toBe(error);
  await expect(run({trigger:'admin'})).rejects.toBe(error);
  let rows = (await env.DB.prepare('SELECT * FROM line_result_outbox').all<{group_id:string;result_json:string}>()).results;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.group_id).toBe(group);
  expect(rows[0]!.result_json).not.toContain(error.message);
  await env.DB.exec('DELETE FROM line_result_outbox');
  await env.DB.prepare('DELETE FROM workflow_feedback_results WHERE run_id=?').bind(runId).run();
  await env.DB.prepare('DELETE FROM workflow_feedback WHERE run_id=?').bind(runId).run();
  await expect(run({},'foreign')).rejects.toBe(error);
  await env.DB.prepare('DELETE FROM publication_regeneration_events WHERE event_id=?').bind(current).run();
  await expect(run({trigger:'cron'})).rejects.toBe(error);
  await expect(run({trigger:'admin'})).rejects.toBe(error);
  expect((await env.DB.prepare('SELECT * FROM line_result_outbox').all()).results).toHaveLength(0);
  await env.DB.prepare("INSERT INTO publication_regeneration_events(event_id,publication_run_id,generation,notification_cycle,workflow_id,action,job_json,group_id,ingress_operation) VALUES (?,?,1,2,?,'restart','{}',?,?)").bind(current,runId,workflowId,group,operation).run();
  const duplicate = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO publication_regeneration_events(event_id,publication_run_id,generation,notification_cycle,workflow_id,action,job_json,group_id,ingress_operation) VALUES (?,?,1,2,?,'restart','{}',?,?)").bind(duplicate,runId,workflowId,group,operation).run();
  await expect(run()).rejects.toBe(error);
  expect((await env.DB.prepare('SELECT * FROM line_result_outbox').all()).results).toHaveLength(0);
  await env.DB.prepare('DELETE FROM publication_regeneration_events WHERE event_id=?').bind(duplicate).run();
  await env.DB.prepare('UPDATE publication_regeneration_events SET group_id=? WHERE event_id=?').bind('foreign',current).run();
  await expect(run()).rejects.toBe(error);
  rows = (await env.DB.prepare('SELECT * FROM line_result_outbox').all()).results as typeof rows;
  expect(rows).toHaveLength(0);
  expect((await env.DB.prepare('SELECT * FROM workflow_feedback_results WHERE run_id=?').bind(runId).all()).results).toHaveLength(0);
});

it('repairs an interrupted setup notice through a later eligible LINE event', async () => {
  const { LineCommandWorkflow } = await import('../../src/line/command-workflow');
  const { createTestEnv } = await import('../helpers/env');
  const { vi } = await import('vitest');
  const env = {...testEnv(),...createTestEnv()} as any, runId=crypto.randomUUID(), group='CtestGroup', eventId=crypto.randomUUID();
  const workflowId=publicationWorkflowId(runId,1), operation=JSON.stringify({type:'docs'});
  await env.DB.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,notification_cycle,settings_context_json) VALUES (?,'locked',?,'now','now',1,?)").bind(runId,workflowId,JSON.stringify({replyGroupId:group})).run();
  await env.DB.prepare('INSERT INTO line_command_ingress VALUES (?,?,?,?,?)').bind(eventId,group,operation,await lineCommandWorkflowId(eventId),'now').run();
  await env.DB.prepare("INSERT INTO publication_regeneration_events(event_id,publication_run_id,generation,notification_cycle,workflow_id,action,job_json,group_id,ingress_operation) VALUES (?,?,1,1,?,'restart','{}',?,?)").bind(eventId,runId,workflowId,group,operation).run();
  await env.DB.exec("CREATE TRIGGER fail_early_docs_outbox BEFORE INSERT ON line_result_outbox BEGIN SELECT RAISE(FAIL, 'injected'); END");
  const step={do:async(name:string,...args:any[])=>{if(name==='settings-context')throw new Error('private setup detail');return args.at(-1)();}};
  try { await expect(PublicationWorkflow.prototype.run.call({env} as any,{instanceId:workflowId,payload:{publicationRunId:runId,trigger:'line'}} as any,step as any)).rejects.toThrow('private setup detail'); }
  finally { await env.DB.exec('DROP TRIGGER fail_early_docs_outbox'); }
  const intent=await env.DB.prepare('SELECT outcome_json FROM workflow_feedback_results WHERE run_id=?').bind(runId).first() as {outcome_json:string} | null;
  expect(intent).toBeTruthy(); expect(intent!.outcome_json).not.toContain('private setup detail');
  const sent:any[]=[]; const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{sent.push(JSON.parse(String(init?.body)));return Response.json({});});
  const lineStep={do:async(_name:string,...args:any[])=>args.at(-1)()}, later=crypto.randomUUID();
  try {
    const invoke=()=>LineCommandWorkflow.prototype.run.call({env} as any,{instanceId:later,payload:{receivedAt:new Date().toISOString(),event:{type:'message',webhookEventId:later,replyToken:'token',source:{type:'group',groupId:group,userId:'U1'},message:{type:'text',id:'m',text:'hello'}}}} as any,lineStep as any);
    const foreign = crypto.randomUUID();
    expect(await LineCommandWorkflow.prototype.run.call({env} as any,{instanceId:foreign,payload:{receivedAt:new Date().toISOString(),event:{type:'message',webhookEventId:foreign,replyToken:'token',source:{type:'group',groupId:'foreign',userId:'U1'},message:{type:'text',id:'m',text:'hello'}}}} as any,lineStep as any)).toEqual({status:'ignored'});
    expect(sent).toHaveLength(0);
    expect(await invoke()).toEqual({status:'accepted'}); await invoke();
    expect(sent).toHaveLength(1); expect(JSON.stringify(sent)).toContain(runId);
    expect((await env.DB.prepare('SELECT * FROM line_result_outbox WHERE group_id=? AND result_key=?').bind(group,JSON.stringify(['publication',runId,1,1,'terminal'])).all()).results).toHaveLength(1);
  } finally { fetcher.mockRestore(); }
});

it('uses trusted binding to record an identity lookup failure', async () => {
  const env=testEnv(), runId=crypto.randomUUID(), group=crypto.randomUUID(), eventId=crypto.randomUUID();
  const workflowId=publicationWorkflowId(runId,1), operation=JSON.stringify({type:'docs'});
  await env.DB.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,notification_cycle,settings_context_json) VALUES (?,'locked',?,'now','now',1,?)").bind(runId,workflowId,JSON.stringify({replyGroupId:group})).run();
  await env.DB.prepare('INSERT INTO line_command_ingress VALUES (?,?,?,?,?)').bind(eventId,group,operation,await lineCommandWorkflowId(eventId),'now').run();
  await env.DB.prepare("INSERT INTO publication_regeneration_events(event_id,publication_run_id,generation,notification_cycle,workflow_id,action,job_json,group_id,ingress_operation) VALUES (?,?,1,1,?,'restart','{}',?,?)").bind(eventId,runId,workflowId,group,operation).run();
  const error=new Error('identity lookup failed');
  const step={do:async(name:string,...args:any[])=>name==='settings-context'?{}:name==='notification-identity'?Promise.reject(error):args.at(-1)()};
  await expect(PublicationWorkflow.prototype.run.call({env} as any,{instanceId:workflowId,payload:{publicationRunId:runId,trigger:'line'}} as any,step as any)).rejects.toBe(error);
  expect(await env.DB.prepare('SELECT group_id FROM line_result_outbox WHERE group_id=?').bind(group).first()).toEqual({group_id:group});
});
