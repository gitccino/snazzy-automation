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
