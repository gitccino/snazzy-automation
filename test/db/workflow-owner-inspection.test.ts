import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { inspectWorkflowOwner } from '../../src/db/workflow-owner-inspection';

it('inspects exact owned group-less imports and publication attempts without exposing context', async () => {
  const db = testEnv().DB, suffix = crypto.randomUUID(), run = `run_${suffix}`, pub = `pub_${suffix}`, owner = `owner_${suffix}`;
  const context = JSON.stringify({replyGroupId:owner,settings:{config:{airtableBaseId:'base',airtableProductsTableId:'products',airtablePublicationRunsTableId:'runs',googleDriveFolderId:'folder',googleTemplateDocId:'template',token:'secret'}}});
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json,failure_reason) VALUES(?,'album','line','start_failed','2026-11-20T00:00:00Z',?,'unsafe secret text')").bind(run,context).run();
  await db.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,settings_context_json,generation,notification_cycle,attempt_count,temp_doc_id) VALUES(?,'failed','workflow','now','now',?,2,3,4,'doc')").bind(pub,context).run();
  await db.prepare("INSERT INTO workflow_feedback(kind,run_id,generation,notification_cycle,group_id,context_json,stage,failure_code) VALUES('publication',?,2,3,?,?,'cleanup','original_failure')").bind(pub,owner,context).run();
  await db.prepare("INSERT INTO publication_cleanup_intents(publication_run_id,generation,notification_cycle,origin_workflow_id,context_json,doc_id,saved_temp_doc,dispatch_verifier_id,deletion_acknowledged) VALUES(?,2,3,'workflow',?,'doc',1,'verifier',1)").bind(pub,context).run();
  const snapshot = async () => Promise.all(['import_runs','publication_jobs','workflow_feedback','workflow_feedback_results','publication_cleanup_intents','line_result_outbox','line_reply_dispatches'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().then(r => r.results)));
  const before = await snapshot();
  const importInput = {kind:'import' as const,runId:run,ownerGroupId:owner,baseId:'base',tableId:'products'};
  const pubInput = {kind:'publication' as const,runId:pub,ownerGroupId:owner,baseId:'base',tableId:'runs',generation:2,notificationCycle:3};
  expect(await inspectWorkflowOwner(db,importInput)).toMatchObject({runId:run, ownerGroupId:owner, execution:{state:'start_failed'}, runFailure:null, externalLiveness:'unknown'});
  const result = await inspectWorkflowOwner(db,pubInput);
  expect(result).toMatchObject({runId:pub, ownerGroupId:owner, execution:{state:'failed',attemptCount:4,generation:2,notificationCycle:3}, feedback:{failureCode:'original_failure'}, cleanup:{docId:'doc',savedTempDoc:true,dispatchVerifierId:'verifier',deletionAcknowledged:true}});
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(await inspectWorkflowOwner(db,{...pubInput,ownerGroupId:'foreign'})).toBeNull();
  expect(await inspectWorkflowOwner(db,{...pubInput,tableId:'wrong'})).toBeNull();
  expect(await inspectWorkflowOwner(db,{...pubInput,notificationCycle:2})).toBeNull();
  expect(await snapshot()).toEqual(before);
  await db.prepare('UPDATE publication_jobs SET settings_context_json=? WHERE publication_run_id=?').bind('{',pub).run();
  expect(await inspectWorkflowOwner(db,pubInput)).toBeNull();
});

it('holds unowned legacy data and reports historical evidence without attributing current state', async () => {
  const db = testEnv().DB, id = `history_${crypto.randomUUID()}`, owner = `owner_${crypto.randomUUID()}`;
  const context = JSON.stringify({replyGroupId:owner,settings:{config:{airtableBaseId:'base',airtablePublicationRunsTableId:'runs',googleDriveFolderId:'https://private/?token=secret'}}});
  await db.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,settings_context_json,generation,notification_cycle) VALUES(?,'generating','new_workflow','now','now',NULL,2,1)").bind(id).run();
  const input = {kind:'publication' as const,runId:id,ownerGroupId:owner,baseId:'base',tableId:'runs',generation:1,notificationCycle:1};
  expect(await inspectWorkflowOwner(db,input)).toBeNull();
  await db.prepare("INSERT INTO workflow_feedback(kind,run_id,generation,notification_cycle,group_id,context_json,stage,failure_code) VALUES('publication',?,1,1,?,?,'failed','https://private/secret')").bind(id,owner,context).run();
  await db.prepare("INSERT INTO line_result_outbox(result_key,group_id,result_json,created_at,state) VALUES(?,?,'{\"secret\":true}','now','uncertain')").bind(`key_${id}`,owner).run();
  const result = await inspectWorkflowOwner(db,input);
  expect(result).toMatchObject({execution:{state:null,workflowId:null,generation:1,notificationCycle:1},feedback:{stage:'failed',failureCode:null},target:{driveFolderId:null},queueHead:{state:'uncertain'}});
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(await inspectWorkflowOwner(db,{...input,ownerGroupId:'foreign'})).toBeNull();
  expect(await inspectWorkflowOwner(db,{...input,generation:0})).toBeNull();
});
