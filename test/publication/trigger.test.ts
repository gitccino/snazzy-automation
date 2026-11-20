import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import type { PublicationRunStatus } from "../../src/publication/types";
import { handleDocsTrigger } from "../../src/publication/trigger";
import {
  acquireOrResumeJob,
  getProductCache,
  putProductCaptions,
  putProductCollage,
  reopenFailedJobForRestart,
  setJobState,
  reopenSuccessfulJobForRegeneration,
} from "../../src/db/publication-repository";
import { createTestEnv, testEnv } from "../helpers/env";

const clock = { now: () => new Date("2026-09-01T17:30:00.000Z") };

function mockRun(status: PublicationRunStatus | null = "Ready") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      records:
        status === null
          ? []
          : [
              {
                id: "rec-run-1",
                fields: {
                  "Publication Date": "2026-09-02",
                  Status: status,
                  Products: [],
                },
              },
            ],
    }),
  );
}

function makeTriggerEnv(statusValue: string) {
  const restart = vi.fn().mockResolvedValue(undefined);
  const resume = vi.fn().mockResolvedValue(undefined);
  const status = vi.fn().mockResolvedValue({ status: statusValue });
  const get = vi.fn().mockResolvedValue({ status, restart, resume });
  const create = vi.fn().mockResolvedValue({ id: "publication-rec-run-1" });
  const env = {
    ...testEnv(),
    ...createTestEnv(),
    PUBLICATION_WORKFLOW: { get, create },
  } as unknown as Env;
  return { env, get, create, status, restart, resume };
}

describe("handleDocsTrigger", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await testEnv().DB.exec("DELETE FROM publication_product_cache");
    await testEnv().DB.exec("DELETE FROM publication_jobs");
  });

  async function completed(fixture: ReturnType<typeof makeTriggerEnv>) {
    await acquireOrResumeJob(
      fixture.env.DB,
      clock,
      "rec-run-1",
      "publication-rec-run-1",
    );
    await setJobState(fixture.env.DB, clock, "rec-run-1", "succeeded", {
      googleDocId: "old-doc",
      googleDocUrl: "old-url",
    });
  }

  it("starts a new deterministic version for LINE + Ready", async () => {
    mockRun("Ready");
    const fixture = makeTriggerEnv("complete");
    await completed(fixture);
    fixture.get.mockImplementation(async (id: string) => {
      if (id.endsWith("-v2")) throw new Error("instance.not_found");
      return {
        status: fixture.status,
        restart: fixture.restart,
        resume: fixture.resume,
      };
    });
    await expect(
      handleDocsTrigger(fixture.env, "line", clock),
    ).resolves.toEqual({
      status: "regenerating",
      publicationRunId: "rec-run-1",
      generation: 2,
    });
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith({
      id: "publication-rec-run-1-v2",
      params: {
        context: expect.objectContaining({ replyGroupId: null }),
        publicationRunId: "rec-run-1",
        trigger: "line",
        generation: 2,
      },
    });
    expect(fixture.restart).not.toHaveBeenCalled();
  });

  it("keeps an allocated v2 resumable after Workflow creation fails", async () => {
    mockRun();
    const fixture = makeTriggerEnv("complete");
    await completed(fixture);
    fixture.get.mockImplementation(async (id: string) => {
      if (id.endsWith("-v2")) throw new Error("instance.not_found");
      return {
        status: fixture.status,
        restart: fixture.restart,
        resume: fixture.resume,
      };
    });
    fixture.create.mockRejectedValueOnce(new Error("creation unavailable"));
    await expect(handleDocsTrigger(fixture.env, "line", clock)).rejects.toThrow(
      "creation unavailable",
    );
    expect(
      (await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other"))
        .job,
    ).toMatchObject({
      generation: 2,
      successfulGeneration: 1,
      googleDocId: "old-doc",
    });
    await expect(
      handleDocsTrigger(fixture.env, "line", clock),
    ).resolves.toMatchObject({ status: "started" });
    expect(fixture.create.mock.calls.map(([value]) => value.id)).toEqual([
      "publication-rec-run-1-v2",
      "publication-rec-run-1-v2",
    ]);
  });

  it.each(["cron", "admin"] as const)(
    "%s skips a replacement request",
    async (trigger) => {
      mockRun("Ready");
      const fixture = makeTriggerEnv("complete");
      await completed(fixture);
      await expect(
        handleDocsTrigger(fixture.env, trigger, clock),
      ).resolves.toEqual({
        status: "already_generated",
        publicationRunId: "rec-run-1",
      });
      expect(fixture.get).not.toHaveBeenCalled();
      expect(
        (await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other"))
          .job.generation,
      ).toBe(1);
    },
  );

  it("cron never retries a failed replacement", async () => {
    mockRun("Failed");
    const fixture = makeTriggerEnv("errored");
    await completed(fixture);
    await reopenSuccessfulJobForRegeneration(
      fixture.env.DB,
      clock,
      "rec-run-1",
      1,
    );
    await setJobState(
      fixture.env.DB,
      clock,
      "rec-run-1",
      "failed",
      undefined,
      2,
    );
    await expect(
      handleDocsTrigger(fixture.env, "cron", clock),
    ).resolves.toEqual({
      status: "already_generated",
      publicationRunId: "rec-run-1",
    });
    expect(fixture.get).not.toHaveBeenCalled();
  });

  it("LINE retries the failed version without allocating v3", async () => {
    mockRun("Failed");
    const fixture = makeTriggerEnv("errored");
    await completed(fixture);
    await reopenSuccessfulJobForRegeneration(
      fixture.env.DB,
      clock,
      "rec-run-1",
      1,
    );
    await setJobState(
      fixture.env.DB,
      clock,
      "rec-run-1",
      "failed",
      undefined,
      2,
    );
    await expect(
      handleDocsTrigger(fixture.env, "line", clock),
    ).resolves.toEqual({ status: "restarted", publicationRunId: "rec-run-1" });
    expect(fixture.get).toHaveBeenCalledWith("publication-rec-run-1-v2");
    expect(
      (await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other"))
        .job,
    ).toMatchObject({ generation: 2, state: "locked" });
  });

  it("reports Generated to LINE without starting a workflow", async () => {
    mockRun("Generated");
    const fixture = makeTriggerEnv("complete");
    await expect(
      handleDocsTrigger(fixture.env, "line", clock),
    ).resolves.toEqual({
      status: "already_generated",
      publicationRunId: "rec-run-1",
    });
    expect(fixture.get).not.toHaveBeenCalled();
  });

  it.each(["admin", "line", "cron"] as const)(
    "creates only an unknown instance with its hyphenated ID and %s trigger",
    async (trigger) => {
      const fetcher = mockRun();
      const fixture = makeTriggerEnv("unknown");

      await expect(
        handleDocsTrigger(fixture.env, trigger, clock),
      ).resolves.toEqual({
        status: "started",
        publicationRunId: "rec-run-1",
      });

      expect(fixture.get).toHaveBeenCalledExactlyOnceWith(
        "publication-rec-run-1",
      );
      expect(fixture.status).toHaveBeenCalledTimes(1);
      expect(fixture.create).toHaveBeenCalledExactlyOnceWith({
        id: "publication-rec-run-1",
        params: {
          context: expect.objectContaining({ replyGroupId: null }),
          publicationRunId: "rec-run-1",
          trigger,
        },
      });
      const url = new URL(String(fetcher.mock.calls[0]?.[0]));
      expect(url.searchParams.get("filterByFormula")).toBe(
        "DATESTR({Publication Date})='2026-09-02'",
      );
      expect(fixture.restart).not.toHaveBeenCalled();
      expect(fixture.resume).not.toHaveBeenCalled();
    },
  );

  it("starts a missing instance when the real Workflow binding rejects its lookup", async () => {
    mockRun();
    const fixture = makeTriggerEnv("unknown");
    fixture.get.mockImplementation((id: string) =>
      testEnv().PUBLICATION_WORKFLOW.get(id),
    );

    await expect(
      handleDocsTrigger(fixture.env, "admin", clock),
    ).resolves.toEqual({
      status: "started",
      publicationRunId: "rec-run-1",
    });

    expect(fixture.create).toHaveBeenCalledExactlyOnceWith({
      id: "publication-rec-run-1",
      params: {
        context: expect.objectContaining({ replyGroupId: null }),
        publicationRunId: "rec-run-1",
        trigger: "admin",
      },
    });
  });

  it("recognizes Cloudflare's wrapped instance-not-found error", async () => {
    mockRun();
    const fixture = makeTriggerEnv("unknown");
    fixture.get.mockRejectedValueOnce(
      new Error("(instance.not_found) Instance not found"),
    );
    await expect(
      handleDocsTrigger(fixture.env, "admin", clock),
    ).resolves.toEqual({
      status: "started",
      publicationRunId: "rec-run-1",
    });
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith({
      id: "publication-rec-run-1",
      params: {
        context: expect.objectContaining({ replyGroupId: null }),
        publicationRunId: "rec-run-1",
        trigger: "admin",
      },
    });
  });

  it("does not create or reopen a failed job when the instance lookup fails for another reason", async () => {
    mockRun("Failed");
    const fixture = makeTriggerEnv("unknown");
    await acquireOrResumeJob(
      fixture.env.DB,
      clock,
      "rec-run-1",
      "previous-owner",
    );
    await setJobState(fixture.env.DB, clock, "rec-run-1", "failed");
    fixture.get.mockRejectedValueOnce(new Error("Workflow lookup unavailable"));

    await expect(
      handleDocsTrigger(fixture.env, "admin", clock),
    ).rejects.toThrow("Workflow lookup unavailable");

    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.restart).not.toHaveBeenCalled();
    expect(
      (await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other"))
        .job.state,
    ).toBe("failed");
  });

  it.each(["errored", "terminated", "complete", "unknown"])(
    "reopens a failed job with its cached products before the %s Workflow is started again",
    async (statusValue) => {
      mockRun("Failed");
      const fixture = makeTriggerEnv(statusValue);
      await acquireOrResumeJob(
        fixture.env.DB,
        clock,
        "rec-run-1",
        "previous-owner",
      );
      await putProductCollage(
        fixture.env.DB,
        clock,
        "rec-run-1",
        "A-1001",
        "products/A-1001/collage/1080x1080.jpg",
        "collage-input",
      );
      await putProductCaptions(
        fixture.env.DB,
        clock,
        "rec-run-1",
        "A-1001",
        '["หนึ่ง","สอง","สาม"]',
        "caption-input",
      );
      await setJobState(fixture.env.DB, clock, "rec-run-1", "failed");
      fixture.status.mockImplementation(async () => {
        expect(
          (
            await acquireOrResumeJob(
              fixture.env.DB,
              clock,
              "rec-run-1",
              "other",
            )
          ).job.state,
        ).toBe("failed");
        return { status: statusValue };
      });
      const start =
        statusValue === "unknown" ? fixture.create : fixture.restart;
      start.mockImplementation(async () => {
        const { job } = await acquireOrResumeJob(
          fixture.env.DB,
          clock,
          "rec-run-1",
          "other",
        );
        expect(job).toMatchObject({
          state: "locked",
          correlationId: "publication-rec-run-1",
        });
        expect(
          await getProductCache(fixture.env.DB, "rec-run-1", "A-1001"),
        ).toEqual({
          collageR2Key: "products/A-1001/collage/1080x1080.jpg",
          captionsJson: '["หนึ่ง","สอง","สาม"]',
          collageInputFingerprint: "collage-input",
          captionsInputFingerprint: "caption-input",
        });
      });

      await expect(
        handleDocsTrigger(fixture.env, "admin", clock),
      ).resolves.toEqual({
        status: statusValue === "unknown" ? "started" : "restarted",
        publicationRunId: "rec-run-1",
      });
      expect(start).toHaveBeenCalledTimes(1);
      expect(
        statusValue === "unknown" ? fixture.restart : fixture.create,
      ).not.toHaveBeenCalled();
    },
  );

  it("keeps a reopened failed job and its cache resumable if recreating an expired Workflow fails", async () => {
    mockRun("Failed");
    const fixture = makeTriggerEnv("unknown");
    fixture.get.mockRejectedValue(new Error("instance.not_found"));
    await acquireOrResumeJob(
      fixture.env.DB,
      clock,
      "rec-run-1",
      "previous-owner",
    );
    await putProductCollage(
      fixture.env.DB,
      clock,
      "rec-run-1",
      "A-1001",
      "products/A-1001/collage/1080x1080.jpg",
      "collage-input",
    );
    await putProductCaptions(
      fixture.env.DB,
      clock,
      "rec-run-1",
      "A-1001",
      '["หนึ่ง","สอง","สาม"]',
      "caption-input",
    );
    await setJobState(fixture.env.DB, clock, "rec-run-1", "failed");
    fixture.create.mockRejectedValueOnce(
      new Error("Workflow creation unavailable"),
    );

    await expect(
      handleDocsTrigger(fixture.env, "admin", clock),
    ).rejects.toThrow("Workflow creation unavailable");
    expect(
      (await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other"))
        .job,
    ).toMatchObject({
      state: "locked",
      correlationId: "publication-rec-run-1",
    });
    expect(
      await getProductCache(fixture.env.DB, "rec-run-1", "A-1001"),
    ).toEqual({
      collageR2Key: "products/A-1001/collage/1080x1080.jpg",
      captionsJson: '["หนึ่ง","สอง","สาม"]',
      collageInputFingerprint: "collage-input",
      captionsInputFingerprint: "caption-input",
    });

    await expect(
      handleDocsTrigger(fixture.env, "admin", clock),
    ).resolves.toEqual({
      status: "started",
      publicationRunId: "rec-run-1",
    });
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(
      fixture.create.mock.calls.every(
        ([options]) => options.id === "publication-rec-run-1",
      ),
    ).toBe(true);
    expect(
      await getProductCache(fixture.env.DB, "rec-run-1", "A-1001"),
    ).toEqual({
      collageR2Key: "products/A-1001/collage/1080x1080.jpg",
      captionsJson: '["หนึ่ง","สอง","สาม"]',
      collageInputFingerprint: "collage-input",
      captionsInputFingerprint: "caption-input",
    });
  });

  it.each(["Draft", "Generating", "Generated"] as const)(
    "does not reopen or start a run returned with ineligible %s status",
    async (runStatus) => {
      mockRun(runStatus);
      const fixture = makeTriggerEnv("errored");
      await acquireOrResumeJob(
        fixture.env.DB,
        clock,
        "rec-run-1",
        "previous-owner",
      );
      await setJobState(fixture.env.DB, clock, "rec-run-1", "failed");

      await expect(
        handleDocsTrigger(fixture.env, "admin", clock),
      ).resolves.toEqual({ status: "no_runnable_run" });

      expect(fixture.get).not.toHaveBeenCalled();
      expect(
        (await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other"))
          .job.state,
      ).toBe("failed");
    },
  );

  it.each(["running", "unavailable", "missing", "unknown", "complete", "paused"])("reconciles a lost verifier create response with %s lookup", async (verifierStatus) => {
    mockRun("Generating");
    const h = makeTriggerEnv("errored");
    const { captureOperationContext } = await import("../../src/settings/runtime");
    const { savePublicationAttemptContext } = await import("../../src/db/execution-context-repository");
    const context = { ...await captureOperationContext(h.env, null), replyGroupId: "owner" };
    await acquireOrResumeJob(h.env.DB, clock, "rec-run-1", "publication-rec-run-1");
    await savePublicationAttemptContext(h.env.DB, "rec-run-1", 1, context);
    h.create.mockRejectedValue(new Error("response lost"));
    h.get.mockImplementation(async (id: string) => {
      if (id === "publication-rec-run-1") return { status: vi.fn().mockResolvedValue({ status: "errored" }) };
      if (verifierStatus === "unavailable") throw new Error("unavailable");
      if (verifierStatus === "missing") throw new Error("instance.not_found");
      return { status: vi.fn().mockResolvedValue({ status: verifierStatus }) };
    });
    const expected = { status: verifierStatus === "running" ? "checking" : "owner_review", publicationRunId: "rec-run-1" };
    expect(await handleDocsTrigger(h.env, "line", clock, undefined, fetch, context)).toEqual(expected);
    const saved = await h.env.DB.prepare("SELECT verifier_id FROM publication_verification_claims WHERE publication_run_id = ?").bind("rec-run-1").first<{ verifier_id: string }>();
    expect(saved?.verifier_id).toBe(h.create.mock.calls[0]![0].id);
    expect(h.get).toHaveBeenLastCalledWith(saved!.verifier_id);
    expect(await handleDocsTrigger(h.env, "line", clock, undefined, fetch, context)).toEqual(expected);
    expect(h.get).toHaveBeenLastCalledWith(saved!.verifier_id);
    expect(await handleDocsTrigger(h.env, "line", clock, undefined, fetch, { ...context, replyGroupId: "other" })).toEqual({ status: "busy" });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.restart).not.toHaveBeenCalled();
    await h.env.DB.exec("DELETE FROM publication_verification_claims WHERE publication_run_id = 'rec-run-1'");
  });

  it.each(["errored", "terminated"])("renews a stopped verifier (%s) once and fences its late completion", async (stopped) => {
    mockRun("Generating");
    const h = makeTriggerEnv("errored");
    const { captureOperationContext } = await import("../../src/settings/runtime");
    const { savePublicationAttemptContext } = await import("../../src/db/execution-context-repository");
    const { completePublicationVerification } = await import("../../src/db/publication-repository");
    const context = { ...await captureOperationContext(h.env, null), replyGroupId: "owner" };
    await acquireOrResumeJob(h.env.DB, clock, "rec-run-1", "publication-rec-run-1");
    await savePublicationAttemptContext(h.env.DB, "rec-run-1", 1, context);
    await handleDocsTrigger(h.env, "line", clock, undefined, fetch, context);
    const oldId = h.create.mock.calls[0]![0].id;
    h.get.mockImplementation(async (id: string) => ({ status: vi.fn().mockResolvedValue({ status: id === oldId ? stopped : id === "publication-rec-run-1" ? "errored" : "running" }) }));
    const results = await Promise.all([1, 2].map(() => handleDocsTrigger(h.env, "line", clock, undefined, fetch, context)));
    expect(results.some(result => result.status === "checking")).toBe(true);
    expect(h.create).toHaveBeenCalledTimes(2);
    const newId = h.create.mock.calls[1]![0].id;
    expect(newId).not.toBe(oldId);
    expect(h.create.mock.calls[1]![0].params).toMatchObject({ kind: "verification", verifierId: newId });
    expect(await completePublicationVerification(h.env.DB, { runId: "rec-run-1", generation: 1, notificationCycle: 1, groupId: "owner" }, oldId)).toBe(false);
    expect(h.restart).not.toHaveBeenCalled();
    await h.env.DB.exec("DELETE FROM publication_verification_claims WHERE publication_run_id = 'rec-run-1'");
  });

  it("dispatches one verifier for the owner of a stopped Generating attempt", async () => {
    mockRun("Generating");
    const h = makeTriggerEnv("errored");
    const { captureOperationContext } = await import("../../src/settings/runtime");
    const { savePublicationAttemptContext } = await import("../../src/db/execution-context-repository");
    const { createWorkflowFeedbackRepository } = await import("../../src/db/workflow-feedback");
    const context = { ...await captureOperationContext(h.env, null), replyGroupId: "owner" };
    await acquireOrResumeJob(h.env.DB, clock, "rec-run-1", "publication-rec-run-1");
    await savePublicationAttemptContext(h.env.DB, "rec-run-1", 1, context);
    await setJobState(h.env.DB, clock, "rec-run-1", "failed");
    const attempt = { kind: "publication" as const, runId: "rec-run-1", generation: 1, notificationCycle: 1, groupId: "owner" };
    expect(await createWorkflowFeedbackRepository(h.env.DB).commitOutcome(attempt, { stage: "failed", action: "review", outcome: "failed", resultKey: "stale-test" })).toBe(true);
    expect(await handleDocsTrigger(h.env, "line", clock, undefined, fetch, context)).toEqual({ status: "checking", publicationRunId: "rec-run-1" });
    const verifierId = h.create.mock.calls[0]![0].id;
    expect(h.create).toHaveBeenCalledWith({ id: verifierId, params: { kind: "verification", publicationRunId: "rec-run-1", generation: 1, notificationCycle: 1, groupId: "owner", verifierId } });
    h.get.mockImplementation(async (id: string) => ({ status: vi.fn().mockResolvedValue({ status: id === verifierId ? "running" : "errored" }) }));
    expect(await handleDocsTrigger(h.env, "line", clock, undefined, fetch, context)).toEqual({ status: "checking", publicationRunId: "rec-run-1" });
    expect(await handleDocsTrigger(h.env, "line", clock, undefined, fetch, { ...context, replyGroupId: "other" })).toEqual({ status: "busy" });
    h.get.mockResolvedValue({ status: h.status, restart: h.restart, resume: h.resume });
    h.status.mockResolvedValue({ status: "running" });
    expect(await handleDocsTrigger(h.env, "line", clock, undefined, fetch, context)).toEqual({ status: "already_running", publicationRunId: "rec-run-1" });
    h.status.mockRejectedValue(new Error("unavailable"));
    expect(await handleDocsTrigger(h.env, "line", clock, undefined, fetch, context)).toEqual({ status: "owner_review", publicationRunId: "rec-run-1" });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.restart).not.toHaveBeenCalled();
    await h.env.DB.exec("DELETE FROM publication_verification_claims WHERE publication_run_id = 'rec-run-1'");
    await h.env.DB.exec("DELETE FROM workflow_feedback_results WHERE result_key = 'stale-test'");
    await h.env.DB.exec("DELETE FROM workflow_feedback WHERE run_id = 'rec-run-1'");
  });

  it("does not restart a job that succeeds while Workflow status is being read", async () => {
    mockRun("Failed");
    const fixture = makeTriggerEnv("errored");
    await acquireOrResumeJob(
      fixture.env.DB,
      clock,
      "rec-run-1",
      "previous-owner",
    );
    await setJobState(fixture.env.DB, clock, "rec-run-1", "failed");
    fixture.status.mockImplementation(async () => {
      await reopenFailedJobForRestart(
        fixture.env.DB,
        clock,
        "rec-run-1",
        "publication-rec-run-1",
      );
      await setJobState(fixture.env.DB, clock, "rec-run-1", "succeeded", {
        googleDocId: "final-doc",
        googleDocUrl: "https://docs.google.com/document/d/final-doc/edit",
      });
      return { status: "errored" };
    });

    await expect(
      handleDocsTrigger(fixture.env, "admin", clock),
    ).resolves.toEqual({
      status: "already_generated",
      publicationRunId: "rec-run-1",
    });
    expect(fixture.restart).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it.each(["queued", "running", "waiting", "waitingForPause"])(
    "returns already_running for %s without reopening a failed job",
    async (statusValue) => {
      mockRun("Failed");
      const fixture = makeTriggerEnv(statusValue);
      await acquireOrResumeJob(
        fixture.env.DB,
        clock,
        "rec-run-1",
        "previous-owner",
      );
      await setJobState(fixture.env.DB, clock, "rec-run-1", "failed");

      await expect(
        handleDocsTrigger(fixture.env, "cron", clock),
      ).resolves.toEqual({
        status: "already_running",
        publicationRunId: "rec-run-1",
      });

      expect(fixture.create).not.toHaveBeenCalled();
      expect(fixture.restart).not.toHaveBeenCalled();
      expect(fixture.resume).not.toHaveBeenCalled();
      expect(
        (await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other"))
          .job,
      ).toMatchObject({ state: "failed", correlationId: "previous-owner" });
    },
  );

  it("resumes a paused instance without reopening the job or creating a duplicate", async () => {
    mockRun("Failed");
    const fixture = makeTriggerEnv("paused");
    await acquireOrResumeJob(
      fixture.env.DB,
      clock,
      "rec-run-1",
      "previous-owner",
    );
    await setJobState(fixture.env.DB, clock, "rec-run-1", "failed");

    await expect(
      handleDocsTrigger(fixture.env, "line", clock),
    ).resolves.toEqual({ status: "resumed", publicationRunId: "rec-run-1" });

    expect(fixture.resume).toHaveBeenCalledTimes(1);
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.restart).not.toHaveBeenCalled();
    expect(
      (await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other"))
        .job.state,
    ).toBe("failed");
  });

  it("restarts a complete instance after staff corrects validation and marks the run Ready", async () => {
    mockRun("Ready");
    const fixture = makeTriggerEnv("complete");
    await acquireOrResumeJob(
      fixture.env.DB,
      clock,
      "rec-run-1",
      "publication-rec-run-1",
    );
    await setJobState(fixture.env.DB, clock, "rec-run-1", "validation_failed");

    await expect(
      handleDocsTrigger(fixture.env, "admin", clock),
    ).resolves.toEqual({ status: "restarted", publicationRunId: "rec-run-1" });

    expect(fixture.restart).toHaveBeenCalledTimes(1);
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("returns already_generated from D1 without changing the completed Workflow or document", async () => {
    mockRun();
    const fixture = makeTriggerEnv("complete");
    await acquireOrResumeJob(
      fixture.env.DB,
      clock,
      "rec-run-1",
      "publication-rec-run-1",
    );
    await setJobState(fixture.env.DB, clock, "rec-run-1", "succeeded", {
      googleDocId: "doc-1",
      googleDocUrl: "https://docs.google.com/document/d/doc-1/edit",
    });

    await expect(
      handleDocsTrigger(fixture.env, "admin", clock),
    ).resolves.toEqual({
      status: "already_generated",
      publicationRunId: "rec-run-1",
    });

    expect(fixture.get).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
    expect(
      (await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other"))
        .job,
    ).toMatchObject({
      state: "succeeded",
      googleDocId: "doc-1",
      googleDocUrl: "https://docs.google.com/document/d/doc-1/edit",
    });
  });

  it("returns no_runnable_run when today's Bangkok date has no eligible run", async () => {
    mockRun(null);
    const fixture = makeTriggerEnv("unknown");

    await expect(
      handleDocsTrigger(fixture.env, "admin", clock),
    ).resolves.toEqual({ status: "no_runnable_run" });
    expect(fixture.get).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it.each(["queued", "running", "waiting", "waitingForPause"])(
    "recognizes a raced create after awaiting the %s instance lookup",
    async (statusValue) => {
      mockRun();
      const fixture = makeTriggerEnv(statusValue);
      fixture.status.mockResolvedValueOnce({ status: "unknown" });
      fixture.create.mockRejectedValueOnce(new Error("duplicate Workflow ID"));

      await expect(
        handleDocsTrigger(fixture.env, "admin", clock),
      ).resolves.toEqual({
        status: "already_running",
        publicationRunId: "rec-run-1",
      });

      expect(fixture.get).toHaveBeenCalledTimes(2);
      expect(fixture.get).toHaveBeenNthCalledWith(2, "publication-rec-run-1");
      expect(fixture.create).toHaveBeenCalledTimes(1);
      expect(fixture.restart).not.toHaveBeenCalled();
    },
  );

  it("leaves failed jobs closed when the Workflow status is unsupported", async () => {
    mockRun("Failed");
    const fixture = makeTriggerEnv("unrecognized-status");
    await acquireOrResumeJob(
      fixture.env.DB,
      clock,
      "rec-run-1",
      "previous-owner",
    );
    await setJobState(fixture.env.DB, clock, "rec-run-1", "failed");

    await expect(
      handleDocsTrigger(fixture.env, "admin", clock),
    ).rejects.toThrow(/^unsupported_publication_workflow_status$/);
    expect(
      (await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other"))
        .job.state,
    ).toBe("failed");
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.restart).not.toHaveBeenCalled();
  });
});
it('allocates a new notification cycle when retrying an errored generating job with an unconfirmed notice',async()=>{
 vi.restoreAllMocks();mockRun('Ready');const h=makeTriggerEnv('errored');
 const {readPublicationJob}=await import('../../src/db/publication-repository');
 const {createLineReplyRepository}=await import('../../src/db/line-reply-repository');
 await h.env.DB.exec('DELETE FROM publication_product_cache');await h.env.DB.exec('DELETE FROM publication_jobs');
 await acquireOrResumeJob(h.env.DB,clock,'rec-run-1','publication-rec-run-1');
 const {savePublicationAttemptContext}=await import('../../src/db/execution-context-repository');
 const {captureOperationContext}=await import('../../src/settings/runtime');
 await savePublicationAttemptContext(h.env.DB,'rec-run-1',1,await captureOperationContext(h.env,null));
 await setJobState(h.env.DB,clock,'rec-run-1','generating',{tempDocId:'preserve-this-doc'});
 const group=crypto.randomUUID();const repo=createLineReplyRepository(h.env.DB,clock);
 await repo.enqueueResult({groupId:group,resultKey:JSON.stringify(['publication','rec-run-1',1,1,'terminal']),result:{schemaVersion:1,kind:'publication',runId:'rec-run-1',generation:1,notificationCycle:1,outcome:'unconfirmed',messages:[{type:'text',text:'inspect first'}]}});
 await handleDocsTrigger(h.env,'line',clock);
 expect((await readPublicationJob(h.env.DB,'rec-run-1'))).toMatchObject({notificationCycle:2,tempDocId:'preserve-this-doc',state:'generating'});
 expect(h.restart).toHaveBeenCalledTimes(1);
 await repo.enqueueResult({groupId:group,resultKey:JSON.stringify(['publication','rec-run-1',1,2,'terminal']),result:{schemaVersion:1,kind:'publication',runId:'rec-run-1',generation:1,notificationCycle:2,outcome:'success',messages:[{type:'text',text:'finished'}]}});
 expect((await repo.head(group))?.result.outcome).toBe('unconfirmed');
});

it('replays the bound regeneration without selecting a replacement Ready run', async () => {
  vi.restoreAllMocks();
  const fetchMock = mockRun('Ready');
  const h = makeTriggerEnv('complete');
  await h.env.DB.exec('DELETE FROM publication_regeneration_events');
  await h.env.DB.exec('DELETE FROM line_command_ingress');
  await h.env.DB.exec('DELETE FROM publication_jobs');
  await acquireOrResumeJob(h.env.DB, clock, 'rec-run-1', 'publication-rec-run-1');
  await setJobState(h.env.DB, clock, 'rec-run-1', 'succeeded');
  const { captureOperationContext } = await import('../../src/settings/runtime');
  const context = await captureOperationContext(h.env, 'group-1');
  await h.env.DB.prepare('INSERT INTO line_command_ingress VALUES (?, ?, ?, ?, ?)').bind('event-1', 'group-1', JSON.stringify({type:'docs'}), 'command-1', clock.now().toISOString()).run();
  h.get.mockImplementation(async (id: string) => {
    if (id.endsWith('-v2')) throw new Error('instance.not_found');
    return {status:h.status, restart:h.restart, resume:h.resume};
  });
  const first = await handleDocsTrigger(h.env, 'line', clock, undefined, fetch, context, 'event-1');
  fetchMock.mockClear();
  fetchMock.mockResolvedValue(Response.json({records:[{id:'replacement', fields:{'Publication Date':'2026-09-02', Status:'Ready', Products:[]}}]}));
  expect(await handleDocsTrigger(h.env, 'line', clock, undefined, fetch, context, 'event-1')).toEqual(first);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(h.create).toHaveBeenCalledTimes(1);
});

it('holds an interrupted bound handoff and rejects mismatched origin', async () => {
  vi.restoreAllMocks();
  const h = makeTriggerEnv('running');
  await h.env.DB.exec('DELETE FROM publication_regeneration_events');
  await h.env.DB.exec('DELETE FROM line_command_ingress');
  await h.env.DB.prepare('INSERT INTO line_command_ingress VALUES (?, ?, ?, ?, ?)').bind('event-hold', 'group-1', JSON.stringify({type:'docs'}), 'command-1', clock.now().toISOString()).run();
  await h.env.DB.prepare("INSERT INTO publication_regeneration_events (event_id, publication_run_id, generation, notification_cycle, workflow_id, action, job_json) VALUES (?, ?, ?, ?, ?, ?, ?)").bind('event-hold','original',2,1,'original-v2','regenerate','{}').run();
  const { captureOperationContext } = await import('../../src/settings/runtime');
  const context = await captureOperationContext(h.env, 'group-1');
  expect(await handleDocsTrigger(h.env,'line',clock,undefined,fetch,context,'event-hold')).toEqual({status:'already_running',publicationRunId:'original'});
  h.get.mockRejectedValue(new Error('instance.not_found'));
  await expect(handleDocsTrigger(h.env,'line',clock,undefined,fetch,context,'event-hold')).rejects.toThrow('publication_handoff_unconfirmed');
  h.get.mockRejectedValue(new Error('lookup unavailable'));
  await expect(handleDocsTrigger(h.env,'line',clock,undefined,fetch,context,'event-hold')).rejects.toThrow('lookup unavailable');
  await expect(handleDocsTrigger(h.env,'line',clock,undefined,fetch,{...context,replyGroupId:'other'},'event-hold')).rejects.toThrow('publication_event_identity_mismatch');
  await expect(handleDocsTrigger(h.env,'line',clock,'2026-09-03',fetch,context,'event-hold')).rejects.toThrow('publication_event_identity_mismatch');
  expect(h.create).not.toHaveBeenCalled();
});

it('binds an initial LINE create before creation and replays the original run', async () => {
  vi.restoreAllMocks();
  const fetchMock = mockRun('Ready');
  const h = makeTriggerEnv('running');
  await h.env.DB.exec('DELETE FROM publication_regeneration_events');
  await h.env.DB.exec('DELETE FROM line_command_ingress');
  await h.env.DB.exec('DELETE FROM publication_jobs');
  await h.env.DB.prepare('INSERT INTO line_command_ingress VALUES (?, ?, ?, ?, ?)').bind('initial-event', 'group-1', JSON.stringify({type:'docs'}), 'command-1', clock.now().toISOString()).run();
  const { captureOperationContext } = await import('../../src/settings/runtime');
  const context = await captureOperationContext(h.env, 'group-1');
  h.get.mockRejectedValueOnce(new Error('instance.not_found'));
  expect(await handleDocsTrigger(h.env, 'line', clock, undefined, fetch, context, 'initial-event')).toEqual({status:'started', publicationRunId:'rec-run-1'});
  fetchMock.mockClear();
  expect(await handleDocsTrigger(h.env, 'line', clock, undefined, fetch, context, 'initial-event')).toEqual({status:'started', publicationRunId:'rec-run-1'});
  expect(fetchMock).not.toHaveBeenCalled();
  expect(h.create).toHaveBeenCalledTimes(1);
});

it('holds an ambiguous initial create and distinguishes unavailable lookup from missing', async () => {
  vi.restoreAllMocks();
  mockRun('Ready');
  const h = makeTriggerEnv('running');
  await h.env.DB.exec('DELETE FROM publication_regeneration_events');
  await h.env.DB.exec('DELETE FROM line_command_ingress');
  await h.env.DB.exec('DELETE FROM publication_jobs');
  await h.env.DB.prepare('INSERT INTO line_command_ingress VALUES (?, ?, ?, ?, ?)').bind('ambiguous-event', 'group-1', JSON.stringify({type:'docs'}), 'command-1', clock.now().toISOString()).run();
  const { captureOperationContext } = await import('../../src/settings/runtime');
  const context = await captureOperationContext(h.env, 'group-1');
  h.get.mockRejectedValueOnce(new Error('instance.not_found')).mockRejectedValueOnce(new Error('lookup unavailable'));
  h.create.mockRejectedValueOnce(new Error('timeout'));
  await expect(handleDocsTrigger(h.env, 'line', clock, undefined, fetch, context, 'ambiguous-event')).rejects.toThrow('lookup unavailable');
  h.get.mockRejectedValueOnce(new Error('instance.not_found'));
  await expect(handleDocsTrigger(h.env, 'line', clock, undefined, fetch, context, 'ambiguous-event')).rejects.toThrow('publication_handoff_unconfirmed');
  await expect(handleDocsTrigger(h.env, 'line', clock, undefined, fetch, {...context, replyGroupId:'other'}, 'ambiguous-event')).rejects.toThrow('publication_event_identity_mismatch');
  expect(h.create).toHaveBeenCalledTimes(1);
});

it('holds an ambiguous failed-job restart on replay without selecting a new Ready run', async () => {
  vi.restoreAllMocks();
  const fetchMock = mockRun('Ready');
  const h = makeTriggerEnv('errored');
  await h.env.DB.exec('DELETE FROM publication_regeneration_events');
  await h.env.DB.exec('DELETE FROM line_command_ingress');
  await h.env.DB.exec('DELETE FROM publication_jobs');
  await acquireOrResumeJob(h.env.DB, clock, 'rec-run-1', 'publication-rec-run-1');
  await setJobState(h.env.DB, clock, 'rec-run-1', 'failed');
  await h.env.DB.prepare('INSERT INTO line_command_ingress VALUES (?, ?, ?, ?, ?)').bind('restart-event', 'group-1', JSON.stringify({type:'docs'}), 'command-1', clock.now().toISOString()).run();
  const { captureOperationContext } = await import('../../src/settings/runtime');
  const context = await captureOperationContext(h.env, 'group-1');
  h.restart.mockRejectedValueOnce(new Error('restart timeout'));
  await expect(handleDocsTrigger(h.env, 'line', clock, undefined, fetch, context, 'restart-event')).rejects.toThrow('restart timeout');
  fetchMock.mockClear();
  fetchMock.mockResolvedValue(Response.json({records:[{id:'replacement', fields:{'Publication Date':'2026-09-02', Status:'Ready', Products:[]}}]}));
  await expect(handleDocsTrigger(h.env, 'line', clock, undefined, fetch, context, 'restart-event')).rejects.toThrow('publication_handoff_unconfirmed');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(h.restart).toHaveBeenCalledTimes(1);
});
