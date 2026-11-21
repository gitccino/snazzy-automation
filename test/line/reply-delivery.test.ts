import type { LineReplyMessage } from '../../src/line/reply-types';
import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { fixedClock } from '../helpers/fakes';
import { createLineReplyRepository } from '../../src/db/line-reply-repository';
import { createLineClient } from '../../src/line/client';
import { deliverEventReply } from '../../src/line/reply-delivery';

async function fixture(status = 200, throwNetwork = false, storedMessages:LineReplyMessage[]=[{type:'text',text:'result'}]) {
 const clock=fixedClock('2026-11-19T08:00:00Z'); const groupId=crypto.randomUUID();
 const repo=createLineReplyRepository(testEnv().DB,clock); const requests:any[]=[];
 const line=createLineClient({channelAccessToken:'private',fetch:async(url,init)=>{requests.push({url,body:JSON.parse(String(init?.body))});if(throwNetwork)throw new Error('network');return Response.json({}, {status});}});
 await repo.enqueueResult({resultKey:groupId,groupId,result:{schemaVersion:1,kind:'import',runId:'run',generation:1,notificationCycle:1,outcome:'success',messages:storedMessages}});
 const input={eventId:crypto.randomUUID(),groupId,workflowId:'wf',receivedAt:clock.now().toISOString(),replyToken:'fresh',commandReply:null,drainQueue:true,publicBaseUrl:'https://app.test'};
 const deps={repo,line,clock,isGroupAllowed:async()=>true};
 return {repo,requests,input,deps,groupId};
}
it('combines command first and queued result in exactly one fresh reply',async()=>{
 const h=await fixture(); await deliverEventReply({...h.input,commandReply:{kind:'text',text:'command'}},h.deps);
 expect(h.requests).toEqual([{url:'https://api.line.me/v2/bot/message/reply',body:{replyToken:'fresh',messages:[{type:'text',text:'command'},{type:'text',text:'result'}]}}]);
 expect(await h.repo.head(h.groupId)).toBeNull();
 expect(await deliverEventReply(h.input,h.deps)).toBe('ignored'); expect(h.requests).toHaveLength(1);
});
it('racing events cannot dispatch the same head twice',async()=>{
 const h=await fixture();await Promise.all([deliverEventReply(h.input,h.deps),deliverEventReply({...h.input,eventId:crypto.randomUUID()},h.deps)]);
 expect(h.requests).toHaveLength(1);
});
it.each([429,400])('definite rejection %s retains result for fresh token',async(status)=>{
 const h=await fixture(status); if(status===400)h.deps.line=createLineClient({channelAccessToken:'x',fetch:async()=>Response.json({message:'Invalid reply token'},{status})});
 expect(await deliverEventReply(h.input,h.deps)).toBe('rejected');expect(await h.repo.head(h.groupId)).toMatchObject({state:'pending'});
 expect(await deliverEventReply(h.input,h.deps)).toBe('duplicate');
});
it('network uncertainty holds FIFO but leaves command replies available',async()=>{
 const h=await fixture(200,true);expect(await deliverEventReply(h.input,h.deps)).toBe('uncertain');
 expect(await h.repo.head(h.groupId)).toMatchObject({state:'uncertain'});
 await deliverEventReply({...h.input,eventId:crypto.randomUUID(),commandReply:{kind:'text',text:'normal'}},h.deps);
 expect(h.requests[1].body.messages).toEqual([{type:'text',text:'normal'}]);
});
it('expired, removed-group and postback-only events leave queued result untouched',async()=>{
 const h=await fixture();await deliverEventReply({...h.input,receivedAt:'2026-11-19T07:00:00Z'},h.deps);
 await deliverEventReply({...h.input,eventId:crypto.randomUUID()},{...h.deps,isGroupAllowed:async()=>false});
 await deliverEventReply({...h.input,eventId:crypto.randomUUID(),drainQueue:false},h.deps);
 expect(h.requests).toEqual([]);expect(await h.repo.head(h.groupId)).toMatchObject({state:'pending'});
});
it('full five-message command leaves indivisible result pending',async()=>{
 const h=await fixture();await deliverEventReply({...h.input,commandReply:{kind:'buttons',text:'x'.repeat(15001),approveData:'yes',rejectData:'no'}},h.deps);
 expect(h.requests[0].body.messages).toHaveLength(5);expect(await h.repo.head(h.groupId)).toMatchObject({state:'pending'});
});
it('receipt-write exhaustion never repeats LINE or releases dispatched evidence',async()=>{
 const h=await fixture();let attempts=0;
 const deps={...h.deps,repo:{...h.repo,accept:async()=>{attempts++;throw new Error('D1 unavailable');}}};
 await expect(deliverEventReply(h.input,deps)).rejects.toThrow('D1 unavailable');
 expect(attempts).toBe(3);expect(h.requests).toHaveLength(1);expect(await h.repo.head(h.groupId)).toMatchObject({state:'dispatched'});
 await deliverEventReply({...h.input,eventId:crypto.randomUUID()},h.deps);
 expect(h.requests).toHaveLength(1);
});
it('allowlist removal after reservation cancels only the unsent prepared reservation',async()=>{
 const h=await fixture();let checks=0;
 await deliverEventReply(h.input,{...h.deps,isGroupAllowed:async()=>++checks===1});
 expect(h.requests).toEqual([]);expect(await h.repo.head(h.groupId)).toMatchObject({state:'pending'});
});
it('delayed results retain original data when a later day supplies the reply token',async()=>{
 const h=await fixture();const tomorrow=fixedClock('2026-11-20T08:00:00Z');
 await deliverEventReply({...h.input,receivedAt:tomorrow.now().toISOString()},{...h.deps,clock:tomorrow});
 expect(h.requests[0].body.messages).toEqual([{type:'text',text:'result'}]);
});
it.each([400,503])('retains safe provider evidence for a %s reply response',async status=>{
 const h=await fixture();h.deps.line=createLineClient({channelAccessToken:'private',fetch:async()=>Response.json({message:'Invalid messages'},{status,headers:{'x-line-request-id':'line-evidence'}})});
 await deliverEventReply(h.input,h.deps);
 expect(await testEnv().DB.prepare('SELECT request_id,http_status,rejection_proven FROM line_reply_dispatches WHERE event_id=?').bind(h.input.eventId).first()).toEqual({request_id:'line-evidence',http_status:status,rejection_proven:status===400?1:0});
});

it('a command losing the reservation race replies once without stealing the reserved result',async()=>{
 const h=await fixture();let raced=false;
 const repo={...h.repo,prepareDispatch:async(input:Parameters<typeof h.repo.prepareDispatch>[0])=>{
  if(!raced && input.candidateSequence!==null) {
   raced=true;expect(await h.repo.prepareDispatch({...input,eventId:crypto.randomUUID(),workflowId:'other-owner',messages:[{type:'text',text:'result'}]})).toBe('prepared');
  }
  return h.repo.prepareDispatch(input);
 }};
 await deliverEventReply({...h.input,commandReply:{kind:'text',text:'normal command'}},{...h.deps,repo});
 expect(h.requests).toHaveLength(1);expect(h.requests[0].body.messages).toEqual([{type:'text',text:'normal command'}]);
 expect(await h.repo.head(h.groupId)).toMatchObject({state:'reserved'});
});
it('an actual delayed terminal card keeps its original date, destination and links after configuration changes',async()=>{
 const {docsWorkflowFailureCard}=await import('../../src/line/docs-summary-card');
 const card=docsWorkflowFailureCard({thaiDate:'19 พฤศจิกายน 2569',reason:'Original job failed',airtableRunUrl:'https://airtable.com/oldBase/oldTable/originalRun'},'https://original-worker.test');
 const h=await fixture(200,false,[{type:'flex',altText:card.text,contents:card.contents}]);
 const tomorrow=fixedClock('2026-11-20T08:00:00Z');
 await deliverEventReply({...h.input,receivedAt:tomorrow.now().toISOString(),publicBaseUrl:'https://new-worker.test'},{...h.deps,clock:tomorrow});
 expect(h.requests[0].body.messages).toEqual([{type:'flex',altText:card.text,contents:card.contents}]);
 expect(JSON.stringify(h.requests[0].body)).toContain('19 พฤศจิกายน 2569');
 expect(JSON.stringify(h.requests[0].body)).toContain('https://airtable.com/oldBase/oldTable/originalRun');
 expect(JSON.stringify(h.requests[0].body)).not.toContain('new-worker');
 expect(await testEnv().DB.prepare('SELECT group_id FROM line_reply_dispatches WHERE event_id=?').bind(h.input.eventId).first()).toEqual({group_id:h.groupId});
});

it('repairs a committed publication intent using its original display facts',async()=>{
 const db=testEnv().DB, groupId=crypto.randomUUID(), runId=crypto.randomUUID(), clock=fixedClock('2026-11-20T08:00:00Z');
 await db.prepare(`INSERT INTO publication_jobs(publication_run_id,publication_date,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,?,'generating',?,'x','x',2,1,?)`).bind(runId,'2026-11-19',runId,JSON.stringify({replyGroupId:groupId})).run();
 const {createWorkflowFeedbackRepository}=await import('../../src/db/workflow-feedback');
 const feedback=createWorkflowFeedbackRepository(db), resultKey=crypto.randomUUID();
 await feedback.commitOutcome({kind:'publication',runId,generation:2,notificationCycle:1,groupId},{stage:'prepare outputs',action:'verify',outcome:'unconfirmed',resultKey,references:{thaiDate:'19 พฤศจิกายน 2569',airtableRunUrl:`https://airtable.com/oldBase/oldTable/${runId}`,publicBaseUrl:'https://old-worker.test'}});
 const requests:any[]=[]; const repo=createLineReplyRepository(db,clock);
 const line=createLineClient({channelAccessToken:'x',fetch:async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return Response.json({});}});
 const input={eventId:crypto.randomUUID(),groupId,workflowId:'wf',receivedAt:clock.now().toISOString(),replyToken:'fresh',commandReply:null,drainQueue:true,publicBaseUrl:'https://new-worker.test'};
 const deps={repo,line,clock,isGroupAllowed:async()=>true,feedback};
 await deliverEventReply(input,deps);
 await deliverEventReply({...input,eventId:crypto.randomUUID()},deps);
 expect(requests).toHaveLength(1); expect(JSON.stringify(requests)).toContain(`https://airtable.com/oldBase/oldTable/${runId}`); expect(JSON.stringify(requests)).toContain('19 พฤศจิกายน 2569');
 expect(await feedback.pendingByGroup(groupId,10)).toHaveLength(0);
 expect(await db.prepare('SELECT group_id FROM line_reply_dispatches WHERE event_id=?').bind(input.eventId).first()).toEqual({group_id:groupId});
});

it('delivers bounded text when a saved publication card cannot render, only to its group and only once',async()=>{
 const db=testEnv().DB, groupId=crypto.randomUUID(), runId=crypto.randomUUID(), clock=fixedClock('2026-11-20T08:00:00Z');
 await db.prepare(`INSERT INTO publication_jobs(publication_run_id,publication_date,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,?,'generating',?,'x','x',2,1,?)`).bind(runId,runId,runId,JSON.stringify({replyGroupId:groupId})).run();
 const {createWorkflowFeedbackRepository}=await import('../../src/db/workflow-feedback');
 const feedback=createWorkflowFeedbackRepository(db), key=JSON.stringify(['publication',runId,2,1,'terminal']);
 await feedback.commitOutcome({kind:'publication',runId,generation:2,notificationCycle:1,groupId},{stage:'prepare',action:'verify',outcome:'unconfirmed',resultKey:key,references:{thaiDate:'วันที่'.repeat(2000),airtableRunUrl:`https://airtable.com/base/table/${runId}`,publicBaseUrl:'invalid url'}});
 const requests:LineReplyMessage[][]=[], repo=createLineReplyRepository(db,clock);
 const input={eventId:crypto.randomUUID(),groupId,workflowId:'wf',receivedAt:clock.now().toISOString(),replyToken:'fresh',commandReply:{kind:'text' as const,text:'command'},drainQueue:true,publicBaseUrl:'https://new.test'};
 const deps={repo,feedback,clock,isGroupAllowed:async()=>true,line:{sendReplyMessages:async (_token:string,messages:LineReplyMessage[])=>{requests.push(messages);return {requestId:null};}}};
 await deliverEventReply({...input,groupId:crypto.randomUUID()},deps);
 expect(requests[0]).toEqual([{type:'text',text:'command'}]);
 expect(await deliverEventReply({...input,eventId:crypto.randomUUID()},deps)).toBe('accepted');
 const notice=requests[1]![1]!;
 expect(notice.type).toBe('text'); expect(String(notice.text).length).toBeLessThanOrEqual(5000);
 expect(notice.text).toContain('ยังยืนยัน'); expect(notice.text).toContain(runId);
 await deliverEventReply({...input,eventId:crypto.randomUUID(),commandReply:null},deps);
 expect(requests).toHaveLength(2);
 expect((await db.prepare('SELECT sequence,state FROM line_result_outbox WHERE result_key=?').bind(key).all()).results).toHaveLength(1);
 expect(await feedback.pendingByGroup(groupId,10)).toHaveLength(0);
});

it('keeps a command reply available when intent repair fails',async()=>{
 const h=await fixture();
 const feedback={pendingByGroup:async()=>{throw new Error('repair failed');}} as unknown as ReturnType<typeof import('../../src/db/workflow-feedback').createWorkflowFeedbackRepository>;
 await deliverEventReply({...h.input,commandReply:{kind:'text',text:'command'}},{...h.deps,feedback});
 expect(h.requests[0].body.messages[0]).toEqual({type:'text',text:'command'});
});

it.each(['confirmed_acceptance', 'close_unverifiable'] as const)('owner %s advances FIFO and a late receipt never resends', async decision => {
 const h = await fixture(200, true);
 await h.repo.enqueueResult({resultKey:h.groupId+'-next',groupId:h.groupId,result:{schemaVersion:1,kind:'import',runId:'next',generation:1,notificationCycle:1,outcome:'success',messages:[{type:'text',text:'next'}]}});
 expect(await deliverEventReply(h.input,h.deps)).toBe('uncertain');
 const sequence=(await h.repo.head(h.groupId))!.sequence;
 expect(await h.repo.recordOwnerDisposition({eventId:h.input.eventId,groupId:h.groupId,sequence,decision,actor:'owner',reason:'reviewed'})).toBe(true);
 await h.repo.accept(h.input.eventId,'late-receipt');
 const requests: LineReplyMessage[][]=[];
 const deps={...h.deps,line:{sendReplyMessages:async (_token:string,messages:LineReplyMessage[])=>{requests.push(messages);return {requestId:'next-receipt'};}}};
 expect(await deliverEventReply({...h.input,eventId:crypto.randomUUID()},deps)).toBe('accepted');
 expect(requests).toEqual([[{type:'text',text:'next'}]]);
 expect(await h.repo.head(h.groupId)).toBeNull();
 expect(await deliverEventReply(h.input,deps)).toBe('ignored');
 expect(requests).toHaveLength(1);
});

it('keeps a malformed queue head in place while sending the ordinary command', async () => {
 const h=await fixture();
 await testEnv().DB.prepare('UPDATE line_result_outbox SET result_json=? WHERE group_id=?').bind('{',h.groupId).run();
 expect(await deliverEventReply({...h.input,commandReply:{kind:'text',text:'command'}},h.deps)).toBe('accepted');
 expect(h.requests[0].body.messages).toEqual([{type:'text',text:'command'}]);
 expect(await testEnv().DB.prepare('SELECT state FROM line_result_outbox WHERE group_id=?').bind(h.groupId).first()).toEqual({state:'pending'});
});

it.each(['unsent','rejected'])('repairs a %s malformed publication head in place and does not duplicate on replay',async history=>{
 const db=testEnv().DB, groupId=crypto.randomUUID(), runId=crypto.randomUUID(), clock=fixedClock('2026-11-20T08:00:00Z');
 await db.prepare(`INSERT INTO publication_jobs(publication_run_id,publication_date,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,?,'generating',?,'x','x',2,1,?)`).bind(runId,runId,runId,JSON.stringify({replyGroupId:groupId})).run();
 const {createWorkflowFeedbackRepository}=await import('../../src/db/workflow-feedback');
 const feedback=createWorkflowFeedbackRepository(db), key=JSON.stringify(['publication',runId,2,1,'terminal']);
 await feedback.commitOutcome({kind:'publication',runId,generation:2,notificationCycle:1,groupId},{stage:'prepare',action:'verify',outcome:'unconfirmed',resultKey:key,references:{thaiDate:'19 พฤศจิกายน 2569',airtableRunUrl:`https://airtable.com/base/table/${runId}`,publicBaseUrl:'https://old.test'}});
 await db.prepare('INSERT INTO line_result_outbox(result_key,group_id,result_json,created_at) VALUES (?,?,?,?)').bind(key,groupId,'{','x').run();
 await feedback.markMaterialized(key,groupId);
 const before=await db.prepare('SELECT sequence,group_id FROM line_result_outbox WHERE result_key=?').bind(key).first();
 const sequence=(before as {sequence:number}).sequence, evidence=crypto.randomUUID();
 await db.prepare("INSERT INTO line_reply_dispatches(event_id,group_id,workflow_id,received_at,candidate_sequence,messages_json,phase,updated_at) VALUES (?,?,'wf','x',?,'[]','rejected','x')").bind(evidence,groupId,sequence).run();
 await feedback.replaceUnsentHead(groupId,sequence,'{',{bad:'replacement'});
 expect(await db.prepare('SELECT result_json FROM line_result_outbox WHERE sequence=?').bind(sequence).first('result_json')).toBe('{');
 if(history==='unsent') await db.prepare('DELETE FROM line_reply_dispatches WHERE event_id=?').bind(evidence).run();
 else await db.prepare("UPDATE line_reply_dispatches SET rejection_proven=1,http_status=400,disposition='blocked_payload',request_id='original-receipt' WHERE event_id=?").bind(evidence).run();
 const requests:LineReplyMessage[][]=[], repo=createLineReplyRepository(db,clock);
 const input={eventId:crypto.randomUUID(),groupId,workflowId:'wf',receivedAt:clock.now().toISOString(),replyToken:'fresh',commandReply:null,drainQueue:true,publicBaseUrl:'https://new.test'};
 const deps={repo,feedback,clock,isGroupAllowed:async()=>true,line:{sendReplyMessages:async (_token:string,messages:LineReplyMessage[])=>{requests.push(messages);return {requestId:null};}}};
 expect(await deliverEventReply(input,deps)).toBe('accepted');
 await deliverEventReply({...input,eventId:crypto.randomUUID()},deps);
 expect(requests).toHaveLength(1);
 if(history==='rejected') expect(await db.prepare('SELECT phase,request_id FROM line_reply_dispatches WHERE event_id=?').bind(evidence).first()).toEqual({phase:'rejected',request_id:'original-receipt'});
 expect(JSON.stringify(requests)).toContain(`https://airtable.com/base/table/${runId}`);
 expect((await db.prepare('SELECT sequence,group_id FROM line_result_outbox WHERE result_key=?').bind(key).all()).results).toEqual([before]);
});

it('repairs only a head with exclusively proven rejected dispatches', async () => {
 const db=testEnv().DB, groupId=crypto.randomUUID(), key=crypto.randomUUID();
 await db.prepare("INSERT INTO line_result_outbox(result_key,group_id,result_json,created_at) VALUES (?,?,'{','x')").bind(key,groupId).run();
 const sequence=await db.prepare('SELECT sequence FROM line_result_outbox WHERE result_key=?').bind(key).first<number>('sequence');
 const {createWorkflowFeedbackRepository}=await import('../../src/db/workflow-feedback');
 const feedback=createWorkflowFeedbackRepository(db), event=crypto.randomUUID();
 await db.prepare("INSERT INTO line_reply_dispatches(event_id,group_id,workflow_id,received_at,candidate_sequence,messages_json,phase,updated_at,http_status,disposition,rejection_proven) VALUES (?,?,'wf','x',?,'[]','rejected','x',400,'blocked_payload',1)").bind(event,groupId,sequence).run();
 await feedback.replaceRejectedHead(groupId,sequence!,'{',{fixed:true});
 expect(await db.prepare('SELECT result_json FROM line_result_outbox WHERE sequence=?').bind(sequence).first('result_json')).toBe('{"fixed":true}');
 await db.prepare("UPDATE line_result_outbox SET result_json='{' WHERE sequence=?").bind(sequence).run();
 for(const phase of ['uncertain','accepted','prepared','dispatched','rejected']) {
  const mixed=crypto.randomUUID();
  await db.prepare("INSERT INTO line_reply_dispatches(event_id,group_id,workflow_id,received_at,candidate_sequence,messages_json,phase,updated_at) VALUES (?,?,'wf','x',?,'[]',?,'x')").bind(mixed,groupId,sequence,phase).run();
  await feedback.replaceRejectedHead(groupId,sequence!,'{',{fixed:true});
  expect(await db.prepare('SELECT result_json FROM line_result_outbox WHERE sequence=?').bind(sequence).first('result_json')).toBe('{');
  await db.prepare('DELETE FROM line_reply_dispatches WHERE event_id=?').bind(mixed).run();
 }
 await db.prepare("INSERT INTO line_reply_owner_dispositions(event_id,sequence,group_id,decision,actor,reason,created_at) VALUES (?,?,?,'close_unverifiable','owner','reviewed','x')").bind(event,sequence,groupId).run();
 await feedback.replaceRejectedHead(groupId,sequence!,'{',{fixed:true});
 expect(await db.prepare('SELECT result_json FROM line_result_outbox WHERE sequence=?').bind(sequence).first('result_json')).toBe('{');
});
