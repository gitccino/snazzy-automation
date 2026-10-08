import type { MutationCoordinator } from '../../src/line/mutation-recovery';
import type { InventoryClient } from '../../src/line/airtable-inventory';

export function fakeMutationCoordinator(inventory: InventoryClient): MutationCoordinator {
  return {
    recover: async () => ({status:'ready'}),
    recoverToken: async () => ({status:'ready'}),
    write: async (pending,recordId) => inventory.updateSaleValues(recordId,pending.after),
    committed: async () => {},
  };
}
