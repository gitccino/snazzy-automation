import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { createLineMutationRepository } from '../db/line-mutation-repository';
import { createLineRepository } from '../db/line-repository';
import { createInventoryClient } from './airtable-inventory';
import { checkLateMutation, executionStatus, recoveryConflictText, type FollowupParams, type RepairResult } from './mutation-recovery';
import { parseConfig } from '../config';
import { createLineClient } from './client';
import { fetchForLineCommand } from '../routes/line';

const checkOptions = { retries:{limit:2,delay:'30 seconds',backoff:'exponential'},timeout:'1 minute' } as const;
type FollowupStep = Pick<WorkflowStep,'do'|'sleepUntil'>;
export async function runMutationFollowup(step: FollowupStep, operations: {
  check():Promise<RepairResult>; notify(key:string):Promise<void>;
  markEnded(state:'ended'|'unresolved'):Promise<void>; now():number; registeredAt?: number;
}) {
  const start = await step.do('monitor-start',async()=>operations.registeredAt ?? operations.now());
  let result: RepairResult = {status:'unchanged'};
  for (const [i,offset] of [30_000,60_000,300_000].entries()) {
    await step.sleepUntil(`check-time-${i}`,new Date(start+offset));
    try { result = await step.do(`check-${i}`,checkOptions,operations.check); }
    catch(error) { console.error('Late mutation check failed',error); result = {status:'unresolved'}; }
  }
  const unresolved = result.status === 'unresolved' || result.status === 'busy';
  await step.do('monitor-ended',()=>operations.markEnded(unresolved?'unresolved':'ended'));
  if (unresolved) {
    const key = await step.do('warning-key',async()=>crypto.randomUUID());
    await step.do('monitor-warning',checkOptions,()=>operations.notify(key));
  }
  return {status:unresolved?'unresolved':'ended'};
}

export class LineMutationFollowupWorkflow extends WorkflowEntrypoint<Env, FollowupParams> {
  async run(event: WorkflowEvent<FollowupParams>, step: WorkflowStep) {
    const thisEnv = this.env;
    const config = parseConfig(this.env.APP_CONFIG_JSON);
    const clock = {now:()=>new Date()};
    const ids = {next:()=>crypto.randomUUID()};
    const mutationRepo = createLineMutationRepository(this.env.DB,clock);
    const inventory = createInventoryClient({baseId:config.airtableBaseId,tableId:config.airtableProductsTableId,token:this.env.AIRTABLE_TOKEN,fetch:fetchForLineCommand});
    return runMutationFollowup(step, {
      now:()=>Date.now(), registeredAt:event.payload.registeredAt,
      check:()=>checkLateMutation(event.payload,event.instanceId,{
        mutationRepo,inventory,ids,repo:createLineRepository(this.env.DB,ids,clock),
        async status(id) {
          try { return executionStatus((await (await thisEnv.LINE_COMMAND_WORKFLOW.get(id)).status()).status); }
          catch { try { return executionStatus((await (await thisEnv.LINE_MUTATION_FOLLOWUP_WORKFLOW.get(id)).status()).status); } catch { return 'unknown'; } }
        },
        registerFollowup:async()=>{throw new Error('Follow-up cannot register another monitor');},
      }),
      markEnded:state=>mutationRepo.markMonitoring(event.payload.pendingToken,state),
      notify:key=>createLineClient({channelAccessToken:this.env.LINE_CHANNEL_ACCESS_TOKEN,fetch:fetchForLineCommand,pushReplies:{groupId:config.lineAllowedGroupId,retryKey:key}})
        .pushMessage(config.lineAllowedGroupId,recoveryConflictText(event.payload.productId)),
    });
  }
}
