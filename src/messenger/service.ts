import { bangkokDay, validDay } from "./parser";
import type {
  ActionBinding,
  Delivery,
  DeliveryConnection,
  CompletionIntent,
  MessengerAction,
  MessengerCommand,
  MessengerDeps,
  MessengerResult,
  RegistrationIntent,
} from "./types";
const message = (text: string): MessengerResult => ({ kind: "text", text });
const unavailable = () =>
  message(
    "⚠️ ไม่สามารถดำเนินการได้ กรุณาตรวจสอบสิทธิ์ กลุ่ม และการตั้งค่าแมสเซนเจอร์",
  );
const uncertain = () =>
  message("⚠️ ยังยืนยันผลการบันทึกไม่ได้ กรุณาตรวจสอบก่อนส่งคำสั่งซ้ำ");
const stale = () =>
  message("⚠️ ข้อมูลรายการเปลี่ยนแล้ว กรุณาใช้ /mess-overview อีกครั้ง");
const confirmsCompletion = (d: Delivery, intent: CompletionIntent) =>
  d.status === "Done" &&
  d.completedAt !== null &&
  Date.parse(d.completedAt) === Date.parse(intent.completion.at) &&
  d.completedByUserId === intent.completion.userId &&
  d.completedByName === intent.completion.name;
export const sameConnection = (
  a: DeliveryConnection,
  b: DeliveryConnection | null,
) =>
  !!b &&
  a.baseId === b.baseId &&
  a.productsTableId === b.productsTableId &&
  a.deliveriesTableId === b.deliveriesTableId;
async function policyFor(groupId: string, deps: MessengerDeps) {
  const policy = await deps.currentPolicy();
  return policy.allowedGroupIds.includes(groupId) &&
    sameConnection(deps.connection, policy.connection)
    ? policy
    : null;
}
function sameTask(d: Delivery, b: ActionBinding) {
  return (
    d.id === b.deliveryId &&
    d.recordId === b.recordId &&
    d.sourceGroupId === b.groupId &&
    bangkokDay(Date.parse(d.scheduledAt)) === b.day
  );
}

export async function getOverview(
  day: string,
  page: number,
  groupId: string,
  deps: MessengerDeps,
): Promise<MessengerResult> {
  const policy = await policyFor(groupId, deps);
  if (!policy) return unavailable();
  if (!validDay(day) || !Number.isSafeInteger(page) || page < 1)
    return message("⚠️ วันที่หรือหน้ารายการไม่ถูกต้อง");
  const all = await deps.airtable.list(groupId, day);
  if (
    all.some(
      (d) =>
        d.sourceGroupId !== groupId ||
        bangkokDay(Date.parse(d.scheduledAt)) !== day,
    )
  )
    throw new Error("Messenger overview scope mismatch");
  all.sort(
    (a, b) =>
      Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt) ||
      Number(a.productId.slice(2)) - Number(b.productId.slice(2)) ||
      a.id.localeCompare(b.id),
  );
  if (page > Math.max(1, Math.ceil(all.length / 5)))
    return message("⚠️ ไม่พบหน้ารายการนี้ กรุณาขอรายการหน้าแรกอีกครั้ง");
  const items = all.slice((page - 1) * 5, page * 5);
  const actions: Record<string, { quote: string; complete: string | null }> =
    {};
  for (const d of items) {
    const quote = deps.ids.next(),
      complete = d.status === "Pending" ? deps.ids.next() : null;
    const binding = {
      deliveryId: d.id,
      recordId: d.recordId,
      groupId,
      day,
      page,
      connection: deps.connection,
    };
    await deps.repo.putAction({ ...binding, token: quote, kind: "quote" });
    if (complete) {
      const prior = await deps.repo.findCompletion(deps.connection, d.recordId);
      await deps.repo.putAction({
        completionCycle:
          prior?.phase === "observed"
            ? prior.id
            : (prior?.previousObservedIntentId ?? null),
        ...binding,
        token: complete,
        kind: "complete",
      });
    }
    actions[d.id] = { quote, complete };
  }
  return {
    kind: "overview",
    overview: {
      day,
      page,
      total: all.length,
      done: all.filter((d) => d.status === "Done").length,
      items,
      actions,
    },
  };
}

export async function registerDelivery(
  command: Extract<MessengerCommand, { type: "mess-register" }>,
  source: {
    eventId: string;
    messageId: string;
    timestamp: number;
    quoteToken: string | null;
    groupId: string;
    userId: string;
  },
  deps: MessengerDeps,
): Promise<MessengerResult> {
  if (!(await policyFor(source.groupId, deps))) return unavailable();
  const day = bangkokDay(Date.parse(command.scheduledAt));
  const prior = await deps.repo.findRegistration(
    deps.connection,
    source.groupId,
    day,
    command.productId,
    source.eventId,
  );
  if (prior) {
    if (
      prior.delivery.sourceGroupId !== source.groupId ||
      prior.delivery.productId !== command.productId ||
      prior.day !== day
    )
      return unavailable();
    return reconcileRegistration(prior, source, deps);
  }
  const existing = await deps.airtable.findDuplicate(
    source.groupId,
    day,
    command.productId,
  );
  if (
    existing &&
    (existing.sourceGroupId !== source.groupId ||
      existing.productId !== command.productId ||
      bangkokDay(Date.parse(existing.scheduledAt)) !== day)
  )
    throw new Error("Messenger duplicate scope mismatch");
  if (existing)
    return message(
      `มีรายการจัดส่ง ${existing.productId} สำหรับวันที่ ${day.split("-").reverse().join("/")} แล้ว${existing.status === "Done" ? " · ✓ เสร็จสิ้น" : ""}`,
    );
  const product = await deps.airtable.findProduct(command.productId);
  if (!product) return message(`⚠️ ไม่พบสินค้า ${command.productId}`);
  const profile = await deps.profile(source.groupId, source.userId);
  if (!profile.displayName.trim())
    throw new Error("Messenger profile unavailable");
  const { intent } = await deps.repo.claimRegistration({
    connection: deps.connection,
    day,
    delivery: {
      id: deps.ids.next(),
      productRecordId: product.recordId,
      productId: command.productId,
      scheduledAt: command.scheduledAt,
      scheduleType: command.scheduleType,
      registeredAt: new Date(source.timestamp).toISOString(),
      responsibleUserId: source.userId,
      responsibleName: profile.displayName,
      sourceGroupId: source.groupId,
      sourceMessageId: source.messageId,
      sourceEventId: source.eventId,
      quoteToken: source.quoteToken,
    },
  });
  return reconcileRegistration(intent, source, deps);
}

async function recordConfirmedObservation(
  intentId: string,
  recordId: string,
  deps: MessengerDeps,
): Promise<void> {
  try {
    await deps.repo.recordObserved(intentId, recordId);
  } catch {
    console.warn("messenger_observation_failed", { intentId });
  }
}
async function reconcileRegistration(
  intent: RegistrationIntent,
  source: { groupId: string; eventId: string },
  deps: MessengerDeps,
): Promise<MessengerResult> {
  const expected = intent.delivery;
  const matches = (d: Delivery) =>
    d.id === expected.id &&
    d.sourceEventId === expected.sourceEventId &&
    d.sourceGroupId === expected.sourceGroupId &&
    d.productId === expected.productId &&
    d.productRecordId === expected.productRecordId &&
    d.scheduledAt === expected.scheduledAt;
  let observed: Delivery | null;
  try {
    observed = await deps.airtable.findBySourceEvent(expected.sourceEventId);
  } catch (error) {
    if (intent.phase !== "prepared") return uncertain();
    throw error;
  }
  if (!observed && !(await policyFor(source.groupId, deps)))
    return unavailable();
  if (!observed && (await deps.repo.beginDispatch(intent.id))) {
    try {
      observed = await deps.airtable.create(expected);
    } catch {
      try {
        observed = await deps.airtable.findBySourceEvent(
          expected.sourceEventId,
        );
      } catch {
        return uncertain();
      }
    }
  }
  if (!observed || !matches(observed)) return uncertain();
  await recordConfirmedObservation(intent.id, observed.recordId, deps);
  if (source.eventId !== expected.sourceEventId)
    return message(
      `มีรายการจัดส่ง ${observed.productId} สำหรับวันที่ ${intent.day.split("-").reverse().join("/")} แล้ว${observed.status === "Done" ? " · ✓ เสร็จสิ้น" : ""}`,
    );
  return message(`บันทึกรายการแมสเซนเจอร์ ${observed.productId} แล้ว`);
}

export async function handleMessengerAction(
  action: MessengerAction,
  actor: { groupId: string; userId: string },
  deps: MessengerDeps,
): Promise<MessengerResult> {
  const policy = await policyFor(actor.groupId, deps);
  if (!policy) return unavailable();
  const binding = await deps.repo.getAction(action.token);
  if (
    !binding ||
    binding.kind !== action.kind ||
    binding.groupId !== actor.groupId ||
    !sameConnection(binding.connection, policy.connection)
  )
    return unavailable();
  if (
    action.kind === "complete" &&
    !policy.completionUserIds.includes(actor.userId)
  )
    return message("⚠️ คุณไม่มีสิทธิ์ทำเครื่องหมายรายการนี้ว่าเสร็จสิ้น");
  const prior =
    action.kind === "complete"
      ? await deps.repo.findCompletion(deps.connection, binding.recordId)
      : null;
  let d: Delivery | null;
  try {
    d = await deps.airtable.get(binding.recordId);
  } catch (error) {
    if (prior && prior.phase !== "prepared") return uncertain();
    throw error;
  }
  if (!d || !sameTask(d, binding)) return unavailable();
  if (action.kind === "quote")
    return d.quoteToken
      ? {
          kind: "quote",
          quoteToken: d.quoteToken,
          text: `รายการจัดส่ง ${d.productId}`,
        }
      : message(`⚠️ ไม่สามารถอ้างอิงข้อความเดิมของ ${d.productId} ได้`);
  const refreshed = async () => {
    try {
      const today = bangkokDay(deps.clock.now().getTime());
      return await getOverview(
        today,
        binding.day === today ? binding.page : 1,
        actor.groupId,
        deps,
      );
    } catch {
      return message(
        "บันทึกสถานะเสร็จสิ้น แต่โหลดรายการล่าสุดไม่สำเร็จ กรุณาใช้ /mess-overview อีกครั้ง",
      );
    }
  };
  if (d.status === "Done") {
    if (prior && confirmsCompletion(d, prior))
      await recordConfirmedObservation(prior.id, d.recordId, deps);
    return refreshed();
  }
  const cycle =
    prior?.phase === "observed"
      ? prior.id
      : (prior?.previousObservedIntentId ?? null);
  if ((binding.completionCycle ?? null) !== cycle) return stale();
  if (prior?.phase === "dispatched") return uncertain();
  const profile = await deps.profile(actor.groupId, actor.userId);
  if (!profile.displayName.trim())
    throw new Error("Messenger profile unavailable");
  const { intent } = await deps.repo.claimCompletion({
    previousObservedIntentId: cycle,
    deliveryId: d.id,
    recordId: d.recordId,
    groupId: actor.groupId,
    connection: deps.connection,
    completion: {
      at: deps.clock.now().toISOString(),
      userId: actor.userId,
      name: profile.displayName,
    },
  });
  if ((intent.previousObservedIntentId ?? null) !== cycle) return stale();
  if (intent.phase === "observed") return stale();
  // Re-read before the sole dispatch; another accepted action or Airtable edit may have completed it.
  let observed: Delivery | null;
  try {
    observed = await deps.airtable.get(intent.recordId);
  } catch (error) {
    if (intent.phase !== "prepared") return uncertain();
    throw error;
  }
  if (!observed || !sameTask(observed, binding)) return unavailable();
  // A denied operation must not consume the sole provider dispatch.
  const latest = await policyFor(actor.groupId, deps);
  if (!latest?.completionUserIds.includes(actor.userId)) return unavailable();
  if (
    observed.status !== "Done" &&
    (await deps.repo.beginDispatch(intent.id))
  ) {
    try {
      observed = await deps.airtable.complete(
        intent.recordId,
        intent.completion,
      );
    } catch {
      try {
        observed = await deps.airtable.get(intent.recordId);
      } catch {
        return uncertain();
      }
    }
  }
  if (!observed || !sameTask(observed, binding) || observed.status !== "Done")
    return uncertain();
  if (confirmsCompletion(observed, intent))
    await recordConfirmedObservation(intent.id, observed.recordId, deps);
  return refreshed();
}
