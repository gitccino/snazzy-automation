import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import type { PublicationRunStatus } from "../../src/publication/types";
import { handleDocsTrigger } from "../../src/publication/trigger";
import {
  acquireOrResumeJob, getProductCache, putProductCaptions, putProductCollage,
  reopenFailedJobForRestart, setJobState,
} from "../../src/db/publication-repository";
import { createTestEnv, testEnv } from "../helpers/env";

const clock = { now: () => new Date("2026-09-01T17:30:00.000Z") };

function mockRun(status: PublicationRunStatus | null = "Ready") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
    records: status === null ? [] : [{
      id: "rec-run-1",
      fields: { "Publication Date": "2026-09-02", Status: status, Products: [] },
    }],
  }));
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

  it.each(["admin", "line", "cron"] as const)("creates only an unknown instance with its hyphenated ID and %s trigger", async (trigger) => {
    const fetcher = mockRun();
    const fixture = makeTriggerEnv("unknown");

    await expect(handleDocsTrigger(fixture.env, trigger, clock)).resolves.toEqual({
      status: "started", publicationRunId: "rec-run-1",
    });

    expect(fixture.get).toHaveBeenCalledExactlyOnceWith("publication-rec-run-1");
    expect(fixture.status).toHaveBeenCalledTimes(1);
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith({
      id: "publication-rec-run-1",
      params: { publicationRunId: "rec-run-1", trigger },
    });
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get("filterByFormula")).toBe("DATESTR({Publication Date})='2026-09-02'");
    expect(fixture.restart).not.toHaveBeenCalled();
    expect(fixture.resume).not.toHaveBeenCalled();
  });

  it("starts a missing instance when the real Workflow binding rejects its lookup", async () => {
    mockRun();
    const fixture = makeTriggerEnv("unknown");
    fixture.get.mockImplementation((id: string) => testEnv().PUBLICATION_WORKFLOW.get(id));

    await expect(handleDocsTrigger(fixture.env, "admin", clock)).resolves.toEqual({
      status: "started", publicationRunId: "rec-run-1",
    });

    expect(fixture.create).toHaveBeenCalledExactlyOnceWith({
      id: "publication-rec-run-1",
      params: { publicationRunId: "rec-run-1", trigger: "admin" },
    });
  });

  it("recognizes Cloudflare's wrapped instance-not-found error", async () => {
    mockRun();
    const fixture = makeTriggerEnv("unknown");
    fixture.get.mockRejectedValueOnce(new Error("(instance.not_found) Instance not found"));
    await expect(handleDocsTrigger(fixture.env, "admin", clock)).resolves.toEqual({
      status: "started", publicationRunId: "rec-run-1",
    });
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith({
      id: "publication-rec-run-1",
      params: { publicationRunId: "rec-run-1", trigger: "admin" },
    });
  });

  it("does not create or reopen a failed job when the instance lookup fails for another reason", async () => {
    mockRun("Failed");
    const fixture = makeTriggerEnv("unknown");
    await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "previous-owner");
    await setJobState(fixture.env.DB, clock, "rec-run-1", "failed");
    fixture.get.mockRejectedValueOnce(new Error("Workflow lookup unavailable"));

    await expect(handleDocsTrigger(fixture.env, "admin", clock)).rejects.toThrow("Workflow lookup unavailable");

    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.restart).not.toHaveBeenCalled();
    expect((await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other")).job.state).toBe("failed");
  });

  it.each(["errored", "terminated", "complete", "unknown"])("reopens a failed job with its cached products before the %s Workflow is started again", async (statusValue) => {
    mockRun("Failed");
    const fixture = makeTriggerEnv(statusValue);
    await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "previous-owner");
    await putProductCollage(fixture.env.DB, clock, "rec-run-1", "A-1001", "products/A-1001/collage/1080x1080.jpg", "collage-input");
    await putProductCaptions(fixture.env.DB, clock, "rec-run-1", "A-1001", '["หนึ่ง","สอง","สาม"]', "caption-input");
    await setJobState(fixture.env.DB, clock, "rec-run-1", "failed");
    fixture.status.mockImplementation(async () => {
      expect((await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other")).job.state).toBe("failed");
      return { status: statusValue };
    });
    const start = statusValue === "unknown" ? fixture.create : fixture.restart;
    start.mockImplementation(async () => {
      const { job } = await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other");
      expect(job).toMatchObject({ state: "locked", correlationId: "publication-rec-run-1" });
      expect(await getProductCache(fixture.env.DB, "rec-run-1", "A-1001")).toEqual({
        collageR2Key: "products/A-1001/collage/1080x1080.jpg",
        captionsJson: '["หนึ่ง","สอง","สาม"]',
        collageInputFingerprint: "collage-input", captionsInputFingerprint: "caption-input",
      });
    });

    await expect(handleDocsTrigger(fixture.env, "admin", clock)).resolves.toEqual({
      status: statusValue === "unknown" ? "started" : "restarted", publicationRunId: "rec-run-1",
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(statusValue === "unknown" ? fixture.restart : fixture.create).not.toHaveBeenCalled();
  });

  it("keeps a reopened failed job and its cache resumable if recreating an expired Workflow fails", async () => {
    mockRun("Failed");
    const fixture = makeTriggerEnv("unknown");
    fixture.get.mockRejectedValue(new Error("instance.not_found"));
    await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "previous-owner");
    await putProductCollage(fixture.env.DB, clock, "rec-run-1", "A-1001", "products/A-1001/collage/1080x1080.jpg", "collage-input");
    await putProductCaptions(fixture.env.DB, clock, "rec-run-1", "A-1001", '["หนึ่ง","สอง","สาม"]', "caption-input");
    await setJobState(fixture.env.DB, clock, "rec-run-1", "failed");
    fixture.create.mockRejectedValueOnce(new Error("Workflow creation unavailable"));

    await expect(handleDocsTrigger(fixture.env, "admin", clock)).rejects.toThrow("Workflow creation unavailable");
    expect((await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other")).job).toMatchObject({
      state: "locked", correlationId: "publication-rec-run-1",
    });
    expect(await getProductCache(fixture.env.DB, "rec-run-1", "A-1001")).toEqual({
      collageR2Key: "products/A-1001/collage/1080x1080.jpg", captionsJson: '["หนึ่ง","สอง","สาม"]',
      collageInputFingerprint: "collage-input", captionsInputFingerprint: "caption-input",
    });

    await expect(handleDocsTrigger(fixture.env, "admin", clock)).resolves.toEqual({
      status: "started", publicationRunId: "rec-run-1",
    });
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.create.mock.calls.every(([options]) => options.id === "publication-rec-run-1")).toBe(true);
    expect(await getProductCache(fixture.env.DB, "rec-run-1", "A-1001")).toEqual({
      collageR2Key: "products/A-1001/collage/1080x1080.jpg", captionsJson: '["หนึ่ง","สอง","สาม"]',
      collageInputFingerprint: "collage-input", captionsInputFingerprint: "caption-input",
    });
  });

  it.each(["Draft", "Generating", "Generated"] as const)("does not reopen or start a run returned with ineligible %s status", async (runStatus) => {
    mockRun(runStatus);
    const fixture = makeTriggerEnv("errored");
    await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "previous-owner");
    await setJobState(fixture.env.DB, clock, "rec-run-1", "failed");

    await expect(handleDocsTrigger(fixture.env, "admin", clock)).resolves.toEqual({ status: "no_runnable_run" });

    expect(fixture.get).not.toHaveBeenCalled();
    expect((await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other")).job.state).toBe("failed");
  });

  it("does not restart a job that succeeds while Workflow status is being read", async () => {
    mockRun("Failed");
    const fixture = makeTriggerEnv("errored");
    await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "previous-owner");
    await setJobState(fixture.env.DB, clock, "rec-run-1", "failed");
    fixture.status.mockImplementation(async () => {
      await reopenFailedJobForRestart(fixture.env.DB, clock, "rec-run-1", "publication-rec-run-1");
      await setJobState(fixture.env.DB, clock, "rec-run-1", "succeeded", { googleDocId: "final-doc", googleDocUrl: "https://docs.google.com/document/d/final-doc/edit" });
      return { status: "errored" };
    });

    await expect(handleDocsTrigger(fixture.env, "admin", clock)).resolves.toEqual({ status: "already_generated", publicationRunId: "rec-run-1" });
    expect(fixture.restart).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it.each(["queued", "running", "waiting", "waitingForPause"])("returns already_running for %s without reopening a failed job", async (statusValue) => {
    mockRun("Failed");
    const fixture = makeTriggerEnv(statusValue);
    await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "previous-owner");
    await setJobState(fixture.env.DB, clock, "rec-run-1", "failed");

    await expect(handleDocsTrigger(fixture.env, "cron", clock)).resolves.toEqual({ status: "already_running", publicationRunId: "rec-run-1" });

    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.restart).not.toHaveBeenCalled();
    expect(fixture.resume).not.toHaveBeenCalled();
    expect((await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other")).job).toMatchObject({ state: "failed", correlationId: "previous-owner" });
  });

  it("resumes a paused instance without reopening the job or creating a duplicate", async () => {
    mockRun("Failed");
    const fixture = makeTriggerEnv("paused");
    await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "previous-owner");
    await setJobState(fixture.env.DB, clock, "rec-run-1", "failed");

    await expect(handleDocsTrigger(fixture.env, "line", clock)).resolves.toEqual({ status: "resumed", publicationRunId: "rec-run-1" });

    expect(fixture.resume).toHaveBeenCalledTimes(1);
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.restart).not.toHaveBeenCalled();
    expect((await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other")).job.state).toBe("failed");
  });

  it("restarts a complete instance after staff corrects validation and marks the run Ready", async () => {
    mockRun("Ready");
    const fixture = makeTriggerEnv("complete");
    await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "publication-rec-run-1");
    await setJobState(fixture.env.DB, clock, "rec-run-1", "validation_failed");

    await expect(handleDocsTrigger(fixture.env, "admin", clock)).resolves.toEqual({ status: "restarted", publicationRunId: "rec-run-1" });

    expect(fixture.restart).toHaveBeenCalledTimes(1);
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("returns already_generated from D1 without changing the completed Workflow or document", async () => {
    mockRun();
    const fixture = makeTriggerEnv("complete");
    await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "publication-rec-run-1");
    await setJobState(fixture.env.DB, clock, "rec-run-1", "succeeded", {
      googleDocId: "doc-1", googleDocUrl: "https://docs.google.com/document/d/doc-1/edit",
    });

    await expect(handleDocsTrigger(fixture.env, "admin", clock)).resolves.toEqual({ status: "already_generated", publicationRunId: "rec-run-1" });

    expect(fixture.get).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
    expect((await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other")).job).toMatchObject({
      state: "succeeded", googleDocId: "doc-1", googleDocUrl: "https://docs.google.com/document/d/doc-1/edit",
    });
  });

  it("returns no_runnable_run when today's Bangkok date has no eligible run", async () => {
    mockRun(null);
    const fixture = makeTriggerEnv("unknown");

    await expect(handleDocsTrigger(fixture.env, "admin", clock)).resolves.toEqual({ status: "no_runnable_run" });
    expect(fixture.get).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it.each(["queued", "running", "waiting", "waitingForPause"])("recognizes a raced create after awaiting the %s instance lookup", async (statusValue) => {
    mockRun();
    const fixture = makeTriggerEnv(statusValue);
    fixture.status.mockResolvedValueOnce({ status: "unknown" });
    fixture.create.mockRejectedValueOnce(new Error("duplicate Workflow ID"));

    await expect(handleDocsTrigger(fixture.env, "admin", clock)).resolves.toEqual({ status: "already_running", publicationRunId: "rec-run-1" });

    expect(fixture.get).toHaveBeenCalledTimes(2);
    expect(fixture.get).toHaveBeenNthCalledWith(2, "publication-rec-run-1");
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.restart).not.toHaveBeenCalled();
  });

  it("leaves failed jobs closed when the Workflow status is unsupported", async () => {
    mockRun("Failed");
    const fixture = makeTriggerEnv("unrecognized-status");
    await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "previous-owner");
    await setJobState(fixture.env.DB, clock, "rec-run-1", "failed");

    await expect(handleDocsTrigger(fixture.env, "admin", clock)).rejects.toThrow(/^unsupported_publication_workflow_status$/);
    expect((await acquireOrResumeJob(fixture.env.DB, clock, "rec-run-1", "other")).job.state).toBe("failed");
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.restart).not.toHaveBeenCalled();
  });
});
