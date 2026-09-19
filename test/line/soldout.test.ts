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
    findEventReply: vi.fn(),
    saveEventReply: vi.fn(),
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

it("keeps the first approver's applying ownership after an ambiguous intent-write failure", async () => {
  const d = deps();
  const pending = soldoutPending();
  let owner = "evt-approve";
  d.repo.claimPending = vi.fn(async (_token, _groupId, _kind, eventId) =>
    owner === eventId ? pending : null,
  );
  d.repo.setPendingAfter = vi.fn().mockRejectedValue(new Error("D1 response lost"));
  d.repo.resetPending = vi.fn(async () => { owner = ""; });

  await expect(resolveSoldout("approve", "tok", actor, "evt-approve", "corr", d))
    .rejects.toThrow("D1 response lost");

  const differentActor = { ...actor, userId: "U2", displayName: "Ploy" };
  await expect(resolveSoldout("approve", "tok", differentActor, "evt-other", "corr-other", d))
    .resolves.toEqual({ kind: "text", text: "คำยืนยันหมดอายุหรือถูกใช้แล้ว" });
  expect(d.repo.resetPending).not.toHaveBeenCalled();
});

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  "does not persist or mutate for invalid sold price %p",
  async (soldPrice) => {
    const d = deps();

    await expect(prepareSoldout(
      { productId: "A-1", soldPrice }, actor, "evt-command", true, d,
    )).resolves.toEqual({
      kind: "text",
      text: "ราคาต้องเป็นจำนวนเต็มบาท เช่น THB 1,290",
    });

    expect(d.repo.createPending).not.toHaveBeenCalled();
    expect(d.inventory.findByProductId).not.toHaveBeenCalled();
    expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  },
);

it("rejects a claimed command without mutating Airtable", async () => {
  const d = deps();
  d.repo.claimPending = vi.fn().mockResolvedValue(soldoutPending());

  await expect(resolveSoldout("reject", "tok", actor, "evt-approve", "corr", d))
    .resolves.toEqual({ kind: "text", text: "ยกเลิกการขาย A-1" });

  expect(d.repo.resolvePending).toHaveBeenCalledWith(
    "tok", "evt-approve", "rejected", "Mint (U1)",
  );
  expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  expect(d.repo.finalizeAction).not.toHaveBeenCalled();
});

it("returns an expired-or-used reply when the pending command cannot be claimed", async () => {
  const d = deps();
  d.repo.claimPending = vi.fn().mockResolvedValue(null);

  await expect(resolveSoldout("approve", "tok", actor, "evt-approve", "corr", d))
    .resolves.toEqual({ kind: "text", text: "คำยืนยันหมดอายุหรือถูกใช้แล้ว" });

  expect(d.repo.resolvePending).not.toHaveBeenCalled();
  expect(d.inventory.findByProductId).not.toHaveBeenCalled();
  expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
});

it("rejects rather than overwrites Airtable values changed after preparation", async () => {
  const d = deps({
    ...product,
    inventoryStatus: "Out",
    soldPrice: 900,
    soldAt: "2026-09-01T09:00:00.000Z",
    soldBy: "Other (U9)",
  });
  d.repo.claimPending = vi.fn().mockResolvedValue(soldoutPending());

  await expect(resolveSoldout("approve", "tok", actor, "evt-approve", "corr", d))
    .resolves.toEqual({
      kind: "text",
      text: "ข้อมูลสินค้าเปลี่ยนแล้ว ไม่ได้เขียนทับ กรุณาตรวจ Airtable",
    });

  expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  expect(d.repo.resolvePending).toHaveBeenCalledWith(
    "tok", "evt-approve", "rejected", "Mint (U1)",
  );
});

it("waits for durable intent persistence before writing Airtable", async () => {
  const d = deps();
  d.repo.claimPending = vi.fn().mockResolvedValue(soldoutPending());
  let beginIntentWrite: (() => void) | undefined;
  let finishIntentWrite: (() => void) | undefined;
  const intentWriteBegan = new Promise<void>((resolve) => { beginIntentWrite = resolve; });
  const intentWrite = new Promise<void>((resolve) => { finishIntentWrite = resolve; });
  d.repo.setPendingAfter = vi.fn(() => {
    beginIntentWrite?.();
    return intentWrite;
  });

  const resolution = resolveSoldout("approve", "tok", actor, "evt-approve", "corr", d);
  await intentWriteBegan;
  expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();

  finishIntentWrite?.();
  await resolution;
  expect(d.inventory.updateSaleValues).toHaveBeenCalledOnce();
});
