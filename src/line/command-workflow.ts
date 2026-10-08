import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env";
import { createWebhookDeps, fetchForLineCommand } from "../routes/line";
import { isRetryable } from "../shared/errors";
import { createLineClient } from "./client";
import type { CommandReply } from "./soldout";
import type { SupportedLineEvent } from "./types";
import { prepareLineReply, sendCommandReply } from "./webhook";

const attemptOptions = { retries: { limit: 0, delay: "1 second" }, timeout: "1 minute" } as const;
const waits = ["30 seconds", "1 minute"] as const;

interface RecoveryOperations {
  prepare(): Promise<CommandReply>;
  deliver(reply: CommandReply, retryKey: string): Promise<void>;
  notify(text: string, retryKey: string): Promise<void>;
}

export async function runLineCommandRecovery(step: Pick<WorkflowStep, "do" | "sleep">, operations: RecoveryOperations) {
  const keys = await step.do("notification-keys", async () => ({
    result: crypto.randomUUID(), status: [crypto.randomUUID(), crypto.randomUUID()], final: crypto.randomUUID(),
  }));
  let reply: CommandReply | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (reply === null) {
      const prepared = await step.do(`prepare-${attempt}`, attemptOptions, async () => {
        try { return { ok: true as const, reply: await operations.prepare() }; }
        catch (error) {
          console.error("LINE command preparation failed", error);
          return { ok: false as const, retryable: isRetryable(error) };
        }
      }).catch(error => {
        // Errors escaping the callback are Workflow interruptions, not command validation failures.
        console.error("LINE preparation step interrupted", error);
        return { ok: false as const, retryable: true };
      });
      if (prepared.ok) reply = prepared.reply;
      else if (!prepared.retryable) break;
    }
    if (reply !== null) {
      const delivered = await step.do(`deliver-${attempt}`, attemptOptions, async () => {
        try {
          await operations.deliver(reply!, keys.result);
          return { ok: true, retryable: false };
        } catch (error) {
          console.error("LINE command delivery failed", error);
          return { ok: false, retryable: isRetryable(error) };
        }
      }).catch(error => {
        console.error("LINE delivery step interrupted", error);
        return { ok: false, retryable: true };
      });
      if (delivered.ok) return { status: "completed" as const };
      if (!delivered.retryable) break;
    }
    if (attempt === 2) break;
    const duration = attempt === 0 ? "30 วินาที" : "1 นาที";
    await step.do(`retry-notice-${attempt}`, attemptOptions, async () => {
      try {
        await operations.notify(`⚠️ ระบบขัดข้องชั่วคราว กำลังลองใหม่อัตโนมัติใน ${duration} ไม่ต้องส่งคำสั่งซ้ำ`, keys.status[attempt]!);
      } catch (error) {
        // A LINE outage must not prevent recovery of the command itself.
        console.error("LINE retry notice failed", error);
      }
    }).catch(error => { console.error("LINE retry notice step interrupted", error); });
    await step.sleep(`retry-wait-${attempt}`, waits[attempt]!);
  }
  await step.do("failure-notice", attemptOptions, () => operations.notify(
    reply === null
      ? "⚠️ ประมวลผลคำสั่งไม่สำเร็จ ระบบหยุดลองใหม่แล้ว กรุณาตรวจสอบข้อมูลก่อนส่งคำสั่งซ้ำ"
      : "⚠️ ประมวลผลคำสั่งแล้ว แต่ส่งผลลัพธ์ไม่สำเร็จ ระบบหยุดลองใหม่แล้ว กรุณาตรวจสอบข้อมูลก่อนส่งคำสั่งซ้ำ",
    keys.final,
  ));
  return { status: "failed" as const };
}

export class LineCommandWorkflow extends WorkflowEntrypoint<Env, { event: SupportedLineEvent }> {
  async run(input: WorkflowEvent<{ event: SupportedLineEvent }>, step: WorkflowStep) {
    const event = input.payload.event;
    const deps = createWebhookDeps(this.env, input.instanceId);
    deps.retryTransientErrors = true;
    if (event.source.groupId !== deps.allowedGroupId) return { status: "ignored" };
    const completed = await step.do("already-processed", () => this.env.DB.prepare(
      "SELECT event_id FROM line_events WHERE event_id = ?",
    ).bind(event.webhookEventId).first<{ event_id: string }>());
    if (completed) return { status: "duplicate" };
    const client = (retryKey: string) => createLineClient({
      channelAccessToken: this.env.LINE_CHANNEL_ACCESS_TOKEN,
      fetch: fetchForLineCommand,
      pushReplies: { groupId: event.source.groupId, retryKey },
    });
    const outcome = await runLineCommandRecovery(step, {
      async prepare() {
        return await deps.repo.findEventReply(event.webhookEventId) ?? await prepareLineReply(event, deps);
      },
      async deliver(reply, retryKey) {
        await deps.repo.saveEventReply(event.webhookEventId, reply);
        await sendCommandReply(event.replyToken, reply, client(retryKey), deps.publicBaseUrl);
      },
      notify: (text, retryKey) => client(retryKey).pushMessage(event.source.groupId, text),
    });
    await step.do("record-completion", () => deps.repo.claimEvent(event.webhookEventId, event.source.groupId));
    return outcome;
  }
}
