import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { createWorkflowFeedbackRepository } from '../../src/db/workflow-feedback';

describe('workflow feedback', () => {
  it('persists an idempotent outcome for the owning publication attempt and rejects stale writers', async () => {
    const db = testEnv().DB;
    const runId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    await db.prepare(`INSERT INTO publication_jobs (publication_run_id, publication_date, state, correlation_id, created_at, updated_at, generation, notification_cycle, settings_context_json) VALUES (?, ?, 'generating', ?, ?, ?, 2, 1, ?)`)
      .bind(runId, '2026-11-20', runId, '2026-11-20', '2026-11-20', JSON.stringify({ replyGroupId: groupId })).run();
    const repo = createWorkflowFeedbackRepository(db);
    const attempt = { kind: 'publication' as const, runId, generation: 2, notificationCycle: 1, groupId };
    const outcome = { stage: 'caption', failureCode: 'claude_failed', action: 'owner', resultKey: `publication:${runId}:2:1` };
    expect(await repo.commitOutcome(attempt, outcome)).toBe(true);
    expect(await repo.commitOutcome(attempt, outcome)).toBe(true);
    expect(await repo.commitOutcome({ ...attempt, generation: 1 }, outcome)).toBe(false);
    expect(await repo.commitOutcome({ ...attempt, groupId: 'other-group' }, outcome)).toBe(false);
    expect(await Promise.all([repo.commitOutcome(attempt, outcome), repo.commitOutcome(attempt, outcome)])).toEqual([true, true]);
    expect(await repo.commitOutcome(attempt, { ...outcome, stage: 'cleanup' })).toBe(true);
    expect(await createWorkflowFeedbackRepository(db).pendingByGroup(groupId, 10)).toHaveLength(1);
    expect(await Promise.all([repo.commitOutcome(attempt, { ...outcome, action: 'retry' }), repo.commitOutcome(attempt, { ...outcome, action: 'retry' })])).toEqual([true, true]);
    expect(await repo.pendingByGroup(groupId, 10)).toHaveLength(2);
    await db.prepare('UPDATE publication_jobs SET generation=3 WHERE publication_run_id=?').bind(runId).run();
    expect(await repo.commitOutcome(attempt, { ...outcome, action: 'new' })).toBe(false);
    expect(await repo.pendingByGroup(groupId, 10)).toHaveLength(2);
  });
});

it('rolls back the stage when the notice insert aborts', async () => {
  const db = testEnv().DB, runId = crypto.randomUUID(), groupId = crypto.randomUUID();
  await db.prepare(`INSERT INTO publication_jobs (publication_run_id, publication_date, state, correlation_id, created_at, updated_at, generation, notification_cycle, settings_context_json) VALUES (?, ?, 'generating', ?, 'x', 'x', 2, 1, ?)`).bind(runId, runId, runId, JSON.stringify({replyGroupId: groupId})).run();
  const repo = createWorkflowFeedbackRepository(db), a = {kind: 'publication' as const, runId, groupId, generation: 2, notificationCycle: 1};
  await repo.recordStage(a, {stage: 'before'});
  await db.prepare(`CREATE TRIGGER feedback_abort BEFORE INSERT ON workflow_feedback_results BEGIN SELECT RAISE(ABORT, 'notice failed'); END`).run();
  try {
    await expect(repo.commitOutcome(a, {stage: 'after', action: 'owner', resultKey: runId})).rejects.toThrow();
    expect(await db.prepare('SELECT stage FROM workflow_feedback WHERE run_id=?').bind(runId).first('stage')).toBe('before');
  } finally { await db.prepare('DROP TRIGGER feedback_abort').run(); }
});

it('fences evidence reads and writes by current owner and event', async () => {
  const db = testEnv().DB, runId = crypto.randomUUID(), groupId = crypto.randomUUID();
  await db.prepare(`INSERT INTO publication_jobs (publication_run_id, publication_date, state, correlation_id, created_at, updated_at, generation, notification_cycle, settings_context_json) VALUES (?, ?, 'generating', ?, 'x', 'x', 2, 1, ?)`).bind(runId, runId, runId, JSON.stringify({replyGroupId: groupId})).run();
  const repo = createWorkflowFeedbackRepository(db), a = {kind: 'publication' as const, runId, groupId, generation: 2, notificationCycle: 1};
  await repo.recordStage(a, {stage: 'x', eventId: 'event'});
  expect(await repo.upsertEvidence(a, 'event', 'group', {ok: true})).toBe(true);
  expect(await repo.readEvidence(a, 'event', 'group')).toEqual({ok: true});
  expect(await repo.upsertEvidence(a, 'wrong', 'group', {ok: false})).toBe(false);
  expect(await repo.readEvidence({...a, groupId: 'wrong'}, 'event', 'group')).toBeNull();
  await db.prepare('UPDATE publication_jobs SET generation=3 WHERE publication_run_id=?').bind(runId).run();
  expect(await repo.readEvidence(a, 'event', 'group')).toBeNull();
  expect(await repo.upsertEvidence(a, 'event', 'group', {})).toBe(false);
});


it('applies the additive migration on fresh and seeded databases', async () => {
  const db = testEnv().DB;
  const migrations = (env as unknown as {TEST_MIGRATIONS: {name: string; queries: string[]}[]}).TEST_MIGRATIONS;
  const migration = migrations.find(m => m.name === '0014_workflow_feedback.sql')!;
  const ids = Array.from({length: 2}, () => crypto.randomUUID());
  for (const [i, id] of ids.entries()) {
    await db.prepare(`INSERT INTO import_runs (id, source_album_id, trigger, status, started_at) VALUES (?, 'album', 'cron', ?, 'x')`).bind(id, ['running', 'completed'][i]).run();
  }
  const key = crypto.randomUUID();
  await db.prepare("INSERT INTO line_result_outbox(result_key,group_id,result_json,created_at) VALUES (?, 'group', '{}', 'x')").bind(key).run();
  for (const prefix of ['fresh_feedback_', 'upgrade_feedback_']) {
    const rename = (sql: string) => sql.replace(/\b(workflow_feedback_group_evidence|workflow_feedback_results|workflow_feedback_pending_group|workflow_feedback_group|workflow_feedback)\b/g, name => prefix + name);
    await db.batch(migration.queries.map(sql => db.prepare(rename(sql))));
    expect(await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).bind(prefix + 'workflow_feedback').first()).toBeTruthy();
  }
  const rows = await db.prepare(`SELECT id, status FROM import_runs WHERE id IN (?,?)`).bind(...ids).all<{id: string; status: string}>();
  expect(rows.results.map(row => row.status).sort()).toEqual(['completed', 'running']);
  expect(await db.prepare('SELECT state FROM line_result_outbox WHERE result_key=?').bind(key).first('state')).toBe('pending');
});

it.each(['import', 'publication'] as const)('looks up only trusted current LINE %s identity', async (kind) => {
  const db = testEnv().DB, eventId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const { lineCommandWorkflowId } = await import('../../src/line/mutation-recovery');
  const workflowId = await lineCommandWorkflowId(eventId);
  const runId = kind === 'import' ? workflowId : crypto.randomUUID();
  const operation = JSON.stringify(kind === 'import' ? {type: 'upload'} : {type: 'docs', publicationDate: '2026-11-20'});
  const context = JSON.stringify({replyGroupId: groupId});
  const a = {kind, runId, groupId, generation: kind === 'import' ? 1 : 2, notificationCycle: 1};
  await db.prepare('INSERT INTO line_command_ingress VALUES (?,?,?,?,?)').bind(eventId, groupId, operation, workflowId, 'now').run();
  if (kind === 'import') {
    await db.prepare("INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json) VALUES (?,?,'line','completed','now',?)").bind(runId, runId, context).run();
  } else {
    await db.prepare("INSERT INTO publication_jobs(publication_run_id,publication_date,state,correlation_id,created_at,updated_at,generation,notification_cycle,settings_context_json) VALUES (?,?,'generating',?,'x','x',2,1,?)").bind(runId, runId, runId, context).run();
    await db.prepare("INSERT INTO publication_regeneration_events(event_id,publication_run_id,generation,notification_cycle,workflow_id,action,job_json,group_id,ingress_operation) VALUES (?,?,2,1,?,'create','{}',?,?)").bind(eventId,runId,runId,groupId,operation).run();
  }
  const repo = createWorkflowFeedbackRepository(db);
  expect(await repo.lookupTrustedEarlyFailure(a, eventId)).toEqual({eventId, context});
  expect(await repo.lookupTrustedEarlyFailure({...a, groupId: 'wrong'}, eventId)).toBeNull();
  expect(await repo.lookupTrustedEarlyFailure({...a, generation: 3}, eventId)).toBeNull();
  expect(await repo.lookupTrustedEarlyFailure({...a, notificationCycle: 2}, eventId)).toBeNull();
  await db.prepare('UPDATE line_command_ingress SET workflow_id=? WHERE event_id=?').bind('wrong',eventId).run();
  expect(await repo.lookupTrustedEarlyFailure(a, eventId)).toBeNull();
  await db.prepare('UPDATE line_command_ingress SET workflow_id=? WHERE event_id=?').bind(workflowId,eventId).run();
  await db.prepare('DELETE FROM line_command_ingress WHERE event_id=?').bind(eventId).run();
  expect(await repo.lookupTrustedEarlyFailure(a, eventId)).toBeNull();
  await db.prepare('INSERT INTO line_command_ingress VALUES (?,?,?,?,?)').bind(eventId, groupId, JSON.stringify({type: 'other'}), workflowId, 'now').run();
  expect(await repo.lookupTrustedEarlyFailure(a, eventId)).toBeNull();
  if (kind === 'import') {
    await db.prepare('UPDATE line_command_ingress SET operation=? WHERE event_id=?').bind(operation,eventId).run();
    await db.prepare("UPDATE import_runs SET trigger='admin' WHERE id=?").bind(runId).run();
    expect(await repo.lookupTrustedEarlyFailure(a, eventId)).toBeNull();
  }
});
