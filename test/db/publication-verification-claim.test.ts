import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { claimPublicationVerification } from '../../src/db/publication-repository';

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
