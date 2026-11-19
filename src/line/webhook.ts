import { renderCommandReply } from "./reply-renderer";
import { isMessengerEvent, prepareMessengerReply, messengerAccessAllowed } from "../messenger/line";
import type { MessengerDeps } from "../messenger/types";
import type { AuditLog } from "../db/audit";
import type { LineRepository } from "../db/line-repository";
import type { IdGenerator } from "../shared/ids";
import type { Clock } from "../shared/time";
import type { InventoryClient } from "./airtable-inventory";
import type { LineClient } from "./client";
import { parseErrorText } from "./messages";
import { parseLineCommand } from "./parser";
import { prepareRevert, resolveRevert } from "./revert";
import { handleReadOnlyCommand, type ReadOnlyDeps } from "./search";
import {
  prepareSoldout,
  resolveSoldout,
  type CommandReply,
  type SoldoutDeps,
} from "./soldout";
import type { LineActor, SupportedLineEvent } from "./types";

export interface WebhookDeps extends ReadOnlyDeps, SoldoutDeps {
  messenger?: MessengerDeps;
  allowedGroupId?: string;
  allowedGroupIds?: string[];
  confirmationEnabled: boolean;
  line: LineClient;
  repo: LineRepository;
  audit: AuditLog;
  inventory: InventoryClient;
  clock: Clock;
  ids: IdGenerator;
}

function parsePostback(data: string): {
  action: "soldout" | "revert";
  decision: "approve" | "reject";
  token: string;
} | null {
  const values = new URLSearchParams(data);
  const keys = Array.from(values.keys());
  if (
    keys.length !== 3 ||
    new Set(keys).size !== 3 ||
    !keys.every(
      (key) => key === "action" || key === "decision" || key === "token",
    )
  ) {
    return null;
  }
  const action = values.get("action");
  const decision = values.get("decision");
  const token = values.get("token");
  if (
    (action !== "soldout" && action !== "revert") ||
    (decision !== "approve" && decision !== "reject") ||
    token === null ||
    token.length === 0
  ) {
    return null;
  }
  return { action, decision, token };
}

async function actorFor(
  event: SupportedLineEvent,
  line: LineClient,
): Promise<LineActor> {
  const profile = await line.getGroupMemberProfile(
    event.source.groupId,
    event.source.userId,
  );
  return {
    userId: event.source.userId,
    displayName: profile.displayName,
    groupId: event.source.groupId,
  };
}

export async function sendCommandReply(replyToken: string, reply: CommandReply, line: LineClient, publicBaseUrl: string): Promise<void> {
  const messages = renderCommandReply(reply, publicBaseUrl);
  await line.sendReplyMessages(replyToken, messages);
}

export async function prepareLineReply(
  event: SupportedLineEvent,
  deps: WebhookDeps,
  correlationId = event.webhookEventId,
): Promise<CommandReply | null> {
  if (isMessengerEvent(event)) return prepareMessengerReply(event, deps.messenger);
  if (event.type === "message") {
    const parsed = parseLineCommand(event.message.text);
    if (!parsed.ok)
      return parsed.code === "unknown_command"
        ? null
        : { kind: "text", text: parseErrorText(parsed.code) };
    const actor = await actorFor(event, deps.line);
    if (parsed.command.type !== "soldout" && parsed.command.type !== "revert") {
      const reply = await handleReadOnlyCommand(parsed.command, deps);
      return typeof reply === "string" ? { kind: "text", text: reply } : reply;
    }
    return parsed.command.type === "soldout"
      ? prepareSoldout(
          parsed.command,
          actor,
          event.webhookEventId,
          deps.confirmationEnabled,
          deps,
        )
      : prepareRevert(actor, event.webhookEventId, deps);
  }
  const postback = parsePostback(event.postback.data);
  if (postback === null) return { kind: "text", text: "คำยืนยันไม่ถูกต้อง" };
  const actor = await actorFor(event, deps.line);
  return postback.action === "soldout"
    ? resolveSoldout(
        postback.decision,
        postback.token,
        actor,
        event.webhookEventId,
        correlationId,
        deps,
      )
    : resolveRevert(
        postback.decision,
        postback.token,
        actor,
        event.webhookEventId,
        correlationId,
        deps,
      );
}

export async function processLineEvents(
  events: SupportedLineEvent[],
  deps: WebhookDeps,
): Promise<void> {
  const failures: unknown[] = [];
  for (const event of events) {
    let claimed = false;
    let dispatchStarted = false;
    try {
      claimed = await deps.repo.claimEvent(
        event.webhookEventId,
        event.source.groupId,
      );
      if (!claimed) continue;
      const correlationId = deps.ids.next();
      if (
        !(deps.allowedGroupIds ?? [deps.allowedGroupId]).includes(
          event.source.groupId,
        )
      ) {
        await deps.audit.record({
          correlationId,
          actor: `line:${event.source.userId}`,
          action: "line_disallowed_group",
          beforeValue: null,
          afterValue: null,
        });
        continue;
      }

      const savedReply = isMessengerEvent(event) ? null : await deps.repo.findEventReply(event.webhookEventId);
      if (savedReply !== null) {
        dispatchStarted = true;
        await sendCommandReply(
          event.replyToken,
          savedReply,
          deps.line,
          deps.publicBaseUrl,
        );
        continue;
      }
      const deliver = async (reply: CommandReply) => {
        if (isMessengerEvent(event) && deps.messenger && !(await messengerAccessAllowed(event, deps.messenger))) {
          dispatchStarted = true;
          await deps.line.replyText(event.replyToken, "⚠️ สิทธิ์หรือการตั้งค่าเปลี่ยนแล้ว กรุณาขอรายการใหม่");
          return;
        }
        await deps.repo.saveEventReply(event.webhookEventId, reply);
        dispatchStarted = true;
        await sendCommandReply(
          event.replyToken,
          reply,
          deps.line,
          deps.publicBaseUrl,
        );
      };
      const reply = await prepareLineReply(event, deps, correlationId);
      if (reply !== null) await deliver(reply);
    } catch (error) {
      failures.push(error);
      if (claimed && !dispatchStarted) {
        try {
          await deps.repo.releaseEvent(event.webhookEventId);
        } catch (releaseError) {
          failures.push(releaseError);
        }
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "LINE webhook batch failed");
}
