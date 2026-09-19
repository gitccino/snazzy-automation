import { matchesSaleValues } from "./airtable-inventory";
import {
  actorText,
  notFoundText,
  saleValuesText,
} from "./messages";
import type {
  LineActor,
  PendingLineCommand,
} from "./types";
import type {
  CommandReply,
  SoldoutDeps,
} from "./soldout";

function confirmationReply(
  pending: PendingLineCommand,
): CommandReply {
  return {
    kind: "buttons",
    text:
      `ยืนยันย้อนกลับ ${pending.productId}\nจาก\n` +
      `${saleValuesText(pending.before)}\nเป็น\n` +
      saleValuesText(pending.after),
    approveData:
      `action=revert&decision=approve&token=${pending.token}`,
    rejectData:
      `action=revert&decision=reject&token=${pending.token}`,
  };
}

export async function prepareRevert(
  requester: LineActor,
  sourceEventId: string,
  deps: SoldoutDeps,
): Promise<CommandReply> {
  const existing = await deps.repo.findPendingBySourceEvent(sourceEventId);
  if (existing !== null) {
    if (existing.kind !== "revert") {
      throw new Error("source event belongs to another command");
    }
    return confirmationReply(existing);
  }

  const action = await deps.repo.latestReversible(requester.groupId);
  if (action === null) {
    return {
      kind: "text",
      text: "ไม่มีคำสั่งที่ย้อนกลับได้ในกลุ่มนี้",
    };
  }
  const product = await deps.inventory.findByProductId(action.productId);
  if (product === null) {
    return {
      kind: "text",
      text: notFoundText(action.productId),
    };
  }
  if (!matchesSaleValues(product, action.after)) {
    return {
      kind: "text",
      text:
        "ข้อมูลสินค้าเปลี่ยนแล้ว " +
        "ไม่สามารถย้อนกลับโดยไม่เขียนทับข้อมูลใหม่",
    };
  }

  const candidate: PendingLineCommand = {
    token: deps.ids.next(),
    sourceEventId,
    applyEventId: null,
    kind: "revert",
    status: "pending",
    requesterUserId: requester.userId,
    groupId: requester.groupId,
    productId: action.productId,
    soldPrice: null,
    before: action.after,
    after: action.before,
    targetActionId: action.id,
    expiresAt: new Date(
      deps.clock.now().getTime() + 10 * 60_000,
    ).toISOString(),
  };
  const pending = await deps.repo.createPending(candidate)
    ?? await deps.repo.findPendingBySourceEvent(sourceEventId);
  if (pending === null) {
    return {
      kind: "text",
      text: "มีคำยืนยันย้อนกลับรายการนี้อยู่แล้ว",
    };
  }
  if (pending.kind !== "revert") {
    throw new Error("source event belongs to another command");
  }
  return confirmationReply(pending);
}

export async function resolveRevert(
  decision: "approve" | "reject",
  token: string,
  actor: LineActor,
  applyEventId: string,
  correlationId: string,
  deps: SoldoutDeps,
): Promise<CommandReply> {
  const pending = await deps.repo.claimPending(
    token,
    actor.groupId,
    "revert",
    applyEventId,
    deps.clock.now().toISOString(),
  );
  if (pending === null) {
    return {
      kind: "text",
      text: "คำยืนยันหมดอายุหรือถูกใช้แล้ว",
    };
  }

  const resolver = actorText(actor.displayName, actor.userId);
  if (pending.status === "approved") {
    return { kind: "text", text: `ย้อนกลับ ${pending.productId} สำเร็จ` };
  }
  if (decision === "reject") {
    await deps.repo.resolvePending(
      token,
      applyEventId,
      "rejected",
      resolver,
    );
    return {
      kind: "text",
      text: `ยกเลิกการย้อนกลับ ${pending.productId}`,
    };
  }
  if (pending.targetActionId === null) {
    await deps.repo.resolvePending(
      token,
      applyEventId,
      "rejected",
      resolver,
    );
    return {
      kind: "text",
      text: "คำยืนยันไม่มีรายการต้นทาง",
    };
  }

  try {
    const product = await deps.inventory.findByProductId(pending.productId);
    if (product === null) {
      await deps.repo.resolvePending(
        token,
        applyEventId,
        "rejected",
        resolver,
      );
      return {
        kind: "text",
        text: notFoundText(pending.productId),
      };
    }

    if (matchesSaleValues(product, pending.before)) {
      await deps.inventory.updateSaleValues(product.recordId, pending.after);
    } else if (matchesSaleValues(product, pending.after)) {
      // A previous attempt may already have restored the exact values.
    } else {
      await deps.repo.resolvePending(
        token,
        applyEventId,
        "rejected",
        resolver,
      );
      return {
        kind: "text",
        text: "ข้อมูลสินค้าเปลี่ยนแล้ว ไม่ได้เขียนทับ กรุณาตรวจ Airtable",
      };
    }

    await deps.repo.finalizeAction({
      pendingToken: token,
      applyEventId,
      targetActionId: pending.targetActionId,
      groupId: actor.groupId,
      productId: pending.productId,
      kind: "revert",
      before: pending.before,
      after: pending.after,
      actor: resolver,
      correlationId,
    });
    return {
      kind: "text",
      text: `ย้อนกลับ ${pending.productId} สำเร็จ`,
    };
  } catch (error) {
    // Claiming persists the complete revert intent. Even a read failure on this
    // attempt may follow an uncertain write on an earlier attempt; keep ownership.
    throw error;
  }
}
