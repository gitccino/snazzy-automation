import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import type { TerminalResultV1 } from '../../src/line/reply-types';
import { claimImportVerification } from '../../src/db/import-repository';

it('admits one verifier only for the captured running album owner', async () => {
  const db = testEnv().DB;
  const runId = crypto.randomUUID();
  const albumId = crypto.randomUUID();
  const contextJson = JSON.stringify({replyGroupId:'owner', target:'original'});
  await db.prepare("INSERT INTO import_runs (id,source_album_id,trigger,status,started_at,settings_context_json) VALUES (?,?,'line','running','x',?)").bind(runId, albumId, contextJson).run();
  const input = {runId, albumId, workflowId:`import-${runId}`, groupId:'owner', contextJson};
  for (const invalid of [{...input, groupId:'foreign'}, {...input, albumId:'stale'}, {...input, workflowId:'stale'}, {...input, contextJson:'{}'}]) {
    expect(await claimImportVerification(db, invalid)).toBe(false);
  }
  await db.prepare("UPDATE import_runs SET status='start_failed' WHERE id=?").bind(runId).run();
  expect(await claimImportVerification(db, input)).toBe(false);
  await db.prepare("UPDATE import_runs SET status='running', settings_context_json=? WHERE id=?").bind(JSON.stringify({replyGroupId:'owner', target:'changed'}), runId).run();
  expect(await claimImportVerification(db, input)).toBe(false);
  await db.prepare('UPDATE import_runs SET settings_context_json=? WHERE id=?').bind(contextJson, runId).run();
  expect((await Promise.all([claimImportVerification(db, input), claimImportVerification(db, input)])).sort()).toEqual([false, true]);
  expect(await db.prepare('SELECT count(*) AS n FROM import_verification_claims WHERE import_run_id=?').bind(runId).first('n')).toBe(1);
});

it('holds a completed historical group when the running-import verifier is requested', async () => {
  const db = testEnv().DB, runId = crypto.randomUUID(), albumId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const contextJson = JSON.stringify({replyGroupId:'owner', settings:{config:{airtableBaseId:'original-base', airtableProductsTableId:'original-table'}}});
  await db.prepare("INSERT INTO import_runs (id,source_album_id,trigger,status,started_at,settings_context_json) VALUES (?,?,'line','completed_with_failures','x',?)").bind(runId, albumId, contextJson).run();
  await db.prepare("INSERT INTO product_groups (id,import_run_id,ordinal,group_hash,state,first_photo_id,last_photo_id,created_at,updated_at) VALUES (?,?,0,?,'failed','missing','missing','x','x')").bind(groupId,runId,crypto.randomUUID()).run();
  await db.prepare("INSERT INTO import_checkpoints (source_album_id,last_position,updated_at) VALUES (?,42,'x')").bind(albumId).run();
  const input = {runId, albumId, workflowId:`import-${runId}`, groupId:'owner', contextJson};
  expect(await claimImportVerification(db, input)).toBe(false);
  expect(await claimImportVerification(db, input)).toBe(false);
  expect(await db.prepare('SELECT state,product_id FROM product_groups WHERE id=?').bind(groupId).first()).toEqual({state:'failed',product_id:null});
  expect(await db.prepare('SELECT last_position FROM import_checkpoints WHERE source_album_id=?').bind(albumId).first('last_position')).toBe(42);
  expect(await db.prepare('SELECT count(*) AS n FROM import_verification_claims WHERE import_run_id=?').bind(runId).first('n')).toBe(0);
});

it('atomically completes and queues one result, rolling back on outbox failure', async () => {
  const { completeImportVerification } = await import('../../src/db/import-repository');
  const db = testEnv().DB;
  const runId = crypto.randomUUID(), albumId = crypto.randomUUID();
  const contextJson = JSON.stringify({replyGroupId:'owner'});
  const input = {runId, albumId, workflowId:`import-${runId}`, groupId:'owner', contextJson};
  const verifierId = `import-verification-${runId}`;
  const result: TerminalResultV1 = {schemaVersion:1, kind:'import', runId, generation:1, notificationCycle:1, outcome:'unconfirmed', messages:[{type:'text', text:'check'}]};
  await db.prepare("INSERT INTO import_runs (id,source_album_id,trigger,status,started_at,settings_context_json) VALUES (?,?,'line','running','x',?)").bind(runId, albumId, contextJson).run();
  expect(await claimImportVerification(db, input)).toBe(true);
  await db.exec("CREATE TRIGGER fail_import_outbox BEFORE INSERT ON line_result_outbox BEGIN SELECT RAISE(ABORT, 'injected'); END");
  await expect(completeImportVerification(db, input, verifierId, result)).rejects.toThrow();
  expect(await db.prepare('SELECT completed,result_json FROM import_verification_claims WHERE import_run_id=?').bind(runId).first()).toEqual({completed:null,result_json:null});
  await db.exec('DROP TRIGGER fail_import_outbox');
  expect(await completeImportVerification(db, input, verifierId, result)).toBe(true);
  expect(await completeImportVerification(db, input, verifierId, result)).toBe(false);
  expect(await db.prepare('SELECT count(*) AS n FROM line_result_outbox WHERE result_key=?').bind(JSON.stringify(['import',runId,1,1,'verification'])).first('n')).toBe(1);
});

it('renews only once and fences stale completion', async () => {
  const { renewImportVerification, completeImportVerification } = await import('../../src/db/import-repository');
  const db = testEnv().DB, runId = crypto.randomUUID(), albumId = crypto.randomUUID();
  const contextJson = JSON.stringify({replyGroupId:'owner', target:'original'});
  const input = {runId, albumId, workflowId:`import-${runId}`, groupId:'owner', contextJson};
  const oldId = `import-verification-${runId}`;
  await db.prepare("INSERT INTO import_runs (id,source_album_id,trigger,status,started_at,settings_context_json) VALUES (?,?,'line','running','x',?)").bind(runId, albumId, contextJson).run();
  expect(await claimImportVerification(db, input)).toBe(true);
  const renewed = await Promise.all([renewImportVerification(db, input, oldId), renewImportVerification(db, input, oldId)]);
  expect(renewed.filter(Boolean)).toHaveLength(1);
  const result: TerminalResultV1 = {schemaVersion:1, kind:'import', runId, generation:1, notificationCycle:1, outcome:'unconfirmed', messages:[{type:'text', text:'check'}]};
  expect(await completeImportVerification(db, input, oldId, result)).toBe(false);
  expect(await completeImportVerification(db, input, renewed.find(Boolean)!, result)).toBe(true);
  expect(await renewImportVerification(db, input, renewed.find(Boolean)!)).toBeNull();
});

it('completes a proven empty scan atomically and preserves the checkpoint', async () => {
  const { completeEmptyImportVerification } = await import('../../src/db/import-repository');
  const db = testEnv().DB, runId = crypto.randomUUID(), albumId = crypto.randomUUID();
  const contextJson = JSON.stringify({replyGroupId:'owner'});
  const input = {runId, albumId, workflowId:`import-${runId}`, groupId:'owner', contextJson};
  const verifierId = `import-verification-${runId}`;
  const result: TerminalResultV1 = {schemaVersion:1, kind:'import', runId, generation:1, notificationCycle:1, outcome:'success', messages:[{type:'text', text:'empty'}]};
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json,scan_evidence_json) VALUES(?,?,'line','running','x',?,'[]')").bind(runId,albumId,contextJson).run();
  await db.prepare("INSERT INTO import_checkpoints VALUES(?,42,'old')").bind(albumId).run();
  await claimImportVerification(db,input);
  expect(await completeEmptyImportVerification(db,input,'stale',result)).toBe(false);
  await db.prepare("UPDATE import_runs SET scan_evidence_json='\"incomplete\"' WHERE id=?").bind(runId).run();
  expect(await completeEmptyImportVerification(db,input,verifierId,result)).toBe(false);
  await db.prepare("UPDATE import_runs SET scan_evidence_json='[]' WHERE id=?").bind(runId).run();
  await db.prepare("INSERT INTO photo_assets(id,source_album_id,apple_photo_id,content_hash,position,import_run_id,created_at) VALUES('asset',?,'photo','hash',0,?,'now')").bind(albumId,runId).run();
  expect(await completeEmptyImportVerification(db,input,verifierId,result)).toBe(false);
  await db.prepare("DELETE FROM photo_assets WHERE id='asset'").run();
  await db.prepare("INSERT INTO product_groups(id,import_run_id,ordinal,group_hash,state,first_photo_id,last_photo_id,created_at,updated_at) VALUES('group',?,0,'hash','pending','a','a','now','now')").bind(runId).run();
  expect(await completeEmptyImportVerification(db,input,verifierId,result)).toBe(false);
  await db.prepare("DELETE FROM product_groups WHERE id='group'").run();
  expect(await completeEmptyImportVerification(db,{...input, contextJson:'{}'},verifierId,result)).toBe(false);
  await db.exec("CREATE TRIGGER fail_empty_outbox BEFORE INSERT ON line_result_outbox BEGIN SELECT RAISE(ABORT, 'injected'); END");
  await expect(completeEmptyImportVerification(db,input,verifierId,result)).rejects.toThrow();
  expect(await db.prepare('SELECT status FROM import_runs WHERE id=?').bind(runId).first('status')).toBe('running');
  expect(await db.prepare('SELECT completed FROM import_verification_claims WHERE import_run_id=?').bind(runId).first('completed')).toBeNull();
  await db.exec('DROP TRIGGER fail_empty_outbox');
  expect(await completeEmptyImportVerification(db,input,verifierId,result)).toBe(true);
  expect(await completeEmptyImportVerification(db,input,verifierId,result)).toBe(false);
  expect(await db.prepare('SELECT status,checkpoint_position FROM import_runs WHERE id=?').bind(runId).first()).toEqual({status:'completed',checkpoint_position:42});
  expect(await db.prepare('SELECT last_position FROM import_checkpoints WHERE source_album_id=?').bind(albumId).first('last_position')).toBe(42);
});

it.each(['scan', 'checkpoint'])('fences a %s change after reading the grouping candidate', async change => {
  const { readImportVerificationGroupingCandidate, completeImportVerification } = await import('../../src/db/import-repository');
  const db = testEnv().DB, runId = crypto.randomUUID(), albumId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const contextJson = JSON.stringify({replyGroupId:groupId});
  const input = {runId, albumId, workflowId:`import-${runId}`, groupId, contextJson};
  const scan = [{applePhotoId:'a',position:0,captureAt:null,mediaType:'image/jpeg'}];
  const facts = {version:1,savedCheckpoint:42,firstImportCutoffDate:null,ignoredGroupCount:0,orphanRange:{firstApplePhotoId:'a',lastApplePhotoId:'a',count:1},checkpointPosition:42};
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json,scan_evidence_json,grouping_evidence_json) VALUES(?,?,'line','running','now',?,?,?)").bind(runId,albumId,contextJson,JSON.stringify(scan),JSON.stringify(facts)).run();
  await db.prepare("INSERT INTO import_checkpoints VALUES(?,42,'old')").bind(albumId).run();
  await db.prepare("INSERT INTO photo_assets(id,source_album_id,apple_photo_id,content_hash,position,is_marker,marker_kind,import_run_id,created_at) VALUES(?,?,'a','hash',0,0,'none',?,'now')").bind(crypto.randomUUID(),albumId,runId).run();
  await claimImportVerification(db,input);
  const verifierId = `import-verification-${runId}`;
  const candidate = await readImportVerificationGroupingCandidate(db,runId,verifierId);
  expect(candidate).not.toBeNull();
  if (change === 'scan') await db.prepare("UPDATE import_runs SET scan_evidence_json='[]' WHERE id=?").bind(runId).run();
  else await db.prepare('UPDATE import_checkpoints SET last_position=99 WHERE source_album_id=?').bind(albumId).run();
  const result: TerminalResultV1 = {schemaVersion:1,kind:'import',runId,generation:1,notificationCycle:1,outcome:'success',messages:[{type:'text',text:'done'}]};
  expect(await completeImportVerification(db,input,verifierId,result,false,candidate!)).toBe(false);
  expect(await db.prepare('SELECT status,checkpoint_position,scan_evidence_json FROM import_runs WHERE id=?').bind(runId).first()).toEqual({status:'running',checkpoint_position:null,scan_evidence_json:change === 'scan' ? '[]' : JSON.stringify(scan)});
  expect(await db.prepare('SELECT last_position FROM import_checkpoints WHERE source_album_id=?').bind(albumId).first('last_position')).toBe(change === 'checkpoint' ? 99 : 42);
  expect(await db.prepare('SELECT completed FROM import_verification_claims WHERE import_run_id=?').bind(runId).first('completed')).toBeNull();
  expect(await db.prepare('SELECT count(*) AS n FROM line_result_outbox WHERE group_id=?').bind(groupId).first('n')).toBe(0);
});
