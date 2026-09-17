import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";
import { fixedClock, sequentialIdGenerator } from "../helpers/fakes";
import { createLineRepository } from "../../src/db/line-repository";
import type { PendingLineCommand, ReversibleLineAction, SaleValues } from "../../src/line/types";

const before = { inventoryStatus: "In" as const, soldPrice: null, soldAt: null, soldBy: null };
const after = { inventoryStatus: "Out" as const, soldPrice: 1290, soldAt: "2026-09-01T10:00:00.000Z", soldBy: "Mint (U1)" };
const revertedAfter = { inventoryStatus: "In" as const, soldPrice: null, soldAt: null, soldBy: null };
const applyTime = "2026-09-01T10:05:00.000Z";
const expiresAt = "2026-09-01T10:10:00.000Z";

type FinalizeInput = Omit<ReversibleLineAction, "id" | "createdAt" | "revertedByActionId"> & {
  applyEventId: string;
  targetActionId: string | null;
};

let nextFixture = 1;

function pendingCommand(overrides: Partial<PendingLineCommand> = {}): PendingLineCommand {
  const suffix = nextFixture++;
  return {
    token: `tok-fixture-${suffix}`,
    sourceEventId: `evt-command-fixture-${suffix}`,
    applyEventId: null,
    kind: "soldout",
    status: "pending",
    requesterUserId: "U1",
    groupId: `C-fixture-${suffix}`,
    productId: `A-${suffix}`,
    soldPrice: 1290,
    before,
    after,
    targetActionId: null,
    expiresAt,
    ...overrides,
  };
}

function finalizeInput(command: PendingLineCommand, applyEventId: string, overrides: Partial<FinalizeInput> = {}): FinalizeInput {
  return {
    pendingToken: command.token,
    applyEventId,
    targetActionId: command.targetActionId,
    groupId: command.groupId,
    productId: command.productId,
    kind: command.kind,
    before: command.before,
    after: command.after,
    actor: "Mint (U1)",
    correlationId: `corr-${command.token}`,
    ...overrides,
  };
}

async function createApplyingCommand(
  command: PendingLineCommand,
  applyEventId = `evt-apply-${command.token}`,
) {
  const repo = createLineRepository(testEnv().DB, sequentialIdGenerator(`line-${command.token}`), fixedClock("2026-09-01T10:00:00.000Z"));
  await repo.createPending(command);
  expect(await repo.claimPending(command.token, command.groupId, command.kind, applyEventId, applyTime)).toMatchObject({ status: "applying" });
  return { repo, applyEventId };
}

async function createApplyingCommandWithoutClaimValidation(
  command: PendingLineCommand,
  applyEventId = `evt-apply-${command.token}`,
) {
  const repo = createLineRepository(testEnv().DB, sequentialIdGenerator(`line-${command.token}`), fixedClock("2026-09-01T10:00:00.000Z"));
  await repo.createPending(command);
  await testEnv().DB.prepare(
    "UPDATE pending_line_commands SET status = 'applying', apply_event_id = ? WHERE token = ?",
  ).bind(applyEventId, command.token).run();
  return { repo, applyEventId };
}

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

  it("does not claim a pending revert after a newer same-group sold-out action", async () => {
    const target = pendingCommand({ groupId: "C-stale-revert", productId: "A-target" });
    const targetSetup = await createApplyingCommand(target);
    const targetAction = await targetSetup.repo.finalizeAction(finalizeInput(target, targetSetup.applyEventId));
    const revert = pendingCommand({
      kind: "revert",
      groupId: target.groupId,
      productId: target.productId,
      soldPrice: null,
      before: after,
      after: revertedAfter,
      targetActionId: targetAction.id,
    });
    const repo = createLineRepository(testEnv().DB, sequentialIdGenerator("line-stale-revert"), fixedClock("2026-09-01T10:00:00.000Z"));
    await repo.createPending(revert);
    const newer = pendingCommand({ groupId: target.groupId, productId: "A-newer" });
    const newerSetup = await createApplyingCommand(newer);
    await newerSetup.repo.finalizeAction(finalizeInput(newer, newerSetup.applyEventId));

    expect(await repo.claimPending(
      revert.token, revert.groupId, "revert", "evt-stale-approve", applyTime,
    )).toBeNull();
    expect((await repo.findPendingBySourceEvent(revert.sourceEventId))?.status).toBe("pending");
  });

  it("returns latest unreverted action in the same group", async () => {
    const repo = createLineRepository(testEnv().DB, sequentialIdGenerator("line"), fixedClock("2026-09-01T10:00:00.000Z"));
    await repo.createPending({ token: "tok-action", sourceEventId: "evt-command-action", applyEventId: null, kind: "soldout", status: "pending", requesterUserId: "U1", groupId: "C1", productId: "A-1", soldPrice: 1290, before, after, targetActionId: null, expiresAt: "2026-09-01T10:10:00.000Z" });
    await repo.claimPending("tok-action", "C1", "soldout", "evt-approve", "2026-09-01T10:05:00.000Z");
    await repo.finalizeAction({ pendingToken: "tok-action", applyEventId: "evt-approve", targetActionId: null, groupId: "C1", productId: "A-1", kind: "soldout", before, after, actor: "Mint (U1)", correlationId: "corr-1" });
    expect((await repo.latestReversible("C1"))?.productId).toBe("A-1");
    expect(await repo.latestReversible("C2")).toBeNull();
  });

  it("expires an unclaimed pending token", async () => {
    const command = pendingCommand({ expiresAt: "2026-09-01T10:00:00.000Z" });
    const repo = createLineRepository(testEnv().DB, sequentialIdGenerator("line-expired"), fixedClock("2026-09-01T10:00:00.000Z"));
    await repo.createPending(command);

    expect(await repo.claimPending(command.token, command.groupId, command.kind, "evt-expired", applyTime)).toBeNull();
    expect((await repo.findPendingBySourceEvent(command.sourceEventId))?.status).toBe("expired");
  });

  it("deduplicates a pending command by source event", async () => {
    const command = pendingCommand();
    const duplicate = pendingCommand({ sourceEventId: command.sourceEventId });
    const repo = createLineRepository(testEnv().DB, sequentialIdGenerator("line-source"), fixedClock("2026-09-01T10:00:00.000Z"));

    await repo.createPending(command);
    expect(await repo.createPending(duplicate)).toMatchObject({ token: command.token, sourceEventId: command.sourceEventId });
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS count FROM pending_line_commands WHERE source_event_id = ?").bind(command.sourceEventId).first<{ count: number }>())?.count).toBe(1);
  });

  it("finalizes an action and its audit event once when retried", async () => {
    const command = pendingCommand();
    const { repo, applyEventId } = await createApplyingCommand(command);
    const input = finalizeInput(command, applyEventId);

    const first = await repo.finalizeAction(input);
    const retry = await repo.finalizeAction(input);

    expect(retry.id).toBe(first.id);
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS count FROM line_actions WHERE pending_token = ?").bind(command.token).first<{ count: number }>())?.count).toBe(1);
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE correlation_id = ?").bind(input.correlationId).first<{ count: number }>())?.count).toBe(1);
  });

  it("concurrently finalizes one durable action and audit event", async () => {
    const command = pendingCommand();
    const { repo, applyEventId } = await createApplyingCommand(command);
    const input = finalizeInput(command, applyEventId);

    const [first, second] = await Promise.all([repo.finalizeAction(input), repo.finalizeAction(input)]);

    expect(second.id).toBe(first.id);
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS count FROM line_actions WHERE pending_token = ?").bind(command.token).first<{ count: number }>())?.count).toBe(1);
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE correlation_id = ?").bind(input.correlationId).first<{ count: number }>())?.count).toBe(1);
  });

  it("marks the sold-out target when finalizing a revert", async () => {
    const soldout = pendingCommand({ groupId: "C-revert", productId: "A-revert" });
    const soldoutSetup = await createApplyingCommand(soldout);
    const soldoutAction = await soldoutSetup.repo.finalizeAction(finalizeInput(soldout, soldoutSetup.applyEventId));
    const revert = pendingCommand({
      kind: "revert",
      groupId: soldout.groupId,
      productId: soldout.productId,
      soldPrice: null,
      before: after,
      after: revertedAfter,
      targetActionId: soldoutAction.id,
    });
    const revertSetup = await createApplyingCommand(revert);

    const revertAction = await revertSetup.repo.finalizeAction(finalizeInput(revert, revertSetup.applyEventId));

    expect((await testEnv().DB.prepare("SELECT reverted_by_action_id FROM line_actions WHERE id = ?").bind(soldoutAction.id).first<{ reverted_by_action_id: string | null }>())?.reverted_by_action_id).toBe(revertAction.id);
    expect(await revertSetup.repo.latestReversible(soldout.groupId)).toBeNull();
  });

  it("allows only one active revert command per target action", async () => {
    const target = pendingCommand({ groupId: "C-one-revert", productId: "A-one-revert" });
    const targetSetup = await createApplyingCommand(target);
    const targetAction = await targetSetup.repo.finalizeAction(finalizeInput(target, targetSetup.applyEventId));
    const first = pendingCommand({ kind: "revert", groupId: target.groupId, productId: target.productId, soldPrice: null, before: after, after: revertedAfter, targetActionId: targetAction.id });
    const second = pendingCommand({ kind: "revert", groupId: target.groupId, productId: target.productId, soldPrice: null, before: after, after: revertedAfter, targetActionId: targetAction.id });
    const repo = createLineRepository(testEnv().DB, sequentialIdGenerator("line-one-revert"), fixedClock("2026-09-01T10:00:00.000Z"));

    expect((await repo.createPending(first))?.token).toBe(first.token);
    expect(await repo.createPending(second)).toBeNull();
  });

  it("rejects action input that differs from the owned pending command", async () => {
    const command = pendingCommand();
    const { repo, applyEventId } = await createApplyingCommand(command);
    const mismatches: Array<Partial<FinalizeInput>> = [
      { groupId: "C-other" },
      { kind: "revert" },
      { productId: "A-other" },
      { before: after },
      { after: before },
      { targetActionId: "action-other" },
    ];

    for (const mismatch of mismatches) {
      await expect(repo.finalizeAction(finalizeInput(command, applyEventId, mismatch))).rejects.toThrow("does not match owned pending command");
    }
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS count FROM line_actions WHERE pending_token = ?").bind(command.token).first<{ count: number }>())?.count).toBe(0);
  });

  it("rejects finalization by a non-owner event without writing an action or audit", async () => {
    const command = pendingCommand();
    const { repo, applyEventId } = await createApplyingCommand(command);
    const input = finalizeInput(command, "evt-not-owner");

    await expect(repo.finalizeAction(input)).rejects.toThrow("pending command is not owned by this event");
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS count FROM line_actions WHERE pending_token = ?").bind(command.token).first<{ count: number }>())?.count).toBe(0);
    expect((await testEnv().DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE correlation_id = ?").bind(input.correlationId).first<{ count: number }>())?.count).toBe(0);
    expect((await repo.findPendingBySourceEvent(command.sourceEventId))?.applyEventId).toBe(applyEventId);
  });

  it("rejects a revert whose target belongs to another group", async () => {
    const foreign = pendingCommand({ groupId: "C-foreign", productId: "A-foreign" });
    const foreignSetup = await createApplyingCommand(foreign);
    const foreignAction = await foreignSetup.repo.finalizeAction(finalizeInput(foreign, foreignSetup.applyEventId));
    const command = pendingCommand({ kind: "revert", groupId: "C-current", productId: foreign.productId, soldPrice: null, before: after, after: revertedAfter, targetActionId: foreignAction.id });
    const { repo, applyEventId } = await createApplyingCommandWithoutClaimValidation(command);

    await expect(repo.finalizeAction(finalizeInput(command, applyEventId))).rejects.toThrow("revert target is no longer reversible");
  });

  it("rejects a revert whose sold-out target has a different product", async () => {
    const target = pendingCommand({ groupId: "C-target-product", productId: "A-target" });
    const targetSetup = await createApplyingCommand(target);
    const targetAction = await targetSetup.repo.finalizeAction(finalizeInput(target, targetSetup.applyEventId));
    const command = pendingCommand({ kind: "revert", groupId: target.groupId, productId: "A-other", soldPrice: null, before: after, after: revertedAfter, targetActionId: targetAction.id });
    const { repo, applyEventId } = await createApplyingCommandWithoutClaimValidation(command);

    await expect(repo.finalizeAction(finalizeInput(command, applyEventId))).rejects.toThrow("revert target is no longer reversible");
  });

  it("rejects a reverted target and a non-sold-out target", async () => {
    const soldout = pendingCommand({ groupId: "C-target-state", productId: "A-target-state" });
    const soldoutSetup = await createApplyingCommand(soldout);
    const soldoutAction = await soldoutSetup.repo.finalizeAction(finalizeInput(soldout, soldoutSetup.applyEventId));
    const firstRevert = pendingCommand({ kind: "revert", groupId: soldout.groupId, productId: soldout.productId, soldPrice: null, before: after, after: revertedAfter, targetActionId: soldoutAction.id });
    const firstRevertSetup = await createApplyingCommand(firstRevert);
    const firstRevertAction = await firstRevertSetup.repo.finalizeAction(finalizeInput(firstRevert, firstRevertSetup.applyEventId));
    const staleTarget = pendingCommand({ kind: "revert", groupId: soldout.groupId, productId: soldout.productId, soldPrice: null, before: after, after: revertedAfter, targetActionId: soldoutAction.id });
    const staleSetup = await createApplyingCommandWithoutClaimValidation(staleTarget);
    const wrongType = pendingCommand({ kind: "revert", groupId: soldout.groupId, productId: soldout.productId, soldPrice: null, before: after, after: revertedAfter, targetActionId: firstRevertAction.id });
    const wrongTypeSetup = await createApplyingCommandWithoutClaimValidation(wrongType);

    await expect(staleSetup.repo.finalizeAction(finalizeInput(staleTarget, staleSetup.applyEventId))).rejects.toThrow("revert target is no longer reversible");
    await expect(wrongTypeSetup.repo.finalizeAction(finalizeInput(wrongType, wrongTypeSetup.applyEventId))).rejects.toThrow("revert target is no longer reversible");
  });
});
