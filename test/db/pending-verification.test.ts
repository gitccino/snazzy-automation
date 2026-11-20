import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { claimImportVerification } from '../../src/db/import-repository';
import { claimPublicationVerification } from '../../src/db/publication-repository';
import { selectPendingVerification } from '../../src/db/pending-verification';

it('selects at most one current pending claim belonging to the requested group', async () => {
  const db = testEnv().DB, groupId = crypto.randomUUID(), foreign = crypto.randomUUID();
  const runId = crypto.randomUUID(), albumId = crypto.randomUUID(), publicationId = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:groupId});
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json) VALUES(?,?,'line','running','x',?)").bind(runId,albumId,context).run();
  await claimImportVerification(db,{runId,albumId,workflowId:`import-${runId}`,groupId,contextJson:context});
  await db.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES(?,'generating','original','x','x',1,1,?)").bind(publicationId,context).run();
  await claimPublicationVerification(db,{runId:publicationId,generation:1,notificationCycle:1,groupId});
  expect(await selectPendingVerification(db,foreign)).toBeNull();
  expect(await selectPendingVerification(db,groupId)).toMatchObject({kind:'import',runId,groupId});
  await db.prepare('UPDATE import_runs SET settings_context_json=? WHERE id=?').bind('{}',runId).run();
  expect(await selectPendingVerification(db,groupId)).toMatchObject({kind:'publication',runId:publicationId,groupId});
  await db.prepare('UPDATE publication_verification_claims SET completed=1 WHERE publication_run_id=?').bind(publicationId).run();
  expect(await selectPendingVerification(db,groupId)).toBeNull();
});

it('rotates persistent claims across imports and publications independently per group', async () => {
  const db = testEnv().DB, group = crypto.randomUUID(), other = crypto.randomUUID();
  const ids = ['a', 'b'].map(x => `${x}-${crypto.randomUUID()}`), publicationId = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:group});
  for (const id of ids) {
    await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json) VALUES(?,?,'line','running','x',?)").bind(id,id,context).run();
    await claimImportVerification(db,{runId:id,albumId:id,workflowId:`import-${id}`,groupId:group,contextJson:context});
  }
  await db.prepare("INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES(?,'generating','original','x','x',1,1,?)").bind(publicationId,context).run();
  await claimPublicationVerification(db,{runId:publicationId,generation:1,notificationCycle:1,groupId:group});
  const selected = [];
  for (let i=0;i<6;i++) { selected.push((await selectPendingVerification(db,group))?.runId); expect(await selectPendingVerification(db,other)).toBeNull(); }
  expect(selected).toEqual([...ids,publicationId,...ids,publicationId]);
});
