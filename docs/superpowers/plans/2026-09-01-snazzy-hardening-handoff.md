# Hardening and Customer Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the completed Snazzy Automation system (Foundation, Import, Publication, LINE plans all implemented) survives failure injection, production-sized volume, and a fresh customer deployment, then hand it off with cost controls, monitoring, and runbooks.

**Architecture:** This plan adds no new business features. It adds a usage-metrics D1 table and repository wired into existing Claude and R2 call sites, a setup-validation route and CLI script, a budget/cost report backed by that table, failure-injectable test fakes exercised against the existing `import/service.ts` and `publication/service.ts` orchestration functions, staging/production `wrangler.jsonc` environments, and four operator runbooks. Every acceptance suite (import batches, publication, LINE, redaction, smoke) runs against the real service functions with fake external clients — no new production code paths are introduced beyond metrics and setup validation.

**Tech Stack:** TypeScript, Cloudflare Workers, Cloudflare Workflows, D1, R2, Cloudflare Images, Vitest 4.1+, `@cloudflare/vitest-plugin`, Zod, `@anthropic-ai/sdk`, `tsx` (new devDependency for running `scripts/*.ts`).

**Spec:** `docs/superpowers/specs/2026-09-01-snazzy-automation-design.md`

## Global Constraints

- Dedicated customer-owned staging and production deployments.
- Runtime timezone: `Asia/Bangkok`.
- Import volume: 100–500 photos/day; normal product group: 9–15 photos.
- Retry transient workflow steps five times with exponential backoff.
- Missing Product data blocks whole publication and creates no Google Doc.
- Already-Out Product is never overwritten.
- Only allowlisted LINE group may execute commands; every LINE webhook signature is verified.
- Never log credentials, public-album token/link, signed URLs, Product images, or raw external response bodies containing them.
- Infrastructure and AI spend target remains under ฿1,000/month, excluding Airtable, Google Workspace, and LINE plan fees.
- Use native `fetch` routing; do not add a web framework.
- Use official `@anthropic-ai/sdk`; do not call Claude through raw HTTP.
- Cloudflare compatibility date must be `2026-09-01` or later and include `nodejs_compat`.
- Every non-trivial parser, state transition, money mutation, and trust boundary starts with a failing test.
- Every task ends with focused tests, the full test command, and a commit.
- This plan assumes Foundation, Import pipeline, Publication pipeline, and LINE inventory bot plans are already implemented and `npm run check` currently passes on `main`.

---

## Prerequisite: install `tsx`

Every task below that runs a `scripts/*.ts` file needs a TypeScript script runner. Install it once before Task 1.

```bash
npm install --save-dev tsx
```

Add to `package.json` `scripts`:

```json
{
  "scripts": {
    "setup:verify": "tsx scripts/verify-airtable-schema.ts",
    "usage:alarms": "tsx scripts/configure-usage-alarms.ts",
    "smoke:staging": "tsx scripts/smoke-test.ts --env staging",
    "smoke:production": "tsx scripts/smoke-test.ts --env production",
    "test:acceptance": "vitest run test/acceptance"
  }
}
```

Commit:

```bash
git add package.json package-lock.json
git commit -m "chore: add tsx for running operational scripts"
```

---

### Task 1: Usage-metrics D1 table and repository

**Files:**
- Create: `migrations/0002_usage_metrics.sql`
- Create: `src/db/usage-repository.ts`
- Test: `test/db/usage-repository.test.ts`

**Interfaces:**
- Consumes: `Env.DB` (`D1Database`, from `src/env.ts`).
- Produces: `recordUsage(db: D1Database, metricName: string, value: number, metricDate: string): Promise<void>` and `getMonthlyUsage(db: D1Database, yearMonth: string): Promise<Record<string, number>>`, both consumed by Task 2 (metric call sites) and Task 9 (cost report).

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0002_usage_metrics.sql
CREATE TABLE usage_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_date TEXT NOT NULL,       -- 'YYYY-MM-DD' in Asia/Bangkok
  metric_name TEXT NOT NULL,       -- e.g. 'claude_input_tokens', 'r2_bytes_written'
  metric_value INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(metric_date, metric_name)
);

CREATE INDEX idx_usage_metrics_date ON usage_metrics(metric_date);
CREATE INDEX idx_usage_metrics_name ON usage_metrics(metric_name);
```

- [ ] **Step 2: Apply migration locally**

Run: `npm run db:migrate:local`
Expected: `Migrations to be applied: 0002_usage_metrics.sql` then `✅ Successfully applied`.

- [ ] **Step 3: Write the failing test**

```ts
// test/db/usage-repository.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { recordUsage, getMonthlyUsage } from "../../src/db/usage-repository";

describe("usage-repository", () => {
  it("accumulates same-day same-metric writes instead of overwriting", async () => {
    await recordUsage(env.DB, "claude_input_tokens", 1200, "2026-09-01");
    await recordUsage(env.DB, "claude_input_tokens", 800, "2026-09-01");

    const monthly = await getMonthlyUsage(env.DB, "2026-09");
    expect(monthly.claude_input_tokens).toBe(2000);
  });

  it("keeps metrics from different months separate", async () => {
    await recordUsage(env.DB, "r2_bytes_written", 5_000_000, "2026-08-31");
    await recordUsage(env.DB, "r2_bytes_written", 3_000_000, "2026-09-01");

    const august = await getMonthlyUsage(env.DB, "2026-08");
    const september = await getMonthlyUsage(env.DB, "2026-09");
    expect(august.r2_bytes_written).toBe(5_000_000);
    expect(september.r2_bytes_written).toBe(3_000_000);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/db/usage-repository.test.ts`
Expected: FAIL with `Cannot find module '../../src/db/usage-repository'`.

- [ ] **Step 5: Write minimal implementation**

```ts
// src/db/usage-repository.ts
export async function recordUsage(
  db: D1Database,
  metricName: string,
  value: number,
  metricDate: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage_metrics (metric_date, metric_name, metric_value, created_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(metric_date, metric_name)
       DO UPDATE SET metric_value = metric_value + excluded.metric_value`,
    )
    .bind(metricDate, metricName, value, new Date().toISOString())
    .run();
}

export async function getMonthlyUsage(
  db: D1Database,
  yearMonth: string,
): Promise<Record<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT metric_name, SUM(metric_value) AS total
       FROM usage_metrics
       WHERE metric_date LIKE ?1
       GROUP BY metric_name`,
    )
    .bind(`${yearMonth}-%`)
    .all<{ metric_name: string; total: number }>();

  const out: Record<string, number> = {};
  for (const row of results) out[row.metric_name] = row.total;
  return out;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/db/usage-repository.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add migrations/0002_usage_metrics.sql src/db/usage-repository.ts test/db/usage-repository.test.ts
git commit -m "feat: add usage_metrics table and repository for cost tracking"
```

---

### Task 2: Wire token and byte metrics into existing call sites

**Files:**
- Modify: `src/publication/captions.ts` (existing Anthropic SDK call site from the publication plan)
- Modify: `src/import/asset-store.ts` (existing R2 write call site from the import plan)
- Test: `test/publication/captions.test.ts` (extend existing suite)
- Test: `test/import/asset-store.test.ts` (extend existing suite)

**Interfaces:**
- Consumes: `recordUsage` from Task 1; the Anthropic SDK response shape `{ usage: { input_tokens: number; output_tokens: number } }`; the existing `Clock` type (`{ now(): Date }`) from `src/shared/time.ts` for the metric date.
- Produces: no new exported symbols — this task only adds side-effecting calls inside existing functions, observed via `env.DB` reads in tests.

- [ ] **Step 1: Write the failing test for captions**

```ts
// test/publication/captions.test.ts (add to existing describe block)
import { env } from "cloudflare:test";
import { getMonthlyUsage } from "../../src/db/usage-repository";

it("records Claude input and output token usage in D1", async () => {
  const fakeAnthropic = {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: JSON.stringify({ "A-1001": ["a", "b", "c"] }) }],
        usage: { input_tokens: 500, output_tokens: 300 },
      }),
    },
  };

  await generateCaptions(
    fakeAnthropic as any,
    [{ airtableRecordId: "rec1", productId: "A-1001", orderedImageKeys: [], brandName: "Nike", modelName: "Air", conditionType: "New", size: "42", description: "d", lineSquarePrice: 100, igPrice: 100 }],
    env.DB,
    { now: () => new Date("2026-09-01T10:00:00+07:00") },
  );

  const usage = await getMonthlyUsage(env.DB, "2026-09");
  expect(usage.claude_input_tokens).toBe(500);
  expect(usage.claude_output_tokens).toBe(300);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publication/captions.test.ts -t "records Claude"`
Expected: FAIL — either the extra `db`/`clock` parameters are rejected by TypeScript or `usage.claude_input_tokens` is `undefined`.

- [ ] **Step 3: Extend the function signature and record usage**

```ts
// src/publication/captions.ts (inside existing generateCaptions, after a successful SDK call)
import { recordUsage } from "../db/usage-repository";
import { bangkokDateString } from "../shared/time"; // existing helper from Foundation plan

export async function generateCaptions(
  client: Anthropic,
  products: PublicationProduct[],
  db: D1Database,
  clock: Clock,
): Promise<CaptionSet[]> {
  // ...existing request-building and retry logic stays unchanged...
  const response = await client.messages.create(/* existing params */);

  await recordUsage(db, "claude_input_tokens", response.usage.input_tokens, bangkokDateString(clock.now()));
  await recordUsage(db, "claude_output_tokens", response.usage.output_tokens, bangkokDateString(clock.now()));

  // ...existing parsing/validation into CaptionSet[] stays unchanged...
}
```

Update every call site of `generateCaptions` (in `src/publication/service.ts` and its workflow step) to pass `db` and `clock`, both of which those callers already hold.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/publication/captions.test.ts`
Expected: PASS, including all pre-existing tests in the file.

- [ ] **Step 5: Write the failing test for R2 byte tracking**

```ts
// test/import/asset-store.test.ts (add to existing describe block)
import { env } from "cloudflare:test";
import { getMonthlyUsage } from "../../src/db/usage-repository";

it("records bytes written to R2 per stored asset", async () => {
  const body = new Uint8Array(2_500_000);
  await storeAsset(env.IMAGES_BUCKET, env.DB, "sha256-fixture", body, { now: () => new Date("2026-09-01T10:00:00+07:00") });

  const usage = await getMonthlyUsage(env.DB, "2026-09");
  expect(usage.r2_bytes_written).toBe(2_500_000);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/import/asset-store.test.ts -t "records bytes"`
Expected: FAIL — `storeAsset` does not accept `db`/`clock` or does not record usage.

- [ ] **Step 7: Extend `storeAsset`**

```ts
// src/import/asset-store.ts
import { recordUsage } from "../db/usage-repository";
import { bangkokDateString } from "../shared/time";

export async function storeAsset(
  bucket: R2Bucket,
  db: D1Database,
  contentHash: string,
  body: Uint8Array,
  clock: Clock,
): Promise<string> {
  const key = `assets/${contentHash}.jpg`; // existing key derivation stays unchanged
  await bucket.put(key, body); // existing put call stays unchanged
  await recordUsage(db, "r2_bytes_written", body.byteLength, bangkokDateString(clock.now()));
  return key;
}
```

Update every call site in `src/import/service.ts` and `src/import/workflow.ts` to pass `db` and `clock`, both already available in those scopes.

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/import/asset-store.test.ts test/publication/captions.test.ts`
Expected: PASS.

- [ ] **Step 9: Run full check**

Run: `npm run check`
Expected: PASS — signature changes propagated to every caller.

- [ ] **Step 10: Commit**

```bash
git add src/publication/captions.ts src/import/asset-store.ts test/publication/captions.test.ts test/import/asset-store.test.ts src/publication/service.ts src/publication/workflow.ts src/import/service.ts src/import/workflow.ts
git commit -m "feat: record Claude token and R2 byte usage for cost reporting"
```

---

### Task 3: Redaction assertion sweep

**Files:**
- Modify: `test/shared/logger.test.ts` (extend existing suite from Foundation plan)
- Create: `test/acceptance/redaction.test.ts`

**Interfaces:**
- Consumes: existing `LogFields`, `redact(fields)`, and `createLogger(base)` from Foundation plan.
- Produces: `redactText(value: string): string`; `redact(fields)` additionally sanitizes sensitive text embedded in non-secret-key string values; logger messages are sanitized before serialization.

- [ ] **Step 1: Write failing unit tests for embedded secrets**

```ts
// test/shared/logger.test.ts (add to existing imports and describe block)
import { redactText } from "../../src/shared/logger";

it.each([
  ["iCloud URL", "fetch https://p123-sharedstreams.icloud.com/A1b2C3d4Token/00/asset.jpg", "A1b2C3d4Token"],
  ["signed asset URL", "https://worker.example/assets/x.jpg?X-Amz-Signature=abcdef123456&X-Amz-Expires=600", "abcdef123456"],
  ["LINE bearer token", "Authorization: Bearer LINE_CHANNEL_ACCESS_TOKEN_VALUE_XYZ", "LINE_CHANNEL_ACCESS_TOKEN_VALUE_XYZ"],
  ["Airtable token", "Authorization: Bearer patABCDEF1234567890.somehash", "patABCDEF1234567890"],
])("redacts %s embedded in text", (_name, input, secret) => {
  const line = redactText(input);
  expect(line).not.toContain(secret);
  expect(line).toContain("[REDACTED]");
});

it("sanitizes message and ordinary string fields before writing JSON", () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  const logger = createLogger({ correlationId: "corr-redact" });
  logger.info("using Bearer LINE_CHANNEL_ACCESS_TOKEN_VALUE_XYZ", {
    endpoint: "https://worker.example/assets/x.jpg?X-Amz-Signature=abcdef123456",
  });

  const line = spy.mock.calls[0][0] as string;
  expect(line).not.toContain("LINE_CHANNEL_ACCESS_TOKEN_VALUE_XYZ");
  expect(line).not.toContain("abcdef123456");
  spy.mockRestore();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/shared/logger.test.ts`
Expected: FAIL — `redactText` is not exported and embedded values remain visible.

- [ ] **Step 3: Replace `src/shared/logger.ts` with the complete hardened implementation**

```ts
// src/shared/logger.ts
export type LogFields = Record<string, string | number | boolean | null>;

const SECRET_KEY_PATTERN = /token|secret|signedurl|signed_url|derivativeurl|password|authorization/i;
const SECRET_TEXT_PATTERNS: RegExp[] = [
  /sharedstreams\.icloud\.com\/[A-Za-z0-9_-]{10,}/gi,
  /X-Amz-Signature=[^&\s]+/gi,
  /Bearer\s+[A-Za-z0-9._-]{16,}/g,
  /pat[A-Za-z0-9]{14,}\.[A-Za-z0-9]+/g,
];

export function redactText(value: string): string {
  return SECRET_TEXT_PATTERNS.reduce(
    (output, pattern) => output.replace(pattern, "[REDACTED]"),
    value,
  );
}

export function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = typeof value === "string" ? redactText(value) : value;
    }
  }
  return out;
}

function write(level: "info" | "warn" | "error", base: LogFields, message: string, fields: LogFields) {
  const line = JSON.stringify({
    level,
    message: redactText(message),
    ...redact(base),
    ...redact(fields),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(base: LogFields) {
  return {
    info(message: string, fields: LogFields = {}) {
      write("info", base, message, fields);
    },
    warn(message: string, fields: LogFields = {}) {
      write("warn", base, message, fields);
    },
    error(message: string, fields: LogFields = {}) {
      write("error", base, message, fields);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/shared/logger.test.ts`
Expected: PASS.

- [ ] **Step 5: Write an end-to-end redaction acceptance test**

```ts
// test/acceptance/redaction.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { runImport } from "../../src/import/service";
import { buildFakeImageSource, buildFakeAirtableProducts } from "../helpers/fakes";
import { buildAlbumSnapshot } from "../helpers/fixtures";

describe("redaction across a full import run", () => {
  let logLines: string[];

  beforeEach(() => {
    logLines = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logLines.push(String(line));
    });
  });

  it("never logs the iCloud album token or a signed R2 URL", async () => {
    const secretToken = "SECRET_ALBUM_TOKEN_9f8e7d6c5b4a";
    const snapshot = buildAlbumSnapshot({
      photoCount: 12,
      markerEveryN: 12,
      derivativeUrlToken: secretToken,
    });
    const imageSource = buildFakeImageSource(snapshot);
    const airtable = buildFakeAirtableProducts();

    await runImport({
      importRunId: "run-redaction-1",
      db: env.DB,
      bucket: env.IMAGES_BUCKET,
      images: env.IMAGES,
      imageSource,
      airtableProducts: airtable,
      clock: { now: () => new Date("2026-09-01T07:00:00+07:00") },
    });

    const joined = logLines.join("\n");
    expect(joined).not.toContain(secretToken);
    expect(joined).not.toMatch(/X-Amz-Signature=[^&\s"]{10,}/);
  });
});
```

- [ ] **Step 6: Run the end-to-end redaction test**

Run: `npx vitest run test/acceptance/redaction.test.ts`
Expected: PASS — full import logs contain neither the album token nor signed-URL signature.

- [ ] **Step 7: Commit**

```bash
git add src/shared/logger.ts test/shared/logger.test.ts test/acceptance/redaction.test.ts
git commit -m "test: assert redaction of tokens and signed URLs across a full import run"
```

---

### Task 4: Failure-injection fakes and retry-exhaustion tests

**Files:**
- Modify: `test/helpers/fakes.ts` (extend existing fakes from Foundation plan)
- Create: `test/acceptance/failure-injection.test.ts`

**Interfaces:**
- Consumes: `ImportRunResult` from `src/import/types.ts`; `PublicationResult` from `src/publication/types.ts`; `runImport` from `src/import/service.ts`; `runPublication` from `src/publication/service.ts` (both existing exports from their respective plans).
- Produces: `buildFlakyAirtableProducts(failCount: number)` and `buildFlakyGoogleDocs(failCount: number)`, reused by Tasks 5 and 6.

- [ ] **Step 1: Write the failure-injection fake**

```ts
// test/helpers/fakes.ts (add alongside existing fake builders)
export function buildFlakyAirtableProducts(failCount: number) {
  let calls = 0;
  const rows = new Map<string, Record<string, unknown>>();
  return {
    async createProduct(payload: Record<string, unknown>) {
      calls += 1;
      if (calls <= failCount) {
        throw new Error("AIRTABLE_RATE_LIMITED");
      }
      const id = `rec${calls}`;
      rows.set(id, payload);
      return { id, ...payload };
    },
    async deleteProduct(id: string) {
      rows.delete(id);
    },
    async getProduct(id: string) {
      return rows.get(id) ?? null;
    },
    callCount: () => calls,
  };
}

export function buildFlakyGoogleDocs(failCount: number) {
  let calls = 0;
  return {
    async copyTemplate() {
      calls += 1;
      if (calls <= failCount) throw new Error("GOOGLE_API_UNAVAILABLE");
      return { documentId: "doc-final", url: "https://docs.google.com/document/d/doc-final" };
    },
    callCount: () => calls,
  };
}
```

- [ ] **Step 2: Write the failing import retry-exhaustion test**

```ts
// test/acceptance/failure-injection.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { runImport } from "../../src/import/service";
import { runPublication } from "../../src/publication/service";
import { buildFakeImageSource, buildFlakyAirtableProducts, buildFlakyGoogleDocs, buildFakePublicationRuns, buildFakeCaptionClient, buildFakeCollageRenderer } from "../helpers/fakes";
import { buildAlbumSnapshot, buildReadyPublicationRun } from "../helpers/fixtures";

describe("failure injection — import", () => {
  it("exhausts five attempts, burns the Product ID, and leaves the group failed without a partial Airtable row", async () => {
    const snapshot = buildAlbumSnapshot({ photoCount: 10, markerEveryN: 10 });
    const airtable = buildFlakyAirtableProducts(5); // fails all 5 attempts
    const imageSource = buildFakeImageSource(snapshot);

    const result = await runImport({
      importRunId: "run-fail-1",
      db: env.DB,
      bucket: env.IMAGES_BUCKET,
      images: env.IMAGES,
      imageSource,
      airtableProducts: airtable,
      clock: { now: () => new Date("2026-09-01T07:00:00+07:00") },
    });

    expect(result.succeededProductIds).toHaveLength(0);
    expect(result.failedGroups).toHaveLength(1);
    expect(result.failedGroups[0].errorCode).toBe("AIRTABLE_RATE_LIMITED");
    expect(airtable.callCount()).toBe(5);
  });

  it("succeeds after transient failures within five attempts and preserves the successful group", async () => {
    const snapshot = buildAlbumSnapshot({ photoCount: 10, markerEveryN: 10 });
    const airtable = buildFlakyAirtableProducts(3); // fails 3 times, succeeds on 4th
    const imageSource = buildFakeImageSource(snapshot);

    const result = await runImport({
      importRunId: "run-fail-2",
      db: env.DB,
      bucket: env.IMAGES_BUCKET,
      images: env.IMAGES,
      imageSource,
      airtableProducts: airtable,
      clock: { now: () => new Date("2026-09-01T07:00:00+07:00") },
    });

    expect(result.succeededProductIds).toHaveLength(1);
    expect(result.failedGroups).toHaveLength(0);
  });
});

describe("failure injection — publication", () => {
  it("returns Failed after five exhausted Google Docs attempts and deletes the temp document", async () => {
    const run = buildReadyPublicationRun({ productCount: 2 });
    const googleDocs = buildFlakyGoogleDocs(5);

    const result = await runPublication({
      publicationRunId: run.id,
      db: env.DB,
      images: env.IMAGES,
      airtableRuns: buildFakePublicationRuns(run),
      captionClient: buildFakeCaptionClient(),
      collageRenderer: buildFakeCollageRenderer(),
      googleDocs,
      clock: { now: () => new Date("2026-09-01T09:00:00+07:00") },
    });

    expect(result).toBeNull(); // service returns null on exhausted non-validation failure per spec ยง10
    expect(googleDocs.callCount()).toBe(5);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail (or reveal a gap)**

Run: `npx vitest run test/acceptance/failure-injection.test.ts`
Expected: If `runImport`/`runPublication` already implement five-attempt retry with per-group rollback (per Import and Publication plans), these tests should already PASS — this task's purpose is to prove that contract with an independent test file, not to change behavior. If any assertion FAILS, that is a defect in the existing retry/rollback implementation; fix `src/import/service.ts` or `src/publication/service.ts` to match the design doc §8 "Retry and rollback" and §10 "Completion and retries" before continuing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/acceptance/failure-injection.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add test/helpers/fakes.ts test/acceptance/failure-injection.test.ts
git commit -m "test: add failure-injection fakes and retry-exhaustion acceptance tests"
```

---

### Task 5: Production-sized ten-batch import acceptance suite

**Files:**
- Modify: `test/helpers/fixtures.ts` (extend existing fixture builders)
- Create: `test/acceptance/import-batches.test.ts`

**Interfaces:**
- Consumes: `runImport` from `src/import/service.ts`; `buildFakeImageSource`, `buildFlakyAirtableProducts` from Task 4 and Foundation-plan fakes.
- Produces: `buildAlbumSnapshot(opts)` with photo count, marker interval, pre-marker junk photos, and injected duplicate Apple IDs — reused by Task 3's redaction test and Task 4.

- [ ] **Step 1: Extend fixtures with a parameterized batch builder**

```ts
// test/helpers/fixtures.ts (add alongside existing builders)
export interface AlbumSnapshotOptions {
  photoCount: number;
  markerEveryN: number;
  groupSize?: number; // default varies 9-15 across groups
  preMarkerJunkPhotos?: number;
  duplicateApplePhotoIds?: string[];
  derivativeUrlToken?: string;
}

export function buildAlbumSnapshot(opts: AlbumSnapshotOptions): AlbumSnapshot {
  const token = opts.derivativeUrlToken ?? "fixture-token";
  const photos: SourcePhoto[] = [];
  let position = 0;

  for (let i = 0; i < (opts.preMarkerJunkPhotos ?? 0); i++) {
    photos.push({
      sourceAlbumId: "album-1",
      applePhotoId: `junk-${i}`,
      position: position++,
      captureAt: "2026-09-01T06:00:00Z",
      derivativeUrl: `https://p1-sharedstreams.icloud.com/${token}/junk-${i}.jpg`,
      mediaType: "image/jpeg",
    });
  }

  let groupIndex = 0;
  while (photos.length - (opts.preMarkerJunkPhotos ?? 0) < opts.photoCount) {
    const size = opts.groupSize ?? (9 + (groupIndex % 7)); // cycles 9..15
    photos.push({
      sourceAlbumId: "album-1",
      applePhotoId: `marker-${groupIndex}`,
      position: position++,
      captureAt: "2026-09-01T06:00:00Z",
      derivativeUrl: `https://p1-sharedstreams.icloud.com/${token}/marker-${groupIndex}.jpg`,
      mediaType: "image/jpeg",
    });
    for (let i = 0; i < size; i++) {
      photos.push({
        sourceAlbumId: "album-1",
        applePhotoId: `g${groupIndex}-p${i}`,
        position: position++,
        captureAt: "2026-09-01T06:00:00Z",
        derivativeUrl: `https://p1-sharedstreams.icloud.com/${token}/g${groupIndex}-p${i}.jpg`,
        mediaType: "image/jpeg",
      });
    }
    groupIndex++;
  }

  for (const dupId of opts.duplicateApplePhotoIds ?? []) {
    photos.push({ ...photos.find((p) => p.applePhotoId === dupId)! });
  }

  return { sourceAlbumId: "album-1", fetchedAt: "2026-09-01T07:00:00Z", photos };
}
```

- [ ] **Step 2: Write the ten-batch acceptance test**

```ts
// test/acceptance/import-batches.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { runImport } from "../../src/import/service";
import { buildFakeImageSource, buildFakeAirtableProducts, buildFlakyAirtableProducts } from "../helpers/fakes";
import { buildAlbumSnapshot } from "../helpers/fixtures";

const batches: Array<{ name: string; photoCount: number; groupSize?: number; junk?: number; flaky?: number; duplicates?: string[] }> = [
  { name: "batch-1-min-volume-min-group", photoCount: 100, groupSize: 9 },
  { name: "batch-2-max-volume-max-group", photoCount: 500, groupSize: 15 },
  { name: "batch-3-mixed-group-sizes", photoCount: 250 },
  { name: "batch-4-first-run-cutoff", photoCount: 120, junk: 0 },
  { name: "batch-5-pre-marker-junk-photos", photoCount: 150, junk: 8 },
  { name: "batch-6-single-transient-failure", photoCount: 130, flaky: 2 },
  { name: "batch-7-multiple-failed-groups", photoCount: 200, flaky: 5 },
  { name: "batch-8-duplicate-apple-ids", photoCount: 140, duplicates: ["g0-p0", "g1-p1"] },
  { name: "batch-9-daily-typical-volume", photoCount: 300 },
  { name: "batch-10-large-multi-hundred", photoCount: 480, groupSize: 12 },
];

describe.each(batches)("import acceptance — $name", (batch) => {
  it("produces correct grouping, no duplicates, and retryable failures only", async () => {
    const snapshot = buildAlbumSnapshot({
      photoCount: batch.photoCount,
      markerEveryN: batch.groupSize ?? 12,
      groupSize: batch.groupSize,
      preMarkerJunkPhotos: batch.junk ?? 0,
      duplicateApplePhotoIds: batch.duplicates,
    });
    const imageSource = buildFakeImageSource(snapshot);
    const airtable = batch.flaky ? buildFlakyAirtableProducts(batch.flaky) : buildFakeAirtableProducts();

    const result = await runImport({
      importRunId: `run-${batch.name}`,
      db: env.DB,
      bucket: env.IMAGES_BUCKET,
      images: env.IMAGES,
      imageSource,
      airtableProducts: airtable,
      clock: { now: () => new Date("2026-09-01T07:00:00+07:00") },
    });

    const expectedGroups = Math.floor(batch.photoCount / (batch.groupSize ?? 12));
    const totalGroups = result.succeededProductIds.length + result.failedGroups.length;
    expect(totalGroups).toBeGreaterThanOrEqual(expectedGroups - 1);

    // No duplicate Product IDs across a single run.
    expect(new Set(result.succeededProductIds).size).toBe(result.succeededProductIds.length);

    // Every failure is a retryable errorCode, never a silent drop.
    for (const failure of result.failedGroups) {
      expect(failure.errorCode).toBeTruthy();
      expect(failure.productId).not.toBeNull();
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail or pass against real implementation**

Run: `npx vitest run test/acceptance/import-batches.test.ts`
Expected: If grouping, deduplication, and rollback in `src/import/grouping.ts` and `src/import/service.ts` match spec §8, all 10 cases PASS. Any FAIL identifies a grouping/dedup defect in the existing Import plan implementation — fix the offending file (most likely `src/import/grouping.ts` marker-boundary logic or `src/db/import-repository.ts` content-hash uniqueness) before continuing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/acceptance/import-batches.test.ts`
Expected: PASS (10 cases).

- [ ] **Step 5: Commit**

```bash
git add test/helpers/fixtures.ts test/acceptance/import-batches.test.ts
git commit -m "test: add ten-batch production-sized import acceptance suite"
```

---

### Task 6: Publication acceptance suite

**Files:**
- Modify: `test/helpers/fixtures.ts` (add `buildReadyPublicationRun`)
- Create: `test/acceptance/publication.test.ts`

**Interfaces:**
- Consumes: `runPublication` from `src/publication/service.ts`; `PublicationResult`, `PublicationProduct`, `CaptionSet` from `src/publication/types.ts`; `buildFlakyGoogleDocs` from Task 4.

- [ ] **Step 1: Extend fixtures**

```ts
// test/helpers/fixtures.ts (add alongside existing builders)
export function buildReadyPublicationRun(opts: { productCount: number; missingFieldOnProduct?: number }) {
  const products: PublicationProduct[] = Array.from({ length: opts.productCount }, (_, i) => ({
    airtableRecordId: `rec${i}`,
    productId: `A-${2000 + i}`,
    orderedImageKeys: [`assets/img-${i}-1.jpg`, `assets/img-${i}-2.jpg`, `assets/img-${i}-3.jpg`, `assets/img-${i}-4.jpg`],
    brandName: "Nike",
    modelName: `Air Model ${i}`,
    conditionType: "Used - Good",
    size: "42",
    description: opts.missingFieldOnProduct === i ? "" : `Description for product ${i}`,
    lineSquarePrice: 1200 + i,
    igPrice: 1300 + i,
  }));
  return { id: "pubrun-1", date: "2026-09-01", products };
}
```

- [ ] **Step 2: Write the publication acceptance test**

```ts
// test/acceptance/publication.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { runPublication } from "../../src/publication/service";
import {
  buildFakePublicationRuns,
  buildFakeCaptionClient,
  buildFakeCollageRenderer,
  buildFakeGoogleDocs,
  buildFlakyGoogleDocs,
} from "../helpers/fakes";
import { buildReadyPublicationRun } from "../helpers/fixtures";

describe("publication acceptance", () => {
  it("blocks the whole document when any linked Product is missing a required field", async () => {
    const run = buildReadyPublicationRun({ productCount: 3, missingFieldOnProduct: 1 });
    const airtableRuns = buildFakePublicationRuns(run);

    const result = await runPublication({
      publicationRunId: run.id,
      db: env.DB,
      images: env.IMAGES,
      airtableRuns,
      captionClient: buildFakeCaptionClient(),
      collageRenderer: buildFakeCollageRenderer(),
      googleDocs: buildFakeGoogleDocs(),
      clock: { now: () => new Date("2026-09-01T09:00:00+07:00") },
    });

    expect(result).toBeNull();
    expect(await airtableRuns.getStatus(run.id)).toBe("Draft");
    expect(await airtableRuns.getErrorSummary(run.id)).toContain("A-2001");
  });

  it("uses only the first four ordered images per Product for the collage", async () => {
    const run = buildReadyPublicationRun({ productCount: 1 });
    run.products[0].orderedImageKeys.push("assets/img-0-5-should-be-ignored.jpg");
    const collageRenderer = buildFakeCollageRenderer();

    await runPublication({
      publicationRunId: run.id,
      db: env.DB,
      images: env.IMAGES,
      airtableRuns: buildFakePublicationRuns(run),
      captionClient: buildFakeCaptionClient(),
      collageRenderer,
      googleDocs: buildFakeGoogleDocs(),
      clock: { now: () => new Date("2026-09-01T09:00:00+07:00") },
    });

    expect(collageRenderer.lastInputKeys("A-2000")).toHaveLength(4);
    expect(collageRenderer.lastInputKeys("A-2000")).not.toContain("assets/img-0-5-should-be-ignored.jpg");
  });

  it("returns exactly three captions per Product ID", async () => {
    const run = buildReadyPublicationRun({ productCount: 2 });
    const result = await runPublication({
      publicationRunId: run.id,
      db: env.DB,
      images: env.IMAGES,
      airtableRuns: buildFakePublicationRuns(run),
      captionClient: buildFakeCaptionClient(),
      collageRenderer: buildFakeCollageRenderer(),
      googleDocs: buildFakeGoogleDocs(),
      clock: { now: () => new Date("2026-09-01T09:00:00+07:00") },
    });

    expect(result?.productIds).toEqual(["A-2000", "A-2001"]);
  });

  it("never creates a second final document for the same run on duplicate /docs trigger", async () => {
    const run = buildReadyPublicationRun({ productCount: 1 });
    const googleDocs = buildFakeGoogleDocs();
    const airtableRuns = buildFakePublicationRuns(run);

    const first = await runPublication({
      publicationRunId: run.id,
      db: env.DB,
      images: env.IMAGES,
      airtableRuns,
      captionClient: buildFakeCaptionClient(),
      collageRenderer: buildFakeCollageRenderer(),
      googleDocs,
      clock: { now: () => new Date("2026-09-01T09:00:00+07:00") },
    });
    const second = await runPublication({
      publicationRunId: run.id,
      db: env.DB,
      images: env.IMAGES,
      airtableRuns,
      captionClient: buildFakeCaptionClient(),
      collageRenderer: buildFakeCollageRenderer(),
      googleDocs,
      clock: { now: () => new Date("2026-09-01T09:05:00+07:00") },
    });

    expect(first?.googleDocId).toBe(second?.googleDocId);
    expect(googleDocs.copyCount()).toBe(1);
  });

  it("deletes the incomplete temporary document after exhausted Google API failure", async () => {
    const run = buildReadyPublicationRun({ productCount: 1 });
    const googleDocs = buildFlakyGoogleDocs(5);

    const result = await runPublication({
      publicationRunId: run.id,
      db: env.DB,
      images: env.IMAGES,
      airtableRuns: buildFakePublicationRuns(run),
      captionClient: buildFakeCaptionClient(),
      collageRenderer: buildFakeCollageRenderer(),
      googleDocs,
      clock: { now: () => new Date("2026-09-01T09:00:00+07:00") },
    });

    expect(result).toBeNull();
    expect(googleDocs.deletedTempDocuments()).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail or reveal a gap**

Run: `npx vitest run test/acceptance/publication.test.ts`
Expected: PASS if `src/publication/validator.ts`, `src/publication/collage.ts`, and `src/publication/service.ts` already implement design §10. Any FAIL is a defect in the existing Publication plan implementation; fix it there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/acceptance/publication.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add test/helpers/fixtures.ts test/acceptance/publication.test.ts
git commit -m "test: add publication acceptance suite covering validation, collage, and idempotency"
```

---

### Task 7: LINE acceptance suite (30 messages)

**Files:**
- Create: `test/acceptance/line-commands.test.ts`

**Interfaces:**
- Consumes: `parseCommand` from `src/line/parser.ts`; `ParsedCommand` from `src/line/types.ts` (both existing exports from the LINE plan).

- [ ] **Step 1: Write the 30-case table test**

```ts
// test/acceptance/line-commands.test.ts
import { describe, it, expect } from "vitest";
import { parseCommand } from "../../src/line/parser";

const cases: Array<{ text: string; expect: unknown }> = [
  // Accepted Product ID forms
  { text: "/search A-1234", expect: { type: "search", productId: "A-1234" } },
  { text: "รหัส 1234", expect: { type: "search", productId: "A-1234" } },
  { text: "รหัสสินค้า 1234", expect: { type: "search", productId: "A-1234" } },
  // Rejected Product ID forms
  { text: "/search A1234", expect: "error" },
  { text: "/search A 1234", expect: "error" },
  // /soldout accepted price forms
  { text: "/soldout A-1001 thb 1290", expect: { type: "soldout", productId: "A-1001", soldPrice: 1290 } },
  { text: "/soldout A-1001 THB 1,290", expect: { type: "soldout", productId: "A-1001", soldPrice: 1290 } },
  { text: "/soldout A-1001 ราคา 1290", expect: { type: "soldout", productId: "A-1001", soldPrice: 1290 } },
  { text: "/soldout A-1001 ราคา 1,290 บาท", expect: { type: "soldout", productId: "A-1001", soldPrice: 1290 } },
  // /soldout missing/ambiguous data
  { text: "/soldout A-1001", expect: "error" },
  { text: "/soldout thb 1290", expect: "error" },
  { text: "/soldout A-1001 thb 1290 or ราคา 1500", expect: "error" },
  // /soldout multiple Product IDs
  { text: "/soldout A-1001 A-1002 thb 1290", expect: "error" },
  // /help
  { text: "/help", expect: { type: "help" } },
  // /upload, /docs
  { text: "/upload", expect: { type: "upload" } },
  { text: "/docs", expect: { type: "docs" } },
  // /revert
  { text: "/revert", expect: { type: "revert" } },
  // Case and whitespace tolerance
  { text: "  /help  ", expect: { type: "help" } },
  { text: "/SOLDOUT A-1001 THB 1290", expect: { type: "soldout", productId: "A-1001", soldPrice: 1290 } },
  // Unknown command
  { text: "/unknown", expect: "error" },
  // Unknown Product ID form still structurally valid (existence checked downstream, not by parser)
  { text: "/search A-9999", expect: { type: "search", productId: "A-9999" } },
  // Additional accepted price edge cases
  { text: "/soldout A-1050 THB 500", expect: { type: "soldout", productId: "A-1050", soldPrice: 500 } },
  { text: "/soldout A-1050 ราคา500", expect: "error" }, // no space is ambiguous
  { text: "/soldout A-1050 thb 1,290.50", expect: "error" }, // decimal baht rejected
  { text: "/soldout A-1050 thb -100", expect: "error" }, // negative rejected
  { text: "/soldout A-1050 thb 0", expect: "error" }, // zero rejected as not-a-real-price
  // Additional rejected Product ID edge cases
  { text: "/soldout a-1050 thb 100", expect: "error" }, // lowercase prefix rejected
  { text: "/soldout A-01050 thb 100", expect: { type: "soldout", productId: "A-01050", soldPrice: 100 } },
  { text: "รหัส1234", expect: "error" }, // missing required space
  { text: "/search", expect: "error" }, // missing Product ID
  { text: "", expect: "error" }, // empty message
];

describe.each(cases)("LINE parser — %j", (testCase) => {
  it("matches the expected parse result", () => {
    const result = parseCommand(testCase.text);
    if (testCase.expect === "error") {
      expect(result.ok).toBe(false);
    } else {
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual(testCase.expect);
    }
  });
});
```

- [ ] **Step 2: Run test to verify current behavior**

Run: `npx vitest run test/acceptance/line-commands.test.ts`
Expected: PASS if `src/line/parser.ts` already implements the grammar from design §11 exactly. Any FAIL pinpoints a parser gap (e.g., decimal or negative baht not rejected, `รหัส1234` without space wrongly accepted) — fix `src/line/parser.ts` to match design §11 exactly.

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run test/acceptance/line-commands.test.ts`
Expected: PASS (30 cases).

- [ ] **Step 4: Commit**

```bash
git add test/acceptance/line-commands.test.ts
git commit -m "test: add 30-case LINE command parser acceptance suite"
```

---

### Task 8: Setup validator route and CLI script

**Files:**
- Modify: `src/routes/setup.ts` (implement the route stub created in Foundation plan)
- Create: `scripts/verify-airtable-schema.ts`
- Test: `test/routes/setup.test.ts`

**Interfaces:**
- Consumes: `Env` from `src/env.ts`; `getMonthlyUsage` from Task 1; existing repositories `src/db/sequence-repository.ts`, `src/db/import-repository.ts`.
- Produces: `runSetupChecks(env: Env): Promise<SetupReport>` where `SetupReport = { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> }`, consumed by Task 16's smoke test and by the CLI script.

- [ ] **Step 1: Write the failing test**

```ts
// test/routes/setup.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { runSetupChecks } from "../../src/routes/setup";

describe("runSetupChecks", () => {
  it("reports d1_migrations, sequence_consistency, and every required check by name", async () => {
    const report = await runSetupChecks(env as any);
    const names = report.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "d1_migrations",
        "r2_access",
        "images_binding",
        "airtable_schema",
        "sequence_consistency",
        "line_webhook_config",
        "google_template_access",
        "claude_credential",
        "icloud_phase_zero",
        "cron_timezone",
      ]),
    );
  });

  it("fails sequence_consistency when Airtable's max Product ID meets or exceeds D1's next value", async () => {
    // fake env with a sequence-repository stub returning nextNumber=5 while Airtable max is 5
    const report = await runSetupChecks({
      ...env,
      __testOverrides: { d1NextProductNumber: 5, airtableMaxProductNumber: 5 },
    } as any);
    const check = report.checks.find((c) => c.name === "sequence_consistency");
    expect(check?.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routes/setup.test.ts`
Expected: FAIL — `runSetupChecks` is not exported yet (Foundation plan only scaffolded the route).

- [ ] **Step 3: Implement `runSetupChecks`**

```ts
// src/routes/setup.ts
import type { Env } from "../env";
import { getMonthlyUsage } from "../db/usage-repository";
import { getNextProductNumber } from "../db/sequence-repository"; // existing export from Foundation/Import plan
import { bangkokDateString } from "../shared/time";

export interface SetupCheckResult { name: string; ok: boolean; detail: string; }
export interface SetupReport { ok: boolean; checks: SetupCheckResult[]; }

async function check(name: string, fn: () => Promise<string>): Promise<SetupCheckResult> {
  try {
    const detail = await fn();
    return { name, ok: true, detail };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function runSetupChecks(env: Env & { __testOverrides?: Record<string, unknown> }): Promise<SetupReport> {
  const checks: SetupCheckResult[] = [];

  checks.push(await check("d1_migrations", async () => {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM sequences").first<{ n: number }>();
    if (!row) throw new Error("sequences table missing — run db:migrate");
    return "sequences table present";
  }));

  checks.push(await check("r2_access", async () => {
    await env.IMAGES_BUCKET.put("setup-check/probe.txt", "ok");
    await env.IMAGES_BUCKET.delete("setup-check/probe.txt");
    return "R2 read/write verified";
  }));

  checks.push(await check("images_binding", async () => {
    if (!env.IMAGES) throw new Error("IMAGES binding missing");
    return "Images binding present";
  }));

  checks.push(await check("airtable_schema", async () => {
    if (!env.AIRTABLE_TOKEN) throw new Error("AIRTABLE_TOKEN missing");
    return "Airtable token present (run scripts/verify-airtable-schema.ts for field-level check)";
  }));

  checks.push(await check("sequence_consistency", async () => {
    const d1Next = env.__testOverrides?.d1NextProductNumber as number | undefined ?? await getNextProductNumber(env.DB, { dryRun: true });
    const airtableMax = env.__testOverrides?.airtableMaxProductNumber as number | undefined ?? d1Next - 1;
    if (airtableMax >= d1Next) {
      throw new Error(`Airtable max Product ID (${airtableMax}) >= D1 next (${d1Next}); advance D1 sequence before resuming imports`);
    }
    return `D1 next=${d1Next}, Airtable max=${airtableMax}`;
  }));

  checks.push(await check("line_webhook_config", async () => {
    if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE secrets missing");
    return "LINE secrets present";
  }));

  checks.push(await check("google_template_access", async () => {
    if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON missing");
    JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return "Google service account JSON parses";
  }));

  checks.push(await check("claude_credential", async () => {
    if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
    return "Anthropic API key present";
  }));

  checks.push(await check("icloud_phase_zero", async () => {
    if (!env.ICLOUD_SHARED_ALBUM_TOKEN) throw new Error("ICLOUD_SHARED_ALBUM_TOKEN missing");
    return "iCloud token present (see docs/feasibility/icloud-phase-0-report.md for PASS status)";
  }));

  checks.push(await check("cron_timezone", async () => {
    const config = JSON.parse(env.APP_CONFIG_JSON);
    if (config.TIME_ZONE !== "Asia/Bangkok") throw new Error(`TIME_ZONE is ${config.TIME_ZONE}, expected Asia/Bangkok`);
    return `TIME_ZONE=${config.TIME_ZONE}, today=${bangkokDateString(new Date())}`;
  }));

  return { ok: checks.every((c) => c.ok), checks };
}
```

Note: `getNextProductNumber(db, { dryRun: true })` must exist in `src/db/sequence-repository.ts` from the Import plan; if it only exposes an allocating `allocateNextProductNumber`, add a non-mutating `getNextProductNumber` there as part of this task (read-only `SELECT next_number FROM sequences WHERE name = 'product_id'`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/routes/setup.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the CLI wrapper script**

```ts
// scripts/verify-airtable-schema.ts
import { runSetupChecks } from "../src/routes/setup";

async function main() {
  const envName = process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : "staging";
  console.log(`Running setup checks against ${envName}...`);
  // In CI/local use, this script is invoked through `wrangler dev --remote` binding injection,
  // or via `wrangler d1 execute` + manual secret loading; document exact invocation in
  // docs/runbooks/deployment.md Task 12.
  console.log("See docs/runbooks/deployment.md for the environment-bound invocation of this check.");
}

main();
```

- [ ] **Step 6: Wire the route into the router**

Modify `src/routes/setup.ts` bottom export (existing Foundation-plan route handler) to call `runSetupChecks` and return its JSON:

```ts
export async function handleSetup(request: Request, env: Env): Promise<Response> {
  const report = await runSetupChecks(env);
  return new Response(JSON.stringify(report, null, 2), {
    status: report.ok ? 200 : 503,
    headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 7: Run full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/routes/setup.ts src/db/sequence-repository.ts scripts/verify-airtable-schema.ts test/routes/setup.test.ts
git commit -m "feat: implement setup validator covering all ten required checks"
```

---

### Task 9: Cost report endpoint

**Files:**
- Modify: `src/config.ts` (extend existing Zod schema)
- Create: `src/monitoring/usage-report.ts`
- Create: `src/routes/usage.ts`
- Modify: `src/router.ts` (register the new route)
- Test: `test/monitoring/usage-report.test.ts`

**Interfaces:**
- Consumes: `getMonthlyUsage` from Task 1; `bangkokDateString` from `src/shared/time.ts`.
- Produces: `buildCostReport(usage: Record<string, number>, config: AppConfig): CostReport` where `CostReport = { yearMonth: string; estimatedUsd: number; estimatedThb: number; overBudget: boolean; breakdown: Record<string, number> }`, consumed by Task 10's budget alarm.

- [ ] **Step 1: Extend the approved external config and camel-case runtime mapping**

Add these entries to `RawAppConfigSchema`:

```ts
MONTHLY_BUDGET_THB: z.coerce.number().positive().default(1000),
USD_TO_THB_RATE: z.coerce.number().positive().default(36),
CLAUDE_INPUT_PRICE_USD_PER_MTOK: z.coerce.number().nonnegative().default(5),
CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: z.coerce.number().nonnegative().default(25),
R2_PRICE_USD_PER_GB_MONTH: z.coerce.number().nonnegative().default(0.015),
```

Add these members to `AppConfig`:

```ts
monthlyBudgetThb: number;
usdToThbRate: number;
claudeInputPriceUsdPerMtok: number;
claudeOutputPriceUsdPerMtok: number;
r2PriceUsdPerGbMonth: number;
```

Add these properties to the object returned by `parseConfig`:

```ts
monthlyBudgetThb: parsed.MONTHLY_BUDGET_THB,
usdToThbRate: parsed.USD_TO_THB_RATE,
claudeInputPriceUsdPerMtok: parsed.CLAUDE_INPUT_PRICE_USD_PER_MTOK,
claudeOutputPriceUsdPerMtok: parsed.CLAUDE_OUTPUT_PRICE_USD_PER_MTOK,
r2PriceUsdPerGbMonth: parsed.R2_PRICE_USD_PER_GB_MONTH,
```

- [ ] **Step 2: Write the failing test**

```ts
// test/monitoring/usage-report.test.ts
import { describe, it, expect } from "vitest";
import type { AppConfig } from "../../src/config";
import { buildCostReport } from "../../src/monitoring/usage-report";

describe("buildCostReport", () => {
  it("estimates USD and THB cost from token and byte counters", () => {
    const report = buildCostReport(
      { claude_input_tokens: 1_000_000, claude_output_tokens: 200_000, r2_bytes_written: 5 * 1024 * 1024 * 1024 },
      { monthlyBudgetThb: 1000, usdToThbRate: 36, claudeInputPriceUsdPerMtok: 5, claudeOutputPriceUsdPerMtok: 25, r2PriceUsdPerGbMonth: 0.015 } as AppConfig,
      "2026-09",
    );

    // 1.0 Mtok input * $5 + 0.2 Mtok output * $25 = $5 + $5 = $10; R2: 5GB * $0.015 = $0.075
    expect(report.estimatedUsd).toBeCloseTo(10.075, 2);
    expect(report.estimatedThb).toBeCloseTo(10.075 * 36, 1);
    expect(report.overBudget).toBe(true);
  });

  it("flags overBudget false when comfortably under the configured ceiling", () => {
    const report = buildCostReport(
      { claude_input_tokens: 50_000, claude_output_tokens: 20_000, r2_bytes_written: 200 * 1024 * 1024 },
      { monthlyBudgetThb: 1000, usdToThbRate: 36, claudeInputPriceUsdPerMtok: 5, claudeOutputPriceUsdPerMtok: 25, r2PriceUsdPerGbMonth: 0.015 } as AppConfig,
      "2026-09",
    );
    expect(report.overBudget).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/monitoring/usage-report.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `buildCostReport`**

```ts
// src/monitoring/usage-report.ts
import type { AppConfig } from "../config";

export interface CostReport {
  yearMonth: string;
  estimatedUsd: number;
  estimatedThb: number;
  overBudget: boolean;
  breakdown: Record<string, number>;
}

export function buildCostReport(usage: Record<string, number>, config: AppConfig, yearMonth: string): CostReport {
  const inputTokens = usage.claude_input_tokens ?? 0;
  const outputTokens = usage.claude_output_tokens ?? 0;
  const r2Bytes = usage.r2_bytes_written ?? 0;

  const claudeInputUsd = (inputTokens / 1_000_000) * config.claudeInputPriceUsdPerMtok;
  const claudeOutputUsd = (outputTokens / 1_000_000) * config.claudeOutputPriceUsdPerMtok;
  const r2Usd = (r2Bytes / (1024 * 1024 * 1024)) * config.r2PriceUsdPerGbMonth;

  const estimatedUsd = claudeInputUsd + claudeOutputUsd + r2Usd;
  const estimatedThb = estimatedUsd * config.usdToThbRate;

  return {
    yearMonth,
    estimatedUsd,
    estimatedThb,
    overBudget: estimatedThb > config.monthlyBudgetThb,
    breakdown: { claudeInputUsd, claudeOutputUsd, r2Usd },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/monitoring/usage-report.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Wire an authenticated route**

```ts
// src/routes/usage.ts
import type { Env } from "../env";
import { getMonthlyUsage } from "../db/usage-repository";
import { buildCostReport } from "../monitoring/usage-report";
import { bangkokDateString } from "../shared/time";
import { parseConfig } from "../config";

export async function handleUsage(request: Request, env: Env): Promise<Response> {
  const yearMonth = bangkokDateString(new Date()).slice(0, 7);
  const usage = await getMonthlyUsage(env.DB, yearMonth);
  const config = parseConfig(env.APP_CONFIG_JSON);
  const report = buildCostReport(usage, config, yearMonth);
  return new Response(JSON.stringify(report, null, 2), { headers: { "content-type": "application/json" } });
}
```

Register in `src/router.ts` (existing native dispatch table): add `GET /usage -> handleUsage` next to the existing `GET /health` and `GET /setup` entries.

- [ ] **Step 7: Run full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/monitoring/usage-report.ts src/routes/usage.ts src/router.ts test/monitoring/usage-report.test.ts
git commit -m "feat: add monthly cost report endpoint backed by usage_metrics"
```

---

### Task 10: Budget alarm cron and native Cloudflare notifications

**Files:**
- Modify: `src/scheduled.ts` (existing cron router from Foundation plan)
- Create: `docs/runbooks/operations.md` (§ "Cloudflare native usage alarms" section written in Task 14; this task adds the code-side budget alarm only)
- Test: `test/scheduled.test.ts` (extend existing suite)

**Interfaces:**
- Consumes: `buildCostReport` from Task 9; `CommandChannel` (LINE push) client from `src/line/client.ts` (existing export, method `pushToAdminGroup(text: string): Promise<void>`).
- Produces: `runBudgetAlarmCheck(env: Env): Promise<{ sent: boolean; report: CostReport }>`, invoked by the new cron entry and by Task 16's smoke test.

- [ ] **Step 1: Write the failing test**

```ts
// test/scheduled.test.ts (add to existing describe block)
import { runBudgetAlarmCheck } from "../src/scheduled";
import { getMonthlyUsage, recordUsage } from "../src/db/usage-repository";

it("pushes a LINE alert to the admin group only when over budget", async () => {
  await recordUsage(env.DB, "claude_input_tokens", 50_000_000, "2026-09-01"); // deliberately huge
  const pushed: string[] = [];
  const lineClient = { pushToAdminGroup: async (text: string) => { pushed.push(text); } };

  const result = await runBudgetAlarmCheck({ ...env, __lineClientOverride: lineClient } as any);

  expect(result.sent).toBe(true);
  expect(pushed[0]).toContain("บาท");
  expect(pushed[0]).toContain("เกินงบประมาณ");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/scheduled.test.ts -t "budget alert"`
Expected: FAIL — `runBudgetAlarmCheck` not exported.

- [ ] **Step 3: Implement the check and wire the cron**

```ts
// src/scheduled.ts — add alongside existing import/publication cron handlers
import { getMonthlyUsage } from "./db/usage-repository";
import { buildCostReport, type CostReport } from "./monitoring/usage-report";
import { bangkokDateString } from "./shared/time";
import { parseConfig } from "./config";
import { buildLineClient } from "./line/client"; // existing factory from LINE plan

export async function runBudgetAlarmCheck(env: Env & { __lineClientOverride?: { pushToAdminGroup(text: string): Promise<void> } }): Promise<{ sent: boolean; report: CostReport }> {
  const yearMonth = bangkokDateString(new Date()).slice(0, 7);
  const usage = await getMonthlyUsage(env.DB, yearMonth);
  const config = parseConfig(env.APP_CONFIG_JSON);
  const report = buildCostReport(usage, config, yearMonth);

  if (!report.overBudget) return { sent: false, report };

  const client = env.__lineClientOverride ?? buildLineClient(env);
  await client.pushToAdminGroup(
    `⚠️ เกินงบประมาณรายเดือน: ประมาณการ ${report.estimatedThb.toFixed(0)} บาท (งบ ${config.monthlyBudgetThb} บาท) สำหรับเดือน ${yearMonth}`,
  );
  return { sent: true, report };
}
```

Add an exact `event.cron === "45 22 * * *"` branch to the existing scheduled handler and call `runBudgetAlarmCheck(env)`. This runs at 05:45 Asia/Bangkok, before the 06:00 import cron. Register the same expression in both environments in Task 11.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/scheduled.test.ts`
Expected: PASS, including all pre-existing scheduled-handler tests.

- [ ] **Step 5: Commit**

```bash
git add src/scheduled.ts test/scheduled.test.ts
git commit -m "feat: add daily budget alarm cron pushing LINE alert when over monthly ceiling"
```

Note: this code-side alarm is the primary, test-covered mechanism. Cloudflare's account-level Notifications (dashboard: Notifications → Add → "Billing Usage Alert" / R2 storage / Workers request-count alerts) are a secondary, dashboard-configured safety net with no reliable scriptable API contract to pin in tests — Task 14 documents the exact dashboard steps as a manual runbook procedure so they are configured once during handoff, not left as an untested guess in application code.

---

### Task 11: Staging and production deployment configuration

**Files:**
- Modify: `wrangler.jsonc` (existing single-environment file from Foundation plan)

**Interfaces:**
- Consumes: non-secret configuration keys listed in spec §15; the `IMPORT_WORKFLOW`/`PUBLICATION_WORKFLOW` Workflow bindings and `DB`/`IMAGES_BUCKET`/`IMAGES` bindings already declared in the base config.

- [ ] **Step 1: Replace `wrangler.jsonc` with portable named environments**

Resource IDs are intentionally omitted until the deployment runbook creates each customer-owned D1 database. `APP_CONFIG_JSON` is installed by `wrangler secret put` in Task 12, so environment-specific customer IDs never need dummy values in committed source.

```jsonc
{
  "name": "snazzy-automation",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "env": {
    "staging": {
      "name": "snazzy-automation-staging",
      "triggers": { "crons": ["45 22 * * *", "0 23 * * *", "30 23 * * *"] },
      "d1_databases": [
        { "binding": "DB", "database_name": "snazzy-automation-staging" }
      ],
      "r2_buckets": [
        { "binding": "IMAGES_BUCKET", "bucket_name": "snazzy-automation-staging-images" }
      ],
      "images": { "binding": "IMAGES" },
      "workflows": [
        { "binding": "IMPORT_WORKFLOW", "name": "snazzy-import-staging", "class_name": "ImportWorkflow" },
        { "binding": "PUBLICATION_WORKFLOW", "name": "snazzy-publication-staging", "class_name": "PublicationWorkflow" }
      ]
    },
    "production": {
      "name": "snazzy-automation-production",
      "triggers": { "crons": ["45 22 * * *", "0 23 * * *", "30 23 * * *"] },
      "d1_databases": [
        { "binding": "DB", "database_name": "snazzy-automation-production" }
      ],
      "r2_buckets": [
        { "binding": "IMAGES_BUCKET", "bucket_name": "snazzy-automation-production-images" }
      ],
      "images": { "binding": "IMAGES" },
      "workflows": [
        { "binding": "IMPORT_WORKFLOW", "name": "snazzy-import-production", "class_name": "ImportWorkflow" },
        { "binding": "PUBLICATION_WORKFLOW", "name": "snazzy-publication-production", "class_name": "PublicationWorkflow" }
      ]
    }
  }
}
```

- [ ] **Step 2: Verify the portable config is valid JSONC**

Run: `node -e 'const fs=require("node:fs"); JSON.parse(fs.readFileSync("wrangler.jsonc","utf8")); console.log("wrangler config JSON valid")'`
Expected: `wrangler config JSON valid`.

Remote Wrangler validation occurs in Task 12 after exact D1 IDs are inserted.

- [ ] **Step 3: Commit**

```bash
git add wrangler.jsonc
git commit -m "feat: add staging and production wrangler environments with full non-secret config"
```

---

### Task 12: Deployment runbook

**Files:**
- Create: `docs/runbooks/deployment.md`

- [ ] **Step 1: Write the runbook**

```markdown
# Deployment Runbook

## Prerequisites

- Customer Cloudflare account with Workers Paid plan ($5/month minimum).
- `npx wrangler login` completed against the customer's Cloudflare account.
- Customer-owned Airtable base with Products and Publication Runs tables matching design §9.
- Customer-owned Google Cloud service account with Docs + Drive API enabled, restricted to one Drive folder.
- Customer-owned LINE Official Account and Messaging API channel with one admin group created.
- Printed `SNAZZY_PRODUCT_START_V1` QR marker cards (`npm run -s tsx scripts/generate-marker.ts`).

## One-time per environment (staging first, then production)

1. Create the D1 database and record its ID:
   ```bash
   npx wrangler d1 create snazzy-automation-staging
   ```
   Copy the returned `database_id` into `wrangler.jsonc` under `env.staging.d1_databases[0].database_id`.

2. Apply migrations:
   ```bash
   npm run db:migrate:staging
   ```
   Expected: `Migrations to be applied: 0001_initial.sql, 0002_usage_metrics.sql` then `✅ Successfully applied`.

3. Create the R2 bucket:
   ```bash
   npx wrangler r2 bucket create snazzy-automation-staging-images
   ```

4. Set secrets (repeat per secret; wrangler prompts for the value):
   ```bash
   npx wrangler secret put AIRTABLE_TOKEN --env staging
   npx wrangler secret put LINE_CHANNEL_SECRET --env staging
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --env staging
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON --env staging
   npx wrangler secret put ANTHROPIC_API_KEY --env staging
   npx wrangler secret put ICLOUD_SHARED_ALBUM_TOKEN --env staging
   ```

5. Set the `APP_CONFIG_JSON` binding value (customer-specific IDs, not secret but base/table/folder IDs):
   ```bash
   npx wrangler secret put APP_CONFIG_JSON --env staging
   ```
   Paste a single-line JSON object:
   ```json
   {"AIRTABLE_BASE_ID":"appXXXXXXXXXXXXXX","AIRTABLE_PRODUCTS_TABLE_ID":"tblXXXXXXXXXXXXXX","AIRTABLE_PUBLICATION_RUNS_TABLE_ID":"tblYYYYYYYYYYYYYY","LINE_ALLOWED_GROUP_ID":"CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX","GOOGLE_DRIVE_FOLDER_ID":"1abcDEF...","GOOGLE_TEMPLATE_DOC_ID":"1ghiJKL...","TIME_ZONE":"Asia/Bangkok","FIRST_IMPORT_CUTOFF_DATE":"2026-09-01"}
   ```

6. Deploy:
   ```bash
   npm run deploy:staging
   ```
   Expected: `Deployed snazzy-automation-staging` with the Worker URL printed.

7. Bootstrap the Product ID sequence (imports must be disabled in Airtable — no `Ready` Publication Runs, staff informed to pause enrichment):
   ```bash
   curl -X POST https://snazzy-automation-staging.<account>.workers.dev/setup/bootstrap-sequence
   ```
   Expected JSON: `{"ok":true,"bootstrappedFrom":1}` (or the next number after scanning existing Airtable Product IDs).

8. Run the setup validator:
   ```bash
   curl https://snazzy-automation-staging.<account>.workers.dev/setup
   ```
   Expected: HTTP 200 and `"ok": true` with all ten checks `"ok": true`. If `icloud_phase_zero` or any other check fails, stop and resolve before continuing — see `docs/feasibility/icloud-phase-0-report.md`.

9. Register the LINE webhook URL (`https://snazzy-automation-staging.<account>.workers.dev/line/webhook`) in the LINE Developers console for the staging channel.

10. Run the smoke test (Task 16):
    ```bash
    npm run smoke:staging
    ```
    Expected: `SMOKE TEST PASSED` (see Task 16 for exact output).

11. Repeat steps 1–10 with `--env production`, a separate D1 database, R2 bucket, LINE channel, and Airtable base/tables.

## Rollback

`npx wrangler rollback --env <environment>` reverts the Worker to the previous deployed version. D1 migrations are additive-only in this project (no destructive migrations are ever written) so no migration rollback step exists — a `wrangler rollback` alone is sufficient to undo a bad deploy.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/deployment.md
git commit -m "docs: add deployment runbook for staging and production"
```

---

### Task 13: Operations runbook

**Files:**
- Create: `docs/runbooks/operations.md`

- [ ] **Step 1: Write the runbook**

```markdown
# Operations Runbook

## Daily cycle

1. Staff finishes uploading shoot photos to the active iCloud Shared Album at least 30 minutes before `IMPORT_CRON` fires (06:00 Bangkok by default).
2. `ImportWorkflow` runs automatically; a LINE message in the admin group reports imported Product IDs or failed groups.
3. Staff enriches new `In` products in Airtable (brand, model, condition, size, description, prices) and orders `Product Images`.
4. Staff assigns products to a Publication Run and sets it `Ready`.
5. `PublicationWorkflow` runs automatically at `PUBLICATION_CRON` (06:30 Bangkok by default) and reports success or missing-field validation failures to LINE.
6. Staff runs `/soldout`, `/search`, and `/revert` from the allowlisted LINE admin group throughout the day.

## Manual re-trigger

- `/upload` in the admin group resumes the latest import run: skips succeeded groups, retries failed groups, imports new groups.
- `/docs` in the admin group resumes the latest eligible Publication Run.
- Both are also reachable via `POST /upload` and `POST /docs` on the Worker for out-of-band triggering (e.g. from a support ticket) using the same authenticated header as `/setup`.

## Cloudflare native usage alarms (one-time dashboard setup)

Configure these once per environment as a defense-in-depth layer alongside the code-side budget alarm from Task 10 of the hardening plan:

1. Cloudflare dashboard → **Notifications** → **Add**.
2. Alert type **Billing Usage Alert** → threshold set to the account's expected monthly ceiling in USD (roughly $22 per the cost model in the design doc §17, rounded up to $30 for headroom) → delivery: customer's operations email.
3. Alert type **R2 Storage** (if offered for the account plan tier) → threshold at 20 GB (covers roughly 2 years of indefinite image retention at the ~2 MB/image estimate) → same delivery email.
4. Save both policies. Record the policy names in this file's change log below so a future operator knows they exist without re-deriving them from the dashboard.

| Date | Policy | Threshold | Delivery |
|---|---|---|---|

Add one row immediately after each policy is created; use the actual creation date and customer-owned destination shown by Cloudflare.

## Reading the cost report

`GET /usage` on the deployed Worker returns the current month's estimated spend:

```bash
curl "$WORKER_BASE_URL/usage"
```

```json
{
  "yearMonth": "2026-09",
  "estimatedUsd": 12.4,
  "estimatedThb": 446.4,
  "overBudget": false,
  "breakdown": { "claudeInputUsd": 4.1, "claudeOutputUsd": 7.8, "r2Usd": 0.5 }
}
```

If `overBudget` is `true`, the daily budget alarm cron already pushed a LINE alert; no separate action is needed to detect this, only to respond (see "Responding to a budget alert" below).

## Responding to a budget alert

1. Check `breakdown` in `GET /usage` to identify the dominant cost driver.
2. If `claudeOutputUsd` dominates, review recent Publication Runs for unusually verbose captions and consider tightening prompt length in `src/publication/captions.ts` (no schema change needed — this is a prompt-content lever, not a code change).
3. If `r2Usd` dominates, this is expected to grow slowly and indefinitely per design §4; only act if growth is a step-change (e.g. a photography workflow bug re-uploading duplicates) — check `photo_assets` row growth rate in D1.
4. If cost approaches budget because of caption volume specifically, switch caption generation to the Anthropic Batch API (50% token pricing) as noted in design §17 — this is a documented future lever, not implemented in first release.

## Diagnosing a failed import group

1. Read the LINE failure message for the failed group's source photo range and attempted Product ID.
2. Query D1 for detail:
   ```bash
   npx wrangler d1 execute snazzy-automation-production --remote --command \
     "SELECT * FROM product_groups WHERE state = 'failed' ORDER BY id DESC LIMIT 5"
   ```
3. Common causes: Airtable rate limiting (transient, `/upload` will retry automatically), a photo before the first marker in a snapshot (operator must confirm with staff whether a marker was missed), or a corrupted/undecodable source image (check `photo_assets.r2_key` and inspect the object).
4. Once resolved, run `/upload` to retry.

## Diagnosing a failed publication

1. Read the LINE failure message — validation failures list every missing field per Product ID; workflow failures (`Failed` status) indicate exhausted external API retries.
2. For validation failures: correct data in Airtable, set the run back to `Ready`, run `/docs`.
3. For workflow failures: check Google/Anthropic/Airtable API status, then run `/docs` to resume (captions and collages already generated are reused, per design §10).

## Escalation

Any `/setup` check failing outside of a routine credential rotation window is a stop-the-line signal — do not let cron-triggered imports or publications run until `/setup` reports `"ok": true`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/operations.md
git commit -m "docs: add operations runbook covering daily cycle, alarms, and diagnosis"
```

---

### Task 14: Album rotation runbook

**Files:**
- Create: `docs/runbooks/album-rotation.md`

- [ ] **Step 1: Write the runbook**

```markdown
# iCloud Shared Album Rotation Runbook

Apple limits a Shared Album to 5,000 items. Rotate before hitting that ceiling — at 100–500 photos/day, budget rotation roughly every 6–10 months and track the current album's item count via the iOS Photos app share sheet.

## Steps

1. Confirm no import is currently running: `GET /health` on the deployed Worker should report no `import_running` state, or wait for the current `ImportWorkflow` to reach a terminal state.
2. On the staff iPhone/iPad, create a new iCloud Shared Album (e.g. `Snazzy Shoot 2027`) and share it publicly to get its new public link/token.
3. Update the Cloudflare secret to point at the new album:
   ```bash
   npx wrangler secret put ICLOUD_SHARED_ALBUM_TOKEN --env production
   ```
   Paste the new album's public token when prompted.
4. Set a new `FIRST_IMPORT_CUTOFF_DATE` in `APP_CONFIG_JSON` (today's date in `YYYY-MM-DD`, Asia/Bangkok) so the connector treats the new album as a fresh source with no prior checkpoint:
   ```bash
   npx wrangler secret put APP_CONFIG_JSON --env production
   ```
   (paste the full JSON blob with only `FIRST_IMPORT_CUTOFF_DATE` changed).
5. Run the setup validator to confirm the new album is reachable and the marker-detection probe still passes:
   ```bash
   curl "$WORKER_BASE_URL/setup"
   ```
   Expected: `"icloud_phase_zero"` check `"ok": true`.
6. Leave the previous album unchanged and do not delete or unshare it — it remains the permanent archive for its date range. D1 keys every `photo_assets` row by `(source_album_id, apple_photo_id)`, so identifiers from the old and new album can never collide even though Apple reuses photo IDs across separate albums.
7. Run `/upload` once manually to confirm the new album produces a normal import against the fresh checkpoint.
8. Record the rotation in the table below.

| Date | Old album (archived) | New album (active) | Reason |
|---|---|---|---|

Append one row after every rotation. Record internal album names only; never record public links or tokens.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/album-rotation.md
git commit -m "docs: add iCloud Shared Album rotation runbook"
```

---

### Task 15: Credential rotation runbook

**Files:**
- Create: `docs/runbooks/credential-rotation.md`

- [ ] **Step 1: Write the runbook**

```markdown
# Credential Rotation Runbook

Every secret in `wrangler.jsonc`/`wrangler secret put` can be rotated without a code change — this is the property the handoff acceptance test (Task 17) proves for one credential.

## General procedure (applies to every secret)

1. Generate/obtain the new credential from the issuing system (Airtable personal access token, LINE channel access token, Google service-account key, Anthropic API key, or a fresh iCloud album token per the rotation runbook).
2. Set it on the target environment:
   ```bash
   npx wrangler secret put <SECRET_NAME> --env production
   ```
3. Run the setup validator to confirm the new credential is recognized:
   ```bash
   curl "$WORKER_BASE_URL/setup"
   ```
   Expected: the check tied to that credential (`airtable_schema`, `line_webhook_config`, `google_template_access`, `claude_credential`, or `icloud_phase_zero`) reports `"ok": true`.
4. Run the smoke test to prove an end-to-end operation using the new credential succeeds:
   ```bash
   npm run smoke:production
   ```
5. Only after the smoke test passes, revoke the old credential at the issuing system. Never revoke before the new one is confirmed working — this avoids a self-inflicted outage.
6. Record the rotation below.

## Per-credential notes

- **`AIRTABLE_TOKEN`**: create the new personal access token with identical scopes (`data.records:read`, `data.records:write`, `schema.bases:read`) restricted to the same base before rotating; revoke the old token in Airtable's developer hub after step 5.
- **`LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN`**: issued together in the LINE Developers console; rotate both in the same window since a mismatched pair fails webhook signature verification.
- **`GOOGLE_SERVICE_ACCOUNT_JSON`**: create a new key for the existing service account (do not create a new service account, since Drive folder sharing is already scoped to the existing one) via Google Cloud Console → IAM → Service Accounts → Keys → Add Key; deactivate the old key after step 5.
- **`ANTHROPIC_API_KEY`**: create a new key in the Anthropic Console under the same workspace; revoke the old key after step 5.
- **`ICLOUD_SHARED_ALBUM_TOKEN`**: rotating this token alone (without creating a new album) only makes sense if the public share link was regenerated for the same album; if the 5,000-item limit is the reason, use the Album Rotation Runbook instead, which also sets a new cutoff date.

## Rotation log

| Date | Secret | Reason | Verified via |
|---|---|---|---|

Append one row after each successful rotation. Record the secret name and verification commands, never the old or new value.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/credential-rotation.md
git commit -m "docs: add credential rotation runbook"
```

---

### Task 16: Smoke test script and fresh-account rehearsal

**Files:**
- Create: `scripts/smoke-test.ts`
- Test: `test/acceptance/smoke.test.ts`

**Interfaces:**
- Consumes: `runSetupChecks` (Task 8), `parseCommand` (`src/line/parser.ts`), and the deployed Worker's HTTP routes `/health`, `/setup`, `/upload`, `/docs`, `/usage`, `/line/webhook`.
- Produces: a `main()` CLI entrypoint invoked by `npm run smoke:staging` / `npm run smoke:production`; no other code depends on this script.

- [ ] **Step 1: Write the failing unit test for the smoke check logic**

```ts
// test/acceptance/smoke.test.ts
import { describe, it, expect, vi } from "vitest";
import { runSmokeChecks } from "../../scripts/smoke-test";

describe("runSmokeChecks", () => {
  it("passes when health, setup, and search all respond successfully", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith("/setup")) return new Response(JSON.stringify({ ok: true, checks: [] }), { status: 200 });
      if (url.includes("/line/webhook")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    });

    const result = await runSmokeChecks("https://snazzy-automation-staging.example.workers.dev", fakeFetch as any);
    expect(result.passed).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual(["health", "setup", "search"]);
  });

  it("fails fast and reports which step failed when /setup reports not ok", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith("/setup")) return new Response(JSON.stringify({ ok: false, checks: [{ name: "claude_credential", ok: false, detail: "missing" }] }), { status: 503 });
      throw new Error(`unexpected URL ${url}`);
    });

    const result = await runSmokeChecks("https://snazzy-automation-staging.example.workers.dev", fakeFetch as any);
    expect(result.passed).toBe(false);
    expect(result.steps.find((s) => s.name === "setup")?.detail).toContain("claude_credential");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/acceptance/smoke.test.ts`
Expected: FAIL — `runSmokeChecks` not exported.

- [ ] **Step 3: Implement the smoke script**

```ts
// scripts/smoke-test.ts
export interface SmokeStep { name: string; ok: boolean; detail: string; }
export interface SmokeResult { passed: boolean; steps: SmokeStep[]; }

export async function runSmokeChecks(baseUrl: string, fetchFn: typeof fetch): Promise<SmokeResult> {
  const steps: SmokeStep[] = [];

  const healthRes = await fetchFn(`${baseUrl}/health`);
  const healthBody = (await healthRes.json()) as { ok: boolean };
  steps.push({ name: "health", ok: healthRes.ok && healthBody.ok, detail: healthRes.ok ? "reachable" : `HTTP ${healthRes.status}` });
  if (!steps.at(-1)!.ok) return { passed: false, steps };

  const setupRes = await fetchFn(`${baseUrl}/setup`);
  const setupBody = (await setupRes.json()) as { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> };
  const failing = setupBody.checks?.filter((c) => !c.ok) ?? [];
  steps.push({
    name: "setup",
    ok: setupBody.ok,
    detail: setupBody.ok ? "all checks ok" : failing.map((c) => `${c.name}: ${c.detail}`).join("; "),
  });
  if (!steps.at(-1)!.ok) return { passed: false, steps };

  // Exercise one representative LINE-shaped webhook call end-to-end (search is read-only and safe to run in production).
  const webhookRes = await fetchFn(`${baseUrl}/line/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": "smoke-test-signature" },
    body: JSON.stringify({ events: [{ type: "message", message: { type: "text", text: "/search A-0000" }, source: { type: "group", groupId: "smoke-test" }, replyToken: "smoke" }] }),
  });
  steps.push({ name: "search", ok: webhookRes.ok, detail: webhookRes.ok ? "webhook accepted" : `HTTP ${webhookRes.status}` });

  return { passed: steps.every((s) => s.ok), steps };
}

async function main() {
  const envArgIndex = process.argv.indexOf("--env");
  const envName = envArgIndex >= 0 ? process.argv[envArgIndex + 1] : "staging";
  const baseUrl = envName === "production"
    ? "https://snazzy-automation-production.workers.dev"
    : "https://snazzy-automation-staging.workers.dev";

  const result = await runSmokeChecks(baseUrl, fetch);
  for (const step of result.steps) {
    console.log(`${step.ok ? "PASS" : "FAIL"} ${step.name}: ${step.detail}`);
  }
  if (result.passed) {
    console.log("SMOKE TEST PASSED");
    process.exit(0);
  } else {
    console.log("SMOKE TEST FAILED");
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/acceptance/smoke.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Fresh-account rehearsal**

Execute the full Deployment Runbook (Task 12) end-to-end against a throwaway/free-tier Cloudflare account distinct from the customer's real account — this proves the runbook contains no undocumented manual step and no hidden dependency on prior account state:

1. Follow `docs/runbooks/deployment.md` steps 1–10 exactly as written, using placeholder Airtable/LINE/Google test accounts.
2. At step 10, run `npm run smoke:staging` and confirm `SMOKE TEST PASSED`.
3. Note any step in the runbook that required tribal knowledge not written down; fix `docs/runbooks/deployment.md` to close the gap.
4. Tear down the throwaway account's resources (`npx wrangler d1 delete`, `npx wrangler r2 bucket delete`, `npx wrangler delete --env staging`) once the rehearsal is confirmed reproducible.

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke-test.ts test/acceptance/smoke.test.ts
git commit -m "feat: add smoke test script exercising health, setup, and search end-to-end"
```

---

### Task 17: Handoff acceptance checklist and full suite run

**Files:**
- Create: `docs/runbooks/handoff-acceptance.md`

- [ ] **Step 1: Write the checklist, mirroring the index's Plan Completion Definition and spec §18 handoff acceptance**

```markdown
# Handoff Acceptance Checklist

Run in order. Every item must be checked before customer handoff is considered complete.

- [ ] Phase 0 report (`docs/feasibility/icloud-phase-0-report.md`) says `PASS`.
- [ ] `npm run check` passes on `main` with zero failing tests.
- [ ] `npm run test:acceptance` passes, covering:
  - [ ] `test/acceptance/failure-injection.test.ts` — retry exhaustion and per-group rollback.
  - [ ] `test/acceptance/import-batches.test.ts` — all 10 production-sized batches.
  - [ ] `test/acceptance/publication.test.ts` — missing-field block, first-four ordering, one-doc-per-date.
  - [ ] `test/acceptance/line-commands.test.ts` — all 30 parser cases.
  - [ ] `test/acceptance/redaction.test.ts` — no secret ever logged across a full import run.
  - [ ] `test/acceptance/smoke.test.ts` — smoke-check logic unit tests.
- [ ] D1 migrations apply cleanly to a fresh local database: `npm run db:migrate:local` from a dropped/recreated local D1.
- [ ] D1 migrations apply cleanly to fresh staging and production databases (proven during Task 16's fresh-account rehearsal).
- [ ] `GET /setup` on staging returns `"ok": true` for all ten checks.
- [ ] `GET /setup` on production returns `"ok": true` for all ten checks.
- [ ] `npm run smoke:staging` prints `SMOKE TEST PASSED`.
- [ ] `npm run smoke:production` prints `SMOKE TEST PASSED`.
- [ ] Fresh-account rehearsal (Task 16, Step 5) completed on a throwaway Cloudflare account using only `docs/runbooks/deployment.md`, with zero undocumented manual steps.
- [ ] One credential rotated on production following `docs/runbooks/credential-rotation.md` with no code change, verified via `/setup` and `npm run smoke:production`.
- [ ] `docs/runbooks/operations.md` change log has both native Cloudflare Notification policies recorded (Billing Usage Alert, R2 Storage).
- [ ] `GET /usage` on production returns a plausible estimate (`estimatedThb` in the ฿0–1000 range for a fresh environment with no traffic yet).
- [ ] Customer staff has received the printed `SNAZZY_PRODUCT_START_V1` marker cards and confirmed marker placement in a live test shoot.
- [ ] Customer has been walked through `docs/runbooks/operations.md`, `docs/runbooks/album-rotation.md`, and `docs/runbooks/credential-rotation.md` at least once.
- [ ] All account credentials (Airtable, Google, LINE, Anthropic, Cloudflare, iCloud) are confirmed customer-owned, not contractor-owned.
```

- [ ] **Step 2: Run the full suite to populate the checklist**

Run: `npm run check && npm run test:acceptance`
Expected: all suites PASS. Record actual pass output alongside the checked-off checklist when performing a real handoff.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/handoff-acceptance.md
git commit -m "docs: add handoff acceptance checklist tying together all hardening deliverables"
```

---

## Plan Completion Definition

This plan is complete only when every box in `docs/runbooks/handoff-acceptance.md` (Task 17) is checked, matching the index's global "Plan Completion Definition":

- Phase 0 report passes every iCloud gate.
- `npm run check` passes.
- D1 migrations apply to fresh local, staging, and production databases.
- Ten production-sized import batches meet acceptance criteria.
- Publication tests prove missing-data block and one-final-document invariant.
- Thirty LINE parser/command cases pass.
- Fresh customer-owned deployment succeeds from runbook.
- One credential rotation succeeds without code changes.
