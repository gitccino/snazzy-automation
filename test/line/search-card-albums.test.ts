import {expect,it} from 'vitest';
import {searchCard} from '../../src/line/search-card';
import {validateReplyMessages} from '../../src/line/client';

it.each([1,2])('places %i album names in black below the upload date, without a heading',count=>{
 const albums=Array.from({length:count},(_,i)=>({sourceAlbumId:String(i),name:i?'Shared album 56':'Snazzy mock album II',url:null,startDate:null,endDate:null}));
 const card=searchCard({recordId:'rec1',productId:'A-12686',inventoryStatus:'In',soldPrice:null,soldAt:null,soldBy:null,uploadDate:'2026-11-22',airtableUrl:'https://airtable.com/rec1'},'https://worker.example',{status:'found',basis:count===1?'source':'date',albums});
 const body=card.contents.body as {contents:Record<string,unknown>[]};
 const details=body.contents[1] as {contents:Record<string,unknown>[]};
 expect(details.contents.at(-2)).toMatchObject({contents:[{text:'วันที่อัปโหลด'},{text:'22/11/2026',align:'end'}]});
 expect(details.contents.at(-1)).toMatchObject({type:'text',text:albums.map(a=>a.name).join('\n'),color:'#2C2C2C',align:'end',wrap:true,margin:'xs'});
 expect(JSON.stringify(card.contents)).not.toContain('"text":"อัลบั้ม iCloud');
 expect(JSON.stringify(card.contents).includes('สินค้านี้อาจอยู่ในอัลบั้มใดอัลบั้มหนึ่ง')).toBe(count===2);
 expect(card.text).toContain('Snazzy mock album II');
 validateReplyMessages([{type:'flex',altText:card.text,contents:card.contents}]);
});

it('requests an external browser for search actions while preserving query values and album fragments',()=>{
 const product={recordId:'rec1',productId:'A-1',inventoryStatus:'In' as const,soldPrice:null,soldAt:null,soldBy:null,uploadDate:null,airtableUrl:'https://airtable.com/app/tbl/rec?view=Grid%20View&openExternalBrowser=0#details'};
 const albums=[
  {sourceAlbumId:'1',name:'Legacy album',url:'https://www.icloud.com/sharedalbum/#D1zv3AbC_def-123',startDate:null,endDate:null},
  {sourceAlbumId:'2',name:'Current album',url:'https://photos.icloud.com/shared/album/AbC_def-123',startDate:null,endDate:null},
 ];
 const card=searchCard(product,'https://worker.example',{status:'found',basis:'date',albums});
 const buttons=(card.contents.footer as {contents:{action:{uri:string}}[]}).contents;
 const urls=buttons.map(b=>new URL(b.action.uri));
 expect(urls.map(u=>u.searchParams.getAll('openExternalBrowser'))).toEqual([['1'],['1'],['1']]);
 expect(urls[0]!.searchParams.get('view')).toBe('Grid View');
 expect(urls[0]!.hash).toBe('#details');
 expect(urls[1]!.hash).toBe('#D1zv3AbC_def-123');
 expect(buttons[1]!.action.uri).toBe('https://www.icloud.com/sharedalbum/?openExternalBrowser=1#D1zv3AbC_def-123');
 expect(urls[2]!.pathname).toBe('/shared/album/AbC_def-123');
 expect(albums[0]!.url).toBe('https://www.icloud.com/sharedalbum/#D1zv3AbC_def-123');
 validateReplyMessages([{type:'flex',altText:card.text,contents:card.contents}]);
});

it('requests external opening for Airtable actions on soldout cards',async()=>{
 const {alreadyOutCard,saleSuccessCard}=await import('../../src/line/search-card');
 const product={recordId:'rec1',productId:'A-1',inventoryStatus:'Out' as const,soldPrice:100,soldAt:null,soldBy:null,uploadDate:null,airtableUrl:'https://airtable.com/app/tbl/rec'};
 for(const card of [alreadyOutCard(product,'https://worker.example'),saleSuccessCard('A-1',100,'https://worker.example',product)]) {
  expect((card.contents.footer as {contents:{action:{uri:string}}[]}).contents[0]!.action.uri).toBe(product.airtableUrl+"?openExternalBrowser=1");
 }
});
