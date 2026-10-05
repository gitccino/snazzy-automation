import { beforeEach, describe, expect, it, vi } from "vitest";

const publicationTrigger = vi.hoisted(() => {
  // Workflow binding registration preloads the Worker modules before this test.
  vi.resetModules();
  return { handleDocsTrigger: vi.fn() };
});
vi.mock("../src/publication/trigger", () => publicationTrigger);

import { createSequenceRepository } from "../src/db/sequence-repository";
import { recordUsage } from "../src/db/usage-repository";
import type { LineClient } from "../src/line/client";
import { handleScheduled, runBudgetAlarmCheck } from "../src/scheduled";
import worker from "../src/index";
import { createTestEnv, testEnv } from "./helpers/env";

function scheduledEnv() {
  const create = vi.fn().mockResolvedValue({ id: "cron-instance" });
  const env = { ...testEnv(), ...createTestEnv() };
  env.IMPORT_WORKFLOW = { create } as unknown as typeof env.IMPORT_WORKFLOW;
  return { env, create };
}

describe("handleScheduled", () => {
  beforeEach(async () => {
    publicationTrigger.handleDocsTrigger.mockReset();
    await testEnv().DB.prepare("DELETE FROM usage_metrics").run();
    await testEnv().DB.prepare("DELETE FROM import_runs WHERE source_album_id = ?")
      .bind("eaf00f6811d7e301eff601ca3dc1e8c72202e63e7ebc28df6270d639cb491058").run();
    await testEnv().DB.prepare("DELETE FROM sequences WHERE name = ?").bind("product_id").run();
  });

  // Mutation: ignoring the configured cron, starting on an unrelated event, or forwarding the wrong trigger.
  it("starts only for the configured cron and accepts an already-running import", async () => {
    const { env, create } = scheduledEnv();
    await expect(handleScheduled(env, "15 4 * * *")).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);
    await expect(handleScheduled(env, "0 23 * * *")).resolves.toBeUndefined();
    await expect(handleScheduled(env, "0 23 * * *")).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0].params.trigger).toBe("cron");
  });
  // Mutation: silently resolving scheduled events when bootstrap or Workflow creation fails.
  it("rejects bootstrap and Workflow-start failures with a generic error", async () => {
    const { env, create } = scheduledEnv();
    await expect(handleScheduled(env, "0 23 * * *")).rejects.toThrow("scheduled_import_failed");
    expect(create).not.toHaveBeenCalled();
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);
    create.mockRejectedValueOnce(new Error("private upstream TEST-TOKEN-ABC123 test-admin-route-token"));
    await expect(handleScheduled(env, "0 23 * * *")).rejects.toThrow(/^scheduled_import_failed$/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  // Mutation: leaking config parsing details through the scheduled rejection.
  it("rejects malformed configuration without echoing its content", async () => {
    const { env, create } = scheduledEnv();
    env.APP_CONFIG_JSON = "private invalid config TEST-TOKEN-ABC123";
    await expect(handleScheduled(env, "0 23 * * *")).rejects.toThrow(/^scheduled_import_failed$/);
    expect(create).not.toHaveBeenCalled();
  });
  // Mutation: omitting scheduled wiring or dropping the rejected promise instead of registering it with waitUntil.
  it("registers scheduled work with the Worker execution context", async () => {
    const { env } = scheduledEnv();
    let pending: Promise<unknown> | undefined;
    const waitUntil = vi.fn((promise: Promise<unknown>) => { pending = promise; });
    const handler: ExportedHandler<typeof env> = worker;
    expect(handler.scheduled).toBeTypeOf("function");
    await handler.scheduled!({ cron: "0 23 * * *" } as ScheduledController, env, { waitUntil } as unknown as ExecutionContext);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(pending).rejects.toThrow(/^scheduled_import_failed$/);
  });

  it("routes the configured publication cron through the shared trigger with the scheduled clock", async () => {
    const { env, create } = scheduledEnv();
    const clock = { now: () => new Date("2026-09-01T17:30:00.000Z") };
    publicationTrigger.handleDocsTrigger.mockResolvedValue({ status: "no_runnable_run" });

    await handleScheduled(env, "30 23 * * *", clock);

    expect(publicationTrigger.handleDocsTrigger).toHaveBeenCalledExactlyOnceWith(env, "cron", clock);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not trigger publication for import or unrelated crons", async () => {
    const { env } = scheduledEnv();
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);

    await handleScheduled(env, "0 23 * * *");
    await handleScheduled(env, "15 4 * * *");

    expect(publicationTrigger.handleDocsTrigger).not.toHaveBeenCalled();
  });

  it("normalizes publication scheduler failures without exposing upstream content", async () => {
    const { env, create } = scheduledEnv();
    publicationTrigger.handleDocsTrigger.mockRejectedValue(new Error("private upstream TEST-TOKEN-ABC123 sk-ant-SECRET"));

    await expect(handleScheduled(env, "30 23 * * *")).rejects.toThrow(/^scheduled_publication_failed$/);
    expect(create).not.toHaveBeenCalled();
  });

  it("passes the event's scheduled time through waitUntil for the publication date lookup", async () => {
    const { env } = scheduledEnv();
    const scheduledTime = Date.parse("2026-09-01T17:30:00.000Z");
    publicationTrigger.handleDocsTrigger.mockResolvedValue({ status: "no_runnable_run" });
    let pending: Promise<unknown> | undefined;
    const waitUntil = vi.fn((promise: Promise<unknown>) => { pending = promise; });
    const handler: ExportedHandler<typeof env> = worker;

    await handler.scheduled!({ cron: "30 23 * * *", scheduledTime } as ScheduledController, env, { waitUntil } as unknown as ExecutionContext);
    await pending;

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(publicationTrigger.handleDocsTrigger).toHaveBeenCalledTimes(1);
    const [actualEnv, actualTrigger, clock] = publicationTrigger.handleDocsTrigger.mock.calls[0]!;
    expect(actualEnv).toBe(env);
    expect(actualTrigger).toBe("cron");
    expect(clock.now().toISOString()).toBe("2026-09-01T17:30:00.000Z");
  });

  it("pushes a Thai budget alert to the configured group only when over budget", async () => {
    const { env } = scheduledEnv();
    const pushed: Array<{ groupId: string; text: string }> = [];
    const lineClient: LineClient = {
      pushMessage: async (groupId, text) => { pushed.push({ groupId, text }); },
      replyFlex: async () => undefined,
      replyText: vi.fn(),
      replyButtons: vi.fn(),
      getGroupMemberProfile: vi.fn(),
    };
    const alarmEnv = { ...env, __lineClientOverride: lineClient };
    await recordUsage(alarmEnv.DB, "claude_input_tokens", 50_000_000, "2026-09-01");

    const result = await runBudgetAlarmCheck(alarmEnv, { now: () => new Date("2026-09-01T22:45:00.000Z") });

    expect(result.sent).toBe(true);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.groupId).toBe("CtestGroup");
    expect(pushed[0]?.text).toContain("บาท");
    expect(pushed[0]?.text).toContain("เกินงบประมาณ");
  });

  it("does not push a budget alert when usage is under budget", async () => {
    const { env } = scheduledEnv();
    const pushMessage = vi.fn();
    const alarmEnv = {
      ...env,
      __lineClientOverride: {
        pushMessage,
        replyFlex: async () => undefined,
        replyText: vi.fn(),
        replyButtons: vi.fn(),
        getGroupMemberProfile: vi.fn(),
      } satisfies LineClient,
    };

    const result = await runBudgetAlarmCheck(alarmEnv, { now: () => new Date("2026-09-01T22:45:00.000Z") });

    expect(result.sent).toBe(false);
    expect(pushMessage).not.toHaveBeenCalled();
  });

  it("routes only the exact daily budget-alarm cron", async () => {
    const { env } = scheduledEnv();
    const pushMessage = vi.fn();
    const alarmEnv = {
      ...env,
      __lineClientOverride: {
        pushMessage,
        replyFlex: async () => undefined,
        replyText: vi.fn(),
        replyButtons: vi.fn(),
        getGroupMemberProfile: vi.fn(),
      } satisfies LineClient,
    };
    await recordUsage(alarmEnv.DB, "claude_input_tokens", 50_000_000, "2026-09-01");
    const clock = { now: () => new Date("2026-09-01T22:45:00.000Z") };

    await handleScheduled(alarmEnv, "44 22 * * *", clock);
    expect(pushMessage).not.toHaveBeenCalled();
    await handleScheduled(alarmEnv, "45 22 * * *", clock);

    expect(pushMessage).toHaveBeenCalledOnce();
  });
});
