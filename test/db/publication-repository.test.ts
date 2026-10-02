import { describe, expect, it, beforeEach } from "vitest";
import { testEnv } from "../helpers/env";
import {
  acquireOrResumeJob,
  claimPublicationDate,
  reopenFailedJobForRestart,
  setJobState,
  incrementAttempt,
  setTempDocId,
  getProductCache,
  putProductCollage,
  putProductCaptions,
  reopenSuccessfulJobForRegeneration,
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
    expect(job.publicationDate).toBeNull();
    expect(alreadySucceeded).toBe(false);
  });

  it("allocates one replacement while retaining the successful Doc and date", async () => {
    await acquireOrResumeJob(env.DB, clock, "run-revision", "publication-run-revision");
    await claimPublicationDate(env.DB, clock, "run-revision", "2026-09-02");
    await setJobState(env.DB, clock, "run-revision", "succeeded", {
      googleDocId: "old-doc", googleDocUrl: "https://docs.google.com/document/d/old-doc/edit", tempDocId: "old-doc",
    });
    const results = await Promise.all([
      reopenSuccessfulJobForRegeneration(env.DB, clock, "run-revision", 1),
      reopenSuccessfulJobForRegeneration(env.DB, clock, "run-revision", 1),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({
      generation: 2, successfulGeneration: 1, state: "locked", googleDocId: "old-doc",
      tempDocId: null, publicationDate: "2026-09-02", correlationId: "publication-run-revision-v2",
    });
    expect(await reopenSuccessfulJobForRegeneration(env.DB, clock, "run-revision", 2)).toBeNull();
  });

  it("fences old-generation state and cache writes", async () => {
    await acquireOrResumeJob(env.DB, clock, "run-fenced", "publication-run-fenced");
    await setJobState(env.DB, clock, "run-fenced", "succeeded", { googleDocId: "old", googleDocUrl: "old-url" });
    await reopenSuccessfulJobForRegeneration(env.DB, clock, "run-fenced", 1);
    await expect(setJobState(env.DB, clock, "run-fenced", "failed", undefined, 1)).rejects.toMatchObject({ code: "publication_generation_stale" });
    await expect(putProductCaptions(env.DB, clock, "run-fenced", "A-1", '["old"]', "fp", 1)).rejects.toMatchObject({ code: "publication_generation_stale" });
    expect((await acquireOrResumeJob(env.DB, clock, "run-fenced", "other")).job).toMatchObject({ state: "locked", generation: 2 });
    expect((await getProductCache(env.DB, "run-fenced", "A-1")).captionsJson).toBeNull();
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

  it("atomically gives a publication date to one run and keeps the losing run unclaimed", async () => {
    await acquireOrResumeJob(env.DB, clock, "run-a", "corr-a");
    await acquireOrResumeJob(env.DB, clock, "run-b", "corr-b");
    const claims = await Promise.all([
      claimPublicationDate(env.DB, clock, "run-a", "2026-09-02"),
      claimPublicationDate(env.DB, clock, "run-b", "2026-09-02"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const rows = await env.DB.prepare("SELECT publication_date FROM publication_jobs ORDER BY publication_run_id").all<{ publication_date: string | null }>();
    expect(rows.results.map(row => row.publication_date).sort()).toEqual(["2026-09-02", null]);
    const winner = claims[0] ? "run-a" : "run-b";
    expect(await claimPublicationDate(env.DB, clock, winner, "2026-09-02")).toBe(true);
  });

  it("retains a date claim across Failed restart and success and refuses moving it to another date", async () => {
    await acquireOrResumeJob(env.DB, clock, "run-owner", "corr-1");
    expect(await claimPublicationDate(env.DB, clock, "run-owner", "2026-09-02")).toBe(true);
    expect(await claimPublicationDate(env.DB, clock, "run-owner", "2026-09-03")).toBe(false);
    await setJobState(env.DB, clock, "run-owner", "failed");
    await acquireOrResumeJob(env.DB, clock, "run-other", "corr-2");
    expect(await claimPublicationDate(env.DB, clock, "run-other", "2026-09-02")).toBe(false);
    await reopenFailedJobForRestart(env.DB, clock, "run-owner", "corr-1");
    expect(await claimPublicationDate(env.DB, clock, "run-owner", "2026-09-02")).toBe(true);
    await setJobState(env.DB, clock, "run-owner", "succeeded");
    expect(await claimPublicationDate(env.DB, clock, "run-other", "2026-09-02")).toBe(false);
    expect(await claimPublicationDate(env.DB, clock, "run-other", "2026-09-03")).toBe(true);
    expect((await acquireOrResumeJob(env.DB, clock, "run-owner", "corr-3")).job.publicationDate).toBe("2026-09-02");
    expect(await claimPublicationDate(env.DB, clock, "missing", "2026-09-04")).toBe(false);
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
    await putProductCollage(env.DB, clock, "run-restart", "A-1001", "products/A-1001/collage/1080x1080.jpg", "collage-input");
    await putProductCaptions(env.DB, clock, "run-restart", "A-1001", '["หนึ่ง","สอง","สาม"]', "caption-input");
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
      collageInputFingerprint: "collage-input",
      captionsInputFingerprint: "caption-input",
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
    expect(before).toEqual({ collageR2Key: null, collageInputFingerprint: null, captionsJson: null, captionsInputFingerprint: null });

    await putProductCollage(env.DB, clock, "run-3", "A-1001", "products/A-1001/collage/1080x1080.jpg", "collage-input-1");
    await putProductCaptions(env.DB, clock, "run-3", "A-1001", JSON.stringify(["a", "b", "c"]), "caption-input-1");

    const after = await getProductCache(env.DB, "run-3", "A-1001");
    expect(after.collageR2Key).toBe("products/A-1001/collage/1080x1080.jpg");
    expect(after.captionsJson).toBe(JSON.stringify(["a", "b", "c"]));
    expect(after.collageInputFingerprint).toBe("collage-input-1");
    expect(after.captionsInputFingerprint).toBe("caption-input-1");
    await putProductCollage(env.DB, clock, "run-3", "A-1001", "new-collage.jpg", "collage-input-2");
    expect(await getProductCache(env.DB, "run-3", "A-1001")).toEqual({
      collageR2Key: "new-collage.jpg", collageInputFingerprint: "collage-input-2",
      captionsJson: JSON.stringify(["a", "b", "c"]), captionsInputFingerprint: "caption-input-1",
    });
    await putProductCaptions(env.DB, clock, "run-3", "A-1001", '["new"]', "caption-input-2");
    expect(await getProductCache(env.DB, "run-3", "A-1001")).toEqual({
      collageR2Key: "new-collage.jpg", collageInputFingerprint: "collage-input-2",
      captionsJson: '["new"]', captionsInputFingerprint: "caption-input-2",
    });
  });
});
