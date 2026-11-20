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

it('holds a lost upload reply and delivers its later result on a fresh same-group event',async()=>{
 const group='CtestGroup', id=crypto.randomUUID(), batches:any[]=[], handoffs:any[]=[], sends:any[]=[];
 const env={...testEnv(),...createTestEnv(),LINE_CHANNEL_SECRET:'secret',LINE_COMMAND_WORKFLOW:{createBatch:async(b:any[])=>{batches.push(...b);return [];},get:async()=>({status:async()=>({status:'running'})})},IMPORT_WORKFLOW:{createBatch:async(x:any[])=>{handoffs.push(...x);return [];},get:async()=>({status:async()=>({status:'running'})})}} as unknown as Env;
 await env.DB.prepare("INSERT OR IGNORE INTO sequences (name,next_value,bootstrapped_at) VALUES ('product_id',1,'now')").run();
 const step={do:async(_n:string,a:any,b?:any)=>(b??a)()} as unknown as WorkflowStep;
 const send=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{if(String(url).includes('/member/'))return Response.json({userId:'U1',displayName:'Tester'});if(!String(url).endsWith('/message/reply'))throw new Error('unexpected fetch: '+String(url));sends.push(JSON.parse(String(init?.body)));if(sends.length===1)throw new Error('accepted but response lost');return Response.json({});});
 const admit=async(eventId:string,text:string)=>{const body=JSON.stringify({events:[{type:'message',webhookEventId:eventId,replyToken:'token-'+eventId,source:{type:'group',groupId:group,userId:'U1'},message:{type:'text',id:'m-'+eventId,text}}]});expect((await handleLineRoute(new Request('https://app/line/webhook',{method:'POST',headers:{'x-line-signature':await sign(body,'secret')},body}),env,{} as ExecutionContext)).status).toBe(200);};
 const run=async(item:any)=>LineCommandWorkflow.prototype.run.call({env} as unknown as LineCommandWorkflow,{payload:item.params,instanceId:item.id} as any,step);
 try {
  await admit(id,'/upload');const first=batches[0];expect(await run(first)).toEqual({status:'uncertain'});
  await admit(id,'/upload');expect(await run(batches[1])).toEqual({status:'duplicate'});
  expect(handoffs).toHaveLength(1);expect(sends).toHaveLength(1);
  expect(await env.DB.prepare('SELECT phase FROM line_reply_dispatches WHERE event_id=?').bind(id).first()).toEqual({phase:'uncertain'});
  const repo=createLineReplyRepository(env.DB,{now:()=>new Date()});await repo.enqueueResult({groupId:group,resultKey:id,result:{schemaVersion:1,kind:'import',runId:id,generation:1,notificationCycle:1,outcome:'success',messages:[{type:'text',text:'final notice'}]}});
  await admit(crypto.randomUUID(),'hello');expect(await run(batches[2])).toEqual({status:'accepted'});expect(sends).toHaveLength(2);expect(sends[1].messages).toEqual([{type:'text',text:'final notice'}]);
 } finally {send.mockRestore();}
});

it('resumes a proven saved upload through signed ingress once without preparing again', async () => {
 const id=crypto.randomUUID(), batches:any[]=[], sends:any[]=[];
 const env={...testEnv(),...createTestEnv(),LINE_CHANNEL_SECRET:'secret',LINE_COMMAND_WORKFLOW:{createBatch:async(b:any[])=>{batches.push(...b);return [];},get:async()=>({status:async()=>({status:'running'})})}} as unknown as Env;
 const body=JSON.stringify({events:[{type:'message',webhookEventId:id,replyToken:'token',source:{type:'group',groupId:'CtestGroup',userId:'U1'},message:{type:'text',id:'m',text:'/upload'}}]});
 const response=await handleLineRoute(new Request('https://app/line/webhook',{method:'POST',headers:{'x-line-signature':await sign(body,'secret')},body}),env,{} as ExecutionContext);
 expect(response.status).toBe(200);
 const item=batches[0];
 const ingress=await env.DB.prepare('SELECT * FROM line_command_ingress WHERE event_id=?').bind(id).first<any>();
 const {createLineRepository}=await import('../../src/db/line-repository');
 const repo=createLineRepository(env.DB,{next:()=>crypto.randomUUID()},{now:()=>new Date()});
 await repo.saveEventReply(id,{kind:'text',text:'prepared'}, {groupId:ingress.group_id,operation:ingress.operation,workflowId:ingress.workflow_id,receivedAt:ingress.received_at});
 await repo.claimEvent(id,ingress.group_id);
 const step={do:async(_n:string,a:any,b?:any)=>(b??a)()} as unknown as WorkflowStep;
 const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{if(!String(url).endsWith('/message/reply'))throw new Error('business preparation repeated');sends.push(JSON.parse(String(init?.body)));return Response.json({});});
 const run=(payload:any=item.params)=>LineCommandWorkflow.prototype.run.call({env} as unknown as LineCommandWorkflow,{payload,instanceId:item.id} as any,step);
 try {
  expect(await run({...item.params,event:{...item.params.event,message:{...item.params.event.message,text:'/docs'}}})).toEqual({status:'duplicate'});
  const old='2020-01-01T00:00:00.000Z';
  await env.DB.prepare('UPDATE line_command_ingress SET received_at=? WHERE event_id=?').bind(old,id).run();
  expect(await run({...item.params,receivedAt:old})).toEqual({status:'ignored'});
  expect(sends).toHaveLength(0);
  await env.DB.prepare('UPDATE line_command_ingress SET received_at=? WHERE event_id=?').bind(ingress.received_at,id).run();
  expect(await run()).toEqual({status:'accepted'});
  expect(await run()).toEqual({status:'duplicate'});
  expect(sends).toHaveLength(1);expect(sends[0].messages).toEqual([{type:'text',text:'prepared'}]);
 } finally {fetcher.mockRestore();}
});

it('dispatches the saved same-group verification after the ordinary reply, and tolerates lookup failures', async () => {
 const group='CtestGroup', foreign='foreign-'+crypto.randomUUID(), runId=crypto.randomUUID(), albumId=crypto.randomUUID(), order:string[]=[];
 const context=JSON.stringify({replyGroupId:group});
 const workflow={get:vi.fn(async(id:string)=>({status:async()=>{order.push('lookup:'+id);if(id===`import-${runId}`)return {status:'errored'};throw new Error('instance.not_found');}})),create:vi.fn(async({id}:any)=>{order.push('create:'+id);})};
 const env={...testEnv(),...createTestEnv(),IMPORT_WORKFLOW:workflow} as unknown as Env;
 await env.DB.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json) VALUES(?,?,'line','running','x',?)").bind(runId,albumId,context).run();
 const {claimImportVerification}=await import('../../src/db/import-repository');
 await claimImportVerification(env.DB,{runId,albumId,workflowId:`import-${runId}`,groupId:group,contextJson:context});
 const repo=createLineReplyRepository(env.DB,{now:()=>new Date()});
 const step={do:async(_n:string,a:any,b?:any)=>(b??a)()} as unknown as WorkflowStep;
 const send=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{order.push('reply');return Response.json({});});
 const run=async(groupId:string)=>{const id=crypto.randomUUID();await repo.enqueueResult({groupId,resultKey:id,result:{schemaVersion:1,kind:'import',runId:id,generation:1,notificationCycle:1,outcome:'success',messages:[{type:'text',text:'notice'}]}});return LineCommandWorkflow.prototype.run.call({env} as unknown as LineCommandWorkflow,{payload:{event:{type:'message',webhookEventId:id,replyToken:'token',source:{type:'group',groupId,userId:'U1'},message:{type:'text',id:'m',text:'hello'}},receivedAt:new Date().toISOString()},instanceId:id} as any,step);};
 try {
  await run(foreign);expect(order).toEqual([]);
  await run(group);expect(order).toEqual(['reply',`lookup:import-${runId}`,`lookup:import-verification-${runId}`,`create:import-verification-${runId}`]);
  expect(workflow.create).toHaveBeenCalledOnce();
  workflow.get.mockRejectedValueOnce(new Error('outage'));order.length=0;
  await run(group);expect(order[0]).toBe('reply');expect(workflow.create).toHaveBeenCalledOnce();
 } finally {send.mockRestore();}
});

it('rotates pending imports and publication after repeated ordinary replies', async () => {
 const group='CtestGroup', context=JSON.stringify({replyGroupId:group}), ids=['a','b'].map(x=>x+crypto.randomUUID()), publicationId=crypto.randomUUID(), order:string[]=[];
 const workflow={get:vi.fn(async(id:string)=>({status:async()=>{order.push('lookup:'+id);return {status:'running'};}})),create:vi.fn()};
 const env={...testEnv(),...createTestEnv(),IMPORT_WORKFLOW:workflow,PUBLICATION_WORKFLOW:workflow} as unknown as Env;
 const {claimImportVerification}=await import('../../src/db/import-repository');
 const {claimPublicationVerification}=await import('../../src/db/publication-repository');
 for (const id of ids) {
  await env.DB.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json) VALUES(?,?,'line','running','x',?)").bind(id,id,context).run();
  await claimImportVerification(env.DB,{runId:id,albumId:id,workflowId:`import-${id}`,groupId:group,contextJson:context});
 }
 await env.DB.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES(?,'generating',?,'x','x',1,1,?)").bind(publicationId,`pub-${publicationId}`,context).run();
 await claimPublicationVerification(env.DB,{runId:publicationId,generation:1,notificationCycle:1,groupId:group});
 const repo=createLineReplyRepository(env.DB,{now:()=>new Date()});
 const step={do:async(_n:string,a:any,b?:any)=>(b??a)()} as unknown as WorkflowStep;
 const send=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{order.push('reply');return Response.json({});});
 try {
  for(let i=0;i<3;i++) {
   const id=crypto.randomUUID();
   await repo.enqueueResult({groupId:group,resultKey:id,result:{schemaVersion:1,kind:'import',runId:id,generation:1,notificationCycle:1,outcome:'success',messages:[{type:'text',text:'notice'}]}});
   await LineCommandWorkflow.prototype.run.call({env} as unknown as LineCommandWorkflow,{payload:{event:{type:'message',webhookEventId:id,replyToken:'token',source:{type:'group',groupId:group,userId:'U1'},message:{type:'text',id:'m',text:'hello'}},receivedAt:new Date().toISOString()},instanceId:id} as any,step);
  }
  expect(order.filter((_,i)=>i%2===0)).toEqual(['reply','reply','reply']);
  expect(order.filter((_,i)=>i%2===1).sort()).toEqual([`lookup:import-${ids[0]}`,`lookup:import-${ids[1]}`,`lookup:pub-${publicationId}`].sort());
  expect(workflow.create).not.toHaveBeenCalled();
 } finally {send.mockRestore();}
});
