import { expect, it, vi } from "vitest";
import type { LineRepository } from "../../src/db/line-repository";
import type { InventoryClient } from "../../src/line/airtable-inventory";
import { prepareRevert, resolveRevert } from "../../src/line/revert";
import type { SoldoutDeps } from "../../src/line/soldout";
import type {
  InventoryProduct,
  PendingLineCommand,
  ReversibleLineAction,
} from "../../src/line/types";

const original = {
  inventoryStatus: "In" as const,
  soldPrice: null,
  soldAt: null,
  soldBy: null,
};
const sold = {
  inventoryStatus: "Out" as const,
  soldPrice: 1290,
  soldAt: "2026-09-01T10:00:00.000Z",
  soldBy: "Mint (U1)",
};
const action: ReversibleLineAction = {
  id: "act1",
  pendingToken: "soldout-token",
  groupId: "C1",
  productId: "A-1",
  kind: "soldout",
  before: original,
  after: sold,
  actor: "Mint (U1)",
  correlationId: "corr-soldout",
  createdAt: "2026-09-01T10:00:00.000Z",
  revertedByActionId: null,
};
const actor = {
  userId: "U2",
  displayName: "Beam",
  groupId: "C1",
};

function product(values: typeof original | typeof sold): InventoryProduct {
  return {
    recordId: "rec1",
    productId: "A-1",
    uploadDate: null,
    airtableUrl: "https://airtable/r",
    ...values,
  };
}

function revertPending(
  overrides: Partial<PendingLineCommand> = {},
): PendingLineCommand {
  return {
    token: "tok",
    sourceEventId: "evt-revert",
    applyEventId: "evt-approve",
    kind: "revert",
    status: "applying",
    requesterUserId: "U2",
    groupId: "C1",
    productId: "A-1",
    soldPrice: null,
    before: sold,
    after: original,
    targetActionId: "act1",
    expiresAt: "2026-09-01T10:15:00.000Z",
    ...overrides,
  };
}

function deps(found: InventoryProduct | null = product(sold)) {
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
    setPendingAfter: vi.fn(),
    resetPending: vi.fn().mockResolvedValue(undefined),
    resolvePending: vi.fn().mockResolvedValue(undefined),
    finalizeAction: vi.fn().mockResolvedValue({ id: "revert1" }),
    latestReversible: vi.fn().mockResolvedValue(action),
  } satisfies LineRepository;
  return {
    inventory,
    repo,
    clock: {
      now: () => new Date("2026-09-01T10:05:00.000Z"),
    },
    ids: { next: () => "tok" },
  } satisfies SoldoutDeps;
}

it("creates mandatory confirmation for latest same-group action", async () => {
  const d = deps();

  const result = await prepareRevert(actor, "evt-revert", d);

  expect(result.kind).toBe("buttons");
  expect(d.repo.latestReversible).toHaveBeenCalledWith("C1");
  expect(d.repo.createPending).toHaveBeenCalledWith(expect.objectContaining({
    sourceEventId: "evt-revert",
    kind: "revert",
    targetActionId: "act1",
    before: sold,
    after: original,
  }));
});

it("refuses approval when Airtable has a newer edit", async () => {
  const d = deps(product({ ...sold, soldPrice: 1500 }));
  d.repo.claimPending = vi.fn().mockResolvedValue(revertPending());

  const result = await resolveRevert(
    "approve", "tok", actor, "evt-approve", "corr-revert", d,
  );

  expect(result.text).toContain("ข้อมูลสินค้าเปลี่ยนแล้ว");
  expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  expect(d.repo.resolvePending).toHaveBeenCalledWith(
    "tok", "evt-approve", "rejected", "Beam (U2)",
  );
});

it("rejects a pending row without an explicit target action", async () => {
  const d = deps();
  d.repo.claimPending = vi.fn().mockResolvedValue(
    revertPending({ targetActionId: null }),
  );

  await resolveRevert("approve", "tok", actor, "evt-approve", "corr-revert", d);

  expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  expect(d.repo.finalizeAction).not.toHaveBeenCalled();
});

it("recovers when Airtable was restored before D1 finalization", async () => {
  const d = deps(product(original));
  d.repo.claimPending = vi.fn().mockResolvedValue(revertPending());

  await resolveRevert("approve", "tok", actor, "evt-approve", "corr-revert", d);

  expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  expect(d.repo.finalizeAction).toHaveBeenCalledWith(expect.objectContaining({
    pendingToken: "tok",
    applyEventId: "evt-approve",
    targetActionId: "act1",
    kind: "revert",
    before: sold,
    after: original,
  }));
});

it("does not release applying ownership after an uncertain Airtable write", async () => {
  const d = deps();
  d.repo.claimPending = vi.fn().mockResolvedValue(revertPending());
  d.inventory.updateSaleValues.mockRejectedValueOnce(new Error("response lost"));

  await expect(resolveRevert(
    "approve", "tok", actor, "evt-approve", "corr-revert", d,
  )).rejects.toThrow("response lost");

  expect(d.repo.resetPending).not.toHaveBeenCalled();
});
