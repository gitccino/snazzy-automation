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
- Retry transient workflow steps five times with exponential backoff (`PUBLICATION_MAX_ATTEMPTS=5`).
- Never log credentials, public-album token/link, signed URLs, Product images, or raw external response bodies containing them.
- Use native `fetch` routing; do not add a web framework.
- Use official `@anthropic-ai/sdk`; do not call Claude through raw HTTP.
- Use Web Crypto for the Google service-account JWT; do not add a Node-only Google SDK.
- Use current Cloudflare Vitest plugin: `@cloudflare/vitest-plugin` with Vitest 4.1 or later; do not use removed `@cloudflare/vitest-pool-workers` APIs.
- Cloudflare compatibility date must be `2026-09-01` or later and include `nodejs_compat`.
- Every non-trivial parser, state transition, money mutation, and trust boundary starts with a failing test.
- Every task ends with focused tests, the full test command, and a commit.
- Anthropic client uses `maxRetries: 0`; Cloudflare Workflow `step.do()` owns durable retry count and backoff.
- Idempotency keys: Workflow instance `publication:<airtablePublicationRunId>`; publication final output unique key is the Airtable Publication Run ID.

## Assumptions Carried From the Completed Import Plan

The import plan (`docs/superpowers/plans/2026-09-01-snazzy-import-pipeline.md`) is assumed complete and has already created the following, which this plan extends or imports without modification unless a task says otherwise:

- `src/env.ts` exporting `Env` exactly as defined in the implementation index, already including `PUBLICATION_WORKFLOW: Workflow<PublicationWorkflowParams>`.
- `src/config.ts` exporting `parseConfig(json: string): AppConfig` and an `AppConfig` interface covering every non-secret key in spec section 15, including `googleDriveFolderId`, `googleTemplateDocId`, `claudeModel`, `claudeRequestInputTokenLimit`, `publicationCron`, `publicationMaxAttempts`, `timeZone`.
- `src/shared/errors.ts` exporting `OperationalError` (has `code: string`, `message: string`, `retryable: boolean`) and a `RetryableError`/`NonRetryableError` pair built on it.
- `src/shared/http.ts` exporting `jsonResponse(body, init?)` and `fetchJson<T>(fetcher: Fetcher, input, init) => Promise<T>`.
- `src/shared/ids.ts` exporting `newCorrelationId(): string` and `sha256Hex(input: string): Promise<string>`.
- `src/shared/time.ts` exporting `nowInBangkok(clock: Clock): Date` and `formatThaiDate(date: Date): string`.
- `src/shared/logger.ts` exporting `createLogger(correlationId: string)` with `.info()`/`.warn()`/`.error()` methods that redact configured secret values.
- `src/db/audit.ts` exporting `recordAuditEvent(db: D1Database, event: { actor: string; action: string; before: unknown; after: unknown; correlationId: string }): Promise<void>`.
- `src/line/client.ts` exporting `pushTextMessage(env: Env, groupId: string, text: string): Promise<void>` (reply/push REST client built for import logs).
- `src/line/messages.ts` exporting Thai message builders used for import logs; this plan adds publication-specific builders to the same file.
- `src/import/airtable-products.ts` exporting an Airtable REST helper pattern (auth header, base/table path construction, retry-free single-call semantics) that `publication/airtable-runs.ts` mirrors for consistency.
- Migration `migrations/0001_initial.sql` already applied, containing `sequences`, `import_runs`, `photo_assets`, `product_groups`, `line_commands`, `audit_events`.

If any assumed export has a different name or signature in the real codebase, the implementer adjusts only the import path/signature at the call site — the behavior contracts in this plan (parameter and return types defined by prior tasks in *this* plan) do not change.

---

## Task 1: Publication D1 schema and repository

**Files:**
- Create: `migrations/0002_publication.sql`
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
  used by `publication/service.ts` and `publication/workflow.ts` (Tasks 7 and 9).

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
-- migrations/0002_publication.sql
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

Run: `npx wrangler d1 migrations apply snazzy-automation --local`
Expected: `0002_publication.sql` applied with no errors.

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
Expected: PASS — 5 tests green.

- [ ] **Step 7: Full check and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add migrations/0002_publication.sql src/db/publication-repository.ts test/db/publication-repository.test.ts
git commit -m "feat(publication): add D1 job lock and per-product output cache"
```

---

## Task 2: Airtable Publication Runs client

**Files:**
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
    trigger: "cron" | "line";
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
  export async function findReadyRunForDate(
    fetcher: Fetcher,
    config: AppConfig,
    token: string,
    isoDate: string,
  ): Promise<PublicationRun | null>;

  export async function loadRunById(
    fetcher: Fetcher,
    config: AppConfig,
    token: string,
    airtableRunId: string,
  ): Promise<PublicationRun>;

  export async function markRunGenerating(fetcher: Fetcher, config: AppConfig, token: string, airtableRunId: string): Promise<void>;

  export async function markRunGenerated(
    fetcher: Fetcher,
    config: AppConfig,
    token: string,
    airtableRunId: string,
    googleDocUrl: string,
    generatedAtIso: string,
  ): Promise<void>;

  export async function markRunNeedsCorrection(
    fetcher: Fetcher,
    config: AppConfig,
    token: string,
    airtableRunId: string,
    errorSummary: string,
  ): Promise<void>;

  export async function markRunFailed(
    fetcher: Fetcher,
    config: AppConfig,
    token: string,
    airtableRunId: string,
    errorSummary: string,
  ): Promise<void>;

  export async function updateProductCollage(
    fetcher: Fetcher,
    config: AppConfig,
    token: string,
    airtableRecordId: string,
    signedCollageUrl: string,
  ): Promise<void>;
  ```
  used by `publication/service.ts` (Task 7).

- [ ] **Step 1: Write the failing test**

```ts
// test/publication/airtable-runs.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  findReadyRunForDate,
  markRunGenerating,
  markRunGenerated,
  markRunNeedsCorrection,
  updateProductCollage,
} from "../../src/publication/airtable-runs";

const config = {
  airtableBaseId: "base123",
  airtableProductsTableId: "tblProducts",
  airtablePublicationRunsTableId: "tblRuns",
} as any;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("findReadyRunForDate", () => {
  it("returns null when no Ready run matches the date", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ records: [] }));
    const result = await findReadyRunForDate(fetcher as any, config, "token", "2026-09-01");
    expect(result).toBeNull();
  });

  it("fetches linked products and maps fields into PublicationProduct", async () => {
    const fetcher = vi
      .fn()
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
                "Product Images": [{ id: "attImg1", url: "https://dl.airtable.com/img1.jpg" }],
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

    const result = await findReadyRunForDate(fetcher as any, config, "token", "2026-09-01");
    expect(result).not.toBeNull();
    expect(result?.products).toHaveLength(1);
    expect(result?.products[0]).toMatchObject({
      airtableRecordId: "recProd1",
      productId: "A-1001",
      brandName: "Nike",
      lineSquarePrice: 1290,
      igPrice: 1390,
    });
    const firstCallUrl = String(fetcher.mock.calls[0][0]);
    expect(firstCallUrl).toContain("tblRuns");
    expect(firstCallUrl).toContain(encodeURIComponent("2026-09-01"));
  });
});

describe("status writes", () => {
  it("markRunGenerating PATCHes Status to Generating", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ id: "recRun1" }));
    await markRunGenerating(fetcher as any, config, "token", "recRun1");
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain("recRun1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body).fields.Status).toBe("Generating");
  });

  it("markRunGenerated writes doc URL, timestamp, and Generated status", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ id: "recRun1" }));
    await markRunGenerated(fetcher as any, config, "token", "recRun1", "https://docs.google.com/x", "2026-09-01T06:00:00.000Z");
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.fields.Status).toBe("Generated");
    expect(body.fields["Google Doc URL"]).toBe("https://docs.google.com/x");
    expect(body.fields["Generated At"]).toBe("2026-09-01T06:00:00.000Z");
  });

  it("markRunNeedsCorrection returns Status to Draft with Error Summary", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ id: "recRun1" }));
    await markRunNeedsCorrection(fetcher as any, config, "token", "recRun1", "A-1001: missing Description");
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.fields.Status).toBe("Draft");
    expect(body.fields["Error Summary"]).toBe("A-1001: missing Description");
  });
});

describe("updateProductCollage", () => {
  it("PATCHes the 4-in-1 Image attachment field with the signed URL", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ id: "recProd1" }));
    await updateProductCollage(fetcher as any, config, "token", "recProd1", "https://r2.example.com/signed");
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.fields["4-in-1 Image"]).toEqual([{ url: "https://r2.example.com/signed" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publication/airtable-runs.test.ts`
Expected: FAIL — `Cannot find module '../../src/publication/airtable-runs'`.

- [ ] **Step 3: Write `src/publication/types.ts`**

Use the interfaces shown in the Interfaces block above verbatim.

- [ ] **Step 4: Write `src/publication/airtable-runs.ts`**

```ts
// src/publication/airtable-runs.ts
import type { AppConfig } from "../config";
import type { Fetcher } from "../shared/http";
import type { PublicationProduct, PublicationRun, PublicationRunStatus } from "./types";

function airtableUrl(config: AppConfig, tableId: string, path = ""): string {
  return `https://api.airtable.com/v0/${config.airtableBaseId}/${tableId}${path}`;
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

interface AirtableRunFields {
  "Publication Date": string;
  Status: PublicationRunStatus;
  Products?: string[];
}

interface AirtableProductFields {
  "Product ID": string;
  "Product Images"?: Array<{ id: string; url: string }>;
  "Brand Name"?: string;
  "Model Name"?: string;
  "Condition Type"?: string;
  Size?: string;
  Description?: string;
  "LINE Square Price"?: number;
  "IG Price"?: number;
}

async function fetchLinkedProducts(
  fetcher: Fetcher,
  config: AppConfig,
  token: string,
  recordIds: string[],
): Promise<PublicationProduct[]> {
  if (recordIds.length === 0) return [];
  const formula = `OR(${recordIds.map((id) => `RECORD_ID()='${id}'`).join(",")})`;
  const url = `${airtableUrl(config, config.airtableProductsTableId)}?filterByFormula=${encodeURIComponent(formula)}`;
  const response = await fetcher(url, { headers: authHeaders(token) });
  if (!response.ok) {
    throw new Error(`airtable products fetch failed with status ${response.status}`);
  }
  const body = (await response.json()) as { records: Array<{ id: string; fields: AirtableProductFields }> };
  return body.records.map((record) => ({
    airtableRecordId: record.id,
    productId: record.fields["Product ID"],
    orderedImageKeys: (record.fields["Product Images"] ?? []).map((image) => image.url),
    brandName: record.fields["Brand Name"] ?? "",
    modelName: record.fields["Model Name"] ?? "",
    conditionType: record.fields["Condition Type"] ?? "",
    size: record.fields.Size ?? "",
    description: record.fields.Description ?? "",
    lineSquarePrice: record.fields["LINE Square Price"] ?? 0,
    igPrice: record.fields["IG Price"] ?? 0,
  }));
}

export async function findReadyRunForDate(
  fetcher: Fetcher,
  config: AppConfig,
  token: string,
  isoDate: string,
): Promise<PublicationRun | null> {
  const formula = `AND({Publication Date}='${isoDate}',{Status}='Ready')`;
  const url = `${airtableUrl(config, config.airtablePublicationRunsTableId)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const response = await fetcher(url, { headers: authHeaders(token) });
  if (!response.ok) {
    throw new Error(`airtable runs fetch failed with status ${response.status}`);
  }
  const body = (await response.json()) as { records: Array<{ id: string; fields: AirtableRunFields }> };
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
  config: AppConfig,
  token: string,
  airtableRunId: string,
): Promise<PublicationRun> {
  const url = airtableUrl(config, config.airtablePublicationRunsTableId, `/${airtableRunId}`);
  const response = await fetcher(url, { headers: authHeaders(token) });
  if (!response.ok) {
    throw new Error(`airtable run fetch failed with status ${response.status}`);
  }
  const body = (await response.json()) as { id: string; fields: AirtableRunFields };
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
  config: AppConfig,
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
    throw new Error(`airtable run update failed with status ${response.status}`);
  }
}

export async function markRunGenerating(fetcher: Fetcher, config: AppConfig, token: string, airtableRunId: string): Promise<void> {
  await patchRun(fetcher, config, token, airtableRunId, { Status: "Generating" });
}

export async function markRunGenerated(
  fetcher: Fetcher,
  config: AppConfig,
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
  config: AppConfig,
  token: string,
  airtableRunId: string,
  errorSummary: string,
): Promise<void> {
  await patchRun(fetcher, config, token, airtableRunId, { Status: "Draft", "Error Summary": errorSummary });
}

export async function markRunFailed(
  fetcher: Fetcher,
  config: AppConfig,
  token: string,
  airtableRunId: string,
  errorSummary: string,
): Promise<void> {
  await patchRun(fetcher, config, token, airtableRunId, { Status: "Failed", "Error Summary": errorSummary });
}

export async function updateProductCollage(
  fetcher: Fetcher,
  config: AppConfig,
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
    throw new Error(`airtable product collage update failed with status ${response.status}`);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/publication/airtable-runs.test.ts`
Expected: PASS — 6 tests green.

- [ ] **Step 6: Full check and commit**

Run: `npm run check`

```bash
git add src/publication/types.ts src/publication/airtable-runs.ts test/publication/airtable-runs.test.ts
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
  used by `publication/service.ts` (Task 7) and LINE message builders (Task 8).

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
  used by `publication/service.ts` (Task 7).

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

function fakeTransformer(calls: unknown[]): ImageTransformer {
  const transformer: ImageTransformer = {
    transform(options) {
      calls.push({ op: "transform", options });
      return transformer;
    },
    draw(overlay, options) {
      calls.push({ op: "draw", options });
      return transformer;
    },
    async output(options) {
      calls.push({ op: "output", options });
      return { response: () => new Response(new Uint8Array([1, 2, 3])) };
    },
  };
  return transformer;
}

function fakeBucket(keys: string[]): R2Bucket {
  return {
    async get(key: string) {
      if (!keys.includes(key)) return null;
      return { body: new ReadableStream() } as any;
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
    const calls: unknown[] = [];
    const images: ImagesBinding = { input: () => fakeTransformer(calls) };
    const bucket = fakeBucket([]);
    await expect(
      generateCollage(bucket, images, ["assets/a.jpg", "assets/b.jpg", "assets/c.jpg", "assets/d.jpg"]),
    ).rejects.toThrow(/collage base/i);
  });

  it("throws when a source image key is missing from R2", async () => {
    const calls: unknown[] = [];
    const images: ImagesBinding = { input: () => fakeTransformer(calls) };
    const bucket = fakeBucket([COLLAGE_BASE_R2_KEY, "assets/a.jpg"]);
    await expect(
      generateCollage(bucket, images, ["assets/a.jpg", "assets/missing.jpg", "assets/c.jpg", "assets/d.jpg"]),
    ).rejects.toThrow(/source image/i);
  });

  it("applies deterministic contain-fit transform and draw offsets in ordered-image order", async () => {
    const calls: unknown[] = [];
    const images: ImagesBinding = { input: () => fakeTransformer(calls) };
    const keys: [string, string, string, string] = ["assets/a.jpg", "assets/b.jpg", "assets/c.jpg", "assets/d.jpg"];
    const bucket = fakeBucket([COLLAGE_BASE_R2_KEY, ...keys]);

    await generateCollage(bucket, images, keys);

    const transformCalls = calls.filter((c: any) => c.op === "transform");
    expect(transformCalls).toHaveLength(4);
    for (const call of transformCalls as any[]) {
      expect(call.options).toEqual({ width: COLLAGE_CELL_SIZE, height: COLLAGE_CELL_SIZE, fit: "contain", background: "#FFFFFF" });
    }

    const drawCalls = calls.filter((c: any) => c.op === "draw");
    expect(drawCalls).toHaveLength(4);
    expect((drawCalls as any[]).map((c) => ({ top: c.options.top, left: c.options.left }))).toEqual(COLLAGE_CELL_POSITIONS);

    const outputCall = calls.find((c: any) => c.op === "output") as any;
    expect(outputCall.options).toEqual({ format: "image/jpeg", quality: 90 });
  });

  it("produces identical transform/draw call sequence across repeated runs (idempotent parameters)", async () => {
    const keys: [string, string, string, string] = ["assets/a.jpg", "assets/b.jpg", "assets/c.jpg", "assets/d.jpg"];
    const bucket = fakeBucket([COLLAGE_BASE_R2_KEY, ...keys]);

    const callsA: unknown[] = [];
    const imagesA: ImagesBinding = { input: () => fakeTransformer(callsA) };
    await generateCollage(bucket, imagesA, keys);

    const callsB: unknown[] = [];
    const imagesB: ImagesBinding = { input: () => fakeTransformer(callsB) };
    await generateCollage(bucket, imagesB, keys);

    expect(callsA.filter((c: any) => c.op !== "output")).toEqual(callsB.filter((c: any) => c.op !== "output"));
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

  let pipeline = images.input(base.body as unknown as ReadableStream);

  for (let i = 0; i < 4; i += 1) {
    const key = orderedR2Keys[i];
    const object = await bucket.get(key);
    if (!object) {
      throw new Error(`collage source image missing from R2 at position ${i}: ${key}`);
    }
    const cell = images
      .input(object.body as unknown as ReadableStream)
      .transform({ width: COLLAGE_CELL_SIZE, height: COLLAGE_CELL_SIZE, fit: "contain", background: "#FFFFFF" });
    pipeline = pipeline.draw(cell, { ...COLLAGE_CELL_POSITIONS[i], width: COLLAGE_CELL_SIZE, height: COLLAGE_CELL_SIZE });
  }

  const result = await pipeline.output({ format: "image/jpeg", quality: 90 });
  const buffer = await result.response().arrayBuffer();
  return new Uint8Array(buffer);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/publication/collage.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Record the collage base asset requirement**

Add to `docs/runbooks/deployment.md` (append, do not restructure existing content) a short note:

```text
## Collage base canvas

Before the first publication run, upload a solid white 1080x1080 JPEG to
`assets/collage-base-1080.jpg` in the R2 bucket for each environment. The
setup validator (hardening plan) checks this object exists.
```

- [ ] **Step 6: Full check and commit**

Run: `npm run check`

```bash
git add src/publication/collage.ts test/publication/collage.test.ts docs/runbooks/deployment.md
git commit -m "feat(publication): add deterministic 4-in-1 Cloudflare Images collage"
```

---

## Task 4A: Private short-lived collage delivery URL

**Files:**
- Create: `src/publication/asset-url.ts`
- Create: `src/routes/asset.ts`
- Create: `test/publication/asset-url.test.ts`
- Create: `test/routes/asset.test.ts`
- Modify: `src/config.ts` (add `publicBaseUrl`)
- Modify: `src/env.ts` (add `ASSET_URL_SIGNING_SECRET`)
- Modify: `src/router.ts` (register `GET /assets/collage`)

**Interfaces:**
- Consumes: private `Env.IMAGES_BUCKET`, `Clock`, `parseConfig`, and collage keys from Task 4.
- Produces:
  ```ts
  export async function signAssetUrl(key: string, baseUrl: string, secret: string, clock: Clock, ttlSeconds?: number): Promise<string>;
  export async function verifyAssetUrl(url: URL, secret: string, clock: Clock): Promise<string | null>;
  export async function handleAssetRoute(request: Request, env: Env): Promise<Response>;
  ```
  Airtable and Google fetch the returned URL during publication. The URL expires after 15 minutes, grants access only to generated collage keys, and is never logged.

- [ ] **Step 1: Write failing signer/verifier tests**

```ts
// test/publication/asset-url.test.ts
import { describe, expect, it } from "vitest";
import { signAssetUrl, verifyAssetUrl } from "../../src/publication/asset-url";

const key = "products/A-1001/collage/1080x1080.jpg";
const secret = "test-signing-secret-with-32-bytes-minimum";
const now = new Date("2026-09-01T05:00:00.000Z");

it("signs a collage URL valid for the requested TTL", async () => {
  const signed = await signAssetUrl(key, "https://worker.example", secret, { now: () => now }, 900);
  await expect(verifyAssetUrl(new URL(signed), secret, { now: () => new Date(now.getTime() + 899_000) })).resolves.toBe(key);
});

it("rejects expired, tampered, and non-collage URLs", async () => {
  const signed = new URL(await signAssetUrl(key, "https://worker.example", secret, { now: () => now }, 900));
  await expect(verifyAssetUrl(signed, secret, { now: () => new Date(now.getTime() + 901_000) })).resolves.toBeNull();
  signed.searchParams.set("key", "assets/private-original.jpg");
  await expect(verifyAssetUrl(signed, secret, { now: () => now })).resolves.toBeNull();
  await expect(signAssetUrl("assets/private-original.jpg", "https://worker.example", secret, { now: () => now })).rejects.toThrow("collage key");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publication/asset-url.test.ts`
Expected: FAIL — `Cannot find module '../../src/publication/asset-url'`.

- [ ] **Step 3: Implement HMAC URL signing**

```ts
// src/publication/asset-url.ts
import type { Clock } from "../shared/time";

const DEFAULT_TTL_SECONDS = 900;
const COLLAGE_KEY = /^products\/A-\d+\/collage\/1080x1080\.jpg$/;
const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function signature(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

function signedValue(key: string, expires: number): string {
  return `${key}\n${expires}`;
}

export async function signAssetUrl(
  key: string,
  baseUrl: string,
  secret: string,
  clock: Clock,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<string> {
  if (!COLLAGE_KEY.test(key)) throw new Error("only a generated collage key may be signed");
  if (ttlSeconds < 1 || ttlSeconds > DEFAULT_TTL_SECONDS) throw new Error("asset URL TTL must be between 1 and 900 seconds");
  const expires = Math.floor(clock.now().getTime() / 1000) + ttlSeconds;
  const url = new URL("/assets/collage", baseUrl);
  url.searchParams.set("key", key);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", await signature(secret, signedValue(key, expires)));
  return url.toString();
}

export async function verifyAssetUrl(url: URL, secret: string, clock: Clock): Promise<string | null> {
  const key = url.searchParams.get("key") ?? "";
  const expires = Number(url.searchParams.get("expires"));
  const supplied = url.searchParams.get("signature") ?? "";
  if (!COLLAGE_KEY.test(key) || !Number.isSafeInteger(expires) || expires <= Math.floor(clock.now().getTime() / 1000)) return null;
  const expected = await signature(secret, signedValue(key, expires));
  if (supplied.length !== expected.length) return null;
  let difference = 0;
  for (let index = 0; index < supplied.length; index += 1) difference |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0 ? key : null;
}
```

- [ ] **Step 4: Run signer tests**

Run: `npx vitest run test/publication/asset-url.test.ts`
Expected: PASS — 2 tests green.

- [ ] **Step 5: Write failing private-route tests**

```ts
// test/routes/asset.test.ts
import { describe, expect, it, vi } from "vitest";
import { handleAssetRoute } from "../../src/routes/asset";
import { signAssetUrl } from "../../src/publication/asset-url";

const now = new Date("2026-09-01T05:00:00.000Z");
const secret = "test-signing-secret-with-32-bytes-minimum";
const key = "products/A-1001/collage/1080x1080.jpg";

it("returns a signed private collage without making the bucket public", async () => {
  const url = await signAssetUrl(key, "https://worker.example", secret, { now: () => now });
  const env = {
    ASSET_URL_SIGNING_SECRET: secret,
    IMAGES_BUCKET: { get: vi.fn().mockResolvedValue({ body: new Uint8Array([1, 2, 3]), httpMetadata: { contentType: "image/jpeg" } }) },
  } as any;
  const response = await handleAssetRoute(new Request(url), env, { now: () => now });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(env.IMAGES_BUCKET.get).toHaveBeenCalledWith(key);
});

it("rejects missing or invalid signatures before reading R2", async () => {
  const env = { ASSET_URL_SIGNING_SECRET: secret, IMAGES_BUCKET: { get: vi.fn() } } as any;
  const response = await handleAssetRoute(new Request(`https://worker.example/assets/collage?key=${encodeURIComponent(key)}`), env, { now: () => now });
  expect(response.status).toBe(403);
  expect(env.IMAGES_BUCKET.get).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Run route tests to verify they fail**

Run: `npx vitest run test/routes/asset.test.ts`
Expected: FAIL — `Cannot find module '../../src/routes/asset'`.

- [ ] **Step 7: Implement and register the asset route**

```ts
// src/routes/asset.ts
import type { Env } from "../env";
import type { Clock } from "../shared/time";
import { verifyAssetUrl } from "../publication/asset-url";

export async function handleAssetRoute(
  request: Request,
  env: Env,
  clock: Clock = { now: () => new Date() },
): Promise<Response> {
  const key = await verifyAssetUrl(new URL(request.url), env.ASSET_URL_SIGNING_SECRET, clock);
  if (!key) return new Response("Forbidden", { status: 403 });
  const object = await env.IMAGES_BUCKET.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "image/jpeg",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
```

Add `publicBaseUrl: z.string().url()` to the existing `AppConfigSchema`, add `ASSET_URL_SIGNING_SECRET: string` to `Env`, and add these exact router lines beside existing route imports and dispatch branches:

```ts
import { handleAssetRoute } from "./routes/asset";

if (request.method === "GET" && url.pathname === "/assets/collage") {
  return handleAssetRoute(request, env);
}
```

Add `publicBaseUrl: "https://worker.example"` to every `AppConfig` test fixture introduced by this and earlier plans.

- [ ] **Step 8: Run focused and full checks**

Run: `npx vitest run test/publication/asset-url.test.ts test/routes/asset.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/publication/asset-url.ts src/routes/asset.ts src/config.ts src/env.ts src/router.ts test/publication/asset-url.test.ts test/routes/asset.test.ts
 git commit -m "feat(publication): serve private collages through expiring URLs"
```

---

## Task 5: Anthropic SDK caption generation with schema validation and deterministic batching

**Files:**
- Create: `src/publication/captions.ts`
- Test: `test/publication/captions.test.ts`

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
  used by `publication/service.ts` (Task 7).

- [ ] **Step 1: Write the failing test**

```ts
// test/publication/captions.test.ts
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
    const client = { messages: { countTokens: vi.fn().mockResolvedValue({ input_tokens: 500 }) } } as any;
    const products = [toCaptionRequestProducts([product("A-1001")])[0], toCaptionRequestProducts([product("A-1002")])[0]];
    const batches = await planCaptionBatches(client, "claude-opus-5", products, 1000);
    expect(batches).toEqual([products.sort((a, b) => a.productId.localeCompare(b.productId))]);
  });

  it("splits deterministically by sorted Product ID when over the limit", async () => {
    const client = {
      messages: {
        countTokens: vi.fn().mockImplementation(async ({ messages }: any) => {
          const text = messages[0].content as string;
          const productCount = (text.match(/"productId"/g) ?? []).length;
          return { input_tokens: productCount > 1 ? 2000 : 400 };
        }),
      },
    } as any;
    const products = ["A-1003", "A-1001", "A-1002", "A-1004"].map((id) => toCaptionRequestProducts([product(id)])[0]);
    const batches = await planCaptionBatches(client, "claude-opus-5", products, 1000);
    expect(batches.every((batch) => batch.length === 1)).toBe(true);
    expect(batches.map((b) => b[0].productId)).toEqual(["A-1001", "A-1002", "A-1003", "A-1004"]);
  });
});

describe("requestCaptionBatch", () => {
  it("returns three drafts per requested Product ID on a clean response", async () => {
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue(
          toolResponse([{ productId: "A-1001", drafts: ["d1", "d2", "d3"] }]),
        ),
      },
    } as any;
    const outcome = await requestCaptionBatch(client, "claude-opus-5", [toCaptionRequestProducts([product("A-1001")])[0]]);
    expect(outcome).toEqual({ captions: [{ productId: "A-1001", drafts: ["d1", "d2", "d3"] }], missingProductIds: [] });
  });

  it("marks only the Product IDs with missing or invalid captions for retry", async () => {
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue(
          toolResponse([
            { productId: "A-1001", drafts: ["d1", "d2", "d3"] },
            { productId: "A-1002", drafts: ["only-one"] },
          ]),
        ),
      },
    } as any;
    const requested = [toCaptionRequestProducts([product("A-1001")])[0], toCaptionRequestProducts([product("A-1002")])[0]];
    const outcome = await requestCaptionBatch(client, "claude-opus-5", requested);
    expect(outcome.captions).toEqual([{ productId: "A-1001", drafts: ["d1", "d2", "d3"] }]);
    expect(outcome.missingProductIds).toEqual(["A-1002"]);
  });

  it("marks every requested Product ID for retry when the response cannot be parsed", async () => {
    const client = { messages: { create: vi.fn().mockResolvedValue({ content: [] }) } } as any;
    const requested = [toCaptionRequestProducts([product("A-1001")])[0], toCaptionRequestProducts([product("A-1002")])[0]];
    const outcome = await requestCaptionBatch(client, "claude-opus-5", requested);
    expect(outcome.captions).toEqual([]);
    expect(outcome.missingProductIds).toEqual(["A-1001", "A-1002"]);
  });

  it("marks every requested Product ID for retry when the tool call throws", async () => {
    const client = { messages: { create: vi.fn().mockRejectedValue(new Error("rate limited")) } } as any;
    const requested = [toCaptionRequestProducts([product("A-1001")])[0]];
    const outcome = await requestCaptionBatch(client, "claude-opus-5", requested);
    expect(outcome.missingProductIds).toEqual(["A-1001"]);
  });

  it("marks every requested Product ID for retry when returned IDs don't match the requested set", async () => {
    const client = {
      messages: { create: vi.fn().mockResolvedValue(toolResponse([{ productId: "A-9999", drafts: ["d1", "d2", "d3"] }])) },
    } as any;
    const requested = [toCaptionRequestProducts([product("A-1001")])[0]];
    const outcome = await requestCaptionBatch(client, "claude-opus-5", requested);
    expect(outcome.captions).toEqual([]);
    expect(outcome.missingProductIds).toEqual(["A-1001"]);
  });
});

describe("generateCaptionsForRun", () => {
  it("batches, requests, and merges captions keyed by Product ID across batches", async () => {
    const client = {
      messages: {
        countTokens: vi.fn().mockResolvedValue({ input_tokens: 100 }),
        create: vi
          .fn()
          .mockResolvedValueOnce(toolResponse([{ productId: "A-1001", drafts: ["d1", "d2", "d3"] }, { productId: "A-1002", drafts: ["e1", "e2", "e3"] }])),
      },
    } as any;
    const products = ["A-1001", "A-1002"].map((id) => toCaptionRequestProducts([product(id)])[0]);
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

const ResponseSchema = z.object({
  captions: z.array(
    z.object({
      productId: z.string(),
      drafts: z.array(z.string()).length(3),
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

export async function planCaptionBatches(
  client: Pick<Anthropic, "messages">,
  model: string,
  products: CaptionRequestProduct[],
  inputTokenLimit: number,
): Promise<CaptionRequestProduct[][]> {
  const sorted = [...products].sort((a, b) => a.productId.localeCompare(b.productId));
  return splitToFit(client, model, sorted, inputTokenLimit);
}

async function splitToFit(
  client: Pick<Anthropic, "messages">,
  model: string,
  products: CaptionRequestProduct[],
  inputTokenLimit: number,
): Promise<CaptionRequestProduct[][]> {
  if (products.length <= 1) return [products];
  const params = buildRequestParams(model, products);
  const { input_tokens } = await client.messages.countTokens({
    model: params.model,
    messages: params.messages,
    tools: params.tools,
  });
  if (input_tokens <= inputTokenLimit) return [products];

  const mid = Math.ceil(products.length / 2);
  const left = products.slice(0, mid);
  const right = products.slice(mid);
  const leftBatches = await splitToFit(client, model, left, inputTokenLimit);
  const rightBatches = await splitToFit(client, model, right, inputTokenLimit);
  return [...leftBatches, ...rightBatches];
}

export async function requestCaptionBatch(
  client: Pick<Anthropic, "messages">,
  model: string,
  products: CaptionRequestProduct[],
): Promise<CaptionGenerationOutcome> {
  const requestedIds = new Set(products.map((p) => p.productId));
  let raw: unknown;
  try {
    raw = await client.messages.create(buildRequestParams(model, products));
  } catch {
    return { captions: [], missingProductIds: [...requestedIds] };
  }

  const toolUse = (raw as Anthropic.Messages.Message).content.find(
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
  const hasUnexpectedId = [...returnedIds].some((id) => !requestedIds.has(id));
  if (hasUnexpectedId) {
    return { captions: [], missingProductIds: [...requestedIds] };
  }

  const captions: CaptionSet[] = [];
  const missingProductIds: string[] = [];
  for (const productId of requestedIds) {
    const match = parsed.data.captions.find((c) => c.productId === productId);
    if (match && match.drafts.length === 3 && match.drafts.every((d) => d.trim().length > 0)) {
      captions.push({ productId, drafts: [match.drafts[0], match.drafts[1], match.drafts[2]] });
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
Expected: PASS — 9 tests green.

- [ ] **Step 5: Full check and commit**

Run: `npm run check`

```bash
git add src/publication/captions.ts test/publication/captions.test.ts
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
  used by `publication/google-docs.ts` (Task 7 area, actually Task 6's own follow-on) and `publication/service.ts` (Task 7).

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
  privateKeyPem = privateKey as unknown as string;
  const publicPem = publicKey as unknown as string;
  const body = publicPem.replace(/-----BEGIN PUBLIC KEY-----/, "").replace(/-----END PUBLIC KEY-----/, "").replace(/\s+/g, "");
  publicKeyDer = Uint8Array.from(atob(body), (c) => c.charCodeAt(0)).buffer;
});

function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  return atob(padded);
}

describe("parseServiceAccountJson", () => {
  it("extracts client_email and private_key", () => {
    const result = parseServiceAccountJson(JSON.stringify({ client_email: "svc@example.iam.gserviceaccount.com", private_key: "key" }));
    expect(result).toEqual({ client_email: "svc@example.iam.gserviceaccount.com", private_key: "key" });
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
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "token-1", expires_in: 3600 }), { status: 200 }),
    );
    const client = createGoogleAuthClient(
      JSON.stringify({ client_email: "svc@example.iam.gserviceaccount.com", private_key: privateKeyPem }),
      clock,
      fetcher as any,
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
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token-1", expires_in: 60 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token-2", expires_in: 3600 }), { status: 200 }));
    const client = createGoogleAuthClient(
      JSON.stringify({ client_email: "svc@example.iam.gserviceaccount.com", private_key: privateKeyPem }),
      clock,
      fetcher as any,
    );

    const first = await client.getAccessToken();
    currentTime = new Date("2026-09-01T05:02:00.000Z");
    const second = await client.getAccessToken();

    expect(first).toBe("token-1");
    expect(second).toBe("token-2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publication/google-auth.test.ts`
Expected: FAIL — `Cannot find module '../../src/publication/google-auth'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/publication/google-auth.ts
import type { Clock } from "../shared/time";
import type { Fetcher } from "../shared/http";

export interface GoogleServiceAccountJson {
  client_email: string;
  private_key: string;
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export function parseServiceAccountJson(json: string): GoogleServiceAccountJson {
  const parsed = JSON.parse(json) as { client_email: string; private_key: string };
  return { client_email: parsed.client_email, private_key: parsed.private_key };
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
        throw new Error(`google token exchange failed with status ${response.status}`);
      }

      const body = (await response.json()) as { access_token: string; expires_in: number };
      cachedToken = body.access_token;
      cachedExpiryMs = nowMs + (body.expires_in - TOKEN_REFRESH_SKEW_SECONDS) * 1000;
      return cachedToken;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/publication/google-auth.test.ts`
Expected: PASS — 4 tests green.

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

  export async function copyTemplate(
    fetcher: Fetcher,
    tokenProvider: AccessTokenProvider,
    templateDocId: string,
    driveFolderId: string,
    newTitle: string,
  ): Promise<string>; // returns copied doc id

  export function buildBatchUpdateRequests(
    publicationDateText: string,
    products: DocProductContent[],
    suffixText: string,
  ): unknown[]; // Google Docs batchUpdate `requests` array, applied in two passes internally by fillTemplate

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
  used by `publication/service.ts` (Task 8).

Template contract (documented for the customer-facing template, referenced by the setup runbook): the master template contains the literal tokens `{{PUBLICATION_DATE}}`, `{{PRODUCTS}}`, and `{{END_PRODUCTS}}`. Everything between `{{PRODUCTS}}` and `{{END_PRODUCTS}}` is one plain-text suffix block that is captured once, then repeated after every generated product section; the two marker tokens and the captured suffix text are removed and replaced by the generated content.

- [ ] **Step 1: Write the failing test**

```ts
// test/publication/google-docs.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  copyTemplate,
  buildBatchUpdateRequests,
  fillTemplate,
  verifyDocumentContainsProducts,
  finalizeDocument,
  deleteDocument,
} from "../../src/publication/google-docs";
import type { DocProductContent } from "../../src/publication/google-docs";

function tokenProvider(token = "access-token-1") {
  return { getAccessToken: vi.fn().mockResolvedValue(token) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("copyTemplate", () => {
  it("POSTs a Drive copy request with the target folder and title", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ id: "copied-doc-1" }));
    const id = await copyTemplate(fetcher as any, tokenProvider(), "template-doc-1", "folder-1", "Publication 2026-09-01 (in progress)");
    expect(id).toBe("copied-doc-1");
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain("template-doc-1/copy");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ name: "Publication 2026-09-01 (in progress)", parents: ["folder-1"] });
    expect(init.headers.Authorization).toBe("Bearer access-token-1");
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
    const requests = buildBatchUpdateRequests("1 กันยายน 2569", [sampleProduct], "-- end of listing --");
    const dateRequest = requests.find((r: any) => r.replaceAllText?.containsText?.text === "{{PUBLICATION_DATE}}");
    expect(dateRequest).toBeTruthy();
    expect((dateRequest as any).replaceAllText.replaceText).toBe("1 กันยายน 2569");

    const insertTextRequests = requests.filter((r: any) => r.insertInlineImage || r.insertText);
    const combinedText = insertTextRequests
      .filter((r: any) => r.insertText)
      .map((r: any) => r.insertText.text)
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

    const imageRequest = requests.find((r: any) => r.insertInlineImage);
    expect((imageRequest as any).insertInlineImage.uri).toBe("https://r2.example.com/signed/A-1001.jpg");
  });

  it("orders multiple products in the given order in the final document", () => {
    const requests = buildBatchUpdateRequests(
      "1 กันยายน 2569",
      [sampleProduct, { ...sampleProduct, productId: "A-1002" }],
      "suffix",
    );
    const insertTexts = requests.filter((r: any) => r.insertText).map((r: any) => r.insertText.text);
    const firstIdIndex = insertTexts.findIndex((t: string) => t.includes("A-1001"));
    const secondIdIndex = insertTexts.findIndex((t: string) => t.includes("A-1002"));
    expect(firstIdIndex).toBeLessThan(secondIdIndex);
  });
});

describe("fillTemplate", () => {
  it("captures the suffix between markers, then batchUpdates with a two-request-set call", async () => {
    const fetcher = vi
      .fn()
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

    await fillTemplate(fetcher as any, tokenProvider(), "doc-1", "1 กันยายน 2569", [sampleProduct]);

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [, batchInit] = fetcher.mock.calls[1];
    const body = JSON.parse(batchInit.body);
    expect(Array.isArray(body.requests)).toBe(true);
    const hasSuffixContent = body.requests.some((r: any) => r.insertText?.text?.includes("-- end of listing --"));
    expect(hasSuffixContent).toBe(true);
  });
});

describe("verifyDocumentContainsProducts", () => {
  it("returns ok:true when every expected Product ID text appears in the document", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        body: { content: [{ paragraph: { elements: [{ textRun: { content: "Product ID: A-1001\nProduct ID: A-1002" } }] } }] },
      }),
    );
    const result = await verifyDocumentContainsProducts(fetcher as any, tokenProvider(), "doc-1", ["A-1001", "A-1002"]);
    expect(result).toEqual({ ok: true });
  });

  it("returns ok:false with the missing Product IDs when any are absent", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ body: { content: [{ paragraph: { elements: [{ textRun: { content: "Product ID: A-1001" } }] } }] } }),
    );
    const result = await verifyDocumentContainsProducts(fetcher as any, tokenProvider(), "doc-1", ["A-1001", "A-1002"]);
    expect(result).toEqual({ ok: false, missingProductIds: ["A-1002"] });
  });
});

describe("finalizeDocument", () => {
  it("renames the doc via Drive and returns the canonical edit URL", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ id: "doc-1" }));
    const url = await finalizeDocument(fetcher as any, tokenProvider(), "doc-1", "Publication 2026-09-01");
    expect(url).toBe("https://docs.google.com/document/d/doc-1/edit");
    const [requestUrl, init] = fetcher.mock.calls[0];
    expect(String(requestUrl)).toContain("drive/v3/files/doc-1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ name: "Publication 2026-09-01" });
  });
});

describe("deleteDocument", () => {
  it("DELETEs the Drive file", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await deleteDocument(fetcher as any, tokenProvider(), "doc-1");
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain("drive/v3/files/doc-1");
    expect(init.method).toBe("DELETE");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publication/google-docs.test.ts`
Expected: FAIL — `Cannot find module '../../src/publication/google-docs'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/publication/google-docs.ts
import type { AccessTokenProvider } from "./google-auth";
import type { Fetcher } from "../shared/http";

export interface DocProductContent {
  productId: string;
  conditionType: string;
  description: string;
  lineSquarePrice: number;
  igPrice: number;
  captionDrafts: [string, string, string];
  collageImageUrl: string;
}

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DOCS_BASE = "https://docs.googleapis.com/v1";

async function authHeaders(tokenProvider: AccessTokenProvider): Promise<HeadersInit> {
  const token = await tokenProvider.getAccessToken();
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

export async function copyTemplate(
  fetcher: Fetcher,
  tokenProvider: AccessTokenProvider,
  templateDocId: string,
  driveFolderId: string,
  newTitle: string,
): Promise<string> {
  const response = await fetcher(`${DRIVE_BASE}/files/${templateDocId}/copy`, {
    method: "POST",
    headers: await authHeaders(tokenProvider),
    body: JSON.stringify({ name: newTitle, parents: [driveFolderId] }),
  });
  if (!response.ok) {
    throw new Error(`google drive copy failed with status ${response.status}`);
  }
  const body = (await response.json()) as { id: string };
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
): unknown[] {
  const requests: unknown[] = [
    {
      replaceAllText: {
        containsText: { text: "{{PUBLICATION_DATE}}", matchCase: true },
        replaceText: publicationDateText,
      },
    },
  ];

  for (const product of products) {
    requests.push({ insertText: { location: { index: 1 }, text: productBlockText(product) } });
    requests.push({
      insertInlineImage: { location: { index: 1 }, uri: product.collageImageUrl, objectSize: { width: { magnitude: 200, unit: "PT" }, height: { magnitude: 200, unit: "PT" } } },
    });
    requests.push({ insertText: { location: { index: 1 }, text: `${suffixText}\n\n` } });
  }

  return requests;
}

interface DocParagraphElement {
  startIndex?: number;
  endIndex?: number;
  textRun?: { content: string };
}

interface GoogleDocBody {
  body: { content: Array<{ paragraph?: { elements: DocParagraphElement[] } }> };
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

function extractSuffixBetweenMarkers(fullText: string): string {
  const startMarker = "{{PRODUCTS}}";
  const endMarker = "{{END_PRODUCTS}}";
  const startIdx = fullText.indexOf(startMarker);
  const endIdx = fullText.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error("template missing {{PRODUCTS}} / {{END_PRODUCTS}} markers");
  }
  return fullText.slice(startIdx + startMarker.length, endIdx);
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
    throw new Error(`google docs get failed with status ${getResponse.status}`);
  }
  const doc = (await getResponse.json()) as GoogleDocBody;
  const fullText = extractPlainText(doc);
  const suffixText = extractSuffixBetweenMarkers(fullText).trim();

  const requests = [
    ...buildBatchUpdateRequests(publicationDateText, products, suffixText),
    { replaceAllText: { containsText: { text: "{{END_PRODUCTS}}", matchCase: true }, replaceText: "" } },
    { replaceAllText: { containsText: { text: suffixText, matchCase: true }, replaceText: "" } },
    { replaceAllText: { containsText: { text: "{{PRODUCTS}}", matchCase: true }, replaceText: "" } },
  ];

  const batchResponse = await fetcher(`${DOCS_BASE}/documents/${docId}:batchUpdate`, {
    method: "POST",
    headers: await authHeaders(tokenProvider),
    body: JSON.stringify({ requests }),
  });
  if (!batchResponse.ok) {
    throw new Error(`google docs batchUpdate failed with status ${batchResponse.status}`);
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
    throw new Error(`google docs get failed with status ${response.status}`);
  }
  const doc = (await response.json()) as GoogleDocBody;
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
    throw new Error(`google drive rename failed with status ${response.status}`);
  }
  return `https://docs.google.com/document/d/${docId}/edit`;
}

export async function deleteDocument(fetcher: Fetcher, tokenProvider: AccessTokenProvider, docId: string): Promise<void> {
  const response = await fetcher(`${DRIVE_BASE}/files/${docId}`, {
    method: "DELETE",
    headers: await authHeaders(tokenProvider),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`google drive delete failed with status ${response.status}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/publication/google-docs.test.ts`
Expected: PASS — 8 tests green.

- [ ] **Step 5: Full check and commit**

Run: `npm run check`

```bash
git add src/publication/google-docs.ts test/publication/google-docs.test.ts
git commit -m "feat(publication): add Google Drive/Docs client with template fill, verification, finalize, cleanup"
```

---

## Task 8: LINE publication log messages

**Files:**
- Modify: `src/line/messages.ts` (append; do not rename existing exports)
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

- [ ] **Step 3: Append the implementation to `src/line/messages.ts`**

```ts
// append to src/line/messages.ts
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

## Task 9: Publication service orchestration

**Files:**
- Create: `src/publication/service.ts`
- Test: `test/publication/service.test.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1–8:
  `acquireOrResumeJob`, `setJobState`, `getProductCache`, `putProductCollage`, `putProductCaptions` (Task 1);
  `findReadyRunForDate`, `markRunGenerating`, `markRunGenerated`, `markRunNeedsCorrection`, `markRunFailed`, `updateProductCollage` (Task 2);
  `validateRunCompleteness`, `formatValidationErrorSummary` (Task 3);
  `generateCollage`, `collageR2Key` (Task 4);
  `toCaptionRequestProducts`, `generateCaptionsForRun` (Task 5);
  `createGoogleAuthClient` (Task 6);
  `copyTemplate`, `fillTemplate`, `verifyDocumentContainsProducts`, `finalizeDocument`, `deleteDocument` (Task 7);
  `buildPublicationSuccessMessage`, `buildPublicationValidationFailureMessage`, `buildPublicationWorkflowFailureMessage` (Task 8);
  `pushTextMessage` (assumed, import plan).
- Produces:
  ```ts
  export interface PublicationServiceDeps {
    db: D1Database;
    bucket: R2Bucket;
    images: ImagesBinding;
    fetcher: Fetcher;
    anthropic: Pick<Anthropic, "messages">;
    clock: Clock;
    config: AppConfig;
    airtableToken: string;
    googleServiceAccountJson: string;
    lineGroupId: string;
    signCollageUrl(r2Key: string): Promise<string>; // short-lived signed R2 URL, never logged
  }

  export type PublicationOutcome =
    | { kind: "succeeded"; result: PublicationResult }
    | { kind: "already_succeeded"; result: PublicationResult }
    | { kind: "validation_failed" }
    | { kind: "no_ready_run" };

  export async function runPublicationForRun(
    deps: PublicationServiceDeps,
    airtableRunId: string,
    correlationId: string,
  ): Promise<PublicationOutcome>;

  export async function findAndRunTodaysPublication(
    deps: PublicationServiceDeps,
    correlationId: string,
  ): Promise<PublicationOutcome>;
  ```
  used by `publication/workflow.ts` (Task 10) and `routes/docs.ts` (Task 11).

- [ ] **Step 1: Write the failing test**

```ts
// test/publication/service.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { runPublicationForRun, findAndRunTodaysPublication } from "../../src/publication/service";
import type { PublicationServiceDeps } from "../../src/publication/service";
import { COLLAGE_BASE_R2_KEY } from "../../src/publication/collage";

const clock = { now: () => new Date("2026-09-01T05:00:00.000Z") };

const config = {
  airtableBaseId: "base123",
  airtableProductsTableId: "tblProducts",
  airtablePublicationRunsTableId: "tblRuns",
  claudeModel: "claude-opus-5",
  claudeRequestInputTokenLimit: 150000,
  googleDriveFolderId: "folder-1",
  googleTemplateDocId: "template-doc-1",
  timeZone: "Asia/Bangkok",
} as any;

function airtableProductFields(overrides: Record<string, unknown> = {}) {
  return {
    "Product ID": "A-1001",
    "Product Images": [
      { id: "a", url: "https://dl.airtable.com/a.jpg" },
      { id: "b", url: "https://dl.airtable.com/b.jpg" },
      { id: "c", url: "https://dl.airtable.com/c.jpg" },
      { id: "d", url: "https://dl.airtable.com/d.jpg" },
    ],
    "Brand Name": "Nike",
    "Model Name": "Air Max",
    "Condition Type": "Used",
    Size: "42",
    Description: "Good condition",
    "LINE Square Price": 1290,
    "IG Price": 1390,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function buildFetcherRouter(handlers: Array<{ match: (url: string, init?: RequestInit) => boolean; respond: (url: string, init?: RequestInit) => Response }>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const handler = handlers.find((h) => h.match(url, init));
    if (!handler) throw new Error(`unhandled fetch: ${init?.method ?? "GET"} ${url}`);
    return handler.respond(url, init);
  });
}

function fakeImages() {
  return {
    input: () => {
      const t: any = {
        transform: () => t,
        draw: () => t,
        output: async () => ({ response: () => new Response(new Uint8Array([1])) }),
      };
      return t;
    },
  };
}

async function fakeBucketWithCollageBase() {
  const store = new Map<string, Uint8Array>();
  store.set(COLLAGE_BASE_R2_KEY, new Uint8Array([1]));
  for (const key of ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]) store.set(key, new Uint8Array([1]));
  return {
    async get(key: string) {
      const value = store.get(key);
      return value ? { body: new ReadableStream() } : null;
    },
    async put(key: string, value: unknown) {
      store.set(key, value as Uint8Array);
    },
  } as unknown as R2Bucket;
}

describe("runPublicationForRun", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM publication_jobs");
    await env.DB.exec("DELETE FROM publication_product_cache");
  });

  it("blocks the whole document and reports validation failure when a product is missing required fields", async () => {
    const fetcher = buildFetcherRouter([
      {
        match: (url) => url.includes("tblRuns") && !url.includes("/rec-run-1"),
        respond: () =>
          jsonResponse({
            records: [{ id: "rec-run-1", fields: { "Publication Date": "2026-09-01", Status: "Ready", Products: ["rec-1001"] } }],
          }),
      },
      {
        match: (url) => url.includes("tblProducts"),
        respond: () => jsonResponse({ records: [{ id: "rec-1001", fields: airtableProductFields({ "Brand Name": "" }) }] }),
      },
      {
        match: (url, init) => url.includes("rec-run-1") && init?.method === "PATCH",
        respond: (_url, init) => {
          const body = JSON.parse((init as any).body);
          expect(body.fields.Status).toBe("Draft");
          expect(body.fields["Error Summary"]).toContain("Brand Name");
          return jsonResponse({ id: "rec-run-1" });
        },
      },
    ]);

    const pushed: string[] = [];
    const deps: PublicationServiceDeps = {
      db: env.DB,
      bucket: await fakeBucketWithCollageBase(),
      images: fakeImages() as any,
      fetcher: fetcher as any,
      anthropic: { messages: { create: vi.fn(), countTokens: vi.fn() } } as any,
      clock,
      config,
      airtableToken: "airtable-token",
      googleServiceAccountJson: JSON.stringify({ client_email: "svc@example.com", private_key: "unused-in-this-test" }),
      lineGroupId: "group-1",
      signCollageUrl: async (key) => `https://r2.example.com/signed/${key}`,
    };

    // pushTextMessage is called by the service; intercept via module mock in the real test file.
    const outcome = await runPublicationForRun(deps, "rec-run-1", "corr-1");
    expect(outcome.kind).toBe("validation_failed");
  });
});

describe("findAndRunTodaysPublication", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM publication_jobs");
    await env.DB.exec("DELETE FROM publication_product_cache");
  });

  it("returns no_ready_run when no Publication Run is Ready for today", async () => {
    const fetcher = buildFetcherRouter([
      { match: (url) => url.includes("tblRuns"), respond: () => jsonResponse({ records: [] }) },
    ]);
    const deps: PublicationServiceDeps = {
      db: env.DB,
      bucket: await fakeBucketWithCollageBase(),
      images: fakeImages() as any,
      fetcher: fetcher as any,
      anthropic: { messages: { create: vi.fn(), countTokens: vi.fn() } } as any,
      clock,
      config,
      airtableToken: "airtable-token",
      googleServiceAccountJson: JSON.stringify({ client_email: "svc@example.com", private_key: "unused" }),
      lineGroupId: "group-1",
      signCollageUrl: async (key) => `https://r2.example.com/signed/${key}`,
    };
    const outcome = await findAndRunTodaysPublication(deps, "corr-1");
    expect(outcome.kind).toBe("no_ready_run");
  });
});
```

Because `runPublicationForRun` calls `pushTextMessage` from `src/line/client.ts` as a side effect, mock that module at the top of the real test file before the imports resolve:

```ts
vi.mock("../../src/line/client", () => ({ pushTextMessage: vi.fn().mockResolvedValue(undefined) }));
```

Add this `vi.mock` call as the first statement in `test/publication/service.test.ts`, above the other imports, per Vitest hoisting rules.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publication/service.test.ts`
Expected: FAIL — `Cannot find module '../../src/publication/service'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/publication/service.ts
import type Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../config";
import type { Clock } from "../shared/time";
import { formatThaiDate } from "../shared/time";
import type { Fetcher } from "../shared/http";
import { pushTextMessage } from "../line/client";
import {
  buildPublicationSuccessMessage,
  buildPublicationValidationFailureMessage,
  buildPublicationWorkflowFailureMessage,
} from "../line/messages";
import {
  acquireOrResumeJob,
  setJobState,
  getProductCache,
  putProductCollage,
  putProductCaptions,
} from "../db/publication-repository";
import {
  findReadyRunForDate,
  loadRunById,
  markRunGenerating,
  markRunGenerated,
  markRunNeedsCorrection,
  markRunFailed,
  updateProductCollage,
} from "./airtable-runs";
import { validateRunCompleteness, formatValidationErrorSummary } from "./validator";
import { generateCollage, collageR2Key, type ImagesBinding } from "./collage";
import { toCaptionRequestProducts, generateCaptionsForRun } from "./captions";
import { createGoogleAuthClient } from "./google-auth";
import { copyTemplate, fillTemplate, verifyDocumentContainsProducts, finalizeDocument, deleteDocument } from "./google-docs";
import type { DocProductContent } from "./google-docs";
import type { PublicationProduct, PublicationRun, PublicationResult, CaptionSet } from "./types";

export interface PublicationServiceDeps {
  db: D1Database;
  bucket: R2Bucket;
  images: ImagesBinding;
  fetcher: Fetcher;
  anthropic: Pick<Anthropic, "messages">;
  clock: Clock;
  config: AppConfig;
  airtableToken: string;
  googleServiceAccountJson: string;
  lineGroupId: string;
  signCollageUrl(r2Key: string): Promise<string>;
}

export type PublicationOutcome =
  | { kind: "succeeded"; result: PublicationResult }
  | { kind: "already_succeeded"; result: PublicationResult }
  | { kind: "validation_failed" }
  | { kind: "no_ready_run" };

function airtableRunUrl(config: AppConfig, airtableRunId: string): string {
  return `https://airtable.com/${config.airtableBaseId}/${config.airtablePublicationRunsTableId}/${airtableRunId}`;
}

async function ensureCollage(deps: PublicationServiceDeps, product: PublicationProduct): Promise<string> {
  const cache = await getProductCache(deps.db, product.airtableRecordId, product.productId);
  if (cache.collageR2Key) return cache.collageR2Key;

  const firstFour = product.orderedImageKeys.slice(0, 4);
  if (firstFour.length < 4) {
    throw new Error(`product ${product.productId} does not have four ordered images at collage time`);
  }
  const collageBytes = await generateCollage(deps.bucket, deps.images, firstFour as [string, string, string, string]);
  const key = collageR2Key(product.productId);
  await deps.bucket.put(key, collageBytes);
  await putProductCollage(deps.db, deps.clock, product.airtableRecordId, product.productId, key);
  return key;
}

async function ensureCaptions(
  deps: PublicationServiceDeps,
  publicationRunId: string,
  products: PublicationProduct[],
): Promise<Map<string, [string, string, string]>> {
  const result = new Map<string, [string, string, string]>();
  const toRequest: PublicationProduct[] = [];

  for (const product of products) {
    const cache = await getProductCache(deps.db, publicationRunId, product.productId);
    if (cache.captionsJson) {
      const drafts = JSON.parse(cache.captionsJson) as [string, string, string];
      result.set(product.productId, drafts);
    } else {
      toRequest.push(product);
    }
  }

  if (toRequest.length > 0) {
    const outcome = await generateCaptionsForRun(
      deps.anthropic,
      deps.config.claudeModel,
      deps.config.claudeRequestInputTokenLimit,
      toCaptionRequestProducts(toRequest),
    );
    for (const captionSet of outcome.captions) {
      await putProductCaptions(deps.db, deps.clock, publicationRunId, captionSet.productId, JSON.stringify(captionSet.drafts));
      result.set(captionSet.productId, captionSet.drafts);
    }
    if (outcome.missingProductIds.length > 0) {
      throw new Error(`caption generation incomplete for: ${outcome.missingProductIds.join(", ")}`);
    }
  }

  return result;
}

export async function runPublicationForRun(
  deps: PublicationServiceDeps,
  airtableRunId: string,
  correlationId: string,
): Promise<PublicationOutcome> {
  const { job, alreadySucceeded } = await acquireOrResumeJob(deps.db, deps.clock, airtableRunId, correlationId);
  if (alreadySucceeded && job.googleDocId && job.googleDocUrl) {
    return {
      kind: "already_succeeded",
      result: { publicationRunId: airtableRunId, googleDocId: job.googleDocId, googleDocUrl: job.googleDocUrl, productIds: [] },
    };
  }

  const run = await loadRunById(deps.fetcher, deps.config, deps.airtableToken, airtableRunId);
  const thaiDate = formatThaiDate(new Date(run.publicationDate));

  await setJobState(deps.db, deps.clock, airtableRunId, "validating");
  const validation = validateRunCompleteness(run.products);
  if (!validation.valid) {
    await setJobState(deps.db, deps.clock, airtableRunId, "validation_failed", {
      validationResultJson: JSON.stringify(validation),
    });
    await markRunNeedsCorrection(
      deps.fetcher,
      deps.config,
      deps.airtableToken,
      airtableRunId,
      formatValidationErrorSummary(validation),
    );
    await pushTextMessage(
      { LINE_ALLOWED_GROUP_ID: deps.lineGroupId } as any,
      deps.lineGroupId,
      buildPublicationValidationFailureMessage({
        thaiDate,
        validation,
        airtableRunUrl: airtableRunUrl(deps.config, airtableRunId),
      }),
    );
    return { kind: "validation_failed" };
  }

  try {
    await setJobState(deps.db, deps.clock, airtableRunId, "generating");
    await markRunGenerating(deps.fetcher, deps.config, deps.airtableToken, airtableRunId);

    const tokenProvider = createGoogleAuthClient(deps.googleServiceAccountJson, deps.clock, deps.fetcher);
    const tempTitle = `Publication ${run.publicationDate} (in progress)`;
    const tempDocId = await copyTemplate(deps.fetcher, tokenProvider, deps.config.googleTemplateDocId, deps.config.googleDriveFolderId, tempTitle);
    await setJobState(deps.db, deps.clock, airtableRunId, "generating", { tempDocId });

    const captionsByProductId = await ensureCaptions(deps, airtableRunId, run.products);

    const docProducts: DocProductContent[] = [];
    for (const product of run.products) {
      const collageKey = await ensureCollage(deps, product);
      const signedUrl = await deps.signCollageUrl(collageKey);
      await updateProductCollage(deps.fetcher, deps.config, deps.airtableToken, product.airtableRecordId, signedUrl);
      const drafts = captionsByProductId.get(product.productId);
      if (!drafts) throw new Error(`missing captions for ${product.productId} after generation`);
      docProducts.push({
        productId: product.productId,
        conditionType: product.conditionType,
        description: product.description,
        lineSquarePrice: product.lineSquarePrice,
        igPrice: product.igPrice,
        captionDrafts: drafts,
        collageImageUrl: signedUrl,
      });
    }

    await fillTemplate(deps.fetcher, tokenProvider, tempDocId, thaiDate, docProducts);

    const expectedIds = run.products.map((p) => p.productId);
    const verification = await verifyDocumentContainsProducts(deps.fetcher, tokenProvider, tempDocId, expectedIds);
    if (!verification.ok) {
      throw new Error(`generated document missing Product IDs: ${verification.missingProductIds.join(", ")}`);
    }

    const finalTitle = `Publication ${run.publicationDate}`;
    const googleDocUrl = await finalizeDocument(deps.fetcher, tokenProvider, tempDocId, finalTitle);
    const generatedAtIso = deps.clock.now().toISOString();
    await markRunGenerated(deps.fetcher, deps.config, deps.airtableToken, airtableRunId, googleDocUrl, generatedAtIso);
    await setJobState(deps.db, deps.clock, airtableRunId, "succeeded", { googleDocId: tempDocId, googleDocUrl });

    await pushTextMessage(
      { LINE_ALLOWED_GROUP_ID: deps.lineGroupId } as any,
      deps.lineGroupId,
      buildPublicationSuccessMessage({ thaiDate, productIds: expectedIds, googleDocUrl }),
    );

    return { kind: "succeeded", result: { publicationRunId: airtableRunId, googleDocId: tempDocId, googleDocUrl, productIds: expectedIds } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown publication error";
    const currentJob = await acquireOrResumeJob(deps.db, deps.clock, airtableRunId, correlationId);
    if (currentJob.job.tempDocId) {
      const tokenProvider = createGoogleAuthClient(deps.googleServiceAccountJson, deps.clock, deps.fetcher);
      await deleteDocument(deps.fetcher, tokenProvider, currentJob.job.tempDocId).catch(() => undefined);
    }
    await setJobState(deps.db, deps.clock, airtableRunId, "failed");
    await markRunFailed(deps.fetcher, deps.config, deps.airtableToken, airtableRunId, reason);
    await pushTextMessage(
      { LINE_ALLOWED_GROUP_ID: deps.lineGroupId } as any,
      deps.lineGroupId,
      buildPublicationWorkflowFailureMessage({ thaiDate, reason, airtableRunUrl: airtableRunUrl(deps.config, airtableRunId) }),
    );
    throw error;
  }
}

export async function findAndRunTodaysPublication(
  deps: PublicationServiceDeps,
  correlationId: string,
): Promise<PublicationOutcome> {
  const todayIso = deps.clock.now().toISOString().slice(0, 10);
  const run = await findReadyRunForDate(deps.fetcher, deps.config, deps.airtableToken, todayIso);
  if (!run) {
    return { kind: "no_ready_run" };
  }
  return runPublicationForRun(deps, run.airtableRunId, correlationId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/publication/service.test.ts`
Expected: PASS — 2 tests green.

- [ ] **Step 5: Full check and commit**

Run: `npm run check`

```bash
git add src/publication/service.ts test/publication/service.test.ts
git commit -m "feat(publication): add publication service orchestration with idempotency and cleanup"
```

---

## Task 10: PublicationWorkflow with durable retries and cron/`/docs` triggers

**Files:**
- Create: `src/publication/workflow.ts`
- Modify: `src/scheduled.ts:1-200` (add publication cron branch; do not restructure existing import cron branch)
- Create: `src/routes/docs.ts`
- Modify: `src/router.ts:1-200` (register `POST /docs`; do not restructure existing routes)
- Test: `test/publication/workflow.test.ts`
- Test: `test/routes/docs.test.ts`

**Interfaces:**
- Consumes: `PublicationWorkflowParams` (Task 2), `runPublicationForRun`/`findAndRunTodaysPublication`/`PublicationServiceDeps` (Task 9), `Env` (assumed).
- Produces:
  ```ts
  // src/publication/workflow.ts
  export class PublicationWorkflow extends WorkflowEntrypoint<Env, PublicationWorkflowParams> {
    async run(event: WorkflowEvent<PublicationWorkflowParams>, step: WorkflowStep): Promise<PublicationResult | null>;
  }

  export function buildPublicationServiceDeps(env: Env, clock: Clock, correlationId: string): PublicationServiceDeps;
  ```
  ```ts
  // src/routes/docs.ts
  export async function handleDocsRoute(request: Request, env: Env): Promise<Response>;
  ```
  used by `src/router.ts` and `src/scheduled.ts`.

- [ ] **Step 1: Write the failing workflow test**

```ts
// test/publication/workflow.test.ts
import { describe, expect, it, vi } from "vitest";
import { buildPublicationServiceDeps } from "../../src/publication/workflow";

vi.mock("../../src/line/client", () => ({ pushTextMessage: vi.fn().mockResolvedValue(undefined) }));

describe("buildPublicationServiceDeps", () => {
  it("wires config, tokens, and a signCollageUrl function backed by R2 signed URLs", async () => {
    const env = {
      DB: {} as any,
      IMAGES_BUCKET: {
        get: vi.fn().mockResolvedValue({ body: new ReadableStream() }),
      } as any,
      IMAGES: {} as any,
      AIRTABLE_TOKEN: "airtable-token",
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "svc@example.com", private_key: "unused" }),
      ANTHROPIC_API_KEY: "anthropic-key",
      APP_CONFIG_JSON: JSON.stringify({
        airtableBaseId: "base123",
        airtableProductsTableId: "tblProducts",
        airtablePublicationRunsTableId: "tblRuns",
        lineAllowedGroupId: "group-1",
        googleDriveFolderId: "folder-1",
        googleTemplateDocId: "template-doc-1",
        timeZone: "Asia/Bangkok",
        importCron: "*/30 * * * *",
        publicationCron: "0 6 * * *",
        uploadCutoffMinutes: 30,
        importMaxAttempts: 5,
        publicationMaxAttempts: 5,
        productIdPrefix: "A",
        productIdInitialNumber: 1,
        claudeModel: "claude-opus-5",
        claudeRequestInputTokenLimit: 150000,
        soldoutConfirmationEnabled: true,
        firstImportCutoffDate: "2026-08-01",
      }),
    } as any;

    const clock = { now: () => new Date("2026-09-01T05:00:00.000Z") };
    const deps = buildPublicationServiceDeps(env, clock, "corr-1");

    expect(deps.airtableToken).toBe("airtable-token");
    expect(deps.lineGroupId).toBe("group-1");
    expect(typeof deps.signCollageUrl).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publication/workflow.test.ts`
Expected: FAIL — `Cannot find module '../../src/publication/workflow'`.

- [ ] **Step 3: Write `src/publication/workflow.ts`**

```ts
// src/publication/workflow.ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import type { Clock } from "../shared/time";
import { parseConfig } from "../config";
import { runPublicationForRun } from "./service";
import type { PublicationServiceDeps } from "./service";
import type { PublicationResult } from "./types";
import type { PublicationWorkflowParams } from "./types";
import { collageR2Key } from "./collage";

const SIGNED_URL_TTL_SECONDS = 900;

export function buildPublicationServiceDeps(env: Env, clock: Clock, correlationId: string): PublicationServiceDeps {
  const config = parseConfig(env.APP_CONFIG_JSON);
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 });

  return {
    db: env.DB,
    bucket: env.IMAGES_BUCKET,
    images: env.IMAGES as any,
    fetcher: fetch.bind(globalThis),
    anthropic,
    clock,
    config,
    airtableToken: env.AIRTABLE_TOKEN,
    googleServiceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON,
    lineGroupId: config.lineAllowedGroupId,
    async signCollageUrl(r2Key: string): Promise<string> {
      const object = await env.IMAGES_BUCKET.get(r2Key);
      if (!object) throw new Error(`collage object missing at ${r2Key}`);
      const signed = await env.IMAGES_BUCKET.createSignedUrl?.(r2Key, { expiresIn: SIGNED_URL_TTL_SECONDS });
      if (!signed) throw new Error(`unable to sign collage URL for ${r2Key}`);
      return signed;
    },
  };
}

export class PublicationWorkflow extends WorkflowEntrypoint<Env, PublicationWorkflowParams> {
  async run(event: WorkflowEvent<PublicationWorkflowParams>, step: WorkflowStep): Promise<PublicationResult | null> {
    const correlationId = `publication:${event.payload.publicationRunId}`;
    const clock = { now: () => new Date() };

    const outcome = await step.do(
      "run-publication",
      { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" } },
      async () => {
        const deps = buildPublicationServiceDeps(this.env, clock, correlationId);
        return runPublicationForRun(deps, event.payload.publicationRunId, correlationId);
      },
    );

    if (outcome.kind === "succeeded" || outcome.kind === "already_succeeded") {
      return outcome.result;
    }
    return null;
  }
}

export const __internal = { collageR2Key };
```

- [ ] **Step 4: Run workflow test to verify it passes**

Run: `npx vitest run test/publication/workflow.test.ts`
Expected: PASS — 1 test green.

- [ ] **Step 5: Write the failing `/docs` route test**

```ts
// test/routes/docs.test.ts
import { describe, expect, it, vi } from "vitest";
import { handleDocsRoute } from "../../src/routes/docs";

describe("handleDocsRoute", () => {
  it("finds today's Ready run and creates a Workflow instance keyed by publication:<runId>", async () => {
    const create = vi.fn().mockResolvedValue({ id: "wf-1" });
    const env = {
      PUBLICATION_WORKFLOW: { create },
      APP_CONFIG_JSON: JSON.stringify({
        airtableBaseId: "base123",
        airtableProductsTableId: "tblProducts",
        airtablePublicationRunsTableId: "tblRuns",
        lineAllowedGroupId: "group-1",
        googleDriveFolderId: "folder-1",
        googleTemplateDocId: "template-doc-1",
        timeZone: "Asia/Bangkok",
        importCron: "*/30 * * * *",
        publicationCron: "0 6 * * *",
        uploadCutoffMinutes: 30,
        importMaxAttempts: 5,
        publicationMaxAttempts: 5,
        productIdPrefix: "A",
        productIdInitialNumber: 1,
        claudeModel: "claude-opus-5",
        claudeRequestInputTokenLimit: 150000,
        soldoutConfirmationEnabled: true,
        firstImportCutoffDate: "2026-08-01",
      }),
      AIRTABLE_TOKEN: "airtable-token",
    } as any;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ records: [{ id: "rec-run-1", fields: { "Publication Date": "2026-09-01", Status: "Ready", Products: [] } }] }),
        { status: 200 },
      ),
    );

    const response = await handleDocsRoute(new Request("https://worker.example/docs", { method: "POST" }), env);

    expect(response.status).toBe(202);
    expect(create).toHaveBeenCalledWith({ id: "publication:rec-run-1", params: { publicationRunId: "rec-run-1", trigger: "line" } });

    fetchSpy.mockRestore();
  });

  it("returns 200 with no-op body when no Ready run exists for today", async () => {
    const env = {
      PUBLICATION_WORKFLOW: { create: vi.fn() },
      APP_CONFIG_JSON: JSON.stringify({
        airtableBaseId: "base123",
        airtableProductsTableId: "tblProducts",
        airtablePublicationRunsTableId: "tblRuns",
        lineAllowedGroupId: "group-1",
        googleDriveFolderId: "folder-1",
        googleTemplateDocId: "template-doc-1",
        timeZone: "Asia/Bangkok",
        importCron: "*/30 * * * *",
        publicationCron: "0 6 * * *",
        uploadCutoffMinutes: 30,
        importMaxAttempts: 5,
        publicationMaxAttempts: 5,
        productIdPrefix: "A",
        productIdInitialNumber: 1,
        claudeModel: "claude-opus-5",
        claudeRequestInputTokenLimit: 150000,
        soldoutConfirmationEnabled: true,
        firstImportCutoffDate: "2026-08-01",
      }),
      AIRTABLE_TOKEN: "airtable-token",
    } as any;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ records: [] }), { status: 200 }));

    const response = await handleDocsRoute(new Request("https://worker.example/docs", { method: "POST" }), env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "no_ready_run" });

    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/routes/docs.test.ts`
Expected: FAIL — `Cannot find module '../../src/routes/docs'`.

- [ ] **Step 7: Write `src/routes/docs.ts`**

```ts
// src/routes/docs.ts
import type { Env } from "../env";
import { parseConfig } from "../config";
import { jsonResponse } from "../shared/http";
import { findReadyRunForDate } from "../publication/airtable-runs";

export async function handleDocsRoute(request: Request, env: Env): Promise<Response> {
  const config = parseConfig(env.APP_CONFIG_JSON);
  const todayIso = new Date().toISOString().slice(0, 10);

  const run = await findReadyRunForDate(fetch.bind(globalThis), config, env.AIRTABLE_TOKEN, todayIso);
  if (!run) {
    return jsonResponse({ status: "no_ready_run" }, { status: 200 });
  }

  await env.PUBLICATION_WORKFLOW.create({
    id: `publication:${run.airtableRunId}`,
    params: { publicationRunId: run.airtableRunId, trigger: "line" },
  });

  return jsonResponse({ status: "started", publicationRunId: run.airtableRunId }, { status: 202 });
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/routes/docs.test.ts`
Expected: PASS — 2 tests green.

- [ ] **Step 9: Wire `/docs` into the router**

Modify `src/router.ts` by adding one route registration next to the existing `/upload` entry (do not touch other routes):

```ts
import { handleDocsRoute } from "./routes/docs";
// ... existing imports stay unchanged

// inside the existing route table/dispatch, alongside the existing POST /upload entry:
if (request.method === "POST" && url.pathname === "/docs") {
  return handleDocsRoute(request, env);
}
```

- [ ] **Step 10: Wire the publication cron into `scheduled.ts`**

Modify `src/scheduled.ts` by adding one branch next to the existing import-cron branch (do not touch the existing import branch):

```ts
import { findAndRunTodaysPublication } from "./publication/service";
import { buildPublicationServiceDeps } from "./publication/workflow";
import { newCorrelationId } from "./shared/ids";
// ... existing imports stay unchanged

// inside the existing scheduled handler, alongside the existing import-cron branch:
if (controller.cron === config.publicationCron) {
  const correlationId = newCorrelationId();
  const clock = { now: () => new Date(event.scheduledTime) };
  const deps = buildPublicationServiceDeps(env, clock, correlationId);
  await findAndRunTodaysPublication(deps, correlationId);
  return;
}
```

- [ ] **Step 11: Full check and commit**

Run: `npm run check`

```bash
git add src/publication/workflow.ts src/routes/docs.ts src/router.ts src/scheduled.ts test/publication/workflow.test.ts test/routes/docs.test.ts
git commit -m "feat(publication): add PublicationWorkflow, /docs trigger, and publication cron"
```

---

## Task 11: Publication acceptance tests

**Files:**
- Create: `test/acceptance/publication.test.ts`

**Interfaces:**
- Consumes: `runPublicationForRun`, `PublicationServiceDeps` (Task 9); `COLLAGE_BASE_R2_KEY` (Task 4); publication D1 repository (Task 1).
- Produces: no new exports — this task only adds tests.

This suite proves the acceptance criteria from spec section 18 (“Publication acceptance”): missing field blocks the whole document, first-four image ordering, collage layout, three captions per Product ID, suffix changes, Google API failure, duplicate `/docs`, one final document per date.

- [ ] **Step 1: Write the failing acceptance test file**

```ts
// test/acceptance/publication.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";

vi.mock("../../src/line/client", () => ({ pushTextMessage: vi.fn().mockResolvedValue(undefined) }));

import { runPublicationForRun } from "../../src/publication/service";
import type { PublicationServiceDeps } from "../../src/publication/service";
import { COLLAGE_BASE_R2_KEY, COLLAGE_CELL_POSITIONS } from "../../src/publication/collage";

const clock = { now: () => new Date("2026-09-01T05:00:00.000Z") };
const config = {
  airtableBaseId: "base123",
  airtableProductsTableId: "tblProducts",
  airtablePublicationRunsTableId: "tblRuns",
  claudeModel: "claude-opus-5",
  claudeRequestInputTokenLimit: 150000,
  googleDriveFolderId: "folder-1",
  googleTemplateDocId: "template-doc-1",
  timeZone: "Asia/Bangkok",
} as any;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function productFields(id: string, overrides: Record<string, unknown> = {}) {
  return {
    "Product ID": id,
    "Product Images": [
      { id: "a", url: `assets/${id}-1.jpg` },
      { id: "b", url: `assets/${id}-2.jpg` },
      { id: "c", url: `assets/${id}-3.jpg` },
      { id: "d", url: `assets/${id}-4.jpg` },
    ],
    "Brand Name": "Nike",
    "Model Name": "Air Max",
    "Condition Type": "Used",
    Size: "42",
    Description: "Good condition",
    "LINE Square Price": 1290,
    "IG Price": 1390,
    ...overrides,
  };
}

function fakeImages(collageCalls: unknown[]) {
  return {
    input: () => {
      const t: any = {
        transform(options: unknown) {
          collageCalls.push({ op: "transform", options });
          return t;
        },
        draw(_overlay: unknown, options: unknown) {
          collageCalls.push({ op: "draw", options });
          return t;
        },
        async output() {
          return { response: () => new Response(new Uint8Array([1, 2, 3])) };
        },
      };
      return t;
    },
  };
}

async function fakeBucket() {
  const store = new Map<string, Uint8Array>();
  store.set(COLLAGE_BASE_R2_KEY, new Uint8Array([1]));
  for (const id of ["A-2001", "A-2002"]) {
    for (const suffix of ["1", "2", "3", "4"]) store.set(`assets/${id}-${suffix}.jpg`, new Uint8Array([1]));
  }
  return {
    async get(key: string) {
      const v = store.get(key);
      return v ? { body: new ReadableStream() } : null;
    },
    async put(key: string, value: unknown) {
      store.set(key, value as Uint8Array);
    },
  } as unknown as R2Bucket;
}

function docBodyWithMarkers() {
  return {
    body: {
      content: [
        { paragraph: { elements: [{ startIndex: 1, endIndex: 21, textRun: { content: "{{PUBLICATION_DATE}}" } }] } },
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
  };
}

function toolCaptionResponse(productIds: string[]) {
  return {
    content: [
      {
        type: "tool_use",
        name: "submit_captions",
        input: { captions: productIds.map((id) => ({ productId: id, drafts: [`${id}-d1`, `${id}-d2`, `${id}-d3`] })) },
      },
    ],
  };
}

function buildDeps(overrides: Partial<PublicationServiceDeps> = {}): PublicationServiceDeps {
  return {
    db: env.DB,
    bucket: overrides.bucket ?? ({} as any),
    images: overrides.images ?? ({} as any),
    fetcher: overrides.fetcher ?? (vi.fn() as any),
    anthropic: overrides.anthropic ?? ({ messages: { create: vi.fn(), countTokens: vi.fn() } } as any),
    clock,
    config,
    airtableToken: "airtable-token",
    googleServiceAccountJson: JSON.stringify({ client_email: "svc@example.com", private_key: "unused" }),
    lineGroupId: "group-1",
    signCollageUrl: overrides.signCollageUrl ?? (async (key: string) => `https://r2.example.com/signed/${key}`),
  };
}

describe("publication acceptance", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM publication_jobs");
    await env.DB.exec("DELETE FROM publication_product_cache");
  });

  it("blocks the whole document when any linked product is missing a required field", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("tblRuns") && init?.method === "PATCH") {
        const body = JSON.parse((init as any).body);
        expect(body.fields.Status).toBe("Draft");
        return jsonResponse({ id: "rec-run-1" });
      }
      if (url.includes("tblRuns")) {
        return jsonResponse({ records: [{ id: "rec-run-1", fields: { "Publication Date": "2026-09-01", Status: "Ready", Products: ["recA", "recB"] } }] });
      }
      if (url.includes("tblProducts")) {
        return jsonResponse({
          records: [
            { id: "recA", fields: productFields("A-2001") },
            { id: "recB", fields: productFields("A-2002", { Description: "" }) },
          ],
        });
      }
      throw new Error(`unhandled fetch: ${url}`);
    });

    const deps = buildDeps({ fetcher: fetcher as any });
    const outcome = await runPublicationForRun(deps, "rec-run-1", "corr-1");
    expect(outcome.kind).toBe("validation_failed");

    const patchCalls = fetcher.mock.calls.filter(([, init]: any) => init?.method === "PATCH" && String(init?.body).includes("Draft"));
    expect(patchCalls.length).toBeGreaterThan(0);

    const googleDocsCalls = fetcher.mock.calls.filter(([url]) => String(url).includes("docs.googleapis.com"));
    expect(googleDocsCalls).toHaveLength(0);
  });

  it("uses only the first four ordered images for the collage in ordered position", async () => {
    const collageCalls: unknown[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("tblRuns") && init?.method === "PATCH") return jsonResponse({ id: "rec-run-1" });
      if (url.includes("tblRuns")) {
        return jsonResponse({
          records: [{ id: "rec-run-1", fields: { "Publication Date": "2026-09-01", Status: "Ready", Products: ["recA"] } }],
        });
      }
      if (url.includes("tblProducts") && init?.method === "PATCH") return jsonResponse({ id: "recA" });
      if (url.includes("tblProducts")) {
        return jsonResponse({
          records: [
            {
              id: "recA",
              fields: productFields("A-2001", {
                "Product Images": [
                  { id: "a", url: "assets/A-2001-1.jpg" },
                  { id: "b", url: "assets/A-2001-2.jpg" },
                  { id: "c", url: "assets/A-2001-3.jpg" },
                  { id: "d", url: "assets/A-2001-4.jpg" },
                  { id: "e", url: "assets/A-2001-5.jpg" },
                ],
              }),
            },
          ],
        });
      }
      if (url.includes("drive/v3/files") && url.includes("copy")) return jsonResponse({ id: "temp-doc-1" });
      if (url.includes("docs.googleapis.com") && !url.includes("batchUpdate")) return jsonResponse(docBodyWithMarkers());
      if (url.includes("batchUpdate")) return jsonResponse({ documentId: "temp-doc-1" });
      if (url.includes("drive/v3/files/temp-doc-1") && init?.method === "PATCH") return jsonResponse({ id: "temp-doc-1" });
      throw new Error(`unhandled fetch: ${url}`);
    });

    const anthropic = { messages: { create: vi.fn().mockResolvedValue(toolCaptionResponse(["A-2001"])), countTokens: vi.fn().mockResolvedValue({ input_tokens: 100 }) } };
    const deps = buildDeps({ fetcher: fetcher as any, bucket: await fakeBucket(), images: fakeImages(collageCalls) as any, anthropic: anthropic as any });

    // verifyDocumentContainsProducts reads the doc again; make that call return text containing the Product ID.
    fetcher.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("tblRuns") && init?.method === "PATCH") return jsonResponse({ id: "rec-run-1" });
      if (url.includes("tblRuns")) {
        return jsonResponse({ records: [{ id: "rec-run-1", fields: { "Publication Date": "2026-09-01", Status: "Ready", Products: ["recA"] } }] });
      }
      if (url.includes("tblProducts") && init?.method === "PATCH") return jsonResponse({ id: "recA" });
      if (url.includes("tblProducts")) {
        return jsonResponse({
          records: [
            {
              id: "recA",
              fields: productFields("A-2001", {
                "Product Images": [
                  { id: "a", url: "assets/A-2001-1.jpg" },
                  { id: "b", url: "assets/A-2001-2.jpg" },
                  { id: "c", url: "assets/A-2001-3.jpg" },
                  { id: "d", url: "assets/A-2001-4.jpg" },
                  { id: "e", url: "assets/A-2001-5.jpg" },
                ],
              }),
            },
          ],
        });
      }
      if (url.includes("drive/v3/files") && url.includes("copy")) return jsonResponse({ id: "temp-doc-1" });
      if (url.includes("batchUpdate")) return jsonResponse({ documentId: "temp-doc-1" });
      if (url.includes("docs.googleapis.com")) {
        return jsonResponse({
          body: { content: [{ paragraph: { elements: [{ textRun: { content: "Product ID: A-2001" } }] } }] },
        });
      }
      if (url.includes("drive/v3/files/temp-doc-1") && init?.method === "PATCH") return jsonResponse({ id: "temp-doc-1" });
      throw new Error(`unhandled fetch: ${url}`);
    });

    const outcome = await runPublicationForRun(deps, "rec-run-1", "corr-1");
    expect(outcome.kind).toBe("succeeded");

    const drawCalls = collageCalls.filter((c: any) => c.op === "draw");
    expect(drawCalls).toHaveLength(4);
    expect((drawCalls as any[]).map((c) => ({ top: c.options.top, left: c.options.left }))).toEqual(COLLAGE_CELL_POSITIONS);
  });

  it("returns already_succeeded and never creates a second final document on duplicate /docs for the same run", async () => {
    await env.DB.prepare(
      `INSERT INTO publication_jobs (publication_run_id, state, correlation_id, google_doc_id, google_doc_url, attempt_count, created_at, updated_at)
       VALUES (?, 'succeeded', 'corr-0', 'doc-existing', 'https://docs.google.com/document/d/doc-existing/edit', 1, ?, ?)`,
    )
      .bind("rec-run-1", clock.now().toISOString(), clock.now().toISOString())
      .run();

    const fetcher = vi.fn();
    const deps = buildDeps({ fetcher: fetcher as any });
    const outcome = await runPublicationForRun(deps, "rec-run-1", "corr-1");

    expect(outcome).toEqual({
      kind: "already_succeeded",
      result: {
        publicationRunId: "rec-run-1",
        googleDocId: "doc-existing",
        googleDocUrl: "https://docs.google.com/document/d/doc-existing/edit",
        productIds: [],
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("deletes the temporary document and marks the job failed when the Google API fails persistently", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("tblRuns") && init?.method === "PATCH") return jsonResponse({ id: "rec-run-1" });
      if (url.includes("tblRuns")) {
        return jsonResponse({ records: [{ id: "rec-run-1", fields: { "Publication Date": "2026-09-01", Status: "Ready", Products: ["recA"] } }] });
      }
      if (url.includes("tblProducts")) {
        return jsonResponse({ records: [{ id: "recA", fields: productFields("A-2001") }] });
      }
      if (url.includes("drive/v3/files") && url.includes("copy")) return jsonResponse({ id: "temp-doc-1" });
      if (url.includes("docs.googleapis.com") && !url.includes("batchUpdate")) return jsonResponse(docBodyWithMarkers());
      if (url.includes("batchUpdate")) return new Response("server error", { status: 500 });
      if (url.includes("drive/v3/files/temp-doc-1") && init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`unhandled fetch: ${url}`);
    });

    const anthropic = { messages: { create: vi.fn().mockResolvedValue(toolCaptionResponse(["A-2001"])), countTokens: vi.fn().mockResolvedValue({ input_tokens: 100 }) } };
    const deps = buildDeps({ fetcher: fetcher as any, bucket: await fakeBucket(), images: fakeImages([]) as any, anthropic: anthropic as any });

    await expect(runPublicationForRun(deps, "rec-run-1", "corr-1")).rejects.toThrow();

    const deleteCalls = fetcher.mock.calls.filter(([url, init]: any) => String(url).includes("temp-doc-1") && init?.method === "DELETE");
    expect(deleteCalls).toHaveLength(1);

    const jobRow = await env.DB.prepare("SELECT state FROM publication_jobs WHERE publication_run_id = ?").bind("rec-run-1").first<{ state: string }>();
    expect(jobRow?.state).toBe("failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/acceptance/publication.test.ts`
Expected: FAIL — assertions fail or requests are unhandled because prior tasks are not yet wired together correctly in this exact combination (surfaces integration gaps not caught by unit tests).

- [ ] **Step 3: Fix integration gaps until the suite passes**

Common gaps to expect and fix directly in the files from Tasks 1–9 (not new files):
- If `verifyDocumentContainsProducts` is called against the same `docId` as `fillTemplate` in `service.ts`, confirm the mocked route order in the test matches call order in `service.ts` (`fillTemplate` then `verifyDocumentContainsProducts`); adjust the fetch router in the test if a route is unreachable, not the implementation, unless the implementation calls a different sequence than intended.
- If `ensureCollage` in `service.ts` reads `getProductCache`/`putProductCollage` keyed by `product.airtableRecordId` instead of `publicationRunId`, correct the two calls in `service.ts` to use `airtableRunId` consistently (this task's fixture inserts/reads cache rows keyed by `publicationRunId`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/acceptance/publication.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Full check and commit**

Run: `npm run check`

```bash
git add test/acceptance/publication.test.ts
git commit -m "test(publication): add acceptance suite for validation blocking, collage ordering, idempotency, and cleanup"
```

---

## Plan Completion Definition

This plan is complete only when:

- `npm run check` passes with all publication tests included.
- `migrations/0002_publication.sql` applies cleanly to a fresh local D1 database via `npm run db:migrate:local`.
- The publication acceptance suite (Task 11) proves: missing-field blocks the whole document and creates no Google Doc; first-four ordered images drive the collage in deterministic position; three captions are generated per Product ID; duplicate `/docs` triggers never create a second final document for the same run; a persistent Google API failure deletes the temporary document and marks the job `failed`.
- `POST /docs` and the publication cron branch both start/resume `PublicationWorkflow` keyed by `publication:<airtablePublicationRunId>`.
- LINE receives a Thai success message (date, count, Product IDs, Google Doc link) on success, a grouped missing-fields report on validation failure, and a failure report with a safe retry command on workflow failure — and none of these messages contain secrets, signed URLs, or raw stack traces (Task 8, Step 1 second test).

## Self-Review Notes

- **Spec coverage:** section 10 (trigger/validation, collage, captions, template, completion/retries) is covered by Tasks 1–2–3–4–5–7–9; section 11's `/docs` command and section 8's cron pattern are covered by Task 10; section 13's LINE log requirements are covered by Task 8; section 12's publication idempotency (`Unique key: Airtable Publication Run ID. One final Google Doc ID per run.`) is covered by Task 1's `publication_jobs` lock plus Task 9's `already_succeeded` short-circuit, exercised in Task 11.
- **Placeholder scan:** no TBD/TODO markers; every step has runnable code and exact commands.
- **Type consistency:** `PublicationServiceDeps`, `PublicationOutcome`, `CaptionSet`, `DocProductContent`, and `ImagesBinding` are defined once (Tasks 2, 4, 5, 7, 9) and reused verbatim by every later task; `collageR2Key`/`COLLAGE_BASE_R2_KEY`/`COLLAGE_CELL_POSITIONS` from Task 4 are the single source used by Tasks 9 and 11.
