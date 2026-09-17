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
  allowedGroupId: string;
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
  const action = values.get("action");
  const decision = values.get("decision");
  const token = values.get("token");
  if (
    (action !== "soldout" && action !== "revert")
    || (decision !== "approve" && decision !== "reject")
    || token === null
    || token.length === 0
  ) {
    return null;
  }
  return { action, decision, token };
}

async function actorFor(event: SupportedLineEvent, line: LineClient): Promise<LineActor> {
  const profile = await line.getGroupMemberProfile(event.source.groupId, event.source.userId);
  return {
    userId: profile.userId,
    displayName: profile.displayName,
    groupId: event.source.groupId,
  };
}

async function send(replyToken: string, reply: CommandReply, line: LineClient): Promise<void> {
  if (reply.kind === "text") {
    await line.replyText(replyToken, reply.text);
    return;
  }
  await line.replyButtons(replyToken, reply.text, reply.text, [
    { label: "ยืนยัน", data: reply.approveData, style: "primary" },
    { label: "ยกเลิก", data: reply.rejectData, style: "secondary" },
  ]);
}

export async function processLineEvents(
  events: SupportedLineEvent[],
  deps: WebhookDeps,
): Promise<void> {
  for (const event of events) {
    const claimed = await deps.repo.claimEvent(event.webhookEventId, event.source.groupId);
    if (!claimed) continue;

    const correlationId = deps.ids.next();
    try {
      if (event.source.groupId !== deps.allowedGroupId) {
        await deps.audit.record({
          correlationId,
          actor: `line:${event.source.userId}`,
          action: "line_disallowed_group",
          beforeValue: null,
          afterValue: null,
        });
        continue;
      }

      const actor = await actorFor(event, deps.line);
      if (event.type === "postback") {
        const postback = parsePostback(event.postback.data);
        if (postback === null) {
          await deps.line.replyText(event.replyToken, "คำยืนยันไม่ถูกต้อง");
          continue;
        }
        const reply = postback.action === "soldout"
          ? await resolveSoldout(
            postback.decision,
            postback.token,
            actor,
            event.webhookEventId,
            correlationId,
            deps,
          )
          : await resolveRevert(
            postback.decision,
            postback.token,
            actor,
            event.webhookEventId,
            correlationId,
            deps,
          );
        await send(event.replyToken, reply, deps.line);
        continue;
      }

      const parsed = parseLineCommand(event.message.text);
      if (!parsed.ok) {
        await deps.line.replyText(event.replyToken, parseErrorText(parsed.code));
        continue;
      }
      if (parsed.command.type === "soldout") {
        await send(
          event.replyToken,
          await prepareSoldout(
            parsed.command,
            actor,
            event.webhookEventId,
            deps.confirmationEnabled,
            deps,
          ),
          deps.line,
        );
        continue;
      }
      if (parsed.command.type === "revert") {
        await send(
          event.replyToken,
          await prepareRevert(actor, event.webhookEventId, deps),
          deps.line,
        );
        continue;
      }
      await deps.line.replyText(
        event.replyToken,
        await handleReadOnlyCommand(parsed.command, deps),
      );
    } catch (error) {
      await deps.repo.releaseEvent(event.webhookEventId);
      throw error;
    }
  }
}
