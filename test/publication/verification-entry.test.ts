import { expect, it, vi } from 'vitest';
import { testEnv } from '../helpers/env';
import { claimPublicationVerification } from '../../src/db/publication-repository';
import { PublicationWorkflow } from '../../src/publication/workflow';

it('fences verification entries and holds the current attempt without starting business work', async () => {
  const env = {...testEnv(), PUBLICATION_WORKFLOW: {get: vi.fn(async () => ({status: async () => ({status: 'terminated'})}))}} as unknown as ReturnType<typeof testEnv>, runId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:groupId, target:'original'});
  await env.DB.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','original','x','x',2,3,?)").bind(runId,context).run();
  const attempt = {runId,generation:2,notificationCycle:3,groupId};
  const claim = await claimPublicationVerification(env.DB, attempt);
  if (claim.status !== 'claimed') throw new Error('missing claim');
  const payload = {kind:'verification',publicationRunId:runId,generation:2,notificationCycle:3,groupId,verifierId:claim.verifierId};
  const step = {do: vi.fn(async (name: string, callback: () => Promise<unknown>) => { expect(name).toBe('verify-publication'); return callback(); })};
  const run = (p: object, id = claim.verifierId) => PublicationWorkflow.prototype.run.call({env} as any, {payload:p,instanceId:id} as any, step as any);
  for (const p of [{...payload,groupId:'foreign'}, {...payload,generation:1}, {...payload,notificationCycle:2}, {...payload,verifierId:'replaced'}]) await expect(run(p)).resolves.toBeNull();
  await expect(run(payload,'foreign')).resolves.toBeNull();
  let row = await env.DB.prepare('SELECT completed,result_json FROM publication_verification_claims WHERE publication_run_id=?').bind(runId).first<{completed:number;result_json:string|null}>();
  expect(row).toMatchObject({completed:0,result_json:null});
  await env.DB.prepare('UPDATE publication_jobs SET settings_context_json=? WHERE publication_run_id=?').bind(JSON.stringify({replyGroupId:groupId,target:'changed'}),runId).run();
  await run(payload);
  row = await env.DB.prepare('SELECT completed,result_json FROM publication_verification_claims WHERE publication_run_id=?').bind(runId).first();
  expect(row).toMatchObject({completed:0,result_json:null});
  await env.DB.prepare('UPDATE publication_jobs SET settings_context_json=? WHERE publication_run_id=?').bind(context,runId).run();
  await run(payload);
  row = await env.DB.prepare('SELECT completed,result_json FROM publication_verification_claims WHERE publication_run_id=?').bind(runId).first();
  expect(row!.completed).toBe(1);
  expect(JSON.parse(row!.result_json!).outcome).toBe('unconfirmed');
  await run(payload);
  expect(step.do).toHaveBeenCalledTimes(8);
});

 it('holds verification while the original workflow is still running', async () => {
  const env = {...testEnv(), PUBLICATION_WORKFLOW: {get: vi.fn(async () => ({status: async () => ({status: 'running'})}))}} as any;
  const runId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:groupId});
  await env.DB.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','original','x','x',1,1,?)").bind(runId,context).run();
  const attempt = {runId,generation:1,notificationCycle:1,groupId};
  const claim = await claimPublicationVerification(env.DB,attempt);
  if (claim.status !== 'claimed') throw new Error('missing claim');
  await expect(PublicationWorkflow.prototype.run.call({env} as any, {payload:{kind:'verification',publicationRunId:runId,generation:1,notificationCycle:1,groupId,verifierId:claim.verifierId},instanceId:claim.verifierId} as any, {do: async (_:string, cb:()=>Promise<unknown>)=>cb()} as any)).rejects.toThrow('publication_origin_not_stopped');
  const row = await env.DB.prepare('SELECT completed FROM publication_verification_claims WHERE publication_run_id=?').bind(runId).first();
  expect(row.completed).toBe(0);
});

it.each([
  ['matched', 'matched', 'failed'],
  ['foreign record', 'foreign', 'unconfirmed'],
  ['conflicting document', 'conflict', 'unconfirmed'],
  ['lost read', 'lost', 'unconfirmed'],
  ['generating repaired', 'repair', 'failed'],
  ['lost update response', 'lost update', 'failed'],
  ['manual conflict before update', 'manual', 'unconfirmed'],
  ['conflict after update', 'after', 'unconfirmed'],
  ['eligibility changed before update', 'eligibility', 'unconfirmed'],
])('verifies a %s Airtable read once and queues its result', async (_label, mode, outcome) => {
  const env = {...testEnv(), PUBLICATION_WORKFLOW: {get: vi.fn(async () => ({status: async () => ({status: 'terminated'})}))}} as any;
  const runId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:groupId,settings:{config:{airtableBaseId:'base',airtablePublicationRunsTableId:'table'}}});
  await env.DB.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','original','x','x',1,1,?)").bind(runId,context).run();
  const attempt = {runId,generation:1,notificationCycle:1,groupId};
  const claim = await claimPublicationVerification(env.DB,attempt);
  if (claim.status !== 'claimed') throw new Error('missing claim');
  await env.DB.prepare("INSERT INTO publication_google_write_evidence VALUES (?,1,1,'tracking',1)").bind(runId).run();
  await env.DB.prepare("INSERT INTO workflow_feedback(kind,run_id,generation,notification_cycle,group_id,context_json,stage,failure_code) VALUES ('publication',?,1,1,?,?,'prepare outputs','anthropic_failed')").bind(runId,groupId,context).run();
  await env.DB.prepare("INSERT INTO workflow_feedback_results(kind,run_id,generation,notification_cycle,revision,result_key,outcome_json,group_id) VALUES ('publication',?,1,1,0,?,?,?)").bind(runId,runId,JSON.stringify({stage:'prepare outputs',failureCode:'anthropic_failed',outcome:'unconfirmed'}),groupId).run();
  let reads = 0;
  const fetchMock = vi.spyOn(globalThis,'fetch').mockImplementation(async (_url, init) => {
    if (mode === 'lost') throw new Error('lost');
    if (init?.method === 'PATCH') {
      expect(JSON.parse(String(init.body))).toEqual({fields:{Status:'Failed'}});
      if (mode === 'lost update') throw new Error('lost');
      return Response.json({});
    }
    reads++;
    if (mode === 'eligibility' && reads === 2) await env.DB.prepare("UPDATE publication_google_write_evidence SET state='unknown' WHERE publication_run_id=?").bind(runId).run();
    const generating = ['repair','lost update','manual','after','eligibility'].includes(mode) && reads <= 2;
    return Response.json({id:mode === 'foreign' ? 'other' : runId,fields:{Status:mode === 'manual' && reads === 2 ? 'Ready' : generating ? 'Generating' : 'Failed', ...((mode === 'conflict' || (mode === 'after' && reads === 3)) ? {'Google Doc URL':'https://example.com'} : {})}});
  });
  try {
    const payload = {kind:'verification',publicationRunId:runId,generation:1,notificationCycle:1,groupId,verifierId:claim.verifierId};
    const run = () => PublicationWorkflow.prototype.run.call({env} as any, {payload,instanceId:claim.verifierId} as any, {do: async (_:string, cb:()=>Promise<unknown>)=>cb()} as any);
    await run(); await run();
    const rows = await env.DB.prepare('SELECT result_json FROM line_result_outbox WHERE group_id=?').bind(groupId).all();
    expect(rows.results).toHaveLength(1);
    expect(JSON.parse(rows.results[0]!.result_json).outcome).toBe(outcome);
    expect(fetchMock).toHaveBeenCalledTimes(['repair','lost update','after'].includes(mode) ? 4 : ['manual','eligibility'].includes(mode) ? 2 : 1);
  } finally { fetchMock.mockRestore(); }
});
