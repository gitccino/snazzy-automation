import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { computeGroupHash } from '../../src/import/grouping';
import { sha256Hex } from '../../src/shared/ids';
import { verifyHistoricalImportEvidence } from '../../src/import/owner-evidence';

it('verifies captured membership, claim, original bytes and downloaded preview identity', async () => {
  const db = testEnv().DB, id = crypto.randomUUID(), run = crypto.randomUUID(), album = crypto.randomUUID();
  const original = new Uint8Array([1,2,3]), preview = new Uint8Array([255,216,255,4]);
  const hash = await sha256Hex(original), photos = ['marker','p1','p2','p3','p4'], groupHash = await computeGroupHash(album, photos.map(applePhotoId => ({applePhotoId}))); 
  const context = JSON.stringify({replyGroupId:'owner',settings:{config:{airtableBaseId:'base',airtableProductsTableId:'table'}}});
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json) VALUES(?,?,'line','completed_with_failures','2026-11-20T00:00:00Z',?)").bind(run,album,context).run();
  await db.prepare("INSERT INTO product_groups(id,import_run_id,ordinal,group_hash,state,product_id,first_photo_id,last_photo_id,created_at,updated_at) VALUES(?,?,0,?,'failed','A-1','marker','p4','now','now')").bind(id,run,groupHash).run();
  for (const [ordinal, photo] of photos.entries()) {
    await db.prepare("INSERT INTO product_group_image_members VALUES(?,?,?,'assets/original')").bind(id,ordinal,photo).run();
    await db.prepare("INSERT INTO photo_assets(id,source_album_id,apple_photo_id,content_hash,r2_key,position,is_marker,import_run_id,created_at) VALUES(?,?,?,?,'assets/original',?,?,?,'now')").bind(crypto.randomUUID(),album,photo,hash,ordinal,ordinal === 0 ? 1 : 0,run).run();
  }
  await db.prepare("INSERT INTO audit_events VALUES(?,?, 'system:import','product_id_allocated',NULL,'A-1','now')").bind(crypto.randomUUID(),run).run();
  await db.prepare("INSERT INTO airtable_create_claims VALUES(?,'A-1','base','table')").bind(id).run();
  const input = {runId:run,ownerGroupId:'owner',groupId:id,baseId:'base',tableId:'table',recordId:'rec1'};
  const deps = {db, readOriginal: async () => original.buffer, renderPreview: async () => preview.buffer,
    readRecord: async () => ({productId:'A-1',groupHash,attachments:Array.from({length:4},(_,i) => ({id:`att${i}`,filename:'image.jpg',url:'https://v5.airtableusercontent.com/image'}))}),
    fetcher: async () => new Response(preview, {headers:{'content-type':'image/jpeg'}})};
  expect(await verifyHistoricalImportEvidence(deps,input)).toMatchObject({status:'verified',recordId:'rec1'});
  expect(await verifyHistoricalImportEvidence({...deps, fetcher: async () => new Response(new Uint8Array([255,216,255,5]))},input)).toEqual({status:'held',reason:'attachment_mismatch'});
  expect(await verifyHistoricalImportEvidence(deps,{...input,ownerGroupId:'foreign'})).toEqual({status:'held',reason:'owner_or_target_mismatch'});
  expect(await verifyHistoricalImportEvidence({...deps,readOriginal:async () => new Uint8Array([9]).buffer},input)).toEqual({status:'held',reason:'original_hash_mismatch'});
  expect(await verifyHistoricalImportEvidence({...deps,readOriginal:async () => null},input)).toEqual({status:'held',reason:'original_missing'});
  expect(await verifyHistoricalImportEvidence({...deps,readRecord:async () => ({productId:'A-2',groupHash,attachments:[]})},input)).toEqual({status:'held',reason:'candidate_conflict'});
  expect(await verifyHistoricalImportEvidence({...deps,readRecord:async () => { throw new Error('secret'); }},input)).toEqual({status:'held',reason:'provider_evidence_unavailable'});
  expect(await verifyHistoricalImportEvidence(deps,{...input,tableId:'other'})).toEqual({status:'held',reason:'owner_or_target_mismatch'});
  await db.prepare("UPDATE airtable_create_claims SET product_id='A-2' WHERE group_id=?").bind(id).run();
  expect(await verifyHistoricalImportEvidence(deps,input)).toEqual({status:'held',reason:'claim_or_record_conflict'});
  await db.prepare("UPDATE airtable_create_claims SET product_id='A-1' WHERE group_id=?").bind(id).run();
  await db.prepare('DELETE FROM product_group_image_members WHERE group_id=?').bind(id).run();
  expect(await verifyHistoricalImportEvidence(deps,input)).toEqual({status:'held',reason:'membership_missing'});
});
