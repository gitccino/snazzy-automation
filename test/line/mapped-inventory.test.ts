import {expect,it,vi} from 'vitest';
import {createInventoryClient} from '../../src/line/airtable-inventory';
import {clientProductFieldMap} from '../../src/shared/product-field-map';
import {searchCard} from '../../src/line/search-card';

it.each(['In','Reserve','Out','Rent','Trade','Pledge','New status'])('reads Thai single select values and displays %s',async status=> {
  const client=createInventoryClient({baseId:'app1',tableId:'tbl1',token:'secret',fieldMap:clientProductFieldMap,fetch:(async()=>Response.json({records:[{id:'rec1',fields:{'รหัสสินค้าstock':'A-1','สถานะ':status,'ชื่อแบรนด์':'Brand','ชื่อรุ่น':'Model','วันที่อัพโหลดรูป':'2026-01-01'}}]})) as typeof fetch});
  const product=await client.findByProductId('A-1');
  expect(product).toMatchObject({inventoryStatus:status,brandName:'Brand',modelName:'Model'});
  expect(searchCard(product!,'https://worker.example').text).toContain(status);
  if(!['In','Out'].includes(status)) expect(JSON.stringify(searchCard(product!,'https://worker.example').contents)).toContain(status);
});
it('writes mapped sale/revert values and filters reports to Out only',async()=> {
  const requests:{url:URL;init?:RequestInit}[]=[];
  const fetcher=vi.fn<typeof fetch>(async(input,init)=> {
    requests.push({url:new URL(String(input)),init});
    return Response.json({records:[]});
  });
  const client=createInventoryClient({baseId:'app1',tableId:'tbl1',token:'secret',fieldMap:clientProductFieldMap,fetch:fetcher});
  await client.updateSaleValues('rec1',{inventoryStatus:'Reserve',soldPrice:null,soldAt:null,soldBy:null});
  expect(JSON.parse(String(requests[0]!.init!.body)).fields).toMatchObject({'สถานะ':'Reserve','ราคาขาย':null});
  await client.listSalesForDay('2026-01-01');
  expect(requests[1]!.url.searchParams.get('filterByFormula')).toContain('{สถานะ}="Out"');
  expect(requests[1]!.url.searchParams.getAll('fields[]')).toContain('ราคารับซื้อ');
});
