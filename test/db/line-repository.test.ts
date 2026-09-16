import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";
import { fixedClock, sequentialIdGenerator } from "../helpers/fakes";
import { createLineRepository } from "../../src/db/line-repository";

const before = { inventoryStatus: "In" as const, soldPrice: null, soldAt: null, soldBy: null };
const after = { inventoryStatus: "Out" as const, soldPrice: 1290, soldAt: "2026-09-01T10:00:00.000Z", soldBy: "Mint (U1)" };

describe("line repository", () => {
  it("claims one webhook event once", async () => {
    const repo = createLineRepository(testEnv().DB, sequentialIdGenerator("line"), fixedClock("2026-09-01T10:00:00.000Z"));
    expect(await repo.claimEvent("evt-1", "C1")).toBe(true);
    expect(await repo.claimEvent("evt-1", "C1")).toBe(false);
    await repo.releaseEvent("evt-1");
    expect(await repo.claimEvent("evt-1", "C1")).toBe(true);
  });

  it("claims one unexpired pending token once and can reset a failed apply", async () => {
    const repo = createLineRepository(testEnv().DB, sequentialIdGenerator("line"), fixedClock("2026-09-01T10:00:00.000Z"));
    await repo.createPending({ token: "tok-1", sourceEventId: "evt-command", applyEventId: null, kind: "soldout", status: "pending", requesterUserId: "U1", groupId: "C1", productId: "A-1", soldPrice: 1290, before, after, targetActionId: null, expiresAt: "2026-09-01T10:10:00.000Z" });
    expect(await repo.claimPending("tok-1", "C1", "revert", "evt-malicious", "2026-09-01T10:05:00.000Z")).toBeNull();
    expect((await repo.claimPending("tok-1", "C1", "soldout", "evt-approve", "2026-09-01T10:05:00.000Z"))?.status).toBe("applying");
    expect(await repo.claimPending("tok-1", "C1", "soldout", "evt-other", "2026-09-01T10:05:00.000Z")).toBeNull();
    expect(await repo.claimPending("tok-1", "C1", "soldout", "evt-approve", "2026-09-01T10:11:00.000Z")).not.toBeNull();
    await repo.resetPending("tok-1", "evt-approve");
    expect(await repo.claimPending("tok-1", "C1", "soldout", "evt-retry", "2026-09-01T10:05:00.000Z")).not.toBeNull();
  });

  it("returns latest unreverted action in the same group", async () => {
    const repo = createLineRepository(testEnv().DB, sequentialIdGenerator("line"), fixedClock("2026-09-01T10:00:00.000Z"));
    await repo.createPending({ token: "tok-action", sourceEventId: "evt-command-action", applyEventId: null, kind: "soldout", status: "pending", requesterUserId: "U1", groupId: "C1", productId: "A-1", soldPrice: 1290, before, after, targetActionId: null, expiresAt: "2026-09-01T10:10:00.000Z" });
    await repo.claimPending("tok-action", "C1", "soldout", "evt-approve", "2026-09-01T10:05:00.000Z");
    await repo.finalizeAction({ pendingToken: "tok-action", applyEventId: "evt-approve", targetActionId: null, groupId: "C1", productId: "A-1", kind: "soldout", before, after, actor: "Mint (U1)", correlationId: "corr-1" });
    expect((await repo.latestReversible("C1"))?.productId).toBe("A-1");
    expect(await repo.latestReversible("C2")).toBeNull();
  });
});
