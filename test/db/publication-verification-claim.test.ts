import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { fixedClock } from '../helpers/fakes';
import { createLineReplyRepository } from '../../src/db/line-reply-repository';
import { createLineClient } from '../../src/line/client';
import { deliverEventReply } from '../../src/line/reply-delivery';
import { claimPublicationVerification, completePublicationVerification, reopenFailedJobForRestart, advanceUnconfirmedPublicationRestart, reopenSuccessfulJobForRegeneration } from '../../src/db/publication-repository';

const db = testEnv().DB;

it('claims one verifier for concurrent requests using captured context', async () => {
  const runId = crypto.randomUUID();
  const context = JSON.stringify({ replyGroupId: 'owner', settings: { config: { airtableBaseId: 'original' } } });
  await db.prepare("INSERT INTO publication_jobs (publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','workflow','x','x',2,3,?)").bind(runId, context).run();
  const request = { runId, generation: 2, notificationCycle: 3, groupId: 'owner' };
  const results = await Promise.all([claimPublicationVerification(db, request), claimPublicationVerification(db, request)]);
  expect(results.filter(r => r.status === 'claimed')).toHaveLength(1);
  expect(results.filter(r => r.status === 'held')).toEqual([{ status: 'held' }]);
  const row = await db.prepare('SELECT * FROM publication_verification_claims WHERE publication_run_id=?').bind(runId).first();
  expect(row).toMatchObject({ generation: 2, notification_cycle: 3, group_id: 'owner', context_json: context, origin_workflow_id: 'workflow' });
  expect(results.find(r => r.status === 'claimed')).toMatchObject({ verifierId: row?.verifier_id });
  expect(await claimPublicationVerification(db, request)).toEqual({ status: 'held' });
});

it('holds stale attempts and foreign groups without exposing captured target', async () => {
  const runId = crypto.randomUUID();
  await db.prepare("INSERT INTO publication_jobs (publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','workflow','x','x',2,3,?)").bind(runId, JSON.stringify({replyGroupId:'owner', target:'secret'})).run();
  for (const request of [{generation:1, notificationCycle:3, groupId:'owner'}, {generation:2, notificationCycle:2, groupId:'owner'}, {generation:2, notificationCycle:3, groupId:'foreign'}]) {
    expect(await claimPublicationVerification(db, {runId, ...request})).toEqual({status:'held'});
  }
  expect(await db.prepare('SELECT * FROM publication_verification_claims WHERE publication_run_id=?').bind(runId).first()).toBeNull();
});

it('renews only a confirmed interrupted verifier and fences late completion', async () => {
  const runId = crypto.randomUUID();
  await db.prepare("INSERT INTO publication_jobs (publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','workflow','x','x',2,3,?)").bind(runId, JSON.stringify({replyGroupId:'owner'})).run();
  const request = {runId, generation:2, notificationCycle:3, groupId:'owner'};
  const first = await claimPublicationVerification(db, request);
  if (first.status !== 'claimed') throw new Error('expected claim');
  for (const status of ['active', 'unavailable', 'terminal'] as const) {
    expect(await claimPublicationVerification(db, request, {verifierId:first.verifierId, status})).toEqual({status:'held'});
  }
  const results = await Promise.all([1,2].map(() => claimPublicationVerification(db, request, {verifierId:first.verifierId, status:'interrupted'})));
  const renewed = results.find(r => r.status === 'claimed');
  expect(results.filter(r => r.status === 'claimed')).toHaveLength(1);
  if (!renewed || renewed.status !== 'claimed') throw new Error('expected renewal');
  expect(renewed.verifierId).not.toBe(first.verifierId);
  const result = {schemaVersion:1, kind:'publication', runId, generation:2, notificationCycle:3, outcome:'success', messages:[{type:'text', text:'original'}]} as const;
  const intent = {originWorkflowId:renewed.originWorkflowId, contextJson:renewed.contextJson, result: {...result, messages: [...result.messages]}};
  expect(await completePublicationVerification(db, request, first.verifierId, intent)).toBe(false);
  expect(await completePublicationVerification(db, request, renewed.verifierId, {...intent, contextJson:'{}'})).toBe(false);
  await db.prepare('UPDATE publication_jobs SET settings_context_json=? WHERE publication_run_id=?').bind(JSON.stringify({replyGroupId:'owner', target:'changed'}), runId).run();
  expect(await completePublicationVerification(db, request, renewed.verifierId, intent)).toBe(false);
  await db.prepare('UPDATE publication_jobs SET settings_context_json=? WHERE publication_run_id=?').bind(renewed.contextJson, runId).run();
  await expect(completePublicationVerification(db, request, renewed.verifierId, {...intent, result:{...intent.result, runId:'other'}})).rejects.toThrow('verification_invalid_result');
  expect(await completePublicationVerification(db, request, renewed.verifierId, intent)).toBe(true);
  expect(await completePublicationVerification(db, request, renewed.verifierId, {...intent, result:{...intent.result, messages:[{type:'text', text:'replacement'}]}})).toBe(false);
  const saved = await db.prepare('SELECT result_json FROM publication_verification_claims WHERE publication_run_id=?').bind(runId).first<{result_json:string}>();
  expect(JSON.parse(saved!.result_json)).toEqual(result);
  expect(await claimPublicationVerification(db, request, {verifierId:renewed.verifierId, status:'interrupted'})).toEqual({status:'held'});
});

it('keeps absent recovery fenced to the owner and current attempt', async () => {
  const runId = crypto.randomUUID();
  await db.prepare("INSERT INTO publication_jobs (publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','workflow','x','x',2,3,?)").bind(runId, JSON.stringify({replyGroupId:'owner'})).run();
  const request = {runId, generation:2, notificationCycle:3, groupId:'owner'};
  const first = await claimPublicationVerification(db, request);
  if (first.status !== 'claimed') throw new Error('expected claim');
  const observation = {verifierId:first.verifierId, status:'absent'} as const;
  expect(await claimPublicationVerification(db, {...request, groupId:'foreign'}, observation)).toEqual({status:'held'});
  expect(await claimPublicationVerification(db, request, {...observation, verifierId:'stale'})).toEqual({status:'held'});
  await db.prepare('UPDATE publication_jobs SET generation=3 WHERE publication_run_id=?').bind(runId).run();
  expect(await claimPublicationVerification(db, request, observation)).toEqual({status:'held'});
  expect(await completePublicationVerification(db, request, first.verifierId)).toBe(false);
});

it('holds renewal when the original workflow or captured context changes', async () => {
  const runId = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:'owner', target:'original'});
  await db.prepare("INSERT INTO publication_jobs (publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','workflow','x','x',2,3,?)").bind(runId, context).run();
  const attempt = {runId, generation:2, notificationCycle:3, groupId:'owner'};
  const claim = await claimPublicationVerification(db, attempt);
  if (claim.status !== 'claimed') throw new Error('expected claim');
  const observation = {verifierId:claim.verifierId, status:'interrupted'} as const;
  await db.prepare('UPDATE publication_jobs SET correlation_id=? WHERE publication_run_id=?').bind('replacement', runId).run();
  expect(await claimPublicationVerification(db, attempt, observation)).toEqual({status:'held'});
  await db.prepare('UPDATE publication_jobs SET correlation_id=?, settings_context_json=? WHERE publication_run_id=?').bind('workflow', JSON.stringify({replyGroupId:'owner', target:'changed'}), runId).run();
  expect(await claimPublicationVerification(db, attempt, observation)).toEqual({status:'held'});
});

it('queues the unconfirmed verification behind the original result for the next messages', async () => {
  const runId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:groupId});
  await db.prepare("INSERT INTO publication_jobs (publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','workflow','x','x',1,1,?)").bind(runId, context).run();
  const attempt = {runId, generation:1, notificationCycle:1, groupId};
  const claim = await claimPublicationVerification(db, attempt);
  if (claim.status !== 'claimed') throw new Error('expected claim');
  const clock = fixedClock('2026-11-19T08:00:00Z');
  const repo = createLineReplyRepository(db, clock);
  const original = {schemaVersion:1, kind:'publication', runId, generation:1, notificationCycle:1, outcome:'unconfirmed', messages:[{type:'text',text:'original'}]} as const;
  const result = {...original, messages:[{type:'text' as const,text:'verification unconfirmed'}]};
  await repo.enqueueResult({resultKey:JSON.stringify(['publication',runId,1,1,'terminal']), groupId, result:{...original, messages:[...original.messages]}});
  const intent = {originWorkflowId:claim.originWorkflowId, contextJson:claim.contextJson, result};
  expect(await completePublicationVerification(db, attempt, 'stale', intent)).toBe(false);
  expect((await db.prepare('SELECT * FROM line_result_outbox WHERE group_id=?').bind(groupId).all()).results).toHaveLength(1);
  expect(await completePublicationVerification(db, attempt, claim.verifierId, intent)).toBe(true);
  expect(await completePublicationVerification(db, attempt, claim.verifierId, intent)).toBe(false);
  const rows = (await db.prepare('SELECT result_key,result_json FROM line_result_outbox WHERE group_id=? ORDER BY sequence').bind(groupId).all<{result_key:string;result_json:string}>()).results;
  expect(rows.map(row => JSON.parse(row.result_json))).toEqual([original, result]);
  expect(rows[1]!.result_key).toBe(JSON.stringify(['publication',runId,1,1,'verification']));
  const requests: any[] = [];
  const line = createLineClient({channelAccessToken:'private',fetch:async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return Response.json({}); }});
  const input = {groupId, workflowId:'wf', receivedAt:clock.now().toISOString(), replyToken:'fresh', commandReply:null, drainQueue:true, publicBaseUrl:'https://app.test'};
  const deps = {repo, line, clock, isGroupAllowed:async()=>true};
  await deliverEventReply({...input,eventId:crypto.randomUUID()}, deps);
  await deliverEventReply({...input,eventId:crypto.randomUUID()}, deps);
  expect(requests.map(request => request.messages)).toEqual([original.messages, result.messages]);
  expect(await repo.head(groupId)).toBeNull();
});

it.each(['pending materialization', 'queued', 'accepted', 'different action'] as const)('handles equivalent feedback with original %s', async state => {
  const { createWorkflowFeedbackRepository } = await import('../../src/db/workflow-feedback');
  const runId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:groupId});
  await db.prepare("INSERT INTO publication_jobs (publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','workflow','x','x',1,1,?)").bind(runId,context).run();
  const attempt = {runId,generation:1,notificationCycle:1,groupId};
  const feedback = createWorkflowFeedbackRepository(db);
  const key = JSON.stringify(['publication',runId,1,1,'terminal']);
  expect(await feedback.commitOutcome({...attempt,kind:'publication'}, {stage:'prepare outputs',action:state === 'different action' ? 'retry' : 'verify',outcome:'unconfirmed',resultKey:key,references:{thaiDate:'19 พฤศจิกายน 2569',airtableRunUrl:`https://airtable.com/base/table/${runId}`,publicBaseUrl:'https://old.test'}})).toBe(true);
  const original = await db.prepare('SELECT * FROM workflow_feedback_results WHERE result_key=?').bind(key).first();
  const repo = createLineReplyRepository(db, fixedClock('2026-11-19T08:00:00Z'));
  const result = {schemaVersion:1,kind:'publication',runId,generation:1,notificationCycle:1,outcome:'unconfirmed',messages:[{type:'text',text:'verification'}]} as const;
  if (state === 'queued' || state === 'accepted') {
    await repo.enqueueResult({resultKey:key,groupId,result:{...result,messages:[{type:'text',text:'original'}]}});
    await feedback.markMaterialized(key,groupId);
    if (state === 'accepted') await db.prepare("UPDATE line_result_outbox SET state='accepted' WHERE result_key=?").bind(key).run();
  }
  const before = (await db.prepare('SELECT * FROM line_result_outbox WHERE group_id=?').bind(groupId).all()).results;
  const claim = await claimPublicationVerification(db,attempt);
  if (claim.status !== 'claimed') throw new Error('expected claim');
  const intent = {originWorkflowId:claim.originWorkflowId,contextJson:claim.contextJson,result:{...result,messages:[...result.messages]}};
  expect(await completePublicationVerification(db,attempt,'stale',intent)).toBe(false);
  expect(await completePublicationVerification(db,attempt,claim.verifierId,intent)).toBe(true);
  expect(await db.prepare('SELECT completed,result_json FROM publication_verification_claims WHERE publication_run_id=?').bind(runId).first()).toEqual({completed:1,result_json:JSON.stringify(intent.result)});
  const after = (await db.prepare('SELECT * FROM line_result_outbox WHERE group_id=? ORDER BY sequence').bind(groupId).all()).results;
  expect(after.slice(0,before.length)).toEqual(before);
  expect(after).toHaveLength(before.length);
  if (state === 'different action') expect(await feedback.pendingByGroup(groupId,10)).toHaveLength(2);
  const saved = await db.prepare('SELECT * FROM workflow_feedback_results WHERE result_key=?').bind(key).first();
  expect(saved).toEqual({...original,materialized:state === 'queued' || state === 'accepted' ? 1 : 0});
  if (state === 'pending materialization') {
    const clock = fixedClock('2026-11-19T08:00:00Z');
    const requests: unknown[] = [];
    const line = createLineClient({channelAccessToken:'x',fetch:async (_url,init) => { requests.push(JSON.parse(String(init?.body))); return Response.json({}); }});
    await deliverEventReply({eventId:crypto.randomUUID(),groupId,workflowId:'wf',receivedAt:clock.now().toISOString(),replyToken:'fresh',commandReply:null,drainQueue:true,publicBaseUrl:'https://new.test'}, {repo,line,clock,isGroupAllowed:async()=>true,feedback});
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests)).toContain('https://airtable.com/base/table/');
    expect(await feedback.pendingByGroup(groupId,10)).toHaveLength(0);
    expect((await db.prepare('SELECT result_key FROM line_result_outbox WHERE group_id=?').bind(groupId).all()).results).toEqual([{result_key:key}]);
  }
});

it('proves only the current tracked pre-document failure without conflicting facts', async () => {
  const { readPreGoogleFailure } = await import('../../src/db/publication-repository');
  const runId = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:'owner', settings:{config:{airtableBaseId:'base', airtablePublicationRunsTableId:'table'}}});
  await db.prepare("INSERT INTO publication_jobs (publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','workflow','x','x',1,1,?)").bind(runId,context).run();
  const attempt = {runId,generation:1,notificationCycle:1,groupId:'owner'};
  const claim = await claimPublicationVerification(db,attempt);
  if (claim.status !== 'claimed') throw new Error('expected claim');
  await db.prepare("INSERT INTO publication_google_write_evidence VALUES (?,1,1,'tracking',1)").bind(runId).run();
  await db.prepare("INSERT INTO workflow_feedback(kind,run_id,generation,notification_cycle,group_id,context_json,stage,failure_code) VALUES ('publication',?,1,1,'owner',?,'prepare outputs','anthropic_failed')").bind(runId,context).run();
  await db.prepare("INSERT INTO workflow_feedback_results(kind,run_id,generation,notification_cycle,revision,result_key,outcome_json,group_id) VALUES ('publication',?,1,1,0,?,?,'owner')").bind(runId,runId,JSON.stringify({stage:'prepare outputs',failureCode:'anthropic_failed',outcome:'unconfirmed'})).run();
  const read = () => readPreGoogleFailure(db,attempt,claim.verifierId);
  expect(await read()).toMatchObject({origin_workflow_id:'workflow',context_json:context,stage:'prepare outputs',failure_code:'anthropic_failed'});
  expect(await readPreGoogleFailure(db,{...attempt,groupId:'foreign'},claim.verifierId)).toBeNull();
  expect(await readPreGoogleFailure(db,attempt,'stale')).toBeNull();
  for (const [sql, value] of [
    ['UPDATE publication_google_write_evidence SET state=? WHERE publication_run_id=?','may_have_written'],
    ['UPDATE publication_jobs SET temp_doc_id=? WHERE publication_run_id=?','doc'],
    ['UPDATE publication_jobs SET finalization_json=? WHERE publication_run_id=?','{}'],
    ['UPDATE publication_jobs SET correlation_id=? WHERE publication_run_id=?','other'],
    ['UPDATE workflow_feedback SET failure_code=? WHERE run_id=?','other'],
  ] as const) {
    await db.prepare(sql).bind(value,runId).run();
    expect(await read()).toBeNull();
    const column = sql.match(/SET (\w+)=/)![1]!;
    const original = column === 'state' ? 'tracking' : column === 'correlation_id' ? 'workflow' : column === 'failure_code' ? 'anthropic_failed' : null;
    await db.prepare(sql).bind(original,runId).run();
  }
  await db.prepare('UPDATE publication_google_write_evidence SET protocol_version=NULL WHERE publication_run_id=?').bind(runId).run();
  expect(await read()).toBeNull();
});


it('holds attempt advancement until the current verifier completes', async () => {
  const runId = crypto.randomUUID(), clock = fixedClock('2026-11-19T08:00:00Z');
  const context = JSON.stringify({replyGroupId:'owner'});
  await db.prepare("INSERT INTO publication_jobs (publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'failed','workflow','x','x',1,1,?)").bind(runId,context).run();
  const attempt = {runId,generation:1,notificationCycle:1,groupId:'owner'};
  const claim = await claimPublicationVerification(db,attempt);
  if (claim.status !== 'claimed') throw new Error('expected claim');
  expect(await reopenFailedJobForRestart(db,clock,runId,'workflow')).toBe(false);
  const eventId = crypto.randomUUID();
  await db.prepare("INSERT INTO line_command_ingress VALUES (?, 'owner', '{\"type\":\"docs\"}', 'command', 'now')").bind(eventId).run();
  expect(await reopenFailedJobForRestart(db,clock,runId,'workflow',1,undefined,1,{id:eventId,groupId:'owner',action:'restart'})).toBe(false);
  expect(await db.prepare('SELECT event_id FROM publication_regeneration_events WHERE event_id=?').bind(eventId).first()).toBeNull();
  await db.prepare("UPDATE publication_jobs SET state='generating' WHERE publication_run_id=?").bind(runId).run();
  expect(await advanceUnconfirmedPublicationRestart(db,clock,runId,1,1)).toBe('contended');
  await db.prepare("UPDATE publication_jobs SET state='succeeded',successful_generation=1 WHERE publication_run_id=?").bind(runId).run();
  expect(await reopenSuccessfulJobForRegeneration(db,clock,runId,1)).toBeNull();
  await db.prepare("UPDATE publication_jobs SET state='failed' WHERE publication_run_id=?").bind(runId).run();
  expect(await completePublicationVerification(db,attempt,claim.verifierId)).toBe(true);
  expect(await reopenFailedJobForRestart(db,clock,runId,'workflow')).toBe(true);
});

it.each([false, true])('delivers a changed verification after its original, including held head=%s', async held => {
  const { createWorkflowFeedbackRepository } = await import('../../src/db/workflow-feedback');
  const runId=crypto.randomUUID(), groupId=crypto.randomUUID(), context=JSON.stringify({replyGroupId:groupId});
  await db.prepare("INSERT INTO publication_jobs (publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','workflow','x','x',1,1,?)").bind(runId,context).run();
  const attempt={runId,generation:1,notificationCycle:1,groupId}, feedback=createWorkflowFeedbackRepository(db);
  const key=JSON.stringify(['publication',runId,1,1,'terminal']);
  await feedback.commitOutcome({...attempt,kind:'publication'},{stage:'prepare outputs',failureCode:'anthropic_failed',action:'verify',outcome:'unconfirmed',resultKey:key,references:{thaiDate:'19 พฤศจิกายน 2569',airtableRunUrl:`https://airtable.com/base/table/${runId}`,publicBaseUrl:'https://old.test'}});
  await db.prepare("INSERT INTO publication_google_write_evidence VALUES (?,1,1,'tracking',1)").bind(runId).run();
  const claim=await claimPublicationVerification(db,attempt);
  if(claim.status!=='claimed') throw new Error('expected claim');
  const result={schemaVersion:1,kind:'publication',runId,generation:1,notificationCycle:1,outcome:'failed',messages:[{type:'text',text:'verified'}]} as const;
  const intent={originWorkflowId:claim.originWorkflowId,contextJson:claim.contextJson,result:{...result,messages:[...result.messages]}};
  expect(await completePublicationVerification(db,attempt,claim.verifierId,intent)).toBe(true);
  expect(await completePublicationVerification(db,attempt,claim.verifierId,intent)).toBe(false);
  expect(await feedback.pendingByGroup(groupId,10)).toHaveLength(2);
  const clock=fixedClock('2026-11-19T08:00:00Z'), repo=createLineReplyRepository(db,clock), requests:any[]=[];
  const line=createLineClient({channelAccessToken:'x',fetch:async (_url,init)=>{requests.push(JSON.parse(String(init?.body)));return Response.json({});}});
  const input={groupId,workflowId:'wf',receivedAt:clock.now().toISOString(),replyToken:'fresh',commandReply:null,drainQueue:true,publicBaseUrl:'https://new.test'};
  const deps={repo,line,clock,isGroupAllowed:async()=>true,feedback};
  if(held) {
    await repo.enqueueResult({resultKey:'held-'+runId,groupId,result:{...result,messages:[{type:'text',text:'held'}]}});
    await db.prepare("UPDATE line_result_outbox SET state='blocked' WHERE result_key=?").bind('held-'+runId).run();
    await deliverEventReply({...input,eventId:crypto.randomUUID()},deps);
    await deliverEventReply({...input,eventId:crypto.randomUUID()},deps);
    expect(requests).toHaveLength(0);
    await db.prepare("UPDATE line_result_outbox SET state='accepted' WHERE result_key=?").bind('held-'+runId).run();
  }
  for(let i=0;i<3;i++) await deliverEventReply({...input,eventId:crypto.randomUUID()},deps);
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[0])).toContain('https://airtable.com/base/table/');
  expect(JSON.stringify(requests[1])).toContain('ผลการตรวจสอบเปลี่ยนจากข้อความก่อนหน้า');
  expect(JSON.stringify(requests[1])).toContain('verified');
  expect((await db.prepare('SELECT result_key FROM line_result_outbox WHERE group_id=? AND result_key IN (?,?)').bind(groupId,key,`${key}:revision:1`).all()).results).toHaveLength(2);
});

it('reads only the current generation finalization intent under the active claim', async () => {
  const { readFinalizationCandidate } = await import('../../src/db/publication-repository');
  const runId = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:'owner',settings:{config:{airtableBaseId:'base',airtablePublicationRunsTableId:'table',googleDriveFolderId:'folder',googleTemplateDocId:'template'}}});
  const intent = {generation:2,publicationDate:'2026-11-20',thaiDate:'date',docId:'new',docUrl:'https://docs.google.com/document/d/new/edit',title:'title',productIds:['A-1'],generatedAt:'2026-11-20T00:00:00.000Z'};
  await db.prepare("INSERT INTO publication_jobs (publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json,google_doc_id,successful_generation,finalization_json) VALUES (?,'generating','workflow','x','x',2,3,?,'old',1,?)").bind(runId,context,JSON.stringify(intent)).run();
  const attempt = {runId,generation:2,notificationCycle:3,groupId:'owner'};
  const claim = await claimPublicationVerification(db,attempt);
  if (claim.status !== 'claimed') throw new Error('expected claim');
  const read = () => readFinalizationCandidate(db,attempt,claim.verifierId);
  expect(await read()).toEqual({origin_workflow_id:'workflow',context_json:context,intent});
  expect(await readFinalizationCandidate(db,attempt,'stale')).toBeNull();
  expect(await readFinalizationCandidate(db,{...attempt,groupId:'foreign'},claim.verifierId)).toBeNull();
  await db.prepare('UPDATE publication_jobs SET finalization_json=? WHERE publication_run_id=?').bind(JSON.stringify({...intent,generation:1,docId:'old'}),runId).run();
  expect(await read()).toBeNull();
  await db.prepare('UPDATE publication_jobs SET finalization_json=? WHERE publication_run_id=?').bind(JSON.stringify({...intent,docId:'old'}),runId).run();
  expect(await read()).toBeNull();
  await db.prepare('UPDATE publication_jobs SET finalization_json=NULL WHERE publication_run_id=?').bind(runId).run();
  expect(await read()).toBeNull();
});
