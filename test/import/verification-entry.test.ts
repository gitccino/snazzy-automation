import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { claimImportVerification } from '../../src/db/import-repository';
import { importWorkflowId } from '../../src/shared/ids';
import { ImportWorkflow } from '../../src/import/workflow';

it('reads only the claimed verifier evidence without starting an import', async () => {
  const env = testEnv(), runId = crypto.randomUUID(), albumId = crypto.randomUUID();
  const contextJson = JSON.stringify({replyGroupId:'owner'});
  await env.DB.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json,scan_evidence_json) VALUES(?,?,'line','running','now',?,'[]')").bind(runId, albumId, contextJson).run();
  expect(await claimImportVerification(env.DB, {runId, albumId, workflowId:importWorkflowId(runId), groupId:'owner', contextJson})).toBe(true);
  (env as any).IMPORT_WORKFLOW = {get: async () => ({status: async () => ({status:'errored'})})};
  const step = {do: async (_name: string, callback: () => Promise<unknown>) => callback()};
  const run = (instanceId: string) => ImportWorkflow.prototype.run.call({env} as any, {instanceId, payload:{kind:'verification', importRunId:runId}} as any, step as any);
  expect(await run(`import-verification-${runId}`)).toMatchObject({kind:'verification', evidence:{sourceAlbumId:albumId, scan:'complete', candidates:[]}});
  expect(await run('foreign')).toEqual({kind:'verification', evidence:null});
  await env.DB.prepare("UPDATE import_runs SET settings_context_json=? WHERE id=?").bind(JSON.stringify({replyGroupId:'owner', changed:true}), runId).run();
  expect(await run(`import-verification-${runId}`)).toEqual({kind:'verification', evidence:null});
});

it.each(['match', 'mismatch', 'error', 'ownership'])('verifies captured rows safely: %s', async (scenario) => {
  const {computeGroupHash} = await import('../../src/import/grouping');
  const env = testEnv(), db = env.DB, runId = crypto.randomUUID(), album = crypto.randomUUID(), group = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:'owner', settings:{config:{airtableBaseId:'base-old', airtableProductsTableId:'table-old'}}});
  const hash = await computeGroupHash(album, [{applePhotoId:'a'}]);
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json,scan_evidence_json) VALUES(?,?,'line','running','now',?,'[]')").bind(runId,album,context).run();
  await db.prepare("INSERT INTO product_groups(id,import_run_id,ordinal,group_hash,state,product_id,airtable_record_id,first_photo_id,last_photo_id,created_at,updated_at) VALUES(?,?,0,?,'importing',?,'rec','a','a','2026-09-01T00:00:00Z','now')").bind(group,runId,hash,scenario).run();
  await db.prepare("INSERT INTO airtable_create_claims VALUES(?,?,'base-old','table-old')").bind(group,scenario).run();
  await db.prepare("INSERT INTO product_group_image_members VALUES(?,0,'a','key-a')").bind(group).run();
  await claimImportVerification(db,{runId,albumId:album,workflowId:importWorkflowId(runId),groupId:'owner',contextJson:context});
  (env as any).IMPORT_WORKFLOW = {get: async () => ({status: async () => ({status:'errored'})})};
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => { calls.push(String(input)); if (scenario === 'ownership') await db.prepare("UPDATE import_runs SET settings_context_json='{}' WHERE id=?").bind(runId).run(); if (scenario === 'error') return new Response('', {status:503}); return Response.json({fields:{'Product ID':scenario === 'mismatch' ? 'other' : scenario,'System Group ID':hash,'Upload Date':'2026-09-01','Product Images':[{url:'https://example.com/a'}]}}); }) as typeof fetch;
  try {
    const step = {do: async (_name: string, callback: () => Promise<unknown>) => callback()};
    await ImportWorkflow.prototype.run.call({env} as any,{instanceId:`import-verification-${runId}`,payload:{kind:'verification',importRunId:runId}} as any,step as any);
    expect(calls).toEqual(['https://api.airtable.com/v0/base-old/table-old/rec']);
    const claim = await db.prepare('SELECT result_json FROM import_verification_claims WHERE import_run_id=?').bind(runId).first<{result_json:string}>();
    if (scenario === 'ownership') expect(claim!.result_json).toBeNull();
    else {
      const result = JSON.parse(claim!.result_json);
      expect(result.outcome).toBe('unconfirmed');
      expect(result.messages[0].text.includes('ยังไม่ได้ยืนยันตัวตนภาพ')).toBe(scenario === 'match');
      await ImportWorkflow.prototype.run.call({env} as any,{instanceId:`import-verification-${runId}`,payload:{kind:'verification',importRunId:runId}} as any,step as any);
      expect(calls).toHaveLength(1);
    }
  } finally { globalThis.fetch = originalFetch; }
});

it('does not complete an empty scan while the original workflow is still running', async () => {
  const env = testEnv(), runId = crypto.randomUUID(), albumId = crypto.randomUUID();
  const contextJson = JSON.stringify({replyGroupId:'owner'});
  await env.DB.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json,scan_evidence_json) VALUES(?,?,'line','running','now',?,'[]')").bind(runId,albumId,contextJson).run();
  await claimImportVerification(env.DB,{runId,albumId,workflowId:importWorkflowId(runId),groupId:'owner',contextJson});
  (env as any).IMPORT_WORKFLOW = {get: async () => ({status: async () => ({status:'running'})})};
  const step = {do: async (_name: string, callback: () => Promise<unknown>) => callback()};
  await expect(ImportWorkflow.prototype.run.call({env} as any,{instanceId:`import-verification-${runId}`,payload:{kind:'verification',importRunId:runId}} as any,step as any)).rejects.toThrow('import_origin_not_stopped');
  expect(await env.DB.prepare('SELECT status FROM import_runs WHERE id=?').bind(runId).first('status')).toBe('running');
});

it('identifies a missing-original group for the owner without claiming it was recovered', async () => {
  const env = testEnv(), db = env.DB, runId = crypto.randomUUID(), albumId = crypto.randomUUID(), owner = crypto.randomUUID(), groupId = crypto.randomUUID();
  const contextJson = JSON.stringify({replyGroupId:owner});
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json,scan_evidence_json) VALUES(?,?,'line','running','now',?,'\"incomplete\"')").bind(runId,albumId,contextJson).run();
  await db.prepare("INSERT INTO product_groups(id,import_run_id,ordinal,group_hash,state,first_photo_id,last_photo_id,created_at,updated_at) VALUES(?,?,0,?,'failed','missing','missing','now','now')").bind(groupId,runId,crypto.randomUUID()).run();
  await claimImportVerification(db,{runId,albumId,workflowId:importWorkflowId(runId),groupId:owner,contextJson});
  (env as any).IMPORT_WORKFLOW = {get: async () => ({status: async () => ({status:'errored'})})};
  const run = () => ImportWorkflow.prototype.run.call({env} as any,{instanceId:`import-verification-${runId}`,payload:{kind:'verification',importRunId:runId}} as any,{do:async (_:string,cb:()=>Promise<unknown>)=>cb()} as any);
  await run(); await run();
  const rows = (await db.prepare('SELECT group_id,result_json FROM line_result_outbox WHERE group_id=?').bind(owner).all<{group_id:string;result_json:string}>()).results;
  expect(rows).toHaveLength(1);
  const result = JSON.parse(rows[0]!.result_json);
  expect(result.outcome).toBe('unconfirmed');
  expect(result.messages[0].text).toContain(groupId);
  expect(await db.prepare('SELECT state FROM product_groups WHERE id=?').bind(groupId).first('state')).toBe('failed');
  expect(await db.prepare('SELECT status FROM import_runs WHERE id=?').bind(runId).first('status')).toBe('running');
});

it.each([
  ['interrupted scan', '"incomplete"'],
  ['legacy nonempty scan without grouping evidence', JSON.stringify([{applePhotoId:'photo', position:0, captureAt:null, mediaType:'image/jpeg'}])],
])('holds %s instead of inferring an empty result', async (_name, scan) => {
  const env = testEnv(), runId = crypto.randomUUID(), albumId = crypto.randomUUID();
  const owner = crypto.randomUUID();
  const contextJson = JSON.stringify({replyGroupId:owner});
  await env.DB.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json,scan_evidence_json) VALUES(?,?,'line','running','now',?,?)").bind(runId, albumId, contextJson, scan).run();
  await claimImportVerification(env.DB, {runId, albumId, workflowId:importWorkflowId(runId), groupId:owner, contextJson});
  (env as any).IMPORT_WORKFLOW = {get: async () => ({status: async () => ({status:'errored'})})};
  const step = {do: async (_name: string, callback: () => Promise<unknown>) => callback()};
  const run = () => ImportWorkflow.prototype.run.call({env} as any, {instanceId:`import-verification-${runId}`, payload:{kind:'verification', importRunId:runId}} as any, step as any);
  await run();
  await run();
  const claim = await env.DB.prepare('SELECT result_json FROM import_verification_claims WHERE import_run_id=?').bind(runId).first<{result_json:string}>();
  expect(JSON.parse(claim!.result_json).outcome).toBe('unconfirmed');
  expect(await env.DB.prepare('SELECT status FROM import_runs WHERE id=?').bind(runId).first('status')).toBe('running');
  expect(await env.DB.prepare('SELECT count(*) AS count FROM line_result_outbox WHERE group_id=?').bind(owner).first('count')).toBe(1);
});

it.each(['ignored', 'orphan'])('completes a verified %s grouping once and preserves its checkpoint', async (kind) => {
  const env = testEnv(), db = env.DB, runId = crypto.randomUUID(), album = crypto.randomUUID();
  const owner = crypto.randomUUID(), context = JSON.stringify({replyGroupId:owner});
  const scan = [{applePhotoId:'a',position:0,captureAt:null,mediaType:'image/jpeg'}, {applePhotoId:'b',position:1,captureAt:null,mediaType:'image/jpeg'}];
  const facts = {version:1,savedCheckpoint:null,firstImportCutoffDate:null,ignoredGroupCount:kind === 'ignored' ? 1 : 0,orphanRange:kind === 'orphan' ? {firstApplePhotoId:'a',lastApplePhotoId:'b',count:2} : null,checkpointPosition:1};
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json,scan_evidence_json,grouping_evidence_json) VALUES(?,?,'line','running','now',?,?,?)").bind(runId,album,context,JSON.stringify(scan),JSON.stringify(facts)).run();
  for (const [i, photo] of scan.entries()) await db.prepare("INSERT INTO photo_assets(id,source_album_id,apple_photo_id,content_hash,position,is_marker,marker_kind,import_run_id,created_at) VALUES(?,?,?,?,?,0,?,?,'now')").bind(crypto.randomUUID(),album,photo.applePhotoId,crypto.randomUUID(),i,kind === 'ignored' && i === 0 ? 'ignore_start' : 'none',runId).run();
  await claimImportVerification(db,{runId,albumId:album,workflowId:importWorkflowId(runId),groupId:owner,contextJson:context});
  (env as any).IMPORT_WORKFLOW = {get: async () => ({status: async () => ({status:'errored'})})};
  const run = () => ImportWorkflow.prototype.run.call({env} as any,{instanceId:`import-verification-${runId}`,payload:{kind:'verification',importRunId:runId}} as any,{do:async (_:string,cb:()=>Promise<unknown>)=>cb()} as any);
  await run(); await run();
  expect(await db.prepare('SELECT status,orphan_photo_count,checkpoint_position FROM import_runs WHERE id=?').bind(runId).first()).toEqual({status:'completed',orphan_photo_count:kind === 'orphan' ? 2 : 0,checkpoint_position:null});
  const rows = (await db.prepare('SELECT group_id,result_json FROM line_result_outbox WHERE group_id=?').bind(owner).all<{group_id:string;result_json:string}>()).results;
  expect(rows).toHaveLength(1);
  const result = JSON.parse(rows[0]!.result_json);
  expect(result.outcome).toBe('success');
  expect(result.messages[0].text).toContain(kind === 'ignored' ? 'ข้ามสินค้าซ้ำ 1' : 'a – b');
});

it.each(['classification', 'scan', 'checkpoint'])('rejects %s changed between reconstruction and completion', async (change) => {
  const env = testEnv(), db = env.DB, runId = crypto.randomUUID(), album = crypto.randomUUID(), owner = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:owner});
  const scan = [{applePhotoId:'a',position:0,captureAt:null,mediaType:'image/jpeg'}];
  const facts = {version:1,savedCheckpoint:null,firstImportCutoffDate:null,ignoredGroupCount:0,orphanRange:{firstApplePhotoId:'a',lastApplePhotoId:'a',count:1},checkpointPosition:0};
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json,scan_evidence_json,grouping_evidence_json) VALUES(?,?,'line','running','now',?,?,?)").bind(runId,album,context,JSON.stringify(scan),JSON.stringify(facts)).run();
  await db.prepare("INSERT INTO photo_assets(id,source_album_id,apple_photo_id,content_hash,position,is_marker,marker_kind,import_run_id,created_at) VALUES(?,?,'a','hash',0,0,'none',?,'now')").bind(crypto.randomUUID(),album,runId).run();
  await claimImportVerification(db,{runId,albumId:album,workflowId:importWorkflowId(runId),groupId:owner,contextJson:context});
  (env as any).IMPORT_WORKFLOW = {get: async () => ({status: async () => ({status:'errored'})})};
  let batches = 0;
  const wrapped = new Proxy(db, {get(target, prop) { if (prop === 'batch') return async (statements: D1PreparedStatement[]) => { if (++batches === 2) { if (change === 'classification') await target.prepare("UPDATE photo_assets SET marker_kind='product_start', is_marker=1 WHERE source_album_id=?").bind(album).run(); else if (change === 'scan') await target.prepare("UPDATE import_runs SET scan_evidence_json='[]' WHERE id=?").bind(runId).run(); else await target.prepare("INSERT INTO import_checkpoints VALUES(?,99,'new')").bind(album).run(); } return target.batch(statements); }; const value = Reflect.get(target,prop,target); return typeof value === 'function' ? value.bind(target) : value; }});
  await ImportWorkflow.prototype.run.call({env:{...env,DB:wrapped}} as any,{instanceId:`import-verification-${runId}`,payload:{kind:'verification',importRunId:runId}} as any,{do:async (_:string,cb:()=>Promise<unknown>)=>cb()} as any);
  expect(await db.prepare('SELECT status,checkpoint_position FROM import_runs WHERE id=?').bind(runId).first()).toEqual({status:'running',checkpoint_position:null});
  expect(await db.prepare('SELECT completed FROM import_verification_claims WHERE import_run_id=?').bind(runId).first('completed')).toBeNull();
  expect(await db.prepare('SELECT count(*) FROM line_result_outbox WHERE group_id=?').bind(owner).first('count(*)')).toBe(0);
  if (change === 'scan') expect(await db.prepare('SELECT scan_evidence_json FROM import_runs WHERE id=?').bind(runId).first('scan_evidence_json')).toBe('[]');
  if (change === 'checkpoint') expect(await db.prepare('SELECT last_position FROM import_checkpoints WHERE source_album_id=?').bind(album).first('last_position')).toBe(99);
});

it.each(['unchanged', 'membership', 'state', 'competing'])('fences reordered confirmed history during verification: %s', async change => {
  const {computeGroupHash} = await import('../../src/import/grouping');
  const {readImportVerificationGroupingCandidate, completeImportVerification} = await import('../../src/db/import-repository');
  const db = testEnv().DB, runId = crypto.randomUUID(), oldRun = crypto.randomUUID(), album = crypto.randomUUID(), group = crypto.randomUUID();
  const owner = crypto.randomUUID(), contextJson = JSON.stringify({replyGroupId:owner});
  const scan = ['m', 'p1', 'p2'].map((applePhotoId,position) => ({applePhotoId,position,captureAt:null,mediaType:'image/jpeg'}));
  const facts = {version:1,savedCheckpoint:null,firstImportCutoffDate:null,countedIgnoreMarkerIds:[],ignoredGroupCount:0,orphanRange:null,checkpointPosition:2};
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at) VALUES(?,?,'line','completed','now')").bind(oldRun,album).run();
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json,scan_evidence_json,grouping_evidence_json) VALUES(?,?,'line','running','now',?,?,?)").bind(runId,album,contextJson,JSON.stringify(scan),JSON.stringify(facts)).run();
  const hash = await computeGroupHash(album,['m','p2','p1'].map(applePhotoId => ({applePhotoId})));
  await db.prepare("INSERT INTO product_groups(id,import_run_id,ordinal,group_hash,state,product_id,airtable_record_id,first_photo_id,last_photo_id,created_at,updated_at) VALUES(?,?,0,?,'succeeded',?,'rec-old','m','p1','now','now')").bind(group,oldRun,hash,crypto.randomUUID()).run();
  for (const [i,id] of ['m','p2','p1'].entries()) await db.prepare('INSERT INTO product_group_image_members VALUES(?,?,?,?)').bind(group,i,id,`key-${id}`).run();
  for (const p of scan) await db.prepare("INSERT INTO photo_assets(id,source_album_id,apple_photo_id,content_hash,r2_key,position,is_marker,marker_kind,import_run_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,'now')")
    .bind(crypto.randomUUID(),album,p.applePhotoId,crypto.randomUUID(),`key-${p.applePhotoId}`,p.position,p.position === 0 ? 1 : 0,p.position === 0 ? 'product_start' : 'none',oldRun).run();
  const input = {runId,albumId:album,workflowId:importWorkflowId(runId),groupId:owner,contextJson};
  await claimImportVerification(db,input);
  const verifier = `import-verification-${runId}`;
  const grouping = await readImportVerificationGroupingCandidate(db,runId,verifier);
  expect(grouping).not.toBeNull();
  if (change === 'membership') await db.prepare("UPDATE product_group_image_members SET apple_photo_id='changed' WHERE group_id=? AND ordinal=1").bind(group).run();
  if (change === 'state') await db.prepare("UPDATE product_groups SET state='failed' WHERE id=?").bind(group).run();
  if (change === 'competing') await db.prepare("INSERT INTO product_groups(id,import_run_id,ordinal,group_hash,state,first_photo_id,last_photo_id,created_at,updated_at) VALUES(?,?,1,?,'succeeded','other','p2','now','now')").bind(crypto.randomUUID(),oldRun,crypto.randomUUID()).run();
  const result = {schemaVersion:1 as const,kind:'import' as const,runId,generation:1,notificationCycle:1,outcome:'success' as const,messages:[{type:'text' as const,text:'done'}]};
  expect(await completeImportVerification(db,input,verifier,result,false,grouping!)).toBe(change === 'unchanged');
  expect(await db.prepare('SELECT status FROM import_runs WHERE id=?').bind(runId).first('status')).toBe(change === 'unchanged' ? 'completed' : 'running');
  expect(await db.prepare('SELECT group_hash FROM product_groups WHERE id=?').bind(group).first('group_hash')).toBe(hash);
});
