import { describe, it, expect } from 'vitest';
import { productFieldMapSchema, productFieldFetch, clientProductFieldMap } from '../../src/shared/product-field-map';

describe('product field mapping', () => {
  it('rejects collisions including defaults and formula delimiters', () => {
    expect(productFieldMapSchema.safeParse({'Product ID':'Sold Price'}).success).toBe(false);
    expect(productFieldMapSchema.safeParse({'Product ID':'bad}name'}).success).toBe(false);
    expect(productFieldMapSchema.safeParse({'Typo':'name'}).success).toBe(false);
  });
  it('maps product queries, writes and responses without changing quoted literals or other tables', async () => {
    const calls: {url:URL; init?:RequestInit}[]=[];
    const wrapped=productFieldFetch((async(input,init)=> {
      calls.push({url:new URL(String(input)),init});
      return Response.json({records:[{id:'rec1',fields:{'รหัสสินค้าstock':'A-1','สถานะ':'Reserve','ชื่อแบรนด์':'Brand'}}]});
    }) as typeof fetch, {airtableBaseId:'app1',airtableProductsTableId:'tbl1',airtableProductFieldMap:clientProductFieldMap});
    const url=new URL('https://api.airtable.com/v0/app1/tbl1');
    url.searchParams.set('filterByFormula',`AND({Product ID}='literal {Product ID}',{Inventory Status}="In")`);
    url.searchParams.append('fields[]','Brand Name');
    const response=await wrapped(url.toString(),{method:'PATCH',body:JSON.stringify({fields:{'Inventory Status':'Out'}})});
    expect(calls[0]!.url.searchParams.get('filterByFormula')).toBe(`AND({รหัสสินค้าstock}='literal {Product ID}',{สถานะ}="In")`);
    expect(calls[0]!.url.searchParams.get('fields[]')).toBe('ชื่อแบรนด์');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({fields:{'สถานะ':'Out'}});
    expect((await response.json() as any).records[0].fields).toEqual({'Product ID':'A-1','Inventory Status':'Reserve','Brand Name':'Brand'});
    await wrapped('https://api.airtable.com/v0/app1/tblOther?fields%5B%5D=Product+ID');
    expect(calls[1]!.url.searchParams.get('fields[]')).toBe('Product ID');
  });
});

it('preserves provider rejection and malformed responses',async()=> {
  const config={airtableBaseId:'app1',airtableProductsTableId:'tbl1',airtableProductFieldMap:clientProductFieldMap};
  const rejected=new Response('private error',{status:429});
  expect(await productFieldFetch((async()=>rejected) as typeof fetch,config)('https://api.airtable.com/v0/app1/tbl1')).toBe(rejected);
  const malformed=new Response('{');
  expect(await productFieldFetch((async()=>malformed) as typeof fetch,config)('https://api.airtable.com/v0/app1/tbl1')).toBe(malformed);
});
it('normalizes metadata for only the configured product table',async()=> {
  const response=await productFieldFetch((async()=>Response.json({tables:[{id:'tbl1',fields:[{name:'ชื่อแบรนด์',type:'singleSelect'}]},{id:'tblOther',fields:[{name:'ชื่อแบรนด์'}]}]})) as typeof fetch,{airtableBaseId:'app1',airtableProductsTableId:'tbl1',airtableProductFieldMap:clientProductFieldMap})('https://api.airtable.com/v0/meta/bases/app1/tables');
  const body=await response.json() as any;
  expect(body.tables[0].fields[0]).toEqual({name:'Brand Name',type:'singleSelect'});
  expect(body.tables[1].fields[0].name).toBe('ชื่อแบรนด์');
});

it('supports nested adapters without translating twice', async()=> {
  const config={airtableBaseId:'app1',airtableProductsTableId:'tbl1',airtableProductFieldMap:{'Brand Name':'Model Name','Model Name':'Brand Name'}};
  let sent:any;
  const base=(async(_input:any,init:any)=> {sent=JSON.parse(init.body);return Response.json({fields:{'Model Name':'Brand'}});}) as typeof fetch;
  const fetcher=productFieldFetch(productFieldFetch(base,config),config);
  const response=await fetcher('https://api.airtable.com/v0/app1/tbl1',{method:'PATCH',body:JSON.stringify({fields:{'Brand Name':'Brand'}})});
  expect(sent).toEqual({fields:{'Model Name':'Brand'}});
  expect(await response.json()).toEqual({fields:{'Brand Name':'Brand'}});
});

it('maps the real import and publication product adapters',async()=> {
  const {createAirtableProductsClient}=await import('../../src/import/airtable-products');
  const {readProductAttachments,replaceProductImages}=await import('../../src/publication/airtable-runs');
  const calls:any[]=[];
  const fetcher=(async(input,init)=> {
    calls.push({url:String(input),init});
    return Response.json({id:'rec1',fields:{'รหัสสินค้าstock':'A-1','รูปสินค้า':[{id:'att1',url:'https://example.test/image.jpg',filename:'photo.jpg'}]}});
  }) as typeof fetch;
  const config={airtableBaseId:'app1',airtableProductsTableId:'tbl1',airtablePublicationRunsTableId:'tbl2',airtableProductFieldMap:clientProductFieldMap};
  const client=createAirtableProductsClient({baseId:'app1',tableId:'tbl1',token:'token',fetch:fetcher,fieldMap:clientProductFieldMap});
  await client.createProduct({productId:'A-1',systemGroupId:'hash',uploadDate:'2026-01-01',productImages:[]});
  expect(JSON.parse(calls[0].init.body).fields).toMatchObject({'รหัสสินค้าstock':'A-1','สถานะ':'In','รูปสินค้า':[]});
  await readProductAttachments(fetcher,config,'token','rec1');
  await replaceProductImages(fetcher,config,'token','rec1',[]);
  expect(JSON.parse(calls[2].init.body).fields).toEqual({'รูปสินค้า':[]});
});

it('preserves unrelated field names that match Object prototype properties', async()=> {
  const wrapped=productFieldFetch((async()=>Response.json({fields:{constructor:'unrelated','รหัสสินค้าstock':'A-1'}})) as typeof fetch,{airtableBaseId:'app1',airtableProductsTableId:'tbl1',airtableProductFieldMap:clientProductFieldMap});
  expect(await (await wrapped('https://api.airtable.com/v0/app1/tbl1')).json()).toEqual({fields:{constructor:'unrelated','Product ID':'A-1'}});
});
