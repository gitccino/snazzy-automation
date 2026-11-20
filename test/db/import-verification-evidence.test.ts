import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { readImportVerificationEvidence } from '../../src/db/import-repository';

it('reads only owned running import evidence and distinguishes incomplete from empty scans', async () => {
  const db = testEnv().DB, id = crypto.randomUUID(), album = crypto.randomUUID();
  await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json,scan_evidence_json) VALUES(?,?,'line','running','now',?,?)").bind(id,album,JSON.stringify({replyGroupId:'owner'}), '"incomplete"').run();
  const read = (group = 'owner', workflow = id) => readImportVerificationEvidence(db, id, workflow, group);
  expect(await read()).toMatchObject({scan: 'incomplete', groups: {pending: 0, importing: 0, succeeded: 0, failed: 0}});
  expect(await read('foreign')).toBeNull();
  expect(await read('owner', 'other')).toBeNull();
  await db.prepare("UPDATE import_runs SET scan_evidence_json=NULL WHERE id=?").bind(id).run();
  expect(await read()).toBeNull();
  await db.prepare("UPDATE import_runs SET scan_evidence_json='[]' WHERE id=?").bind(id).run();
  expect(await read()).toMatchObject({scan: 'complete'});
  await db.prepare("INSERT INTO product_groups(id,import_run_id,ordinal,group_hash,state,first_photo_id,last_photo_id,created_at,updated_at) VALUES(?,?,0,?,'failed','a','b','now','now')").bind(crypto.randomUUID(),id,crypto.randomUUID()).run();
  expect(await read()).toMatchObject({groups: {failed: 1}});
  await db.prepare("UPDATE import_runs SET status='start_failed' WHERE id=?").bind(id).run();
  expect(await read()).toBeNull();
});
