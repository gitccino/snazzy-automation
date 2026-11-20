import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { claimImportVerification } from '../../src/db/import-repository';

it('admits one verifier only for the captured running album owner', async () => {
  const db = testEnv().DB;
  const runId = crypto.randomUUID();
  const albumId = crypto.randomUUID();
  const contextJson = JSON.stringify({replyGroupId:'owner', target:'original'});
  await db.prepare("INSERT INTO import_runs (id,source_album_id,trigger,status,started_at,settings_context_json) VALUES (?,?,'line','running','x',?)").bind(runId, albumId, contextJson).run();
  const input = {runId, albumId, workflowId:`import-${runId}`, groupId:'owner', contextJson};
  for (const invalid of [{...input, groupId:'foreign'}, {...input, albumId:'stale'}, {...input, workflowId:'stale'}, {...input, contextJson:'{}'}]) {
    expect(await claimImportVerification(db, invalid)).toBe(false);
  }
  await db.prepare("UPDATE import_runs SET status='start_failed' WHERE id=?").bind(runId).run();
  expect(await claimImportVerification(db, input)).toBe(false);
  await db.prepare("UPDATE import_runs SET status='running', settings_context_json=? WHERE id=?").bind(JSON.stringify({replyGroupId:'owner', target:'changed'}), runId).run();
  expect(await claimImportVerification(db, input)).toBe(false);
  await db.prepare('UPDATE import_runs SET settings_context_json=? WHERE id=?').bind(contextJson, runId).run();
  expect((await Promise.all([claimImportVerification(db, input), claimImportVerification(db, input)])).sort()).toEqual([false, true]);
  expect(await db.prepare('SELECT count(*) AS n FROM import_verification_claims WHERE import_run_id=?').bind(runId).first('n')).toBe(1);
});
