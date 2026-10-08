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

import { recoverAbandonedMutation } from '../../src/line/mutation-recovery';
import type { InventoryProduct } from '../../src/line/types';

it.each(['intended', 'original', 'conflict', 'missing'] as const)('recovers terminal operation against %s Airtable values', async mode => {
  const { pending, mutations, repo, owner, db } = await mutationFixture();
  await mutations.setOperationOwner(pending.token, owner, 'Mint (U1)', 'original-corr');
  let monitorRegistered = false;
  const current: InventoryProduct | null = mode === 'missing' ? null : {
    recordId: 'rec16', productId: pending.productId, uploadDate: null, airtableUrl: 'https://airtable.example',
    ...(mode === 'intended' ? pending.after : mode === 'original' ? pending.before : { ...pending.after, soldPrice: 15000 }),
  };
  const inventory = { findByProductId: vi.fn(async () => current), updateSaleValues: vi.fn(), listSalesForDay: vi.fn() };
  const result = await recoverAbandonedMutation(pending.productId, 'C1', 'new-owner', {
    mutationRepo: mutations, repo, inventory, status: async () => 'terminal',
    registerFollowup: async () => { monitorRegistered = true; }, ids: sequentialIdGenerator(pending.token),
  });
  expect(result.status).toBe('ready');
  const row = await db.prepare('SELECT status,resolution_reason FROM pending_line_commands WHERE token = ?').bind(pending.token).first();
  expect(row).toEqual({status: mode === 'intended' ? 'approved' : 'failed', resolution_reason: mode === 'intended' ? null : mode === 'original' ? 'replaced' : mode === 'missing' ? 'missing_product' : 'conflict'});
  expect(inventory.updateSaleValues).not.toHaveBeenCalled();
  expect(monitorRegistered).toBe(mode !== 'intended');
  expect(await mutations.control(pending.productId)).toBeNull();
  if (mode === 'intended') expect(await db.prepare('SELECT actor,correlation_id FROM line_actions WHERE pending_token = ?').bind(pending.token).first()).toEqual({actor:'Mint (U1)',correlation_id:'original-corr'});
});

it('never takes over an active old Workflow or assumes a missing Workflow ended', async () => {
  const { pending, mutations, repo, owner } = await mutationFixture();
  await mutations.setOperationOwner(pending.token, owner);
  const inventory = { findByProductId: vi.fn(), updateSaleValues: vi.fn(), listSalesForDay: vi.fn() };
  const deps = { mutationRepo: mutations, repo, inventory, status: async () => 'active' as const,
    registerFollowup: vi.fn(), ids: sequentialIdGenerator('recover') };
  expect(await recoverAbandonedMutation(pending.productId, 'C1', 'new', deps)).toEqual({status:'busy'});
  expect(inventory.findByProductId).not.toHaveBeenCalled();
  await expect(recoverAbandonedMutation(pending.productId, 'C1', 'new', {...deps,status:async ()=>'unknown'})).rejects.toThrow('Cannot verify');
});

it('keeps unknown operation ownership until follow-up registration succeeds', async () => {
  const { pending, mutations, repo, owner } = await mutationFixture();
  await mutations.setOperationOwner(pending.token, owner);
  const current = { ...pending.before, productId: pending.productId, recordId: 'rec16', uploadDate: null, airtableUrl: 'https://airtable.example' };
  await expect(recoverAbandonedMutation(pending.productId, 'C1', 'new', {
    mutationRepo: mutations, repo, inventory: {findByProductId:async()=>current,updateSaleValues:vi.fn(),listSalesForDay:vi.fn()},
    status:async ()=>'terminal',registerFollowup:async()=>{throw Error('registration failed');},ids:sequentialIdGenerator('register'),
  })).rejects.toThrow('registration failed');
  expect((await mutations.findApplying(pending.productId))?.token).toBe(pending.token);
});
