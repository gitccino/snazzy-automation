import { expect } from 'vitest';
import { testEnv } from './env';
import { fixedClock, sequentialIdGenerator } from './fakes';
import { createLineRepository } from '../../src/db/line-repository';
import { createLineMutationRepository } from '../../src/db/line-mutation-repository';
import type { PendingLineCommand } from '../../src/line/types';

const clock = fixedClock('2026-10-09T07:00:00.000Z');
let n = 0;
export async function mutationFixture() {
  const suffix = ++n;
  const db = testEnv().DB;
  const repo = createLineRepository(db, sequentialIdGenerator(`action-${suffix}`), clock);
  const mutations = createLineMutationRepository(db, clock);
  const pending: PendingLineCommand = {
    token: `mutation-${suffix}`, sourceEventId: `source-${suffix}`, applyEventId: null,
    kind: 'soldout', status: 'pending', requesterUserId: 'U1', groupId: 'C1', productId: `A-${1600 + suffix}`,
    soldPrice: 12000, before: { inventoryStatus: 'In', soldPrice: null, soldAt: null, soldBy: null },
    after: { inventoryStatus: 'Out', soldPrice: 12000, soldAt: '2026-10-09T07:00:00.000Z', soldBy: 'Mint (U1)' },
    targetActionId: null, expiresAt: '2026-10-09T07:10:00.000Z',
  };
  await repo.createPending(pending);
  const claimed = (await repo.claimPending(pending.token, 'C1', 'soldout', `apply-${suffix}`, clock.now().toISOString()))!;
  return { db, repo, mutations, pending: claimed, owner: `line-owner-${suffix}` };
}

