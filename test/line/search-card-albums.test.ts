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
