import { describe, expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { fixedClock } from '../helpers/fakes';
import { createLineReplyRepository } from '../../src/db/line-reply-repository';

const clock = fixedClock('2026-11-19T08:00:00.000Z');
const messages = [{ type: 'text' as const, text: 'finished' }];
const result = { schemaVersion: 1 as const, kind: 'import' as const, runId: 'run-1', generation: 1, notificationCycle: 1, outcome: 'success' as const, messages };
function fixture() {
  const groupId = crypto.randomUUID();
  const repo = createLineReplyRepository(testEnv().DB, clock);
  const enqueue = (key: string) => repo.enqueueResult({ resultKey: key + groupId, groupId, result });
  const prepare = (eventId: string, sequence: number | null) => repo.prepareDispatch({ eventId: eventId + groupId, groupId, workflowId: eventId, receivedAt: clock.now().toISOString(), candidateSequence: sequence, messages });
  return { repo, groupId, enqueue, prepare };
}
describe('reply outbox', () => {
  it('enqueue is idempotent without changing FIFO and conflicts preserve evidence', async () => {
    const { repo, groupId, enqueue } = fixture();
    await enqueue('a');
    const first = await repo.head(groupId);
    await enqueue('b'); await enqueue('a');
    expect(await repo.head(groupId)).toEqual(first);
    await expect(repo.enqueueResult({ resultKey: 'a' + groupId, groupId, result: { ...result, outcome: 'failed' } })).rejects.toThrow('outbox_result_conflict');
    expect(await repo.head(groupId)).toEqual(first);
  });
  it('two events reserve one head and unresolved head cannot be skipped', async () => {
    const { repo, groupId, enqueue, prepare } = fixture();
    await enqueue('a'); await enqueue('b');
    const head = (await repo.head(groupId))!;
    const states = await Promise.all([prepare('e1', head.sequence), prepare('e2', head.sequence)]);
    expect(states.sort()).toEqual(['head_changed', 'prepared']);
    expect(await repo.head(groupId)).toMatchObject({ sequence: head.sequence, state: 'reserved' });
  });
  it('dispatch CAS wins once and acceptance advances FIFO', async () => {
    const { repo, groupId, enqueue, prepare } = fixture();
    await enqueue('a'); await enqueue('b');
    const sequence = (await repo.head(groupId))!.sequence;
    expect(await prepare('e', sequence)).toBe('prepared');
    expect(await repo.beginDispatch('e' + groupId)).toBe(true);
    expect(await repo.beginDispatch('e' + groupId)).toBe(false);
    await repo.accept('e' + groupId, 'request-1');
    expect((await repo.head(groupId))!.sequence).toBeGreaterThan(sequence);
    expect(await prepare('e', null)).toBe('duplicate');
  });
  it('abandoned preparation cannot later dispatch; dispatched evidence cannot be abandoned', async () => {
    const { repo, groupId, enqueue, prepare } = fixture();
    await enqueue('a');
    const sequence = (await repo.head(groupId))!.sequence;
    await prepare('e', sequence); await repo.abandonPrepared('e' + groupId);
    expect(await repo.beginDispatch('e' + groupId)).toBe(false);
    expect(await repo.head(groupId)).toMatchObject({ state: 'pending' });
    await prepare('f', sequence); await repo.beginDispatch('f' + groupId);
    await repo.abandonPrepared('f' + groupId);
    expect(await repo.head(groupId)).toMatchObject({ state: 'dispatched' });
  });
  it('explicit rejection releases only to a fresh event and unknown outcome holds the head', async () => {
    const { repo, groupId, enqueue, prepare } = fixture();
    await enqueue('a'); const sequence = (await repo.head(groupId))!.sequence;
    await prepare('e', sequence); await repo.beginDispatch('e' + groupId);
    await repo.reject('e' + groupId, 'retry_on_new_event');
    expect(await repo.head(groupId)).toMatchObject({ state: 'pending' });
    expect(await prepare('e', sequence)).toBe('duplicate');
    await prepare('f', sequence); await repo.beginDispatch('f' + groupId);
    await repo.markUncertain('f' + groupId);
    expect(await repo.head(groupId)).toMatchObject({ state: 'uncertain' });
    expect(await prepare('g', sequence)).toBe('head_changed');
  });
});
it('refuses an oversized terminal bundle before inserting a poison FIFO head',async()=>{
 const {repo,groupId}=fixture();
 await expect(repo.enqueueResult({resultKey:groupId,groupId,result:{...result,messages:Array.from({length:6},()=>({type:'text',text:'x'}))}})).rejects.toThrow();
 expect(await repo.head(groupId)).toBeNull();
});
