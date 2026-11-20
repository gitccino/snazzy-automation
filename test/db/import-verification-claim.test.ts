import { expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import type { TerminalResultV1 } from '../../src/line/reply-types';
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

it('atomically completes and queues one result, rolling back on outbox failure', async () => {
  const { completeImportVerification } = await import('../../src/db/import-repository');
  const db = testEnv().DB;
  const runId = crypto.randomUUID(), albumId = crypto.randomUUID();
  const contextJson = JSON.stringify({replyGroupId:'owner'});
  const input = {runId, albumId, workflowId:`import-${runId}`, groupId:'owner', contextJson};
  const verifierId = `import-verification-${runId}`;
  const result: TerminalResultV1 = {schemaVersion:1, kind:'import', runId, generation:1, notificationCycle:1, outcome:'unconfirmed', messages:[{type:'text', text:'check'}]};
  await db.prepare("INSERT INTO import_runs (id,source_album_id,trigger,status,started_at,settings_context_json) VALUES (?,?,'line','running','x',?)").bind(runId, albumId, contextJson).run();
  expect(await claimImportVerification(db, input)).toBe(true);
  await db.exec("CREATE TRIGGER fail_import_outbox BEFORE INSERT ON line_result_outbox BEGIN SELECT RAISE(ABORT, 'injected'); END");
  await expect(completeImportVerification(db, input, verifierId, result)).rejects.toThrow();
  expect(await db.prepare('SELECT completed,result_json FROM import_verification_claims WHERE import_run_id=?').bind(runId).first()).toEqual({completed:null,result_json:null});
  await db.exec('DROP TRIGGER fail_import_outbox');
  expect(await completeImportVerification(db, input, verifierId, result)).toBe(true);
  expect(await completeImportVerification(db, input, verifierId, result)).toBe(false);
  expect(await db.prepare('SELECT count(*) AS n FROM line_result_outbox WHERE result_key=?').bind(JSON.stringify(['import',runId,1,1,'verification'])).first('n')).toBe(1);
});
