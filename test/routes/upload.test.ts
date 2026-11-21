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
    await testEnv().DB.prepare("DELETE FROM import_verification_claims WHERE import_run_id IN (SELECT id FROM import_runs WHERE source_album_id = ?)").bind("eaf00f6811d7e301eff601ca3dc1e8c72202e63e7ebc28df6270d639cb491058").run();
    await testEnv()
      .DB.prepare("DELETE FROM import_runs WHERE source_album_id = ?")
      .bind("eaf00f6811d7e301eff601ca3dc1e8c72202e63e7ebc28df6270d639cb491058")
      .run();
    await testEnv()
      .DB.prepare("DELETE FROM sequences WHERE name = ?")
      .bind("product_id")
      .run();
  });
  it("does not leave a running job when context persistence fails", async () => {
    const { env, create } = triggerEnv();
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);
    await env.DB.exec(
      "CREATE TRIGGER fail_import_context BEFORE UPDATE OF settings_context_json ON import_runs BEGIN SELECT RAISE(FAIL, 'context unavailable'); END",
    );
    try {
      await handleUploadTrigger(env, "admin");
      expect(create).not.toHaveBeenCalled();
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM import_runs WHERE status='running'",
        ).first("count"),
      ).toBe(0);
    } finally {
      await env.DB.exec("DROP TRIGGER fail_import_context");
    }
  });
  // Mutation: bypassing bootstrap for any trigger and creating a run or Workflow.
  it("rejects every trigger before Product ID bootstrap", async () => {
    const { env, create } = triggerEnv();
    for (const trigger of ["cron", "line", "admin"] as const) {
      const response = await handleUploadTrigger(env, trigger);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        status: "sequence_not_bootstrapped",
      });
    }
    expect(create).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM import_runs").first(
        "count",
      ),
    ).toBe(0);
  });

  // Mutation: passing the album token instead of its digest, omitting persistence, or changing the trigger/instance ID.
  it("persists a safe album digest and starts the requested Workflow", async () => {
    const { env, create } = triggerEnv();
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);
    const response = await handleUploadTrigger(env, "line");
    expect(response.status).toBe(202);
    const body = await response.json<{
      status: string;
      importRunId: string;
      workflowInstanceId: string;
    }>();
    expect(body).toEqual({
      status: "started",
      importRunId: expect.any(String),
      workflowInstanceId: "instance-1",
    });
    expect(create).toHaveBeenCalledExactlyOnceWith({
      id: `import-${body.importRunId}`,
      params: {
        context: expect.objectContaining({ replyGroupId: null }),
        importRunId: body.importRunId,
        sourceAlbumId:
          "eaf00f6811d7e301eff601ca3dc1e8c72202e63e7ebc28df6270d639cb491058",
        trigger: "line",
      },
    });
    expect(
      await env.DB.prepare(
        "SELECT id, source_album_id, trigger, status FROM import_runs",
      ).all(),
    ).toMatchObject({
      results: [
        {
          id: body.importRunId,
          source_album_id:
            "eaf00f6811d7e301eff601ca3dc1e8c72202e63e7ebc28df6270d639cb491058",
          trigger: "line",
          status: "running",
        },
      ],
    });
    expect(JSON.stringify([body, create.mock.calls])).not.toContain(
      "TEST-TOKEN-ABC123",
    );
    expect(JSON.stringify([body, create.mock.calls])).not.toContain(
      "test-admin-route-token",
    );
  });
  it.each(["found", "missing", "unavailable", "unknown"] as const)(
    "reconciles a running claim when workflow is %s", async (state) => {
      const { env } = triggerEnv();
      await createSequenceRepository(env.DB).bootstrap("product_id", 1);
      const createBatch = vi.fn().mockResolvedValue([]);
      const get = vi.fn().mockImplementation(async () => {
        if (state === "missing") throw new Error("instance.not_found");
        if (state === "unavailable") throw new Error("unavailable");
        return { status: async () => ({ status: state === "unknown" ? "unknown" : "running" }) };
      });
      env.IMPORT_WORKFLOW = { createBatch, get } as unknown as typeof env.IMPORT_WORKFLOW;
      await handleUploadTrigger(env, "line", "stable");
      if (state === "unavailable" || state === "unknown" || state === "missing") {
        await expect(handleUploadTrigger(env, "line", "stable")).rejects.toMatchObject({ retryable: true });
      } else {
        expect((await handleUploadTrigger(env, "line", "stable")).status).toBe(202);
      }
      expect(get).toHaveBeenCalledWith("import-stable");
      expect(createBatch).toHaveBeenCalledTimes(1);
      expect(await env.DB.prepare("SELECT status FROM import_runs WHERE id = ?").bind("stable").first("status")).toBe("running");
    },
  );
  it("holds a lost creation response when lookup reports missing, including replay", async () => {
    const { env } = triggerEnv();
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);
    const createBatch = vi.fn().mockRejectedValue(new Error("response lost"));
    env.IMPORT_WORKFLOW = { createBatch, get: vi.fn().mockRejectedValue(new Error("instance.not_found")) } as unknown as typeof env.IMPORT_WORKFLOW;
    await expect(handleUploadTrigger(env, "line", "uncertain")).rejects.toThrow();
    await expect(handleUploadTrigger(env, "line", "uncertain")).rejects.toThrow();
    expect(createBatch).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT status FROM import_runs WHERE id = ?").bind("uncertain").first("status")).toBe("running");
  });
  it.each(["found", "missing", "unavailable"] as const)(
    "reconciles a failed create response when workflow is %s", async (state) => {
      const { env } = triggerEnv();
      await createSequenceRepository(env.DB).bootstrap("product_id", 1);
      const createBatch = vi.fn().mockRejectedValue(new Error("response lost"));
      const get = vi.fn().mockImplementation(async () => {
        if (state === "missing") throw new Error("instance.not_found");
        if (state === "unavailable") throw new Error("unavailable");
        return { status: async () => ({ status: "running" }) };
      });
      env.IMPORT_WORKFLOW = { createBatch, get } as unknown as typeof env.IMPORT_WORKFLOW;
      if (state === "found") expect((await handleUploadTrigger(env, "line", "stable")).status).toBe(202);
      else await expect(handleUploadTrigger(env, "line", "stable")).rejects.toMatchObject({ retryable: true });
      expect(get).toHaveBeenCalledWith("import-stable");
      expect(await env.DB.prepare("SELECT status FROM import_runs WHERE id = ?").bind("stable").first("status")).toBe("running");
    },
  );
  it.each(["running", "errored", "unknown"] as const)(
    "reconciles a fresh LINE event against the original %s workflow", async (state) => {
      const { env } = triggerEnv();
      await createSequenceRepository(env.DB).bootstrap("product_id", 1);
      const { captureOperationContext } = await import("../../src/settings/runtime");
      const context = await captureOperationContext(env, "owner-group");
      const createBatch = vi.fn().mockResolvedValue([]);
      const get = vi.fn().mockResolvedValue({ status: async () => ({ status: state }) });
      const create = vi.fn().mockResolvedValue({});
      env.IMPORT_WORKFLOW = { createBatch, get, create } as unknown as typeof env.IMPORT_WORKFLOW;
      await handleUploadTrigger(env, "line", "original", context, "event-original");
      const response = await handleUploadTrigger(env, "line", "fresh", context, "event-fresh");
      expect(await response.json()).toEqual(state === "running" ? { status: "already_running" } : { status: state === "errored" ? "checking" : "owner_review", importRunId: "original" });
      expect(get).toHaveBeenCalledWith("import-original");
      expect(createBatch).toHaveBeenCalledTimes(1);
      if (state === 'errored') expect(create).toHaveBeenCalledWith({id:'import-verification-original', params:{kind:'verification', importRunId:'original'}});
      else expect(create).not.toHaveBeenCalled();
    },
  );
  it('dispatches a saved claim when its verifier was never created', async () => {
    const { env } = triggerEnv();
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);
    const { captureOperationContext } = await import("../../src/settings/runtime");
    const { claimImportVerification } = await import("../../src/db/import-repository");
    const context = await captureOperationContext(env, "owner-group");
    const get = vi.fn().mockImplementation(async (id: string) => {
      if (id === "import-original") return {status: async () => ({status:"errored"})};
      throw new Error("instance.not_found");
    });
    const create = vi.fn().mockResolvedValue({});
    env.IMPORT_WORKFLOW = {createBatch: vi.fn().mockResolvedValue([]), get, create} as unknown as typeof env.IMPORT_WORKFLOW;
    await handleUploadTrigger(env, "line", "original", context, "event-original");
    const row = await env.DB.prepare("SELECT source_album_id, settings_context_json FROM import_runs WHERE id=?").bind("original").first<{source_album_id:string; settings_context_json:string}>();
    await claimImportVerification(env.DB, {runId:"original", albumId:row!.source_album_id, workflowId:"import-original", groupId:"owner-group", contextJson:row!.settings_context_json});
    const response = await handleUploadTrigger(env, "line", "fresh", context, "event-fresh");
    expect(await response.json()).toEqual({status:"checking", importRunId:"original"});
    expect(create).toHaveBeenCalledWith({id:"import-verification-original", params:{kind:"verification", importRunId:"original"}});
  });
  it('replays a lost verifier create response and renews only after interruption', async () => {
    const { env } = triggerEnv();
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);
    const { captureOperationContext } = await import("../../src/settings/runtime");
    const context = await captureOperationContext(env, "owner-group");
    let verifierStatus = "running";
    const get = vi.fn().mockImplementation(async (id: string) => ({status: async () => ({status: id === "import-original" ? "errored" : verifierStatus})}));
    const create = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValue({});
    const createBatch = vi.fn().mockResolvedValue([]);
    env.IMPORT_WORKFLOW = {createBatch, get, create} as unknown as typeof env.IMPORT_WORKFLOW;
    await handleUploadTrigger(env, "line", "original", context, "event-original");
    for (const event of ["one", "two"]) {
      const response = await handleUploadTrigger(env, "line", event, context, `event-${event}`);
      expect(await response.json()).toEqual({status:"checking", importRunId:"original"});
    }
    expect(create).toHaveBeenCalledTimes(1);
    verifierStatus = "terminated";
    const response = await handleUploadTrigger(env, "line", "three", context, "event-three");
    expect(await response.json()).toEqual({status:"checking", importRunId:"original"});
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0].id).not.toBe('import-verification-original');
    expect(createBatch).toHaveBeenCalledTimes(1);
  });
  it.each(["completed", "completed_with_failures"] as const)("observes %s finalization during workflow lookup", async (status) => {
    const { env } = triggerEnv();
    const runId = `original-${status}`, groupId = `owner-${status}`;
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);
    const { captureOperationContext } = await import("../../src/settings/runtime");
    const { createImportRepository } = await import("../../src/db/import-repository");
    const context = await captureOperationContext(env, groupId);
    const { createLineReplyRepository } = await import("../../src/db/line-reply-repository");
    const { createLineClient } = await import("../../src/line/client");
    const { deliverEventReply } = await import("../../src/line/reply-delivery");
    const clock = { now: () => new Date() }, repo = createLineReplyRepository(env.DB, clock), requests: any[] = [];
    await repo.enqueueResult({ resultKey: `older-${status}`, groupId: groupId, result: { schemaVersion: 1, kind: "import", runId: `older-${status}`, generation: 1, notificationCycle: 1, outcome: "success", messages: [{ type: "text", text: "older summary" }] } });
    const createBatch = vi.fn().mockResolvedValue([]);
    const get = vi.fn().mockImplementation(async () => ({ status: async () => {
      const repo = createImportRepository(env.DB, { next: () => "id" }, { now: () => new Date() });
      const album = await env.DB.prepare("SELECT source_album_id FROM import_runs WHERE id=?").bind(runId).first<string>("source_album_id");
      await repo.finalizeImportRun({ id: runId, sourceAlbumId: album!, status, orphanPhotoCount: 0, checkpointPosition: 7,
        lineResult: { groupId: groupId, result: { schemaVersion: 1, kind: "import", runId: runId, generation: 1, notificationCycle: 1, outcome: status === "completed" ? "success" : "partial", messages: [{ type: "text", text: "detailed summary" }] } } });
      return { status: "complete" };
    }}));
    env.IMPORT_WORKFLOW = { createBatch, get } as unknown as typeof env.IMPORT_WORKFLOW;
    await handleUploadTrigger(env, "line", runId, context, "event-original");
    const response = await handleUploadTrigger(env, "line", "fresh", context, "event-fresh");
    expect(await response.json()).toEqual({ status: status === "completed" ? "completed" : "partial", importRunId: runId });
    expect(createBatch).toHaveBeenCalledTimes(1);
    const line = createLineClient({ channelAccessToken: "x", fetch: async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return Response.json({}); } });
    const input = { eventId: crypto.randomUUID(), groupId: groupId, workflowId: "wf", receivedAt: clock.now().toISOString(), replyToken: "token", commandReply: { kind: "text" as const, text: `status ${runId}` }, drainQueue: true, publicBaseUrl: "https://example.test" };
    const deps = { repo, line, clock, isGroupAllowed: async () => true };
    await deliverEventReply(input, deps);
    await deliverEventReply({ ...input, eventId: crypto.randomUUID() }, deps);
    await deliverEventReply({ ...input, eventId: crypto.randomUUID() }, deps);
    expect(requests.map(r => r.messages.map((m: any) => m.text))).toEqual([[`status ${runId}`, "older summary"], [`status ${runId}`, "detailed summary"], [`status ${runId}`]]);
  });
  it.each(["foreign", "missing", "unavailable"] as const)(
    "keeps the original lock for %s reconciliation", async (scenario) => {
      const { env } = triggerEnv();
      await createSequenceRepository(env.DB).bootstrap("product_id", 1);
      const { captureOperationContext } = await import("../../src/settings/runtime");
      const owner = await captureOperationContext(env, "owner-group");
      const caller = scenario === "foreign" ? await captureOperationContext(env, "other-group") : owner;
      const createBatch = vi.fn().mockResolvedValue([]);
      const get = vi.fn().mockRejectedValue(new Error(scenario === "missing" ? "instance.not_found" : "unavailable"));
      env.IMPORT_WORKFLOW = { createBatch, get } as unknown as typeof env.IMPORT_WORKFLOW;
      await handleUploadTrigger(env, "line", "original", owner, "event-original");
      const response = await handleUploadTrigger(env, "line", "fresh", caller, "event-fresh");
      expect(await response.json()).toEqual(scenario === "foreign" ? { status: "busy" } : { status: "owner_review", importRunId: "original" });
      expect(createBatch).toHaveBeenCalledTimes(1);
      expect(await env.DB.prepare("SELECT status FROM import_runs WHERE id = ?").bind("original").first("status")).toBe("running");
      if (scenario === "foreign") expect(get).not.toHaveBeenCalled();
    },
  );
  // Mutation: letting the D1 uniqueness race reject instead of returning a benign conflict.
  it("allows one concurrent running import per album using real D1", async () => {
    const { env, create } = triggerEnv();
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);
    const responses = await Promise.all([
      handleUploadTrigger(env, "cron"),
      handleUploadTrigger(env, "admin"),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      202, 409,
    ]);
    expect(
      await responses.find((response) => response.status === 409)!.json(),
    ).toEqual({ status: "already_running" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM import_runs WHERE status = 'running'",
      ).first("count"),
    ).toBe(1);
    expect((await handleUploadTrigger(env, "line")).status).toBe(409);
    expect(create).toHaveBeenCalledTimes(1);
  });
  // Mutation: retaining the running lock after create rejects, or returning/logging its upstream error.
  it("marks failed starts and permits a later attempt without exposing secrets", async () => {
    const { env, create } = triggerEnv();
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);
    create.mockRejectedValueOnce(
      new Error(
        "upstream private body TEST-TOKEN-ABC123 test-admin-route-token",
      ),
    );
    const errorLog = vi.spyOn(console, "error");
    const warnLog = vi.spyOn(console, "warn");
    try {
      const failed = await handleUploadTrigger(env, "admin");
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({ status: "workflow_start_failed" });
      expect(
        await env.DB.prepare(
          "SELECT status, finished_at FROM import_runs",
        ).all(),
      ).toMatchObject({
        results: [{ status: "start_failed", finished_at: expect.any(String) }],
      });
      expect((await handleUploadTrigger(env, "admin")).status).toBe(202);
      expect(
        await env.DB.prepare(
          "SELECT status FROM import_runs ORDER BY status",
        ).all(),
      ).toMatchObject({
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
  it.each(["INSERT", "UPDATE"] as const)(
    "hides %s database failures",
    async (operation) => {
      const { env, create } = triggerEnv();
      await createSequenceRepository(env.DB).bootstrap("product_id", 1);
      if (operation === "UPDATE")
        create.mockRejectedValueOnce(new Error("private Workflow failure"));
      await env.DB.exec(
        `CREATE TRIGGER task15_fail_write BEFORE ${operation} ON import_runs BEGIN SELECT RAISE(FAIL, 'private database body TEST-TOKEN-ABC123'); END;`,
      );
      try {
        const response = await handleUploadTrigger(env, "admin");
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          status: "import_trigger_failed",
        });
        expect(create).not.toHaveBeenCalled();
      } finally {
        await env.DB.exec("DROP TRIGGER task15_fail_write");
      }
    },
  );
});
