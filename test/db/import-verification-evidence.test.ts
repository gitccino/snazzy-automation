import { expect, it } from 'vitest';
import { importWorkflowId } from '../../src/shared/ids';
import { testEnv } from '../helpers/env';
import { claimImportVerification, readImportVerificationEvidence } from '../../src/db/import-repository';

it('reads only owned running import evidence and distinguishes incomplete from empty scans', async () => {
  const db = testEnv().DB, id = crypto.randomUUID(), album = crypto.randomUUID();
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json,scan_evidence_json) VALUES(?,?,'line','running','now',?,?)").bind(id,album,JSON.stringify({replyGroupId:'owner'}), '"incomplete"').run();
  const read = (group = 'owner', workflow = importWorkflowId(id)) => readImportVerificationEvidence(db, id, workflow, group);
  expect(await read()).toMatchObject({scan: 'incomplete', groups: {pending: 0, importing: 0, succeeded: 0, failed: 0}});
  expect(await read('foreign')).toBeNull();
  expect(await read('owner', 'other')).toBeNull();
  await db.prepare("UPDATE import_runs SET scan_evidence_json=NULL WHERE id=?").bind(id).run();
  expect(await read()).toBeNull();
  await db.prepare("UPDATE import_runs SET scan_evidence_json='[]' WHERE id=?").bind(id).run();
  expect(await read()).toMatchObject({scan: 'complete'});
  await db.prepare("INSERT INTO product_groups(id,import_run_id,ordinal,group_hash,state,first_photo_id,last_photo_id,created_at,updated_at) VALUES(?,?,0,?,'failed','a','b','now','now')").bind(crypto.randomUUID(),id,crypto.randomUUID()).run();
  expect(await read()).toMatchObject({groups: {failed: 1}});
  await db.prepare("UPDATE import_runs SET status='start_failed' WHERE id=?").bind(id).run();
  expect(await read()).toBeNull();
});


it('reads the persisted claim identity and rejects foreign or stale owners', async () => {
  const db = testEnv().DB, runId = `import-${crypto.randomUUID()}`, albumId = crypto.randomUUID();
  const contextJson = JSON.stringify({replyGroupId:'owner'});
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json,scan_evidence_json) VALUES(?,?,'line','running','now',?,'[]')").bind(runId, albumId, contextJson).run();
  expect(await claimImportVerification(db, {runId, albumId, workflowId:importWorkflowId(runId), groupId:'owner', contextJson})).toBe(true);
  const claim = await db.prepare('SELECT import_run_id, origin_workflow_id, group_id FROM import_verification_claims WHERE import_run_id=?').bind(runId).first<{import_run_id:string; origin_workflow_id:string; group_id:string}>();
  expect(claim).not.toBeNull();
  const read = (workflowId = claim!.origin_workflow_id, groupId = claim!.group_id) => readImportVerificationEvidence(db, claim!.import_run_id, workflowId, groupId);
  expect(await read()).toMatchObject({sourceAlbumId:albumId, scan:'complete'});
  expect(await read(runId)).toBeNull();
  expect(await read(importWorkflowId(crypto.randomUUID()))).toBeNull();
  expect(await read(undefined, 'foreign')).toBeNull();
  await db.prepare("UPDATE import_runs SET status='start_failed' WHERE id=?").bind(runId).run();
  expect(await read()).toBeNull();
});

it('admits only candidates with the original ordered membership and target', async () => {
  const { readImportVerificationCandidates } = await import('../../src/db/import-repository');
  const { computeGroupHash } = await import('../../src/import/grouping');
  const db = testEnv().DB, runId = crypto.randomUUID(), album = crypto.randomUUID(), group = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:'owner', settings:{config:{airtableBaseId:'base', airtableProductsTableId:'table'}}});
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json) VALUES(?,?,'line','running','now',?)").bind(runId,album,context).run();
  await claimImportVerification(db, {runId, albumId:album, workflowId:importWorkflowId(runId), groupId:'owner', contextJson:context});
  const verifier = `import-verification-${runId}`;
  const hash = await computeGroupHash(album, [{applePhotoId:'a'}, {applePhotoId:'b'}]);
  await db.prepare("INSERT INTO product_groups(id,import_run_id,ordinal,group_hash,state,product_id,airtable_record_id,first_photo_id,last_photo_id,created_at,updated_at) VALUES(?,?,0,?,'importing','A1','rec','a','b','now','now')").bind(group,runId,hash).run();
  await db.prepare("INSERT INTO airtable_create_claims VALUES(?,'A1','base','table')").bind(group).run();
  await db.prepare("INSERT INTO product_group_image_members VALUES(?,0,'a','key-a'),(?,1,'b','key-b')").bind(group,group).run();
  expect(await readImportVerificationCandidates(db,runId,verifier)).toHaveLength(1);
  expect(await readImportVerificationCandidates(db,runId,'foreign')).toHaveLength(0);
  await db.prepare("DELETE FROM product_group_image_members WHERE group_id=?").bind(group).run();
  await db.prepare("INSERT INTO product_group_image_members VALUES(?,0,'b','key-b'),(?,1,'a','key-a')").bind(group,group).run();
  expect(await readImportVerificationCandidates(db,runId,verifier)).toHaveLength(0);
});
