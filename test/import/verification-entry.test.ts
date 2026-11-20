import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { claimImportVerification } from '../../src/db/import-repository';
import { importWorkflowId } from '../../src/shared/ids';
import { ImportWorkflow } from '../../src/import/workflow';

it('reads only the claimed verifier evidence without starting an import', async () => {
  const env = testEnv(), runId = crypto.randomUUID(), albumId = crypto.randomUUID();
  const contextJson = JSON.stringify({replyGroupId:'owner'});
  await env.DB.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json,scan_evidence_json) VALUES(?,?,'line','running','now',?,'[]')").bind(runId, albumId, contextJson).run();
  expect(await claimImportVerification(env.DB, {runId, albumId, workflowId:importWorkflowId(runId), groupId:'owner', contextJson})).toBe(true);
  (env as any).IMPORT_WORKFLOW = {get: async () => ({status: async () => ({status:'errored'})})};
  const step = {do: async (_name: string, callback: () => Promise<unknown>) => callback()};
  const run = (instanceId: string) => ImportWorkflow.prototype.run.call({env} as any, {instanceId, payload:{kind:'verification', importRunId:runId}} as any, step as any);
  expect(await run(`import-verification-${runId}`)).toMatchObject({kind:'verification', evidence:{sourceAlbumId:albumId, scan:'complete'}});
  expect(await run('foreign')).toEqual({kind:'verification', evidence:null});
  await env.DB.prepare("UPDATE import_runs SET settings_context_json=? WHERE id=?").bind(JSON.stringify({replyGroupId:'owner', changed:true}), runId).run();
  expect(await run(`import-verification-${runId}`)).toEqual({kind:'verification', evidence:null});
});
