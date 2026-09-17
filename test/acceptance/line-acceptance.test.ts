import { describe, expect, it, vi } from "vitest";
import type { LineRepository } from "../../src/db/line-repository";
import type { InventoryClient } from "../../src/line/airtable-inventory";
import { parseLineCommand } from "../../src/line/parser";
import { prepareRevert, resolveRevert } from "../../src/line/revert";
import {
  prepareSoldout,
  resolveSoldout,
  type SoldoutDeps,
} from "../../src/line/soldout";
import type {
  InventoryProduct,
  PendingLineCommand,
  ReversibleLineAction,
  SaleValues,
} from "../../src/line/types";

const parserCases: Array<[text: string, ok: boolean, typeOrCode: string]> = [
  ["/help", true, "help"],
  ["/upload", true, "upload"],
  ["/docs", true, "docs"],
  ["/revert", true, "revert"],
  ["/search A-1234", true, "search"],
  ["/search A1234", false, "invalid_product_id"],
  ["/search A 1234", false, "invalid_product_id"],
  ["/soldout A-1234 thb 1290", true, "soldout"],
  ["/soldout A-1234 THB 1,290", true, "soldout"],
  ["/soldout รหัส 1234 ราคา 1290", true, "soldout"],
  ["/soldout รหัสสินค้า 1234 ราคา 1,290 บาท", true, "soldout"],
  ["/soldout A1234 ราคา 1290", false, "invalid_product_id"],
  ["/soldout A 1234 ราคา 1290", false, "invalid_product_id"],
  ["/soldout ราคา 1290", false, "missing_product_id"],
  ["/soldout A-1", false, "missing_price"],
  ["/soldout A-1 A-2 ราคา 1290", false, "multiple_product_ids"],
  ["/soldout A-1 ราคา 100 ราคา 200", false, "multiple_prices"],
  ["/soldout A-1 thb 12.50", false, "invalid_price"],
  ["/soldout A-1 ราคา 1,29 บาท", false, "invalid_price"],
  ["hello", false, "unknown_command"],
];

const original: SaleValues = {
  inventoryStatus: "In",
  soldPrice: null,
  soldAt: null,
  soldBy: null,
};
const sold: SaleValues = {
  inventoryStatus: "Out",
  soldPrice: 100,
  soldAt: "2026-09-01T10:00:00.000Z",
  soldBy: "Mint (U1)",
};

function actor() {
  return { userId: "U1", displayName: "Mint", groupId: "C1" };
}

function product(values: SaleValues): InventoryProduct {
  return {
    recordId: "rec1",
    productId: "A-1",
    uploadDate: "2026-09-01",
    airtableUrl: "https://airtable/r",
    ...values,
  };
}

function action(): ReversibleLineAction {
  return {
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
}

function pending(kind: "soldout" | "revert"): PendingLineCommand {
  return {
    token: "tok",
    sourceEventId: kind === "soldout" ? "evt-soldout" : "evt-revert",
    applyEventId: "evt-approve",
    kind,
    status: "applying",
    requesterUserId: "U0",
    groupId: "C1",
    productId: "A-1",
    soldPrice: kind === "soldout" ? 100 : null,
    before: kind === "soldout" ? original : sold,
    after: kind === "soldout"
      ? { inventoryStatus: "Out", soldPrice: 100, soldAt: null, soldBy: null }
      : original,
    targetActionId: kind === "revert" ? "act1" : null,
    expiresAt: "2026-09-01T10:10:00.000Z",
  };
}

function deps(found: InventoryProduct | null): SoldoutDeps {
  const inventory = {
    findByProductId: vi.fn().mockResolvedValue(found),
    updateSaleValues: vi.fn().mockResolvedValue(undefined),
  } satisfies InventoryClient;
  const repo = {
    claimEvent: vi.fn(),
    releaseEvent: vi.fn(),
    findPendingBySourceEvent: vi.fn().mockResolvedValue(null),
    createPending: vi.fn().mockImplementation(async (value) => value),
    claimPending: vi.fn().mockResolvedValue(pending("soldout")),
    setPendingAfter: vi.fn().mockResolvedValue(undefined),
    resetPending: vi.fn().mockResolvedValue(undefined),
    resolvePending: vi.fn().mockResolvedValue(undefined),
    finalizeAction: vi.fn().mockResolvedValue({ id: "action-new" }),
    latestReversible: vi.fn().mockResolvedValue(action()),
  } satisfies LineRepository;
  return {
    clock: { now: () => new Date("2026-09-01T10:00:00.000Z") },
    ids: { next: () => "tok" },
    inventory,
    repo,
  };
}

describe("LINE acceptance: exactly 30 cases", () => {
  it.each(parserCases)("parser: %s", (text, ok, typeOrCode) => {
    const result = parseLineCommand(text);
    expect(result.ok).toBe(ok);
    expect(result.ok ? result.command.type : result.code).toBe(typeOrCode);
  });

  it("21 unknown Product returns not found", async () => {
    const result = await prepareSoldout(
      { productId: "A-404", soldPrice: 100 }, actor(), "evt-command", true, deps(null),
    );
    expect(result.text).toContain("ไม่พบสินค้า");
  });

  it("22 already-Out does not mutate", async () => {
    const d = deps(product(sold));
    await prepareSoldout({ productId: "A-1", soldPrice: 100 }, actor(), "evt-command", true, d);
    expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  });

  it("23 confirmation stores ten-minute expiry", async () => {
    const d = deps(product(original));
    await prepareSoldout({ productId: "A-1", soldPrice: 100 }, actor(), "evt-command", true, d);
    expect(d.repo.createPending).toHaveBeenCalledWith(expect.objectContaining({
      expiresAt: "2026-09-01T10:10:00.000Z",
    }));
  });

  it("24 disabled confirmation uses durable mutation path", async () => {
    const d = deps(product(original));
    vi.mocked(d.repo.claimPending).mockResolvedValue({
      ...pending("soldout"), applyEventId: "evt-command",
    });
    await prepareSoldout({ productId: "A-1", soldPrice: 100 }, actor(), "evt-command", false, d);
    expect(d.inventory.updateSaleValues).toHaveBeenCalledTimes(1);
    expect(d.repo.finalizeAction).toHaveBeenCalledTimes(1);
  });

  it("25 duplicate or expired soldout callback does nothing", async () => {
    const d = deps(product(original));
    vi.mocked(d.repo.claimPending).mockResolvedValue(null);
    await resolveSoldout("approve", "used", actor(), "evt-approve", "corr", d);
    expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  });

  it("26 soldout approver becomes Sold By", async () => {
    const d = deps(product(original));
    await resolveSoldout("approve", "tok", actor(), "evt-approve", "corr", d);
    expect(d.inventory.updateSaleValues).toHaveBeenCalledWith(
      "rec1", expect.objectContaining({ soldBy: "Mint (U1)" }),
    );
  });

  it("27 revert reads only same-group latest action", async () => {
    const d = deps(product(sold));
    await prepareRevert(actor(), "evt-revert", d);
    expect(d.repo.latestReversible).toHaveBeenCalledWith("C1");
  });

  it("28 revert always creates confirmation", async () => {
    const d = deps(product(sold));
    const result = await prepareRevert(actor(), "evt-revert", d);
    expect(result.kind).toBe("buttons");
  });

  it("29 revert refuses newer Airtable edit", async () => {
    const d = deps(product({ ...sold, soldPrice: 200 }));
    vi.mocked(d.repo.claimPending).mockResolvedValue(pending("revert"));
    await resolveRevert("approve", "tok", actor(), "evt-approve", "corr", d);
    expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  });

  it("30 revert restores exact values and finalizes target action", async () => {
    const d = deps(product(sold));
    vi.mocked(d.repo.claimPending).mockResolvedValue(pending("revert"));
    await resolveRevert("approve", "tok", actor(), "evt-approve", "corr", d);
    expect(d.inventory.updateSaleValues).toHaveBeenCalledWith("rec1", original);
    expect(d.repo.finalizeAction).toHaveBeenCalledWith(expect.objectContaining({
      targetActionId: "act1", kind: "revert",
    }));
  });
});
