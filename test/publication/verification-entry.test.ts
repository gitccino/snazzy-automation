import { expect, it, vi } from 'vitest';
import { createTestEnv, testEnv } from '../helpers/env';
import { claimPublicationVerification } from '../../src/db/publication-repository';
import { PublicationWorkflow } from '../../src/publication/workflow';
import { createWorkflowFeedbackRepository } from '../../src/db/workflow-feedback';
import { createLineReplyRepository } from '../../src/db/line-reply-repository';
import { deliverEventReply } from '../../src/line/reply-delivery';
import { createLineClient } from '../../src/line/client';
import { fixedClock } from '../helpers/fakes';
import { handleDocsTrigger } from '../../src/publication/trigger';
import { publicationWorkflowId } from '../../src/publication/types';
import { captureOperationContext } from '../../src/settings/runtime';

it('checks a stopped owned publication when Airtable saved success before D1', async () => {
  const runId = crypto.randomUUID(), groupId = crypto.randomUUID(), dispatched: any[] = [];
  const env = {...testEnv(), ...createTestEnv(), AIRTABLE_TOKEN:'test', GOOGLE_OAUTH_CLIENT_ID:'client', GOOGLE_OAUTH_CLIENT_SECRET:'secret', GOOGLE_REFRESH_TOKEN:'refresh', PUBLICATION_WORKFLOW:{get:async()=>({status:async()=>({status:'terminated'})}), create:async (item:any)=>{dispatched.push(item); return {id:item.id};}}} as any;
  const captured = await captureOperationContext(env,null);
  const context = {...captured,replyGroupId:groupId,settings:{...captured.settings,config:{...captured.settings.config,airtableBaseId:'base',airtablePublicationRunsTableId:'table',googleDriveFolderId:'folder',googleTemplateDocId:'template'}}};
  const intent = {generation:1,publicationDate:'2026-11-20',thaiDate:'date',docId:'doc',docUrl:'https://docs.google.com/document/d/doc/edit',title:'title',productIds:['A-1'],generatedAt:'2026-11-20T00:00:00.000Z'};
  await env.DB.prepare("INSERT INTO publication_jobs(publication_run_id,publication_date,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json,finalization_json) VALUES (?,?,'generating',?,'x','x',1,1,?,?)").bind(runId,intent.publicationDate,publicationWorkflowId(runId,1),JSON.stringify(context),JSON.stringify(intent)).run();
  const requests: string[] = [];
  const mock = vi.spyOn(globalThis,'fetch').mockImplementation(async (input,init) => {
    const url = String(input), method = init?.method ?? 'GET'; requests.push(`${method} ${url}`);
    if (url.includes('oauth2.googleapis.com')) return Response.json({access_token:'token',expires_in:3600});
    if (url.includes('api.airtable.com')) {
      const record = {id:runId,fields:{'Publication Date':intent.publicationDate,Status:'Generated',Products:[],'Google Doc URL':intent.docUrl,'Generated At':intent.generatedAt}};
      return Response.json(url.includes(`/${runId}`) ? record : {records:[record]});
    }
    if (url.includes('docs.googleapis.com')) return Response.json({body:{content:[{paragraph:{elements:[{textRun:{content:'Product ID: A-1\n'}}]}}]}});
    if (url.includes('googleapis.com/drive')) return Response.json({id:'doc',name:'title',parents:['folder'],trashed:false});
    throw new Error(`unexpected ${url}`);
  });
  try {
    expect(await handleDocsTrigger(env,'line',fixedClock('2026-11-20T00:00:00Z'),intent.publicationDate,fetch,{...context,replyGroupId:'other'} as any)).toEqual({status:'busy'});
    expect(await handleDocsTrigger(env,'line',fixedClock('2026-11-20T00:00:00Z'),intent.publicationDate,fetch,context as any)).toEqual({status:'checking',publicationRunId:runId});
    expect(dispatched).toHaveLength(1);
    const item = dispatched[0];
    await PublicationWorkflow.prototype.run.call({env} as any,{payload:item.params,instanceId:item.id} as any,{do:async (_:string,cb:()=>Promise<unknown>)=>cb()} as any);
    const claim = await env.DB.prepare('SELECT result_json FROM publication_verification_claims WHERE publication_run_id=?').bind(runId).first();
    expect(JSON.parse(claim.result_json)).toMatchObject({outcome:'success',messages:[{text:expect.stringContaining(intent.docUrl)}]});
    const outbox = await env.DB.prepare('SELECT group_id,result_json FROM line_result_outbox WHERE group_id=?').bind(groupId).all();
    expect(outbox.results).toHaveLength(1);
    expect(await env.DB.prepare('SELECT state,successful_generation FROM publication_jobs WHERE publication_run_id=?').bind(runId).first()).toEqual({state:'generating',successful_generation:0});
    expect(requests.filter(request=>!request.includes('oauth2.googleapis.com')).every(request=>request.startsWith('GET '))).toBe(true);
  } finally { mock.mockRestore(); }
});

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
  await env.DB.prepare("INSERT INTO workflow_feedback_results(kind,run_id,generation,notification_cycle,revision,result_key,outcome_json,group_id) VALUES ('publication',?,1,1,0,?,?,?)").bind(runId,runId,JSON.stringify({stage:'prepare outputs',failureCode:'anthropic_failed',action:'verify',outcome:'unconfirmed',references:{thaiDate:'19 พฤศจิกายน 2569',airtableRunUrl:`https://airtable.com/base/table/${runId}`,publicBaseUrl:'https://original.test'}}),groupId).run();
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
    const claimRow = await env.DB.prepare('SELECT result_json FROM publication_verification_claims WHERE publication_run_id=?').bind(runId).first();
    const verified = JSON.parse(claimRow.result_json);
    expect(verified.outcome).toBe(outcome);
    const clock = fixedClock('2026-11-20T08:00:00Z');
    const requests: any[] = [];
    const line = createLineClient({channelAccessToken:'test',fetch:async (_url,init)=>{requests.push(JSON.parse(String(init?.body)));return Response.json({}, {headers:{'x-line-request-id':'receipt'}});}});
    const deps = {clock, repo:createLineReplyRepository(env.DB,clock), feedback:createWorkflowFeedbackRepository(env.DB), isGroupAllowed:async()=>true, line};
    const input = {groupId,workflowId:'eligible',receivedAt:clock.now().toISOString(),replyToken:'fresh',commandReply:null,drainQueue:true,publicBaseUrl:'https://new.test'};
    for (let i=0;i<3;i++) await deliverEventReply({...input,eventId:crypto.randomUUID()},deps);
    expect(requests).toHaveLength(outcome === 'failed' ? 2 : 1);
    expect(JSON.stringify(requests[0])).toContain(`https://airtable.com/base/table/${runId}`);
    expect(JSON.stringify(requests[0])).toContain('19 พฤศจิกายน 2569');
    if (outcome === 'failed') expect(requests[1].messages).toEqual([{type:'text',text:'ผลการตรวจสอบเปลี่ยนจากข้อความก่อนหน้า'},...verified.messages]);
    expect(requests.every(request=>request.replyToken==='fresh')).toBe(true);
    expect((await env.DB.prepare('SELECT group_id,phase,request_id FROM line_reply_dispatches WHERE group_id=?').bind(groupId).all()).results).toEqual(requests.map(()=>({group_id:groupId,phase:'accepted',request_id:'receipt'})));
    expect(await deps.feedback.pendingByGroup(groupId,10)).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(['repair','lost update','after'].includes(mode) ? 4 : ['manual','eligibility'].includes(mode) ? 2 : 1);
  } finally { fetchMock.mockRestore(); }
});

it.each(['match','conflict','unavailable','changed','generating'])('verifies saved finalization evidence: %s', async mode => {
  const env = {...testEnv(), AIRTABLE_TOKEN:'test-airtable-token', GOOGLE_OAUTH_CLIENT_ID:'client', GOOGLE_OAUTH_CLIENT_SECRET:'secret', GOOGLE_REFRESH_TOKEN:'refresh', PUBLICATION_WORKFLOW:{get:vi.fn(async()=>({status:async()=>({status:'terminated'})}))}} as any;
  const runId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:groupId,settings:{config:{airtableBaseId:'original-base',airtablePublicationRunsTableId:'original-table',googleDriveFolderId:'folder',googleTemplateDocId:'template'}}});
  const intent = {generation:1,publicationDate:'2026-11-20',thaiDate:'date',docId:'doc',docUrl:'https://docs.google.com/document/d/doc/edit',title:'title',productIds:['A-1'],generatedAt:'2026-11-20T00:00:00.000Z'};
  await env.DB.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json,finalization_json) VALUES (?,'generating','original','x','x',1,1,?,?)").bind(runId,context,JSON.stringify(intent)).run();
  const claim = await claimPublicationVerification(env.DB,{runId,generation:1,notificationCycle:1,groupId});
  if (claim.status !== 'claimed') throw new Error('missing claim');
  const fetchMock = vi.spyOn(globalThis,'fetch').mockImplementation(async (url,init) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com')) return Response.json({access_token:'token',expires_in:3600});
    expect(init?.method ?? 'GET').toBe('GET');
    if (u.includes('api.airtable.com')) { if (mode === 'unavailable') throw new Error('offline'); if (mode === 'changed') await env.DB.prepare('UPDATE publication_jobs SET finalization_json=? WHERE publication_run_id=?').bind(JSON.stringify({...intent,title:'changed'}),runId).run(); expect(u).toContain('/original-base/original-table/'); expect((init?.headers as any).Authorization).toBe('Bearer test-airtable-token'); return Response.json({id:runId,fields:mode === 'generating' ? {Status:'Generating'} : {Status:'Generated','Google Doc URL':mode === 'conflict' ? 'https://example.com' : intent.docUrl,'Generated At':intent.generatedAt}}); }
    if (u.includes('docs.googleapis.com')) return Response.json({body:{content:[{paragraph:{elements:[{textRun:{content:'Product ID: A-1\n'}}]}}]}});
    if (u.includes('googleapis.com/drive')) return Response.json({id:'doc',name:'title',parents:['folder'],trashed:false});
    throw new Error(`unexpected ${u}`);
  });
  try {
    const payload = {kind:'verification',publicationRunId:runId,generation:1,notificationCycle:1,groupId,verifierId:claim.verifierId};
    const run = () => PublicationWorkflow.prototype.run.call({env} as any,{payload,instanceId:claim.verifierId} as any,{do:async (_:string,cb:()=>Promise<unknown>)=>cb()} as any);
    await run(); if (mode !== 'changed') await run();
    const row = await env.DB.prepare('SELECT result_json FROM publication_verification_claims WHERE publication_run_id=?').bind(runId).first();
    if (mode === 'changed') { expect(row.result_json).toBeNull(); return; }
    expect(JSON.parse(row.result_json).outcome).toBe(mode === 'match' ? 'success' : 'unconfirmed');
    const outbox = await env.DB.prepare('SELECT group_id,result_json FROM line_result_outbox WHERE group_id=?').bind(groupId).all();
    expect(outbox.results).toHaveLength(1);
    if (mode === 'match') expect(JSON.stringify(outbox.results)).toContain(intent.docUrl);
  } finally { fetchMock.mockRestore(); }
});

it('reads the saved cleanup ID using the captured folder and leaves the outcome uncertain', async () => {
  const env = {...testEnv(), GOOGLE_OAUTH_CLIENT_ID:'client', GOOGLE_OAUTH_CLIENT_SECRET:'secret', GOOGLE_REFRESH_TOKEN:'refresh', PUBLICATION_WORKFLOW:{get:vi.fn(async()=>({status:async()=>({status:'terminated'})}))}} as any;
  const runId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:groupId,settings:{config:{googleDriveFolderId:'folder'}}});
  await env.DB.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','original','x','x',1,1,?)").bind(runId,context).run();
  await env.DB.prepare("INSERT INTO publication_cleanup_intents (publication_run_id,generation,notification_cycle,origin_workflow_id,context_json,doc_id) VALUES (?,1,1,'original',?,'saved/id')").bind(runId,context).run();
  const claim = await claimPublicationVerification(env.DB,{runId,generation:1,notificationCycle:1,groupId});
  if (claim.status !== 'claimed') throw new Error('missing claim');
  const fetchMock = vi.spyOn(globalThis,'fetch').mockImplementation(async (url,init) => {
    if (String(url).includes('oauth2.googleapis.com')) return Response.json({access_token:'token',expires_in:3600});
    expect(String(url)).toContain('/files/saved%2Fid?fields=id,parents,trashed,appProperties');
    expect((init?.headers as any).Authorization).toBe('Bearer token');
    expect(init?.method ?? 'GET').toBe('GET');
    return Response.json({id:'saved/id',parents:['folder'],trashed:false,appProperties:{publicationRunId:runId}});
  });
  try {
    const payload = {kind:'verification',publicationRunId:runId,generation:1,notificationCycle:1,groupId,verifierId:claim.verifierId};
    await PublicationWorkflow.prototype.run.call({env} as any,{payload,instanceId:claim.verifierId} as any,{do:async (_:string,cb:()=>Promise<unknown>)=>cb()} as any);
    const row = await env.DB.prepare('SELECT result_json FROM publication_verification_claims WHERE publication_run_id=?').bind(runId).first();
    expect(JSON.parse(row.result_json).outcome).toBe('unconfirmed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally { fetchMock.mockRestore(); }
});

it.each(['success','timeout','mismatch','missing'])('dispatches cleanup at most once: %s', async mode => {
  const env = {...testEnv(), GOOGLE_OAUTH_CLIENT_ID:'client', GOOGLE_OAUTH_CLIENT_SECRET:'secret', GOOGLE_REFRESH_TOKEN:'refresh', PUBLICATION_WORKFLOW:{get:async()=>({status:async()=>({status:'terminated'})})}} as any;
  const runId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:groupId,settings:{config:{googleDriveFolderId:'folder'}}});
  await env.DB.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','original','x','x',1,1,?)").bind(runId,context).run();
  await env.DB.prepare("INSERT INTO publication_cleanup_intents (publication_run_id,generation,notification_cycle,origin_workflow_id,context_json,doc_id,saved_temp_doc) VALUES (?,1,1,'original',?,'doc',1)").bind(runId,context).run();
  const claim = await claimPublicationVerification(env.DB,{runId,generation:1,notificationCycle:1,groupId});
  if (claim.status !== 'claimed') throw new Error('missing claim');
  let deletes = 0;
  const mock = vi.spyOn(globalThis,'fetch').mockImplementation(async (url,init) => {
    if (String(url).includes('oauth2.googleapis.com')) return Response.json({access_token:'token',expires_in:3600});
    if (init?.method === 'DELETE') { deletes++; if (mode === 'timeout') throw new Error('timeout'); return new Response(null,{status:mode === 'missing' ? 404 : 204}); }
    return Response.json({id:'doc',parents:[mode === 'mismatch' ? 'other' : 'folder'],trashed:false,appProperties:{publicationRunId:runId}});
  });
  try {
    const payload = {kind:'verification',publicationRunId:runId,generation:1,notificationCycle:1,groupId,verifierId:claim.verifierId};
    const run = () => PublicationWorkflow.prototype.run.call({env} as any,{payload,instanceId:claim.verifierId} as any,{do:async (_:string,cb:()=>Promise<unknown>)=>cb()} as any);
    await run(); await run();
    const row = await env.DB.prepare('SELECT dispatch_verifier_id,deletion_acknowledged FROM publication_cleanup_intents WHERE publication_run_id=?').bind(runId).first();
    expect(deletes).toBe(mode === 'mismatch' ? 0 : 1);
    expect(row.deletion_acknowledged).toBe(mode === 'success' ? 1 : null);
    expect(row.dispatch_verifier_id).toBe(mode === 'mismatch' ? null : claim.verifierId);
  } finally { mock.mockRestore(); }
});

it('does not access Drive when replaying an acknowledged cleanup receipt', async () => {
  const env = {...testEnv(), PUBLICATION_WORKFLOW:{get:async()=>({status:async()=>({status:'terminated'})})}} as any;
  const runId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:groupId,settings:{config:{googleDriveFolderId:'folder'}}});
  await env.DB.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'failed','original','x','x',1,1,?)").bind(runId,context).run();
  const claim = await claimPublicationVerification(env.DB,{runId,generation:1,notificationCycle:1,groupId});
  if (claim.status !== 'claimed') throw new Error('missing claim');
  await env.DB.prepare("INSERT INTO publication_cleanup_intents (publication_run_id,generation,notification_cycle,origin_workflow_id,context_json,doc_id,saved_temp_doc,dispatch_verifier_id,deletion_acknowledged) VALUES (?,1,1,'original',?,'doc',1,?,1)").bind(runId,context,claim.verifierId).run();
  const mock = vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('unexpected fetch'));
  try {
    const payload = {kind:'verification',publicationRunId:runId,generation:1,notificationCycle:1,groupId,verifierId:claim.verifierId};
    const run = () => PublicationWorkflow.prototype.run.call({env} as any,{payload,instanceId:claim.verifierId} as any,{do:async (_:string,cb:()=>Promise<unknown>)=>cb()} as any);
    await run(); await run();
    expect(mock).not.toHaveBeenCalled();
  } finally { mock.mockRestore(); }
});

it.each(['success', 'lost response', 'manual conflict'])('repairs the original Airtable row after acknowledged cleanup: %s', async mode => {
  const env = {...testEnv(), PUBLICATION_WORKFLOW:{get:async()=>({status:async()=>({status:'terminated'})})}} as any;
  const runId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:groupId,settings:{config:{airtableBaseId:'original-base',airtablePublicationRunsTableId:'original-table'}}});
  await env.DB.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json,temp_doc_id) VALUES (?,'failed','original','x','x',1,1,?,'doc')").bind(runId,context).run();
  const claim = await claimPublicationVerification(env.DB,{runId,generation:1,notificationCycle:1,groupId});
  if (claim.status !== 'claimed') throw new Error('missing claim');
  await env.DB.prepare("INSERT INTO publication_cleanup_intents (publication_run_id,generation,notification_cycle,origin_workflow_id,context_json,doc_id,saved_temp_doc,dispatch_verifier_id,deletion_acknowledged) VALUES (?,1,1,'original',?,'doc',1,?,1)").bind(runId,context,claim.verifierId).run();
  await env.DB.prepare("INSERT INTO workflow_feedback(kind,run_id,generation,notification_cycle,group_id,context_json,stage,failure_code) VALUES ('publication',?,1,1,?,?,'prepare outputs','anthropic_failed')").bind(runId,groupId,context).run();
  await env.DB.prepare("INSERT INTO workflow_feedback_results(kind,run_id,generation,notification_cycle,revision,result_key,outcome_json,group_id) VALUES ('publication',?,1,1,0,?,?,?)").bind(runId,runId,JSON.stringify({stage:'prepare outputs',failureCode:'anthropic_failed',outcome:'unconfirmed'}),groupId).run();
  let status = 'Generating', patches = 0, reads = 0;
  const mock = vi.spyOn(globalThis,'fetch').mockImplementation(async (url,init) => {
    expect(String(url)).toBe(`https://api.airtable.com/v0/original-base/original-table/${runId}`);
    if (init?.method === 'PATCH') { patches++; status = 'Failed'; expect(JSON.parse(String(init.body))).toEqual({fields:{Status:'Failed'}}); if (mode === 'lost response') throw new Error('lost'); }
    else if (++reads === 2 && mode === 'manual conflict') status = 'Ready';
    return Response.json({id:runId,fields:{Status:status}});
  });
  try {
    const payload = {kind:'verification',publicationRunId:runId,generation:1,notificationCycle:1,groupId,verifierId:claim.verifierId};
    const run = () => PublicationWorkflow.prototype.run.call({env} as any,{payload,instanceId:claim.verifierId} as any,{do:async (_:string,cb:()=>Promise<unknown>)=>cb()} as any);
    await run(); await run();
    expect(patches).toBe(mode === 'manual conflict' ? 0 : 1);
    const row = await env.DB.prepare('SELECT outcome_json FROM workflow_feedback_results WHERE run_id=? AND revision=1').bind(runId).first();
    if (mode === 'manual conflict') {
      expect(row).toBeNull();
      const claimRow = await env.DB.prepare('SELECT result_json FROM publication_verification_claims WHERE publication_run_id=?').bind(runId).first();
      expect(JSON.parse(claimRow.result_json).outcome).toBe('unconfirmed');
    } else {
      expect(status).toBe('Failed');
      expect(JSON.parse(row.outcome_json)).toMatchObject({outcome:'failed',result:{messages:[{text:expect.stringContaining('ตรวจสอบแล้ว สถานะงานใน Airtable เป็น Failed')}]}});
    }
  } finally { mock.mockRestore(); }
});

it('delivers the primary failure and one truthful cleanup correction only to the original group', async () => {
  const env = {...testEnv(), GOOGLE_OAUTH_CLIENT_ID:'client', GOOGLE_OAUTH_CLIENT_SECRET:'secret', GOOGLE_REFRESH_TOKEN:'refresh', PUBLICATION_WORKFLOW:{get:async()=>({status:async()=>({status:'terminated'})})}} as any;
  const runId = crypto.randomUUID(), groupId = crypto.randomUUID(), otherGroup = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:groupId,settings:{config:{airtableBaseId:'original-base',airtablePublicationRunsTableId:'original-table',googleDriveFolderId:'folder'}}});
  await env.DB.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json,temp_doc_id) VALUES (?,'failed','original','x','x',1,1,?,'doc')").bind(runId,context).run();
  const claim = await claimPublicationVerification(env.DB,{runId,generation:1,notificationCycle:1,groupId});
  if (claim.status !== 'claimed') throw new Error('missing claim');
  await env.DB.prepare("INSERT INTO publication_cleanup_intents (publication_run_id,generation,notification_cycle,origin_workflow_id,context_json,doc_id,saved_temp_doc) VALUES (?,1,1,'original',?,'doc',1)").bind(runId,context).run();
  await env.DB.prepare("INSERT INTO workflow_feedback(kind,run_id,generation,notification_cycle,group_id,context_json,stage,failure_code) VALUES ('publication',?,1,1,?,?,'prepare outputs','anthropic_failed')").bind(runId,groupId,context).run();
  await env.DB.prepare("INSERT INTO workflow_feedback_results(kind,run_id,generation,notification_cycle,revision,result_key,outcome_json,group_id) VALUES ('publication',?,1,1,0,?,?,?)").bind(runId,runId,JSON.stringify({stage:'prepare outputs',failureCode:'anthropic_failed',action:'verify',outcome:'unconfirmed',references:{thaiDate:'19 พฤศจิกายน 2569',airtableRunUrl:`https://airtable.com/base/table/${runId}`,publicBaseUrl:'https://original.test'}}),groupId).run();
  let status = 'Generating', patches = 0, deletes = 0;
  const mock = vi.spyOn(globalThis,'fetch').mockImplementation(async (url,init) => {
    if (String(url).includes('oauth2.googleapis.com')) return Response.json({access_token:'token',expires_in:3600});
    if (String(url).includes('googleapis.com/drive')) {
      if (init?.method === 'DELETE') { deletes++; return new Response(null,{status:204}); }
      return Response.json({id:'doc',parents:['folder'],trashed:false,appProperties:{publicationRunId:runId}});
    }
    expect(String(url)).toBe(`https://api.airtable.com/v0/original-base/original-table/${runId}`);
    if (init?.method === 'PATCH') { patches++; expect(JSON.parse(String(init.body))).toEqual({fields:{Status:'Failed'}}); status = 'Failed'; }
    return Response.json({id:runId,fields:{Status:status}});
  });
  try {
    const payload = {kind:'verification',publicationRunId:runId,generation:1,notificationCycle:1,groupId,verifierId:claim.verifierId};
    const run = () => PublicationWorkflow.prototype.run.call({env} as any,{payload,instanceId:claim.verifierId} as any,{do:async (_:string,cb:()=>Promise<unknown>)=>cb()} as any);
    await run();
    expect(deletes).toBe(1);
    expect(await env.DB.prepare('SELECT dispatch_verifier_id,deletion_acknowledged FROM publication_cleanup_intents WHERE publication_run_id=?').bind(runId).first()).toMatchObject({dispatch_verifier_id:claim.verifierId,deletion_acknowledged:1});
    const clock = fixedClock('2026-11-20T08:00:00Z'), requests: any[] = [];
    const line = createLineClient({channelAccessToken:'test',fetch:async (_url,init)=>{requests.push(JSON.parse(String(init?.body)));return Response.json({}, {headers:{'x-line-request-id':'receipt'}});}});
    const deps = {clock,repo:createLineReplyRepository(env.DB,clock),feedback:createWorkflowFeedbackRepository(env.DB),isGroupAllowed:async()=>true,line};
    const deliver = (groupId: string) => deliverEventReply({groupId,workflowId:'eligible',receivedAt:clock.now().toISOString(),replyToken:'fresh',commandReply:null,drainQueue:true,publicBaseUrl:'https://new.test',eventId:crypto.randomUUID()},deps);
    await deliver(otherGroup);
    expect(requests).toHaveLength(0);
    await deliver(groupId); await deliver(groupId);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0])).toContain(`https://airtable.com/base/table/${runId}`);
    expect(JSON.stringify(requests[0])).toContain('19 พฤศจิกายน 2569');
    expect(JSON.stringify(requests[0])).toContain('ยังยืนยันสถานะงานเอกสารไม่ได้');
    expect(requests[1].messages[0]).toEqual({type:'text',text:'ผลการตรวจสอบเปลี่ยนจากข้อความก่อนหน้า'});
    expect(JSON.stringify(requests[1])).toContain('ตรวจสอบแล้ว สถานะงานใน Airtable เป็น Failed');
    const calls = mock.mock.calls.length;
    await run(); await deliver(groupId); await deliver(otherGroup);
    expect(requests).toHaveLength(2);
    expect(patches).toBe(1);
    expect(deletes).toBe(1);
    expect(mock).toHaveBeenCalledTimes(calls);
  } finally { mock.mockRestore(); }
});
