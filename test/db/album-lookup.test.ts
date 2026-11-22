import { expect, it } from 'vitest';
import { testEnv, createTestEnv } from '../helpers/env';
import { lookupProductAlbum } from '../../src/db/album-lookup';
const albums = [{sourceAlbumId:'album32',name:'Shared album 32',url:null,startDate:null,endDate:null}, {sourceAlbumId:'album33',name:'Shared album 33',url:null,startDate:'2026-01-01',endDate:'2026-12-31'}];
const target = {baseId:'app1',tableId:'tbl1'};
it('uses exact saved product, record and captured target before date mapping', async () => {
 const db=testEnv().DB, id=crypto.randomUUID(), productId=`A-${Date.now()}`, recordId=crypto.randomUUID();
 await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json) VALUES (?, 'album32','admin','completed','now',?)").bind(id,JSON.stringify({settings:{config:{airtableBaseId:'app1',airtableProductsTableId:'tbl1'}}})).run();
 await db.prepare("INSERT INTO product_groups(id,import_run_id,ordinal,group_hash,state,product_id,airtable_record_id,first_photo_id,last_photo_id,created_at,updated_at) VALUES (?,?,1,?,'succeeded',?,?,'p1','p2','now','now')").bind(id,id,id,productId,recordId).run();
 const product={productId,recordId,uploadDate:'2026-03-01'};
 expect(await lookupProductAlbum(db,target,product,albums)).toMatchObject({basis:'source',albums:[albums[0]]});
 expect(await lookupProductAlbum(db,{...target,baseId:'other'},product,albums)).toMatchObject({basis:'date',albums:[albums[1]]});
 expect(await lookupProductAlbum(db,target,{...product,recordId:'other'},albums)).toMatchObject({basis:'date'});
 expect(await lookupProductAlbum(db,target,product,[albums[1]!])).toEqual({status:'unknown'});
});
it('contains dependency errors and does not expose them or guess from the date',async()=>{
 const db={prepare(){throw new Error('secret-provider-body')}} as unknown as D1Database;
 expect(await lookupProductAlbum(db,target,{productId:'A-1',recordId:'rec1',uploadDate:'2026-03-01'},albums)).toEqual({status:'unavailable'});
});

it('wires real command dependencies to the captured registry and preserves a product reply on D1 failure', async()=>{
 const {createWebhookDeps}=await import('../../src/routes/line');
 const {captureOperationContext}=await import('../../src/settings/runtime');
 const {handleReadOnlyCommand}=await import('../../src/line/search');
 const {validateReplyMessages}=await import('../../src/line/client');
 const environment={...testEnv(),...createTestEnv(),CONFIGURATION_MODE:"legacy" as const};
 const context=await captureOperationContext(environment,'CtestGroup');
 context.settings.config.icloudAlbums=albums;
 const deps=await createWebhookDeps(environment,undefined,context);
 deps.inventory.findByProductId=async()=>({recordId:'legacy',productId:'A-1',uploadDate:'2026-02-01',inventoryStatus:'In',soldPrice:null,soldAt:null,soldBy:null,airtableUrl:'https://airtable.com/record'});
 const reply=await handleReadOnlyCommand({type:'search',productId:'A-1'},deps);
 expect(JSON.stringify(reply)).toContain('Shared album 33');
 if(typeof reply==='string')throw new Error('Expected Flex');
 validateReplyMessages([{type:'flex',altText:reply.text,contents:reply.contents}]);
 const unavailable=await createWebhookDeps({...environment,DB:{prepare(){throw new Error('sensitive')}} as unknown as D1Database},undefined,context);
 unavailable.inventory=deps.inventory;
 const failure=JSON.stringify(await handleReadOnlyCommand({type:'search',productId:'A-1'},unavailable));
 expect(failure).toContain('ตรวจสอบอัลบั้ม iCloud ไม่สำเร็จ');
 expect(failure).toContain('เปิดใน Airtable');
 expect(failure).not.toContain('sensitive');
});
