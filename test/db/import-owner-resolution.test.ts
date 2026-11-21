import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { resolveHistoricalImportGroup } from '../../src/db/import-owner-resolution';
import { verifyHistoricalImportEvidence } from '../../src/import/owner-evidence';
import { computeGroupHash } from '../../src/import/grouping';
import { sha256Hex } from '../../src/shared/ids';

it('atomically resolves verified evidence, replays it, and rejects stale evidence', async () => {
  const db=testEnv().DB, runId=crypto.randomUUID(), groupId=crypto.randomUUID(), album=crypto.randomUUID();
  const photos=['m','a','b','c','d'], bytes=new Uint8Array([255,216,255,4]);
  const hash=await sha256Hex(bytes), groupHash=await computeGroupHash(album,photos.map(applePhotoId=>({applePhotoId})));
  const context=JSON.stringify({replyGroupId:'owner',settings:{config:{airtableBaseId:'base',airtableProductsTableId:'table'}}});
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json) VALUES(?,?,'line','completed','now',?)").bind(runId,album,context).run();
  await db.prepare("INSERT INTO product_groups(id,import_run_id,ordinal,group_hash,state,product_id,first_photo_id,last_photo_id,created_at,updated_at) VALUES(?,?,0,?,'failed','A','m','d','now','now')").bind(groupId,runId,groupHash).run();
  for (const [i,p] of photos.entries()) {
    await db.prepare('INSERT INTO product_group_image_members VALUES(?,?,?,?)').bind(groupId,i,p,p).run();
    await db.prepare("INSERT INTO photo_assets(id,source_album_id,apple_photo_id,content_hash,r2_key,position,is_marker,import_run_id,created_at) VALUES(?,?,?,?,?,?,?,?,'now')").bind(crypto.randomUUID(),album,p,hash,p,i,i===0?1:0,runId).run();
  }
  await db.prepare("INSERT INTO audit_events VALUES(?,?,'system:import','product_id_allocated',NULL,'A','now')").bind(crypto.randomUUID(),runId).run();
  await db.prepare("INSERT INTO airtable_create_claims VALUES(?,'A','base','table')").bind(groupId).run();
  const identity={runId,groupId,ownerGroupId:'owner',baseId:'base',tableId:'table',recordId:'rec'};
  const evidence=await verifyHistoricalImportEvidence({db,readOriginal:async()=>bytes.buffer,renderPreview:async()=>bytes.buffer,readRecord:async()=>({productId:'A',groupHash,attachments:photos.slice(1).map(id=>({id,filename:'x.jpg',url:'https://v5.airtableusercontent.com/x'}))}),fetcher:async()=>new Response(bytes,{headers:{'content-type':'image/jpeg'}})},identity);
  if(evidence.status!=='verified') throw new Error(evidence.reason);
  const action={...identity,actor:'owner',reason:'verified',evidence};
  await db.prepare("UPDATE photo_assets SET content_hash='changed' WHERE source_album_id=? AND apple_photo_id='a'").bind(album).run();
  expect(await resolveHistoricalImportGroup(db,action)).toBeNull();
  await db.prepare('UPDATE photo_assets SET content_hash=? WHERE source_album_id=? AND apple_photo_id=\'a\'').bind(hash,album).run();
  await db.prepare("UPDATE airtable_create_claims SET table_id='other' WHERE group_id=?").bind(groupId).run();
  expect(await resolveHistoricalImportGroup(db,action)).toBeNull();
  await db.prepare("UPDATE airtable_create_claims SET table_id='table' WHERE group_id=?").bind(groupId).run();
  await db.prepare("UPDATE product_group_image_members SET r2_key='other' WHERE group_id=? AND ordinal=1").bind(groupId).run();
  expect(await resolveHistoricalImportGroup(db,action)).toBeNull();
  await db.prepare("UPDATE product_group_image_members SET r2_key='a' WHERE group_id=? AND ordinal=1").bind(groupId).run();
  await db.prepare("CREATE TRIGGER fail_resolution_audit BEFORE INSERT ON import_owner_group_resolutions BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END").run();
  await expect(resolveHistoricalImportGroup(db,action)).rejects.toThrow();
  expect(await db.prepare('SELECT state,airtable_record_id FROM product_groups WHERE id=?').bind(groupId).first()).toMatchObject({state:'failed',airtable_record_id:null});
  await db.prepare('DROP TRIGGER fail_resolution_audit').run();
  const [a,b]=await Promise.all([resolveHistoricalImportGroup(db,action),resolveHistoricalImportGroup(db,{...action,actor:'other'})]);
  expect([a,b].filter(Boolean)).toHaveLength(1);
  const winner=a ? action : {...action,actor:'other'};
  expect(await resolveHistoricalImportGroup(db,winner)).toEqual(a ?? b);
  await expect(db.prepare('DELETE FROM import_owner_group_resolutions WHERE group_id=?').bind(groupId).run()).rejects.toThrow();
  await expect(db.prepare("UPDATE import_owner_group_resolutions SET reason='changed' WHERE group_id=?").bind(groupId).run()).rejects.toThrow();
  expect(await db.prepare('SELECT state,airtable_record_id FROM product_groups WHERE id=?').bind(groupId).first()).toMatchObject({state:'succeeded',airtable_record_id:'rec'});
});
