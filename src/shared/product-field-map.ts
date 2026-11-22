import { z } from 'zod';
import type { Fetcher } from './http';

export const productFields = ['Product ID','System Group ID','Upload Date','Product Images','Inventory Status','4-in-1 Image','Publication Run','Sold Price','Sold At','Sold By','Last System Update','Brand Name','Model Name','Condition Type','Size','Description','LINE Square Price','IG Price','Product Cost','Data Complete','Missing Fields'] as const;
export const productFieldMapSchema = z.partialRecord(z.enum(productFields), z.string().trim().min(1).max(200).regex(/^[^{}\x00-\x1f]+$/)).superRefine((map,ctx) => {
  const names=productFields.map(field=>map[field] ?? field);
  if(new Set(names).size!==names.length) ctx.addIssue({code:'custom',message:'Product field names must be unique, including unmapped fields'});
});
export type ProductFieldMap = z.infer<typeof productFieldMapSchema>;
export const clientProductFieldMap:ProductFieldMap = {'Product ID':'รหัสสินค้าstock','Upload Date':'วันที่อัพโหลดรูป','Product Images':'รูปสินค้า','Inventory Status':'สถานะ','Sold Price':'ราคาขาย','Brand Name':'ชื่อแบรนด์','Model Name':'ชื่อรุ่น','Description':'รายละเอียดสินค้า','LINE Square Price':'ราคาLinesquare','IG Price':'ราคาIG','Product Cost':'ราคารับซื้อ'};
export interface ProductFieldConfig {airtableBaseId:string;airtableProductsTableId:string;airtableProductFieldMap?:ProductFieldMap}

const originalFetchers=new WeakMap<Fetcher,Fetcher>();
export function productFieldFetch(fetcher:Fetcher, config:ProductFieldConfig):Fetcher {
  fetcher=originalFetchers.get(fetcher) ?? fetcher;
  const map=productFieldMapSchema.parse(config.airtableProductFieldMap ?? {});
  if(!Object.keys(map).length) return fetcher;
  const reverse=Object.fromEntries(Object.entries(map).map(([key,value])=>[value,key]));
  const rename=(fields:Record<string,unknown>, names:Record<string,string>)=> {
    const entries=Object.entries(fields).map(([key,value])=>[Object.hasOwn(names,key) ? names[key]! : key,value] as const);
    if(new Set(entries.map(([key])=>key)).size!==entries.length) throw new Error('airtable_product_fields_ambiguous');
    return Object.fromEntries(entries);
  };
  const records=(body:any,names:Record<string,string>)=> {
    if(body && typeof body==='object') {
      if(body.fields && typeof body.fields==='object' && !Array.isArray(body.fields)) body.fields=rename(body.fields,names);
      if(Array.isArray(body.records)) body.records=body.records.map((record:any)=>records(record,names));
    }
    return body;
  };
  const wrapped=(async(input,init)=> {
    const url=new URL(input instanceof Request ? input.url : String(input));
    if(url.origin!=='https://api.airtable.com') return fetcher(input,init);
    const parts=url.pathname.split('/').map(decodeURIComponent);
    const product=parts[1]==='v0' && parts[2]===config.airtableBaseId && parts[3]===config.airtableProductsTableId;
    const metadata=parts[2]==='meta' && parts[3]==='bases' && parts[4]===config.airtableBaseId && parts[5]==='tables';
    if(!product && !metadata) return fetcher(input,init);
    // All callers use URL strings; a Request must keep its method, headers and body.
    let options=init;
    if(input instanceof Request) {
      const request=new Request(input,init);
      options={method:request.method,headers:request.headers,signal:request.signal,
        ...(!['GET','HEAD'].includes(request.method) ? {body:await request.text()} : {})};
    }
    if(product) {
      const params=new URLSearchParams();
      for(const [key,value] of url.searchParams) {
        let translated=value;
        if(key==='fields[]' || /^sort\[\d+\]\[field\]$/.test(key)) translated=map[value as keyof ProductFieldMap] ?? value;
        if(key==='filterByFormula') translated=value.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\{([^{}]+)\}/g,(token,field:string|undefined)=>field ? `{${map[field as keyof ProductFieldMap] ?? field}}` : token);
        params.append(key,translated);
      }
      url.search=params.toString();
      if(typeof options?.body==='string') options={...options,body:JSON.stringify(records(JSON.parse(options.body),map))};
    }
    const response=await fetcher(url.toString(),options);
    if(!response.ok || response.status===204) return response;
    // Malformed responses remain failures at the existing adapter's validation boundary.
    let body:any;
    try { body=await response.clone().json(); } catch { return response; }
    if(product) records(body,reverse);
    else if(Array.isArray(body?.tables)) for(const table of body.tables) if(table.id===config.airtableProductsTableId && Array.isArray(table.fields)) for(const field of table.fields) field.name=Object.hasOwn(reverse,field.name) ? reverse[field.name] : field.name;
    const headers=new Headers(response.headers);
    headers.delete('content-length'); headers.delete('content-encoding'); headers.delete('etag');
    return new Response(JSON.stringify(body),{status:response.status,statusText:response.statusText,headers});
  }) as Fetcher;
  originalFetchers.set(wrapped,fetcher);
  return wrapped;
}
