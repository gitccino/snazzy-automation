import type { LineMutationRepository } from '../db/line-mutation-repository';
import type { IdGenerator } from '../shared/ids';
import type { PendingLineCommand } from './types';
import { InventoryWriteRejectedError, validSaleValues, type InventoryClient } from './airtable-inventory';
import { OperationalError } from '../shared/errors';

export async function writeTrackedSale(pending: PendingLineCommand, recordId: string, owner: string, deps: {
  mutationRepo: LineMutationRepository; inventory: InventoryClient; ids: IdGenerator; repair?: boolean;
}) {
  if (!validSaleValues(pending.after)) throw new OperationalError('airtable_inventory_invalid_sale_values', 'Invalid sale values', false);
  const id = deps.ids.next();
  await deps.mutationRepo.beginAttempt({ id, token: pending.token, recordId, intended: pending.after, owner, repair: deps.repair });
  try {
    await deps.inventory.updateSaleValues(recordId, pending.after);
  } catch (error) {
    if (error instanceof InventoryWriteRejectedError) await deps.mutationRepo.finishAttempt(id, 'rejected', error.code);
    throw error;
  }
  await deps.mutationRepo.finishAttempt(id, 'acknowledged', 'http_2xx');
}

import type { LineRepository } from '../db/line-repository';
import { matchesSaleValues } from './airtable-inventory';
export type FollowupParams = { pendingToken: string; productId: string; registeredAt?: number };
export type RecoveryResult = { status: 'ready'; warning?: string } | { status: 'busy' };
export type ExecutionStatus = 'active' | 'terminal' | 'unknown';
export interface RecoveryDeps {
  mutationRepo: LineMutationRepository;
  repo: LineRepository;
  inventory: InventoryClient;
  ids: IdGenerator;
  status(workflowId: string): Promise<ExecutionStatus>;
  registerFollowup(params: FollowupParams): Promise<void>;
}

export async function lineCommandWorkflowId(eventId: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(eventId));
  return 'line-' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function executionStatus(status: string): ExecutionStatus {
  return ['complete', 'errored', 'terminated'].includes(status) ? 'terminal' : 'active';
}
export const recoveryConflictText = (productId: string) => `⚠️ ข้อมูลสินค้า ${productId} ไม่ตรงกับรายการที่ระบบยืนยันล่าสุด กรุณาตรวจสอบ Airtable`;

async function acquireControl(productId: string, owner: string, mode: 'recovery' | 'repair', token: string, deps: RecoveryDeps) {
  const control = await deps.mutationRepo.control(productId);
  if (control && control.owner_workflow_id !== owner) {
    const state = await deps.status(control.owner_workflow_id);
    if (state === 'unknown') throw new OperationalError('line_recovery_owner_unknown', 'Cannot verify prior execution', true);
    if (state === 'active') return false;
    // Reclaim only the exact observed terminal owner; another command may win.
    if (!await deps.mutationRepo.reclaim(productId, control.owner_workflow_id, owner)) return false;
    await deps.mutationRepo.release(productId, owner);
  }
  return deps.mutationRepo.acquire(productId, owner, mode, token);
}

export async function recoverAbandonedMutation(productId: string, groupId: string, owner: string, deps: RecoveryDeps): Promise<RecoveryResult> {
  const pending = await deps.mutationRepo.findApplying(productId);
  if (!pending) {
    const control = await deps.mutationRepo.control(productId);
    if (!control) return { status: 'ready' };
    if (!await acquireControl(productId, owner, 'recovery', control.pending_token, deps)) return { status: 'busy' };
    await deps.mutationRepo.release(productId, owner);
    return { status: 'ready' };
  }
  if (pending.groupId !== groupId || !pending.applyEventId) return { status: 'busy' };
  const context = await deps.mutationRepo.context(pending.token);
  const oldOwner = context?.workflow_id ?? await lineCommandWorkflowId(pending.applyEventId);
  // The current command's own durable retry must resume, not supersede itself.
  if (oldOwner === owner && !await deps.mutationRepo.control(productId)) return { status: 'ready' };
  const state = await deps.status(oldOwner);
  if (state === 'unknown') throw new OperationalError('line_recovery_owner_unknown', 'Cannot verify prior execution', true);
  if (state === 'active') return { status: 'busy' };
  if (!await acquireControl(productId, owner, 'recovery', pending.token, deps)) return { status: 'busy' };
  const current = await deps.inventory.findByProductId(productId);
  let warning: string | undefined;
  if (current && validSaleValues(pending.after) && matchesSaleValues(current, pending.after)) {
    const actor = context?.mutation_actor ?? (pending.kind === 'soldout' ? pending.after.soldBy : null);
    if (!actor) throw new OperationalError('line_recovery_actor_unknown', 'Original mutation actor is unknown', false);
    await deps.repo.finalizeAction({ pendingToken: pending.token, applyEventId: pending.applyEventId,
      targetActionId: pending.targetActionId, groupId: pending.groupId, productId, kind: pending.kind,
      before: pending.before, after: pending.after, actor,
      correlationId: context?.mutation_correlation_id ?? pending.applyEventId, recoveryWorkflowId: owner });
  } else {
    const reason = !current ? 'missing_product' : matchesSaleValues(current, pending.before) ? 'replaced' : 'conflict';
    if (await deps.mutationRepo.hasUnknownAttempt(pending.token)) {
      await deps.registerFollowup({pendingToken:pending.token,productId});
      await deps.mutationRepo.markMonitoring(pending.token, 'registered');
    }
    if (!await deps.mutationRepo.failOwned(pending.token, owner, reason)) throw new OperationalError('line_recovery_owner_changed', 'Recovery owner changed', true);
    await deps.mutationRepo.audit(pending.token, 'line_mutation_' + reason, pending.before, pending.after, pending.token + '-recovery');
    if (reason === 'conflict') warning = recoveryConflictText(productId);
  }
  await deps.mutationRepo.release(productId, owner);
  return {status:'ready', ...(warning ? {warning} : {})};
}

export type RepairResult = { status: 'unchanged' | 'repaired' | 'busy' | 'unresolved' };
export async function checkLateMutation(params: FollowupParams, owner: string, deps: RecoveryDeps): Promise<RepairResult> {
  if (!await acquireControl(params.productId, owner, 'repair', params.pendingToken, deps)) return {status:'busy'};
  const current = await deps.inventory.findByProductId(params.productId);
  const latest = await deps.mutationRepo.latestConfirmed(params.productId);
  const superseded = await deps.mutationRepo.superseded(params.productId);
  const late = current && superseded.find(old => validSaleValues(old.after) && matchesSaleValues(current,old.after));
  if (!current || (!late && !(latest && matchesSaleValues(current,latest.after)) && !superseded.some(old=>matchesSaleValues(current,old.before)))) {
    await deps.mutationRepo.release(params.productId,owner);
    return {status:'unresolved'};
  }
  if (latest && current && matchesSaleValues(current,latest.after) || !late) {
    await deps.mutationRepo.release(params.productId,owner);
    return {status:'unchanged'};
  }
  if (!latest || latest.commitSeq <= late.resolutionSeq) {
    await deps.mutationRepo.release(params.productId,owner);
    return {status:'unresolved'};
  }
  // Capture repair intent before PATCH; retain ownership on an uncertain failure.
  await writeTrackedSale({...late,after:latest.after},current!.recordId,owner,{...deps,repair:true});
  await deps.mutationRepo.audit(late.token,'line_late_write_repaired',late.after,latest.after, deps.ids.next());
  await deps.mutationRepo.release(params.productId,owner);
  return {status:'repaired'};
}

export interface MutationCoordinator {
  recoverToken(token: string, groupId: string): Promise<RecoveryResult>;
  recover(productId: string, groupId: string): Promise<RecoveryResult>;
  write(pending: PendingLineCommand, recordId: string, actor: string, correlationId: string): Promise<void>;
  committed(productId: string): Promise<void>;
}
export function createMutationCoordinator(owner: string, deps: RecoveryDeps): MutationCoordinator {
  return {
    async recoverToken(token,groupId) {
      const pending = await deps.mutationRepo.operation(token);
      if (!pending || pending.groupId !== groupId || ['failed','expired','rejected','approved'].includes(pending.status)) return {status:'ready'};
      return recoverAbandonedMutation(pending.productId,groupId,owner,deps);
    },
    recover: (productId,groupId) => recoverAbandonedMutation(productId,groupId,owner,deps),
    async write(pending,recordId,actor,correlationId) {
      await deps.mutationRepo.setOperationOwner(pending.token,owner,actor,correlationId);
      await writeTrackedSale(pending,recordId,owner,deps);
    },
    async committed(productId) {
      let monitors;
      try { monitors = await deps.mutationRepo.monitors(productId); }
      catch(error) { console.error('Cannot query late-write monitors',error); return; }
      for (const monitor of monitors) {
        try { await checkLateMutation({pendingToken:monitor.token,productId},owner,deps); }
        catch(error) { console.error('Immediate late-write check failed',error); }
      }
    },
  };
}
