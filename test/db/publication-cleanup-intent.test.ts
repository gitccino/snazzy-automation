import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { acquireOrResumeJob, admitPublicationCleanup, claimPublicationVerification, readPublicationCleanupCandidate } from '../../src/db/publication-repository';

it('captures an owned cleanup once and fences conflicting attempts', async () => {
  const db = testEnv().DB, id = crypto.randomUUID();
  await acquireOrResumeJob(db, { now: () => new Date() }, id, 'owner');
  await db.prepare('UPDATE publication_jobs SET settings_context_json=? WHERE publication_run_id=?').bind('{"context":1}', id).run();
  expect(await admitPublicationCleanup(db, id, 1, 1, 'other', 'doc')).toBe(false);
  expect(await admitPublicationCleanup(db, id, 1, 1, 'owner', 'doc')).toBe(true);
  expect(await admitPublicationCleanup(db, id, 1, 1, 'owner', 'doc')).toBe(true);
  expect(await admitPublicationCleanup(db, id, 1, 1, 'owner', 'other-doc')).toBe(false);
  expect(await db.prepare('SELECT origin_workflow_id, context_json, doc_id FROM publication_cleanup_intents WHERE publication_run_id=?').bind(id).first()).toEqual({origin_workflow_id:'owner', context_json:'{"context":1}', doc_id:'doc'});
  await db.prepare('UPDATE publication_jobs SET finalization_json=? WHERE publication_run_id=?').bind('{}', id).run();
  expect(await admitPublicationCleanup(db, id, 1, 1, 'owner', 'doc')).toBe(false);
  await db.prepare('UPDATE publication_jobs SET finalization_json=NULL, google_doc_id=? WHERE publication_run_id=?').bind('doc', id).run();
  expect(await admitPublicationCleanup(db, id, 1, 1, 'owner', 'doc')).toBe(false);
});

it('reads cleanup only for the active matching verifier and conflict-free job', async () => {
  const db = testEnv().DB, id = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:'group', settings:{config:{googleDriveFolderId:'folder'}}});
  await acquireOrResumeJob(db, {now:()=>new Date()}, id, 'owner');
  await db.prepare('UPDATE publication_jobs SET settings_context_json=? WHERE publication_run_id=?').bind(context,id).run();
  expect(await admitPublicationCleanup(db,id,1,1,'owner','doc')).toBe(true);
  const attempt = {runId:id,generation:1,notificationCycle:1,groupId:'group'};
  const claim = await claimPublicationVerification(db,attempt);
  if (claim.status !== 'claimed') throw new Error('expected claim');
  expect(await readPublicationCleanupCandidate(db,attempt,claim.verifierId)).toEqual({origin_workflow_id:'owner',context_json:context,doc_id:'doc',folder_id:'folder'});
  expect(await readPublicationCleanupCandidate(db,{...attempt,groupId:'other'},claim.verifierId)).toBeNull();
  expect(await readPublicationCleanupCandidate(db,attempt,'stale')).toBeNull();
  for (const update of ["generation=2", "correlation_id='other'", "settings_context_json='{}'", "finalization_json='{}'", "google_doc_id='doc'", "successful_generation=1"]) {
    await db.prepare(`UPDATE publication_jobs SET ${update} WHERE publication_run_id=?`).bind(id).run();
    expect(await readPublicationCleanupCandidate(db,attempt,claim.verifierId)).toBeNull();
    await db.prepare("UPDATE publication_jobs SET generation=1, correlation_id='owner', settings_context_json=?, finalization_json=NULL, google_doc_id=NULL, successful_generation=0 WHERE publication_run_id=?").bind(context,id).run();
  }
});
