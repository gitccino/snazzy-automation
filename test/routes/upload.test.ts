import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSequenceRepository } from "../../src/db/sequence-repository";
import { handleUploadTrigger } from "../../src/routes/upload";
import { createTestEnv, testEnv } from "../helpers/env";

function triggerEnv() {
  const create = vi.fn().mockResolvedValue({ id: "instance-1" });
  const env = { ...testEnv(), ...createTestEnv() };
  env.IMPORT_WORKFLOW = { create } as unknown as typeof env.IMPORT_WORKFLOW;
  return { env, create };
}

describe("handleUploadTrigger", () => {
  beforeEach(async () => {
    await testEnv().DB.prepare("DELETE FROM import_runs WHERE source_album_id = ?")
      .bind("eaf00f6811d7e301eff601ca3dc1e8c72202e63e7ebc28df6270d639cb491058").run();
    await testEnv().DB.prepare("DELETE FROM sequences WHERE name = ?").bind("product_id").run();
  });
  // Mutation: bypassing bootstrap for any trigger and creating a run or Workflow.
  it("rejects every trigger before Product ID bootstrap", async () => {
    const { env, create } = triggerEnv();
    for (const trigger of ["cron", "line", "admin"] as const) {
      const response = await handleUploadTrigger(env, trigger);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "sequence_not_bootstrapped" });
    }
    expect(create).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM import_runs").first("count")).toBe(0);
  });

  // Mutation: passing the album token instead of its digest, omitting persistence, or changing the trigger/instance ID.
  it("persists a safe album digest and starts the requested Workflow", async () => {
    const { env, create } = triggerEnv();
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);
    const response = await handleUploadTrigger(env, "line");
    expect(response.status).toBe(202);
    const body = await response.json<{ status: string; importRunId: string; workflowInstanceId: string }>();
    expect(body).toEqual({ status: "started", importRunId: expect.any(String), workflowInstanceId: "instance-1" });
    expect(create).toHaveBeenCalledExactlyOnceWith({
      id: `import-${body.importRunId}`,
      params: {
        importRunId: body.importRunId,
        sourceAlbumId: "eaf00f6811d7e301eff601ca3dc1e8c72202e63e7ebc28df6270d639cb491058",
        trigger: "line",
      },
    });
    expect(await env.DB.prepare("SELECT id, source_album_id, trigger, status FROM import_runs").all()).toMatchObject({
      results: [{ id: body.importRunId, source_album_id: "eaf00f6811d7e301eff601ca3dc1e8c72202e63e7ebc28df6270d639cb491058", trigger: "line", status: "running" }],
    });
    expect(JSON.stringify([body, create.mock.calls])).not.toContain("TEST-TOKEN-ABC123");
    expect(JSON.stringify([body, create.mock.calls])).not.toContain("test-admin-route-token");
  });
  it("reuses the same import run after an uncertain Workflow start response", async () => {
    const { env } = triggerEnv();
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);
    const createBatch = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValue([]);
    env.IMPORT_WORKFLOW = { createBatch } as unknown as typeof env.IMPORT_WORKFLOW;
    await expect(handleUploadTrigger(env, "line", "line-stable-event")).rejects.toMatchObject({ retryable: true });
    expect((await handleUploadTrigger(env, "line", "line-stable-event")).status).toBe(202);
    expect(createBatch.mock.calls[0]).toEqual(createBatch.mock.calls[1]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM import_runs").first("count")).toBe(1);
    await env.DB.prepare("UPDATE import_runs SET status = 'completed' WHERE id = ?").bind("line-stable-event").run();
    expect((await handleUploadTrigger(env, "line", "line-stable-event")).status).toBe(202);
    expect(createBatch).toHaveBeenCalledTimes(2);
  });
  // Mutation: letting the D1 uniqueness race reject instead of returning a benign conflict.
  it("allows one concurrent running import per album using real D1", async () => {
    const { env, create } = triggerEnv();
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);
    const responses = await Promise.all([
      handleUploadTrigger(env, "cron"),
      handleUploadTrigger(env, "admin"),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(await responses.find((response) => response.status === 409)!.json()).toEqual({ status: "already_running" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM import_runs WHERE status = 'running'").first("count")).toBe(1);
    expect((await handleUploadTrigger(env, "line")).status).toBe(409);
    expect(create).toHaveBeenCalledTimes(1);
  });
  // Mutation: retaining the running lock after create rejects, or returning/logging its upstream error.
  it("marks failed starts and permits a later attempt without exposing secrets", async () => {
    const { env, create } = triggerEnv();
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);
    create.mockRejectedValueOnce(new Error("upstream private body TEST-TOKEN-ABC123 test-admin-route-token"));
    const errorLog = vi.spyOn(console, "error");
    const warnLog = vi.spyOn(console, "warn");
    try {
      const failed = await handleUploadTrigger(env, "admin");
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({ status: "workflow_start_failed" });
      expect(await env.DB.prepare("SELECT status, finished_at FROM import_runs").all()).toMatchObject({
        results: [{ status: "start_failed", finished_at: expect.any(String) }],
      });
      expect((await handleUploadTrigger(env, "admin")).status).toBe(202);
      expect(await env.DB.prepare("SELECT status FROM import_runs ORDER BY status").all()).toMatchObject({
        results: [{ status: "running" }, { status: "start_failed" }],
      });
      expect(create).toHaveBeenCalledTimes(2);
      expect(errorLog).not.toHaveBeenCalled();
      expect(warnLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      warnLog.mockRestore();
    }
  });
  // Mutation: propagating raw database exceptions from run creation or failed-start cleanup.
  it.each(["INSERT", "UPDATE"] as const)("hides %s database failures", async (operation) => {
    const { env, create } = triggerEnv();
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);
    if (operation === "UPDATE") create.mockRejectedValueOnce(new Error("private Workflow failure"));
    await env.DB.exec(`CREATE TRIGGER task15_fail_write BEFORE ${operation} ON import_runs BEGIN SELECT RAISE(FAIL, 'private database body TEST-TOKEN-ABC123'); END;`);
    try {
      const response = await handleUploadTrigger(env, "admin");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ status: "import_trigger_failed" });
      expect(create).toHaveBeenCalledTimes(operation === "INSERT" ? 0 : 1);
    } finally {
      await env.DB.exec("DROP TRIGGER task15_fail_write");
    }
  });
});
