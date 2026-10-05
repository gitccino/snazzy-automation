import type { LineRepository } from "../db/line-repository";
import type { IdGenerator } from "../shared/ids";
import type { Clock } from "../shared/time";
import {
  matchesSaleValues,
  type InventoryClient,
} from "./airtable-inventory";
import {
  actorText,
  alreadyOutText,
  notFoundText,
  parseErrorText,
} from "./messages";
import type {
  LineActor,
  PendingLineCommand,
  SaleValues,
} from "./types";
import type { SearchCardReply } from "./search-card";

export type CommandReply =
  | SearchCardReply
  | { kind: "text"; text: string }
  | {
      kind: "buttons";
      text: string;
      approveData: string;
      rejectData: string;
      sale?: { productId: string; soldPrice: number };
    };

export interface SoldoutDeps {
  inventory: InventoryClient;
  repo: LineRepository;
  clock: Clock;
  ids: IdGenerator;
}

function saleReply(productId: string, soldPrice: number): CommandReply {
  return {
    kind: "text",
    text: `บันทึก ${productId} เป็น Out ราคา ${soldPrice.toLocaleString("en-US")} บาท`,
  };
}

function confirmationReply(pending: PendingLineCommand): CommandReply {
  const price = pending.soldPrice;
  if (price === null) {
    throw new Error("soldout pending command has no price");
  }
  return {
    kind: "buttons",
    sale: { productId: pending.productId, soldPrice: price },
    text: `ยืนยันขาย ${pending.productId} ราคา ${price.toLocaleString("en-US")} บาท`,
    approveData: `action=soldout&decision=approve&token=${pending.token}`,
    rejectData: `action=soldout&decision=reject&token=${pending.token}`,
  };
}

export async function prepareSoldout(
  input: { productId: string; soldPrice: number },
  requester: LineActor,
  sourceEventId: string,
  confirmationEnabled: boolean,
  deps: SoldoutDeps,
): Promise<CommandReply> {
  if (!Number.isSafeInteger(input.soldPrice) || input.soldPrice <= 0) {
    return { kind: "text", text: parseErrorText("invalid_price") };
  }

  const existing = await deps.repo.findPendingBySourceEvent(sourceEventId);
  if (existing !== null) {
    return confirmationEnabled
      ? confirmationReply(existing)
      : resolveSoldout(
          "approve",
          existing.token,
          requester,
          sourceEventId,
          sourceEventId,
          deps,
        );
  }

  const product = await deps.inventory.findByProductId(input.productId);
  if (product === null) {
    return { kind: "text", text: notFoundText(input.productId) };
  }
  if (product.inventoryStatus === "Out") {
    return { kind: "text", text: alreadyOutText(product) };
  }

  const before: SaleValues = {
    inventoryStatus: product.inventoryStatus,
    soldPrice: product.soldPrice,
    soldAt: product.soldAt,
    soldBy: product.soldBy,
  };
  const candidate: PendingLineCommand = {
    token: deps.ids.next(),
    sourceEventId,
    applyEventId: null,
    kind: "soldout",
    status: "pending",
    requesterUserId: requester.userId,
    groupId: requester.groupId,
    productId: input.productId,
    soldPrice: input.soldPrice,
    before,
    after: {
      inventoryStatus: "Out",
      soldPrice: input.soldPrice,
      soldAt: null,
      soldBy: null,
    },
    targetActionId: null,
    expiresAt: new Date(deps.clock.now().getTime() + 10 * 60_000).toISOString(),
  };
  const pending = await deps.repo.createPending(candidate)
    ?? await deps.repo.findPendingBySourceEvent(sourceEventId);
  if (pending === null) {
    return { kind: "text", text: `มีคำสั่งสำหรับ ${input.productId} ที่รอยืนยันหรือกำลังดำเนินการอยู่` };
  }

  return confirmationEnabled
    ? confirmationReply(pending)
    : resolveSoldout(
        "approve",
        pending.token,
        requester,
        sourceEventId,
        sourceEventId,
        deps,
      );
}

export async function resolveSoldout(
  decision: "approve" | "reject",
  token: string,
  actor: LineActor,
  applyEventId: string,
  correlationId: string,
  deps: SoldoutDeps,
): Promise<CommandReply> {
  const nowIso = deps.clock.now().toISOString();
  const pending = await deps.repo.claimPending(
    token,
    actor.groupId,
    "soldout",
    applyEventId,
    nowIso,
  );
  if (pending === null) {
    return { kind: "text", text: "คำยืนยันหมดอายุหรือถูกใช้แล้ว" };
  }
  if (pending.status === "approved" && pending.soldPrice !== null) {
    return saleReply(pending.productId, pending.soldPrice);
  }

  const resolver = actorText(actor.displayName, actor.userId);
  if (decision === "reject") {
    await deps.repo.resolvePending(token, applyEventId, "rejected", resolver);
    return { kind: "text", text: `ยกเลิกการขาย ${pending.productId}` };
  }
  if (pending.soldPrice === null) {
    await deps.repo.resolvePending(token, applyEventId, "rejected", resolver);
    return { kind: "text", text: "คำยืนยันราคาไม่ถูกต้อง" };
  }

  const recoveringMutation = pending.after.soldAt !== null
    && pending.after.soldBy !== null;
  let mutationIntentPersisted = recoveringMutation;
  try {
    const product = await deps.inventory.findByProductId(pending.productId);
    if (product === null) {
      await deps.repo.resolvePending(token, applyEventId, "rejected", resolver);
      return { kind: "text", text: notFoundText(pending.productId) };
    }

    const after: SaleValues = mutationIntentPersisted
      ? pending.after
      : {
          inventoryStatus: "Out",
          soldPrice: pending.soldPrice,
          soldAt: nowIso,
          soldBy: resolver,
        };
    if (!mutationIntentPersisted) {
      mutationIntentPersisted = true;
      await deps.repo.setPendingAfter(token, applyEventId, after);
    }

    if (matchesSaleValues(product, pending.before)) {
      await deps.inventory.updateSaleValues(product.recordId, after);
    } else if (!recoveringMutation || !matchesSaleValues(product, after)) {
      await deps.repo.resolvePending(token, applyEventId, "rejected", resolver);
      return {
        kind: "text",
        text: "ข้อมูลสินค้าเปลี่ยนแล้ว ไม่ได้เขียนทับ กรุณาตรวจ Airtable",
      };
    }

    await deps.repo.finalizeAction({
      pendingToken: token,
      applyEventId,
      targetActionId: null,
      groupId: actor.groupId,
      productId: pending.productId,
      kind: "soldout",
      before: pending.before,
      after,
      actor: resolver,
      correlationId,
    });
    return saleReply(pending.productId, pending.soldPrice);
  } catch (error) {
    if (!mutationIntentPersisted) {
      await deps.repo.resetPending(token, applyEventId);
    }
    throw error;
  }
}
