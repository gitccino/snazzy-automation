import { expect, it, vi } from "vitest";
import type { LineRepository } from "../../src/db/line-repository";
import type { InventoryClient } from "../../src/line/airtable-inventory";
import {
  prepareSoldout,
  resolveSoldout,
  type SoldoutDeps,
} from "../../src/line/soldout";
import type {
  InventoryProduct,
  PendingLineCommand,
} from "../../src/line/types";

const product: InventoryProduct = {
  recordId: "rec1",
  productId: "A-1",
  uploadDate: "2026-09-01",
  airtableUrl: "https://airtable/r",
  inventoryStatus: "In",
  soldPrice: null,
  soldAt: null,
  soldBy: null,
};
const actor = {
  userId: "U1",
  displayName: "Mint",
  groupId: "C1",
};

function soldoutPending(
  overrides: Partial<PendingLineCommand> = {},
): PendingLineCommand {
  return {
    token: "tok",
    sourceEventId: "evt-command",
    applyEventId: "evt-approve",
    kind: "soldout",
    status: "applying",
    requesterUserId: "U0",
    groupId: "C1",
    productId: "A-1",
    soldPrice: 1290,
    before: {
      inventoryStatus: "In",
      soldPrice: null,
      soldAt: null,
      soldBy: null,
    },
    after: {
      inventoryStatus: "Out",
      soldPrice: 1290,
      soldAt: null,
      soldBy: null,
    },
    targetActionId: null,
    expiresAt: "2026-09-01T10:10:00.000Z",
    ...overrides,
  };
}

function deps(found: InventoryProduct | null = product) {
  const inventory = {
    findByProductId: vi.fn().mockResolvedValue(found),
    updateSaleValues: vi.fn().mockResolvedValue(undefined),
  } satisfies InventoryClient;
  const repo = {
    claimEvent: vi.fn(),
    releaseEvent: vi.fn(),
    findPendingBySourceEvent: vi.fn().mockResolvedValue(null),
    createPending: vi.fn().mockImplementation(async (value) => value),
    claimPending: vi.fn(),
    setPendingAfter: vi.fn().mockResolvedValue(undefined),
    resetPending: vi.fn().mockResolvedValue(undefined),
    resolvePending: vi.fn().mockResolvedValue(undefined),
    finalizeAction: vi.fn().mockResolvedValue({ id: "act1" }),
    latestReversible: vi.fn(),
  } satisfies LineRepository;
  return {
    inventory,
    repo,
    clock: {
      now: () => new Date("2026-09-01T10:00:00.000Z"),
    },
    ids: { next: () => "tok" },
  } satisfies SoldoutDeps;
}

it("does not overwrite or create a command for an already-Out Product", async () => {
  const d = deps({ ...product, inventoryStatus: "Out", soldPrice: 900 });

  const result = await prepareSoldout(
    { productId: "A-1", soldPrice: 1290 }, actor, "evt-command", true, d,
  );

  expect(result.kind).toBe("text");
  expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  expect(d.repo.createPending).not.toHaveBeenCalled();
});

it("stores requester, source event, price, before state, and ten-minute expiry", async () => {
  const d = deps();

  const result = await prepareSoldout(
    { productId: "A-1", soldPrice: 1290 }, actor, "evt-command", true, d,
  );

  expect(result.kind).toBe("buttons");
  expect(d.repo.createPending).toHaveBeenCalledWith(expect.objectContaining({
    sourceEventId: "evt-command",
    requesterUserId: "U1",
    soldPrice: 1290,
    before: expect.objectContaining({ inventoryStatus: "In" }),
    expiresAt: "2026-09-01T10:10:00.000Z",
  }));
});

it("persists exact after state before Airtable write and uses approver as Sold By", async () => {
  const d = deps();
  d.repo.claimPending = vi.fn().mockResolvedValue(soldoutPending());

  await resolveSoldout("approve", "tok", actor, "evt-approve", "corr", d);

  const after = {
    inventoryStatus: "Out" as const,
    soldPrice: 1290,
    soldAt: "2026-09-01T10:00:00.000Z",
    soldBy: "Mint (U1)",
  };
  expect(d.repo.setPendingAfter).toHaveBeenCalledWith("tok", "evt-approve", after);
  expect(d.inventory.updateSaleValues).toHaveBeenCalledWith("rec1", after);
  expect(d.repo.finalizeAction).toHaveBeenCalledWith(expect.objectContaining({
    pendingToken: "tok", applyEventId: "evt-approve", after, actor: "Mint (U1)",
  }));
});

it("keeps applying ownership when D1 finalization fails after mutation intent is durable", async () => {
  const d = deps();
  d.repo.claimPending = vi.fn().mockResolvedValue(soldoutPending());
  vi.mocked(d.repo.finalizeAction).mockRejectedValueOnce(new Error("D1 unavailable"));

  await expect(resolveSoldout("approve", "tok", actor, "evt-approve", "corr", d))
    .rejects.toThrow("D1 unavailable");

  expect(d.repo.resetPending).not.toHaveBeenCalled();
});

it("recovers after Airtable succeeded but D1 finalization previously failed", async () => {
  const after = {
    inventoryStatus: "Out" as const,
    soldPrice: 1290,
    soldAt: "2026-09-01T09:59:00.000Z",
    soldBy: "Mint (U1)",
  };
  const d = deps({ ...product, ...after });
  d.repo.claimPending = vi.fn().mockResolvedValue(soldoutPending({ after }));

  await resolveSoldout("approve", "tok", actor, "evt-retry", "corr-retry", d);

  expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  expect(d.repo.finalizeAction).toHaveBeenCalledTimes(1);
});

it("confirmation-disabled mode uses sender as approver through same pending protocol", async () => {
  const d = deps();
  d.repo.claimPending = vi.fn().mockResolvedValue(
    soldoutPending({ applyEventId: "evt-command" }),
  );

  await prepareSoldout(
    { productId: "A-1", soldPrice: 1290 }, actor, "evt-command", false, d,
  );

  expect(d.repo.claimPending).toHaveBeenCalledWith(
    "tok", "C1", "soldout", "evt-command", "2026-09-01T10:00:00.000Z",
  );
  expect(d.repo.finalizeAction).toHaveBeenCalledWith(
    expect.objectContaining({ actor: "Mint (U1)" }),
  );
});
