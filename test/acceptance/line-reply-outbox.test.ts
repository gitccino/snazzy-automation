import { expect,it,vi } from 'vitest';
import type { WorkflowStep } from 'cloudflare:workers';
import { testEnv,createTestEnv } from '../helpers/env';
import { createLineReplyRepository } from '../../src/db/line-reply-repository';
import { handleLineRoute } from '../../src/routes/line';
import { LineCommandWorkflow } from '../../src/line/command-workflow';
import type { Env } from '../../src/env';

async function sign(body:string,secret:string) {
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body)))));
}
it('signed same-group messages drain durable FIFO across new workflow instances without persisting conversation',async()=>{
 const group='Coutbox-'+crypto.randomUUID(); const other='Cother-'+crypto.randomUUID();
 const config=JSON.parse(createTestEnv().APP_CONFIG_JSON);config.LINE_ALLOWED_GROUP_ID=group;
 const captured:any[]=[]; const batches:any[]=[];
 const env={...testEnv(),...createTestEnv(),APP_CONFIG_JSON:JSON.stringify(config),LINE_CHANNEL_SECRET:'secret',LINE_COMMAND_WORKFLOW:{createBatch:async(batch:any[])=>{batches.push(...batch);return [];}}} as unknown as Env;
 const outbox=createLineReplyRepository(env.DB,{now:()=>new Date()});
 const enqueue=async(id:string)=>outbox.enqueueResult({groupId:group,resultKey:id,result:{schemaVersion:1,kind:'import',runId:id,generation:1,notificationCycle:1,outcome:'success',messages:[{type:'text',text:id}]}});
 await enqueue('old-'+group); await enqueue('new-'+group);
 const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
   captured.push({url:String(url),body:JSON.parse(String(init?.body)),headers:new Headers(init?.headers)});return Response.json({},{headers:{'x-line-request-id':'receipt'}});
 });
 const step={do:async(_name:string,optionsOrCallback:any,callback?:any)=>(callback??optionsOrCallback)()} as unknown as WorkflowStep;
 async function admit(id:string,groupId=group,message:any={type:'text',id:'private-message-id',text:'private conversation'}) {
   const body=JSON.stringify({events:[{type:'message',webhookEventId:id,replyToken:'fresh-'+id,source:{type:'group',groupId,userId:'another-user'},message}]});
   expect((await handleLineRoute(new Request('https://app/line/webhook',{method:'POST',headers:{'x-line-signature':await sign(body,env.LINE_CHANNEL_SECRET)},body}),env,{waitUntil(){}} as unknown as ExecutionContext)).status).toBe(200);
 }
 try {
   await admit('other',other); await admit('first');await admit('second',group,{type:'sticker',id:'secret-media',packageId:'secret'});
   expect(JSON.stringify(batches)).not.toContain('private conversation');expect(JSON.stringify(batches)).not.toContain('secret-media');
   for(const item of batches)await LineCommandWorkflow.prototype.run.call({env} as unknown as LineCommandWorkflow,{payload:item.params,instanceId:item.id} as any,step);
   expect(captured.map(r=>r.body.messages)).toEqual([[{type:'text',text:'old-'+group}],[{type:'text',text:'new-'+group}]]);
   expect(captured.every(r=>r.url.endsWith('/message/reply')&&!r.headers.has('x-line-retry-key'))).toBe(true);
   const first=batches[0];await LineCommandWorkflow.prototype.run.call({env} as unknown as LineCommandWorkflow,{payload:first.params,instanceId:first.id} as any,step);
   expect(captured).toHaveLength(2);expect(await outbox.head(group)).toBeNull();
 } finally {fetcher.mockRestore();}
});
it('suppresses historical saved-reply-only redelivery before repeating business preparation',async()=>{
 const {createLineRepository}=await import('../../src/db/line-repository');
 const env={...testEnv(),...createTestEnv()} as Env;
 const id=crypto.randomUUID(); const repo=createLineRepository(env.DB,{next:()=>crypto.randomUUID()},{now:()=>new Date()});
 await repo.saveEventReply(id,{kind:'text',text:'historical push may already be accepted'});
 const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('business or LINE must not be called'));
 const step={do:async(_name:string,optionsOrCallback:any,callback?:any)=>(callback??optionsOrCallback)()} as unknown as WorkflowStep;
 try {
  const result=await LineCommandWorkflow.prototype.run.call({env} as unknown as LineCommandWorkflow,{payload:{event:{type:'message',webhookEventId:id,replyToken:'new',source:{type:'group',groupId:'CtestGroup',userId:'U1'},message:{type:'text',id:'m',text:'/upload'}},receivedAt:new Date().toISOString()},instanceId:id} as any,step);
  expect(fetcher).not.toHaveBeenCalled();expect(result).toEqual({status:'duplicate'});
 } finally {fetcher.mockRestore();}
});
