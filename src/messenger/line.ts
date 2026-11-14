import type { SupportedLineEvent } from "../line/types";
import type { CommandReply } from "../line/soldout";
import { messengerOverviewCard } from "./card";
import { bangkokDay, sanitizeMessengerEvent } from "./parser";
import {
  getOverview,
  handleMessengerAction,
  registerDelivery,
  sameConnection,
} from "./service";
import type { MessengerAction, MessengerDeps, MessengerResult } from "./types";

export function isMessengerEvent(event: SupportedLineEvent): boolean {
  return event.type === "message"
    ? !!event.messenger ||
        /^\/mess(?:-overview)?(?:\s|$)/.test(event.message.text.trim())
    : new URLSearchParams(event.postback.data).has("messenger");
}
export function parseMessengerAction(data: string): MessengerAction | null {
  const values = new URLSearchParams(data),
    keys = Array.from(values.keys());
  const kind = values.get("messenger"),
    token = values.get("token");
  if (
    keys.length !== 2 ||
    new Set(keys).size !== 2 ||
    !keys.every((k) => k === "messenger" || k === "token") ||
    (kind !== "quote" && kind !== "complete") ||
    !token ||
    !/^[-A-Za-z0-9]{1,100}$/.test(token)
  )
    return null;
  return { kind, token };
}
export async function messengerAccessAllowed(
  event: SupportedLineEvent,
  deps: MessengerDeps | undefined,
): Promise<boolean> {
  if (!deps) return false;
  const policy = await deps.currentPolicy();
  if (
    !policy.allowedGroupIds.includes(event.source.groupId) ||
    !sameConnection(deps.connection, policy.connection)
  )
    return false;
  if (
    event.type === "postback" &&
    parseMessengerAction(event.postback.data)?.kind === "complete"
  )
    return policy.completionUserIds.includes(event.source.userId);
  return true;
}
export async function prepareMessengerReply(
  event: SupportedLineEvent,
  deps: MessengerDeps | undefined,
): Promise<CommandReply> {
  if (!deps)
    return {
      kind: "text",
      text: "⚠️ กรุณาตั้งค่าตารางแมสเซนเจอร์ก่อนใช้คำสั่งนี้",
    };
  let result: MessengerResult;
  if (event.type === "postback") {
    const action = parseMessengerAction(event.postback.data);
    if (!action) return { kind: "text", text: "⚠️ ปุ่มแมสเซนเจอร์ไม่ถูกต้อง" };
    result = await handleMessengerAction(
      action,
      { groupId: event.source.groupId, userId: event.source.userId },
      deps,
    );
  } else {
    const safe = sanitizeMessengerEvent(event);
    if (safe.type !== "message") throw new Error("Invalid messenger event");
    const parsed = safe.messenger;
    if (!parsed?.ok)
      return {
        kind: "text",
        text: "⚠️ ใช้ /mess แมสเลย A-1234 หรือ /mess 14:30 A-1234 หรือ /mess พรุ่งนี้ 14:00 A-1234 และ /mess-overview สำหรับรายการวันนี้",
      };
    const c = parsed.command;
    result =
      c.type === "mess-overview"
        ? await getOverview(c.day, c.page, event.source.groupId, deps)
        : await registerDelivery(
            c,
            {
              eventId: event.webhookEventId,
              messageId: event.message.id,
              timestamp: event.timestamp!,
              quoteToken: event.message.quoteToken ?? null,
              groupId: event.source.groupId,
              userId: event.source.userId,
            },
            deps,
          );
  }
  if (result.kind === "quote")
    return {
      kind: "quoted-text",
      text: result.text,
      quoteToken: result.quoteToken,
    };
  if (result.kind === "overview")
    return {
      kind: "flex",
      ...messengerOverviewCard(
        result.overview,
        bangkokDay(deps.clock.now().getTime()),
      ),
    };
  return result;
}
