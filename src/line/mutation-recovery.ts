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
