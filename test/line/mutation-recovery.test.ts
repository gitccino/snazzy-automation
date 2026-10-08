import { expect, it, vi } from 'vitest';
import { mutationFixture } from '../helpers/line-mutation';
import { writeTrackedSale } from '../../src/line/mutation-recovery';
import { createInventoryClient } from '../../src/line/airtable-inventory';
import { sequentialIdGenerator } from '../helpers/fakes';

it.each([200, 429, 500, 'timeout'] as const)('persists the real PATCH outcome for %s', async status => {
  const { pending, mutations, owner, db } = await mutationFixture();
  await mutations.setOperationOwner(pending.token, owner, 'Mint (U1)', 'corr');
  const inventory = createInventoryClient({ baseId: 'app1', tableId: 'tbl1', token: 'token', fetch: vi.fn(async () => {
    const attempt = await db.prepare('SELECT outcome FROM line_mutation_attempts WHERE pending_token = ?').bind(pending.token).first();
    expect(attempt).toEqual({outcome:'unknown'});
    if (status === 'timeout') throw new DOMException('timeout','TimeoutError');
    return new Response('{}', {status});
  }) });
  const promise = writeTrackedSale(pending, 'rec16', owner, { mutationRepo: mutations, inventory, ids: sequentialIdGenerator(pending.token) });
  if (status === 200) await promise;
  else await expect(promise).rejects.toThrow();
  const row = await db.prepare('SELECT outcome FROM line_mutation_attempts WHERE pending_token = ?').bind(pending.token).first();
  expect(row).toEqual({outcome: status === 200 ? 'acknowledged' : status === 429 ? 'rejected' : 'unknown'});
});

it('does not send a PATCH after failing to persist ownership or intent', async () => {
  const { pending, mutations, owner } = await mutationFixture();
  const inventory = { updateSaleValues: vi.fn(), findByProductId: vi.fn(), listSalesForDay: vi.fn() };
  await expect(writeTrackedSale(pending, 'rec16', owner, { mutationRepo: mutations, inventory, ids: sequentialIdGenerator('write') })).rejects.toThrow();
  expect(inventory.updateSaleValues).not.toHaveBeenCalled();
});
