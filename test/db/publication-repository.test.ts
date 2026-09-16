import { describe, expect, it, beforeEach } from "vitest";
import { testEnv } from "../helpers/env";
import {
  acquireOrResumeJob,
  reopenFailedJobForRestart,
  setJobState,
  incrementAttempt,
  setTempDocId,
  getProductCache,
  putProductCollage,
  putProductCaptions,
} from "../../src/db/publication-repository";

const clock = { now: () => new Date("2026-09-01T05:00:00.000Z") };
const env = testEnv();

describe("publication-repository", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM publication_product_cache");
    await env.DB.exec("DELETE FROM publication_jobs");
  });

  it("acquires a new job on first call", async () => {
    const { job, alreadySucceeded } = await acquireOrResumeJob(env.DB, clock, "run-1", "corr-1");
    expect(job.state).toBe("locked");
    expect(job.attemptCount).toBe(0);
    expect(alreadySucceeded).toBe(false);
  });

  it("resumes the same job row on a second acquire without duplicating it", async () => {
    await acquireOrResumeJob(env.DB, clock, "run-1", "corr-1");
    const { job } = await acquireOrResumeJob(env.DB, clock, "run-1", "corr-2");
    const rows = await env.DB.prepare("SELECT COUNT(*) as n FROM publication_jobs WHERE publication_run_id = ?")
      .bind("run-1")
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    expect(job.publicationRunId).toBe("run-1");
  });

  it("gives ownership to only one concurrent acquirer", async () => {
    const acquisitions = await Promise.all([
      acquireOrResumeJob(env.DB, clock, "run-concurrent", "corr-a"),
      acquireOrResumeJob(env.DB, clock, "run-concurrent", "corr-b"),
    ]);
    expect(acquisitions.filter((result) => result.ownsLock)).toHaveLength(1);
    expect(acquisitions.filter((result) => !result.ownsLock)).toHaveLength(1);
  });

  it("reports alreadySucceeded true and refuses to reset a succeeded job", async () => {
    await acquireOrResumeJob(env.DB, clock, "run-1", "corr-1");
    await setJobState(env.DB, clock, "run-1", "succeeded", { googleDocId: "doc-1", googleDocUrl: "https://docs.google.com/doc-1" });
    const { job, alreadySucceeded } = await acquireOrResumeJob(env.DB, clock, "run-1", "corr-3");
    expect(alreadySucceeded).toBe(true);
    expect(job.googleDocId).toBe("doc-1");
  });

  it("refuses terminal-state rewrites and preserves final document fields", async () => {
    await acquireOrResumeJob(env.DB, clock, "run-terminal", "corr-1");
    await setJobState(env.DB, clock, "run-terminal", "succeeded", {
      googleDocId: "doc-final",
      googleDocUrl: "https://docs.google.com/doc-final",
    });
    await setJobState(env.DB, clock, "run-terminal", "failed", {
      googleDocId: "doc-stale",
      googleDocUrl: "https://docs.google.com/doc-stale",
    });
    const { job } = await acquireOrResumeJob(env.DB, clock, "run-terminal", "corr-2");
    expect(job.state).toBe("succeeded");
    expect(job.googleDocId).toBe("doc-final");
    expect(job.googleDocUrl).toBe("https://docs.google.com/doc-final");
  });

  it("explicitly reopens a failed job for restart while retaining cached products", async () => {
    await acquireOrResumeJob(env.DB, clock, "run-restart", "old-correlation");
    await putProductCollage(env.DB, clock, "run-restart", "A-1001", "products/A-1001/collage/1080x1080.jpg");
    await putProductCaptions(env.DB, clock, "run-restart", "A-1001", '["หนึ่ง","สอง","สาม"]');
    await setJobState(env.DB, clock, "run-restart", "failed");
    await setJobState(env.DB, clock, "run-restart", "validating");
    expect((await acquireOrResumeJob(env.DB, clock, "run-restart", "other")).job.state).toBe("failed");

    const restartedAt = { now: () => new Date("2026-09-02T05:00:00.000Z") };
    expect(await reopenFailedJobForRestart(env.DB, restartedAt, "run-restart", "publication-run-restart")).toBe(true);

    const { job } = await acquireOrResumeJob(env.DB, restartedAt, "run-restart", "other");
    expect(job).toMatchObject({
      state: "locked",
      correlationId: "publication-run-restart",
      createdAt: "2026-09-01T05:00:00.000Z",
      updatedAt: "2026-09-02T05:00:00.000Z",
    });
    expect(await getProductCache(env.DB, "run-restart", "A-1001")).toEqual({
      collageR2Key: "products/A-1001/collage/1080x1080.jpg",
      captionsJson: '["หนึ่ง","สอง","สาม"]',
    });
  });

  it.each(["locked", "validating", "validation_failed", "generating", "succeeded"] as const)(
    "does not reopen or mutate a %s job through the failed-job restart helper",
    async (state) => {
      await acquireOrResumeJob(env.DB, clock, "run-guard", "original-owner");
      await setJobState(env.DB, clock, "run-guard", state, {
        googleDocId: "doc-preserved",
        googleDocUrl: "https://docs.google.com/document/d/doc-preserved/edit",
      });
      const before = await acquireOrResumeJob(env.DB, clock, "run-guard", "other");

      expect(await reopenFailedJobForRestart(env.DB, clock, "run-guard", "publication-run-guard")).toBe(false);
      expect((await acquireOrResumeJob(env.DB, clock, "run-guard", "other")).job).toEqual(before.job);
    },
  );

  it("reopens failed jobs atomically and does not create missing jobs", async () => {
    expect(await reopenFailedJobForRestart(env.DB, clock, "run-missing", "publication-run-missing")).toBe(false);
    await acquireOrResumeJob(env.DB, clock, "run-race", "original-owner");
    await setJobState(env.DB, clock, "run-race", "failed");

    const results = await Promise.all([
      reopenFailedJobForRestart(env.DB, clock, "run-race", "publication-run-race"),
      reopenFailedJobForRestart(env.DB, clock, "run-race", "publication-run-race"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("supports explicit null clearing in state patches", async () => {
    await acquireOrResumeJob(env.DB, clock, "run-clear", "corr-1");
    await setJobState(env.DB, clock, "run-clear", "validation_failed", { validationResultJson: '{"error":"bad"}' });
    await setJobState(env.DB, clock, "run-clear", "validating", { validationResultJson: null });
    const { job } = await acquireOrResumeJob(env.DB, clock, "run-clear", "corr-1");
    expect(job.validationResultJson).toBeNull();
  });

  it("increments attempt count monotonically", async () => {
    await acquireOrResumeJob(env.DB, clock, "run-2", "corr-1");
    const a = await incrementAttempt(env.DB, "run-2");
    const b = await incrementAttempt(env.DB, "run-2");
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it("returns each concurrent attempt increment exactly once", async () => {
    await acquireOrResumeJob(env.DB, clock, "run-attempts", "corr-1");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => incrementAttempt(env.DB, "run-attempts")),
    );
    expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("persists and explicitly clears the one temporary document ID", async () => {
    await acquireOrResumeJob(env.DB, clock, "run-temp", "corr-1");
    await setTempDocId(env.DB, clock, "run-temp", "doc-temp-1");
    expect((await acquireOrResumeJob(env.DB, clock, "run-temp", "corr-2")).job.tempDocId).toBe("doc-temp-1");
    await setTempDocId(env.DB, clock, "run-temp", null);
    expect((await acquireOrResumeJob(env.DB, clock, "run-temp", "corr-3")).job.tempDocId).toBeNull();
  });

  it("caches and returns per-product collage and caption output", async () => {
    await acquireOrResumeJob(env.DB, clock, "run-3", "corr-1");
    const before = await getProductCache(env.DB, "run-3", "A-1001");
    expect(before).toEqual({ collageR2Key: null, captionsJson: null });

    await putProductCollage(env.DB, clock, "run-3", "A-1001", "products/A-1001/collage/1080x1080.jpg");
    await putProductCaptions(env.DB, clock, "run-3", "A-1001", JSON.stringify(["a", "b", "c"]));

    const after = await getProductCache(env.DB, "run-3", "A-1001");
    expect(after.collageR2Key).toBe("products/A-1001/collage/1080x1080.jpg");
    expect(after.captionsJson).toBe(JSON.stringify(["a", "b", "c"]));
  });
});
