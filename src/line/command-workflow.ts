import { createLineReplyRepository } from '../db/line-reply-repository';
import { deliverEventReply } from './reply-delivery';
import { loadSettingsSnapshot } from '../settings/runtime';
import { isMessengerEvent, messengerAccessAllowed } from "../messenger/line";
import { captureOperationContext } from "../settings/runtime";
import { readPendingContext } from "../db/execution-context-repository";
import type { OperationContext } from "../settings/schema";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { Env } from "../env";
import { createWebhookDeps, fetchForLineCommand } from "../routes/line";
import { isRetryable } from "../shared/errors";
import { createLineClient } from "./client";
import type { CommandReply } from "./soldout";
import type { LineIngressEvent } from "./types";
import { prepareLineReply } from "./webhook";

const attemptOptions = {
  retries: { limit: 0, delay: "1 second" },
  timeout: "1 minute",
} as const;
const waits = ["30 seconds", "1 minute"] as const;

interface RecoveryOperations {
  prepare(): Promise<CommandReply | null>;
  deliver(reply: CommandReply, retryKey: string): Promise<void>;
  notify(text: string, retryKey: string): Promise<void>;
}

export async function runLineCommandRecovery(
  step: Pick<WorkflowStep, "do" | "sleep">,
  operations: RecoveryOperations,
) {
  const keys = await step.do("notification-keys", async () => ({
    result: crypto.randomUUID(),
    status: [crypto.randomUUID(), crypto.randomUUID()],
    final: crypto.randomUUID(),
  }));
  let reply: CommandReply | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (reply === null) {
      const prepared = await step
        .do(`prepare-${attempt}`, attemptOptions, async () => {
          try {
            return { ok: true as const, reply: await operations.prepare() };
          } catch (error) {
            console.error("LINE command preparation failed", error);
            return { ok: false as const, retryable: isRetryable(error) };
          }
        })
        .catch((error) => {
          // Errors escaping the callback are Workflow interruptions, not command validation failures.
          console.error("LINE preparation step interrupted", error);
          return { ok: false as const, retryable: true };
        });
      if (prepared.ok) {
        if (prepared.reply === null) return { status: "ignored" as const };
        reply = prepared.reply;
      } else if (!prepared.retryable) break;
    }
    if (reply !== null) {
      const delivered = await step
        .do(`deliver-${attempt}`, attemptOptions, async () => {
          try {
            await operations.deliver(reply!, keys.result);
            return { ok: true, retryable: false };
          } catch (error) {
            console.error("LINE command delivery failed", error);
            return { ok: false, retryable: isRetryable(error) };
          }
        })
        .catch((error) => {
          console.error("LINE delivery step interrupted", error);
          return { ok: false, retryable: true };
        });
      if (delivered.ok) return { status: "completed" as const };
      if (!delivered.retryable) break;
    }
    if (attempt === 2) break;
    const duration = attempt === 0 ? "30 วินาที" : "1 นาที";
    await step
      .do(`retry-notice-${attempt}`, attemptOptions, async () => {
        try {
          await operations.notify(
            `⚠️ ระบบขัดข้องชั่วคราว กำลังลองใหม่อัตโนมัติใน ${duration} ไม่ต้องส่งคำสั่งซ้ำ`,
            keys.status[attempt]!,
          );
        } catch (error) {
          // A LINE outage must not prevent recovery of the command itself.
          console.error("LINE retry notice failed", error);
        }
      })
      .catch((error) => {
        console.error("LINE retry notice step interrupted", error);
      });
    await step.sleep(`retry-wait-${attempt}`, waits[attempt]!);
  }
  await step.do("failure-notice", attemptOptions, () =>
    operations.notify(
      reply === null
        ? "⚠️ ประมวลผลคำสั่งไม่สำเร็จ ระบบหยุดลองใหม่แล้ว กรุณาตรวจสอบข้อมูลก่อนส่งคำสั่งซ้ำ"
        : "⚠️ ประมวลผลคำสั่งแล้ว แต่ส่งผลลัพธ์ไม่สำเร็จ ระบบหยุดลองใหม่แล้ว กรุณาตรวจสอบข้อมูลก่อนส่งคำสั่งซ้ำ",
      keys.final,
    ),
  );
  return { status: "failed" as const };
}

export class LineCommandWorkflow extends WorkflowEntrypoint<Env,{event:LineIngressEvent;context?:OperationContext;receivedAt?:string}> {
  async run(input:WorkflowEvent<{event:LineIngressEvent;context?:OperationContext;receivedAt?:string}>,step:WorkflowStep) {
    const {event,receivedAt}=input.payload;
    // Legacy persisted events may already have pushed; never adopt them into reply delivery.
    if(!receivedAt)return {status:'ignored' as const};
    const context=await step.do('settings-context',attemptOptions,async()=>{
      if(event.type==='postback' && !isMessengerEvent(event)) {
        const token=new URLSearchParams(event.postback.data).get('token');
        if(token) {
          const saved=await readPendingContext(this.env.DB,token);
          if(saved) { if(saved.replyGroupId!==event.source.groupId)throw new Error('confirmation_group_mismatch'); return saved; }
          if(this.env.CONFIGURATION_MODE==='d1')throw new Error('legacy_context_requires_operator_resolution');
        }
      }
      if(!input.payload.context && this.env.CONFIGURATION_MODE==='d1')throw new Error('legacy_context_requires_operator_resolution');
      return input.payload.context ?? await captureOperationContext(this.env,event.source.groupId);
    });
    const allowed=async(groupId:string)=>(await loadSettingsSnapshot(this.env)).config.lineAllowedGroupIds.includes(groupId);
    if(!await allowed(event.source.groupId))return {status:'ignored' as const};
    const completed=await step.do('already-processed',()=>this.env.DB.prepare('SELECT event_id FROM line_events WHERE event_id=? UNION ALL SELECT event_id FROM line_event_replies WHERE event_id=? LIMIT 1').bind(event.webhookEventId,event.webhookEventId).first<{event_id:string}>());
    if(completed)return {status:'duplicate' as const};
    const deps=await createWebhookDeps(this.env,input.instanceId,context);
    deps.retryTransientErrors=true;
    let reply=await step.do('prepare-reply',attemptOptions,async():Promise<CommandReply|null>=>{
      if(event.type==='queue-trigger')return null;
      try { return await prepareLineReply(event,deps); }
      catch { return {kind:'text',text:'⚠️ ประมวลผลคำสั่งไม่สำเร็จ กรุณาตรวจสอบข้อมูลก่อนส่งคำสั่งซ้ำ'}; }
    });
    if(event.type!=='queue-trigger' && isMessengerEvent(event) && deps.messenger && !await messengerAccessAllowed(event,deps.messenger))
      reply={kind:'text',text:'⚠️ สิทธิ์หรือการตั้งค่าเปลี่ยนแล้ว กรุณาขอรายการใหม่'};
    await step.do('record-command-completion',attemptOptions,async()=>{
      if(reply)await deps.repo.saveEventReply(event.webhookEventId,reply);
      await deps.repo.claimEvent(event.webhookEventId,event.source.groupId);
    });
    const status=await step.do('reply-once',attemptOptions,()=>deliverEventReply({eventId:event.webhookEventId,groupId:event.source.groupId,workflowId:input.instanceId,receivedAt,replyToken:event.replyToken,commandReply:reply,drainQueue:event.type!=='postback',publicBaseUrl:deps.publicBaseUrl},{repo:createLineReplyRepository(this.env.DB,deps.clock),line:deps.line,clock:deps.clock,isGroupAllowed:allowed}));
    return {status};
  }
}
