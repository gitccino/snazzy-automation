# Snazzy Publication Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Cloudflare-native publication pipeline that validates Airtable Publication Runs for completeness, generates deterministic 4-in-1 Cloudflare Images collages, generates three Thai caption drafts per Product ID with the official Anthropic SDK, writes one final Google Doc per publication date through a service-account client, and exposes the pipeline through `PublicationWorkflow`, a cron trigger, a `/docs` HTTP trigger, and LINE publication logs.

**Architecture:** A single durable `PublicationWorkflow` orchestrates a testable `publication/service.ts` core: validate every linked Product before touching Google, generate/reuse collages and captions, copy the customer's Google Doc template once per run, verify the generated document contains every expected Product ID, then rename it to final and update Airtable. D1 owns the publication idempotency lock, cached per-product outputs, and validation state so retries never regenerate valid work or create a second final document. All external calls (Airtable, Anthropic, Google, Cloudflare Images, LINE) sit behind narrow, structurally-typed clients so service logic is testable with fakes and without network access.

**Tech Stack:** TypeScript, Cloudflare Workers, Cloudflare Workflows, D1, Cloudflare Images (binding), npm, Vitest 4.1+, `@cloudflare/vitest-plugin`, Zod, `@anthropic-ai/sdk`, Web Crypto, Airtable REST API, Google Drive/Docs REST APIs.

**Spec:** `docs/superpowers/specs/2026-09-01-snazzy-automation-design.md`

## Global Constraints

- Dedicated customer-owned staging and production deployments.
- Runtime timezone: `Asia/Bangkok`.
- One final Google Doc per Airtable Publication Run.
- Missing Product data blocks whole publication and creates no Google Doc.
- Claude model defaults to `claude-opus-5`; text fields only; exactly three Thai drafts per Product ID.
- Retry each transient Workflow stage up to five times after its initial call, with exponential backoff (`PUBLICATION_RETRY_LIMIT=5`; at most six calls per stage).
- Never log credentials, public-album token/link, signed URLs, Product images, or raw external response bodies containing them.
- Use native `fetch` routing; do not add a web framework.
- Use official `@anthropic-ai/sdk`; do not call Claude through raw HTTP.
- Use Web Crypto for the Google service-account JWT; do not add a Node-only Google SDK.
- Use current Cloudflare Vitest plugin: `@cloudflare/vitest-plugin` with Vitest 4.1 or later; do not use removed `@cloudflare/vitest-pool-workers` APIs.
- Cloudflare compatibility date must be `2026-09-01` or later and include `nodejs_compat`.
- Every non-trivial parser, state transition, money mutation, and trust boundary starts with a failing test.
- Every task ends with focused tests, `npm run check`, and a commit.
- Anthropic client uses `maxRetries: 0`; Cloudflare Workflow `step.do()` owns durable retry count and backoff.
- Idempotency keys: Workflow instance `publication-<airtablePublicationRunId>`; Cloudflare custom Workflow IDs do not allow colons. Publication final output unique key is the Airtable Publication Run ID.

## Assumptions Carried From the Completed Import Plan

The import plan (`docs/superpowers/plans/2026-09-01-snazzy-import-pipeline.md`) is assumed complete and has already created the following, which this plan extends or imports without modification unless a task says otherwise:

- `src/env.ts` exporting the import-stage `Env`; Task 2 extends it with publication-only Workflow and secret bindings after `PublicationWorkflowParams` exists.
- `src/config.ts` exporting the import-stage `parseConfig(raw: unknown): AppConfig`; Task 2 adds publication-only Google, Claude, and cron fields while retaining import fields.
- `src/shared/errors.ts` exporting `OperationalError` (has `code: string`, `message: string`, `retryable: boolean`) and `isRetryable(error): boolean`; Task 10 converts permanent stage failures to `NonRetryableError` from `cloudflare:workflows` at the durable boundary.
- `src/shared/http.ts` exporting `Fetcher`, `SafeFetchOptions`, and `safeFetch(input: string, init: RequestInit | undefined, options: SafeFetchOptions): Promise<Response>`; external publication clients remain single-call and may mirror Import's direct-fetch error mapping where URL redaction is unnecessary.
- `src/shared/ids.ts` exporting `newCorrelationId(): string` and `sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string>`.
- `src/shared/time.ts` exporting `nowBangkokIso(clock: Clock): string`, `bangkokDateTimeThai(clock: Clock): string`, and `todayBangkokDate(clock: Clock): string`; date-only trigger lookup uses `todayBangkokDate` and never slices a UTC ISO timestamp.
- `src/shared/logger.ts` exporting `createLogger(base: LogFields)` with `.info()`/`.warn()`/`.error()` methods and secret-key redaction.
- `src/db/audit.ts` exporting `createAuditLog(db, ids, clock): AuditLog`; `AuditLog.record(entry)` accepts exactly `correlationId`, `actor`, `action`, `beforeValue`, and `afterValue`.
- `src/line/client.ts` exporting `createLineClient({ channelAccessToken, fetch }): LineClient`; `LineClient.pushMessage(toGroupId, text)` sends Thai import/publication notifications.
- Import notifications live in `src/import/notify.ts`; no `src/line/messages.ts` exists yet. Task 8 creates that file for publication-specific Thai message builders without moving or renaming Import behavior.
- `src/import/airtable-products.ts` exporting an Airtable REST helper pattern (auth header, base/table path construction, retry-free single-call semantics) that `publication/airtable-runs.ts` mirrors for consistency.
- Migrations `migrations/0001_initial.sql` and `migrations/0002_import_run_terminal_details.sql` are already applied. This plan owns `migrations/0003_publication.sql`; the later LINE and hardening plans must use `0004_line_inventory.sql` and `0005_usage_metrics.sql` respectively.

Reconciled baseline: `main` at squash-merge commit `aa5edba` (`feat: add durable Snazzy import pipeline (#2)`), with TypeScript clean and 34 test files / 197 tests. Executors must preserve the existing `/assets` and `/upload` router branches, Import cron behavior, `IMPORT_WORKFLOW` binding/export, and both Import migrations while extending them with Publication behavior.

---

## Task 1: Publication D1 schema and repository

**Files:**
- Create: `migrations/0003_publication.sql`
- Create: `src/db/publication-repository.ts`
- Test: `test/db/publication-repository.test.ts`

**Interfaces:**
- Consumes: `D1Database` (Cloudflare binding), `Clock` from `src/shared/time.ts` conventions (`{ now(): Date }`).
- Produces:
  ```ts
  export type PublicationJobState =
    | "locked"
    | "validating"
    | "validation_failed"
    | "generating"
    | "succeeded"
    | "failed";

  export interface PublicationJobRow {
    publicationRunId: string;
    state: PublicationJobState;
    correlationId: string;
    googleDocId: string | null;
    googleDocUrl: string | null;
    tempDocId: string | null;
    validationResultJson: string | null;
    attemptCount: number;
    createdAt: string;
    updatedAt: string;
  }

  export interface ProductOutputCache {
    collageR2Key: string | null;
    captionsJson: string | null;
  }

  export async function acquireOrResumeJob(
    db: D1Database,
    clock: Clock,
    publicationRunId: string,
    correlationId: string,
  ): Promise<{ job: PublicationJobRow; alreadySucceeded: boolean }>;

  export async function setJobState(
    db: D1Database,
    clock: Clock,
    publicationRunId: string,
    state: PublicationJobState,
    patch?: Partial<Pick<PublicationJobRow, "googleDocId" | "googleDocUrl" | "tempDocId" | "validationResultJson">>,
  ): Promise<void>;

  export async function incrementAttempt(db: D1Database, publicationRunId: string): Promise<number>;

  export async function setTempDocId(
    db: D1Database,
    clock: Clock,
    publicationRunId: string,
    tempDocId: string | null,
  ): Promise<void>;

  export async function getProductCache(
    db: D1Database,
    publicationRunId: string,
    productId: string,
  ): Promise<ProductOutputCache>;

  export async function putProductCollage(
    db: D1Database,
    clock: Clock,
    publicationRunId: string,
    productId: string,
    collageR2Key: string,
  ): Promise<void>;

  export async function putProductCaptions(
    db: D1Database,
    clock: Clock,
    publicationRunId: string,
    productId: string,
    captionsJson: string,
  ): Promise<void>;
  ```
  used by `publication/service.ts` and `publication/workflow.ts` (Tasks 9 and 10).

- [ ] **Step 1: Write the failing schema/repository test**

```ts
// test/db/publication-repository.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  acquireOrResumeJob,
  setJobState,
  incrementAttempt,
  setTempDocId,
  getProductCache,
  putProductCollage,
  putProductCaptions,
} from "../../src/db/publication-repository";

const clock = { now: () => new Date("2026-09-01T05:00:00.000Z") };

describe("publication-repository", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM publication_jobs");
    await env.DB.exec("DELETE FROM publication_product_cache");
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

  it("reports alreadySucceeded true and refuses to reset a succeeded job", async () => {
    await acquireOrResumeJob(env.DB, clock, "run-1", "corr-1");
    await setJobState(env.DB, clock, "run-1", "succeeded", { googleDocId: "doc-1", googleDocUrl: "https://docs.google.com/doc-1" });
    const { job, alreadySucceeded } = await acquireOrResumeJob(env.DB, clock, "run-1", "corr-3");
    expect(alreadySucceeded).toBe(true);
    expect(job.googleDocId).toBe("doc-1");
  });

  it("increments attempt count monotonically", async () => {
    await acquireOrResumeJob(env.DB, clock, "run-2", "corr-1");
    const a = await incrementAttempt(env.DB, "run-2");
    const b = await incrementAttempt(env.DB, "run-2");
    expect(a).toBe(1);
    expect(b).toBe(2);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/publication-repository.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/publication-repository'` and/or `no such table: publication_jobs`.

- [ ] **Step 3: Write the migration**

```sql
-- migrations/0003_publication.sql
CREATE TABLE publication_jobs (
  publication_run_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('locked', 'validating', 'validation_failed', 'generating', 'succeeded', 'failed')),
  correlation_id TEXT NOT NULL,
  google_doc_id TEXT,
  google_doc_url TEXT,
  temp_doc_id TEXT,
  validation_result_json TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE publication_product_cache (
  publication_run_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  collage_r2_key TEXT,
  captions_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (publication_run_id, product_id),
  FOREIGN KEY (publication_run_id) REFERENCES publication_jobs (publication_run_id)
);

CREATE INDEX idx_publication_product_cache_run ON publication_product_cache (publication_run_id);
```

- [ ] **Step 4: Apply the migration locally**

Run: `npm run db:migrate:local`
Expected: `0003_publication.sql` applied after both Import migrations with no errors.

- [ ] **Step 5: Write the repository implementation**

```ts
// src/db/publication-repository.ts
import type { Clock } from "../shared/time";

export type PublicationJobState =
  | "locked"
  | "validating"
  | "validation_failed"
  | "generating"
  | "succeeded"
  | "failed";

export interface PublicationJobRow {
  publicationRunId: string;
  state: PublicationJobState;
  correlationId: string;
  googleDocId: string | null;
  googleDocUrl: string | null;
  tempDocId: string | null;
  validationResultJson: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductOutputCache {
  collageR2Key: string | null;
  captionsJson: string | null;
}

interface JobRowRaw {
  publication_run_id: string;
  state: PublicationJobState;
  correlation_id: string;
  google_doc_id: string | null;
  google_doc_url: string | null;
  temp_doc_id: string | null;
  validation_result_json: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}

function toRow(raw: JobRowRaw): PublicationJobRow {
  return {
    publicationRunId: raw.publication_run_id,
    state: raw.state,
    correlationId: raw.correlation_id,
    googleDocId: raw.google_doc_id,
    googleDocUrl: raw.google_doc_url,
    tempDocId: raw.temp_doc_id,
    validationResultJson: raw.validation_result_json,
    attemptCount: raw.attempt_count,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export async function acquireOrResumeJob(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  correlationId: string,
): Promise<{ job: PublicationJobRow; alreadySucceeded: boolean }> {
  const nowIso = clock.now().toISOString();
  await db
    .prepare(
      `INSERT INTO publication_jobs (publication_run_id, state, correlation_id, attempt_count, created_at, updated_at)
       VALUES (?, 'locked', ?, 0, ?, ?)
       ON CONFLICT (publication_run_id) DO NOTHING`,
    )
    .bind(publicationRunId, correlationId, nowIso, nowIso)
    .run();

  const raw = await db
    .prepare("SELECT * FROM publication_jobs WHERE publication_run_id = ?")
    .bind(publicationRunId)
    .first<JobRowRaw>();

  if (!raw) {
    throw new Error(`publication job row missing immediately after insert for ${publicationRunId}`);
  }

  const job = toRow(raw);
  return { job, alreadySucceeded: job.state === "succeeded" };
}

export async function setJobState(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  state: PublicationJobState,
  patch?: Partial<Pick<PublicationJobRow, "googleDocId" | "googleDocUrl" | "tempDocId" | "validationResultJson">>,
): Promise<void> {
  const nowIso = clock.now().toISOString();
  await db
    .prepare(
      `UPDATE publication_jobs
       SET state = ?,
           google_doc_id = COALESCE(?, google_doc_id),
           google_doc_url = COALESCE(?, google_doc_url),
           temp_doc_id = COALESCE(?, temp_doc_id),
           validation_result_json = COALESCE(?, validation_result_json),
           updated_at = ?
       WHERE publication_run_id = ?`,
    )
    .bind(
      state,
      patch?.googleDocId ?? null,
      patch?.googleDocUrl ?? null,
      patch?.tempDocId ?? null,
      patch?.validationResultJson ?? null,
      nowIso,
      publicationRunId,
    )
    .run();
}

export async function incrementAttempt(db: D1Database, publicationRunId: string): Promise<number> {
  await db
    .prepare("UPDATE publication_jobs SET attempt_count = attempt_count + 1 WHERE publication_run_id = ?")
    .bind(publicationRunId)
    .run();
  const raw = await db
    .prepare("SELECT attempt_count FROM publication_jobs WHERE publication_run_id = ?")
    .bind(publicationRunId)
    .first<{ attempt_count: number }>();
  return raw?.attempt_count ?? 0;
}

export async function setTempDocId(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  tempDocId: string | null,
): Promise<void> {
  await db
    .prepare("UPDATE publication_jobs SET temp_doc_id = ?, updated_at = ? WHERE publication_run_id = ?")
    .bind(tempDocId, clock.now().toISOString(), publicationRunId)
    .run();
}

export async function getProductCache(
  db: D1Database,
  publicationRunId: string,
  productId: string,
): Promise<ProductOutputCache> {
  const raw = await db
    .prepare("SELECT collage_r2_key, captions_json FROM publication_product_cache WHERE publication_run_id = ? AND product_id = ?")
    .bind(publicationRunId, productId)
    .first<{ collage_r2_key: string | null; captions_json: string | null }>();
  return { collageR2Key: raw?.collage_r2_key ?? null, captionsJson: raw?.captions_json ?? null };
}

export async function putProductCollage(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  productId: string,
  collageR2Key: string,
): Promise<void> {
  const nowIso = clock.now().toISOString();
  await db
    .prepare(
      `INSERT INTO publication_product_cache (publication_run_id, product_id, collage_r2_key, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (publication_run_id, product_id)
       DO UPDATE SET collage_r2_key = excluded.collage_r2_key, updated_at = excluded.updated_at`,
    )
    .bind(publicationRunId, productId, collageR2Key, nowIso)
    .run();
}

export async function putProductCaptions(
  db: D1Database,
  clock: Clock,
  publicationRunId: string,
  productId: string,
  captionsJson: string,
): Promise<void> {
  const nowIso = clock.now().toISOString();
  await db
    .prepare(
      `INSERT INTO publication_product_cache (publication_run_id, product_id, captions_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (publication_run_id, product_id)
       DO UPDATE SET captions_json = excluded.captions_json, updated_at = excluded.updated_at`,
    )
    .bind(publicationRunId, productId, captionsJson, nowIso)
    .run();
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/db/publication-repository.test.ts`
Expected: PASS — 6 tests green.

- [ ] **Step 7: Full check and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add migrations/0003_publication.sql src/db/publication-repository.ts test/db/publication-repository.test.ts
git commit -m "feat(publication): add D1 job lock and per-product output cache"
```

---

## Task 2: Airtable Publication Runs client

**Files:**
- Modify: `src/config.ts`
- Modify: `src/env.ts`
- Modify: `test/config.test.ts`
- Modify: `test/helpers/env.ts`
- Create: `src/publication/types.ts`
- Create: `src/publication/airtable-runs.ts`
- Test: `test/publication/airtable-runs.test.ts`

**Interfaces:**
- Consumes: `Fetcher` (`typeof fetch`) from `src/shared/http.ts` conventions, `AppConfig` from `src/config.ts`.
- Produces:
  ```ts
  // src/publication/types.ts
  export interface PublicationWorkflowParams {
    publicationRunId: string;
    trigger: "cron" | "line" | "admin";
  }

  export interface PublicationProduct {
    airtableRecordId: string;
    productId: string;
    orderedImageKeys: string[];
    brandName: string;
    modelName: string;
    conditionType: string;
    size: string;
    description: string;
    lineSquarePrice: number;
    igPrice: number;
  }

  export interface CaptionSet {
    productId: string;
    drafts: [string, string, string];
  }

  export interface PublicationResult {
    publicationRunId: string;
    googleDocId: string;
    googleDocUrl: string;
    productIds: string[];
  }

  export type PublicationRunStatus = "Draft" | "Ready" | "Generating" | "Generated" | "Failed";

  export interface PublicationRun {
    airtableRunId: string;
    publicationDate: string;
    status: PublicationRunStatus;
    products: PublicationProduct[];
  }
  ```
  ```ts
  // src/publication/airtable-runs.ts
  export type AirtablePublicationConfig = Pick<
    AppConfig,
    | "airtableBaseId"
    | "airtableProductsTableId"
    | "airtablePublicationRunsTableId"
  >;

  export async function findRunnableRunForDate(
    fetcher: Fetcher,
    config: AirtablePublicationConfig,
    token: string,
    isoDate: string,
  ): Promise<PublicationRun | null>;

  export async function loadRunById(
    fetcher: Fetcher,
    config: AirtablePublicationConfig,
    token: string,
    airtableRunId: string,
  ): Promise<PublicationRun>;

  export async function markRunGenerating(fetcher: Fetcher, config: AirtablePublicationConfig, token: string, airtableRunId: string): Promise<void>;

  export async function markRunGenerated(
    fetcher: Fetcher,
    config: AirtablePublicationConfig,
    token: string,
    airtableRunId: string,
    googleDocUrl: string,
    generatedAtIso: string,
  ): Promise<void>;

  export async function markRunNeedsCorrection(
    fetcher: Fetcher,
    config: AirtablePublicationConfig,
    token: string,
    airtableRunId: string,
    errorSummary: string,
  ): Promise<void>;

  export async function markRunFailed(
    fetcher: Fetcher,
    config: AirtablePublicationConfig,
    token: string,
    airtableRunId: string,
    errorSummary: string,
  ): Promise<void>;

  export async function updateProductCollage(
    fetcher: Fetcher,
    config: AirtablePublicationConfig,
    token: string,
    airtableRecordId: string,
    signedCollageUrl: string,
  ): Promise<void>;
  ```
  used by `publication/service.ts` (Task 9).

`Product Images` attachment URLs are temporary Airtable delivery URLs and must never be used as R2 keys. Import Task 9 writes each attachment filename as the private object basename; this client preserves staff order and reconstructs each key as `assets/<filename>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/publication/airtable-runs.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  findRunnableRunForDate,
  markRunGenerating,
  markRunGenerated,
  markRunNeedsCorrection,
  updateProductCollage,
  type AirtablePublicationConfig,
} from "../../src/publication/airtable-runs";
import type { Fetcher } from "../../src/shared/http";

const config = {
  airtableBaseId: "base123",
  airtableProductsTableId: "tblProducts",
  airtablePublicationRunsTableId: "tblRuns",
} satisfies AirtablePublicationConfig;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("findRunnableRunForDate", () => {
  it("returns null when no Ready or Failed run matches the date", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ records: [] }));
    const result = await findRunnableRunForDate(fetcher, config, "token", "2026-09-01");
    expect(result).toBeNull();
  });

  it("fetches a Ready run, while the same query also permits retrying a Failed run", async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(
        jsonResponse({
          records: [
            {
              id: "recRun1",
              fields: {
                "Publication Date": "2026-09-01",
                Status: "Ready",
                Products: ["recProd1"],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          records: [
            {
              id: "recProd1",
              fields: {
                "Product ID": "A-1001",
                "Product Images": [{ id: "attImg1", url: "https://dl.airtable.com/img1.jpg", filename: "a.jpg" }],
                "Brand Name": "Nike",
                "Model Name": "Air Max",
                "Condition Type": "Used",
                Size: "42",
                Description: "Good condition",
                "LINE Square Price": 1290,
                "IG Price": 1390,
              },
            },
          ],
        }),
      );

    const result = await findRunnableRunForDate(fetcher, config, "token", "2026-09-01");
    expect(result).not.toBeNull();
    expect(result?.products).toHaveLength(1);
    expect(result?.products[0]).toMatchObject({
      airtableRecordId: "recProd1",
      productId: "A-1001",
      orderedImageKeys: ["assets/a.jpg"],
      brandName: "Nike",
      lineSquarePrice: 1290,
      igPrice: 1390,
    });
    const firstCallUrl = String(fetcher.mock.calls[0]![0]);
    expect(firstCallUrl).toContain("tblRuns");
    expect(firstCallUrl).toContain(encodeURIComponent("2026-09-01"));
  });

  it("rejects a malformed Airtable attachment before it becomes an R2 key", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        records: [{
          id: "recRun1",
          fields: {
            "Publication Date": "2026-09-01",
            Status: "Ready",
            Products: ["recProd1"],
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        records: [{
          id: "recProd1",
          fields: {
            "Product ID": "A-1001",
            "Product Images": [{
              id: "att1",
              url: "https://dl.airtable.com/image.jpg",
              filename: "../outside.jpg",
            }],
          },
        }],
      }));

    await expect(
      findRunnableRunForDate(fetcher, config, "token", "2026-09-01"),
    ).rejects.toThrow(/invalid attachment filename/i);
  });

  it.each([
    [429, true],
    [422, false],
  ])(
    "classifies Airtable status %i with retryable=%s",
    async (status, retryable) => {
      const fetcher = vi.fn<Fetcher>().mockResolvedValue(
        jsonResponse({}, status),
      );

      await expect(
        findRunnableRunForDate(
          fetcher,
          config,
          "token",
          "2026-09-01",
        ),
      ).rejects.toMatchObject({
        code: "airtable_runs_fetch_failed",
        retryable,
      });
    },
  );
});

describe("status writes", () => {
  it("markRunGenerating PATCHes Status to Generating", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ id: "recRun1" }));
    await markRunGenerating(fetcher, config, "token", "recRun1");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain("recRun1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body)).fields.Status).toBe("Generating");
  });

  it("markRunGenerated writes doc URL, timestamp, and Generated status", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ id: "recRun1" }));
    await markRunGenerated(fetcher, config, "token", "recRun1", "https://docs.google.com/x", "2026-09-01T06:00:00.000Z");
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(body.fields.Status).toBe("Generated");
    expect(body.fields["Google Doc URL"]).toBe("https://docs.google.com/x");
    expect(body.fields["Generated At"]).toBe("2026-09-01T06:00:00.000Z");
  });

  it("markRunNeedsCorrection returns Status to Draft with Error Summary", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ id: "recRun1" }));
    await markRunNeedsCorrection(fetcher, config, "token", "recRun1", "A-1001: missing Description");
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(body.fields.Status).toBe("Draft");
    expect(body.fields["Error Summary"]).toBe("A-1001: missing Description");
  });
});

describe("updateProductCollage", () => {
  it("PATCHes the 4-in-1 Image attachment field with the signed URL", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ id: "recProd1" }));
    await updateProductCollage(fetcher, config, "token", "recProd1", "https://r2.example.com/signed");
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(body.fields["4-in-1 Image"]).toEqual([{ url: "https://r2.example.com/signed" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publication/airtable-runs.test.ts`
Expected: FAIL — `Cannot find module '../../src/publication/airtable-runs'`.

- [ ] **Step 3: Extend publication configuration**

Add these fields to the existing `RawAppConfigSchema`:

```ts
PUBLICATION_CRON: z.string().min(1),
PUBLICATION_RETRY_LIMIT: z.literal(5),
AIRTABLE_PUBLICATION_RUNS_TABLE_ID: z.string().min(1),
GOOGLE_DRIVE_FOLDER_ID: z.string().min(1),
GOOGLE_TEMPLATE_DOC_ID: z.string().min(1),
CLAUDE_MODEL: z.literal("claude-opus-5"),
CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: z.number().int().positive().max(150_000),
```

Add matching camel-case members to `AppConfig`:

```ts
publicationCron: string;
publicationRetryLimit: 5;
airtablePublicationRunsTableId: string;
googleDriveFolderId: string;
googleTemplateDocId: string;
claudeModel: "claude-opus-5";
claudeRequestInputTokenLimit: number;
```

Add exact mappings to the object returned by `parseConfig`:

```ts
publicationCron: parsed.PUBLICATION_CRON,
publicationRetryLimit: parsed.PUBLICATION_RETRY_LIMIT,
airtablePublicationRunsTableId: parsed.AIRTABLE_PUBLICATION_RUNS_TABLE_ID,
googleDriveFolderId: parsed.GOOGLE_DRIVE_FOLDER_ID,
googleTemplateDocId: parsed.GOOGLE_TEMPLATE_DOC_ID,
claudeModel: parsed.CLAUDE_MODEL,
claudeRequestInputTokenLimit: parsed.CLAUDE_REQUEST_INPUT_TOKEN_LIMIT,
```

Extend the existing `validRawConfig` object in `test/config.test.ts` with these fields so later plans inherit one complete fixture:

```ts
PUBLICATION_CRON: "30 23 * * *",
PUBLICATION_RETRY_LIMIT: 5,
AIRTABLE_PUBLICATION_RUNS_TABLE_ID: "tblRuns",
GOOGLE_DRIVE_FOLDER_ID: "folder-1",
GOOGLE_TEMPLATE_DOC_ID: "template-1",
CLAUDE_MODEL: "claude-opus-5",
CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 150_000,
```

Extend the exact object expected by the existing `"parses the import uppercase JSON contract into camel-case runtime fields"` test with the same seven camel-case Publication properties. That test uses `toEqual`, so updating only its input would make the existing Import test fail on the newly returned keys:

```ts
publicationCron: "30 23 * * *",
publicationRetryLimit: 5,
airtablePublicationRunsTableId: "tblRuns",
googleDriveFolderId: "folder-1",
googleTemplateDocId: "template-1",
claudeModel: "claude-opus-5",
claudeRequestInputTokenLimit: 150_000,
```

Extend `TestEnvConfig` and the object returned by `createTestEnv()` in `test/helpers/env.ts` with the two new secret bindings:

```ts
GOOGLE_SERVICE_ACCOUNT_JSON: string;
ANTHROPIC_API_KEY: string;

// createTestEnv() defaults
GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
  client_email: "publication-test@example.iam.gserviceaccount.com",
  private_key: "test-private-key",
}),
ANTHROPIC_API_KEY: "test-anthropic-key",
```

Inside the existing `APP_CONFIG_JSON` fixture in `createTestEnv()`, add the same seven uppercase Publication config keys shown for `validRawConfig`. This keeps every pre-existing Import route, scheduler, and acceptance test valid after the shared config schema becomes stricter.

Append these tests to `test/config.test.ts`:

```ts
it("maps every publication config key", () => {
  const config = parseConfig(validRawConfig);
  expect(config).toMatchObject({
    publicationCron: "30 23 * * *",
    publicationRetryLimit: 5,
    airtablePublicationRunsTableId: "tblRuns",
    googleDriveFolderId: "folder-1",
    googleTemplateDocId: "template-1",
    claudeModel: "claude-opus-5",
    claudeRequestInputTokenLimit: 150_000,
  });
});

it.each([
  ["retry limit", { PUBLICATION_RETRY_LIMIT: 4 }],
  ["model", { CLAUDE_MODEL: "claude-sonnet-5" }],
  ["token limit", { CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 150_001 }],
])("rejects invalid publication %s", (_name, patch) => {
  expect(() => parseConfig({
    ...validRawConfig,
    ...patch,
  })).toThrow();
});
```

- [ ] **Step 4: Write `src/publication/types.ts`**

Use the interfaces shown in the Interfaces block above verbatim.

- [ ] **Step 5: Write `src/publication/airtable-runs.ts`**

```ts
// src/publication/airtable-runs.ts
import { z } from "zod";
import type { AppConfig } from "../config";
import { OperationalError } from "../shared/errors";
import type { Fetcher } from "../shared/http";
import type { PublicationProduct, PublicationRun } from "./types";

export type AirtablePublicationConfig = Pick<
  AppConfig,
  | "airtableBaseId"
  | "airtableProductsTableId"
  | "airtablePublicationRunsTableId"
>;

function airtableUrl(
  config: AirtablePublicationConfig,
  tableId: string,
  path = "",
): string {
  return `https://api.airtable.com/v0/${config.airtableBaseId}/${tableId}${path}`;
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function airtableHttpError(
  code: string,
  action: string,
  status: number,
): OperationalError {
  return new OperationalError(
    code,
    `Airtable ${action} failed with status ${status}`,
    status === 429 || status >= 500,
  );
}

const AirtableRunRecordSchema = z.object({
  id: z.string().min(1),
  fields: z.object({
    "Publication Date": z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    Status: z.enum(["Draft", "Ready", "Generating", "Generated", "Failed"]),
    Products: z.array(z.string().min(1)).optional(),
  }),
});

const AirtableProductRecordSchema = z.object({
  id: z.string().min(1),
  fields: z.object({
    "Product ID": z.string().regex(/^A-\d+$/),
    "Product Images": z.array(z.object({
      id: z.string().min(1),
      url: z.string().url(),
      filename: z.string().min(1),
    })).optional(),
    "Brand Name": z.string().optional(),
    "Model Name": z.string().optional(),
    "Condition Type": z.string().optional(),
    Size: z.string().optional(),
    Description: z.string().optional(),
    "LINE Square Price": z.number().optional(),
    "IG Price": z.number().optional(),
  }),
});

function attachmentR2Key(filename: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
    throw new Error("Airtable Product Images contains an invalid attachment filename");
  }
  return `assets/${filename}`;
}

async function fetchLinkedProducts(
  fetcher: Fetcher,
  config: AirtablePublicationConfig,
  token: string,
  recordIds: string[],
): Promise<PublicationProduct[]> {
  if (recordIds.length === 0) return [];
  const formula = `OR(${recordIds.map((id) => `RECORD_ID()='${id}'`).join(",")})`;
  const url = `${airtableUrl(config, config.airtableProductsTableId)}?filterByFormula=${encodeURIComponent(formula)}`;
  const response = await fetcher(url, { headers: authHeaders(token) });
  if (!response.ok) {
    throw airtableHttpError(
      "airtable_products_fetch_failed",
      "products fetch",
      response.status,
    );
  }
  const body = z.object({
    records: z.array(AirtableProductRecordSchema),
  }).parse(await response.json());
  return body.records.map((record) => ({
    airtableRecordId: record.id,
    productId: record.fields["Product ID"],
    orderedImageKeys: (record.fields["Product Images"] ?? []).map((image) =>
      attachmentR2Key(image.filename),
    ),
    brandName: record.fields["Brand Name"] ?? "",
    modelName: record.fields["Model Name"] ?? "",
    conditionType: record.fields["Condition Type"] ?? "",
    size: record.fields.Size ?? "",
    description: record.fields.Description ?? "",
    lineSquarePrice: record.fields["LINE Square Price"] ?? 0,
    igPrice: record.fields["IG Price"] ?? 0,
  }));
}

export async function findRunnableRunForDate(
  fetcher: Fetcher,
  config: AirtablePublicationConfig,
  token: string,
  isoDate: string,
): Promise<PublicationRun | null> {
  const formula = `AND({Publication Date}='${isoDate}',OR({Status}='Ready',{Status}='Failed'))`;
  const url = `${airtableUrl(config, config.airtablePublicationRunsTableId)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const response = await fetcher(url, { headers: authHeaders(token) });
  if (!response.ok) {
    throw airtableHttpError(
      "airtable_runs_fetch_failed",
      "runs fetch",
      response.status,
    );
  }
  const body = z.object({
    records: z.array(AirtableRunRecordSchema),
  }).parse(await response.json());
  const record = body.records[0];
  if (!record) return null;

  const products = await fetchLinkedProducts(fetcher, config, token, record.fields.Products ?? []);
  return {
    airtableRunId: record.id,
    publicationDate: record.fields["Publication Date"],
    status: record.fields.Status,
    products,
  };
}

export async function loadRunById(
  fetcher: Fetcher,
  config: AirtablePublicationConfig,
  token: string,
  airtableRunId: string,
): Promise<PublicationRun> {
  const url = airtableUrl(config, config.airtablePublicationRunsTableId, `/${airtableRunId}`);
  const response = await fetcher(url, { headers: authHeaders(token) });
  if (!response.ok) {
    throw airtableHttpError(
      "airtable_run_fetch_failed",
      "run fetch",
      response.status,
    );
  }
  const body = AirtableRunRecordSchema.parse(await response.json());
  const products = await fetchLinkedProducts(fetcher, config, token, body.fields.Products ?? []);
  return {
    airtableRunId: body.id,
    publicationDate: body.fields["Publication Date"],
    status: body.fields.Status,
    products,
  };
}

async function patchRun(
  fetcher: Fetcher,
  config: AirtablePublicationConfig,
  token: string,
  airtableRunId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const url = airtableUrl(config, config.airtablePublicationRunsTableId, `/${airtableRunId}`);
  const response = await fetcher(url, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) {
    throw airtableHttpError(
      "airtable_run_update_failed",
      "run update",
      response.status,
    );
  }
}

export async function markRunGenerating(fetcher: Fetcher, config: AirtablePublicationConfig, token: string, airtableRunId: string): Promise<void> {
  await patchRun(fetcher, config, token, airtableRunId, { Status: "Generating" });
}

export async function markRunGenerated(
  fetcher: Fetcher,
  config: AirtablePublicationConfig,
  token: string,
  airtableRunId: string,
  googleDocUrl: string,
  generatedAtIso: string,
): Promise<void> {
  await patchRun(fetcher, config, token, airtableRunId, {
    Status: "Generated",
    "Google Doc URL": googleDocUrl,
    "Generated At": generatedAtIso,
  });
}

export async function markRunNeedsCorrection(
  fetcher: Fetcher,
  config: AirtablePublicationConfig,
  token: string,
  airtableRunId: string,
  errorSummary: string,
): Promise<void> {
  await patchRun(fetcher, config, token, airtableRunId, { Status: "Draft", "Error Summary": errorSummary });
}

export async function markRunFailed(
  fetcher: Fetcher,
  config: AirtablePublicationConfig,
  token: string,
  airtableRunId: string,
  errorSummary: string,
): Promise<void> {
  await patchRun(fetcher, config, token, airtableRunId, { Status: "Failed", "Error Summary": errorSummary });
}

export async function updateProductCollage(
  fetcher: Fetcher,
  config: AirtablePublicationConfig,
  token: string,
  airtableRecordId: string,
  signedCollageUrl: string,
): Promise<void> {
  const url = airtableUrl(config, config.airtableProductsTableId, `/${airtableRecordId}`);
  const response = await fetcher(url, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify({ fields: { "4-in-1 Image": [{ url: signedCollageUrl }] } }),
  });
  if (!response.ok) {
    throw airtableHttpError(
      "airtable_product_collage_update_failed",
      "product collage update",
      response.status,
    );
  }
}
```

- [ ] **Step 6: Extend `Env` with publication bindings**

Add the type import and three publication-only members without renaming existing import bindings:

```ts
// add at the top of src/env.ts
import type { PublicationWorkflowParams } from "./publication/types";

// insert inside the existing Env interface
PUBLICATION_WORKFLOW: Workflow<PublicationWorkflowParams>;
GOOGLE_SERVICE_ACCOUNT_JSON: string;
ANTHROPIC_API_KEY: string;
```

`Workflow` remains the ambient Workers type already used by the merged `Env`; do not add a redundant runtime import. `LINE_CHANNEL_SECRET` is added later by the LINE plan, where webhook verification first needs it.

- [ ] **Step 7: Run focused tests to verify the shared fixtures and client pass**

Run: `npx vitest run test/config.test.ts test/publication/airtable-runs.test.ts test/routes/upload.test.ts test/scheduled.test.ts`
Expected: PASS — Publication config/client tests and the existing Import consumers of `createTestEnv()` remain green.

- [ ] **Step 8: Full check and commit**

Run: `npm run check`

```bash
git add src/config.ts src/env.ts src/publication/types.ts src/publication/airtable-runs.ts test/config.test.ts test/helpers/env.ts test/publication/airtable-runs.test.ts
git commit -m "feat(publication): add Airtable Publication Runs client"
```

---

## Task 3: Completeness validator

**Files:**
- Create: `src/publication/validator.ts`
- Test: `test/publication/validator.test.ts`

**Interfaces:**
- Consumes: `PublicationProduct` from `src/publication/types.ts` (Task 2).
- Produces:
  ```ts
  export interface ProductMissingFields {
    productId: string;
    missingFields: string[];
  }

  export interface ValidationResult {
    valid: boolean;
    productsMissingFields: ProductMissingFields[];
  }

  export function validateRunCompleteness(products: PublicationProduct[]): ValidationResult;

  export function formatValidationErrorSummary(result: ValidationResult): string;
  ```
  used by `publication/service.ts` (Task 9) and LINE message builders (Task 8).

- [ ] **Step 1: Write the failing test**

```ts
// test/publication/validator.test.ts
import { describe, expect, it } from "vitest";
import { validateRunCompleteness, formatValidationErrorSummary } from "../../src/publication/validator";
import type { PublicationProduct } from "../../src/publication/types";

function product(overrides: Partial<PublicationProduct> = {}): PublicationProduct {
  return {
    airtableRecordId: "rec1",
    productId: "A-1001",
    orderedImageKeys: ["img1", "img2", "img3", "img4"],
    brandName: "Nike",
    modelName: "Air Max",
    conditionType: "Used",
    size: "42",
    description: "Good condition",
    lineSquarePrice: 1290,
    igPrice: 1390,
    ...overrides,
  };
}

describe("validateRunCompleteness", () => {
  it("passes when every product has every required field and at least four images", () => {
    const result = validateRunCompleteness([product()]);
    expect(result).toEqual({ valid: true, productsMissingFields: [] });
  });

  it("flags a product missing text fields by name", () => {
    const result = validateRunCompleteness([product({ brandName: "", description: "" })]);
    expect(result.valid).toBe(false);
    expect(result.productsMissingFields).toEqual([
      { productId: "A-1001", missingFields: ["Brand Name", "Description"] },
    ]);
  });

  it("flags a product with fewer than four ordered images", () => {
    const result = validateRunCompleteness([product({ orderedImageKeys: ["img1", "img2"] })]);
    expect(result.valid).toBe(false);
    expect(result.productsMissingFields).toEqual([
      { productId: "A-1001", missingFields: ["Product Images (needs at least 4)"] },
    ]);
  });

  it("flags zero or negative prices", () => {
    const result = validateRunCompleteness([product({ lineSquarePrice: 0, igPrice: -5 })]);
    expect(result.productsMissingFields).toEqual([
      { productId: "A-1001", missingFields: ["LINE Square Price", "IG Price"] },
    ]);
  });

  it("reports every failing product, not just the first", () => {
    const result = validateRunCompleteness([
      product({ productId: "A-1001", brandName: "" }),
      product({ productId: "A-1002", size: "" }),
    ]);
    expect(result.productsMissingFields.map((p) => p.productId)).toEqual(["A-1001", "A-1002"]);
  });

  it("rejects a run with zero linked products", () => {
    const result = validateRunCompleteness([]);
    expect(result.valid).toBe(false);
    expect(result.productsMissingFields).toEqual([{ productId: "(run)", missingFields: ["No Products linked to this Publication Run"] }]);
  });
});

describe("formatValidationErrorSummary", () => {
  it("groups missing fields by Product ID into one readable summary", () => {
    const summary = formatValidationErrorSummary({
      valid: false,
      productsMissingFields: [
        { productId: "A-1001", missingFields: ["Brand Name", "Description"] },
        { productId: "A-1002", missingFields: ["Size"] },
      ],
    });
    expect(summary).toBe("A-1001: Brand Name, Description\nA-1002: Size");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publication/validator.test.ts`
Expected: FAIL — `Cannot find module '../../src/publication/validator'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/publication/validator.ts
import type { PublicationProduct } from "./types";

export interface ProductMissingFields {
  productId: string;
  missingFields: string[];
}

export interface ValidationResult {
  valid: boolean;
  productsMissingFields: ProductMissingFields[];
}

const REQUIRED_TEXT_FIELDS: Array<{ key: keyof PublicationProduct; label: string }> = [
  { key: "brandName", label: "Brand Name" },
  { key: "modelName", label: "Model Name" },
  { key: "conditionType", label: "Condition Type" },
  { key: "size", label: "Size" },
  { key: "description", label: "Description" },
];

const MIN_COLLAGE_IMAGES = 4;

export function validateRunCompleteness(products: PublicationProduct[]): ValidationResult {
  if (products.length === 0) {
    return {
      valid: false,
      productsMissingFields: [{ productId: "(run)", missingFields: ["No Products linked to this Publication Run"] }],
    };
  }

  const productsMissingFields: ProductMissingFields[] = [];

  for (const product of products) {
    const missingFields: string[] = [];

    for (const field of REQUIRED_TEXT_FIELDS) {
      const value = product[field.key];
      if (typeof value !== "string" || value.trim().length === 0) {
        missingFields.push(field.label);
      }
    }

    if (product.orderedImageKeys.length < MIN_COLLAGE_IMAGES) {
      missingFields.push(`Product Images (needs at least ${MIN_COLLAGE_IMAGES})`);
    }

    if (!(product.lineSquarePrice > 0)) {
      missingFields.push("LINE Square Price");
    }

    if (!(product.igPrice > 0)) {
      missingFields.push("IG Price");
    }

    if (missingFields.length > 0) {
      productsMissingFields.push({ productId: product.productId, missingFields });
    }
  }

  return { valid: productsMissingFields.length === 0, productsMissingFields };
}

export function formatValidationErrorSummary(result: ValidationResult): string {
  return result.productsMissingFields.map((p) => `${p.productId}: ${p.missingFields.join(", ")}`).join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/publication/validator.test.ts`
Expected: PASS — 7 tests green.

- [ ] **Step 5: Full check and commit**

Run: `npm run check`

```bash
git add src/publication/validator.ts test/publication/validator.test.ts
git commit -m "feat(publication): add whole-run completeness validator"
```

---

## Task 4: Deterministic 4-in-1 Cloudflare Images collage

**Files:**
- Create: `src/publication/collage.ts`
- Create: `docs/runbooks/collage-base-1080.jpg`
- Test: `test/publication/collage.test.ts`

**Interfaces:**
- Consumes: `R2Bucket`, and a structural `ImagesBinding` type matching the Cloudflare Images binding chain used below.
- Produces:
  ```ts
  export const COLLAGE_BASE_R2_KEY = "assets/collage-base-1080.jpg";
  export const COLLAGE_CANVAS_SIZE = 1080;
  export const COLLAGE_CELL_SIZE = 504;
  export const COLLAGE_GUTTER = 24;
  export const COLLAGE_CELL_POSITIONS: Array<{ top: number; left: number }>; // exactly 4, deterministic order

  export interface ImagesBinding {
    input(stream: ReadableStream | ArrayBuffer): ImageTransformer;
  }
  export interface ImageTransformer {
    transform(options: { width: number; height: number; fit: "contain"; background: string }): ImageTransformer;
    draw(overlay: ImageTransformer, options: { top: number; left: number; width: number; height: number }): ImageTransformer;
    output(options: { format: "image/jpeg"; quality: number }): Promise<{ response(): Response }>;
  }

  export async function generateCollage(
    bucket: R2Bucket,
    images: ImagesBinding,
    orderedR2Keys: [string, string, string, string],
  ): Promise<Uint8Array>;

  export function collageR2Key(productId: string): string; // `products/<productId>/collage/1080x1080.jpg`
  ```
  used by `publication/service.ts` (Task 9).

- [ ] **Step 1: Write the failing test**

```ts
// test/publication/collage.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  generateCollage,
  collageR2Key,
  COLLAGE_BASE_R2_KEY,
  COLLAGE_CELL_SIZE,
  COLLAGE_CELL_POSITIONS,
} from "../../src/publication/collage";
import type { ImagesBinding, ImageTransformer } from "../../src/publication/collage";

type ImageCall =
  | {
      op: "transform";
      options: Parameters<ImageTransformer["transform"]>[0];
    }
  | {
      op: "draw";
      options: Parameters<ImageTransformer["draw"]>[1];
    }
  | {
      op: "output";
      options: Parameters<ImageTransformer["output"]>[0];
    };

function fakeTransformer(calls: ImageCall[]): ImageTransformer {
  const transformer: ImageTransformer = {
    transform(options) {
      calls.push({ op: "transform", options });
      return transformer;
    },
    draw(_overlay, options) {
      calls.push({ op: "draw", options });
      return transformer;
    },
    async output(options) {
      calls.push({ op: "output", options });
      return {
        response: () =>
          new Response(new Uint8Array([1, 2, 3])),
      };
    },
  };
  return transformer;
}

function fakeBucket(keys: string[]): R2Bucket {
  return {
    async get(key: string) {
      if (!keys.includes(key)) return null;
      return {
        body: new ReadableStream(),
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

describe("collageR2Key", () => {
  it("builds the deterministic per-product collage key", () => {
    expect(collageR2Key("A-1001")).toBe("products/A-1001/collage/1080x1080.jpg");
  });
});

describe("generateCollage", () => {
  it("throws when the base canvas asset is missing from R2", async () => {
    const calls: ImageCall[] = [];
    const images: ImagesBinding = { input: () => fakeTransformer(calls) };
    const bucket = fakeBucket([]);
    await expect(
      generateCollage(bucket, images, ["assets/a.jpg", "assets/b.jpg", "assets/c.jpg", "assets/d.jpg"]),
    ).rejects.toThrow(/collage base/i);
  });

  it("throws when a source image key is missing from R2", async () => {
    const calls: ImageCall[] = [];
    const images: ImagesBinding = { input: () => fakeTransformer(calls) };
    const bucket = fakeBucket([COLLAGE_BASE_R2_KEY, "assets/a.jpg"]);
    await expect(
      generateCollage(bucket, images, ["assets/a.jpg", "assets/missing.jpg", "assets/c.jpg", "assets/d.jpg"]),
    ).rejects.toThrow(/source image/i);
  });

  it("applies deterministic contain-fit transform and draw offsets in ordered-image order", async () => {
    const calls: ImageCall[] = [];
    const images: ImagesBinding = { input: () => fakeTransformer(calls) };
    const keys: [string, string, string, string] = ["assets/a.jpg", "assets/b.jpg", "assets/c.jpg", "assets/d.jpg"];
    const bucket = fakeBucket([COLLAGE_BASE_R2_KEY, ...keys]);

    await generateCollage(bucket, images, keys);

    const transformCalls = calls.filter(
      (call): call is Extract<
        ImageCall,
        { op: "transform" }
      > => call.op === "transform",
    );
    expect(transformCalls).toHaveLength(4);
    for (const call of transformCalls) {
      expect(call.options).toEqual({
        width: COLLAGE_CELL_SIZE,
        height: COLLAGE_CELL_SIZE,
        fit: "contain",
        background: "#FFFFFF",
      });
    }

    const drawCalls = calls.filter(
      (call): call is Extract<ImageCall, { op: "draw" }> =>
        call.op === "draw",
    );
    expect(drawCalls).toHaveLength(4);
    expect(drawCalls.map(({ options }) => ({
      top: options.top,
      left: options.left,
    }))).toEqual(COLLAGE_CELL_POSITIONS);

    const outputCall = calls.find(
      (call): call is Extract<ImageCall, { op: "output" }> =>
        call.op === "output",
    );
    expect(outputCall?.options).toEqual({
      format: "image/jpeg",
      quality: 90,
    });
  });

  it("produces identical transform/draw call sequence across repeated runs (idempotent parameters)", async () => {
    const keys: [string, string, string, string] = ["assets/a.jpg", "assets/b.jpg", "assets/c.jpg", "assets/d.jpg"];
    const bucket = fakeBucket([COLLAGE_BASE_R2_KEY, ...keys]);

    const callsA: ImageCall[] = [];
    const imagesA: ImagesBinding = { input: () => fakeTransformer(callsA) };
    await generateCollage(bucket, imagesA, keys);

    const callsB: ImageCall[] = [];
    const imagesB: ImagesBinding = { input: () => fakeTransformer(callsB) };
    await generateCollage(bucket, imagesB, keys);

    expect(
      callsA.filter(({ op }) => op !== "output"),
    ).toEqual(
      callsB.filter(({ op }) => op !== "output"),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publication/collage.test.ts`
Expected: FAIL — `Cannot find module '../../src/publication/collage'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/publication/collage.ts
export const COLLAGE_BASE_R2_KEY = "assets/collage-base-1080.jpg";
export const COLLAGE_CANVAS_SIZE = 1080;
export const COLLAGE_CELL_SIZE = 504;
export const COLLAGE_GUTTER = 24;

export const COLLAGE_CELL_POSITIONS: Array<{ top: number; left: number }> = [
  { top: COLLAGE_GUTTER, left: COLLAGE_GUTTER },
  { top: COLLAGE_GUTTER, left: COLLAGE_GUTTER + COLLAGE_CELL_SIZE + COLLAGE_GUTTER },
  { top: COLLAGE_GUTTER + COLLAGE_CELL_SIZE + COLLAGE_GUTTER, left: COLLAGE_GUTTER },
  {
    top: COLLAGE_GUTTER + COLLAGE_CELL_SIZE + COLLAGE_GUTTER,
    left: COLLAGE_GUTTER + COLLAGE_CELL_SIZE + COLLAGE_GUTTER,
  },
];

export interface ImageTransformer {
  transform(options: { width: number; height: number; fit: "contain"; background: string }): ImageTransformer;
  draw(overlay: ImageTransformer, options: { top: number; left: number; width: number; height: number }): ImageTransformer;
  output(options: { format: "image/jpeg"; quality: number }): Promise<{ response(): Response }>;
}

export interface ImagesBinding {
  input(stream: ReadableStream | ArrayBuffer): ImageTransformer;
}

export function collageR2Key(productId: string): string {
  return `products/${productId}/collage/1080x1080.jpg`;
}

export async function generateCollage(
  bucket: R2Bucket,
  images: ImagesBinding,
  orderedR2Keys: [string, string, string, string],
): Promise<Uint8Array> {
  const base = await bucket.get(COLLAGE_BASE_R2_KEY);
  if (!base) {
    throw new Error(`collage base canvas missing from R2 at ${COLLAGE_BASE_R2_KEY}`);
  }

  let pipeline = images.input(base.body);

  for (const [index, key] of orderedR2Keys.entries()) {
    const position = COLLAGE_CELL_POSITIONS[index];
    if (!position) {
      throw new Error(`collage position missing at index ${index}`);
    }
    const object = await bucket.get(key);
    if (!object) {
      throw new Error(
        `collage source image missing from R2 at position ${index}: ${key}`,
      );
    }
    const cell = images
      .input(object.body)
      .transform({
        width: COLLAGE_CELL_SIZE,
        height: COLLAGE_CELL_SIZE,
        fit: "contain",
        background: "#FFFFFF",
      });
    pipeline = pipeline.draw(cell, {
      ...position,
      width: COLLAGE_CELL_SIZE,
      height: COLLAGE_CELL_SIZE,
    });
  }

  const result = await pipeline.output({ format: "image/jpeg", quality: 90 });
  const buffer = await result.response().arrayBuffer();
  return new Uint8Array(buffer);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/publication/collage.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Generate the deterministic white base canvas**

Use already-installed `jpeg-js`; no image CLI or new dependency is required:

```bash
node --input-type=module -e 'import fs from "node:fs"; import jpeg from "jpeg-js"; const width=1080; const height=1080; const data=Buffer.alloc(width*height*4,255); fs.writeFileSync("docs/runbooks/collage-base-1080.jpg", jpeg.encode({data,width,height},90).data)'
```

Run: `node -e 'const fs=require("node:fs"); const jpeg=require("jpeg-js"); const decoded=jpeg.decode(fs.readFileSync("docs/runbooks/collage-base-1080.jpg")); if(decoded.width!==1080||decoded.height!==1080) process.exit(1)'`
Expected: exit 0.

- [ ] **Step 6: Full check and commit**

Run: `npm run check`

```bash
git add src/publication/collage.ts test/publication/collage.test.ts docs/runbooks/collage-base-1080.jpg
git commit -m "feat(publication): add deterministic 4-in-1 Cloudflare Images collage"
```

---

## Task 4A: Reuse private R2 asset delivery for collages

**Files:**
- Modify: `test/import/asset-store.test.ts` (extend existing shared signer test)

**Interfaces:**
- Consumes: `createAssetStore(bucket, config, clock): AssetStore` and `AssetStore.signUrl(r2Key, ttlSeconds): Promise<string>` from Import Task 6; existing authenticated `GET /assets/:encodedKey` route from Import Task 7; `AppConfig.publicBaseUrl`; `Env.ASSET_URL_SIGNING_SECRET`.
- Produces: no new production symbol. Publication Task 9 receives the existing `AssetStore` and calls `assets.signUrl(collageR2Key, 900)`.

The import plan already implements HMAC signing and private R2 delivery for any persisted object key. Do not create `src/publication/asset-url.ts`, a second asset route, or any call to nonexistent `R2Bucket.createSignedUrl`. Signed URLs are temporary Airtable/Google ingestion URLs; never persist or log them.

- [ ] **Step 1: Extend the existing failing signer test with a collage key**

```ts
// test/import/asset-store.test.ts — append inside the existing createAssetStore describe block
it("signs a generated collage through the same private asset route", async () => {
  const clock = fixedClock("2026-09-01T05:00:00.000Z");
  const store = createAssetStore(
    env.IMAGES_BUCKET,
    {
      signingSecret: "test-signing-secret",
      publicBaseUrl: "https://worker.example",
    },
    clock,
  );

  const url = new URL(
    await store.signUrl(
      "products/A-1001/collage/1080x1080.jpg",
      900,
    ),
  );

  expect(url.origin).toBe("https://worker.example");
  expect(decodeURIComponent(url.pathname)).toContain(
    "products/A-1001/collage/1080x1080.jpg",
  );
  expect(url.searchParams.get("expires")).toBeTruthy();
  expect(url.searchParams.get("signature")).toBeTruthy();
});
```

- [ ] **Step 2: Run the focused test**

Run: `npx vitest run test/import/asset-store.test.ts -t "generated collage"`
Expected: PASS because shared `AssetStore.signUrl` is key-agnostic and already signs the object path plus expiry. If this fails because Import Task 6 restricts keys to `assets/`, remove that unnecessary prefix restriction while retaining path canonicalization and signature verification; add the collage case to the same test file.

- [ ] **Step 3: Run full check and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add src/import/asset-store.ts test/import/asset-store.test.ts
git commit -m "test(publication): reuse private asset signing for collages"
```

---

## Task 5: Anthropic SDK caption generation with schema validation and deterministic batching

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/publication/captions.ts`
- Test: `test/publication/captions.test.ts`

**Dependency setup (before Step 1):**

```bash
npm install @anthropic-ai/sdk
```

This must complete before compiling the failing test; production code imports SDK types and later constructs the official client.

**Interfaces:**
- Consumes: `CaptionSet`, `PublicationProduct` from `src/publication/types.ts`, `AppConfig` from `src/config.ts`.
- Produces:
  ```ts
  export interface CaptionRequestProduct {
    productId: string;
    brandName: string;
    modelName: string;
    conditionType: string;
    size: string;
    description: string;
  }

  export interface CaptionGenerationOutcome {
    captions: CaptionSet[];
    missingProductIds: string[];
  }

  export function toCaptionRequestProducts(products: PublicationProduct[]): CaptionRequestProduct[];

  export async function planCaptionBatches(
    client: Pick<Anthropic, "messages">,
    model: string,
    products: CaptionRequestProduct[],
    inputTokenLimit: number,
  ): Promise<CaptionRequestProduct[][]>;

  export async function requestCaptionBatch(
    client: Pick<Anthropic, "messages">,
    model: string,
    products: CaptionRequestProduct[],
  ): Promise<CaptionGenerationOutcome>;

  export async function generateCaptionsForRun(
    client: Pick<Anthropic, "messages">,
    model: string,
    inputTokenLimit: number,
    products: CaptionRequestProduct[],
  ): Promise<CaptionGenerationOutcome>;
  ```
  used by `publication/service.ts` (Task 9).

- [ ] **Step 1: Write the failing test**

```ts
// test/publication/captions.test.ts
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  toCaptionRequestProducts,
  planCaptionBatches,
  requestCaptionBatch,
  generateCaptionsForRun,
} from "../../src/publication/captions";
import type { CaptionRequestProduct } from "../../src/publication/captions";
import type { PublicationProduct } from "../../src/publication/types";

function product(productId: string): PublicationProduct {
  return {
    airtableRecordId: `rec-${productId}`,
    productId,
    orderedImageKeys: ["a", "b", "c", "d"],
    brandName: "Nike",
    modelName: "Air Max",
    conditionType: "Used",
    size: "42",
    description: "Good condition",
    lineSquarePrice: 1290,
    igPrice: 1390,
  };
}

function toolResponse(captions: Array<{ productId: string; drafts: string[] }>) {
  return {
    content: [
      {
        type: "tool_use",
        name: "submit_captions",
        input: { captions },
      },
    ],
  };
}

type CountTokensParams = Parameters<
  Anthropic["messages"]["countTokens"]
>[0];

function sdkClient(
  messages: Record<string, ReturnType<typeof vi.fn>>,
): Pick<Anthropic, "messages"> {
  // Test-only structural stub. Production always constructs official Anthropic SDK client.
  return { messages } as unknown as Pick<Anthropic, "messages">;
}

describe("toCaptionRequestProducts", () => {
  it("maps only the text fields Claude needs, no images", () => {
    const result = toCaptionRequestProducts([product("A-1001")]);
    expect(result).toEqual([
      {
        productId: "A-1001",
        brandName: "Nike",
        modelName: "Air Max",
        conditionType: "Used",
        size: "42",
        description: "Good condition",
      },
    ]);
  });
});

describe("planCaptionBatches", () => {
  it("returns a single batch when the estimated token count fits the limit", async () => {
    const client = sdkClient({
      countTokens: vi.fn().mockResolvedValue({ input_tokens: 500 }),
    });
    const products = [toCaptionRequestProducts([product("A-1001")])[0]!, toCaptionRequestProducts([product("A-1002")])[0]!];
    const batches = await planCaptionBatches(client, "claude-opus-5", products, 1000);
    expect(batches).toEqual([products.sort((a, b) => a.productId.localeCompare(b.productId))]);
  });

  it("splits deterministically by sorted Product ID when over the limit", async () => {
    const client = sdkClient({
      countTokens: vi.fn().mockImplementation(
        async ({ messages }: CountTokensParams) => {
          const text = messages[0]!.content as string;
          const productCount =
            (text.match(/"productId"/g) ?? []).length;
          return {
            input_tokens: productCount > 1 ? 2000 : 400,
          };
        },
      ),
    });
    const products = ["A-1003", "A-1001", "A-1002", "A-1004"].map((id) => toCaptionRequestProducts([product(id)])[0]!);
    const batches = await planCaptionBatches(client, "claude-opus-5", products, 1000);
    expect(batches.every((batch) => batch.length === 1)).toBe(true);
    expect(batches.map((batch) => batch[0]!.productId)).toEqual(["A-1001", "A-1002", "A-1003", "A-1004"]);
  });

  it("uses the smallest number of deterministic Product-ID-ordered batches", async () => {
    const tokenWeights = new Map([
      ["A-1001", 700],
      ["A-1002", 100],
      ["A-1003", 100],
      ["A-1004", 100],
      ["A-1005", 100],
    ]);
    const client = sdkClient({
      countTokens: vi.fn().mockImplementation(
        async ({ messages }: CountTokensParams) => {
          const text = messages[0]!.content as string;
          const productIds = [
            ...text.matchAll(/Product ID: (A-\d+)/g),
          ].map((match) => match[1]!);
          return {
            input_tokens: productIds.reduce(
              (total, productId) =>
                total + (tokenWeights.get(productId) ?? 0),
              0,
            ),
          };
        },
      ),
    });
    const products = [
      "A-1005",
      "A-1001",
      "A-1004",
      "A-1002",
      "A-1003",
    ].map(
      (id) => toCaptionRequestProducts([product(id)])[0]!,
    );

    const batches = await planCaptionBatches(
      client,
      "claude-opus-5",
      products,
      800,
    );

    expect(batches.map((batch) =>
      batch.map(({ productId }) => productId))).toEqual([
      ["A-1001", "A-1002"],
      ["A-1003", "A-1004", "A-1005"],
    ]);
  });

  it("rejects one Product that exceeds the configured input-token limit", async () => {
    const client = sdkClient({
      countTokens: vi.fn().mockResolvedValue({
        input_tokens: 1_001,
      }),
    });

    await expect(planCaptionBatches(
      client,
      "claude-opus-5",
      [toCaptionRequestProducts([product("A-1001")])[0]!],
      1_000,
    )).rejects.toMatchObject({
      code: "anthropic_input_too_large",
      retryable: false,
    });
  });

  it("classifies a permanent count-tokens rejection as non-retryable", async () => {
    const client = sdkClient({
      countTokens: vi.fn().mockRejectedValue({ status: 401 }),
    });

    await expect(planCaptionBatches(
      client,
      "claude-opus-5",
      [toCaptionRequestProducts([product("A-1001")])[0]!],
      1_000,
    )).rejects.toMatchObject({
      code: "anthropic_count_tokens_failed",
      retryable: false,
    });
  });
});

describe("requestCaptionBatch", () => {
  it("returns three Thai drafts per requested Product ID on a clean response", async () => {
    const create = vi.fn().mockResolvedValue(
      toolResponse([
        {
          productId: "A-1001",
          drafts: ["หนึ่ง", "สอง", "สาม"],
        },
      ]),
    );
    const client = sdkClient({ create });
    const outcome = await requestCaptionBatch(client, "claude-opus-5", [toCaptionRequestProducts([product("A-1001")])[0]!]);
    expect(outcome).toEqual({ captions: [{ productId: "A-1001", drafts: ["หนึ่ง", "สอง", "สาม"] }], missingProductIds: [] });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-opus-5",
        thinking: { type: "adaptive" },
        tool_choice: { type: "tool", name: "submit_captions" },
      }),
    );
    const request = create.mock.calls[0]![0];
    expect(JSON.stringify(request.messages)).not.toContain("orderedImageKeys");
    expect(JSON.stringify(request.messages)).not.toContain("assets/");
  });

  it("marks only the Product IDs with missing or invalid captions for retry", async () => {
    const client = sdkClient({
      create: vi.fn().mockResolvedValue(
        toolResponse([
          {
            productId: "A-1001",
            drafts: ["หนึ่ง", "สอง", "สาม"],
          },
          {
            productId: "A-1002",
            drafts: ["one", "two", "three"],
          },
        ]),
      ),
    });
    const requested = [toCaptionRequestProducts([product("A-1001")])[0]!, toCaptionRequestProducts([product("A-1002")])[0]!];
    const outcome = await requestCaptionBatch(client, "claude-opus-5", requested);
    expect(outcome.captions).toEqual([{ productId: "A-1001", drafts: ["หนึ่ง", "สอง", "สาม"] }]);
    expect(outcome.missingProductIds).toEqual(["A-1002"]);
  });

  it("marks every requested Product ID for retry when the response cannot be parsed", async () => {
    const client = sdkClient({
      create: vi.fn().mockResolvedValue({ content: [] }),
    });
    const requested = [toCaptionRequestProducts([product("A-1001")])[0]!, toCaptionRequestProducts([product("A-1002")])[0]!];
    const outcome = await requestCaptionBatch(client, "claude-opus-5", requested);
    expect(outcome.captions).toEqual([]);
    expect(outcome.missingProductIds).toEqual(["A-1001", "A-1002"]);
  });

  it("marks every requested Product ID for retry when the tool call throws", async () => {
    const client = sdkClient({
      create: vi
        .fn()
        .mockRejectedValue(new Error("rate limited")),
    });
    const requested = [toCaptionRequestProducts([product("A-1001")])[0]!];
    const outcome = await requestCaptionBatch(client, "claude-opus-5", requested);
    expect(outcome.missingProductIds).toEqual(["A-1001"]);
  });

  it("classifies a permanent Messages API rejection as non-retryable", async () => {
    const client = sdkClient({
      create: vi.fn().mockRejectedValue({ status: 401 }),
    });
    const requested = [
      toCaptionRequestProducts([product("A-1001")])[0]!,
    ];

    await expect(requestCaptionBatch(
      client,
      "claude-opus-5",
      requested,
    )).rejects.toMatchObject({
      code: "anthropic_create_message_failed",
      retryable: false,
    });
  });

  it("marks every requested Product ID for retry when returned IDs don't match the requested set", async () => {
    const client = sdkClient({
      create: vi.fn().mockResolvedValue(
        toolResponse([
          {
            productId: "A-9999",
            drafts: ["หนึ่ง", "สอง", "สาม"],
          },
        ]),
      ),
    });
    const requested = [toCaptionRequestProducts([product("A-1001")])[0]!];
    const outcome = await requestCaptionBatch(client, "claude-opus-5", requested);
    expect(outcome.captions).toEqual([]);
    expect(outcome.missingProductIds).toEqual(["A-1001"]);
  });
});

describe("generateCaptionsForRun", () => {
  it("batches, requests, and merges captions keyed by Product ID across batches", async () => {
    const client = sdkClient({
      countTokens: vi.fn().mockResolvedValue({
        input_tokens: 100,
      }),
      create: vi.fn().mockResolvedValueOnce(
        toolResponse([
          {
            productId: "A-1001",
            drafts: ["หนึ่ง", "สอง", "สาม"],
          },
          {
            productId: "A-1002",
            drafts: ["สี่", "ห้า", "หก"],
          },
        ]),
      ),
    });
    const products = ["A-1001", "A-1002"].map((id) => toCaptionRequestProducts([product(id)])[0]!);
    const outcome = await generateCaptionsForRun(client, "claude-opus-5", 1000, products);
    expect(outcome.captions.map((c) => c.productId).sort()).toEqual(["A-1001", "A-1002"]);
    expect(outcome.missingProductIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publication/captions.test.ts`
Expected: FAIL — `Cannot find module '../../src/publication/captions'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/publication/captions.ts
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { OperationalError } from "../shared/errors";
import type { CaptionSet, PublicationProduct } from "./types";

export interface CaptionRequestProduct {
  productId: string;
  brandName: string;
  modelName: string;
  conditionType: string;
  size: string;
  description: string;
}

export interface CaptionGenerationOutcome {
  captions: CaptionSet[];
  missingProductIds: string[];
}

const CAPTIONS_TOOL_SCHEMA = {
  name: "submit_captions",
  description: "Submit exactly three Thai caption drafts for each requested Product ID.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      captions: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            productId: { type: "string" as const },
            drafts: { type: "array" as const, items: { type: "string" as const }, minItems: 3, maxItems: 3 },
          },
          required: ["productId", "drafts"],
          additionalProperties: false,
        },
      },
    },
    required: ["captions"],
    additionalProperties: false,
  },
};

const ThaiDraftSchema = z.string()
  .trim()
  .min(1)
  .max(400)
  .regex(/[ก-๙]/);

const ResponseSchema = z.object({
  captions: z.array(
    z.object({
      productId: z.string(),
      drafts: z.tuple([
        ThaiDraftSchema,
        ThaiDraftSchema,
        ThaiDraftSchema,
      ]),
    }),
  ),
});

export function toCaptionRequestProducts(products: PublicationProduct[]): CaptionRequestProduct[] {
  return products.map((p) => ({
    productId: p.productId,
    brandName: p.brandName,
    modelName: p.modelName,
    conditionType: p.conditionType,
    size: p.size,
    description: p.description,
  }));
}

function buildPrompt(products: CaptionRequestProduct[]): string {
  const lines = products.map(
    (p) =>
      `Product ID: ${p.productId}\nBrand: ${p.brandName}\nModel: ${p.modelName}\nCondition: ${p.conditionType}\nSize: ${p.size}\nDescription: ${p.description}`,
  );
  return [
    "Write exactly three short Thai marketplace caption drafts for each product below.",
    "Use only the facts given. Do not invent details. Keep each draft under 400 Thai characters.",
    "Call submit_captions with one entry per Product ID, in the same order as given.",
    "",
    ...lines,
  ].join("\n\n");
}

function buildRequestParams(model: string, products: CaptionRequestProduct[]) {
  return {
    model,
    max_tokens: 16000,
    thinking: { type: "adaptive" as const },
    tools: [CAPTIONS_TOOL_SCHEMA],
    tool_choice: { type: "tool" as const, name: "submit_captions" },
    messages: [{ role: "user" as const, content: buildPrompt(products) }],
  };
}

function apiStatus(error: unknown): number | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("status" in error)
  ) {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function rethrowPermanentAnthropicError(
  error: unknown,
  action: "count_tokens" | "create_message",
): void {
  const status = apiStatus(error);
  if (
    status !== null &&
    status >= 400 &&
    status < 500 &&
    status !== 429
  ) {
    throw new OperationalError(
      `anthropic_${action}_failed`,
      `Anthropic ${action} failed with status ${status}`,
      false,
    );
  }
}

async function countInputTokens(
  client: Pick<Anthropic, "messages">,
  model: string,
  products: CaptionRequestProduct[],
): Promise<number> {
  const params = buildRequestParams(model, products);
  try {
    const result = await client.messages.countTokens({
      model: params.model,
      messages: params.messages,
      tools: params.tools,
    });
    return result.input_tokens;
  } catch (error) {
    rethrowPermanentAnthropicError(
      error,
      "count_tokens",
    );
    throw error;
  }
}

export async function planCaptionBatches(
  client: Pick<Anthropic, "messages">,
  model: string,
  products: CaptionRequestProduct[],
  inputTokenLimit: number,
): Promise<CaptionRequestProduct[][]> {
  const sorted = [...products].sort(
    (a, b) => a.productId.localeCompare(b.productId),
  );
  const batches: CaptionRequestProduct[][] = [];
  let current: CaptionRequestProduct[] = [];

  for (const product of sorted) {
    const candidate = [...current, product];
    const candidateTokens = await countInputTokens(
      client,
      model,
      candidate,
    );
    if (candidateTokens <= inputTokenLimit) {
      current = candidate;
      continue;
    }

    if (current.length === 0) {
      throw new OperationalError(
        "anthropic_input_too_large",
        `Product ${product.productId} exceeds the configured Claude input-token limit`,
        false,
      );
    }

    batches.push(current);
    const singleTokens = await countInputTokens(
      client,
      model,
      [product],
    );
    if (singleTokens > inputTokenLimit) {
      throw new OperationalError(
        "anthropic_input_too_large",
        `Product ${product.productId} exceeds the configured Claude input-token limit`,
        false,
      );
    }
    current = [product];
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

export async function requestCaptionBatch(
  client: Pick<Anthropic, "messages">,
  model: string,
  products: CaptionRequestProduct[],
): Promise<CaptionGenerationOutcome> {
  const requestedIds = new Set(products.map((p) => p.productId));
  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create(
      buildRequestParams(model, products),
    );
  } catch (error) {
    rethrowPermanentAnthropicError(
      error,
      "create_message",
    );
    return {
      captions: [],
      missingProductIds: [...requestedIds],
    };
  }

  const toolUse = response.content.find(
    (block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use" && block.name === "submit_captions",
  );
  if (!toolUse) {
    return { captions: [], missingProductIds: [...requestedIds] };
  }

  const parsed = ResponseSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    return { captions: [], missingProductIds: [...requestedIds] };
  }

  const returnedIds = new Set(parsed.data.captions.map((c) => c.productId));
  const hasInvalidIdSet =
    parsed.data.captions.length !== requestedIds.size ||
    returnedIds.size !== requestedIds.size ||
    [...returnedIds].some((id) => !requestedIds.has(id));
  if (hasInvalidIdSet) {
    return { captions: [], missingProductIds: [...requestedIds] };
  }

  const captions: CaptionSet[] = [];
  const missingProductIds: string[] = [];
  for (const productId of requestedIds) {
    const match = parsed.data.captions.find((c) => c.productId === productId);
    if (match) {
      captions.push({ productId, drafts: match.drafts });
    } else {
      missingProductIds.push(productId);
    }
  }

  return { captions, missingProductIds };
}

export async function generateCaptionsForRun(
  client: Pick<Anthropic, "messages">,
  model: string,
  inputTokenLimit: number,
  products: CaptionRequestProduct[],
): Promise<CaptionGenerationOutcome> {
  if (products.length === 0) return { captions: [], missingProductIds: [] };

  const batches = await planCaptionBatches(client, model, products, inputTokenLimit);
  const captions: CaptionSet[] = [];
  const missingProductIds: string[] = [];

  for (const batch of batches) {
    const outcome = await requestCaptionBatch(client, model, batch);
    captions.push(...outcome.captions);
    missingProductIds.push(...outcome.missingProductIds);
  }

  return { captions, missingProductIds };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/publication/captions.test.ts`
Expected: PASS — 13 tests green.

- [ ] **Step 5: Full check and commit**

Run: `npm run check`

```bash
git add package.json package-lock.json src/publication/captions.ts test/publication/captions.test.ts
git commit -m "feat(publication): add Anthropic SDK caption generation with schema validation and deterministic batching"
```

---

## Task 6: Google service-account JWT client

**Files:**
- Create: `src/publication/google-auth.ts`
- Test: `test/publication/google-auth.test.ts`

**Interfaces:**
- Consumes: `Clock`, `Fetcher` (structural types already used across the codebase).
- Produces:
  ```ts
  export interface GoogleServiceAccountJson {
    client_email: string;
    private_key: string;
  }

  export interface AccessTokenProvider {
    getAccessToken(): Promise<string>;
  }

  export function parseServiceAccountJson(json: string): GoogleServiceAccountJson;

  export async function signServiceAccountJwt(
    account: GoogleServiceAccountJson,
    clock: Clock,
    scopes: string[],
  ): Promise<string>;

  export function createGoogleAuthClient(
    serviceAccountJsonText: string,
    clock: Clock,
    fetcher: Fetcher,
  ): AccessTokenProvider;
  ```
  used by `publication/google-docs.ts` (Task 7) and `publication/service.ts` (Task 9).

- [ ] **Step 1: Write the failing test**

```ts
// test/publication/google-auth.test.ts
import { describe, expect, it, vi, beforeAll } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { signServiceAccountJwt, createGoogleAuthClient, parseServiceAccountJson } from "../../src/publication/google-auth";

let privateKeyPem: string;
let publicKeyDer: ArrayBuffer;

beforeAll(() => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privateKeyPem = privateKey;
  const publicPem = publicKey;
  const body = publicPem.replace(/-----BEGIN PUBLIC KEY-----/, "").replace(/-----END PUBLIC KEY-----/, "").replace(/\s+/g, "");
  publicKeyDer = Uint8Array.from(atob(body), (c) => c.charCodeAt(0)).buffer;
});

function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  return atob(padded);
}

describe("parseServiceAccountJson", () => {
  it("extracts and validates client_email and PKCS#8 private_key", () => {
    const result = parseServiceAccountJson(JSON.stringify({
      client_email: "svc@example.iam.gserviceaccount.com",
      private_key: privateKeyPem,
    }));
    expect(result).toEqual({
      client_email: "svc@example.iam.gserviceaccount.com",
      private_key: privateKeyPem,
    });
  });

  it("rejects malformed secret JSON at the configuration boundary", () => {
    expect(() => parseServiceAccountJson(JSON.stringify({
      client_email: "not-an-email",
      private_key: "not-a-key",
    }))).toThrow();
  });
});

describe("signServiceAccountJwt", () => {
  it("produces a JWT with correct header, claims, and a verifiable RS256 signature", async () => {
    const clock = { now: () => new Date("2026-09-01T05:00:00.000Z") };
    const jwt = await signServiceAccountJwt(
      { client_email: "svc@example.iam.gserviceaccount.com", private_key: privateKeyPem },
      clock,
      ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/documents"],
    );

    const [headerB64, claimsB64, signatureB64] = jwt.split(".");
    if (!headerB64 || !claimsB64 || !signatureB64) {
      throw new Error("JWT must contain three segments");
    }
    const header = JSON.parse(base64UrlDecode(headerB64));
    const claims = JSON.parse(base64UrlDecode(claimsB64));

    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims.iss).toBe("svc@example.iam.gserviceaccount.com");
    expect(claims.scope).toBe("https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claims.iat).toBe(1756702800);
    expect(claims.exp).toBe(1756706400);

    const publicKey = await crypto.subtle.importKey("spki", publicKeyDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signingInput = `${headerB64}.${claimsB64}`;
    const signatureBytes = Uint8Array.from(base64UrlDecode(signatureB64), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      signatureBytes,
      new TextEncoder().encode(signingInput),
    );
    expect(valid).toBe(true);
  });
});

describe("createGoogleAuthClient", () => {
  it("exchanges the signed JWT for an access token and caches it until near expiry", async () => {
    const clock = { now: () => new Date("2026-09-01T05:00:00.000Z") };
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "token-1",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );
    const client = createGoogleAuthClient(
      JSON.stringify({ client_email: "svc@example.iam.gserviceaccount.com", private_key: privateKeyPem }),
      clock,
      fetcher,
    );

    const first = await client.getAccessToken();
    const second = await client.getAccessToken();

    expect(first).toBe("token-1");
    expect(second).toBe("token-1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refreshes the token once it expires", async () => {
    let currentTime = new Date("2026-09-01T05:00:00.000Z");
    const clock = { now: () => currentTime };
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token-1", expires_in: 60 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token-2", expires_in: 3600 }), { status: 200 }));
    const client = createGoogleAuthClient(
      JSON.stringify({ client_email: "svc@example.iam.gserviceaccount.com", private_key: privateKeyPem }),
      clock,
      fetcher,
    );

    const first = await client.getAccessToken();
    currentTime = new Date("2026-09-01T05:02:00.000Z");
    const second = await client.getAccessToken();

    expect(first).toBe("token-1");
    expect(second).toBe("token-2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [429, true],
    [400, false],
  ])(
    "classifies token endpoint status %i with retryable=%s",
    async (status, retryable) => {
      const clock = {
        now: () => new Date("2026-09-01T05:00:00.000Z"),
      };
      const fetcher = vi.fn<Fetcher>().mockResolvedValue(
        new Response(null, { status }),
      );
      const client = createGoogleAuthClient(
        JSON.stringify({
          client_email:
            "svc@example.iam.gserviceaccount.com",
          private_key: privateKeyPem,
        }),
        clock,
        fetcher,
      );

      await expect(client.getAccessToken())
        .rejects.toMatchObject({
          code: "google_token_exchange_failed",
          retryable,
        });
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publication/google-auth.test.ts`
Expected: FAIL — `Cannot find module '../../src/publication/google-auth'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/publication/google-auth.ts
import { z } from "zod";
import { OperationalError } from "../shared/errors";
import type { Clock } from "../shared/time";
import type { Fetcher } from "../shared/http";

export interface GoogleServiceAccountJson {
  client_email: string;
  private_key: string;
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

const ServiceAccountSchema = z.object({
  client_email: z.string().email(),
  private_key: z.string().refine(
    (value) => value.includes("-----BEGIN PRIVATE KEY-----"),
    "private_key must be PKCS#8 PEM",
  ),
});

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

export function parseServiceAccountJson(json: string): GoogleServiceAccountJson {
  return ServiceAccountSchema.parse(JSON.parse(json));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(input: string): string {
  return base64UrlEncode(new TextEncoder().encode(input));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const binary = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", binary.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export async function signServiceAccountJwt(account: GoogleServiceAccountJson, clock: Clock, scopes: string[]): Promise<string> {
  const nowSeconds = Math.floor(clock.now().getTime() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: account.client_email,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };

  const signingInput = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(JSON.stringify(claims))}`;
  const key = await importPrivateKey(account.private_key);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/documents"];
const TOKEN_REFRESH_SKEW_SECONDS = 60;

export function createGoogleAuthClient(serviceAccountJsonText: string, clock: Clock, fetcher: Fetcher): AccessTokenProvider {
  const account = parseServiceAccountJson(serviceAccountJsonText);
  let cachedToken: string | null = null;
  let cachedExpiryMs = 0;

  return {
    async getAccessToken(): Promise<string> {
      const nowMs = clock.now().getTime();
      if (cachedToken && nowMs < cachedExpiryMs) {
        return cachedToken;
      }

      const jwt = await signServiceAccountJwt(account, clock, GOOGLE_SCOPES);
      const response = await fetcher("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: jwt,
        }).toString(),
      });

      if (!response.ok) {
        throw new OperationalError(
          "google_token_exchange_failed",
          `Google token exchange failed with status ${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      }

      const body = TokenResponseSchema.parse(await response.json());
      cachedToken = body.access_token;
      cachedExpiryMs = nowMs + (body.expires_in - TOKEN_REFRESH_SKEW_SECONDS) * 1000;
      return cachedToken;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/publication/google-auth.test.ts`
Expected: PASS — 7 tests green.

- [ ] **Step 5: Full check and commit**

Run: `npm run check`

```bash
git add src/publication/google-auth.ts test/publication/google-auth.test.ts
git commit -m "feat(publication): add Google service-account JWT client using Web Crypto"
```

---

## Task 7: Google Drive/Docs client — template copy, placeholder fill, verification, finalize, cleanup

**Files:**
- Create: `src/publication/google-docs.ts`
- Test: `test/publication/google-docs.test.ts`

**Interfaces:**
- Consumes: `AccessTokenProvider` (Task 6), `AppConfig`, `Fetcher`, `PublicationProduct`, `CaptionSet` from `src/publication/types.ts`.
- Produces:
  ```ts
  export interface DocProductContent {
    productId: string;
    conditionType: string;
    description: string;
    lineSquarePrice: number;
    igPrice: number;
    captionDrafts: [string, string, string];
    collageImageUrl: string;
  }

  export async function findTemporaryDocument(
    fetcher: Fetcher,
    tokenProvider: AccessTokenProvider,
    driveFolderId: string,
    publicationRunId: string,
  ): Promise<string | null>;

  export async function copyTemplate(
    fetcher: Fetcher,
    tokenProvider: AccessTokenProvider,
    templateDocId: string,
    driveFolderId: string,
    publicationRunId: string,
    newTitle: string,
  ): Promise<string>; // tags the copy with appProperties.publicationRunId and returns copied doc id

  export type GoogleDocsRequest =
    | {
        deleteContentRange: {
          range: { startIndex: number; endIndex: number };
        };
      }
    | {
        insertText: {
          location: { index: number };
          text: string;
        };
      }
    | {
        insertInlineImage: {
          location: { index: number };
          uri: string;
          objectSize: {
            width: { magnitude: number; unit: "PT" };
            height: { magnitude: number; unit: "PT" };
          };
        };
      }
    | {
        replaceAllText: {
          containsText: { text: string; matchCase: boolean };
          replaceText: string;
        };
      };

  export function buildBatchUpdateRequests(
    publicationDateText: string,
    products: DocProductContent[],
    suffixText: string,
    insertionIndex: number,
    deletionEndIndex: number,
  ): GoogleDocsRequest[]; // one atomic Google Docs batchUpdate request array

  export async function fillTemplate(
    fetcher: Fetcher,
    tokenProvider: AccessTokenProvider,
    docId: string,
    publicationDateText: string,
    products: DocProductContent[],
  ): Promise<void>;

  export async function verifyDocumentContainsProducts(
    fetcher: Fetcher,
    tokenProvider: AccessTokenProvider,
    docId: string,
    expectedProductIds: string[],
  ): Promise<{ ok: true } | { ok: false; missingProductIds: string[] }>;

  export async function finalizeDocument(
    fetcher: Fetcher,
    tokenProvider: AccessTokenProvider,
    docId: string,
    finalTitle: string,
  ): Promise<string>; // returns https://docs.google.com/document/d/<id>/edit URL

  export async function deleteDocument(fetcher: Fetcher, tokenProvider: AccessTokenProvider, docId: string): Promise<void>;
  ```
  used by `publication/service.ts` (Task 9).

Template contract (documented for the customer-facing template, referenced by the setup runbook): the master template contains the literal tokens `{{PUBLICATION_DATE}}`, `{{PRODUCTS}}`, and `{{END_PRODUCTS}}`. Each marker must remain inside one Google Docs text run. Everything between `{{PRODUCTS}}` and `{{END_PRODUCTS}}` is one plain-text suffix block captured once and repeated after every generated product section. One atomic `batchUpdate` deletes the full marker region, inserts products at that exact document index in reverse request order so final Product order stays correct, then replaces the date token.

- [ ] **Step 1: Write the failing test**

```ts
// test/publication/google-docs.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  findTemporaryDocument,
  copyTemplate,
  buildBatchUpdateRequests,
  fillTemplate,
  verifyDocumentContainsProducts,
  finalizeDocument,
  deleteDocument,
} from "../../src/publication/google-docs";
import type {
  DocProductContent,
  GoogleDocsRequest,
} from "../../src/publication/google-docs";
import type { Fetcher } from "../../src/shared/http";

function tokenProvider(token = "access-token-1") {
  return {
    getAccessToken: vi.fn().mockResolvedValue(token),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("temporary document discovery and copy", () => {
  it("finds the existing copy by parent folder and private app property", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ files: [{ id: "copied-doc-1" }] }));
    const id = await findTemporaryDocument(fetcher, tokenProvider(), "folder-1", "rec-run-1");
    expect(id).toBe("copied-doc-1");
    const [url] = fetcher.mock.calls[0]!;
    const query = new URL(String(url)).searchParams.get("q");
    expect(query).toContain("'folder-1' in parents");
    expect(query).toContain("key='publicationRunId'");
    expect(query).toContain("value='rec-run-1'");
  });

  it("tags a new Drive copy with the Publication Run ID", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ id: "copied-doc-1" }));
    const id = await copyTemplate(
      fetcher,
      tokenProvider(),
      "template-doc-1",
      "folder-1",
      "rec-run-1",
      "Publication 2026-09-01 (in progress)",
    );
    expect(id).toBe("copied-doc-1");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain("template-doc-1/copy");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Publication 2026-09-01 (in progress)",
      parents: ["folder-1"],
      appProperties: { publicationRunId: "rec-run-1" },
    });
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer access-token-1",
    );
  });

  it("rejects a malformed successful Drive response", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ id: 42 }));

    await expect(
      copyTemplate(
        fetcher,
        tokenProvider(),
        "template-doc-1",
        "folder-1",
        "rec-run-1",
        "Publication 2026-09-01 (in progress)",
      ),
    ).rejects.toThrow("google drive copy returned a malformed response");
  });
});

const sampleProduct: DocProductContent = {
  productId: "A-1001",
  conditionType: "Used",
  description: "Good condition",
  lineSquarePrice: 1290,
  igPrice: 1390,
  captionDrafts: ["draft1", "draft2", "draft3"],
  collageImageUrl: "https://r2.example.com/signed/A-1001.jpg",
};

describe("buildBatchUpdateRequests", () => {
  it("produces a replaceAllText request for the date and one insertText per product field", () => {
    const requests = buildBatchUpdateRequests(
      "1 กันยายน 2569",
      [sampleProduct],
      "-- end of listing --",
      32,
      63,
    );
    const dateRequest = requests.find(
      (request): request is Extract<
        GoogleDocsRequest,
        { replaceAllText: unknown }
      > => "replaceAllText" in request,
    );
    expect(dateRequest?.replaceAllText.replaceText).toBe(
      "1 กันยายน 2569",
    );

    const combinedText = requests
      .filter(
        (request): request is Extract<
          GoogleDocsRequest,
          { insertText: unknown }
        > => "insertText" in request,
      )
      .map(({ insertText }) => insertText.text)
      .join("");
    expect(combinedText).toContain("A-1001");
    expect(combinedText).toContain("Used");
    expect(combinedText).toContain("Good condition");
    expect(combinedText).toContain("1290");
    expect(combinedText).toContain("1390");
    expect(combinedText).toContain("draft1");
    expect(combinedText).toContain("draft2");
    expect(combinedText).toContain("draft3");
    expect(combinedText).toContain("-- end of listing --");

    const imageRequest = requests.find(
      (request): request is Extract<
        GoogleDocsRequest,
        { insertInlineImage: unknown }
      > => "insertInlineImage" in request,
    );
    expect(imageRequest?.insertInlineImage.uri).toBe(
      "https://r2.example.com/signed/A-1001.jpg",
    );
  });

  it("uses one delete range and reverse insertion requests so final Product order is preserved", () => {
    const requests = buildBatchUpdateRequests(
      "1 กันยายน 2569",
      [sampleProduct, { ...sampleProduct, productId: "A-1002" }],
      "suffix",
      32,
      63,
    );
    const deleteRequest = requests[0];
    if (!deleteRequest) {
      throw new Error("expected delete request");
    }
    expect(
      "deleteContentRange" in deleteRequest
        ? deleteRequest.deleteContentRange.range
        : null,
    ).toEqual({ startIndex: 32, endIndex: 63 });
    const productTextRequests = requests.filter(
      (request): request is Extract<
        GoogleDocsRequest,
        { insertText: unknown }
      > =>
        "insertText" in request &&
        request.insertText.text.includes("Product ID:"),
    );
    expect(productTextRequests.map(({ insertText }) =>
      insertText.text.match(/A-\d+/)?.[0])).toEqual([
      "A-1002",
      "A-1001",
    ]);
    expect(productTextRequests.every(({ insertText }) =>
      insertText.location.index === 32)).toBe(true);
    const finalRequest = requests.at(-1);
    expect(
      finalRequest && "replaceAllText" in finalRequest
        ? finalRequest.replaceAllText.containsText.text
        : null,
    ).toBe("{{PUBLICATION_DATE}}");
  });
});

describe("fillTemplate", () => {
  it("rejects template markers split across Google Docs text runs", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(
      jsonResponse({
        body: {
          content: [{ paragraph: { elements: [
            { startIndex: 1, textRun: { content: "{{PUBLICATION_DATE}}" } },
            { startIndex: 21, textRun: { content: "{{PRO" } },
            { startIndex: 26, textRun: { content: "DUCTS}}" } },
            { startIndex: 32, textRun: { content: "suffix" } },
            { startIndex: 38, textRun: { content: "{{END_PRODUCTS}}" } },
          ] } }],
        },
      }),
    );

    await expect(
      fillTemplate(
        fetcher,
        tokenProvider(),
        "doc-1",
        "1 กันยายน 2569",
        [sampleProduct],
      ),
    ).rejects.toThrow(/must remain inside one text run/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not write again when a prior atomic batch already produced every Product ID", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(
      jsonResponse({
        body: {
          content: [{ paragraph: { elements: [{ textRun: { content: "Product ID: A-1001" } }] } }],
        },
      }),
    );

    await fillTemplate(fetcher, tokenProvider(), "doc-1", "1 กันยายน 2569", [sampleProduct]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).not.toContain("batchUpdate");
  });

  it("captures the suffix between markers, then applies one atomic batchUpdate", async () => {
    const fetcher = vi
      .fn<Fetcher>()
      // 1: documents.get to read the template body and locate markers/suffix
      .mockResolvedValueOnce(
        jsonResponse({
          body: {
            content: [
              {
                paragraph: {
                  elements: [
                    { startIndex: 1, endIndex: 21, textRun: { content: "{{PUBLICATION_DATE}}" } },
                  ],
                },
              },
              {
                paragraph: {
                  elements: [
                    { startIndex: 21, endIndex: 32, textRun: { content: "{{PRODUCTS}}" } },
                    { startIndex: 32, endIndex: 47, textRun: { content: "-- end of listing --" } },
                    { startIndex: 47, endIndex: 63, textRun: { content: "{{END_PRODUCTS}}" } },
                  ],
                },
              },
            ],
          },
        }),
      )
      // 2: batchUpdate call
      .mockResolvedValueOnce(jsonResponse({ documentId: "doc-1" }));

    await fillTemplate(fetcher, tokenProvider(), "doc-1", "1 กันยายน 2569", [sampleProduct]);

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [, batchInit] = fetcher.mock.calls[1]!;
    const body = JSON.parse(String(batchInit?.body)) as {
      requests: GoogleDocsRequest[];
    };
    expect(Array.isArray(body.requests)).toBe(true);
    const hasSuffixContent = body.requests.some(
      (request) =>
        "insertText" in request &&
        request.insertText.text.includes("-- end of listing --"),
    );
    expect(hasSuffixContent).toBe(true);
  });
});

describe("verifyDocumentContainsProducts", () => {
  it("returns ok:true when every expected Product ID text appears in the document", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(
      jsonResponse({
        body: { content: [{ paragraph: { elements: [{ textRun: { content: "Product ID: A-1001\nProduct ID: A-1002" } }] } }] },
      }),
    );
    const result = await verifyDocumentContainsProducts(fetcher, tokenProvider(), "doc-1", ["A-1001", "A-1002"]);
    expect(result).toEqual({ ok: true });
  });

  it("returns ok:false with the missing Product IDs when any are absent", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(
      jsonResponse({ body: { content: [{ paragraph: { elements: [{ textRun: { content: "Product ID: A-1001" } }] } }] } }),
    );
    const result = await verifyDocumentContainsProducts(fetcher, tokenProvider(), "doc-1", ["A-1001", "A-1002"]);
    expect(result).toEqual({ ok: false, missingProductIds: ["A-1002"] });
  });
});

describe("finalizeDocument", () => {
  it("renames the doc via Drive and returns the canonical edit URL", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ id: "doc-1" }));
    const url = await finalizeDocument(fetcher, tokenProvider(), "doc-1", "Publication 2026-09-01");
    expect(url).toBe("https://docs.google.com/document/d/doc-1/edit");
    const [requestUrl, init] = fetcher.mock.calls[0]!;
    expect(String(requestUrl)).toContain("drive/v3/files/doc-1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Publication 2026-09-01",
    });
  });

  it.each([
    [429, true],
    [403, false],
  ])(
    "classifies Drive status %i with retryable=%s",
    async (status, retryable) => {
      const fetcher = vi.fn<Fetcher>().mockResolvedValue(
        new Response(null, { status }),
      );

      await expect(
        finalizeDocument(
          fetcher,
          tokenProvider(),
          "doc-1",
          "Publication 2026-09-01",
        ),
      ).rejects.toMatchObject({
        code: "google_drive_rename_failed",
        retryable,
      });
    },
  );
});

describe("deleteDocument", () => {
  it("DELETEs the Drive file", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(new Response(null, { status: 204 }));
    await deleteDocument(fetcher, tokenProvider(), "doc-1");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain("drive/v3/files/doc-1");
    expect(init?.method).toBe("DELETE");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publication/google-docs.test.ts`
Expected: FAIL — `Cannot find module '../../src/publication/google-docs'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/publication/google-docs.ts
import { z } from "zod";
import { OperationalError } from "../shared/errors";
import type { AccessTokenProvider } from "./google-auth";
import type { Fetcher } from "../shared/http";

const DriveFilesSchema = z.object({
  files: z.array(z.object({ id: z.string().min(1) })).optional(),
});

const DriveFileSchema = z.object({
  id: z.string().min(1),
});

const GoogleDocSchema = z.object({
  body: z.object({
    content: z.array(z.object({
      paragraph: z.object({
        elements: z.array(z.object({
          startIndex: z.number().int().optional(),
          endIndex: z.number().int().optional(),
          textRun: z.object({ content: z.string() }).optional(),
        })),
      }).optional(),
    })),
  }),
});

type GoogleDocBody = z.infer<typeof GoogleDocSchema>;

export interface DocProductContent {
  productId: string;
  conditionType: string;
  description: string;
  lineSquarePrice: number;
  igPrice: number;
  captionDrafts: [string, string, string];
  collageImageUrl: string;
}

export type GoogleDocsRequest =
  | {
      deleteContentRange: {
        range: { startIndex: number; endIndex: number };
      };
    }
  | {
      insertText: {
        location: { index: number };
        text: string;
      };
    }
  | {
      insertInlineImage: {
        location: { index: number };
        uri: string;
        objectSize: {
          width: { magnitude: number; unit: "PT" };
          height: { magnitude: number; unit: "PT" };
        };
      };
    }
  | {
      replaceAllText: {
        containsText: { text: string; matchCase: boolean };
        replaceText: string;
      };
    };

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DOCS_BASE = "https://docs.googleapis.com/v1";

function googleHttpError(
  code: string,
  action: string,
  status: number,
): OperationalError {
  return new OperationalError(
    code,
    `Google ${action} failed with status ${status}`,
    status === 429 || status >= 500,
  );
}

async function authHeaders(tokenProvider: AccessTokenProvider): Promise<HeadersInit> {
  const token = await tokenProvider.getAccessToken();
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function parseGoogleJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  action: string,
): Promise<T> {
  try {
    return schema.parse(await response.json());
  } catch {
    throw new Error(`google ${action} returned a malformed response`);
  }
}

export async function findTemporaryDocument(
  fetcher: Fetcher,
  tokenProvider: AccessTokenProvider,
  driveFolderId: string,
  publicationRunId: string,
): Promise<string | null> {
  const query = [
    `'${driveFolderId}' in parents`,
    "trashed = false",
    `appProperties has { key='publicationRunId' and value='${publicationRunId}' }`,
  ].join(" and ");
  const url = new URL(`${DRIVE_BASE}/files`);
  url.searchParams.set("q", query);
  url.searchParams.set("fields", "files(id)");
  url.searchParams.set("pageSize", "2");
  const response = await fetcher(url, { headers: await authHeaders(tokenProvider) });
  if (!response.ok) {
    throw googleHttpError(
      "google_drive_lookup_failed",
      "Drive lookup",
      response.status,
    );
  }
  const body = await parseGoogleJson(response, DriveFilesSchema, "drive lookup");
  if ((body.files?.length ?? 0) > 1) {
    throw new Error(`multiple temporary documents found for ${publicationRunId}`);
  }
  return body.files?.[0]?.id ?? null;
}

export async function copyTemplate(
  fetcher: Fetcher,
  tokenProvider: AccessTokenProvider,
  templateDocId: string,
  driveFolderId: string,
  publicationRunId: string,
  newTitle: string,
): Promise<string> {
  const response = await fetcher(`${DRIVE_BASE}/files/${templateDocId}/copy`, {
    method: "POST",
    headers: await authHeaders(tokenProvider),
    body: JSON.stringify({
      name: newTitle,
      parents: [driveFolderId],
      appProperties: { publicationRunId },
    }),
  });
  if (!response.ok) {
    throw googleHttpError(
      "google_drive_copy_failed",
      "Drive copy",
      response.status,
    );
  }
  const body = await parseGoogleJson(response, DriveFileSchema, "drive copy");
  return body.id;
}

function productBlockText(product: DocProductContent): string {
  return [
    `Product ID: ${product.productId}`,
    `Condition: ${product.conditionType}`,
    `Description: ${product.description}`,
    `LINE Square Price: ${product.lineSquarePrice}`,
    `IG Price: ${product.igPrice}`,
    `Caption 1: ${product.captionDrafts[0]}`,
    `Caption 2: ${product.captionDrafts[1]}`,
    `Caption 3: ${product.captionDrafts[2]}`,
    "",
  ].join("\n");
}

export function buildBatchUpdateRequests(
  publicationDateText: string,
  products: DocProductContent[],
  suffixText: string,
  insertionIndex: number,
  deletionEndIndex: number,
): GoogleDocsRequest[] {
  const requests: GoogleDocsRequest[] = [{
    deleteContentRange: {
      range: {
        startIndex: insertionIndex,
        endIndex: deletionEndIndex,
      },
    },
  }];

  for (const product of [...products].reverse()) {
    requests.push({
      insertText: {
        location: { index: insertionIndex },
        text: `${suffixText}\n\n`,
      },
    });
    requests.push({
      insertText: {
        location: { index: insertionIndex },
        text: productBlockText(product),
      },
    });
    requests.push({
      insertInlineImage: {
        location: { index: insertionIndex },
        uri: product.collageImageUrl,
        objectSize: {
          width: { magnitude: 200, unit: "PT" },
          height: { magnitude: 200, unit: "PT" },
        },
      },
    });
  }

  requests.push({
    replaceAllText: {
      containsText: { text: "{{PUBLICATION_DATE}}", matchCase: true },
      replaceText: publicationDateText,
    },
  });
  return requests;
}

function extractPlainText(doc: GoogleDocBody): string {
  const parts: string[] = [];
  for (const block of doc.body.content) {
    for (const element of block.paragraph?.elements ?? []) {
      if (element.textRun) parts.push(element.textRun.content);
    }
  }
  return parts.join("");
}

interface IndexedTextRun {
  startIndex: number;
  content: string;
}

function indexedTextRuns(doc: GoogleDocBody): IndexedTextRun[] {
  const runs: IndexedTextRun[] = [];
  for (const block of doc.body.content) {
    for (const element of block.paragraph?.elements ?? []) {
      if (element.textRun && element.startIndex !== undefined) {
        runs.push({
          startIndex: element.startIndex,
          content: element.textRun.content,
        });
      }
    }
  }
  return runs;
}

function documentIndexAtOffset(
  runs: IndexedTextRun[],
  textOffset: number,
): number {
  let consumed = 0;
  for (const run of runs) {
    const next = consumed + run.content.length;
    if (textOffset <= next) {
      return run.startIndex + textOffset - consumed;
    }
    consumed = next;
  }
  throw new Error("template marker index is outside document text runs");
}

function findTemplateRegion(doc: GoogleDocBody): {
  insertionIndex: number;
  deletionEndIndex: number;
  suffixText: string;
} {
  const startMarker = "{{PRODUCTS}}";
  const endMarker = "{{END_PRODUCTS}}";
  const runs = indexedTextRuns(doc);
  for (const marker of [
    "{{PUBLICATION_DATE}}",
    startMarker,
    endMarker,
  ]) {
    if (!runs.some((run) => run.content.includes(marker))) {
      throw new Error(
        `template marker ${marker} must remain inside one text run`,
      );
    }
  }
  const fullText = runs.map((run) => run.content).join("");
  const startOffset = fullText.indexOf(startMarker);
  const endOffset = fullText.indexOf(endMarker);
  if (startOffset === -1 || endOffset < startOffset + startMarker.length) {
    throw new Error("template missing {{PRODUCTS}} / {{END_PRODUCTS}} markers");
  }
  return {
    insertionIndex: documentIndexAtOffset(runs, startOffset),
    deletionEndIndex: documentIndexAtOffset(
      runs,
      endOffset + endMarker.length,
    ),
    suffixText: fullText.slice(
      startOffset + startMarker.length,
      endOffset,
    ).trim(),
  };
}

export async function fillTemplate(
  fetcher: Fetcher,
  tokenProvider: AccessTokenProvider,
  docId: string,
  publicationDateText: string,
  products: DocProductContent[],
): Promise<void> {
  const getResponse = await fetcher(`${DOCS_BASE}/documents/${docId}`, { headers: await authHeaders(tokenProvider) });
  if (!getResponse.ok) {
    throw googleHttpError(
      "google_docs_get_failed",
      "Docs get",
      getResponse.status,
    );
  }
  const doc = await parseGoogleJson(getResponse, GoogleDocSchema, "docs get");
  const fullText = extractPlainText(doc);
  const expectedProductIds = products.map((product) => product.productId);
  const alreadyComplete =
    !fullText.includes("{{PRODUCTS}}") &&
    expectedProductIds.every((productId) =>
      fullText.includes(`Product ID: ${productId}`),
    );
  if (alreadyComplete) {
    return;
  }
  const region = findTemplateRegion(doc);
  const requests = buildBatchUpdateRequests(
    publicationDateText,
    products,
    region.suffixText,
    region.insertionIndex,
    region.deletionEndIndex,
  );

  const batchResponse = await fetcher(`${DOCS_BASE}/documents/${docId}:batchUpdate`, {
    method: "POST",
    headers: await authHeaders(tokenProvider),
    body: JSON.stringify({ requests }),
  });
  if (!batchResponse.ok) {
    throw googleHttpError(
      "google_docs_batch_update_failed",
      "Docs batchUpdate",
      batchResponse.status,
    );
  }
}

export async function verifyDocumentContainsProducts(
  fetcher: Fetcher,
  tokenProvider: AccessTokenProvider,
  docId: string,
  expectedProductIds: string[],
): Promise<{ ok: true } | { ok: false; missingProductIds: string[] }> {
  const response = await fetcher(`${DOCS_BASE}/documents/${docId}`, { headers: await authHeaders(tokenProvider) });
  if (!response.ok) {
    throw googleHttpError(
      "google_docs_get_failed",
      "Docs get",
      response.status,
    );
  }
  const doc = await parseGoogleJson(response, GoogleDocSchema, "docs get");
  const fullText = extractPlainText(doc);
  const missingProductIds = expectedProductIds.filter((id) => !fullText.includes(`Product ID: ${id}`));
  if (missingProductIds.length > 0) {
    return { ok: false, missingProductIds };
  }
  return { ok: true };
}

export async function finalizeDocument(
  fetcher: Fetcher,
  tokenProvider: AccessTokenProvider,
  docId: string,
  finalTitle: string,
): Promise<string> {
  const response = await fetcher(`${DRIVE_BASE}/files/${docId}`, {
    method: "PATCH",
    headers: await authHeaders(tokenProvider),
    body: JSON.stringify({ name: finalTitle }),
  });
  if (!response.ok) {
    throw googleHttpError(
      "google_drive_rename_failed",
      "Drive rename",
      response.status,
    );
  }
  return `https://docs.google.com/document/d/${docId}/edit`;
}

export async function deleteDocument(fetcher: Fetcher, tokenProvider: AccessTokenProvider, docId: string): Promise<void> {
  const response = await fetcher(`${DRIVE_BASE}/files/${docId}`, {
    method: "DELETE",
    headers: await authHeaders(tokenProvider),
  });
  if (!response.ok && response.status !== 404) {
    throw googleHttpError(
      "google_drive_delete_failed",
      "Drive delete",
      response.status,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/publication/google-docs.test.ts`
Expected: PASS — 14 tests green.

- [ ] **Step 5: Full check and commit**

Run: `npm run check`

```bash
git add src/publication/google-docs.ts test/publication/google-docs.test.ts
git commit -m "feat(publication): add Google Drive/Docs client with template fill, verification, finalize, cleanup"
```

---

## Task 8: LINE publication log messages

**Files:**
- Create: `src/line/messages.ts`
- Test: `test/line/publication-messages.test.ts`

**Interfaces:**
- Consumes: `ValidationResult`, `formatValidationErrorSummary` from `src/publication/validator.ts` (Task 3); `PublicationResult` from `src/publication/types.ts` (Task 2).
- Produces:
  ```ts
  export function buildPublicationSuccessMessage(input: {
    thaiDate: string;
    productIds: string[];
    googleDocUrl: string;
  }): string;

  export function buildPublicationValidationFailureMessage(input: {
    thaiDate: string;
    validation: ValidationResult;
    airtableRunUrl: string;
  }): string;

  export function buildPublicationWorkflowFailureMessage(input: {
    thaiDate: string;
    reason: string;
    airtableRunUrl: string;
  }): string;
  ```
  used by `publication/service.ts` (Task 9).

- [ ] **Step 1: Write the failing test**

```ts
// test/line/publication-messages.test.ts
import { describe, expect, it } from "vitest";
import {
  buildPublicationSuccessMessage,
  buildPublicationValidationFailureMessage,
  buildPublicationWorkflowFailureMessage,
} from "../../src/line/messages";

describe("buildPublicationSuccessMessage", () => {
  it("includes date, action, count, Product IDs, and the Google Doc link", () => {
    const message = buildPublicationSuccessMessage({
      thaiDate: "1 กันยายน 2569",
      productIds: ["A-1001", "A-1002"],
      googleDocUrl: "https://docs.google.com/document/d/doc-1/edit",
    });
    expect(message).toContain("1 กันยายน 2569");
    expect(message).toContain("2");
    expect(message).toContain("A-1001");
    expect(message).toContain("A-1002");
    expect(message).toContain("https://docs.google.com/document/d/doc-1/edit");
  });
});

describe("buildPublicationValidationFailureMessage", () => {
  it("groups missing fields by Product ID and includes the Airtable link and retry hint", () => {
    const message = buildPublicationValidationFailureMessage({
      thaiDate: "1 กันยายน 2569",
      validation: {
        valid: false,
        productsMissingFields: [{ productId: "A-1001", missingFields: ["Brand Name", "Description"] }],
      },
      airtableRunUrl: "https://airtable.com/base/tbl/rec1",
    });
    expect(message).toContain("A-1001");
    expect(message).toContain("Brand Name, Description");
    expect(message).toContain("https://airtable.com/base/tbl/rec1");
    expect(message).toContain("/docs");
  });

  it("never includes signed URLs, tokens, or raw stack traces", () => {
    const message = buildPublicationValidationFailureMessage({
      thaiDate: "1 กันยายน 2569",
      validation: { valid: false, productsMissingFields: [{ productId: "A-1001", missingFields: ["Description"] }] },
      airtableRunUrl: "https://airtable.com/base/tbl/rec1",
    });
    expect(message).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
    expect(message).not.toContain("signature=");
  });
});

describe("buildPublicationWorkflowFailureMessage", () => {
  it("includes action, human-readable reason, Airtable link, and a safe retry command", () => {
    const message = buildPublicationWorkflowFailureMessage({
      thaiDate: "1 กันยายน 2569",
      reason: "Google Docs API returned a persistent error",
      airtableRunUrl: "https://airtable.com/base/tbl/rec1",
    });
    expect(message).toContain("Google Docs API returned a persistent error");
    expect(message).toContain("https://airtable.com/base/tbl/rec1");
    expect(message).toContain("/docs");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/line/publication-messages.test.ts`
Expected: FAIL — the three new exports do not exist yet.

- [ ] **Step 3: Create `src/line/messages.ts`**

```ts
// src/line/messages.ts
import type { ValidationResult } from "../publication/validator";
import { formatValidationErrorSummary } from "../publication/validator";

export function buildPublicationSuccessMessage(input: {
  thaiDate: string;
  productIds: string[];
  googleDocUrl: string;
}): string {
  return [
    `วันที่: ${input.thaiDate}`,
    "การดำเนินการ: สร้างเอกสารเผยแพร่สำเร็จ",
    `จำนวนสินค้า: ${input.productIds.length}`,
    `รหัสสินค้า: ${input.productIds.join(", ")}`,
    `ลิงก์เอกสาร: ${input.googleDocUrl}`,
  ].join("\n");
}

export function buildPublicationValidationFailureMessage(input: {
  thaiDate: string;
  validation: ValidationResult;
  airtableRunUrl: string;
}): string {
  return [
    `วันที่: ${input.thaiDate}`,
    "การดำเนินการ: สร้างเอกสารเผยแพร่ล้มเหลว (ข้อมูลไม่ครบ)",
    "สินค้าที่ข้อมูลไม่ครบ:",
    formatValidationErrorSummary(input.validation),
    `ลิงก์ Airtable: ${input.airtableRunUrl}`,
    "แก้ไขข้อมูลให้ครบ ตั้งสถานะเป็น Ready แล้วส่งคำสั่ง /docs อีกครั้ง",
  ].join("\n");
}

export function buildPublicationWorkflowFailureMessage(input: {
  thaiDate: string;
  reason: string;
  airtableRunUrl: string;
}): string {
  return [
    `วันที่: ${input.thaiDate}`,
    "การดำเนินการ: สร้างเอกสารเผยแพร่ล้มเหลว",
    `สาเหตุ: ${input.reason}`,
    `ลิงก์ Airtable: ${input.airtableRunUrl}`,
    "ส่งคำสั่ง /docs เพื่อลองใหม่",
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/line/publication-messages.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Full check and commit**

Run: `npm run check`

```bash
git add src/line/messages.ts test/line/publication-messages.test.ts
git commit -m "feat(line): add publication success/validation-failure/workflow-failure messages"
```

---

## Task 9: Retry-safe publication stages

**Files:**
- Create: `src/publication/service.ts`
- Test: `test/publication/service.test.ts`

**Interfaces:**
- Consumes: publication repository (Task 1), Airtable client (Task 2), validator (Task 3), collage generator (Task 4), shared `AssetStore` (Import Task 6), caption generator (Task 5), Google auth (Task 6), Google Docs client (Task 7), and LINE message builders (Task 8).
- Produces:

```ts
export interface PublicationServiceDeps {
  db: D1Database;
  assets: AssetStore;
  bucket: R2Bucket;
  images: ImagesBinding;
  fetcher: Fetcher;
  anthropic: Pick<Anthropic, "messages">;
  clock: Clock;
  config: AppConfig;
  airtableToken: string;
  googleServiceAccountJson: string;
  notify(text: string): Promise<void>;
}

export interface ValidatedPublication {
  run: PublicationRun;
  thaiDate: string;
}

export interface PreparedProductOutput {
  product: PublicationProduct;
  collageR2Key: string;
  captionDrafts: [string, string, string];
}

export interface PreparedPublication extends ValidatedPublication {
  outputs: PreparedProductOutput[];
}

export type ValidationStageOutcome =
  | { kind: "valid"; value: ValidatedPublication }
  | { kind: "already_succeeded"; result: PublicationResult }
  | {
      kind: "validation_failed";
      thaiDate: string;
      validation: ValidationResult;
    };

export async function validatePublication(
  deps: PublicationServiceDeps,
  publicationRunId: string,
  correlationId: string,
): Promise<ValidationStageOutcome>;

export async function notifyPublicationValidationFailure(
  deps: PublicationServiceDeps,
  publicationRunId: string,
  thaiDate: string,
  validation: ValidationResult,
): Promise<void>;

export async function preparePublicationOutputs(
  deps: PublicationServiceDeps,
  validated: ValidatedPublication,
): Promise<PreparedPublication>;

export async function ensureTemporaryDocument(
  deps: PublicationServiceDeps,
  prepared: PreparedPublication,
): Promise<string>;

export async function fillAndVerifyDocument(
  deps: PublicationServiceDeps,
  prepared: PreparedPublication,
  tempDocId: string,
): Promise<void>;

export async function finalizePublication(
  deps: PublicationServiceDeps,
  prepared: PreparedPublication,
  tempDocId: string,
): Promise<PublicationResult>;

export async function notifyPublicationSuccess(
  deps: PublicationServiceDeps,
  prepared: PreparedPublication,
  result: PublicationResult,
): Promise<void>;

export async function failPublicationAfterExhaustion(
  deps: PublicationServiceDeps,
  publicationRunId: string,
  reason: string,
  thaiDate: string | null,
): Promise<void>;
```

Each function is one durable Workflow stage. No function wraps the whole publication in a catch that deletes the temporary document on its first transient failure. D1 caches valid captions and collages, so a retried output stage requests only missing Product IDs. Google copy recovery first reads D1, then searches Drive by `appProperties.publicationRunId`, then copies only if neither source has a document ID.

- [ ] **Step 1: Write failing stage tests**

```ts
// test/publication/service.test.ts
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { env } from "cloudflare:test";
import {
  ensureTemporaryDocument,
  failPublicationAfterExhaustion,
  preparePublicationOutputs,
  validatePublication,
  type PublicationServiceDeps,
  type ValidatedPublication,
} from "../../src/publication/service";

let serviceAccountPrivateKey = "";

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  serviceAccountPrivateKey = privateKey;
});

const clock = {
  now: () => new Date("2026-09-01T17:30:00.000Z"),
};

function baseDeps(
  overrides: Partial<PublicationServiceDeps> = {},
): PublicationServiceDeps {
  return {
    db: env.DB,
    assets: {
      putOriginal: vi.fn(),
      signUrl: vi.fn(async (key: string) =>
        `https://worker.example/assets/${encodeURIComponent(key)}?expires=1&signature=x`,
      ),
    } as PublicationServiceDeps["assets"],
    bucket: {
      get: vi.fn(),
      put: vi.fn(),
    } as unknown as R2Bucket,
    images: {} as PublicationServiceDeps["images"],
    fetcher: vi.fn() as unknown as typeof fetch,
    anthropic: {
      messages: {
        create: vi.fn(),
        countTokens: vi.fn(),
      },
    } as unknown as PublicationServiceDeps["anthropic"],
    clock,
    config: {
      airtableBaseId: "base123",
      airtableProductsTableId: "tblProducts",
      airtablePublicationRunsTableId: "tblRuns",
      googleDriveFolderId: "folder-1",
      googleTemplateDocId: "template-1",
      claudeModel: "claude-opus-5",
      claudeRequestInputTokenLimit: 150_000,
      publicBaseUrl: "https://worker.example",
      timeZone: "Asia/Bangkok",
    } as PublicationServiceDeps["config"],
    airtableToken: "airtable-token",
    googleServiceAccountJson: JSON.stringify({
      client_email: "svc@example.com",
      private_key: serviceAccountPrivateKey,
    }),
    notify: vi.fn(),
    ...overrides,
  };
}

const product = {
  airtableRecordId: "rec-product-1",
  productId: "A-1001",
  orderedImageKeys: ["assets/1.jpg", "assets/2.jpg", "assets/3.jpg", "assets/4.jpg"],
  brandName: "Nike",
  modelName: "Air Max",
  conditionType: "Used",
  size: "42",
  description: "Good condition",
  lineSquarePrice: 1290,
  igPrice: 1390,
};

const validated: ValidatedPublication = {
  run: {
    airtableRunId: "rec-run-1",
    publicationDate: "2026-09-02",
    status: "Ready",
    products: [product],
  },
  thaiDate: "2 กันยายน 2569",
};

describe("publication stages", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM publication_product_cache");
    await env.DB.exec("DELETE FROM publication_jobs");
  });

  it("loads the exact Airtable Publication Run requested by Workflow params", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "rec-run-1",
        fields: {
          "Publication Date": "2026-09-02",
          Status: "Ready",
          Products: [],
        },
      })));
    const deps = baseDeps({ fetcher: fetcher as unknown as typeof fetch });

    const outcome = await validatePublication(deps, "rec-run-1", "corr-1");

    expect(outcome.kind).toBe("valid");
    expect(String(fetcher.mock.calls[0]![0])).toContain("tblRuns/rec-run-1");
  });

  it("returns validation_failed before any Google, Claude, Images, or R2 side effect", async () => {
    const invalid = {
      ...product,
      description: "",
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "rec-run-1",
        fields: {
          "Publication Date": "2026-09-02",
          Status: "Ready",
          Products: ["rec-product-1"],
        },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        records: [{ id: "rec-product-1", fields: {
          "Product ID": invalid.productId,
          "Product Images": invalid.orderedImageKeys.map((r2Key, index) => ({
            id: String(index),
            url: `https://dl.airtable.com/${index}`,
            filename: r2Key.slice("assets/".length),
          })),
          "Brand Name": invalid.brandName,
          "Model Name": invalid.modelName,
          "Condition Type": invalid.conditionType,
          Size: invalid.size,
          Description: invalid.description,
          "LINE Square Price": invalid.lineSquarePrice,
          "IG Price": invalid.igPrice,
        } }],
      })))
      .mockResolvedValue(new Response(JSON.stringify({ id: "rec-run-1" })));
    const deps = baseDeps({ fetcher: fetcher as unknown as typeof fetch });

    const outcome = await validatePublication(deps, "rec-run-1", "corr-1");

    expect(outcome).toEqual({
      kind: "validation_failed",
      thaiDate: "2 กันยายน 2569",
      validation: {
        valid: false,
        productsMissingFields: [{
          productId: "A-1001",
          missingFields: ["Description"],
        }],
      },
    });
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.anthropic.messages.create).not.toHaveBeenCalled();
    expect(deps.bucket.put).not.toHaveBeenCalled();
  });

  it("reuses cached valid outputs and calls Claude only for an uncached Product ID", async () => {
    await env.DB.prepare(
      `INSERT INTO publication_jobs
         (publication_run_id, state, correlation_id, attempt_count, created_at, updated_at)
       VALUES (?, 'generating', ?, 0, ?, ?)`,
    ).bind("rec-run-1", "corr-1", clock.now().toISOString(), clock.now().toISOString()).run();
    await env.DB.prepare(
      `INSERT INTO publication_product_cache
         (publication_run_id, product_id, collage_r2_key, captions_json, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      "rec-run-1",
      "A-1001",
      "products/A-1001/collage/1080x1080.jpg",
      JSON.stringify(["หนึ่ง", "สอง", "สาม"]),
      clock.now().toISOString(),
    ).run();
    const deps = baseDeps();

    const prepared = await preparePublicationOutputs(deps, validated);

    expect(prepared.outputs[0]!.captionDrafts).toEqual(["หนึ่ง", "สอง", "สาม"]);
    expect(deps.anthropic.messages.create).not.toHaveBeenCalled();
    expect(deps.bucket.put).not.toHaveBeenCalled();
  });

  it("treats malformed cached captions as missing and replaces them", async () => {
    await env.DB.prepare(
      `INSERT INTO publication_jobs
         (publication_run_id, state, correlation_id, attempt_count, created_at, updated_at)
       VALUES (?, 'generating', ?, 0, ?, ?)`,
    ).bind(
      "rec-run-1",
      "corr-1",
      clock.now().toISOString(),
      clock.now().toISOString(),
    ).run();
    await env.DB.prepare(
      `INSERT INTO publication_product_cache
         (publication_run_id, product_id, collage_r2_key, captions_json, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      "rec-run-1",
      "A-1001",
      "products/A-1001/collage/1080x1080.jpg",
      "{malformed",
      clock.now().toISOString(),
    ).run();
    const create = vi.fn().mockResolvedValue({
      content: [{
        type: "tool_use",
        id: "tool-1",
        name: "submit_captions",
        input: {
          captions: [{
            productId: "A-1001",
            drafts: ["หนึ่ง", "สอง", "สาม"],
          }],
        },
      }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
      },
    });
    const deps = baseDeps({
      anthropic: {
        messages: {
          countTokens: vi.fn().mockResolvedValue({
            input_tokens: 100,
          }),
          create,
        },
      } as unknown as PublicationServiceDeps["anthropic"],
    });

    const prepared = await preparePublicationOutputs(
      deps,
      validated,
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(prepared.outputs[0]!.captionDrafts).toEqual([
      "หนึ่ง",
      "สอง",
      "สาม",
    ]);
  });

  it("rediscovers a copied Drive document when D1 persistence was missed", async () => {
    await env.DB.prepare(
      `INSERT INTO publication_jobs
         (publication_run_id, state, correlation_id, attempt_count, created_at, updated_at)
       VALUES (?, 'generating', ?, 0, ?, ?)`,
    ).bind("rec-run-1", "corr-1", clock.now().toISOString(), clock.now().toISOString()).run();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "google-token",
        expires_in: 3600,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        files: [{ id: "temp-doc-existing" }],
      })));
    const deps = baseDeps({ fetcher: fetcher as unknown as typeof fetch });

    const id = await ensureTemporaryDocument(
      deps,
      { ...validated, outputs: [] },
    );

    expect(id).toBe("temp-doc-existing");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toContain("drive/v3/files");
    const row = await env.DB.prepare(
      "SELECT temp_doc_id FROM publication_jobs WHERE publication_run_id = ?",
    ).bind("rec-run-1").first<{ temp_doc_id: string | null }>();
    expect(row?.temp_doc_id).toBe("temp-doc-existing");
  });

  it("deletes the temporary document and marks Failed only when exhaustion cleanup is called", async () => {
    await env.DB.prepare(
      `INSERT INTO publication_jobs
         (publication_run_id, state, correlation_id, temp_doc_id, attempt_count, created_at, updated_at)
       VALUES (?, 'generating', ?, ?, 0, ?, ?)`,
    ).bind("rec-run-1", "corr-1", "temp-doc-1", clock.now().toISOString(), clock.now().toISOString()).run();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "google-token",
        expires_in: 3600,
      })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "rec-run-1" })));
    const deps = baseDeps({ fetcher: fetcher as unknown as typeof fetch });

    await failPublicationAfterExhaustion(
      deps,
      "rec-run-1",
      "google unavailable",
      "2 กันยายน 2569",
    );

    expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
    expect(deps.notify).toHaveBeenCalledWith(
      expect.stringContaining("2 กันยายน 2569"),
    );
    const row = await env.DB.prepare(
      "SELECT state, temp_doc_id FROM publication_jobs WHERE publication_run_id = ?",
    ).bind("rec-run-1").first<{ state: string; temp_doc_id: string | null }>();
    expect(row).toEqual({ state: "failed", temp_doc_id: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publication/service.test.ts`
Expected: FAIL with `Cannot find module '../../src/publication/service'`.

- [ ] **Step 3: Implement the stage functions**

```ts
// src/publication/service.ts
import type Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../config";
import type { AssetStore } from "../import/asset-store";
import type { Fetcher } from "../shared/http";
import type { Clock } from "../shared/time";
import {
  acquireOrResumeJob,
  getProductCache,
  putProductCaptions,
  putProductCollage,
  setJobState,
  setTempDocId,
} from "../db/publication-repository";
import {
  loadRunById,
  markRunFailed,
  markRunGenerated,
  markRunGenerating,
  markRunNeedsCorrection,
  updateProductCollage,
} from "./airtable-runs";
import { generateCollage, collageR2Key, type ImagesBinding } from "./collage";
import { generateCaptionsForRun, toCaptionRequestProducts } from "./captions";
import { createGoogleAuthClient } from "./google-auth";
import {
  copyTemplate,
  deleteDocument,
  fillTemplate,
  finalizeDocument,
  findTemporaryDocument,
  verifyDocumentContainsProducts,
  type DocProductContent,
} from "./google-docs";
import type {
  PublicationProduct,
  PublicationResult,
  PublicationRun,
} from "./types";
import {
  formatValidationErrorSummary,
  validateRunCompleteness,
  type ValidationResult,
} from "./validator";
import {
  buildPublicationSuccessMessage,
  buildPublicationValidationFailureMessage,
  buildPublicationWorkflowFailureMessage,
} from "../line/messages";

export interface PublicationServiceDeps {
  db: D1Database;
  assets: AssetStore;
  bucket: R2Bucket;
  images: ImagesBinding;
  fetcher: Fetcher;
  anthropic: Pick<Anthropic, "messages">;
  clock: Clock;
  config: AppConfig;
  airtableToken: string;
  googleServiceAccountJson: string;
  notify(text: string): Promise<void>;
}

export interface ValidatedPublication {
  run: PublicationRun;
  thaiDate: string;
}

export interface PreparedProductOutput {
  product: PublicationProduct;
  collageR2Key: string;
  captionDrafts: [string, string, string];
}

export interface PreparedPublication extends ValidatedPublication {
  outputs: PreparedProductOutput[];
}

export type ValidationStageOutcome =
  | { kind: "valid"; value: ValidatedPublication }
  | { kind: "already_succeeded"; result: PublicationResult }
  | {
      kind: "validation_failed";
      thaiDate: string;
      validation: ValidationResult;
    };

function thaiDate(isoDate: string): string {
  return new Intl.DateTimeFormat(
    "th-TH-u-ca-buddhist-nu-latn",
    {
      timeZone: "Asia/Bangkok",
      day: "numeric",
      month: "long",
      year: "numeric",
    },
  ).format(new Date(`${isoDate}T12:00:00.000Z`));
}

function airtableRunUrl(config: AppConfig, runId: string): string {
  return `https://airtable.com/${config.airtableBaseId}/${config.airtablePublicationRunsTableId}/${runId}`;
}

function cachedDrafts(value: string | null): [string, string, string] | null {
  if (!value) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (
    Array.isArray(parsed) &&
    parsed.length === 3 &&
    parsed.every((draft) =>
      typeof draft === "string" &&
      draft === draft.trim() &&
      draft.length > 0 &&
      draft.length <= 400 &&
      /[ก-๙]/.test(draft),
    )
  ) {
    return [parsed[0], parsed[1], parsed[2]];
  }
  return null;
}

export async function validatePublication(
  deps: PublicationServiceDeps,
  publicationRunId: string,
  correlationId: string,
): Promise<ValidationStageOutcome> {
  const acquired = await acquireOrResumeJob(
    deps.db,
    deps.clock,
    publicationRunId,
    correlationId,
  );
  const run = await loadRunById(
    deps.fetcher,
    deps.config,
    deps.airtableToken,
    publicationRunId,
  );
  if (
    acquired.alreadySucceeded &&
    acquired.job.googleDocId &&
    acquired.job.googleDocUrl
  ) {
    return {
      kind: "already_succeeded",
      result: {
        publicationRunId,
        googleDocId: acquired.job.googleDocId,
        googleDocUrl: acquired.job.googleDocUrl,
        productIds: run.products.map((product) => product.productId),
      },
    };
  }
  const displayDate = thaiDate(run.publicationDate);
  await setJobState(deps.db, deps.clock, publicationRunId, "validating");
  const validation = validateRunCompleteness(run.products);
  if (!validation.valid) {
    const summary = formatValidationErrorSummary(validation);
    await setJobState(
      deps.db,
      deps.clock,
      publicationRunId,
      "validation_failed",
      { validationResultJson: JSON.stringify(validation) },
    );
    await markRunNeedsCorrection(
      deps.fetcher,
      deps.config,
      deps.airtableToken,
      publicationRunId,
      summary,
    );
    return {
      kind: "validation_failed",
      thaiDate: displayDate,
      validation,
    };
  }

  return { kind: "valid", value: { run, thaiDate: displayDate } };
}

export async function notifyPublicationValidationFailure(
  deps: PublicationServiceDeps,
  publicationRunId: string,
  displayDate: string,
  validation: ValidationResult,
): Promise<void> {
  await deps.notify(buildPublicationValidationFailureMessage({
    thaiDate: displayDate,
    validation,
    airtableRunUrl: airtableRunUrl(deps.config, publicationRunId),
  }));
}

async function ensureCollage(
  deps: PublicationServiceDeps,
  publicationRunId: string,
  product: PublicationProduct,
): Promise<string> {
  const cache = await getProductCache(
    deps.db,
    publicationRunId,
    product.productId,
  );
  if (cache.collageR2Key) return cache.collageR2Key;

  const [first, second, third, fourth] =
    product.orderedImageKeys;
  if (!first || !second || !third || !fourth) {
    throw new Error(
      `four ordered images required for ${product.productId}`,
    );
  }
  const bytes = await generateCollage(
    deps.bucket,
    deps.images,
    [first, second, third, fourth],
  );
  const key = collageR2Key(product.productId);
  await deps.bucket.put(key, bytes);
  await putProductCollage(
    deps.db,
    deps.clock,
    publicationRunId,
    product.productId,
    key,
  );
  return key;
}

async function captionsForProducts(
  deps: PublicationServiceDeps,
  publicationRunId: string,
  products: PublicationProduct[],
): Promise<Map<string, [string, string, string]>> {
  const result = new Map<string, [string, string, string]>();
  const missing: PublicationProduct[] = [];
  for (const product of products) {
    const cache = await getProductCache(
      deps.db,
      publicationRunId,
      product.productId,
    );
    const drafts = cachedDrafts(cache.captionsJson);
    if (drafts) result.set(product.productId, drafts);
    else missing.push(product);
  }

  if (missing.length > 0) {
    const generated = await generateCaptionsForRun(
      deps.anthropic,
      deps.config.claudeModel,
      deps.config.claudeRequestInputTokenLimit,
      toCaptionRequestProducts(missing),
    );
    for (const item of generated.captions) {
      await putProductCaptions(
        deps.db,
        deps.clock,
        publicationRunId,
        item.productId,
        JSON.stringify(item.drafts),
      );
      result.set(item.productId, item.drafts);
    }
    if (generated.missingProductIds.length > 0) {
      throw new Error(
        `caption generation incomplete for ${generated.missingProductIds.join(", ")}`,
      );
    }
  }
  return result;
}

export async function preparePublicationOutputs(
  deps: PublicationServiceDeps,
  validated: ValidatedPublication,
): Promise<PreparedPublication> {
  const runId = validated.run.airtableRunId;
  await setJobState(deps.db, deps.clock, runId, "generating");
  await markRunGenerating(
    deps.fetcher,
    deps.config,
    deps.airtableToken,
    runId,
  );
  const captions = await captionsForProducts(
    deps,
    runId,
    validated.run.products,
  );
  const outputs: PreparedProductOutput[] = [];
  for (const product of validated.run.products) {
    const drafts = captions.get(product.productId);
    if (!drafts) throw new Error(`captions missing for ${product.productId}`);
    outputs.push({
      product,
      collageR2Key: await ensureCollage(deps, runId, product),
      captionDrafts: drafts,
    });
  }
  return { ...validated, outputs };
}

export async function ensureTemporaryDocument(
  deps: PublicationServiceDeps,
  prepared: PreparedPublication,
): Promise<string> {
  const runId = prepared.run.airtableRunId;
  const acquired = await acquireOrResumeJob(
    deps.db,
    deps.clock,
    runId,
    `publication-${runId}`,
  );
  if (acquired.job.tempDocId) return acquired.job.tempDocId;

  const tokenProvider = createGoogleAuthClient(
    deps.googleServiceAccountJson,
    deps.clock,
    deps.fetcher,
  );
  const discovered = await findTemporaryDocument(
    deps.fetcher,
    tokenProvider,
    deps.config.googleDriveFolderId,
    runId,
  );
  const docId = discovered ?? await copyTemplate(
    deps.fetcher,
    tokenProvider,
    deps.config.googleTemplateDocId,
    deps.config.googleDriveFolderId,
    runId,
    `Publication ${prepared.run.publicationDate} (in progress)`,
  );
  await setTempDocId(deps.db, deps.clock, runId, docId);
  return docId;
}

export async function fillAndVerifyDocument(
  deps: PublicationServiceDeps,
  prepared: PreparedPublication,
  tempDocId: string,
): Promise<void> {
  const tokenProvider = createGoogleAuthClient(
    deps.googleServiceAccountJson,
    deps.clock,
    deps.fetcher,
  );
  const products: DocProductContent[] = [];
  for (const output of prepared.outputs) {
    const signedUrl = await deps.assets.signUrl(output.collageR2Key, 900);
    await updateProductCollage(
      deps.fetcher,
      deps.config,
      deps.airtableToken,
      output.product.airtableRecordId,
      signedUrl,
    );
    products.push({
      productId: output.product.productId,
      conditionType: output.product.conditionType,
      description: output.product.description,
      lineSquarePrice: output.product.lineSquarePrice,
      igPrice: output.product.igPrice,
      captionDrafts: output.captionDrafts,
      collageImageUrl: signedUrl,
    });
  }

  await fillTemplate(
    deps.fetcher,
    tokenProvider,
    tempDocId,
    prepared.thaiDate,
    products,
  );
  const expected = prepared.outputs.map((output) => output.product.productId);
  const verification = await verifyDocumentContainsProducts(
    deps.fetcher,
    tokenProvider,
    tempDocId,
    expected,
  );
  if (!verification.ok) {
    throw new Error(
      `generated document missing Product IDs: ${verification.missingProductIds.join(", ")}`,
    );
  }
}

export async function finalizePublication(
  deps: PublicationServiceDeps,
  prepared: PreparedPublication,
  tempDocId: string,
): Promise<PublicationResult> {
  const runId = prepared.run.airtableRunId;
  const acquired = await acquireOrResumeJob(
    deps.db,
    deps.clock,
    runId,
    `publication-${runId}`,
  );
  if (
    acquired.alreadySucceeded &&
    acquired.job.googleDocId &&
    acquired.job.googleDocUrl
  ) {
    return {
      publicationRunId: runId,
      googleDocId: acquired.job.googleDocId,
      googleDocUrl: acquired.job.googleDocUrl,
      productIds: prepared.outputs.map((output) => output.product.productId),
    };
  }

  const tokenProvider = createGoogleAuthClient(
    deps.googleServiceAccountJson,
    deps.clock,
    deps.fetcher,
  );
  const url = await finalizeDocument(
    deps.fetcher,
    tokenProvider,
    tempDocId,
    `Publication ${prepared.run.publicationDate}`,
  );
  await markRunGenerated(
    deps.fetcher,
    deps.config,
    deps.airtableToken,
    runId,
    url,
    deps.clock.now().toISOString(),
  );
  await setJobState(deps.db, deps.clock, runId, "succeeded", {
    googleDocId: tempDocId,
    googleDocUrl: url,
    tempDocId,
  });
  return {
    publicationRunId: runId,
    googleDocId: tempDocId,
    googleDocUrl: url,
    productIds: prepared.outputs.map((output) => output.product.productId),
  };
}

export async function notifyPublicationSuccess(
  deps: PublicationServiceDeps,
  prepared: PreparedPublication,
  result: PublicationResult,
): Promise<void> {
  await deps.notify(buildPublicationSuccessMessage({
    thaiDate: prepared.thaiDate,
    productIds: result.productIds,
    googleDocUrl: result.googleDocUrl,
  }));
}

export async function failPublicationAfterExhaustion(
  deps: PublicationServiceDeps,
  publicationRunId: string,
  reason: string,
  thaiDate: string | null,
): Promise<void> {
  const acquired = await acquireOrResumeJob(
    deps.db,
    deps.clock,
    publicationRunId,
    `publication-${publicationRunId}`,
  );
  if (acquired.alreadySucceeded) return;

  if (acquired.job.tempDocId) {
    const tokenProvider = createGoogleAuthClient(
      deps.googleServiceAccountJson,
      deps.clock,
      deps.fetcher,
    );
    await deleteDocument(
      deps.fetcher,
      tokenProvider,
      acquired.job.tempDocId,
    );
    await setTempDocId(deps.db, deps.clock, publicationRunId, null);
  }
  await setJobState(deps.db, deps.clock, publicationRunId, "failed");
  await markRunFailed(
    deps.fetcher,
    deps.config,
    deps.airtableToken,
    publicationRunId,
    reason,
  );
  await deps.notify(buildPublicationWorkflowFailureMessage({
    thaiDate: thaiDate ?? "ไม่สามารถอ่านวันที่รายการได้",
    reason,
    airtableRunUrl: airtableRunUrl(deps.config, publicationRunId),
  }));
}
```

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run test/publication/service.test.ts test/publication/google-docs.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full check and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add src/publication/service.ts test/publication/service.test.ts src/publication/google-docs.ts test/publication/google-docs.test.ts
git commit -m "feat(publication): add retry-safe publication stages"
```

---

## Task 10: PublicationWorkflow and create/restart triggers

**Files:**
- Create: `src/publication/workflow.ts`
- Create: `src/publication/trigger.ts`
- Create: `src/routes/docs.ts`
- Modify: `src/router.ts`
- Modify: `src/scheduled.ts`
- Modify: `src/index.ts`
- Modify: `wrangler.jsonc`
- Test: `test/publication/workflow.test.ts`
- Test: `test/publication/trigger.test.ts`
- Test: `test/routes/docs.test.ts`
- Test: `test/router.test.ts`
- Test: `test/scheduled.test.ts`

**Interfaces:**
- Consumes: stage functions from Task 9; `findRunnableRunForDate` from Task 2; `verifyAdminBearer` from `src/shared/admin-auth.ts`; `createAssetStore` from Import Task 6; `WorkflowInstance.restart()`, `resume()`, and `status()` from Cloudflare Workflows.
- Produces:

```ts
export async function runPublicationWorkflow(
  params: PublicationWorkflowParams,
  step: WorkflowStep,
  deps: PublicationServiceDeps,
): Promise<PublicationResult | null>;

export class PublicationWorkflow extends WorkflowEntrypoint<
  Env,
  PublicationWorkflowParams
> {
  run(
    event: WorkflowEvent<PublicationWorkflowParams>,
    step: WorkflowStep,
  ): Promise<PublicationResult | null>;
}

export type DocsTriggerResult =
  | { status: "no_runnable_run" }
  | { status: "already_generated"; publicationRunId: string }
  | { status: "already_running"; publicationRunId: string }
  | { status: "started" | "restarted" | "resumed"; publicationRunId: string };

export async function handleDocsTrigger(
  env: Env,
  trigger: "cron" | "line" | "admin",
  clock?: Clock,
): Promise<DocsTriggerResult>;

export async function handleDocsRoute(
  request: Request,
  env: Env,
  clock?: Clock,
): Promise<Response>;
```

Workflow custom ID is exactly `publication-<airtablePublicationRunId>`. `create()` is used only when `status()` is `unknown`. Existing `errored`, `terminated`, or `complete` instances use `restart()`; a `paused` instance uses `resume()`; active instances return `already_running`. This lets `/docs` retry a Failed Airtable run and rerun a corrected validation-failed run without attempting a duplicate Workflow ID.

- [ ] **Step 1: Write failing Workflow test**

```ts
// test/publication/workflow.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const stages = vi.hoisted(() => ({
  validatePublication: vi.fn(),
  notifyPublicationValidationFailure: vi.fn(),
  preparePublicationOutputs: vi.fn(),
  ensureTemporaryDocument: vi.fn(),
  fillAndVerifyDocument: vi.fn(),
  finalizePublication: vi.fn(),
  notifyPublicationSuccess: vi.fn(),
  failPublicationAfterExhaustion: vi.fn(),
}));

vi.mock("../../src/publication/service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/publication/service")>(),
  ...stages,
}));

import { runPublicationWorkflow } from "../../src/publication/workflow";
import type { PublicationServiceDeps } from "../../src/publication/service";

const params = {
  publicationRunId: "rec-run-1",
  trigger: "admin" as const,
};
const deps = {
  config: { publicationRetryLimit: 5 },
} as PublicationServiceDeps;

function retryingStep() {
  return {
    do: vi.fn(async (
      _name: string,
      options: { retries: { limit: number } },
      callback: () => Promise<unknown>,
    ) => {
      let lastError: unknown;
      for (let call = 0; call <= options.retries.limit; call += 1) {
        try {
          return await callback();
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    }),
  };
}

describe("runPublicationWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stages.validatePublication.mockResolvedValue({
      kind: "valid",
      value: { run: { airtableRunId: "rec-run-1" }, thaiDate: "2 กันยายน 2569" },
    });
    stages.notifyPublicationValidationFailure.mockResolvedValue(undefined);
    stages.preparePublicationOutputs.mockResolvedValue({
      run: { airtableRunId: "rec-run-1" },
      thaiDate: "2 กันยายน 2569",
      outputs: [],
    });
    stages.ensureTemporaryDocument.mockResolvedValue("temp-doc-1");
    stages.fillAndVerifyDocument.mockResolvedValue(undefined);
    stages.finalizePublication.mockResolvedValue({
      publicationRunId: "rec-run-1",
      googleDocId: "temp-doc-1",
      googleDocUrl: "https://docs.google.com/document/d/temp-doc-1/edit",
      productIds: [],
    });
    stages.notifyPublicationSuccess.mockResolvedValue(undefined);
    stages.failPublicationAfterExhaustion.mockResolvedValue(undefined);
  });

  it("runs six named durable stages with retry limit five", async () => {
    const step = retryingStep();

    await runPublicationWorkflow(params, step as never, deps);

    expect(step.do.mock.calls.map(([name]) => name)).toEqual([
      "validate publication",
      "prepare outputs",
      "ensure temporary document",
      "fill and verify document",
      "finalize publication",
      "notify publication success",
    ]);
    expect(step.do.mock.calls.every(([, options]) =>
      options.retries.limit === 5)).toBe(true);
  });

  it("calls fill six times, then performs exhaustion cleanup once", async () => {
    stages.fillAndVerifyDocument.mockRejectedValue(
      new Error("google 503"),
    );
    const step = retryingStep();

    await expect(
      runPublicationWorkflow(params, step as never, deps),
    ).rejects.toThrow("google 503");

    expect(stages.fillAndVerifyDocument).toHaveBeenCalledTimes(6);
    expect(stages.failPublicationAfterExhaustion).toHaveBeenCalledWith(
      deps,
      "rec-run-1",
      "google 503",
      "2 กันยายน 2569",
    );
  });

  it("keeps a validation failure in Draft when LINE notification exhausts retries", async () => {
    stages.validatePublication.mockResolvedValue({
      kind: "validation_failed",
      thaiDate: "2 กันยายน 2569",
      validation: {
        valid: false,
        productsMissingFields: [{
          productId: "A-1001",
          missingFields: ["Description"],
        }],
      },
    });
    stages.notifyPublicationValidationFailure.mockRejectedValue(
      new Error("LINE 503"),
    );
    const step = retryingStep();

    await expect(
      runPublicationWorkflow(params, step as never, deps),
    ).rejects.toThrow("LINE 503");

    expect(stages.notifyPublicationValidationFailure).toHaveBeenCalledTimes(6);
    expect(stages.preparePublicationOutputs).not.toHaveBeenCalled();
    expect(stages.failPublicationAfterExhaustion).not.toHaveBeenCalled();
  });

  it("does not downgrade a succeeded publication when success notification exhausts retries", async () => {
    stages.notifyPublicationSuccess.mockRejectedValue(new Error("LINE 503"));
    const step = retryingStep();

    await expect(
      runPublicationWorkflow(params, step as never, deps),
    ).rejects.toThrow("LINE 503");

    expect(stages.finalizePublication).toHaveBeenCalledTimes(1);
    expect(stages.notifyPublicationSuccess).toHaveBeenCalledTimes(6);
    expect(stages.failPublicationAfterExhaustion).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run Workflow test to verify it fails**

Run: `npx vitest run test/publication/workflow.test.ts`
Expected: FAIL with missing module.

- [ ] **Step 3: Implement Workflow**

```ts
// src/publication/workflow.ts
import Anthropic from "@anthropic-ai/sdk";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { parseConfig } from "../config";
import { createAssetStore } from "../import/asset-store";
import { createLineClient } from "../line/client";
import type { Env } from "../env";
import type { Clock } from "../shared/time";
import { OperationalError } from "../shared/errors";
import {
  ensureTemporaryDocument,
  failPublicationAfterExhaustion,
  fillAndVerifyDocument,
  finalizePublication,
  notifyPublicationSuccess,
  notifyPublicationValidationFailure,
  preparePublicationOutputs,
  validatePublication,
  type PublicationServiceDeps,
} from "./service";
import type {
  PublicationResult,
  PublicationWorkflowParams,
} from "./types";

function depsFor(env: Env, clock: Clock): PublicationServiceDeps {
  const config = parseConfig(env.APP_CONFIG_JSON);
  return {
    db: env.DB,
    assets: createAssetStore(
      env.IMAGES_BUCKET,
      {
        signingSecret: env.ASSET_URL_SIGNING_SECRET,
        publicBaseUrl: config.publicBaseUrl,
      },
      clock,
    ),
    bucket: env.IMAGES_BUCKET,
    images: env.IMAGES,
    fetcher: fetch.bind(globalThis),
    anthropic: new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      maxRetries: 0,
    }),
    clock,
    config,
    airtableToken: env.AIRTABLE_TOKEN,
    googleServiceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON,
    notify: (text) =>
      createLineClient({
        channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
        fetch: fetch.bind(globalThis),
      }).pushMessage(config.lineAllowedGroupId, text),
  };
}

async function workflowCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof OperationalError && !error.retryable) {
      throw new NonRetryableError(error.message, error.code);
    }
    throw error;
  }
}

export async function runPublicationWorkflow(
  params: PublicationWorkflowParams,
  step: WorkflowStep,
  deps: PublicationServiceDeps,
): Promise<PublicationResult | null> {
  const retries = {
    retries: {
      limit: deps.config.publicationRetryLimit,
      delay: "10 seconds" as const,
      backoff: "exponential" as const,
    },
    timeout: "5 minutes" as const,
  };
  const runId = params.publicationRunId;

  let validation: Awaited<ReturnType<typeof validatePublication>>;
  try {
    validation = await step.do(
      "validate publication",
      retries,
      () => workflowCall(() =>
        validatePublication(deps, runId, `publication-${runId}`)),
    );
  } catch (error) {
    const reason = error instanceof Error
      ? error.message
      : "unknown publication error";
    await step.do(
      "record exhausted publication failure",
      retries,
      () => failPublicationAfterExhaustion(deps, runId, reason, null),
    );
    throw error;
  }

  if (validation.kind === "validation_failed") {
    await step.do(
      "notify validation failure",
      retries,
      () => workflowCall(() => notifyPublicationValidationFailure(
        deps,
        runId,
        validation.thaiDate,
        validation.validation,
      )),
    );
    return null;
  }
  if (validation.kind === "already_succeeded") {
    return validation.result;
  }

  let prepared: Awaited<ReturnType<typeof preparePublicationOutputs>>;
  let result: PublicationResult;
  try {
    prepared = await step.do(
      "prepare outputs",
      retries,
      () => workflowCall(() =>
        preparePublicationOutputs(deps, validation.value)),
    );
    const tempDocId = await step.do(
      "ensure temporary document",
      retries,
      () => workflowCall(() =>
        ensureTemporaryDocument(deps, prepared)),
    );
    await step.do(
      "fill and verify document",
      retries,
      () => workflowCall(() =>
        fillAndVerifyDocument(deps, prepared, tempDocId)),
    );
    result = await step.do(
      "finalize publication",
      retries,
      () => workflowCall(() =>
        finalizePublication(deps, prepared, tempDocId)),
    );
  } catch (error) {
    const reason = error instanceof Error
      ? error.message
      : "unknown publication error";
    await step.do(
      "record exhausted publication failure",
      retries,
      () => failPublicationAfterExhaustion(
        deps,
        runId,
        reason,
        validation.value.thaiDate,
      ),
    );
    throw error;
  }

  // Notification failure must not delete or downgrade a completed document.
  await step.do(
    "notify publication success",
    retries,
    () => workflowCall(() =>
      notifyPublicationSuccess(deps, prepared, result)),
  );
  return result;
}

export class PublicationWorkflow extends WorkflowEntrypoint<
  Env,
  PublicationWorkflowParams
> {
  async run(
    event: WorkflowEvent<PublicationWorkflowParams>,
    step: WorkflowStep,
  ): Promise<PublicationResult | null> {
    const clock = { now: () => new Date() };
    return runPublicationWorkflow(
      event.payload,
      step,
      depsFor(this.env, clock),
    );
  }
}
```

- [ ] **Step 4: Write failing trigger tests**

```ts
// test/publication/trigger.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import type { Env } from "../../src/env";
import { handleDocsTrigger } from "../../src/publication/trigger";

const clock = {
  now: () => new Date("2026-09-01T17:30:00.000Z"),
};

const rawConfig = {
  TIME_ZONE: "Asia/Bangkok",
  UPLOAD_CUTOFF_MINUTES: 30,
  PRODUCT_ID_PREFIX: "A",
  IMPORT_CRON: "0 23 * * *",
  IMPORT_RETRY_LIMIT: 5,
  PRODUCT_ID_INITIAL_NUMBER: 1,
  FIRST_IMPORT_CUTOFF_DATE: null,
  AIRTABLE_BASE_ID: "base123",
  AIRTABLE_PRODUCTS_TABLE_ID: "tblProducts",
  LINE_ALLOWED_GROUP_ID: "group-1",
  PUBLIC_BASE_URL: "https://worker.example",
  PUBLICATION_CRON: "30 23 * * *",
  PUBLICATION_RETRY_LIMIT: 5,
  AIRTABLE_PUBLICATION_RUNS_TABLE_ID: "tblRuns",
  GOOGLE_DRIVE_FOLDER_ID: "folder-1",
  GOOGLE_TEMPLATE_DOC_ID: "template-1",
  CLAUDE_MODEL: "claude-opus-5",
  CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 150_000,
};

function mockRun(records: unknown[] = [{
  id: "rec-run-1",
  fields: {
    "Publication Date": "2026-09-02",
    Status: "Ready",
    Products: [],
  },
}]): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ records })),
  );
}

function makeTriggerEnv(statusValue: string) {
  const restart = vi.fn();
  const resume = vi.fn();
  const status = vi.fn().mockResolvedValue({ status: statusValue });
  const get = vi.fn().mockReturnValue({ status, restart, resume });
  const create = vi.fn().mockResolvedValue({ id: "publication-rec-run-1" });
  const env = {
    DB: testEnv.DB,
    APP_CONFIG_JSON: JSON.stringify(rawConfig),
    AIRTABLE_TOKEN: "airtable-token",
    PUBLICATION_WORKFLOW: { get, create },
  } as unknown as Env;
  return { env, get, create, restart, resume };
}

describe("handleDocsTrigger", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await testEnv.DB.exec("DELETE FROM publication_product_cache");
    await testEnv.DB.exec("DELETE FROM publication_jobs");
  });

  it("restarts an errored retained Workflow using the hyphenated ID", async () => {
    mockRun();
    const fixture = makeTriggerEnv("errored");

    const result = await handleDocsTrigger(fixture.env, "admin", clock);

    expect(fixture.get).toHaveBeenCalledWith("publication-rec-run-1");
    expect(fixture.restart).toHaveBeenCalledTimes(1);
    expect(fixture.create).not.toHaveBeenCalled();
    expect(result.status).toBe("restarted");
  });

  it("creates only an unknown instance and records admin trigger", async () => {
    mockRun();
    const fixture = makeTriggerEnv("unknown");

    const result = await handleDocsTrigger(fixture.env, "admin", clock);

    expect(fixture.create).toHaveBeenCalledWith({
      id: "publication-rec-run-1",
      params: {
        publicationRunId: "rec-run-1",
        trigger: "admin",
      },
    });
    expect(result.status).toBe("started");
  });

  it("resumes a paused instance", async () => {
    mockRun();
    const fixture = makeTriggerEnv("paused");
    const result = await handleDocsTrigger(fixture.env, "line", clock);
    expect(fixture.resume).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("resumed");
  });

  it.each(["queued", "running", "waiting", "waitingForPause"])(
    "returns already_running for active status %s",
    async (statusValue) => {
      mockRun();
      const fixture = makeTriggerEnv(statusValue);
      const result = await handleDocsTrigger(fixture.env, "cron", clock);
      expect(result.status).toBe("already_running");
      expect(fixture.create).not.toHaveBeenCalled();
      expect(fixture.restart).not.toHaveBeenCalled();
    },
  );

  it("restarts a complete instance after staff corrects a validation failure", async () => {
    mockRun();
    const fixture = makeTriggerEnv("complete");
    const result = await handleDocsTrigger(fixture.env, "admin", clock);
    expect(fixture.restart).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("restarted");
  });

  it("returns already_generated from D1 without changing Workflow state", async () => {
    mockRun();
    await testEnv.DB.prepare(
      `INSERT INTO publication_jobs
         (publication_run_id, state, correlation_id, google_doc_id,
          google_doc_url, attempt_count, created_at, updated_at)
       VALUES (?, 'succeeded', ?, ?, ?, 1, ?, ?)`,
    ).bind(
      "rec-run-1",
      "corr-1",
      "doc-1",
      "https://docs.google.com/document/d/doc-1/edit",
      clock.now().toISOString(),
      clock.now().toISOString(),
    ).run();
    const fixture = makeTriggerEnv("complete");

    const result = await handleDocsTrigger(fixture.env, "admin", clock);

    expect(result.status).toBe("already_generated");
    expect(fixture.get).not.toHaveBeenCalled();
  });

  it("returns no_runnable_run when today's Bangkok date has no Ready or Failed run", async () => {
    mockRun([]);
    const fixture = makeTriggerEnv("unknown");
    const result = await handleDocsTrigger(fixture.env, "admin", clock);
    expect(result).toEqual({ status: "no_runnable_run" });
    expect(fixture.get).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Implement trigger service**

```ts
// src/publication/trigger.ts
import type { Env } from "../env";
import { parseConfig } from "../config";
import { acquireOrResumeJob } from "../db/publication-repository";
import { todayBangkokDate, type Clock } from "../shared/time";
import { findRunnableRunForDate } from "./airtable-runs";

export type DocsTriggerResult =
  | { status: "no_runnable_run" }
  | { status: "already_generated"; publicationRunId: string }
  | { status: "already_running"; publicationRunId: string }
  | {
      status: "started" | "restarted" | "resumed";
      publicationRunId: string;
    };

export async function handleDocsTrigger(
  env: Env,
  trigger: "cron" | "line" | "admin",
  clock: Clock = { now: () => new Date() },
): Promise<DocsTriggerResult> {
  const config = parseConfig(env.APP_CONFIG_JSON);
  const date = todayBangkokDate(clock);
  const run = await findRunnableRunForDate(
    fetch.bind(globalThis),
    config,
    env.AIRTABLE_TOKEN,
    date,
  );
  if (!run) return { status: "no_runnable_run" };

  const acquired = await acquireOrResumeJob(
    env.DB,
    clock,
    run.airtableRunId,
    `publication-${run.airtableRunId}`,
  );
  if (acquired.alreadySucceeded) {
    return {
      status: "already_generated",
      publicationRunId: run.airtableRunId,
    };
  }

  const id = `publication-${run.airtableRunId}`;
  const instance = env.PUBLICATION_WORKFLOW.get(id);
  const state = await instance.status();
  if (["queued", "running", "waiting", "waitingForPause"].includes(state.status)) {
    return { status: "already_running", publicationRunId: run.airtableRunId };
  }
  if (state.status === "paused") {
    await instance.resume();
    return { status: "resumed", publicationRunId: run.airtableRunId };
  }
  if (["errored", "terminated", "complete"].includes(state.status)) {
    await instance.restart();
    return { status: "restarted", publicationRunId: run.airtableRunId };
  }
  if (state.status !== "unknown") {
    throw new Error(`unsupported publication Workflow status: ${state.status}`);
  }

  try {
    await env.PUBLICATION_WORKFLOW.create({
      id,
      params: { publicationRunId: run.airtableRunId, trigger },
    });
  } catch (error) {
    const raced = await env.PUBLICATION_WORKFLOW.get(id).status();
    if (["queued", "running", "waiting", "waitingForPause"].includes(raced.status)) {
      return { status: "already_running", publicationRunId: run.airtableRunId };
    }
    throw error;
  }
  return { status: "started", publicationRunId: run.airtableRunId };
}
```

- [ ] **Step 6: Write failing `/docs` authentication tests**

```ts
// test/routes/docs.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";

const trigger = vi.hoisted(() => ({
  handleDocsTrigger: vi.fn(),
}));

vi.mock("../../src/publication/trigger", () => trigger);

import { handleDocsRoute } from "../../src/routes/docs";

const env = {
  ADMIN_ROUTE_TOKEN: "correct-token",
} as Env;

describe("POST /docs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trigger.handleDocsTrigger.mockResolvedValue({
      status: "started",
      publicationRunId: "rec-run-1",
    });
  });

  it.each([
    ["missing", undefined],
    ["wrong", "Bearer wrong-token"],
  ])(
    "rejects %s admin bearer before Airtable or Workflow access",
    async (_name, authorization) => {
      const request = new Request("https://worker.example/docs", {
        method: "POST",
        headers: authorization ? { authorization } : undefined,
      });

      const response = await handleDocsRoute(request, env);

      expect(response.status).toBe(401);
      expect(trigger.handleDocsTrigger).not.toHaveBeenCalled();
    },
  );

  it("passes admin trigger after constant-time bearer verification", async () => {
    const clock = {
      now: () => new Date("2026-09-01T17:30:00.000Z"),
    };
    const response = await handleDocsRoute(
      new Request("https://worker.example/docs", {
        method: "POST",
        headers: { authorization: "Bearer correct-token" },
      }),
      env,
      clock,
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "started",
      publicationRunId: "rec-run-1",
    });
    expect(trigger.handleDocsTrigger).toHaveBeenCalledWith(
      env,
      "admin",
      clock,
    );
  });

  it("returns 200 for an idempotent already-generated result", async () => {
    trigger.handleDocsTrigger.mockResolvedValue({
      status: "already_generated",
      publicationRunId: "rec-run-1",
    });
    const response = await handleDocsRoute(
      new Request("https://worker.example/docs", {
        method: "POST",
        headers: { authorization: "Bearer correct-token" },
      }),
      env,
    );
    expect(response.status).toBe(200);
  });
});
```

- [ ] **Step 7: Implement and register `/docs` plus cron**

```ts
// src/routes/docs.ts
import type { Env } from "../env";
import type { Clock } from "../shared/time";
import { verifyAdminBearer } from "../shared/admin-auth";
import { handleDocsTrigger } from "../publication/trigger";

export async function handleDocsRoute(
  request: Request,
  env: Env,
  clock: Clock = { now: () => new Date() },
): Promise<Response> {
  if (!await verifyAdminBearer(request, env.ADMIN_ROUTE_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await handleDocsTrigger(env, "admin", clock);
    const status = ["started", "restarted", "resumed"].includes(result.status)
      ? 202
      : 200;
    return Response.json(result, { status });
  } catch {
    return Response.json(
      { status: "publication_trigger_failed" },
      { status: 500 },
    );
  }
}
```

Add a route test whose mocked trigger rejects with a message containing credential sentinels; assert the response is exactly status 500 with `{ status: "publication_trigger_failed" }` and contains none of the rejected message.

Register exact native route:

```ts
// src/router.ts
import { handleDocsRoute } from "./routes/docs";

if (request.method === "POST" && url.pathname === "/docs") {
  return handleDocsRoute(request, env);
}
```

Keep the existing `GET /assets/*` and `POST /upload` branches in their current order. Extend `test/router.test.ts` with a handler-boundary case proving authenticated `POST /docs` dispatches to `handleDocsRoute`; preserve the existing signed-asset and upload dispatch assertions.

Replace `src/scheduled.ts` with the merged two-cron dispatcher below. It preserves the existing Import status checks and generic `scheduled_import_failed` boundary, adds an injected clock for Bangkok-date publication lookup, and calls the same internal trigger service rather than the HTTP route or publication stages directly:

```ts
// src/scheduled.ts
import type { Env } from "./env";
import { parseConfig } from "./config";
import { handleUploadTrigger } from "./routes/upload";
import { handleDocsTrigger } from "./publication/trigger";
import type { Clock } from "./shared/time";

export async function handleScheduled(
  env: Env,
  cron: string,
  clock: Clock = { now: () => new Date() },
): Promise<void> {
  let failureCode = "scheduled_import_failed";
  try {
    const config = parseConfig(env.APP_CONFIG_JSON);
    if (cron === config.importCron) {
      const response = await handleUploadTrigger(env, "cron");
      if (response.status !== 202 && response.status !== 409) {
        throw new Error("scheduled_import_failed");
      }
      return;
    }
    if (cron === config.publicationCron) {
      failureCode = "scheduled_publication_failed";
      await handleDocsTrigger(env, "cron", clock);
    }
  } catch {
    throw new Error(failureCode);
  }
}
```

Update the existing Worker entrypoint to pass the scheduled event time without changing its `waitUntil` ownership:

```ts
// src/index.ts scheduled handler
ctx.waitUntil(handleScheduled(
  env,
  controller.cron,
  { now: () => new Date(controller.scheduledTime) },
));
```

Append scheduler tests that inject `2026-09-01T17:30:00.000Z`, prove only `PUBLICATION_CRON` calls `handleDocsTrigger(env, "cron", clock)`, prove unrelated crons remain no-ops, and prove a rejected Publication trigger is normalized to exactly `scheduled_publication_failed`. Keep every existing Import scheduler test unchanged.

```ts
const publicationTrigger = vi.hoisted(() => ({
  handleDocsTrigger: vi.fn(),
}));
vi.mock("../src/publication/trigger", () => publicationTrigger);

it("routes only the publication cron through the shared trigger with the scheduled clock", async () => {
  const { env } = scheduledEnv();
  const clock = { now: () => new Date("2026-09-01T17:30:00.000Z") };
  publicationTrigger.handleDocsTrigger.mockResolvedValue({
    status: "no_runnable_run",
  });

  await handleScheduled(env, "30 23 * * *", clock);

  expect(publicationTrigger.handleDocsTrigger).toHaveBeenCalledWith(
    env,
    "cron",
    clock,
  );
});

it("normalizes publication scheduler failures", async () => {
  const { env } = scheduledEnv();
  publicationTrigger.handleDocsTrigger.mockRejectedValue(
    new Error("private upstream response"),
  );

  await expect(handleScheduled(env, "30 23 * * *")).rejects.toThrow(
    /^scheduled_publication_failed$/,
  );
});
```

LINE `/docs` continues to call:

```ts
await handleDocsTrigger(env, "line");
```

It never calls public `POST /docs` and therefore never needs `ADMIN_ROUTE_TOKEN`.

- [ ] **Step 8: Export and bind `PublicationWorkflow` locally**

Add the second Workflow class export beside `ImportWorkflow`:

```ts
// src/index.ts
export { PublicationWorkflow } from "./publication/workflow";
```

Append the publication binding to the existing top-level local `workflows` array in `wrangler.jsonc`:

```jsonc
{
  "name": "snazzy-publication-workflow-local",
  "binding": "PUBLICATION_WORKFLOW",
  "class_name": "PublicationWorkflow"
}
```

Keep the existing `IMPORT_WORKFLOW` entry; local tests and `wrangler dev` require both bindings.

- [ ] **Step 9: Run focused tests**

Run: `npx vitest run test/publication/workflow.test.ts test/publication/trigger.test.ts test/routes/docs.test.ts test/router.test.ts test/scheduled.test.ts`
Expected: PASS.

- [ ] **Step 10: Run full check and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add src/publication/workflow.ts src/publication/trigger.ts src/routes/docs.ts src/router.ts src/scheduled.ts src/index.ts wrangler.jsonc test/publication/workflow.test.ts test/publication/trigger.test.ts test/routes/docs.test.ts test/router.test.ts test/scheduled.test.ts
git commit -m "feat(publication): add durable Workflow and retry-safe triggers"
```

---

## Task 11: Publication acceptance suite

**Files:**
- Create: `test/acceptance/publication.test.ts`

**Interfaces:**
- Consumes: Task 9 stage functions, Task 10 Workflow/trigger functions, Task 4 collage constants, Task 5 caption generator, Task 7 Google client, and D1 publication repository.
- Produces: no production exports.

- [ ] **Step 1: Write complete acceptance cases**

```ts
// test/acceptance/publication.test.ts
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { env as testEnv } from "cloudflare:test";
import type { Env } from "../../src/env";
import {
  acquireOrResumeJob,
  getProductCache,
  setJobState,
  setTempDocId,
} from "../../src/db/publication-repository";
import {
  COLLAGE_BASE_R2_KEY,
  COLLAGE_CELL_POSITIONS,
  COLLAGE_CELL_SIZE,
  type ImageTransformer,
  type ImagesBinding,
} from "../../src/publication/collage";
import {
  copyTemplate,
  fillTemplate,
} from "../../src/publication/google-docs";
import {
  ensureTemporaryDocument,
  failPublicationAfterExhaustion,
  preparePublicationOutputs,
  validatePublication,
  type PublicationServiceDeps,
  type ValidatedPublication,
} from "../../src/publication/service";
import { handleDocsTrigger } from "../../src/publication/trigger";
import type {
  PublicationProduct,
  PublicationRun,
} from "../../src/publication/types";

const clock = {
  now: () => new Date("2026-09-01T17:30:00.000Z"),
};

let privateKey = "";

beforeAll(() => {
  privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
});

const rawConfig = {
  TIME_ZONE: "Asia/Bangkok",
  UPLOAD_CUTOFF_MINUTES: 30,
  PRODUCT_ID_PREFIX: "A",
  IMPORT_CRON: "0 23 * * *",
  IMPORT_RETRY_LIMIT: 5,
  PRODUCT_ID_INITIAL_NUMBER: 1,
  FIRST_IMPORT_CUTOFF_DATE: null,
  AIRTABLE_BASE_ID: "base123",
  AIRTABLE_PRODUCTS_TABLE_ID: "tblProducts",
  LINE_ALLOWED_GROUP_ID: "group-1",
  PUBLIC_BASE_URL: "https://worker.example",
  PUBLICATION_CRON: "30 23 * * *",
  PUBLICATION_RETRY_LIMIT: 5,
  AIRTABLE_PUBLICATION_RUNS_TABLE_ID: "tblRuns",
  GOOGLE_DRIVE_FOLDER_ID: "folder-1",
  GOOGLE_TEMPLATE_DOC_ID: "template-1",
  CLAUDE_MODEL: "claude-opus-5",
  CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 150_000,
};

function product(productId: string, imageCount = 5): PublicationProduct {
  return {
    airtableRecordId: `rec-${productId}`,
    productId,
    orderedImageKeys: Array.from(
      { length: imageCount },
      (_, index) => `assets/${productId}-${index + 1}.jpg`,
    ),
    brandName: "Nike",
    modelName: "Air Max",
    conditionType: "Used",
    size: "42",
    description: "สภาพดี",
    lineSquarePrice: 1290,
    igPrice: 1390,
  };
}

function validated(
  runId: string,
  products: PublicationProduct[],
): ValidatedPublication {
  return {
    run: {
      airtableRunId: runId,
      publicationDate: "2026-09-02",
      status: "Ready",
      products,
    },
    thaiDate: "2 กันยายน 2569",
  };
}

function toolResponse(products: PublicationProduct[]) {
  return {
    content: [{
      type: "tool_use",
      name: "submit_captions",
      input: {
        captions: products.map(({ productId }) => ({
          productId,
          drafts: [
            `แคปชันหนึ่ง ${productId}`,
            `แคปชันสอง ${productId}`,
            `แคปชันสาม ${productId}`,
          ],
        })),
      },
    }],
    usage: {
      input_tokens: products.length * 100,
      output_tokens: products.length * 50,
    },
  };
}

type ImageCall =
  | {
      op: "transform";
      options: Parameters<ImageTransformer["transform"]>[0];
    }
  | {
      op: "draw";
      options: Parameters<ImageTransformer["draw"]>[1];
    }
  | {
      op: "output";
      options: Parameters<ImageTransformer["output"]>[0];
    };

function fakeTransformer(calls: ImageCall[]): ImageTransformer {
  const transformer: ImageTransformer = {
    transform(options) {
      calls.push({ op: "transform", options });
      return transformer;
    },
    draw(_overlay, options) {
      calls.push({ op: "draw", options });
      return transformer;
    },
    async output(options) {
      calls.push({ op: "output", options });
      return {
        response: () => new Response(new Uint8Array([1, 2, 3])),
      };
    },
  };
  return transformer;
}

function baseDeps(
  overrides: Partial<PublicationServiceDeps> = {},
): PublicationServiceDeps {
  const imageCalls: ImageCall[] = [];
  return {
    db: testEnv.DB,
    assets: {
      putOriginal: vi.fn(),
      signUrl: vi.fn(async (key: string) =>
        `https://worker.example/assets/${encodeURIComponent(key)}?expires=1&signature=x`),
    } as PublicationServiceDeps["assets"],
    bucket: {
      get: vi.fn(async () => ({ body: new ReadableStream() })),
      put: vi.fn(),
    } as unknown as R2Bucket,
    images: {
      input: () => fakeTransformer(imageCalls),
    } satisfies ImagesBinding,
    fetcher: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "ok" })),
    ) as unknown as typeof fetch,
    anthropic: {
      messages: {
        countTokens: vi.fn().mockResolvedValue({ input_tokens: 1_000 }),
        create: vi.fn(),
      },
    } as unknown as PublicationServiceDeps["anthropic"],
    clock,
    config: {
      airtableBaseId: "base123",
      airtableProductsTableId: "tblProducts",
      airtablePublicationRunsTableId: "tblRuns",
      googleDriveFolderId: "folder-1",
      googleTemplateDocId: "template-1",
      claudeModel: "claude-opus-5",
      claudeRequestInputTokenLimit: 150_000,
      publicationRetryLimit: 5,
      publicBaseUrl: "https://worker.example",
      lineAllowedGroupId: "group-1",
      timeZone: "Asia/Bangkok",
    } as PublicationServiceDeps["config"],
    airtableToken: "airtable-token",
    googleServiceAccountJson: JSON.stringify({
      client_email: "svc@example.com",
      private_key: privateKey,
    }),
    notify: vi.fn(),
    ...overrides,
  };
}

async function createJob(runId: string): Promise<void> {
  await acquireOrResumeJob(testEnv.DB, clock, runId, `publication-${runId}`);
}

async function cacheCollage(runId: string, productId: string): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO publication_product_cache
       (publication_run_id, product_id, collage_r2_key, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(
    runId,
    productId,
    `products/${productId}/collage/1080x1080.jpg`,
    clock.now().toISOString(),
  ).run();
}

function runnableRunResponse(): Response {
  return new Response(JSON.stringify({
    records: [{
      id: "rec-run-1",
      fields: {
        "Publication Date": "2026-09-02",
        Status: "Ready",
        Products: [],
      },
    }],
  }));
}

describe("publication acceptance", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM publication_product_cache");
    await testEnv.DB.exec("DELETE FROM publication_jobs");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("missing field blocks whole run before Google copy", async () => {
    const invalid = product("A-1001");
    invalid.description = "";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "rec-run-1",
        fields: {
          "Publication Date": "2026-09-02",
          Status: "Ready",
          Products: ["rec-A-1001"],
        },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        records: [{
          id: "rec-A-1001",
          fields: {
            "Product ID": invalid.productId,
            "Product Images": invalid.orderedImageKeys.map((key, index) => ({
              id: String(index),
              url: `https://dl.airtable.com/${index}`,
              filename: key.slice("assets/".length),
            })),
            "Brand Name": invalid.brandName,
            "Model Name": invalid.modelName,
            "Condition Type": invalid.conditionType,
            Size: invalid.size,
            Description: invalid.description,
            "LINE Square Price": invalid.lineSquarePrice,
            "IG Price": invalid.igPrice,
          },
        }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "rec-run-1" })));
    const deps = baseDeps({ fetcher: fetcher as unknown as typeof fetch });

    const outcome = await validatePublication(
      deps,
      "rec-run-1",
      "publication-rec-run-1",
    );

    expect(outcome.kind).toBe("validation_failed");
    const patch = JSON.parse(String(fetcher.mock.calls[2]![1]?.body));
    expect(patch.fields).toEqual({
      Status: "Draft",
      "Error Summary": "A-1001: Description",
    });
    expect(fetcher.mock.calls.some(([url]) =>
      String(url).includes("googleapis.com"))).toBe(false);
    expect(deps.anthropic.messages.create).not.toHaveBeenCalled();
    expect(deps.bucket.get).not.toHaveBeenCalled();
    expect(deps.bucket.put).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("first four ordered images occupy deterministic 2x2 positions", async () => {
    const runId = "rec-run-collage";
    const item = product("A-1001", 5);
    await createJob(runId);
    await testEnv.DB.prepare(
      `INSERT INTO publication_product_cache
         (publication_run_id, product_id, captions_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(
      runId,
      item.productId,
      JSON.stringify(["หนึ่ง", "สอง", "สาม"]),
      clock.now().toISOString(),
    ).run();
    const imageCalls: ImageCall[] = [];
    const get = vi.fn(async (key: string) => {
      const allowed = [COLLAGE_BASE_R2_KEY, ...item.orderedImageKeys.slice(0, 4)];
      return allowed.includes(key) ? { body: new ReadableStream() } : null;
    });
    const deps = baseDeps({
      bucket: { get, put: vi.fn() } as unknown as R2Bucket,
      images: { input: () => fakeTransformer(imageCalls) },
    });

    const prepared = await preparePublicationOutputs(
      deps,
      validated(runId, [item]),
    );

    expect(get.mock.calls.map(([key]) => key)).toEqual([
      COLLAGE_BASE_R2_KEY,
      ...item.orderedImageKeys.slice(0, 4),
    ]);
    expect(get).not.toHaveBeenCalledWith(item.orderedImageKeys[4]);
    expect(prepared.outputs[0]!.collageR2Key).toBe(
      "products/A-1001/collage/1080x1080.jpg",
    );
    const transforms = imageCalls.filter(
      (call): call is Extract<
        ImageCall,
        { op: "transform" }
      > => call.op === "transform",
    );
    expect(transforms).toHaveLength(4);
    for (const call of transforms) {
      expect(call.options).toEqual({
        width: COLLAGE_CELL_SIZE,
        height: COLLAGE_CELL_SIZE,
        fit: "contain",
        background: "#FFFFFF",
      });
    }
    expect(imageCalls
      .filter(
        (call): call is Extract<
          ImageCall,
          { op: "draw" }
        > => call.op === "draw",
      )
      .map(({ options }) => ({
        top: options.top,
        left: options.left,
      }))).toEqual(COLLAGE_CELL_POSITIONS);
  });

  it("exactly three Thai captions are cached for a normal 22-product run in one request", async () => {
    const runId = "rec-run-22";
    const products = Array.from(
      { length: 22 },
      (_, index) => product(`A-${1001 + index}`, 4),
    );
    await createJob(runId);
    for (const item of products) await cacheCollage(runId, item.productId);
    const countTokens = vi.fn().mockResolvedValue({ input_tokens: 12_000 });
    const create = vi.fn().mockResolvedValue(toolResponse(products));
    const deps = baseDeps({
      anthropic: { messages: { countTokens, create } } as unknown as
        PublicationServiceDeps["anthropic"],
    });

    const prepared = await preparePublicationOutputs(
      deps,
      validated(runId, products),
    );

    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(prepared.outputs).toHaveLength(22);
    const prompt = create.mock.calls[0]![0].messages[0]!.content as string;
    expect(prompt).not.toContain("assets/");
    for (const item of products) {
      const cache = await getProductCache(testEnv.DB, runId, item.productId);
      const drafts = JSON.parse(cache.captionsJson ?? "[]") as string[];
      expect(drafts).toHaveLength(3);
      expect(drafts.every((draft) => draft.trim().length > 0)).toBe(true);
      expect(drafts.every((draft) => /[ก-๙]/.test(draft))).toBe(true);
    }
  });

  it("retry requests only uncached or invalid Product IDs", async () => {
    const runId = "rec-run-retry";
    const products = [product("A-1001", 4), product("A-1002", 4), product("A-1003", 4)];
    await createJob(runId);
    for (const item of products) await cacheCollage(runId, item.productId);
    const create = vi.fn()
      .mockResolvedValueOnce(toolResponse(products.slice(0, 2)))
      .mockResolvedValueOnce(toolResponse(products.slice(2)));
    const deps = baseDeps({
      anthropic: {
        messages: {
          countTokens: vi.fn().mockResolvedValue({ input_tokens: 1_000 }),
          create,
        },
      } as unknown as PublicationServiceDeps["anthropic"],
    });

    await expect(
      preparePublicationOutputs(deps, validated(runId, products)),
    ).rejects.toThrow("caption generation incomplete for A-1003");
    expect((await getProductCache(testEnv.DB, runId, "A-1001")).captionsJson).not.toBeNull();
    expect((await getProductCache(testEnv.DB, runId, "A-1002")).captionsJson).not.toBeNull();
    expect((await getProductCache(testEnv.DB, runId, "A-1003")).captionsJson).toBeNull();

    await preparePublicationOutputs(deps, validated(runId, products));

    const firstPrompt = create.mock.calls[0]![0].messages[0]!.content as string;
    const retryPrompt = create.mock.calls[1]![0].messages[0]!.content as string;
    expect(firstPrompt).toContain("A-1001");
    expect(firstPrompt).toContain("A-1002");
    expect(firstPrompt).toContain("A-1003");
    expect(retryPrompt).not.toContain("A-1001");
    expect(retryPrompt).not.toContain("A-1002");
    expect(retryPrompt).toContain("A-1003");

    const schemaRunId = "rec-run-schema";
    await createJob(schemaRunId);
    for (const item of products) await cacheCollage(schemaRunId, item.productId);
    const schemaDeps = baseDeps({
      anthropic: {
        messages: {
          countTokens: vi.fn().mockResolvedValue({ input_tokens: 1_000 }),
          create: vi.fn().mockResolvedValue({
            content: [],
            usage: {
              input_tokens: 0,
              output_tokens: 0,
            },
          }),
        },
      } as unknown as PublicationServiceDeps["anthropic"],
    });
    await expect(
      preparePublicationOutputs(schemaDeps, validated(schemaRunId, products)),
    ).rejects.toThrow(/caption generation incomplete/);
    for (const item of products) {
      expect((await getProductCache(
        testEnv.DB,
        schemaRunId,
        item.productId,
      )).captionsJson).toBeNull();
    }
  });

  it("Drive appProperties recovery prevents a second copy and document refill", async () => {
    const runId = "rec-run-drive";
    await createJob(runId);
    const tokenProvider = {
      getAccessToken: vi.fn().mockResolvedValue("google-token"),
    };
    const initialCopyFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "temp-doc-1" })),
    );

    const copiedId = await copyTemplate(
      initialCopyFetch as unknown as typeof fetch,
      tokenProvider,
      "template-1",
      "folder-1",
      runId,
      "Publication 2026-09-02 (in progress)",
    );
    expect(copiedId).toBe("temp-doc-1");
    // Simulate copy success followed by failure before setTempDocId persisted.
    expect((await acquireOrResumeJob(
      testEnv.DB,
      clock,
      runId,
      "corr-check",
    )).job.tempDocId).toBeNull();

    const recoveryFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "google-token",
        expires_in: 3600,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        files: [{ id: "temp-doc-1" }],
      })));
    const deps = baseDeps({
      fetcher: recoveryFetch as unknown as typeof fetch,
    });
    const recoveredId = await ensureTemporaryDocument(
      deps,
      { ...validated(runId, []), outputs: [] },
    );

    expect(recoveredId).toBe("temp-doc-1");
    expect(recoveryFetch.mock.calls.some(([url]) =>
      String(url).endsWith("/copy"))).toBe(false);
    const query = new URL(String(recoveryFetch.mock.calls[1]![0]))
      .searchParams.get("q");
    expect(query).toContain("'folder-1' in parents");
    expect(query).toContain("key='publicationRunId'");
    expect(query).toContain(`value='${runId}'`);

    const fillFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        body: { content: [
          { paragraph: { elements: [{
            startIndex: 1,
            endIndex: 21,
            textRun: { content: "{{PUBLICATION_DATE}}" },
          }] } },
          { paragraph: { elements: [{
            startIndex: 21,
            endIndex: 55,
            textRun: {
              content: "{{PRODUCTS}}suffix{{END_PRODUCTS}}",
            },
          }] } },
        ] },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ documentId: "temp-doc-1" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        body: { content: [{ paragraph: { elements: [
          { textRun: { content: "Product ID: A-1001" } },
        ] } }] },
      })));
    const docProduct = {
      productId: "A-1001",
      conditionType: "Used",
      description: "สภาพดี",
      lineSquarePrice: 1290,
      igPrice: 1390,
      captionDrafts: ["หนึ่ง", "สอง", "สาม"] as [string, string, string],
      collageImageUrl: "https://worker.example/signed-collage",
    };
    await fillTemplate(
      fillFetch as unknown as typeof fetch,
      tokenProvider,
      "temp-doc-1",
      "2 กันยายน 2569",
      [docProduct],
    );
    await fillTemplate(
      fillFetch as unknown as typeof fetch,
      tokenProvider,
      "temp-doc-1",
      "2 กันยายน 2569",
      [docProduct],
    );
    expect(fillFetch.mock.calls.filter(([url]) =>
      String(url).includes(":batchUpdate"))).toHaveLength(1);
  });

  it("duplicate docs trigger reuses one hyphenated Workflow ID", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      runnableRunResponse());

    function workflowEnv(statusValue: string) {
      const restart = vi.fn();
      const resume = vi.fn();
      const get = vi.fn().mockReturnValue({
        status: vi.fn().mockResolvedValue({ status: statusValue }),
        restart,
        resume,
      });
      const create = vi.fn().mockResolvedValue({
        id: "publication-rec-run-1",
      });
      const env = {
        DB: testEnv.DB,
        APP_CONFIG_JSON: JSON.stringify(rawConfig),
        AIRTABLE_TOKEN: "airtable-token",
        PUBLICATION_WORKFLOW: { get, create },
      } as unknown as Env;
      return { env, get, create, restart };
    }

    const first = workflowEnv("unknown");
    expect((await handleDocsTrigger(first.env, "admin", clock)).status)
      .toBe("started");
    expect(first.create).toHaveBeenCalledWith({
      id: "publication-rec-run-1",
      params: {
        publicationRunId: "rec-run-1",
        trigger: "admin",
      },
    });

    const active = workflowEnv("running");
    expect((await handleDocsTrigger(active.env, "line", clock)).status)
      .toBe("already_running");

    const errored = workflowEnv("errored");
    expect((await handleDocsTrigger(errored.env, "admin", clock)).status)
      .toBe("restarted");
    expect(errored.restart).toHaveBeenCalledTimes(1);

    await setJobState(testEnv.DB, clock, "rec-run-1", "succeeded", {
      googleDocId: "doc-1",
      googleDocUrl: "https://docs.google.com/document/d/doc-1/edit",
    });
    const succeeded = workflowEnv("complete");
    expect((await handleDocsTrigger(succeeded.env, "admin", clock)).status)
      .toBe("already_generated");
    expect(succeeded.get).not.toHaveBeenCalled();

    for (const fixture of [first, active, errored, succeeded]) {
      for (const [options] of fixture.create.mock.calls) {
        expect(options.id).toMatch(/^publication-/);
        expect(options.id).not.toContain(":");
      }
    }
  });

  it("keeps temp doc during six calls and deletes it only after retry exhaustion", async () => {
    const runId = "rec-run-exhausted";
    await createJob(runId);
    await setTempDocId(testEnv.DB, clock, runId, "temp-doc-1");
    const fill = vi.fn().mockRejectedValue(new Error("google 503"));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "google-token",
        expires_in: 3600,
      })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: runId })));
    const deps = baseDeps({ fetcher: fetcher as unknown as typeof fetch });

    for (let call = 0; call < 6; call += 1) {
      await expect(fill()).rejects.toThrow("google 503");
      expect(fetcher.mock.calls.some(([, init]) =>
        init?.method === "DELETE")).toBe(false);
    }

    await failPublicationAfterExhaustion(
      deps,
      runId,
      "google 503",
      "2 กันยายน 2569",
    );

    expect(fill).toHaveBeenCalledTimes(6);
    expect(fetcher.mock.calls.filter(([, init]) =>
      init?.method === "DELETE")).toHaveLength(1);
    expect((await acquireOrResumeJob(
      testEnv.DB,
      clock,
      runId,
      "corr-after",
    )).job).toMatchObject({ state: "failed", tempDocId: null });
  });
});
```

Task 10's pure Workflow-runner test proves `step.do()` invokes those six failed calls and only then calls `failPublicationAfterExhaustion`; this acceptance case uses the real cleanup function to prove its D1, Drive, Airtable, and LINE effects.

- [ ] **Step 2: Run acceptance suite**

Run: `npx vitest run test/acceptance/publication.test.ts`
Expected: PASS — 7 acceptance tests green. Any failure identifies an integration defect in production code from Tasks 1–10, not missing test scaffolding.

- [ ] **Step 3: Fix only publication integration defects if Step 2 fails**

Allowed files: `src/publication/*.ts`, `src/routes/docs.ts`, `src/scheduled.ts`, `src/db/publication-repository.ts`, and their existing tests. Do not create alternate production paths or replace real stage calls with acceptance-only helpers. Re-run the single failing test after each minimal fix until all 7 pass.

- [ ] **Step 4: Run focused, acceptance, and full checks**

Run: `npx vitest run test/acceptance/publication.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/acceptance/publication.test.ts src/publication src/routes/docs.ts src/scheduled.ts src/db/publication-repository.ts
git commit -m "test(publication): prove validation, retry, recovery, and one-document invariants"
```

---

## Plan Completion Definition

This plan is complete only when:

- `npm run check` passes with all publication tests.
- `migrations/0003_publication.sql` applies after `0001_initial.sql` and `0002_import_run_terminal_details.sql` on a fresh local D1 database.
- Missing Product data returns the Airtable run to Draft, writes the complete Error Summary, sends a Thai LINE report, and performs no Google/Claude/Images/R2 side effect.
- Collages use the first four ordered images, deterministic 1080×1080 2×2 contain layout, white padding, private R2 storage, and shared `AssetStore.signUrl` delivery.
- Caption generation uses official `@anthropic-ai/sdk`, model `claude-opus-5`, adaptive thinking, `maxRetries: 0`, deterministic token batching, exactly three Thai drafts, valid-output caching, and missing-only retry.
- Google Drive copy is tagged with `appProperties.publicationRunId`, rediscovered after uncertain copy persistence, and never duplicated for one Airtable Publication Run.
- Google document fill is retry-safe: one atomic batch, completed-document no-op detection, Product ID verification, and one final document URL.
- Transient stages receive one initial call plus five retries. Temporary document deletion and Failed status occur only after exhaustion; validation failures do not create a document or mark Failed.
- `POST /docs` rejects missing/wrong bearer tokens, uses trigger `admin`, and shares internal trigger code with cron and LINE.
- Cron and `/docs` use Bangkok date and create/restart/resume `PublicationWorkflow` under `publication-<airtablePublicationRunId>`; no colon Workflow ID remains.

## Self-Review Notes

- **Spec coverage:** Tasks 1–11 cover D1 idempotency, whole-run validation, deterministic collage, Claude batching/cache, retry-safe Drive/Docs generation, LINE reports, Workflow stage retries, authenticated manual trigger, cron, and acceptance.
- **Reuse:** Private R2 signing/delivery reuses Import `AssetStore`; no second signer, route, or `R2Bucket.createSignedUrl` call exists.
- **Retry ownership:** Cloudflare `step.do()` owns retry count. Anthropic automatic retries remain disabled. Permanent `OperationalError` values become `cloudflare:workflows` `NonRetryableError` with preserved code.
- **Type consistency:** `PublicationWorkflowParams.trigger` is `"cron" | "line" | "admin"`; every cache call uses Airtable Publication Run ID; every trigger uses hyphenated Workflow ID.
