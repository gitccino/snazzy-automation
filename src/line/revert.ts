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
    revert: { productId: pending.productId, before: pending.before, after: pending.after },
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
    if (['failed','rejected','expired'].includes(existing.status)) return {kind:'text',text:'คำยืนยันหมดอายุหรือถูกใช้แล้ว'};
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
  const recovery = await deps.mutation.recover(action.productId,requester.groupId);
  if (recovery.status === 'busy') return {kind:'text',text:'⚠️ มีงานปรับปรุงสินค้ากำลังทำงานอยู่ กรุณาลองอีกครั้งภายหลัง'};
  const latest = await deps.repo.latestReversible(requester.groupId);
  if (latest?.id !== action.id) return {kind:'text',text:'⚠️ รายการที่ย้อนกลับได้เปลี่ยนแล้ว กรุณาส่ง /revert อีกครั้ง'};
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
  return {...confirmationReply(pending),recoveryWarning:recovery.warning};
}

export async function resolveRevert(
  decision: "approve" | "reject",
  token: string,
  actor: LineActor,
  applyEventId: string,
  correlationId: string,
  deps: SoldoutDeps,
): Promise<CommandReply> {
  const recovery = await deps.mutation.recoverToken(token,actor.groupId);
  if (recovery.status === 'busy') return {kind:'text',text:'⚠️ มีงานปรับปรุงสินค้ากำลังทำงานอยู่ กรุณาลองอีกครั้งภายหลัง'};
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
    return { kind: "text", text: `ย้อนกลับ ${pending.productId} สำเร็จ`, revertSuccess: true };
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
      await deps.mutation.write(pending,product.recordId,resolver,correlationId);
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
    await deps.mutation.committed(pending.productId);
    return {
      kind: "text",
      text: `ย้อนกลับ ${pending.productId} สำเร็จ`,
      revertSuccess: true,
      recoveryWarning: recovery.warning,
    };
  } catch (error) {
    // Claiming persists the complete revert intent. Even a read failure on this
    // attempt may follow an uncertain write on an earlier attempt; keep ownership.
    throw error;
  }
}
