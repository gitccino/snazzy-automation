import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { runPublicationWorkflow } from '../../src/publication/workflow';
import { createLineReplyRepository } from '../../src/db/line-reply-repository';
import { parseConfig } from '../../src/config';
import { createTestEnv } from '../helpers/env';
import type { PublicationServiceDeps } from '../../src/publication/service';

type Params = { runId: string; groupId: string; status: number };
export class BoundaryWorkflow extends WorkflowEntrypoint<{DB:D1Database}, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const {runId, groupId, status} = event.payload;
    const clock = {now: () => new Date()};
    const config = {...parseConfig(createTestEnv().APP_CONFIG_JSON), publicationRetryLimit: 5 as const};
    const deps = {
      db: this.env.DB, clock, config, airtableToken: 'test',
      anthropic: {messages: {countTokens: async () => {
        await this.env.DB.prepare('INSERT INTO boundary_attempts(run_id) VALUES (?)').bind(runId).run();
        throw {status};
      }}},
      fetcher: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('oauth2.googleapis.com')) return Response.json({access_token:'test',expires_in:3600});
        if (url.includes('googleapis.com/drive')) return Response.json({files:[]});
        return Response.json({id:runId,fields:{}});
      },
      googleOAuthCredentials: {clientId:'test',clientSecret:'test',refreshToken:'test'},
      notify: async (text: string, contents?: Record<string,unknown>, outcome = 'success') => {
        await createLineReplyRepository(this.env.DB,clock).enqueueResult({groupId,resultKey:JSON.stringify(['publication',runId,1,1,'terminal']),result:{schemaVersion:1,kind:'publication',runId,generation:1,notificationCycle:1,outcome,messages:[contents ? {type:'flex',altText:text,contents} : {type:'text',text}]} as any});
      },
    } as unknown as PublicationServiceDeps;
    const imageProduct = {airtableRecordId:'rec-product',productId:'A-1001',brandName:'Nike',modelName:'Air',conditionType:'Used',size:'42',description:'test',lineSquarePrice:1,igPrice:1,orderedImageKeys:['1','2','3','4']};
    const harnessStep = new Proxy(step, {get(target, key) {
      if (key !== 'do') return Reflect.get(target,key,target);
      return (name: string, ...args: unknown[]) => name.startsWith('images ') ? Promise.resolve(name.endsWith('replace') ? imageProduct : {}) : target.do(name, args[0] as any, args[1] as any);
    }});
    return runPublicationWorkflow({publicationRunId:runId,trigger:'line'},harnessStep,deps,event.instanceId,{groupId,notificationCycle:1});
  }
}
export default {fetch: () => new Response('ok')};
