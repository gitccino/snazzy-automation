import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSequenceRepository } from "../src/db/sequence-repository";
import { handleScheduled } from "../src/scheduled";
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
});
