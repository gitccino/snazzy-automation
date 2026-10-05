import type { AuditLog } from "../db/audit";
import type { LineRepository } from "../db/line-repository";
import type { IdGenerator } from "../shared/ids";
import type { Clock } from "../shared/time";
import type { InventoryClient } from "./airtable-inventory";
import type { LineClient } from "./client";
import { saleSuccessCard } from "./search-card";
import { confirmationCard, revertSuccessCard } from "./confirmation-card";
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
  const keys = Array.from(values.keys());
  if (
    keys.length !== 3
    || new Set(keys).size !== 3
    || !keys.every((key) => key === "action" || key === "decision" || key === "token")
  ) {
    return null;
  }
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
    userId: event.source.userId,
    displayName: profile.displayName,
    groupId: event.source.groupId,
  };
}

async function send(replyToken: string, reply: CommandReply, line: LineClient, publicBaseUrl: string): Promise<void> {
  if (reply.kind === "flex") {
    await line.replyFlex(replyToken, reply.text, reply.contents);
    return;
  }
  if (reply.kind === "text") {
    if (reply.revertSuccess) {
      await line.replyFlex(replyToken, reply.text, revertSuccessCard(publicBaseUrl));
      return;
    }
    if (reply.saleSuccess) {
      const { productId, soldPrice, product } = reply.saleSuccess;
      const card = saleSuccessCard(productId, soldPrice, publicBaseUrl, product);
      await line.replyFlex(replyToken, card.text, card.contents);
      return;
    }
    await line.replyText(replyToken, reply.text);
    return;
  }
  // Flex text components allow 2,000 characters. Keep the existing lossless
  // multi-message path for unusually large legacy confirmation details.
  if (reply.text.length <= 2000) {
    await line.replyFlex(replyToken, reply.text, confirmationCard(reply, publicBaseUrl));
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
  const failures: unknown[] = [];
  for (const event of events) {
    let claimed = false;
    try {
      claimed = await deps.repo.claimEvent(event.webhookEventId, event.source.groupId);
      if (!claimed) continue;
      const correlationId = deps.ids.next();
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

      const savedReply = await deps.repo.findEventReply(event.webhookEventId);
      if (savedReply !== null) {
        await send(event.replyToken, savedReply, deps.line, deps.publicBaseUrl);
        continue;
      }
      const deliver = async (reply: CommandReply) => {
        await deps.repo.saveEventReply(event.webhookEventId, reply);
        await send(event.replyToken, reply, deps.line, deps.publicBaseUrl);
      };
      const actor = await actorFor(event, deps.line);
      if (event.type === "postback") {
        const postback = parsePostback(event.postback.data);
        if (postback === null) {
          await deliver({ kind: "text", text: "คำยืนยันไม่ถูกต้อง" });
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
        await deliver(reply);
        continue;
      }

      const parsed = parseLineCommand(event.message.text);
      if (!parsed.ok) {
        await deliver({ kind: "text", text: parseErrorText(parsed.code) });
        continue;
      }
      if (parsed.command.type === "soldout") {
        await deliver(
          await prepareSoldout(
            parsed.command,
            actor,
            event.webhookEventId,
            deps.confirmationEnabled,
            deps,
          ),
        );
        continue;
      }
      if (parsed.command.type === "revert") {
        await deliver(
          await prepareRevert(actor, event.webhookEventId, deps),
        );
        continue;
      }
      const reply = await handleReadOnlyCommand(parsed.command, deps);
      await deliver(typeof reply === "string" ? { kind: "text", text: reply } : reply);
    } catch (error) {
      failures.push(error);
      if (claimed) {
        try {
          await deps.repo.releaseEvent(event.webhookEventId);
        } catch (releaseError) {
          failures.push(releaseError);
        }
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "LINE webhook batch failed");
}
