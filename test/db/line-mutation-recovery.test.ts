import { expect, it } from 'vitest';
import { mutationFixture } from '../helpers/line-mutation';
import { fixedClock } from '../helpers/fakes';
const clock = fixedClock('2026-10-09T07:00:00.000Z');

it('permits one recovery owner and rejects wrong-owner release', async () => {
  const { mutations, pending } = await mutationFixture();
  const acquired = await Promise.all([
    mutations.acquire(pending.productId, 'one', 'recovery', pending.token),
    mutations.acquire(pending.productId, 'two', 'recovery', pending.token),
  ]);
  expect(acquired.filter(Boolean)).toHaveLength(1);
  const winner = acquired[0] ? 'one' : 'two';
  expect(await mutations.release(pending.productId, 'other')).toBe(false);
  expect(await mutations.release(pending.productId, winner)).toBe(true);
});

it('fails a replaced operation, frees ownership and prevents its old token from reopening', async () => {
  const { mutations, pending, repo } = await mutationFixture();
  await mutations.acquire(pending.productId, 'recover', 'recovery', pending.token);
  expect(await mutations.failOwned(pending.token, 'recover', 'replaced')).toBe(true);
  await mutations.release(pending.productId, 'recover');
  expect(await repo.claimPending(pending.token, 'C1', 'soldout', pending.applyEventId!, clock.now().toISOString())).toBeNull();
  const replacement = await repo.createPending({ ...pending, token: pending.token + '-new', sourceEventId: pending.sourceEventId + '-new', soldPrice: 13000 });
  expect(replacement?.status).toBe('pending');
  await expect(repo.finalizeAction({ pendingToken: pending.token, applyEventId: pending.applyEventId!, targetActionId: null,
    groupId: 'C1', productId: pending.productId, kind: 'soldout', before: pending.before, after: pending.after,
    actor: 'Mint (U1)', correlationId: 'old' })).rejects.toThrow();
});

it('blocks normal creation and finalization while recovery owns the product', async () => {
  const { mutations, pending, repo, db } = await mutationFixture();
  await mutations.acquire(pending.productId, 'recover', 'recovery', pending.token);
  await expect(repo.finalizeAction({ pendingToken: pending.token, applyEventId: pending.applyEventId!, targetActionId: null,
    groupId: 'C1', productId: pending.productId, kind: 'soldout', before: pending.before, after: pending.after,
    actor: 'Mint (U1)', correlationId: 'old' })).rejects.toThrow();
  expect(await db.prepare('SELECT id FROM line_actions WHERE pending_token = ?').bind(pending.token).first()).toBeNull();
});

it('does not acquire repair ownership while a pending confirmation exists', async () => {
  const { pending, mutations, repo } = await mutationFixture();
  await repo.resetPending(pending.token, pending.applyEventId!);
  expect(await mutations.acquire(pending.productId, 'monitor', 'repair', pending.token)).toBe(false);
});

it('stores unknown intent durably and retains uncertainty across later rejections', async () => {
  const { mutations, pending, owner } = await mutationFixture();
  await mutations.setOperationOwner(pending.token, owner);
  await mutations.beginAttempt({ id: 'attempt-' + pending.token, token: pending.token, recordId: 'rec16', intended: pending.after, owner });
  expect(await mutations.hasUnknownAttempt(pending.token)).toBe(true);
  await mutations.beginAttempt({ id: 'rejected-' + pending.token, token: pending.token, recordId: 'rec16', intended: pending.after, owner });
  await mutations.finishAttempt('rejected-' + pending.token, 'rejected', 'http_429');
  expect(await mutations.hasUnknownAttempt(pending.token)).toBe(true);
  await mutations.finishAttempt('attempt-' + pending.token, 'acknowledged', 'http_2xx');
  expect(await mutations.hasUnknownAttempt(pending.token)).toBe(false);
});

it('finalizes recovered history under its recovery owner and orders same-clock commits', async () => {
  const { mutations, pending, repo } = await mutationFixture();
  await mutations.acquire(pending.productId, 'recover', 'recovery', pending.token);
  const first = await repo.finalizeAction({ pendingToken: pending.token, applyEventId: pending.applyEventId!, targetActionId: null,
    groupId: 'C1', productId: pending.productId, kind: 'soldout', before: pending.before, after: pending.after,
    actor: 'Mint (U1)', correlationId: 'old', recoveryWorkflowId: 'recover' });
  await mutations.release(pending.productId, 'recover');
  const second = { ...pending, token: pending.token + '-revert', sourceEventId: pending.sourceEventId + '-revert', kind: 'revert' as const,
    targetActionId: first.id, soldPrice: null, before: pending.after, after: pending.before };
  await repo.createPending(second);
  await repo.claimPending(second.token, 'C1', 'revert', 'revert-event', clock.now().toISOString());
  const reverted = await repo.finalizeAction({ pendingToken: second.token, applyEventId: 'revert-event', targetActionId: first.id,
    groupId: 'C1', productId: pending.productId, kind: 'revert', before: second.before, after: second.after,
    actor: 'Mint (U1)', correlationId: 'revert' });
  expect((await mutations.latestConfirmed(pending.productId))?.id).toBe(reverted.id);
  expect(await repo.latestReversible('C1')).not.toMatchObject({ id: first.id });
});

it('does not acquire stale recovery ownership over a newly created confirmation', async () => {
  const {mutations,pending,repo}=await mutationFixture();
  await mutations.acquire(pending.productId,'winner','recovery',pending.token);
  await mutations.failOwned(pending.token,'winner','replaced');
  await mutations.release(pending.productId,'winner');
  await repo.createPending({...pending,token:pending.token+'-new',sourceEventId:pending.sourceEventId+'-new'});
  expect(await mutations.acquire(pending.productId,'loser','recovery',pending.token)).toBe(false);
});
