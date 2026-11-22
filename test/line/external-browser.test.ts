import {expect,it} from 'vitest';
import {docsSuccessCard,docsValidationFailureCard,docsWorkflowFailureCard,docsUnconfirmedCard} from '../../src/line/docs-summary-card';
import {renderButtons} from '../../src/line/reply-renderer';

it('uses external browser actions on Google Docs and all document Airtable result cards',()=>{
 const publicBaseUrl='https://worker.example';
 const input={thaiDate:'22 พฤศจิกายน 2569',airtableRunUrl:'https://airtable.com/app/tbl/rec#view'};
 const cards=[
  docsSuccessCard({thaiDate:input.thaiDate,productIds:['A-1'],googleDocUrl:'https://docs.google.com/document/d/doc/edit?tab=t.0#heading=h.1'},publicBaseUrl),
  docsValidationFailureCard({...input,validation:{valid:false,productsMissingFields:[{productId:'A-1',missingFields:['Price']}]}},publicBaseUrl),
  docsWorkflowFailureCard({...input,reason:'safe failure'},publicBaseUrl),
  docsUnconfirmedCard(input,publicBaseUrl),
 ];
 for(const card of cards){
  const uri=(card.contents.footer as {contents:{action:{uri:string}}[]}).contents[0]!.action.uri;
  expect(new URL(uri).searchParams.get('openExternalBrowser')).toBe('1');
 }
 const google=new URL((cards[0]!.contents.footer as {contents:{action:{uri:string}}[]}).contents[0]!.action.uri);
 expect(google.searchParams.get('tab')).toBe('t.0');
 expect(google.hash).toBe('#heading=h.1');
 expect(cards[0]!.text).toContain('https://docs.google.com/document/d/doc/edit?tab=t.0#heading=h.1');
});

it('keeps confirmation postbacks unchanged',()=>{
 const result=renderButtons('Confirm','Confirm sale',[{label:'ยืนยัน',data:'approve=123'}]);
 expect(result[0]).toMatchObject({type:'template',template:{actions:[{type:'postback',data:'approve=123',displayText:'ยืนยัน'}]}});
 expect(JSON.stringify(result)).not.toContain('openExternalBrowser');
});
