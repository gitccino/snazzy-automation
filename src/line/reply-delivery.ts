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
}, deps: {repo:LineReplyRepository;line:Pick<LineClient,'sendReplyMessages'>;clock:Clock;isGroupAllowed(groupId:string):Promise<boolean>})
:Promise<'accepted'|'rejected'|'uncertain'|'ignored'|'duplicate'> {
  const fresh=()=>Number.isFinite(Date.parse(input.receivedAt)) && deps.clock.now().getTime()-Date.parse(input.receivedAt)<=45000;
  if(!input.replyToken.trim() || !fresh() || !await deps.isGroupAllowed(input.groupId))return 'ignored';
  const normal=input.commandReply ? renderCommandReply(input.commandReply,input.publicBaseUrl):[];
  const head=input.drainQueue ? await deps.repo.head(input.groupId):null;
  const candidate=head?.state==='pending' && normal.length+head.result.messages.length<=5 ? head:null;
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
      await retryReplyPersistence(()=>deps.repo.reject(input.eventId,error.disposition));return 'rejected';
    }
    await retryReplyPersistence(()=>deps.repo.markUncertain(input.eventId));return 'uncertain';
  }
  // Receipt persistence is separate: retrying it must never repeat the external send.
  await retryReplyPersistence(()=>deps.repo.accept(input.eventId,receipt.requestId));
  return 'accepted';
}
