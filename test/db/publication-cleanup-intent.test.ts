import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { acquireOrResumeJob, admitPublicationCleanup, claimPublicationVerification, claimPublicationCleanupDispatch, recordPublicationCleanupReceipt, readPublicationCleanupCandidate, readPublicationCleanupReceipt, readPublicationCleanupFailure } from '../../src/db/publication-repository';

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
  expect(await readPublicationCleanupCandidate(db,attempt,claim.verifierId,false)).toEqual({origin_workflow_id:'owner',context_json:context,doc_id:'doc',folder_id:'folder'});
  expect(await readPublicationCleanupCandidate(db,{...attempt,groupId:'other'},claim.verifierId,false)).toBeNull();
  expect(await readPublicationCleanupCandidate(db,attempt,'stale',false)).toBeNull();
  for (const update of ["generation=2", "correlation_id='other'", "settings_context_json='{}'", "finalization_json='{}'", "google_doc_id='doc'", "successful_generation=1"]) {
    await db.prepare(`UPDATE publication_jobs SET ${update} WHERE publication_run_id=?`).bind(id).run();
    expect(await readPublicationCleanupCandidate(db,attempt,claim.verifierId,false)).toBeNull();
    await db.prepare("UPDATE publication_jobs SET generation=1, correlation_id='owner', settings_context_json=?, finalization_json=NULL, google_doc_id=NULL, successful_generation=0 WHERE publication_run_id=?").bind(context,id).run();
  }
});

it('records saved temporary document evidence only at first admission', async () => {
  const db = testEnv().DB;
  for (const saved of [true, false]) {
    const id = crypto.randomUUID();
    await acquireOrResumeJob(db, {now:()=>new Date()}, id, 'owner');
    if (saved) await db.prepare('UPDATE publication_jobs SET temp_doc_id=? WHERE publication_run_id=?').bind('doc',id).run();
    expect(await admitPublicationCleanup(db,id,1,1,'owner','doc')).toBe(true);
    await db.prepare('UPDATE publication_jobs SET temp_doc_id=? WHERE publication_run_id=?').bind('doc',id).run();
    expect(await admitPublicationCleanup(db,id,1,1,'owner','doc')).toBe(true);
    expect(await db.prepare('SELECT saved_temp_doc FROM publication_cleanup_intents WHERE publication_run_id=?').bind(id).first()).toEqual({saved_temp_doc:saved ? 1 : null});
  }
});


it('requires saved ownership for delete retry and rejects conflicting job evidence', async () => {
  const db = testEnv().DB;
  for (const evidence of ['saved', 'discovery', 'legacy']) {
    const id = crypto.randomUUID();
    const context = JSON.stringify({replyGroupId:'group', settings:{config:{googleDriveFolderId:'folder'}}});
    await acquireOrResumeJob(db, {now:()=>new Date()}, id, 'owner');
    await db.prepare('UPDATE publication_jobs SET settings_context_json=?, temp_doc_id=? WHERE publication_run_id=?').bind(context,evidence === 'saved' ? 'doc' : null,id).run();
    await admitPublicationCleanup(db,id,1,1,'owner','doc');
    if (evidence === 'legacy') await db.prepare('UPDATE publication_cleanup_intents SET saved_temp_doc=NULL WHERE publication_run_id=?').bind(id).run();
    const attempt = {runId:id,generation:1,notificationCycle:1,groupId:'group'};
    const claim = await claimPublicationVerification(db,attempt);
    if (claim.status !== 'claimed') throw new Error('expected claim');
    expect(!!await readPublicationCleanupCandidate(db,attempt,claim.verifierId,true)).toBe(evidence === 'saved');
    expect(await readPublicationCleanupCandidate(db,attempt,claim.verifierId,false)).not.toBeNull();
    for (const update of ["finalization_json='{}'", "google_doc_id='doc'", "successful_generation=1"]) {
      await db.prepare(`UPDATE publication_jobs SET ${update} WHERE publication_run_id=?`).bind(id).run();
      expect(await readPublicationCleanupCandidate(db,attempt,claim.verifierId,true)).toBeNull();
      await db.prepare('UPDATE publication_jobs SET finalization_json=NULL, google_doc_id=NULL, successful_generation=0 WHERE publication_run_id=?').bind(id).run();
    }
  }
});

it('atomically claims a saved cleanup once across verifier replacement', async () => {
  const db = testEnv().DB, id = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:'group', settings:{config:{googleDriveFolderId:'folder'}}});
  await acquireOrResumeJob(db, {now:()=>new Date()}, id, 'owner');
  await db.prepare('UPDATE publication_jobs SET settings_context_json=?, temp_doc_id=? WHERE publication_run_id=?').bind(context,'doc',id).run();
  await admitPublicationCleanup(db,id,1,1,'owner','doc');
  const attempt = {runId:id,generation:1,notificationCycle:1,groupId:'group'};
  const claim = await claimPublicationVerification(db,attempt);
  if (claim.status !== 'claimed') throw new Error('expected claim');
  expect(await claimPublicationCleanupDispatch(db,{...attempt,groupId:'foreign'},claim.verifierId,'doc')).toBe(false);
  expect(await claimPublicationCleanupDispatch(db,attempt,'stale','doc')).toBe(false);
  for (const update of ["generation=2", "notification_cycle=2", "correlation_id='foreign'", "settings_context_json='{}'", "finalization_json='{}'", "google_doc_id='doc'", "successful_generation=1"]) {
    await db.prepare(`UPDATE publication_jobs SET ${update} WHERE publication_run_id=?`).bind(id).run();
    expect(await claimPublicationCleanupDispatch(db,attempt,claim.verifierId,'doc')).toBe(false);
    await db.prepare("UPDATE publication_jobs SET generation=1, notification_cycle=1, correlation_id='owner', settings_context_json=?, finalization_json=NULL, google_doc_id=NULL, successful_generation=0 WHERE publication_run_id=?").bind(context,id).run();
  }
  await db.prepare('UPDATE publication_cleanup_intents SET saved_temp_doc=NULL WHERE publication_run_id=?').bind(id).run();
  expect(await claimPublicationCleanupDispatch(db,attempt,claim.verifierId,'doc')).toBe(false);
  await db.prepare('UPDATE publication_cleanup_intents SET saved_temp_doc=1 WHERE publication_run_id=?').bind(id).run();
  const results = await Promise.all([claimPublicationCleanupDispatch(db,attempt,claim.verifierId,'doc'),claimPublicationCleanupDispatch(db,attempt,claim.verifierId,'doc')]);
  expect(results.filter(Boolean)).toHaveLength(1);
  await db.prepare("UPDATE publication_verification_claims SET verifier_id='replacement' WHERE publication_run_id=?").bind(id).run();
  expect(await claimPublicationCleanupDispatch(db,attempt,'replacement','doc')).toBe(false);
});


it('records only the original positive deletion receipt, including after a newer attempt', async () => {
  const db = testEnv().DB, id = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:'group', settings:{config:{googleDriveFolderId:'folder'}}});
  await acquireOrResumeJob(db, {now:()=>new Date()}, id, 'owner');
  await db.prepare('UPDATE publication_jobs SET settings_context_json=?, temp_doc_id=? WHERE publication_run_id=?').bind(context,'doc',id).run();
  await admitPublicationCleanup(db,id,1,1,'owner','doc');
  const attempt = {runId:id,generation:1,notificationCycle:1,groupId:'group'};
  const claim = await claimPublicationVerification(db,attempt);
  if (claim.status !== 'claimed') throw new Error('expected claim');
  expect(await claimPublicationCleanupDispatch(db,attempt,claim.verifierId,'doc')).toBe(true);
  const receipt = { ...attempt, verifierId:claim.verifierId, docId:'doc', acknowledged:true as const };
  expect(await recordPublicationCleanupReceipt(db,{...receipt, groupId:'foreign'})).toBe(false);
  expect(await recordPublicationCleanupReceipt(db,{...receipt, verifierId:'foreign'})).toBe(false);
  expect(await recordPublicationCleanupReceipt(db,{...receipt, docId:'foreign'})).toBe(false);
  expect(await recordPublicationCleanupReceipt(db,{...receipt, acknowledged:false})).toBe(false);
  await db.prepare("UPDATE publication_jobs SET generation=2, temp_doc_id='new-doc' WHERE publication_run_id=?").bind(id).run();
  expect(await recordPublicationCleanupReceipt(db,receipt)).toBe(true);
  expect(await recordPublicationCleanupReceipt(db,receipt)).toBe(true);
  expect(await db.prepare('SELECT deletion_acknowledged FROM publication_cleanup_intents WHERE publication_run_id=?').bind(id).first()).toEqual({deletion_acknowledged:1});
  expect(await db.prepare('SELECT generation,temp_doc_id FROM publication_jobs WHERE publication_run_id=?').bind(id).first()).toEqual({generation:2,temp_doc_id:'new-doc'});
});


it('reads an acknowledged receipt only for the current owner and matching captured attempt', async () => {
  const db = testEnv().DB, id = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:'group',settings:{config:{googleDriveFolderId:'folder'}}});
  await acquireOrResumeJob(db,{now:()=>new Date()},id,'owner');
  await db.prepare('UPDATE publication_jobs SET settings_context_json=?, temp_doc_id=? WHERE publication_run_id=?').bind(context,'doc',id).run();
  await admitPublicationCleanup(db,id,1,1,'owner','doc');
  const attempt = {runId:id,generation:1,notificationCycle:1,groupId:'group'};
  const claim = await claimPublicationVerification(db,attempt);
  if (claim.status !== 'claimed') throw new Error('expected claim');
  await claimPublicationCleanupDispatch(db,attempt,claim.verifierId,'doc');
  await recordPublicationCleanupReceipt(db,{...attempt,verifierId:claim.verifierId,docId:'doc',acknowledged:true});
  expect(await readPublicationCleanupReceipt(db,attempt,claim.verifierId)).toEqual({origin_workflow_id:'owner',context_json:context,doc_id:'doc'});
  expect(await readPublicationCleanupReceipt(db,attempt,'stale')).toBeNull();
  expect(await readPublicationCleanupReceipt(db,{...attempt,groupId:'other'},claim.verifierId)).toBeNull();
  for (const update of ["generation=2", "notification_cycle=2", "correlation_id='other'", "settings_context_json='{}'", "finalization_json='{}'", "google_doc_id='doc'", "successful_generation=1"]) {
    await db.prepare(`UPDATE publication_jobs SET ${update} WHERE publication_run_id=?`).bind(id).run();
    expect(await readPublicationCleanupReceipt(db,attempt,claim.verifierId)).toBeNull();
    await db.prepare("UPDATE publication_jobs SET generation=1, notification_cycle=1, correlation_id='owner', settings_context_json=?, finalization_json=NULL, google_doc_id=NULL, successful_generation=0 WHERE publication_run_id=?").bind(context,id).run();
  }
  const replacement = crypto.randomUUID();
  await db.prepare("UPDATE publication_verification_claims SET verifier_id=? WHERE publication_run_id=?").bind(replacement,id).run();
  expect(await readPublicationCleanupReceipt(db,attempt,claim.verifierId)).toBeNull();
  expect(await readPublicationCleanupReceipt(db,attempt,replacement)).not.toBeNull();
});


it('joins a confirmed receipt to the matching saved primary failure', async () => {
  const db = testEnv().DB, id = crypto.randomUUID();
  const context = JSON.stringify({replyGroupId:'group',settings:{config:{googleDriveFolderId:'folder'}}});
  await acquireOrResumeJob(db,{now:()=>new Date()},id,'owner');
  await db.prepare('UPDATE publication_jobs SET settings_context_json=?, temp_doc_id=? WHERE publication_run_id=?').bind(context,'doc',id).run();
  await admitPublicationCleanup(db,id,1,1,'owner','doc');
  const attempt = {runId:id,generation:1,notificationCycle:1,groupId:'group'};
  const claim = await claimPublicationVerification(db,attempt);
  if (claim.status !== 'claimed') throw new Error('expected claim');
  await claimPublicationCleanupDispatch(db,attempt,claim.verifierId,'doc');
  await recordPublicationCleanupReceipt(db,{...attempt,verifierId:claim.verifierId,docId:'doc',acknowledged:true});
  expect(await readPublicationCleanupFailure(db,attempt,claim.verifierId)).toBeNull();
  await db.prepare("INSERT INTO workflow_feedback(kind,run_id,generation,notification_cycle,group_id,context_json,stage,failure_code) VALUES ('publication',?,1,1,'group',?,'prepare outputs','claude_failed')").bind(id,context).run();
  await db.prepare("INSERT INTO workflow_feedback_results(kind,run_id,generation,notification_cycle,revision,result_key,outcome_json,group_id) VALUES ('publication',?,1,1,0,?,?,'group')").bind(id,id,JSON.stringify({stage:'prepare outputs',failureCode:'claude_failed',outcome:'unconfirmed'})).run();
  expect(await readPublicationCleanupFailure(db,attempt,claim.verifierId)).toEqual({origin_workflow_id:'owner',context_json:context,doc_id:'doc',stage:'prepare outputs',failure_code:'claude_failed'});
  expect(await readPublicationCleanupFailure(db,attempt,'stale')).toBeNull();
  expect(await readPublicationCleanupFailure(db,{...attempt,groupId:'foreign'},claim.verifierId)).toBeNull();
  await db.prepare("UPDATE publication_jobs SET correlation_id='foreign' WHERE publication_run_id=?").bind(id).run();
  expect(await readPublicationCleanupFailure(db,attempt,claim.verifierId)).toBeNull();
});
