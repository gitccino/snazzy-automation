import { expect,it,vi } from 'vitest';
import { createMessengerAirtable } from '../../src/messenger/airtable';
import { connection,delivery,input,record } from './fixtures';
it('reads every Airtable page including Done rows',async()=>{
 const done={...delivery,id:'d2',recordId:'r2',productId:'A-10',status:'Done' as const,completedAt:'2026-11-14T03:00:00Z',completedByUserId:'book',completedByName:'Book'};
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({records:[record()],offset:'page2'})).mockResolvedValueOnce(Response.json({records:[record(done)]}));
 const rows=await createMessengerAirtable({connection,token:'secret',fetch:fetcher}).list('C1','2026-11-14');
 expect(rows.map(d=>d.status)).toEqual(['Pending','Done']);
 expect(String(fetcher.mock.calls[1]![0])).toContain('offset=page2');
});
it('rejects duplicate product IDs instead of selecting the first',async()=>{
 const api=createMessengerAirtable({connection,token:'secret',fetch:async()=>Response.json({records:[{id:'a',fields:{}},{id:'b',fields:{}}]})});
 await expect(api.findProduct('A-2')).rejects.toThrow();
});
it('rejects repeated offsets, invalid fields and incomplete reads',async()=>{
 for(const body of [{records:[record()],offset:'loop'},{records:[{id:'x',fields:{}}]}]){
  const api=createMessengerAirtable({connection,token:'secret',fetch:async()=>Response.json(body)});
  await expect(api.list('C1','2026-11-14')).rejects.toThrow();
 }
 const api=createMessengerAirtable({connection,token:'secret',fetch:async()=>new Response('private provider detail',{status:500})});
 await expect(api.list('C1','2026-11-14')).rejects.toThrow('Airtable messenger request failed');
});
it('sends only delivery fields and completes without touching inventory',async()=>{
 const fetcher=vi.fn(async (_url:RequestInfo|URL,init?:RequestInit)=>{
  const fields=JSON.parse(String(init?.body)).fields;
  return Response.json({...record(),fields:{...record().fields,...fields}});
 });
 const api=createMessengerAirtable({connection,token:'secret',fetch:fetcher});
 await api.create(input);await api.complete('rec1',{at:'2026-11-14T04:00:00Z',userId:'book',name:'Book'});
 expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body)).fields).toEqual({Status:'Done','Completed At':'2026-11-14T04:00:00Z','Completed By User ID':'book','Completed By Name':'Book'});
 expect(String(fetcher.mock.calls[0]![1]!.body)).not.toMatch(/Inventory Status|Sold Price/);
});
it('escapes formula literals and rejects Done without completion metadata',async()=>{
 const fetcher=vi.fn(async()=>Response.json({records:[]}));
 await createMessengerAirtable({connection,token:'s',fetch:fetcher}).findBySourceEvent("e'\\x");
 expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get('filterByFormula')).toBe("{Source Event ID}='e\\'\\\\x'");
 const api=createMessengerAirtable({connection,token:'s',fetch:async()=>Response.json(record({...delivery,status:'Done'}))});
 await expect(api.get('rec1')).rejects.toThrow();
});
