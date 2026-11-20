import { docsUnconfirmedCard } from './docs-summary-card';
import type { createWorkflowFeedbackRepository } from '../db/workflow-feedback';
import type { LineReplyRepository } from '../db/line-reply-repository';
import type { Clock } from '../shared/time';
import { LineReplyError, validateReplyMessages, type LineClient } from './client';
import { renderCommandReply } from './reply-renderer';
import type { CommandReply } from './soldout';

export async function retryReplyPersistence<T>(operation:()=>Promise<T>):Promise<T> {
  for(let attempt=0;;attempt++) {
    try { return await operation(); }
    catch(error) { if(attempt===2)throw error; await new Promise(resolve=>setTimeout(resolve,1000)); }
  }
}
export async function deliverEventReply(input: {
  eventId:string; groupId:string; workflowId:string; receivedAt:string; replyToken:string;
  commandReply:CommandReply|null; drainQueue:boolean; publicBaseUrl:string;
}, deps: {repo:LineReplyRepository;line:Pick<LineClient,'sendReplyMessages'>;clock:Clock;isGroupAllowed(groupId:string):Promise<boolean>;feedback?:ReturnType<typeof createWorkflowFeedbackRepository>})
:Promise<'accepted'|'rejected'|'uncertain'|'ignored'|'duplicate'> {
  const fresh=()=>Number.isFinite(Date.parse(input.receivedAt)) && deps.clock.now().getTime()-Date.parse(input.receivedAt)<=45000;
  if(!input.replyToken.trim() || !fresh() || !await deps.isGroupAllowed(input.groupId))return 'ignored';
  const normal=input.commandReply ? renderCommandReply(input.commandReply,input.publicBaseUrl):[];
  if(input.drainQueue && deps.feedback) {
    try {
      const rows=await deps.feedback.pendingByGroup(input.groupId,1);
      const row=rows[0] as {kind:string;run_id:string;generation:number;notification_cycle:number;result_key:string;outcome_json:string}|undefined;
      if(row) {
        if(!await deps.feedback.hasOutbox(row.result_key,input.groupId)) {
          const outcome=JSON.parse(row.outcome_json) as {outcome?:string;references?:{thaiDate?:string;airtableRunUrl?:string;publicBaseUrl?:string}};
          const facts=outcome.references;
          if(row.kind==='publication' && outcome.outcome==='unconfirmed' && facts?.thaiDate && facts.airtableRunUrl && facts.publicBaseUrl) {
            const card=docsUnconfirmedCard({thaiDate:facts.thaiDate,airtableRunUrl:facts.airtableRunUrl},facts.publicBaseUrl);
            await deps.repo.enqueueResult({resultKey:row.result_key,groupId:input.groupId,result:{schemaVersion:1,kind:'publication',runId:row.run_id,generation:row.generation,notificationCycle:row.notification_cycle,outcome:'unconfirmed',messages:[{type:'flex',altText:card.text,contents:card.contents}]}});
          }
        }
        await deps.feedback.markMaterialized(row.result_key,input.groupId);
      }
    } catch(error) { console.error('workflow_feedback_repair_failed',error); }
  }
  if(input.drainQueue && deps.feedback) {
    try {
      const row=await deps.feedback.publicationHead(input.groupId);
      if(row && row.result_key===JSON.stringify(['publication',row.run_id,row.generation,row.notification_cycle,'terminal'])) {
        let malformed=false;
        try { const result=JSON.parse(row.result_json); validateReplyMessages(result.messages); } catch { malformed=true; }
        if(malformed) {
          const outcome=JSON.parse(row.outcome_json) as {outcome?:string;references?:{thaiDate?:string;airtableRunUrl?:string;publicBaseUrl?:string}};
          const facts=outcome.references;
          if(outcome.outcome==='unconfirmed' && facts?.thaiDate && facts.airtableRunUrl && facts.publicBaseUrl) {
            const card=docsUnconfirmedCard({thaiDate:facts.thaiDate,airtableRunUrl:facts.airtableRunUrl},facts.publicBaseUrl);
            await deps.feedback.replaceUnsentHead(input.groupId,row.sequence,row.result_json,{schemaVersion:1,kind:'publication',runId:row.run_id,generation:row.generation,notificationCycle:row.notification_cycle,outcome:'unconfirmed',messages:[{type:'flex',altText:card.text,contents:card.contents}]});
          }
        }
      }
    } catch(error) { console.error('workflow_feedback_repair_failed',error); }
  }
  let head:Awaited<ReturnType<LineReplyRepository['head']>>=null;
  try { if(input.drainQueue) head=await deps.repo.head(input.groupId); }
  catch(error) { if(!(error instanceof SyntaxError))throw error; }
  let candidate:typeof head=null;
  if(head?.state==='pending') {
    try {
      validateReplyMessages(head.result.messages);
      if(normal.length+head.result.messages.length<=5)candidate=head;
    } catch { /* Keep the malformed head for owner inspection. */ }
  }
  let messages=candidate ? [...normal,...candidate.result.messages]:normal;
  if(!messages.length)return 'ignored';
  validateReplyMessages(messages);
  const prepare=(sequence:number|null)=>deps.repo.prepareDispatch({...input,candidateSequence:sequence,messages});
  let prepared=await prepare(candidate?.sequence??null);
  if(prepared==='head_changed') {
    if(!normal.length)return 'ignored';
    messages=normal; prepared=await prepare(null);
  }
  if(prepared!=='prepared')return 'duplicate';
  if(!fresh() || !await deps.isGroupAllowed(input.groupId)) {
    await deps.repo.abandonPrepared(input.eventId);return 'ignored';
  }
  if(!await deps.repo.beginDispatch(input.eventId))return 'duplicate';
  let receipt:{requestId:string|null};
  try { receipt=await deps.line.sendReplyMessages(input.replyToken,messages); }
  catch(error) {
    if(error instanceof LineReplyError && error.classification==='definite_rejection') {
      await retryReplyPersistence(()=>deps.repo.reject(input.eventId,error.disposition,{status:error.status,requestId:error.requestId}));return 'rejected';
    }
    await retryReplyPersistence(()=>deps.repo.markUncertain(input.eventId,error instanceof LineReplyError?{status:error.status,requestId:error.requestId}:undefined));return 'uncertain';
  }
  // Receipt persistence is separate: retrying it must never repeat the external send.
  await retryReplyPersistence(()=>deps.repo.accept(input.eventId,receipt.requestId));
  return 'accepted';
}
