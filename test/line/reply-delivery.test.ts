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
 expect(await testEnv().DB.prepare('SELECT request_id,http_status FROM line_reply_dispatches WHERE event_id=?').bind(h.input.eventId).first()).toEqual({request_id:'line-evidence',http_status:status});
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
