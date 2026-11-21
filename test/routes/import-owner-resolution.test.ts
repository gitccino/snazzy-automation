import { expect, it, vi } from 'vitest';
import { testEnv } from '../helpers/env';
import { routeRequest } from '../../src/router';
import { computeGroupHash } from '../../src/import/grouping';
import { sha256Hex } from '../../src/shared/ids';
import { createImportRepository } from '../../src/db/import-repository';

it('authenticates, verifies and applies only matching historical evidence without provider writes', async () => {
  const env=testEnv(), db=env.DB, runId=crypto.randomUUID(), groupId=crypto.randomUUID(), album=crypto.randomUUID();
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
  const freshRun=crypto.randomUUID();
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json) VALUES(?,?,'line','running','now',?)").bind(freshRun,album,context).run();
  const repo=createImportRepository(db,{next:()=>crypto.randomUUID()},{now:()=>new Date()});
  const input={runId,groupId,ownerGroupId:'owner',baseId:'base',tableId:'table',recordId:'rec',actor:'admin',reason:'verified',apply:true};
  let mismatch=false;
  const provider=vi.fn(async (url: string | URL | Request, init?:RequestInit) => {
    expect(init?.method ?? 'GET').toBe('GET');
    if (String(url).startsWith('https://api.airtable.com/')) return Response.json({fields:{'Product ID':'A','System Group ID':groupHash,'Product Images':photos.slice(1).map(id=>({id,filename:'x.jpg',url:'https://v5.airtableusercontent.com/private?signature=secret'}))}});
    return new Response(mismatch ? new Uint8Array([255,216,255,5]) : bytes,{headers:{'content-type':'image/jpeg'}});
  });
  vi.stubGlobal('fetch',provider);
  const bindings={...env,IMAGES_BUCKET:{get:async()=>({arrayBuffer:async()=>bytes.buffer})},IMAGES:{input:()=>({transform:()=>({output:async()=>({response:()=>new Response(bytes,{headers:{'content-type':'image/jpeg'}})})})})}} as unknown as typeof env;
  const call=(body:unknown,token='test-admin-route-token') => routeRequest(new Request('https://worker/admin/import-owner-resolution',{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body)}),bindings,{} as ExecutionContext);
  try {
    expect((await call(input,'wrong')).status).toBe(401);
    expect(provider).not.toHaveBeenCalled();
    expect((await call({...input,apply:false})).status).toBe(400);
    expect((await call({...input,ownerGroupId:'foreign'})).status).toBe(409);
    expect((await call({...input,tableId:'foreign'})).status).toBe(409);
    expect(provider).not.toHaveBeenCalled();
    mismatch=true;
    expect(await (await call(input)).json()).toEqual({status:'held',reason:'attachment_mismatch'});
    mismatch=false;
    expect((await repo.listHistoricalHolds(freshRun)).some(x=>x.groupId===groupId)).toBe(true);
    expect(await (await call(input)).json()).toEqual({status:'resolved'});
    const audit=await db.prepare('SELECT evidence_json FROM import_owner_group_resolutions WHERE group_id=?').bind(groupId).first<{evidence_json:string}>();
    expect(audit?.evidence_json).not.toContain('airtableusercontent');
    expect(audit?.evidence_json).not.toContain('signature=secret');
    expect(JSON.parse(audit!.evidence_json).captured.candidate.attachments[0]).toEqual({id:'a'});
    expect((await repo.listHistoricalHolds(freshRun)).some(x=>x.groupId===groupId)).toBe(false);
    expect((await call(input)).status).toBe(409);
    expect((await db.prepare('SELECT count(*) AS n FROM import_owner_group_resolutions WHERE group_id=?').bind(groupId).first<{n:number}>())?.n).toBe(1);
  } finally { vi.unstubAllGlobals(); }
});
