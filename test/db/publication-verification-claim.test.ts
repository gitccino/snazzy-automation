import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { claimPublicationVerification, completePublicationVerification } from '../../src/db/publication-repository';

const db = testEnv().DB;

it('claims one verifier for concurrent requests using captured context', async () => {
  const runId = crypto.randomUUID();
  const context = JSON.stringify({ replyGroupId: 'owner', settings: { config: { airtableBaseId: 'original' } } });
  await db.prepare("INSERT INTO publication_jobs (publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','workflow','x','x',2,3,?)").bind(runId, context).run();
  const request = { runId, generation: 2, notificationCycle: 3, groupId: 'owner' };
  const results = await Promise.all([claimPublicationVerification(db, request), claimPublicationVerification(db, request)]);
  expect(results.filter(r => r.status === 'claimed')).toHaveLength(1);
  expect(results.filter(r => r.status === 'held')).toEqual([{ status: 'held' }]);
  const row = await db.prepare('SELECT * FROM publication_verification_claims WHERE publication_run_id=?').bind(runId).first();
  expect(row).toMatchObject({ generation: 2, notification_cycle: 3, group_id: 'owner', context_json: context, origin_workflow_id: 'workflow' });
  expect(results.find(r => r.status === 'claimed')).toMatchObject({ verifierId: row?.verifier_id });
  expect(await claimPublicationVerification(db, request)).toEqual({ status: 'held' });
});

it('holds stale attempts and foreign groups without exposing captured target', async () => {
  const runId = crypto.randomUUID();
  await db.prepare("INSERT INTO publication_jobs (publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','workflow','x','x',2,3,?)").bind(runId, JSON.stringify({replyGroupId:'owner', target:'secret'})).run();
  for (const request of [{generation:1, notificationCycle:3, groupId:'owner'}, {generation:2, notificationCycle:2, groupId:'owner'}, {generation:2, notificationCycle:3, groupId:'foreign'}]) {
    expect(await claimPublicationVerification(db, {runId, ...request})).toEqual({status:'held'});
  }
  expect(await db.prepare('SELECT * FROM publication_verification_claims WHERE publication_run_id=?').bind(runId).first()).toBeNull();
});

it('renews only a confirmed interrupted verifier and fences late completion', async () => {
  const runId = crypto.randomUUID();
  await db.prepare("INSERT INTO publication_jobs (publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','workflow','x','x',2,3,?)").bind(runId, JSON.stringify({replyGroupId:'owner'})).run();
  const request = {runId, generation:2, notificationCycle:3, groupId:'owner'};
  const first = await claimPublicationVerification(db, request);
  if (first.status !== 'claimed') throw new Error('expected claim');
  for (const status of ['active', 'unavailable', 'terminal'] as const) {
    expect(await claimPublicationVerification(db, request, {verifierId:first.verifierId, status})).toEqual({status:'held'});
  }
  const results = await Promise.all([1,2].map(() => claimPublicationVerification(db, request, {verifierId:first.verifierId, status:'interrupted'})));
  const renewed = results.find(r => r.status === 'claimed');
  expect(results.filter(r => r.status === 'claimed')).toHaveLength(1);
  if (!renewed || renewed.status !== 'claimed') throw new Error('expected renewal');
  expect(renewed.verifierId).not.toBe(first.verifierId);
  const result = {schemaVersion:1, kind:'publication', runId, generation:2, notificationCycle:3, outcome:'success', messages:[{type:'text', text:'original'}]} as const;
  const intent = {originWorkflowId:renewed.originWorkflowId, contextJson:renewed.contextJson, result: {...result, messages: [...result.messages]}};
  expect(await completePublicationVerification(db, request, first.verifierId, intent)).toBe(false);
  expect(await completePublicationVerification(db, request, renewed.verifierId, {...intent, contextJson:'{}'})).toBe(false);
  await db.prepare('UPDATE publication_jobs SET settings_context_json=? WHERE publication_run_id=?').bind(JSON.stringify({replyGroupId:'owner', target:'changed'}), runId).run();
  expect(await completePublicationVerification(db, request, renewed.verifierId, intent)).toBe(false);
  await db.prepare('UPDATE publication_jobs SET settings_context_json=? WHERE publication_run_id=?').bind(renewed.contextJson, runId).run();
  await expect(completePublicationVerification(db, request, renewed.verifierId, {...intent, result:{...intent.result, runId:'other'}})).rejects.toThrow('verification_invalid_result');
  expect(await completePublicationVerification(db, request, renewed.verifierId, intent)).toBe(true);
  expect(await completePublicationVerification(db, request, renewed.verifierId, {...intent, result:{...intent.result, messages:[{type:'text', text:'replacement'}]}})).toBe(false);
  const saved = await db.prepare('SELECT result_json FROM publication_verification_claims WHERE publication_run_id=?').bind(runId).first<{result_json:string}>();
  expect(JSON.parse(saved!.result_json)).toEqual(result);
  expect(await claimPublicationVerification(db, request, {verifierId:renewed.verifierId, status:'interrupted'})).toEqual({status:'held'});
});

it('keeps absent recovery fenced to the owner and current attempt', async () => {
  const runId = crypto.randomUUID();
  await db.prepare("INSERT INTO publication_jobs (publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,'generating','workflow','x','x',2,3,?)").bind(runId, JSON.stringify({replyGroupId:'owner'})).run();
  const request = {runId, generation:2, notificationCycle:3, groupId:'owner'};
  const first = await claimPublicationVerification(db, request);
  if (first.status !== 'claimed') throw new Error('expected claim');
  const observation = {verifierId:first.verifierId, status:'absent'} as const;
  expect(await claimPublicationVerification(db, {...request, groupId:'foreign'}, observation)).toEqual({status:'held'});
  expect(await claimPublicationVerification(db, request, {...observation, verifierId:'stale'})).toEqual({status:'held'});
  await db.prepare('UPDATE publication_jobs SET generation=3 WHERE publication_run_id=?').bind(runId).run();
  expect(await claimPublicationVerification(db, request, observation)).toEqual({status:'held'});
  expect(await completePublicationVerification(db, request, first.verifierId)).toBe(false);
});
