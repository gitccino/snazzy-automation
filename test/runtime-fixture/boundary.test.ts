import { env, introspectWorkflowInstance } from 'cloudflare:test';
import { expect, it } from 'vitest';

it.each([[401,1,'anthropic_auth_failed'],[429,6,'anthropic_count_tokens_failed']] as const)('preserves safe failure and retry count for Claude %i', async (status, attempts, code) => {
  const bindings = env as unknown as {DB:D1Database; BOUNDARY_WORKFLOW:Workflow};
  const runId=crypto.randomUUID(), groupId=crypto.randomUUID(), workflowId=`publication-${runId}`;
  await bindings.DB.prepare('CREATE TABLE IF NOT EXISTS boundary_attempts(run_id TEXT)').run();
  await bindings.DB.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating',?,'x','x',1,1,?)").bind(runId,workflowId,JSON.stringify({replyGroupId:groupId})).run();
  const product={airtableRecordId:'rec-product',productId:'A-1001',brandName:'Nike',modelName:'Air',conditionType:'Used',size:'42',description:'test',lineSquarePrice:1,igPrice:1,attachments:[0,1,2,3].map(i=>({id:`a${i}`,filename:`${i}.jpg`}))};
  await using instance=await introspectWorkflowInstance(bindings.BOUNDARY_WORKFLOW,workflowId);
  await instance.modify(async m=>{
    await m.disableRetryDelays();
    await m.mockStepResult({name:'recover finalization'},null);
    await m.mockStepResult({name:'validate publication'},{kind:'valid',value:{run:{airtableRunId:runId,publicationDate:'2026-09-02',status:'Ready',products:[product]},thaiDate:'2 กันยายน 2569'}});

  });
  await bindings.BOUNDARY_WORKFLOW.create({id:workflowId,params:{runId,groupId,status}});
  await instance.waitForStatus('errored');
  expect((await bindings.DB.prepare('SELECT count(*) AS count FROM boundary_attempts WHERE run_id=?').bind(runId).first<{count:number}>())?.count).toBe(attempts);
  expect((await bindings.DB.prepare('SELECT failure_code FROM workflow_feedback WHERE run_id=?').bind(runId).first<{failure_code:string}>())?.failure_code).toBe(code);
  const result=await bindings.DB.prepare('SELECT result_json FROM line_result_outbox WHERE group_id=?').bind(groupId).first<{result_json:string}>();
  expect(result?.result_json).toContain(status===401?'เชื่อมต่อ Claude':'คำบรรยาย');
});


it.each(['google','image'] as const)('preserves permanent %s failure in the real runtime', async mode => {
  const bindings = env as unknown as {DB:D1Database; BOUNDARY_WORKFLOW:Workflow};
  const runId=crypto.randomUUID(), groupId=crypto.randomUUID(), workflowId=`publication-${runId}`;
  await bindings.DB.prepare('CREATE TABLE IF NOT EXISTS boundary_attempts(run_id TEXT)').run();
  await bindings.DB.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating',?,'x','x',1,1,?)").bind(runId,workflowId,JSON.stringify({replyGroupId:groupId})).run();
  const product={airtableRecordId:'rec-product',productId:'A-1001',brandName:'Nike',modelName:'Air',conditionType:'Used',size:'42',description:'test',lineSquarePrice:1,igPrice:1,attachments:[0,1,2,3].map(i=>({id:`a${i}`,filename:`${i}.jpg`}))};
  const validated={run:{airtableRunId:runId,publicationDate:'2026-09-02',status:'Ready',products:[product]},thaiDate:'2 กันยายน 2569'};
  await using instance=await introspectWorkflowInstance(bindings.BOUNDARY_WORKFLOW,workflowId);
  await instance.modify(async m=>{
    await m.disableRetryDelays();
    await m.mockStepResult({name:'recover finalization'},null);
    await m.mockStepResult({name:'validate publication'},{kind:'valid',value:validated});
    if (mode === 'google') await m.mockStepResult({name:'prepare outputs'},{...validated,outputs:[]});
  });
  await bindings.BOUNDARY_WORKFLOW.create({id:workflowId,params:{runId,groupId,status:401,mode}});
  await instance.waitForStatus('errored');
  expect((await bindings.DB.prepare('SELECT count(*) AS count FROM boundary_attempts WHERE run_id=?').bind(runId).first<{count:number}>())?.count).toBe(1);
  const result=await bindings.DB.prepare('SELECT result_json FROM line_result_outbox WHERE group_id=?').bind(groupId).first<{result_json:string}>();
  expect(result?.result_json).toContain(mode === 'google' ? 'Google' : 'A-1001');
  expect(result?.result_json).not.toContain('private');
  const feedback=await bindings.DB.prepare('SELECT failure_code FROM workflow_feedback WHERE run_id=?').bind(runId).first<{failure_code:string}>();
  expect(feedback?.failure_code).toBe(mode === 'google' ? 'google_auth_failed' : 'product_image_source_changed');
});
