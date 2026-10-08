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

import { checkLateMutation } from '../../src/line/mutation-recovery';

it.each(['late','latest','manual','pending'] as const)('repairs only a recognizable late write (%s)', async state => {
  const { pending, mutations, repo, owner, db } = await mutationFixture();
  await mutations.setOperationOwner(pending.token, owner, 'Mint (U1)', 'old');
  await mutations.acquire(pending.productId, 'recover', 'recovery', pending.token);
  await mutations.markMonitoring(pending.token, 'registered');
  await mutations.failOwned(pending.token,'recover','replaced');
  await mutations.release(pending.productId,'recover');
  const latest = { ...pending.after, soldPrice: 13000, soldAt:'2026-10-09T07:01:00.000Z' };
  const newer = { ...pending, token:pending.token+'-new',sourceEventId:pending.sourceEventId+'-new', after:latest };
  await repo.createPending(newer);
  if (state !== 'pending') {
    await repo.claimPending(newer.token,'C1','soldout','new-approve','2026-10-09T07:00:00.000Z');
    await repo.finalizeAction({pendingToken:newer.token,applyEventId:'new-approve',targetActionId:null,groupId:'C1',productId:pending.productId,
      kind:'soldout',before:newer.before,after:latest,actor:'Mint (U1)',correlationId:'new'});
  }
  let current = { recordId:'rec16',productId:pending.productId,uploadDate:null,airtableUrl:'https://airtable.example',
    ...(state === 'latest' ? latest : state === 'manual' ? {...latest,soldPrice:15000} : pending.after) };
  const result = await checkLateMutation({pendingToken:pending.token,productId:pending.productId},'monitor',{
    mutationRepo:mutations,repo,inventory:{findByProductId:async()=>current,updateSaleValues:async (_id,values)=>{current={...current,...values};},listSalesForDay:vi.fn()},
    status:async ()=>'terminal',registerFollowup:vi.fn(),ids:sequentialIdGenerator(pending.token+'-repair'),
  });
  expect(result.status).toBe(state === 'late' ? 'repaired' : state === 'latest' ? 'unchanged' : state === 'pending' ? 'busy' : 'unresolved');
  expect(current.soldPrice).toBe(state === 'late' || state === 'latest' ? 13000 : state === 'manual' ? 15000 : 12000);
  expect((await db.prepare('SELECT COUNT(*) AS n FROM line_actions WHERE product_id = ?').bind(pending.productId).first<{n:number}>())?.n).toBe(state === 'pending' ? 0 : 1);
});

import { createMutationCoordinator } from '../../src/line/mutation-recovery';
import { prepareSoldout, resolveSoldout } from '../../src/line/soldout';
import { fixedClock } from '../helpers/fakes';

it('lets a new 13000 sale win and repairs a delayed 12000 write through real D1 history', async () => {
  const {pending,mutations,repo,owner,db} = await mutationFixture();
  await mutations.setOperationOwner(pending.token,owner,'Mint (U1)','old');
  let current:InventoryProduct = {...pending.before,productId:pending.productId,recordId:'rec16',uploadDate:null,airtableUrl:'https://airtable.example'};
  const writes:number[] = [];
  const inventory = {findByProductId:async()=>({...current}),listSalesForDay:vi.fn(),updateSaleValues:async (_id:string,values:typeof pending.after)=>{writes.push(values.soldPrice!);current={...current,...values};}};
  const dependencies = {mutationRepo:mutations,repo,inventory,status:async ()=>'terminal' as const,registerFollowup:async()=>{},ids:sequentialIdGenerator(pending.token+'-new')};
  const actor = {groupId:'C1',userId:'U2',displayName:'Beam'};
  const d = {repo,inventory,clock:fixedClock('2026-10-09T07:01:00.000Z'),ids:dependencies.ids,mutation:createMutationCoordinator('new-command',dependencies)};
  const confirmation = await prepareSoldout({productId:pending.productId,soldPrice:13000},actor,'new-source-'+pending.token,true,d);
  expect(confirmation.kind).toBe('buttons');
  const replacement = (await repo.findPendingBySourceEvent('new-source-'+pending.token))!;
  expect(replacement.soldPrice).toBe(13000);
  const success = await resolveSoldout('approve',replacement.token,actor,'new-approval-'+pending.token,'new-corr',{
    ...d,mutation:createMutationCoordinator('new-approval-workflow',dependencies),
  });
  expect(success).toMatchObject({saleSuccess:{soldPrice:13000}});
  expect(writes).toEqual([13000]);
  expect(current.soldBy).toBe('Beam (U2)');
  current={...current,...pending.after}; // Provider applies the previously timed-out write late.
  expect((await checkLateMutation({pendingToken:pending.token,productId:pending.productId},'monitor',dependencies)).status).toBe('repaired');
  expect(current).toMatchObject({soldPrice:13000,soldBy:'Beam (U2)',soldAt:'2026-10-09T07:01:00.000Z'});
  expect((await db.prepare('SELECT COUNT(*) AS n FROM line_actions WHERE product_id = ?').bind(pending.productId).first<{n:number}>())?.n).toBe(1);
  expect(await mutations.control(pending.productId)).toBeNull();
  expect((await mutations.operation(pending.token))?.status).toBe('failed');
});

it('returns usual already sold response when recovery finds the old sale succeeded', async () => {
  const {pending,mutations,repo,owner} = await mutationFixture();
  await mutations.setOperationOwner(pending.token,owner,'Mint (U1)','original');
  const inventory = {findByProductId:async()=>({...pending.after,productId:pending.productId,recordId:'rec16',uploadDate:null,airtableUrl:'https://airtable.example'}),listSalesForDay:vi.fn(),updateSaleValues:vi.fn()};
  const ids = sequentialIdGenerator('already-'+pending.token);
  const mutation = createMutationCoordinator('new-command',{mutationRepo:mutations,repo,inventory,ids,status:async()=>'terminal',registerFollowup:vi.fn()});
  const reply = await prepareSoldout({productId:pending.productId,soldPrice:13000},{groupId:'C1',userId:'U2',displayName:'Beam'},'new-'+pending.token,true,{repo,inventory,ids,clock:fixedClock('2026-10-09T07:01:00Z'),mutation});
  expect(reply).toMatchObject({alreadyOut:{soldPrice:12000}});
  expect(inventory.updateSaleValues).not.toHaveBeenCalled();
});

it('reclaims a dead recovery owner without treating a live owner as expired', async () => {
  const {pending,mutations,repo,owner} = await mutationFixture();
  await mutations.setOperationOwner(pending.token,owner);
  await mutations.acquire(pending.productId,'dead-recovery','recovery',pending.token);
  const inventory = {findByProductId:async()=>({...pending.before,productId:pending.productId,recordId:'rec16',uploadDate:null,airtableUrl:'https://airtable.example'}),listSalesForDay:vi.fn(),updateSaleValues:vi.fn()};
  const deps = {mutationRepo:mutations,repo,inventory,ids:sequentialIdGenerator('reclaim'),registerFollowup:vi.fn(),status:async (id:string)=>id==='dead-recovery'?'active' as const:'terminal' as const};
  expect((await recoverAbandonedMutation(pending.productId,'C1','new-recovery',deps)).status).toBe('busy');
  expect((await recoverAbandonedMutation(pending.productId,'C1','new-recovery',{...deps,status:async()=>'terminal'})).status).toBe('ready');
  expect((await mutations.operation(pending.token))?.status).toBe('failed');
});

it('does not reopen a failed operation when its original source message is replayed', async () => {
  const {pending,mutations,repo} = await mutationFixture();
  await mutations.acquire(pending.productId,'recover','recovery',pending.token);
  await mutations.failOwned(pending.token,'recover','replaced');
  await mutations.release(pending.productId,'recover');
  const inventory={findByProductId:vi.fn(),updateSaleValues:vi.fn(),listSalesForDay:vi.fn()};
  const mutation=createMutationCoordinator('old-replay',{repo,mutationRepo:mutations,inventory,ids:sequentialIdGenerator('replay'),status:async()=>'terminal',registerFollowup:vi.fn()});
  const result=await prepareSoldout({productId:pending.productId,soldPrice:12000},{groupId:'C1',userId:'U1',displayName:'Mint'},pending.sourceEventId,true,{repo,inventory,mutation,ids:sequentialIdGenerator('no-reopen'),clock:fixedClock('2026-10-09T07:02:00Z')});
  expect(result.kind).toBe('text');
  expect(inventory.findByProductId).not.toHaveBeenCalled();
});
