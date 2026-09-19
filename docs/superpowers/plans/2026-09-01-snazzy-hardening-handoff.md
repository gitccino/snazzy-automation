# Hardening and Customer Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the completed Snazzy Automation system (Foundation, Import, Publication, LINE plans all implemented) survives failure injection, production-sized volume, and a fresh customer deployment, then hand it off with cost controls, monitoring, and runbooks.

**Architecture:** This plan adds no new business features. It adds a usage-metrics D1 table and repository wired into existing Claude and R2 call sites, a setup-validation route and CLI script, a budget/cost report backed by that table, failure-injectable test fakes exercised against the existing `import/service.ts` and `publication/service.ts` orchestration functions, staging/production `wrangler.jsonc` environments, and four operator runbooks. Every acceptance suite (import batches, publication, LINE, redaction, smoke) runs against the real service functions with fake external clients — no new production code paths are introduced beyond metrics and setup validation.

**Tech Stack:** TypeScript, Cloudflare Workers, Cloudflare Workflows, D1, R2, Cloudflare Images, Vitest 4.1+, `@cloudflare/vitest-plugin`, Zod, `@anthropic-ai/sdk`, and the existing `tsx` devDependency from Foundation Task 1.

**Spec:** `docs/superpowers/specs/2026-09-01-snazzy-automation-design.md`

## Global Constraints

- Dedicated customer-owned staging and production deployments.
- Runtime timezone: `Asia/Bangkok`.
- Import volume: 100–500 photos/day; normal product group: 9–15 photos.
- Retry transient workflow steps up to five times after the initial attempt, with exponential backoff.
- Operator routes `/upload`, `/docs`, `/setup`, and `/usage` verify `Authorization: Bearer <ADMIN_ROUTE_TOKEN>` with the shared constant-time `verifyAdminBearer` helper before any side effect or dependency access.
- Missing Product data blocks whole publication and creates no Google Doc.
- Already-Out Product is never overwritten.
- Only allowlisted LINE group may execute commands; every LINE webhook signature is verified.
- Never log credentials, public-album token/link, signed URLs, Product images, or raw external response bodies containing them.
- Infrastructure and AI spend target remains under ฿1,000/month, excluding Airtable, Google Workspace, and LINE plan fees.
- Use native `fetch` routing; do not add a web framework.
- Use official `@anthropic-ai/sdk`; do not call Claude through raw HTTP.
- Cloudflare compatibility date must be `2026-09-01` or later and include `nodejs_compat`.
- Every non-trivial parser, state transition, money mutation, and trust boundary starts with a failing test.
- Every task ends with focused tests, `npm run check`, and a commit.
- This plan assumes Foundation, Import pipeline, Publication pipeline, and LINE inventory bot plans are already implemented and `npm run check` currently passes on `main`.

---

### Task 0: Register operational scripts

Foundation Task 1 already installs `tsx`. Add only the scripts implemented by this plan to the existing `package.json` `scripts` object; preserve every existing script:

```json
{
  "scripts": {
    "setup:verify": "tsx scripts/verify-airtable-schema.ts",
    "smoke": "tsx scripts/smoke-test.ts",
    "test:acceptance": "vitest run test/acceptance"
  }
}
```

No `usage:alarms` script exists: Task 9 implements the code-side cron alarm, while account-level Cloudflare notifications remain documented dashboard setup.

Run: `npm run check`
Expected: PASS — registered scripts do not break typecheck or the full test suite.

Commit:

```bash
git add package.json
git commit -m "chore: register hardening operational scripts"
```

---

### Task 1: Usage-metrics D1 table and repository

**Files:**
- Create: `migrations/0005_usage_metrics.sql`
- Create: `src/db/usage-repository.ts`
- Test: `test/db/usage-repository.test.ts`

**Interfaces:**
- Consumes: `Env.DB` (`D1Database`, from `src/env.ts`).
- Produces: `recordUsage(db: D1Database, metricName: string, value: number, metricDate: string): Promise<void>`, `getMonthlyUsage(db: D1Database, yearMonth: string): Promise<Record<string, number>>`, and `getUsageTotal(db: D1Database, metricName: string): Promise<number>`. Task 8 combines monthly Claude tokens with the all-time `r2_bytes_added` total as a conservative current-storage gauge.

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0005_usage_metrics.sql
CREATE TABLE usage_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_date TEXT NOT NULL,       -- 'YYYY-MM-DD' in Asia/Bangkok
  metric_name TEXT NOT NULL,       -- e.g. 'claude_input_tokens', 'r2_bytes_added'
  metric_value INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(metric_date, metric_name)
);

CREATE INDEX idx_usage_metrics_date ON usage_metrics(metric_date);
CREATE INDEX idx_usage_metrics_name ON usage_metrics(metric_name);
```

- [ ] **Step 2: Apply migration locally**

Run: `npm run db:migrate:local`
Expected: `Migrations to be applied: 0005_usage_metrics.sql` then `✅ Successfully applied`.

- [ ] **Step 3: Write the failing test**

```ts
// test/db/usage-repository.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  getMonthlyUsage,
  getUsageTotal,
  recordUsage,
} from "../../src/db/usage-repository";

describe("usage-repository", () => {
  it("accumulates same-day same-metric writes instead of overwriting", async () => {
    await recordUsage(env.DB, "claude_input_tokens", 1200, "2026-09-01");
    await recordUsage(env.DB, "claude_input_tokens", 800, "2026-09-01");

    const monthly = await getMonthlyUsage(env.DB, "2026-09");
    expect(monthly.claude_input_tokens).toBe(2000);
  });

  it("keeps metrics from different months separate", async () => {
    await recordUsage(env.DB, "r2_bytes_added", 5_000_000, "2026-08-31");
    await recordUsage(env.DB, "r2_bytes_added", 3_000_000, "2026-09-01");

    const august = await getMonthlyUsage(env.DB, "2026-08");
    const september = await getMonthlyUsage(env.DB, "2026-09");
    expect(august.r2_bytes_added).toBe(5_000_000);
    expect(september.r2_bytes_added).toBe(3_000_000);
    expect(await getUsageTotal(env.DB, "r2_bytes_added"))
      .toBe(8_000_000);
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

export async function getUsageTotal(
  db: D1Database,
  metricName: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(metric_value), 0) AS total
       FROM usage_metrics
       WHERE metric_name = ?1`,
    )
    .bind(metricName)
    .first<{ total: number }>();
  return row?.total ?? 0;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/db/usage-repository.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 8: Commit**

```bash
git add migrations/0005_usage_metrics.sql src/db/usage-repository.ts test/db/usage-repository.test.ts
git commit -m "feat: add usage_metrics table and repository for cost tracking"
```

---

### Task 2: Wire token and byte metrics into existing call sites

**Files:**
- Modify: `src/publication/captions.ts` (existing Anthropic SDK call site from the publication plan)
- Modify: `src/publication/service.ts` (pass usage context to caption generation)
- Modify: `src/publication/workflow.ts` (pass D1 to the asset store)
- Modify: `src/import/asset-store.ts` (existing R2 write call site from the import plan)
- Modify: `src/import/workflow.ts` (pass D1 to the asset store)
- Test: `test/publication/captions.test.ts` (extend existing suite)
- Test: `test/import/asset-store.test.ts` (extend existing suite)

**Interfaces:**
- Consumes: `recordUsage` from Task 1; the Anthropic SDK response shape `{ usage: { input_tokens: number; output_tokens: number } }`; the existing `Clock` type (`{ now(): Date }`) from `src/shared/time.ts` for the metric date.
- Produces: no new exported symbols — this task only adds side-effecting calls inside existing functions, observed via `env.DB` reads in tests.

- [ ] **Step 1: Write the failing test for captions**

First extend the existing `toolResponse` test helper so every successful SDK fixture carries usage:

```ts
function toolResponse(
  captions: Array<{ productId: string; drafts: string[] }>,
  usage = { input_tokens: 0, output_tokens: 0 },
) {
  return {
    content: [
      {
        type: "tool_use",
        name: "submit_captions",
        input: { captions },
      },
    ],
    usage,
  };
}
```

Then append this test inside the existing `generateCaptionsForRun` describe block:

```ts
import { env } from "cloudflare:test";
import { getMonthlyUsage } from "../../src/db/usage-repository";

it("records Claude input and output token usage in D1", async () => {
  const client = sdkClient({
    countTokens: vi.fn().mockResolvedValue({ input_tokens: 500 }),
    create: vi.fn().mockResolvedValue(toolResponse(
      [{ productId: "A-1001", drafts: ["หนึ่ง", "สอง", "สาม"] }],
      { input_tokens: 500, output_tokens: 300 },
    )),
  });
  const products = toCaptionRequestProducts([product("A-1001")]);

  await generateCaptionsForRun(
    client,
    "claude-opus-5",
    1_000,
    products,
    {
      db: env.DB,
      clock: {
        now: () => new Date("2026-09-01T10:00:00+07:00"),
      },
    },
  );

  const usage = await getMonthlyUsage(env.DB, "2026-09");
  expect(usage.claude_input_tokens).toBe(500);
  expect(usage.claude_output_tokens).toBe(300);
});
```

Also add `usage: { input_tokens: 0, output_tokens: 0 }` to the existing malformed fixture whose successful SDK response is `{ content: [] }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publication/captions.test.ts -t "records Claude"`
Expected: FAIL because `generateCaptionsForRun` does not accept `db`/`clock` and no usage rows are written.

- [ ] **Step 3: Extend the exact caption functions and call site**

Add these imports to `src/publication/captions.ts`:

```ts
import { recordUsage } from "../db/usage-repository";
import { todayBangkokDate, type Clock } from "../shared/time";
```

Replace `requestCaptionBatch` with:

```ts
interface CaptionUsageContext {
  db: D1Database;
  clock: Clock;
}

export async function requestCaptionBatch(
  client: Pick<Anthropic, "messages">,
  model: string,
  products: CaptionRequestProduct[],
  usageContext?: CaptionUsageContext,
): Promise<CaptionGenerationOutcome> {
  const requestedIds = new Set(products.map((product) => product.productId));
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

  if (usageContext) {
    const metricDate = todayBangkokDate(
      usageContext.clock,
    );
    await recordUsage(
      usageContext.db,
      "claude_input_tokens",
      response.usage.input_tokens,
      metricDate,
    );
    await recordUsage(
      usageContext.db,
      "claude_output_tokens",
      response.usage.output_tokens,
      metricDate,
    );
  }

  const toolUse = response.content.find(
    (block): block is Anthropic.Messages.ToolUseBlock =>
      block.type === "tool_use" && block.name === "submit_captions",
  );
  if (!toolUse) {
    return { captions: [], missingProductIds: [...requestedIds] };
  }

  const parsed = ResponseSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    return { captions: [], missingProductIds: [...requestedIds] };
  }

  const returnedIds = new Set(
    parsed.data.captions.map((caption) => caption.productId),
  );
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
    const match = parsed.data.captions.find(
      (caption) => caption.productId === productId,
    );
    if (match) {
      captions.push({ productId, drafts: match.drafts });
    } else {
      missingProductIds.push(productId);
    }
  }
  return { captions, missingProductIds };
}
```

Replace `generateCaptionsForRun` with:

```ts
export async function generateCaptionsForRun(
  client: Pick<Anthropic, "messages">,
  model: string,
  inputTokenLimit: number,
  products: CaptionRequestProduct[],
  usageContext?: CaptionUsageContext,
): Promise<CaptionGenerationOutcome> {
  if (products.length === 0) {
    return { captions: [], missingProductIds: [] };
  }
  const batches = await planCaptionBatches(
    client,
    model,
    products,
    inputTokenLimit,
  );
  const captions: CaptionSet[] = [];
  const missingProductIds: string[] = [];
  for (const batch of batches) {
    const outcome = await requestCaptionBatch(
      client,
      model,
      batch,
      usageContext,
    );
    captions.push(...outcome.captions);
    missingProductIds.push(...outcome.missingProductIds);
  }
  return { captions, missingProductIds };
}
```

In `src/publication/service.ts`, replace the existing call inside `captionsForProducts` with:

```ts
const generated = await generateCaptionsForRun(
  deps.anthropic,
  deps.config.claudeModel,
  deps.config.claudeRequestInputTokenLimit,
  toCaptionRequestProducts(missing),
  { db: deps.db, clock: deps.clock },
);
```

Existing unit tests keep their current calls and omit `usageContext`; only the D1 metrics test above and the production `captionsForProducts` call pass it. This preserves focused caption tests while making metrics mandatory on the sole production path.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/publication/captions.test.ts`
Expected: PASS, including all pre-existing tests in the file.

- [ ] **Step 5: Write the failing test for net-new R2 storage tracking**

```ts
// test/import/asset-store.test.ts (add to existing describe block)
import { env } from "cloudflare:test";
import { getUsageTotal } from "../../src/db/usage-repository";

it("records only bytes added by a newly created R2 object", async () => {
  const clock = {
    now: () => new Date("2026-09-01T10:00:00+07:00"),
  };
  const store = createAssetStore(
    env.IMAGES_BUCKET,
    {
      signingSecret: "test-signing-secret",
      publicBaseUrl: "https://worker.example",
    },
    clock,
    env.DB,
  );
  const body = new Uint8Array(2_500_000).buffer;

  expect((await store.putIfAbsent(
    "sha256-fixture",
    "jpg",
    body,
    "image/jpeg",
  )).created).toBe(true);
  expect((await store.putIfAbsent(
    "sha256-fixture",
    "jpg",
    body,
    "image/jpeg",
  )).created).toBe(false);

  expect(await getUsageTotal(env.DB, "r2_bytes_added"))
    .toBe(2_500_000);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/import/asset-store.test.ts -t "newly created R2"`
Expected: FAIL because `createAssetStore` does not yet accept `db` or record the new object's bytes.

- [ ] **Step 7: Extend the existing `createAssetStore` constructor and `putIfAbsent` implementation**

```ts
// src/import/asset-store.ts — add imports
import { recordUsage } from "../db/usage-repository";
import { todayBangkokDate } from "../shared/time";

// replace the existing constructor signature
export function createAssetStore(
  bucket: R2Bucket,
  config: {
    signingSecret: string;
    publicBaseUrl: string;
  },
  clock: Clock,
  db?: D1Database,
): AssetStore {
  return {
    async putIfAbsent(
      contentHash,
      extension,
      body,
      contentType,
    ) {
      const r2Key = `assets/${contentHash}.${extension}`;
      const created = await bucket.put(r2Key, body, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType },
      });
      if (created === null) {
        return { r2Key, created: false };
      }
      if (db) {
        await recordUsage(
          db,
          "r2_bytes_added",
          body.byteLength,
          todayBangkokDate(clock),
        );
      }
      return { r2Key, created: true };
    },

    async signUrl(r2Key, ttlSeconds) {
      const expiresAt =
        Math.floor(clock.now().getTime() / 1000) + ttlSeconds;
      const payload = `${r2Key}:${expiresAt}`;
      const signature = await hmacHex(config.signingSecret, payload);
      const url = new URL(
        `${config.publicBaseUrl}/assets/${encodeURIComponent(r2Key)}`,
      );
      url.searchParams.set("exp", String(expiresAt));
      url.searchParams.set("sig", signature);
      return url.toString();
    },
  };
}
```

Keep existing unit-test constructors unchanged except the metrics test above. Add D1 only at the two production constructors:

```ts
// src/import/workflow.ts
assets: createAssetStore(
  this.env.IMAGES_BUCKET,
  {
    signingSecret: this.env.ASSET_URL_SIGNING_SECRET,
    publicBaseUrl: config.publicBaseUrl,
  },
  clock,
  this.env.DB,
),
```

```ts
// src/publication/workflow.ts
assets: createAssetStore(
  env.IMAGES_BUCKET,
  {
    signingSecret: env.ASSET_URL_SIGNING_SECRET,
    publicBaseUrl: config.publicBaseUrl,
  },
  clock,
  env.DB,
),
```

The conditional R2 write is atomic: a pre-existing content-hash key returns `null`, skips the metric, and prevents concurrent imports from double-counting retained storage.

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/import/asset-store.test.ts test/publication/captions.test.ts`
Expected: PASS.

- [ ] **Step 9: Run full check**

Run: `npm run check`
Expected: PASS — production constructors pass D1; existing focused tests remain valid without metrics.

- [ ] **Step 10: Commit**

```bash
git add src/publication/captions.ts src/import/asset-store.ts test/publication/captions.test.ts test/import/asset-store.test.ts src/publication/service.ts src/publication/workflow.ts src/import/workflow.ts
git commit -m "feat: record Claude token and R2 byte usage for cost reporting"
```

---

### Task 3: Embedded-secret redaction hardening

**Files:**
- Modify: `src/shared/logger.ts`
- Modify: `test/shared/logger.test.ts`
- Modify: `test/icloud/redaction-audit.test.ts`

**Interfaces:**
- Consumes: existing `LogFields`, `redact(fields)`, and `createLogger(base)` from Foundation Task 5; existing iCloud redaction audit from Foundation Task 12.
- Produces: `redactText(value: string): string`; `redact(fields)` additionally sanitizes sensitive text embedded in ordinary string values; logger messages are sanitized before JSON serialization.

- [ ] **Step 1: Write failing unit tests for embedded secrets**

```ts
// test/shared/logger.test.ts (add to existing imports and describe block)
import { redactText } from "../../src/shared/logger";

it.each([
  [
    "iCloud URL",
    "fetch https://p123-sharedstreams.icloud.com/A1b2C3d4Token/00/asset.jpg",
    "A1b2C3d4Token",
  ],
  [
    "signed asset URL",
    "https://worker.example/assets/x.jpg?X-Amz-Signature=abcdef123456&X-Amz-Expires=600",
    "abcdef123456",
  ],
  [
    "LINE bearer token",
    "Authorization: Bearer LINE_CHANNEL_ACCESS_TOKEN_VALUE_XYZ",
    "LINE_CHANNEL_ACCESS_TOKEN_VALUE_XYZ",
  ],
  [
    "Airtable token",
    "Authorization: Bearer patABCDEF1234567890.somehash",
    "patABCDEF1234567890",
  ],
])("redacts %s embedded in text", (_name, input, secret) => {
  const line = redactText(input);
  expect(line).not.toContain(secret);
  expect(line).toContain("[REDACTED]");
});

it("sanitizes message and ordinary string fields before writing JSON", () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  const logger = createLogger({ correlationId: "corr-redact" });
  logger.info("using Bearer LINE_CHANNEL_ACCESS_TOKEN_VALUE_XYZ", {
    endpoint:
      "https://worker.example/assets/x.jpg?X-Amz-Signature=abcdef123456",
  });

  const line = String(spy.mock.calls[0][0]);
  expect(line).not.toContain("LINE_CHANNEL_ACCESS_TOKEN_VALUE_XYZ");
  expect(line).not.toContain("abcdef123456");
  spy.mockRestore();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/shared/logger.test.ts`
Expected: FAIL — `redactText` is not exported and embedded values remain visible.

- [ ] **Step 3: Replace `src/shared/logger.ts` with the hardened implementation**

```ts
// src/shared/logger.ts
export type LogFields = Record<
  string,
  string | number | boolean | null
>;

const SECRET_KEY_PATTERN =
  /token|secret|signedurl|signed_url|derivativeurl|password|authorization/i;
const SECRET_TEXT_PATTERNS: RegExp[] = [
  /sharedstreams\.icloud\.com\/[A-Za-z0-9_-]{10,}/gi,
  /X-Amz-Signature=[^&\s]+/gi,
  /[?&]sig=[^&\s]+/gi,
  /Bearer\s+[A-Za-z0-9._-]{16,}/g,
  /LINE_CHANNEL_ACCESS_TOKEN_VALUE_[A-Za-z0-9_-]+/g,
  /pat[A-Za-z0-9]{14,}\.[A-Za-z0-9]+/g,
];

export function redactText(value: string): string {
  return SECRET_TEXT_PATTERNS.reduce(
    (output, pattern) =>
      output.replace(pattern, "[REDACTED]"),
    value,
  );
}

export function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] =
        typeof value === "string"
          ? redactText(value)
          : value;
    }
  }
  return out;
}

function write(
  level: "info" | "warn" | "error",
  base: LogFields,
  message: string,
  fields: LogFields,
): void {
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

- [ ] **Step 4: Extend existing cross-cutting redaction audit**

```ts
// test/icloud/redaction-audit.test.ts (append inside describe block)
it("redacts derivative and signed URLs embedded in a logged error", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const logger = createLogger({ correlationId: "corr-embedded" });
  const albumToken = "A1b2C3d4Token";
  const signature = "abcdef123456";

  logger.error("download failed", {
    reason:
      `https://p1-sharedstreams.icloud.com/${albumToken}/asset.jpg ` +
      `https://worker.example/assets/x.jpg?X-Amz-Signature=${signature}`,
  });

  const line = String(spy.mock.calls[0][0]);
  expect(line).not.toContain(albumToken);
  expect(line).not.toContain(signature);
  expect(line).toContain("[REDACTED]");
  spy.mockRestore();
});
```

- [ ] **Step 5: Run focused and full checks**

Run: `npx vitest run test/shared/logger.test.ts test/icloud/redaction-audit.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/logger.ts test/shared/logger.test.ts test/icloud/redaction-audit.test.ts
git commit -m "feat: redact secrets embedded in log text"
```

---

### Task 4: Workflow retry-exhaustion acceptance tests

**Files:**
- Create: `test/helpers/workflow-step.ts`
- Create: `test/acceptance/retry-exhaustion.test.ts`

**Interfaces:**
- Consumes: `runImportWorkflow` from Import Task 14; `OperationalError`; Cloudflare `NonRetryableError` semantics.
- Produces: `retryingStep()`, a test-only `WorkflowStep.do()` harness that records step name, retry limit, and actual attempts. Task 5 and Task 6 reuse it.

- [ ] **Step 1: Extract one exact Workflow-step retry harness**

```ts
// test/helpers/workflow-step.ts
import { NonRetryableError } from "cloudflare:workflows";

export interface WorkflowStepCall {
  name: string;
  retryLimit: number;
  attempts: number;
}

export function retryingStep() {
  const calls: WorkflowStepCall[] = [];
  return {
    calls,
    async do<T>(
      name: string,
      optionsOrCallback: unknown,
      maybeCallback?: () => Promise<T>,
    ): Promise<T> {
      const hasOptions =
        typeof optionsOrCallback !== "function";
      const callback = (
        hasOptions ? maybeCallback : optionsOrCallback
      ) as () => Promise<T>;
      const retryLimit = hasOptions
        ? (
            optionsOrCallback as {
              retries?: { limit: number };
            }
          ).retries?.limit ?? 0
        : 0;
      let attempts = 0;

      for (;;) {
        attempts += 1;
        try {
          const result = await callback();
          calls.push({ name, retryLimit, attempts });
          return result;
        } catch (error) {
          if (
            attempts > retryLimit ||
            error instanceof NonRetryableError
          ) {
            calls.push({ name, retryLimit, attempts });
            throw error;
          }
        }
      }
    },
  };
}
```

- [ ] **Step 2: Write import retry and sibling-isolation acceptance tests**

```ts
// test/acceptance/retry-exhaustion.test.ts
import { describe, expect, it, vi } from "vitest";
import { runImportWorkflow } from "../../src/import/workflow";
import type {
  PersistedGroup,
  ProcessGroupDeps,
} from "../../src/import/service";
import { OperationalError } from "../../src/shared/errors";
import { retryingStep } from "../helpers/workflow-step";

function group(id: string, ordinal: number): PersistedGroup {
  return {
    groupId: id,
    groupRowId: `row-${id}`,
    ordinal,
    markerPhotoId: `marker-${id}`,
    attachablePhotos: [{
      applePhotoId: `photo-${id}`,
      r2Key: `assets/${id}.jpg`,
    }],
  };
}

function forwardedDeps(): ProcessGroupDeps {
  // Orchestrator only forwards this object to stage fakes below.
  return Object.create(null) as ProcessGroupDeps;
}

const payload = {
  importRunId: "run-retry-acceptance",
  sourceAlbumId: "album-1",
  trigger: "admin" as const,
};

describe("Workflow-owned import retries", () => {
  it("succeeds after three transient failures within five retries", async () => {
    const step = retryingStep();
    const process = vi.fn()
      .mockRejectedValueOnce(new OperationalError(
        "airtable_rate_limited",
        "rate limited",
        true,
      ))
      .mockRejectedValueOnce(new OperationalError(
        "airtable_rate_limited",
        "rate limited",
        true,
      ))
      .mockRejectedValueOnce(new OperationalError(
        "airtable_rate_limited",
        "rate limited",
        true,
      ))
      .mockResolvedValue({
        outcome: "succeeded",
        productId: "A-501",
      });

    const result = await runImportWorkflow(
      forwardedDeps(),
      payload,
      step,
      {
        retryLimit: 5,
        downloadAndGroup: async () => ({
          pendingGroups: [group("g1", 0)],
          orphanRange: null,
          checkpointPosition: 10,
        }),
        processGroupAttempt: process,
        recordExhaustedFailure: vi.fn(),
        finalize: vi.fn().mockResolvedValue(undefined),
        notify: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(result).toEqual({
      importRunId: payload.importRunId,
      succeededProductIds: ["A-501"],
      failedGroups: [],
    });
    expect(process).toHaveBeenCalledTimes(4);
    expect(step.calls.find(
      ({ name }) => name === "process-group-row-g1",
    )).toMatchObject({ retryLimit: 5, attempts: 4 });
  });

  it("records one failed group after six attempts and continues its sibling", async () => {
    const step = retryingStep();
    const process = vi.fn(
      async (_deps, current: PersistedGroup) => {
        if (current.groupId === "g1") {
          throw new OperationalError(
            "airtable_rate_limited",
            "rate limited",
            true,
          );
        }
        return {
          outcome: "succeeded" as const,
          productId: "A-502",
        };
      },
    );
    const record = vi.fn().mockResolvedValue({
      productId: "A-501",
      errorCode: "airtable_rate_limited",
    });

    const result = await runImportWorkflow(
      forwardedDeps(),
      payload,
      step,
      {
        retryLimit: 5,
        downloadAndGroup: async () => ({
          pendingGroups: [group("g1", 0), group("g2", 1)],
          orphanRange: null,
          checkpointPosition: 20,
        }),
        processGroupAttempt: process,
        recordExhaustedFailure: record,
        finalize: vi.fn().mockResolvedValue(undefined),
        notify: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(step.calls.find(
      ({ name }) => name === "process-group-row-g1",
    )).toMatchObject({ retryLimit: 5, attempts: 6 });
    expect(record).toHaveBeenCalledTimes(1);
    expect(result.failedGroups).toEqual([{
      groupId: "row-g1",
      productId: "A-501",
      errorCode: "airtable_rate_limited",
    }]);
    expect(result.succeededProductIds).toEqual(["A-502"]);
  });
});
```

- [ ] **Step 3: Run focused tests**

Run: `npx vitest run test/import/workflow.test.ts test/acceptance/retry-exhaustion.test.ts`
Expected: PASS — transient case uses 4 attempts; exhausted case uses 6 attempts and still processes sibling group.

- [ ] **Step 4: Run full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/workflow-step.ts test/acceptance/retry-exhaustion.test.ts
git commit -m "test: verify Workflow retry exhaustion and sibling isolation"
```

---

### Task 5: Production-sized grouping and import-orchestration acceptance suite

**Files:**
- Modify: `test/helpers/fixtures.ts`
- Create: `test/acceptance/import-batches.test.ts`

**Interfaces:**
- Consumes: `groupByMarkers`, `computeGroupHash`, `GroupingPhoto` from Import Task 8; `runImportWorkflow` and `PersistedGroup` from Import Task 14; `retryingStep()` from Task 4.
- Produces: `buildGroupingPhotos(options)`, a deterministic 100–500-photo fixture with explicit product-group sizes and optional pre-marker orphan photos.

- [ ] **Step 1: Add deterministic production-volume fixture builder**

```ts
// test/helpers/fixtures.ts (append)
import type { GroupingPhoto } from "../../src/import/grouping";

export interface GroupingBatchOptions {
  groupSizes: number[];
  orphanPhotoCount?: number;
}

export function buildGroupingPhotos(
  options: GroupingBatchOptions,
): GroupingPhoto[] {
  const photos: GroupingPhoto[] = [];
  let position = 0;

  for (
    let index = 0;
    index < (options.orphanPhotoCount ?? 0);
    index += 1
  ) {
    const id = `orphan-${index}`;
    photos.push({
      applePhotoId: id,
      position: position++,
      isMarker: false,
      r2Key: `assets/${id}.jpg`,
    });
  }

  options.groupSizes.forEach((size, groupIndex) => {
    const markerId = `marker-${groupIndex}`;
    photos.push({
      applePhotoId: markerId,
      position: position++,
      isMarker: true,
      r2Key: `assets/${markerId}.jpg`,
    });
    for (let index = 0; index < size; index += 1) {
      const id = `g${groupIndex}-p${index}`;
      photos.push({
        applePhotoId: id,
        position: position++,
        isMarker: false,
        r2Key: `assets/${id}.jpg`,
      });
    }
  });

  return photos;
}
```

- [ ] **Step 2: Write ten production-sized acceptance cases**

```ts
// test/acceptance/import-batches.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  computeGroupHash,
  groupByMarkers,
} from "../../src/import/grouping";
import type {
  PersistedGroup,
  ProcessGroupDeps,
} from "../../src/import/service";
import { runImportWorkflow } from "../../src/import/workflow";
import { buildGroupingPhotos } from "../helpers/fixtures";
import { retryingStep } from "../helpers/workflow-step";

const batches = [
  {
    name: "100 photos with minimum nine-photo products",
    groupSizes: Array(10).fill(9),
    orphanPhotoCount: 0,
  },
  {
    name: "500 photos with maximum fifteen-photo products",
    groupSizes: Array(31).fill(15),
    orphanPhotoCount: 4,
  },
  {
    name: "mixed sizes nine through fifteen",
    groupSizes: Array.from(
      { length: 20 },
      (_, index) => 9 + (index % 7),
    ),
    orphanPhotoCount: 0,
  },
  {
    name: "twelve even twelve-photo products",
    groupSizes: Array(12).fill(12),
    orphanPhotoCount: 0,
  },
  {
    name: "eight pre-marker orphan photos",
    groupSizes: Array(12).fill(12),
    orphanPhotoCount: 8,
  },
  {
    name: "100-photo boundary with one orphan",
    groupSizes: Array(9).fill(10),
    orphanPhotoCount: 1,
  },
  {
    name: "twenty-five eleven-photo products",
    groupSizes: Array(25).fill(11),
    orphanPhotoCount: 0,
  },
  {
    name: "alternating nine and fifteen photo products",
    groupSizes: Array.from(
      { length: 16 },
      (_, index) => index % 2 === 0 ? 9 : 15,
    ),
    orphanPhotoCount: 0,
  },
  {
    name: "normal twenty-two-product day",
    groupSizes: Array(22).fill(12),
    orphanPhotoCount: 0,
  },
  {
    name: "494-photo large day",
    groupSizes: Array(38).fill(12),
    orphanPhotoCount: 0,
  },
] satisfies Array<{
  name: string;
  groupSizes: number[];
  orphanPhotoCount: number;
}>;

function forwardedDeps(): ProcessGroupDeps {
  // Orchestrator only forwards this object to stage fakes below.
  return Object.create(null) as ProcessGroupDeps;
}

describe.each(batches)("import batch: $name", (batch) => {
  it("preserves marker groups, stable hashes, and one Product ID per group", async () => {
    const photos = buildGroupingPhotos(batch);
    expect(photos.length).toBeGreaterThanOrEqual(100);
    expect(photos.length).toBeLessThanOrEqual(500);

    const grouped = groupByMarkers(photos);
    expect(grouped.orphanPhotos).toHaveLength(
      batch.orphanPhotoCount,
    );
    expect(grouped.groups).toHaveLength(
      batch.groupSizes.length,
    );
    expect(grouped.groups.map(({ photos: groupPhotos }) =>
      groupPhotos.length)).toEqual(
      batch.groupSizes.map((size) => size + 1),
    );

    const groupedIds = grouped.groups.flatMap(({ photos: groupPhotos }) =>
      groupPhotos.map(({ applePhotoId }) => applePhotoId));
    expect(new Set(groupedIds).size).toBe(groupedIds.length);

    const hashes = await Promise.all(
      grouped.groups.map(({ photos: groupPhotos }) =>
        computeGroupHash("album-1", groupPhotos)),
    );
    expect(new Set(hashes).size).toBe(hashes.length);

    const pendingGroups: PersistedGroup[] = grouped.groups.map(
      (group, index) => ({
        groupId: hashes[index],
        groupRowId: `row-${index}`,
        ordinal: group.ordinal,
        markerPhotoId: group.photos[0].applePhotoId,
        attachablePhotos: group.photos
          .filter(({ isMarker }) => !isMarker)
          .map(({ applePhotoId, r2Key }) => ({
            applePhotoId,
            r2Key,
          })),
      }),
    );
    const notify = vi.fn().mockResolvedValue(undefined);
    const result = await runImportWorkflow(
      forwardedDeps(),
      {
        importRunId: `run-${batch.name}`,
        sourceAlbumId: "album-1",
        trigger: "admin",
      },
      retryingStep(),
      {
        retryLimit: 5,
        downloadAndGroup: async () => ({
          pendingGroups,
          orphanRange: grouped.orphanPhotos.length === 0
            ? null
            : {
                firstApplePhotoId:
                  grouped.orphanPhotos[0].applePhotoId,
                lastApplePhotoId:
                  grouped.orphanPhotos.at(-1)!.applePhotoId,
                count: grouped.orphanPhotos.length,
              },
          checkpointPosition: photos.at(-1)!.position,
        }),
        processGroupAttempt: async (_deps, group) => ({
          outcome: "succeeded",
          productId: `A-${1001 + group.ordinal}`,
        }),
        recordExhaustedFailure: vi.fn(),
        finalize: vi.fn().mockResolvedValue(undefined),
        notify,
      },
    );

    expect(result.failedGroups).toEqual([]);
    expect(result.succeededProductIds).toHaveLength(
      batch.groupSizes.length,
    );
    expect(new Set(result.succeededProductIds).size).toBe(
      result.succeededProductIds.length,
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run focused acceptance tests**

Run: `npx vitest run test/import/grouping.test.ts test/import/workflow.test.ts test/acceptance/import-batches.test.ts`
Expected: PASS — 10 acceptance cases cover 100–500 photos, 9–15 product photos, pre-marker orphans, stable group hashes, and unique Product IDs.

- [ ] **Step 4: Run full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/fixtures.ts test/acceptance/import-batches.test.ts
git commit -m "test: cover production-sized import grouping batches"
```

---

### Task 6: Bind publication cleanup acceptance to Workflow retry budget

**Files:**
- Modify: `test/acceptance/publication.test.ts` (created by Publication Task 11)

**Interfaces:**
- Consumes: existing seven-case publication acceptance suite; `retryingStep()` from Task 4; `failPublicationAfterExhaustion` and D1 publication state from Publication Task 9.
- Produces: no production exports. Replaces the acceptance suite's manual six-call loop with the same `WorkflowStep.do()` retry harness used by import acceptance.

- [ ] **Step 1: Import shared retry harness**

```ts
// test/acceptance/publication.test.ts
import { retryingStep } from "../helpers/workflow-step";
```

- [ ] **Step 2: Replace manual retry loop in the existing exhaustion test**

Replace:

```ts
for (let call = 0; call < 6; call += 1) {
  await expect(fill()).rejects.toThrow("google 503");
  expect(fetcher.mock.calls.some(([, init]) =>
    init?.method === "DELETE")).toBe(false);
}
```

with:

```ts
const step = retryingStep();
await expect(
  step.do(
    "fill and verify document",
    {
      retries: {
        limit: 5,
        delay: "10 seconds",
        backoff: "exponential",
      },
      timeout: "5 minutes",
    },
    fill,
  ),
).rejects.toThrow("google 503");
expect(step.calls).toContainEqual({
  name: "fill and verify document",
  retryLimit: 5,
  attempts: 6,
});
expect(fetcher.mock.calls.some(([, init]) =>
  init?.method === "DELETE")).toBe(false);
```

Keep the existing `failPublicationAfterExhaustion(...)` call and assertions after this replacement. They prove one deletion occurs only after all six Workflow attempts and D1 ends with `{ state: "failed", tempDocId: null }`.

- [ ] **Step 3: Run Workflow and acceptance suites together**

Run: `npx vitest run test/publication/workflow.test.ts test/acceptance/publication.test.ts`
Expected: PASS — Workflow unit test proves `runPublicationWorkflow` invokes the stage six times; acceptance test proves real cleanup happens once after those six attempts.

- [ ] **Step 4: Run full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/acceptance/publication.test.ts
git commit -m "test: bind publication cleanup to Workflow retry budget"
```

---
### Task 7: Setup validator route and CLI script

**Files:**
- Create: `src/routes/setup.ts` (validator and one-time sequence bootstrap)
- Create: `src/routes/health.ts` (public liveness plus sequence/import readiness)
- Modify: `src/router.ts` (register health and authenticated setup routes)
- Create: `scripts/verify-airtable-schema.ts`
- Test: `test/routes/setup.test.ts`
- Test: `test/routes/health.test.ts`

**Interfaces:**
- Consumes: `Env` from `src/env.ts`; `parseConfig`; shared constant-time `verifyAdminBearer`; `createAssetStore` and `handleGetAsset`; `createSequenceRepository`; Airtable REST with paginated `Product ID` reads; existing LINE, Google-auth, Anthropic SDK, and iCloud clients for live credential/access probes.
- Produces: `runSetupChecks(env, fetcher?, clock?, probes?): Promise<SetupReport>`, authenticated `handleSetup(request, env, fetcher?, clock?, probes?): Promise<Response>`, authenticated one-time `handleBootstrapSequence(request, env)`, and public `handleHealth(env, fetcher?): Promise<Response>`. `SetupReport = { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> }` is consumed by Task 15's smoke test and CLI script.

Publication review requirement: implement the [publication deployment contract](../../runbooks/publication-setup.md) as part of the Google setup probe and its tests. Require a nonempty folder `driveId`, verify explicit service-account Shared Drive membership and effective copy/edit/rename/delete permissions, and use `supportsAllDrives=true` on Drive reads/permission calls. A readable My Drive folder or template-only share must fail setup. The baseline Google probe example below checks only document type/parent and must be extended with these checks before shipping. Keep direct service-account authentication; do not add impersonation.

- [ ] **Step 1: Write the failing test**

```ts
// test/routes/setup.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  createSetupExternalProbes,
  handleBootstrapSequence,
  handleSetup,
  runSetupChecks,
} from "../../src/routes/setup";
import { testEnv } from "../helpers/env";

const requiredProductsFields = [
  "Product ID",
  "System Group ID",
  "Upload Date",
  "Product Images",
  "Inventory Status",
  "4-in-1 Image",
  "Publication Run",
  "Sold Price",
  "Sold At",
  "Sold By",
  "Last System Update",
  "Brand Name",
  "Model Name",
  "Condition Type",
  "Size",
  "Description",
  "LINE Square Price",
  "IG Price",
  "Data Complete",
  "Missing Fields",
];
const requiredRunFields = [
  "Publication Date",
  "Status",
  "Products",
  "Google Doc URL",
  "Generated At",
  "Error Summary",
];

function airtableSetupFetch(productIds = ["A-500"]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/meta/bases/")) {
      return Response.json({
        tables: [
          {
            id: "tblProducts",
            fields: requiredProductsFields.map((name) => ({ name })),
          },
          {
            id: "tblRuns",
            fields: requiredRunFields.map((name) => ({ name })),
          },
        ],
      });
    }
    return Response.json({
      records: productIds.map((productId, index) => ({
        id: `rec-${index}`,
        fields: { "Product ID": productId },
      })),
    });
  });
}

describe("setup routes", () => {
  it("reports all eleven required setup checks by name", async () => {
    const env = testEnv();
    await env.IMAGES_BUCKET.put(
      "assets/collage-base-1080.jpg",
      "fixture",
    );
    await env.DB.prepare(
      `INSERT INTO sequences
       (name, next_value, bootstrapped_at)
       VALUES ('product_id', 501, '2026-09-01T00:00:00.000Z')`,
    ).run();

    const report = await runSetupChecks(
      env,
      airtableSetupFetch(),
      { now: () => new Date("2026-09-02T01:00:00.000Z") },
      {
        verifyLineGroupAccess: vi.fn().mockResolvedValue(undefined),
        verifyGoogleTemplateAccess: vi.fn().mockResolvedValue(undefined),
        verifyClaudeCredential: vi.fn().mockResolvedValue(undefined),
        verifyICloudSnapshotAccess: vi.fn().mockResolvedValue(250),
      },
    );

    expect(report.checks.map((check) => check.name)).toEqual([
      "d1_migrations",
      "r2_access",
      "asset_delivery",
      "images_binding",
      "airtable_schema",
      "sequence_consistency",
      "line_webhook_config",
      "google_template_access",
      "claude_credential",
      "icloud_phase_zero",
      "cron_timezone",
    ]);
    expect(report.ok).toBe(true);
  });

  it("returns the setup report after valid bearer authentication", async () => {
    const env = testEnv();
    await env.IMAGES_BUCKET.put(
      "assets/collage-base-1080.jpg",
      "fixture",
    );
    await env.DB.prepare(
      `INSERT INTO sequences
       (name, next_value, bootstrapped_at)
       VALUES ('product_id', 501, '2026-09-01T00:00:00.000Z')`,
    ).run();
    const response = await handleSetup(
      new Request("https://worker.example/setup", {
        headers: {
          authorization: `Bearer ${env.ADMIN_ROUTE_TOKEN}`,
        },
      }),
      env,
      airtableSetupFetch(),
      { now: () => new Date("2026-09-02T01:00:00.000Z") },
      {
        verifyLineGroupAccess: vi.fn().mockResolvedValue(undefined),
        verifyGoogleTemplateAccess: vi.fn().mockResolvedValue(undefined),
        verifyClaudeCredential: vi.fn().mockResolvedValue(undefined),
        verifyICloudSnapshotAccess: vi.fn().mockResolvedValue(250),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: "airtable_schema",
          ok: true,
        }),
      ]),
    });
  });

  it.each([
    undefined,
    "Bearer wrong-token",
  ])("rejects setup before checks for missing or wrong bearer", async (authorization) => {
    const headers = authorization ? { authorization } : undefined;
    const response = await handleSetup(
      new Request("https://worker.example/setup", { headers }),
      { ADMIN_ROUTE_TOKEN: "admin-secret" } as ReturnType<typeof testEnv>,
    );
    expect(response.status).toBe(401);
  });

  it("rejects a malformed successful LINE group summary", async () => {
    const env = testEnv();
    const probes = createSetupExternalProbes(
      env,
      vi.fn().mockResolvedValue(Response.json({ groupId: "C1" })),
      { now: () => new Date("2026-09-02T01:00:00.000Z") },
    );

    await expect(probes.verifyLineGroupAccess()).rejects.toThrow();
  });

  it("bootstraps from maximum valid Airtable Product ID plus one", async () => {
    const env = testEnv();
    const response = await handleBootstrapSequence(
      new Request("https://worker.example/setup/bootstrap-sequence", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.ADMIN_ROUTE_TOKEN}`,
        },
      }),
      env,
      airtableSetupFetch(["A-9", "invalid", "A-501"]),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      bootstrappedFrom: 502,
    });
  });

  it("rejects a second bootstrap without moving the sequence", async () => {
    const env = testEnv();
    const request = () => new Request(
      "https://worker.example/setup/bootstrap-sequence",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.ADMIN_ROUTE_TOKEN}`,
        },
      },
    );
    expect((await handleBootstrapSequence(
      request(),
      env,
      airtableSetupFetch(["A-10"]),
    )).status).toBe(200);
    expect((await handleBootstrapSequence(
      request(),
      env,
      airtableSetupFetch(["A-999"]),
    )).status).toBe(409);
  });
});
```

```ts
// test/routes/health.test.ts
import { describe, expect, it, vi } from "vitest";
import { handleHealth } from "../../src/routes/health";
import { testEnv } from "../helpers/env";

function airtableProducts(productIds: string[]) {
  return vi.fn().mockResolvedValue(Response.json({
    records: productIds.map((productId, index) => ({
      id: `rec-${index}`,
      fields: { "Product ID": productId },
    })),
  }));
}

describe("GET /health", () => {
  it("fails readiness before Product ID bootstrap", async () => {
    const response = await handleHealth(
      testEnv(),
      airtableProducts([]),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      importRunning: false,
      code: "sequence_not_bootstrapped",
    });
  });

  it("reports running imports and fails on Airtable sequence drift", async () => {
    const env = testEnv();
    await env.DB.prepare(
      `INSERT INTO sequences
       (name, next_value, bootstrapped_at)
       VALUES ('product_id', 501, '2026-09-01T00:00:00.000Z')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO import_runs
       (id, source_album_id, trigger, status, started_at)
       VALUES ('run-1', 'album-1', 'cron', 'running',
               '2026-09-01T00:00:00.000Z')`,
    ).run();

    const response = await handleHealth(
      env,
      airtableProducts(["A-501"]),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      importRunning: true,
      code: "sequence_drift",
    });
  });

  it("returns healthy when D1 remains ahead of Airtable", async () => {
    const env = testEnv();
    await env.DB.prepare(
      `INSERT INTO sequences
       (name, next_value, bootstrapped_at)
       VALUES ('product_id', 502, '2026-09-01T00:00:00.000Z')`,
    ).run();

    const response = await handleHealth(
      env,
      airtableProducts(["A-501"]),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      importRunning: false,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routes/setup.test.ts test/routes/health.test.ts`
Expected: FAIL — `src/routes/setup.ts` and `src/routes/health.ts` do not exist yet.

- [ ] **Step 3: Implement `runSetupChecks`**

```ts
// src/routes/setup.ts
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { parseConfig } from "../config";
import { createSequenceRepository } from "../db/sequence-repository";
import type { Env, Fetcher } from "../env";
import { createICloudClient } from "../icloud/client";
import { createAssetStore } from "../import/asset-store";
import { createGoogleAuthClient } from "../publication/google-auth";
import { verifyAdminBearer } from "../shared/admin-auth";
import type { Clock } from "../shared/time";
import { todayBangkokDate } from "../shared/time";
import { handleGetAsset } from "./assets";

const AirtableMetaSchema = z.object({
  tables: z.array(z.object({
    id: z.string().min(1),
    fields: z.array(z.object({
      name: z.string().min(1),
    })),
  })),
});
const AirtableRecordsSchema = z.object({
  records: z.array(z.object({
    id: z.string().min(1),
    fields: z.object({
      "Product ID": z.string().optional(),
    }),
  })),
  offset: z.string().optional(),
});
const LineGroupSummarySchema = z.object({
  groupName: z.string().min(1),
});
const DriveFileSchema = z.object({
  id: z.string().min(1),
  mimeType: z.string().min(1),
  parents: z.array(z.string()).optional(),
});

export interface SetupExternalProbes {
  verifyLineGroupAccess(): Promise<void>;
  verifyGoogleTemplateAccess(): Promise<void>;
  verifyClaudeCredential(): Promise<void>;
  verifyICloudSnapshotAccess(): Promise<number>;
}

const requiredFields = {
  Products: [
    "Product ID",
    "System Group ID",
    "Upload Date",
    "Product Images",
    "Inventory Status",
    "4-in-1 Image",
    "Publication Run",
    "Sold Price",
    "Sold At",
    "Sold By",
    "Last System Update",
    "Brand Name",
    "Model Name",
    "Condition Type",
    "Size",
    "Description",
    "LINE Square Price",
    "IG Price",
    "Data Complete",
    "Missing Fields",
  ],
  "Publication Runs": [
    "Publication Date",
    "Status",
    "Products",
    "Google Doc URL",
    "Generated At",
    "Error Summary",
  ],
} as const;

export interface SetupCheckResult {
  name: string;
  ok: boolean;
  detail: string;
}
export interface SetupReport {
  ok: boolean;
  checks: SetupCheckResult[];
}

async function check(
  name: string,
  fn: () => Promise<string>,
): Promise<SetupCheckResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error
        ? error.message
        : String(error),
    };
  }
}

async function airtableJson(
  fetcher: Fetcher,
  url: string,
  token: string,
): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Airtable setup request failed: ${response.status}`);
  }
  return response.json();
}

async function validateAirtableSchema(
  env: Env,
  fetcher: Fetcher,
): Promise<void> {
  const config = parseConfig(env.APP_CONFIG_JSON);
  const body = AirtableMetaSchema.parse(await airtableJson(
    fetcher,
    `https://api.airtable.com/v0/meta/bases/${config.airtableBaseId}/tables`,
    env.AIRTABLE_TOKEN,
  ));
  const expected = [
    {
      tableId: config.airtableProductsTableId,
      label: "Products" as const,
    },
    {
      tableId: config.airtablePublicationRunsTableId,
      label: "Publication Runs" as const,
    },
  ];
  for (const entry of expected) {
    const table = body.tables.find((candidate) =>
      candidate.id === entry.tableId,
    );
    if (!table) {
      throw new Error(`${entry.label} table ID not found`);
    }
    const names = new Set(table.fields.map((field) => field.name));
    const missing = requiredFields[entry.label].filter((name) =>
      !names.has(name),
    );
    if (missing.length > 0) {
      throw new Error(
        `${entry.label} missing fields: ${missing.join(", ")}`,
      );
    }
  }
}

export async function maximumAirtableProductNumber(
  env: Env,
  fetcher: Fetcher,
): Promise<number> {
  const config = parseConfig(env.APP_CONFIG_JSON);
  let offset: string | undefined;
  let maximum = 0;
  do {
    const url = new URL(
      `https://api.airtable.com/v0/${config.airtableBaseId}/${config.airtableProductsTableId}`,
    );
    url.searchParams.append("fields[]", "Product ID");
    url.searchParams.set("pageSize", "100");
    if (offset) {
      url.searchParams.set("offset", offset);
    }
    const body = AirtableRecordsSchema.parse(await airtableJson(
      fetcher,
      url.toString(),
      env.AIRTABLE_TOKEN,
    ));
    for (const record of body.records) {
      const match = /^A-(\d+)$/.exec(
        record.fields["Product ID"] ?? "",
      );
      if (match) {
        maximum = Math.max(maximum, Number(match[1]));
      }
    }
    offset = body.offset;
  } while (offset);
  return maximum;
}

export async function sequenceState(env: Env): Promise<{
  nextValue: number;
  bootstrapped: boolean;
} | null> {
  const row = await env.DB.prepare(
    `SELECT next_value, bootstrapped_at
     FROM sequences
     WHERE name = 'product_id'`,
  ).first<{
    next_value: number;
    bootstrapped_at: string | null;
  }>();
  return row
    ? {
        nextValue: row.next_value,
        bootstrapped: row.bootstrapped_at !== null,
      }
    : null;
}

export function createSetupExternalProbes(
  env: Env,
  fetcher: Fetcher,
  clock: Clock,
): SetupExternalProbes {
  const config = parseConfig(env.APP_CONFIG_JSON);
  const googleAuth = createGoogleAuthClient(
    env.GOOGLE_SERVICE_ACCOUNT_JSON,
    clock,
    fetcher,
  );
  const anthropic = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    maxRetries: 0,
    fetch: fetcher,
  });
  const imageSource = createICloudClient(
    env.ICLOUD_SHARED_ALBUM_TOKEN,
    fetcher,
  );

  async function loadDriveFile(id: string) {
    const token = await googleAuth.getAccessToken();
    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`,
    );
    url.searchParams.set("fields", "id,mimeType,parents");
    const response = await fetcher(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Google Drive access failed: ${response.status}`);
    }
    return DriveFileSchema.parse(await response.json());
  }

  return {
    async verifyLineGroupAccess() {
      const response = await fetcher(
        `https://api.line.me/v2/bot/group/${encodeURIComponent(config.lineAllowedGroupId)}/summary`,
        {
          headers: {
            authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
          },
        },
      );
      if (!response.ok) {
        throw new Error(`LINE group access failed: ${response.status}`);
      }
      LineGroupSummarySchema.parse(await response.json());
    },
    async verifyGoogleTemplateAccess() {
      const folder = await loadDriveFile(config.googleDriveFolderId);
      if (folder.mimeType !== "application/vnd.google-apps.folder") {
        throw new Error("Configured Google folder is not a Drive folder");
      }
      const template = await loadDriveFile(config.googleTemplateDocId);
      if (
        template.mimeType !== "application/vnd.google-apps.document" ||
        !template.parents?.includes(folder.id)
      ) {
        throw new Error("Google template is not a document in configured folder");
      }
    },
    async verifyClaudeCredential() {
      const model = await anthropic.models.retrieve(config.claudeModel);
      if (model.id !== config.claudeModel) {
        throw new Error(`Anthropic returned unexpected model ${model.id}`);
      }
    },
    async verifyICloudSnapshotAccess() {
      const snapshot = await imageSource.getSnapshot();
      return snapshot.photos.length;
    },
  };
}

export async function runSetupChecks(
  env: Env,
  fetcher: Fetcher = fetch.bind(globalThis),
  clock: Clock = { now: () => new Date() },
  probes: SetupExternalProbes = createSetupExternalProbes(
    env,
    fetcher,
    clock,
  ),
): Promise<SetupReport> {
  const config = parseConfig(env.APP_CONFIG_JSON);
  const checks: SetupCheckResult[] = [];

  checks.push(await check("d1_migrations", async () => {
    const expectedTables = [
      "sequences",
      "import_runs",
      "import_checkpoints",
      "photo_assets",
      "product_groups",
      "audit_events",
      "publication_jobs",
      "publication_product_cache",
      "line_events",
      "pending_line_commands",
      "line_actions",
      "line_event_replies",
      "usage_metrics",
    ];
    const rows = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (${expectedTables
         .map(() => "?")
         .join(",")})`,
    ).bind(...expectedTables).all<{ name: string }>();
    const present = new Set(rows.results.map((row) => row.name));
    const missing = expectedTables.filter((name) => !present.has(name));
    if (missing.length > 0) {
      throw new Error(`Missing D1 tables: ${missing.join(", ")}`);
    }
    return `${expectedTables.length} required D1 tables present`;
  }));

  checks.push(await check("r2_access", async () => {
    const key = `setup-check/${crypto.randomUUID()}.txt`;
    await env.IMAGES_BUCKET.put(key, "ok");
    const object = await env.IMAGES_BUCKET.get(key);
    await env.IMAGES_BUCKET.delete(key);
    if (!object || await object.text() !== "ok") {
      throw new Error("R2 probe read did not match write");
    }
    if (
      await env.IMAGES_BUCKET.head(
        "assets/collage-base-1080.jpg",
      ) === null
    ) {
      throw new Error(
        "R2 collage base missing at assets/collage-base-1080.jpg",
      );
    }
    return "R2 write/read/delete and collage base verified";
  }));

  checks.push(await check("asset_delivery", async () => {
    const key = `setup-check/${crypto.randomUUID()}.txt`;
    await env.IMAGES_BUCKET.put(key, "signed-ok");
    try {
      const assets = createAssetStore(
        env.IMAGES_BUCKET,
        {
          signingSecret: env.ASSET_URL_SIGNING_SECRET,
          publicBaseUrl: config.publicBaseUrl,
      },
      clock,
    );
      const url = await assets.signUrl(key, 60);
      const response = await handleGetAsset(
        new Request(url),
        env,
        clock,
      );
      if (!response.ok || await response.text() !== "signed-ok") {
        throw new Error("signed asset route probe failed");
      }
      return "signed private asset route verified";
    } finally {
      await env.IMAGES_BUCKET.delete(key);
    }
  }));

  checks.push(await check("images_binding", async () => {
    if (!env.IMAGES) {
      throw new Error("IMAGES binding missing");
    }
    if (!env.IMPORT_WORKFLOW || !env.PUBLICATION_WORKFLOW) {
      throw new Error("Workflow binding missing");
    }
    if (!env.ADMIN_ROUTE_TOKEN) {
      throw new Error("ADMIN_ROUTE_TOKEN missing");
    }
    return "Images, Workflow, and admin-auth bindings present";
  }));

  checks.push(await check("airtable_schema", async () => {
    await validateAirtableSchema(env, fetcher);
    return "Airtable tables and required fields verified";
  }));

  checks.push(await check("sequence_consistency", async () => {
    const state = await sequenceState(env);
    if (!state?.bootstrapped) {
      throw new Error(
        "Product sequence not bootstrapped; POST /setup/bootstrap-sequence",
      );
    }
    const airtableMaximum = await maximumAirtableProductNumber(
      env,
      fetcher,
    );
    if (airtableMaximum >= state.nextValue) {
      throw new Error(
        `Airtable max Product ID (${airtableMaximum}) >= D1 next (${state.nextValue})`,
      );
    }
    return `D1 next=${state.nextValue}, Airtable max=${airtableMaximum}`;
  }));

  checks.push(await check("line_webhook_config", async () => {
    if (!env.LINE_CHANNEL_SECRET) {
      throw new Error("LINE_CHANNEL_SECRET missing");
    }
    await probes.verifyLineGroupAccess();
    return "LINE token can access configured allowed group";
  }));

  checks.push(await check("google_template_access", async () => {
    await probes.verifyGoogleTemplateAccess();
    return "Google service account can access template in target folder";
  }));

  checks.push(await check("claude_credential", async () => {
    await probes.verifyClaudeCredential();
    return `Anthropic credential can access ${config.claudeModel}`;
  }));

  checks.push(await check("icloud_phase_zero", async () => {
    const photoCount = await probes.verifyICloudSnapshotAccess();
    return `iCloud snapshot access verified (${photoCount} photos); committed Phase 0 report must also be PASS`;
  }));

  checks.push(await check("cron_timezone", async () => {
    if (config.timeZone !== "Asia/Bangkok") {
      throw new Error(`TIME_ZONE is ${config.timeZone}`);
    }
    if (config.uploadCutoffMinutes !== 30) {
      throw new Error(
        `UPLOAD_CUTOFF_MINUTES is ${config.uploadCutoffMinutes}`,
      );
    }
    return `Asia/Bangkok cutoff=30m today=${todayBangkokDate(clock)}`;
  }));

  return {
    ok: checks.every((entry) => entry.ok),
    checks,
  };
}

export async function handleBootstrapSequence(
  request: Request,
  env: Env,
  fetcher: Fetcher = fetch.bind(globalThis),
): Promise<Response> {
  if (!await verifyAdminBearer(request, env.ADMIN_ROUTE_TOKEN)) {
    return Response.json(
      { error: "unauthorized" },
      { status: 401 },
    );
  }
  const existing = await sequenceState(env);
  if (existing?.bootstrapped) {
    return Response.json(
      { error: "already_bootstrapped" },
      { status: 409 },
    );
  }
  const config = parseConfig(env.APP_CONFIG_JSON);
  const maximum = await maximumAirtableProductNumber(env, fetcher);
  const nextValue = Math.max(
    config.productIdInitialNumber,
    maximum + 1,
  );
  await createSequenceRepository(env.DB).bootstrap(
    "product_id",
    nextValue,
  );
  return Response.json({
    ok: true,
    bootstrappedFrom: nextValue,
  });
}
```

`maximumAirtableProductNumber` scans every Airtable page, accepts only exact `A-<digits>` IDs, and ignores malformed values. `handleBootstrapSequence` is one-time and returns `409 already_bootstrapped` before a second scan can move D1.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/routes/setup.test.ts test/routes/health.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Write the CLI wrapper script**

```ts
// scripts/verify-airtable-schema.ts
import { z } from "zod";

const SetupReportSchema = z.object({
  ok: z.boolean(),
  checks: z.array(z.object({
    name: z.string(),
    ok: z.boolean(),
    detail: z.string(),
  })),
});

async function main(): Promise<void> {
  const baseUrl = process.env.WORKER_BASE_URL;
  const token = process.env.ADMIN_ROUTE_TOKEN;
  if (!baseUrl || !token) {
    throw new Error(
      "Set WORKER_BASE_URL and ADMIN_ROUTE_TOKEN",
    );
  }
  const response = await fetch(`${baseUrl}/setup`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const report = SetupReportSchema.parse(await response.json());
  for (const check of report.checks) {
    console.log(
      `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`,
    );
  }
  if (!response.ok || !report.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
```

Exact staging invocation after deploy:

```bash
read -r -p "Exact staging Worker base URL: " WORKER_BASE_URL
export WORKER_BASE_URL
ADMIN_ROUTE_TOKEN="$ADMIN_ROUTE_TOKEN" npm run setup:verify
```

- [ ] **Step 6: Wire the route into the router**

Append the authenticated validator handler to `src/routes/setup.ts`:

```ts
export async function handleSetup(
  request: Request,
  env: Env,
  fetcher: Fetcher = fetch.bind(globalThis),
  clock: Clock = { now: () => new Date() },
  probes?: SetupExternalProbes,
): Promise<Response> {
  if (!await verifyAdminBearer(
    request,
    env.ADMIN_ROUTE_TOKEN,
  )) {
    return Response.json(
      { error: "unauthorized" },
      { status: 401 },
    );
  }
  const report = await runSetupChecks(
    env,
    fetcher,
    clock,
    probes ?? createSetupExternalProbes(
      env,
      fetcher,
      clock,
    ),
  );
  return Response.json(report, {
    status: report.ok ? 200 : 503,
  });
}
```

Create the public readiness route. It performs no mutation and exposes only boolean state/error code, never credentials or customer data:

```ts
// src/routes/health.ts
import type { Env, Fetcher } from "../env";
import {
  maximumAirtableProductNumber,
  sequenceState,
} from "./setup";

export async function handleHealth(
  env: Env,
  fetcher: Fetcher = fetch.bind(globalThis),
): Promise<Response> {
  const running = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM import_runs
     WHERE status = 'running'`,
  ).first<{ count: number }>();
  const importRunning = (running?.count ?? 0) > 0;
  const sequence = await sequenceState(env);

  if (!sequence?.bootstrapped) {
    return Response.json({
      ok: false,
      importRunning,
      code: "sequence_not_bootstrapped",
    }, { status: 503 });
  }

  try {
    const airtableMaximum = await maximumAirtableProductNumber(
      env,
      fetcher,
    );
    if (airtableMaximum >= sequence.nextValue) {
      return Response.json({
        ok: false,
        importRunning,
        code: "sequence_drift",
      }, { status: 503 });
    }
  } catch {
    return Response.json({
      ok: false,
      importRunning,
      code: "airtable_unavailable",
    }, { status: 503 });
  }

  return Response.json({ ok: true, importRunning });
}
```

Register all three routes in `src/router.ts` before the `not_found` response:

```ts
if (request.method === "GET" && url.pathname === "/health") {
  return handleHealth(env);
}

if (request.method === "GET" && url.pathname === "/setup") {
  return handleSetup(request, env);
}

if (
  request.method === "POST" &&
  url.pathname === "/setup/bootstrap-sequence"
) {
  return handleBootstrapSequence(request, env);
}
```

Add imports:

```ts
import { handleHealth } from "./routes/health";
import {
  handleBootstrapSequence,
  handleSetup,
} from "./routes/setup";
```

- [ ] **Step 7: Run full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/routes/setup.ts src/routes/health.ts src/router.ts scripts/verify-airtable-schema.ts test/routes/setup.test.ts test/routes/health.test.ts
git commit -m "feat: add health and secure setup validation routes"
```

---

### Task 8: Cost report endpoint

**Files:**
- Modify: `src/config.ts` (extend existing Zod schema)
- Create: `src/monitoring/usage-report.ts`
- Create: `src/routes/usage.ts`
- Modify: `src/router.ts` (register the new route)
- Test: `test/monitoring/usage-report.test.ts`
- Test: `test/routes/usage.test.ts`

**Interfaces:**
- Consumes: `getMonthlyUsage` and `getUsageTotal` from Task 1; `todayBangkokDate` from `src/shared/time.ts`. Monthly Claude tokens are combined with all-time net-new R2 bytes under synthetic key `r2_stored_bytes`.
- Produces: `buildCostReport(usage: Record<string, number>, config: AppConfig, yearMonth: string): CostReport` where `CostReport = { yearMonth: string; estimatedUsd: number; estimatedThb: number; overBudget: boolean; breakdown: Record<string, number> }`, consumed by Task 9's budget alarm.

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
      { claude_input_tokens: 1_000_000, claude_output_tokens: 200_000, r2_stored_bytes: 5 * 1024 * 1024 * 1024 },
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
      { claude_input_tokens: 50_000, claude_output_tokens: 20_000, r2_stored_bytes: 200 * 1024 * 1024 },
      { monthlyBudgetThb: 1000, usdToThbRate: 36, claudeInputPriceUsdPerMtok: 5, claudeOutputPriceUsdPerMtok: 25, r2PriceUsdPerGbMonth: 0.015 } as AppConfig,
      "2026-09",
    );
    expect(report.overBudget).toBe(false);
  });
});
```

```ts
// test/routes/usage.test.ts
import { describe, expect, it } from "vitest";
import { recordUsage } from "../../src/db/usage-repository";
import { handleUsage } from "../../src/routes/usage";
import { testEnv } from "../helpers/env";

describe("GET /usage", () => {
  it.each([
    undefined,
    "Bearer wrong-token",
  ])("rejects missing or wrong bearer before reading D1", async (authorization) => {
    const env = {
      ADMIN_ROUTE_TOKEN: "admin-secret",
    } as ReturnType<typeof testEnv>;
    const headers = authorization
      ? { authorization }
      : undefined;

    const response = await handleUsage(
      new Request("https://worker.example/usage", { headers }),
      env,
    );

    expect(response.status).toBe(401);
  });

  it("returns the monthly report for the exact admin bearer", async () => {
    const env = testEnv();
    await recordUsage(
      env.DB,
      "claude_input_tokens",
      1_000,
      "2026-09-01",
    );
    await recordUsage(
      env.DB,
      "r2_bytes_added",
      2_000,
      "2026-08-31",
    );

    const response = await handleUsage(
      new Request("https://worker.example/usage", {
        headers: {
          authorization: `Bearer ${env.ADMIN_ROUTE_TOKEN}`,
        },
      }),
      env,
      { now: () => new Date("2026-09-02T01:00:00.000Z") },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      yearMonth: "2026-09",
      overBudget: false,
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/monitoring/usage-report.test.ts test/routes/usage.test.ts`
Expected: FAIL because cost-report and authenticated usage-route modules do not exist.

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
  const r2Bytes = usage.r2_stored_bytes ?? 0;

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

`r2_stored_bytes` is the all-time sum of bytes for newly created content-addressed objects, not monthly write traffic. Multiplying current retained bytes by the monthly GB rate slightly overestimates objects added mid-month, which is intentional for a budget alarm and avoids undercounting indefinite retention.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/monitoring/usage-report.test.ts test/routes/usage.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Wire an authenticated route**

```ts
// src/routes/usage.ts
import type { Clock } from "../shared/time";
import type { Env } from "../env";
import { parseConfig } from "../config";
import {
  getMonthlyUsage,
  getUsageTotal,
} from "../db/usage-repository";
import { buildCostReport } from "../monitoring/usage-report";
import { verifyAdminBearer } from "../shared/admin-auth";
import { todayBangkokDate } from "../shared/time";

export async function handleUsage(
  request: Request,
  env: Env,
  clock: Clock = { now: () => new Date() },
): Promise<Response> {
  if (!await verifyAdminBearer(
    request,
    env.ADMIN_ROUTE_TOKEN,
  )) {
    return Response.json(
      { error: "unauthorized" },
      { status: 401 },
    );
  }

  const yearMonth = todayBangkokDate(clock).slice(0, 7);
  const monthly = await getMonthlyUsage(env.DB, yearMonth);
  const usage = {
    ...monthly,
    r2_stored_bytes: await getUsageTotal(
      env.DB,
      "r2_bytes_added",
    ),
  };
  const config = parseConfig(env.APP_CONFIG_JSON);
  const report = buildCostReport(usage, config, yearMonth);
  return Response.json(report);
}
```

Register in `src/router.ts` (existing native dispatch table): add `GET /usage -> handleUsage` next to the existing `GET /health` and `GET /setup` entries.

- [ ] **Step 7: Run full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/monitoring/usage-report.ts src/routes/usage.ts src/router.ts test/monitoring/usage-report.test.ts test/routes/usage.test.ts
git commit -m "feat: add monthly cost report endpoint backed by usage_metrics"
```

---

### Task 9: Budget alarm cron and native Cloudflare notifications

**Files:**
- Modify: `src/scheduled.ts` (existing cron router from Foundation plan)
- Test: `test/scheduled.test.ts` (extend existing suite)

**Interfaces:**
- Consumes: `buildCostReport` from Task 8; `getMonthlyUsage`/`getUsageTotal` from Task 1; existing `createLineClient(...): LineClient` and `LineClient.pushMessage(toGroupId, text)` from `src/line/client.ts`; `AppConfig.lineAllowedGroupId`.
- Produces: `runBudgetAlarmCheck(env: Env): Promise<{ sent: boolean; report: CostReport }>`, invoked only by the new scheduled cron branch. Task 15's deployment smoke remains non-mutating and validates `/usage` without sending an alarm.

- [ ] **Step 1: Write the failing test**

```ts
// test/scheduled.test.ts (add to existing describe block)
import { runBudgetAlarmCheck } from "../src/scheduled";
import { recordUsage } from "../src/db/usage-repository";
import type { LineClient } from "../src/line/client";

it("pushes a LINE alert to the admin group only when over budget", async () => {
  await recordUsage(env.DB, "claude_input_tokens", 50_000_000, "2026-09-01"); // deliberately huge
  const pushed: string[] = [];
  const lineClient = {
    pushMessage: async (_groupId: string, text: string) => {
      pushed.push(text);
    },
  } as LineClient;

  const result = await runBudgetAlarmCheck({
    ...env,
    __lineClientOverride: lineClient,
  });

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
import {
  getMonthlyUsage,
  getUsageTotal,
} from "./db/usage-repository";
import {
  buildCostReport,
  type CostReport,
} from "./monitoring/usage-report";
import { todayBangkokDate } from "./shared/time";
import { parseConfig } from "./config";
import {
  createLineClient,
  type LineClient,
} from "./line/client";

export async function runBudgetAlarmCheck(
  env: Env & { __lineClientOverride?: LineClient },
): Promise<{ sent: boolean; report: CostReport }> {
  const yearMonth = todayBangkokDate({
    now: () => new Date(),
  }).slice(0, 7);
  const monthly = await getMonthlyUsage(env.DB, yearMonth);
  const usage = {
    ...monthly,
    r2_stored_bytes: await getUsageTotal(
      env.DB,
      "r2_bytes_added",
    ),
  };
  const config = parseConfig(env.APP_CONFIG_JSON);
  const report = buildCostReport(usage, config, yearMonth);

  if (!report.overBudget) {
    return { sent: false, report };
  }

  const client = env.__lineClientOverride ?? createLineClient({
    channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
    fetch: fetch.bind(globalThis),
  });
  await client.pushMessage(
    config.lineAllowedGroupId,
    `⚠️ เกินงบประมาณรายเดือน: ประมาณการ ${report.estimatedThb.toFixed(0)} บาท (งบ ${config.monthlyBudgetThb} บาท) สำหรับเดือน ${yearMonth}`,
  );
  return { sent: true, report };
}
```

Add an exact `event.cron === "45 22 * * *"` branch to the existing scheduled handler and call `runBudgetAlarmCheck(env)`. This runs at 05:45 Asia/Bangkok, before the 06:00 import cron. Register the same expression in both environments in Task 10.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/scheduled.test.ts`
Expected: PASS, including all pre-existing scheduled-handler tests.

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add src/scheduled.ts test/scheduled.test.ts
git commit -m "feat: add daily budget alarm cron pushing LINE alert when over monthly ceiling"
```

Note: this code-side alarm is the primary, test-covered mechanism. Cloudflare's account-level Notifications (dashboard: Notifications → Add → "Billing Usage Alert" / R2 storage / Workers request-count alerts) are a secondary, dashboard-configured safety net with no reliable scriptable API contract to pin in tests — Task 12 documents the exact dashboard steps as a manual runbook procedure so they are configured once during handoff, not left as an untested guess in application code.

---

### Task 10: Staging and production deployment configuration

**Files:**
- Modify: `wrangler.jsonc` (existing single-environment file from Foundation plan)

**Interfaces:**
- Consumes: non-secret configuration keys listed in spec §15; the `IMPORT_WORKFLOW`/`PUBLICATION_WORKFLOW` Workflow bindings and `DB`/`IMAGES_BUCKET`/`IMAGES` bindings already declared in the base config.

- [ ] **Step 1: Add portable named environments without removing local bindings**

Preserve the top-level local D1, R2, Images, and both Workflow bindings created by Import Task 1/15 and Publication Task 10; `vitest.config.ts` reads those top-level bindings. Resource IDs are intentionally omitted only from the new remote environments until the deployment runbook creates each customer-owned D1 database. `APP_CONFIG_JSON` is installed by `wrangler secret put` in Task 11, so environment-specific customer IDs never need dummy values in committed source.

```jsonc
{
  "name": "snazzy-automation",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "snazzy-automation-local",
      "database_id": "00000000-0000-0000-0000-000000000001",
      "migrations_dir": "migrations"
    }
  ],
  "r2_buckets": [
    {
      "binding": "IMAGES_BUCKET",
      "bucket_name": "snazzy-automation-local-images"
    }
  ],
  "images": { "binding": "IMAGES" },
  "workflows": [
    {
      "binding": "IMPORT_WORKFLOW",
      "name": "snazzy-import-workflow-local",
      "class_name": "ImportWorkflow"
    },
    {
      "binding": "PUBLICATION_WORKFLOW",
      "name": "snazzy-publication-workflow-local",
      "class_name": "PublicationWorkflow"
    }
  ],
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

Cron ownership is fixed in both environments: `45 22 * * *` runs the daily budget alarm, `0 23 * * *` triggers import after the upload cutoff, and `30 23 * * *` triggers publication.

- [ ] **Step 2: Verify the portable config is valid JSONC**

Run: `node -e 'const fs=require("node:fs"); JSON.parse(fs.readFileSync("wrangler.jsonc","utf8")); console.log("wrangler config JSON valid")'`
Expected: `wrangler config JSON valid`.

Remote Wrangler validation occurs in Task 11 after exact D1 IDs are inserted.

- [ ] **Step 3: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 4: Commit**

```bash
git add wrangler.jsonc
git commit -m "feat: add staging and production wrangler environments with full non-secret config"
```

---

### Task 11: Deployment runbook

Carry forward the [publication deployment contract](../../runbooks/publication-setup.md): verify Shared Drive membership and a disposable copy/edit/rename/delete rehearsal, provide Images bindings in each named environment, and upload and remotely verify the private collage base asset before publication traffic.

**Files:**
- Create: `docs/runbooks/deployment.md`

**Interfaces:**
- Consumes: final `wrangler.jsonc`, migration scripts, setup/bootstrap routes, smoke script, customer-owned Cloudflare/Airtable/Google/LINE/Anthropic/iCloud configuration, and marker/base-canvas assets created by earlier plans.
- Produces: exact staging-first deployment, migration, secret installation, setup validation, smoke, production repetition, and rollback procedure used by Tasks 15–16.

- [ ] **Step 1: Write the runbook**

```markdown
# Deployment Runbook

## Prerequisites

- Customer Cloudflare account with Workers Paid plan ($5/month minimum).
- `npx wrangler login` completed against the customer's Cloudflare account.
- Customer-owned Airtable base with Products and Publication Runs tables matching design §9.
- Customer-owned Google Cloud service account with Docs + Drive API enabled and explicit membership in a dedicated customer-owned Shared Drive. The configured folder must belong to that Shared Drive and grant effective copy/edit/rename/delete access. Verify the publication setup contract; no impersonation.
- Customer-owned LINE Official Account and Messaging API channel with one admin group created.
- Printed `SNAZZY_PRODUCT_START_V1` QR marker cards (`npm run generate-marker`).

## One-time per environment (staging first, then production)

1. Create staging resources:
   ```bash
   npx wrangler d1 create snazzy-automation-staging
   npx wrangler r2 bucket create snazzy-automation-staging-images
   npx wrangler r2 object put \
     snazzy-automation-staging-images/assets/collage-base-1080.jpg \
     --file docs/runbooks/collage-base-1080.jpg \
     --remote
   ```
   Copy the exact returned D1 `database_id` into `env.staging.d1_databases[0].database_id` in `wrangler.jsonc`. Do not continue while that property is absent. Validate the real binding:
   ```bash
   npx wrangler deploy --dry-run --env staging
   ```

2. Apply migrations:
   ```bash
   npm run db:migrate:staging
   ```
  Expected: `0001_initial.sql`, `0002_import_run_terminal_details.sql`, `0003_line_inventory.sql`, `0003_publication.sql`, `0004_line_recovery.sql`, and `0005_usage_metrics.sql` applied successfully. Publication migration 0003 includes the unique date claim and per-output input fingerprints.

3. Install every secret. Keep the admin token in the current shell because authenticated setup and smoke commands need the same value:
   ```bash
   npx wrangler secret put AIRTABLE_TOKEN --env staging

   read -r -s -p "LINE channel secret: " LINE_CHANNEL_SECRET
   printf '%s' "$LINE_CHANNEL_SECRET" |
     npx wrangler secret put LINE_CHANNEL_SECRET --env staging
   export LINE_CHANNEL_SECRET

   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --env staging
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON --env staging
   npx wrangler secret put ANTHROPIC_API_KEY --env staging
   npx wrangler secret put ICLOUD_SHARED_ALBUM_TOKEN --env staging

   read -r -s -p "Asset URL signing secret: " ASSET_URL_SIGNING_SECRET
   printf '%s' "$ASSET_URL_SIGNING_SECRET" |
     npx wrangler secret put ASSET_URL_SIGNING_SECRET --env staging

   read -r -s -p "Admin route token: " ADMIN_ROUTE_TOKEN
   printf '%s' "$ADMIN_ROUTE_TOKEN" |
     npx wrangler secret put ADMIN_ROUTE_TOKEN --env staging
   export ADMIN_ROUTE_TOKEN
   ```

4. Deploy once, then copy the exact URL Wrangler prints:
   ```bash
   npm run deploy:staging
   read -r -p "Exact staging Worker base URL: " WORKER_BASE_URL
   export WORKER_BASE_URL
   ```
   `WORKER_BASE_URL` must be the deployed origin only, with no trailing slash.

5. Export customer-owned non-secret IDs and the first import cutoff:
   ```bash
   read -r -p "Airtable base ID: " AIRTABLE_BASE_ID
   read -r -p "Airtable Products table ID: " AIRTABLE_PRODUCTS_TABLE_ID
   read -r -p "Airtable Publication Runs table ID: " AIRTABLE_PUBLICATION_RUNS_TABLE_ID
   read -r -p "Allowed LINE group ID: " LINE_ALLOWED_GROUP_ID
   read -r -p "Google Drive folder ID: " GOOGLE_DRIVE_FOLDER_ID
   read -r -p "Google template document ID: " GOOGLE_TEMPLATE_DOC_ID
   read -r -p "First import cutoff ISO timestamp: " FIRST_IMPORT_CUTOFF_DATE
   export AIRTABLE_BASE_ID AIRTABLE_PRODUCTS_TABLE_ID
   export AIRTABLE_PUBLICATION_RUNS_TABLE_ID LINE_ALLOWED_GROUP_ID
   export GOOGLE_DRIVE_FOLDER_ID GOOGLE_TEMPLATE_DOC_ID
   export FIRST_IMPORT_CUTOFF_DATE
   ```

6. Generate complete `APP_CONFIG_JSON`, install it, and redeploy:
   ```bash
   APP_CONFIG_JSON="$(node <<'NODE'
   const required = [
     "AIRTABLE_BASE_ID",
     "AIRTABLE_PRODUCTS_TABLE_ID",
     "AIRTABLE_PUBLICATION_RUNS_TABLE_ID",
     "LINE_ALLOWED_GROUP_ID",
     "GOOGLE_DRIVE_FOLDER_ID",
     "GOOGLE_TEMPLATE_DOC_ID",
     "WORKER_BASE_URL",
     "FIRST_IMPORT_CUTOFF_DATE",
   ];
   for (const name of required) {
     if (!process.env[name]) throw new Error(`${name} missing`);
   }
   process.stdout.write(JSON.stringify({
     AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
     AIRTABLE_PRODUCTS_TABLE_ID: process.env.AIRTABLE_PRODUCTS_TABLE_ID,
     AIRTABLE_PUBLICATION_RUNS_TABLE_ID: process.env.AIRTABLE_PUBLICATION_RUNS_TABLE_ID,
     LINE_ALLOWED_GROUP_ID: process.env.LINE_ALLOWED_GROUP_ID,
     GOOGLE_DRIVE_FOLDER_ID: process.env.GOOGLE_DRIVE_FOLDER_ID,
     GOOGLE_TEMPLATE_DOC_ID: process.env.GOOGLE_TEMPLATE_DOC_ID,
     PUBLIC_BASE_URL: process.env.WORKER_BASE_URL,
     TIME_ZONE: "Asia/Bangkok",
     IMPORT_CRON: "0 23 * * *",
     PUBLICATION_CRON: "30 23 * * *",
     UPLOAD_CUTOFF_MINUTES: 30,
     IMPORT_RETRY_LIMIT: 5,
     PUBLICATION_RETRY_LIMIT: 5,
     PRODUCT_ID_PREFIX: "A",
     PRODUCT_ID_INITIAL_NUMBER: 1,
     CLAUDE_MODEL: "claude-opus-5",
     CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 150000,
     SOLDOUT_CONFIRMATION_ENABLED: true,
     FIRST_IMPORT_CUTOFF_DATE: process.env.FIRST_IMPORT_CUTOFF_DATE,
     MONTHLY_BUDGET_THB: 1000,
     USD_TO_THB_RATE: 36,
     CLAUDE_INPUT_PRICE_USD_PER_MTOK: 5,
     CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: 25,
     R2_PRICE_USD_PER_GB_MONTH: 0.015,
   }));
   NODE
   )"
   printf '%s' "$APP_CONFIG_JSON" |
     npx wrangler secret put APP_CONFIG_JSON --env staging
   npm run deploy:staging
   ```

7. Bootstrap Product ID sequence once. Pause staff imports during this scan:
   ```bash
   curl --fail-with-body \
     -X POST \
     -H "Authorization: Bearer $ADMIN_ROUTE_TOKEN" \
     "$WORKER_BASE_URL/setup/bootstrap-sequence"
   ```
   Expected: `{"ok":true,"bootstrappedFrom":N}`, where `N` is one greater than maximum valid Airtable `A-<NUMBER>` or `PRODUCT_ID_INITIAL_NUMBER` when no valid ID exists. A second call must return HTTP 409.

8. Run authenticated setup validator:
   ```bash
   curl --fail-with-body \
     -H "Authorization: Bearer $ADMIN_ROUTE_TOKEN" \
     "$WORKER_BASE_URL/setup"
   ```
   Expected: HTTP 200 and all eleven checks `ok: true`. Missing and wrong bearer values must return HTTP 401. Stop on any failed check; `icloud_phase_zero` also requires `docs/feasibility/icloud-phase-0-report.md` to say `PASS`.

9. Register `$WORKER_BASE_URL/line/webhook` in LINE Developers console for staging channel.

10. Run smoke test:
    ```bash
    WORKER_BASE_URL="$WORKER_BASE_URL" \
    ADMIN_ROUTE_TOKEN="$ADMIN_ROUTE_TOKEN" \
    LINE_CHANNEL_SECRET="$LINE_CHANNEL_SECRET" \
    npm run smoke
    ```
    Expected: `SMOKE TEST PASSED`.

11. Create `snazzy-automation-production` D1 and `snazzy-automation-production-images` R2 resources. Repeat steps 1–10 with every `--env staging` changed to `--env production`, `npm run db:migrate:staging` changed to `npm run db:migrate:production`, and `npm run deploy:staging` changed to `npm run deploy:production`. At step 4, read the exact production Worker origin into the same `WORKER_BASE_URL` variable. Use production customer IDs and secrets, copy the exact production `database_id` into `env.production.d1_databases[0].database_id`, and rerun `npx wrangler deploy --dry-run --env production` before migration or deploy. Commit both real D1 IDs in `wrangler.jsonc` after successful dry-run validation; resource IDs are customer-owned identifiers, not secrets.

## Rollback

Use `npx wrangler rollback --env staging` or `npx wrangler rollback --env production` to restore the prior Worker version. D1 migrations are additive-only; rollback never deletes D1 data and no reverse migration runs.
```

- [ ] **Step 2: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/deployment.md
git commit -m "docs: add deployment runbook for staging and production"
```

---

### Task 12: Operations runbook

**Files:**
- Create: `docs/runbooks/operations.md`

**Interfaces:**
- Consumes: deployed import/publication/LINE flows, authenticated `/setup` and `/usage` routes, D1 operational tables, LINE notifications, and Cloudflare native notification policies.
- Produces: customer daily-cycle, manual retry, cost-alarm response, failed-import, failed-publication, and escalation procedure referenced by Task 16.

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

Configure these once per environment as a defense-in-depth layer alongside the code-side budget alarm from Task 9 of the hardening plan:

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
curl --fail-with-body \
  -H "Authorization: Bearer $ADMIN_ROUTE_TOKEN" \
  "$WORKER_BASE_URL/usage"
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

- [ ] **Step 2: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/operations.md
git commit -m "docs: add operations runbook covering daily cycle, alarms, and diagnosis"
```

---

### Task 13: Album rotation runbook

**Files:**
- Modify: `docs/runbooks/album-rotation.md`

**Interfaces:**
- Consumes: the Phase 0 rotation procedure and source-key proof created by Foundation Task 16, plus public `GET /health` and authenticated `GET /setup` from Hardening Task 7.
- Produces: final production rotation procedure. Replace the feasibility-era runbook body with the complete content below; do not recreate the file or remove the source-identity safety explanation.

- [ ] **Step 1: Replace the feasibility runbook with the production runbook**

```markdown
# iCloud Shared Album Rotation Runbook

Apple limits a Shared Album to 5,000 items. Rotate before hitting that ceiling — at 100–500 photos/day, budget rotation roughly every 6–10 months and track the current album's item count via the iOS Photos app share sheet.

## Steps

1. Confirm no import is currently running: `GET /health` on the deployed Worker must return HTTP 200 with `"ok": true` and `"importRunning": false`. Otherwise wait for the current `ImportWorkflow` to reach a terminal state and check again.
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
5. Run the setup validator to confirm the new album is reachable; marker detection remains covered by the recorded Phase 0 report and automated fixture tests:
   ```bash
   curl --fail-with-body \
     -H "Authorization: Bearer $ADMIN_ROUTE_TOKEN" \
     "$WORKER_BASE_URL/setup"
   ```
   Expected: `"icloud_phase_zero"` check `"ok": true`.
6. Leave the previous album unchanged and do not delete or unshare it — it remains the permanent archive for its date range. D1 keys every `photo_assets` row by `(source_album_id, apple_photo_id)`, so identifiers from the old and new album can never collide even though Apple reuses photo IDs across separate albums.
7. Run `/upload` once manually to confirm the new album produces a normal import against the fresh checkpoint.
8. Record the rotation in the table below.

| Date | Old album (archived) | New album (active) | Reason |
|---|---|---|---|

Append one row after every rotation. Record internal album names only; never record public links or tokens.
```

- [ ] **Step 2: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/album-rotation.md
git commit -m "docs: add iCloud Shared Album rotation runbook"
```

---

### Task 14: Credential rotation runbook

**Files:**
- Create: `docs/runbooks/credential-rotation.md`

**Interfaces:**
- Consumes: every Cloudflare secret binding, authenticated `/setup` and `/usage` behavior, `npm run smoke`, signed-asset TTL, and provider-specific credential ownership rules.
- Produces: no-code per-credential rotation and verification procedure used by final handoff acceptance.

- [ ] **Step 1: Write the runbook**

```markdown
# Credential Rotation Runbook

Every secret in `wrangler.jsonc`/`wrangler secret put` can be rotated without a code change — this is the property the handoff acceptance test (Task 16) proves for one credential.

## General procedure (applies to every secret)

1. Generate/obtain the new credential from the issuing system (Airtable personal access token, LINE channel access token, Google service-account key, Anthropic API key, or a fresh iCloud album token per the rotation runbook).
2. Set the credential being rotated with its exact command:
   ```bash
   npx wrangler secret put AIRTABLE_TOKEN --env production
   npx wrangler secret put LINE_CHANNEL_SECRET --env production
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --env production
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON --env production
   npx wrangler secret put ANTHROPIC_API_KEY --env production
   npx wrangler secret put ICLOUD_SHARED_ALBUM_TOKEN --env production
   npx wrangler secret put ASSET_URL_SIGNING_SECRET --env production
   npx wrangler secret put ADMIN_ROUTE_TOKEN --env production
   ```
   Run only command for credential being rotated. For `ADMIN_ROUTE_TOKEN`, export new value as `ADMIN_ROUTE_TOKEN` before steps 3–4.
3. Run the setup validator to confirm the new credential is recognized:
   ```bash
   curl --fail-with-body \
     -H "Authorization: Bearer $ADMIN_ROUTE_TOKEN" \
     "$WORKER_BASE_URL/setup"
   ```
   Expected: the check tied to that credential (`airtable_schema`, `line_webhook_config`, `google_template_access`, `claude_credential`, or `icloud_phase_zero`) reports `"ok": true`.
4. Run the smoke test to prove an end-to-end operation using the new credential succeeds:
   ```bash
   npm run smoke
   ```
5. Only after the smoke test passes, revoke the old credential at the issuing system. Never revoke before the new one is confirmed working — this avoids a self-inflicted outage.
6. Record the rotation below.

## Per-credential notes

- **`AIRTABLE_TOKEN`**: create the new personal access token with identical scopes (`data.records:read`, `data.records:write`, `schema.bases:read`) restricted to the same base before rotating; revoke the old token in Airtable's developer hub after step 5.
- **`LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN`**: issued together in the LINE Developers console; rotate both in the same window since a mismatched pair fails webhook signature verification.
- **`GOOGLE_SERVICE_ACCOUNT_JSON`**: create a new key for the existing service account (do not create a new service account, since Drive folder sharing is already scoped to the existing one) via Google Cloud Console → IAM → Service Accounts → Keys → Add Key; deactivate the old key after step 5.
- **`ANTHROPIC_API_KEY`**: create a new key in the Anthropic Console under the same workspace; revoke the old key after step 5.
- **`ICLOUD_SHARED_ALBUM_TOKEN`**: rotating this token alone (without creating a new album) only makes sense if the public share link was regenerated for the same album; if the 5,000-item limit is the reason, use the Album Rotation Runbook instead, which also sets a new cutoff date.
- **`ASSET_URL_SIGNING_SECRET`**: existing signed URLs expire and become invalid after rotation. Wait at least 15 minutes—the maximum planned signed-URL TTL—before revoking any separately stored old value.
- **`ADMIN_ROUTE_TOKEN`**: update operator password storage and current shell immediately. Verify missing and old bearer values return 401, then verify new bearer succeeds on `/setup` and `/usage`.

## Rotation log

| Date | Secret | Reason | Verified via |
|---|---|---|---|

Append one row after each successful rotation. Record the secret name and verification commands, never the old or new value.
```

- [ ] **Step 2: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/credential-rotation.md
git commit -m "docs: add credential rotation runbook"
```

---

### Task 15: Smoke test script and fresh-account rehearsal

**Files:**
- Create: `scripts/smoke-test.ts`
- Test: `test/acceptance/smoke.test.ts`

**Interfaces:**
- Consumes: response contracts exposed by the deployed Worker's `GET /health`, authenticated `GET /setup`, authenticated `GET /usage`, and signed `POST /line/webhook` routes. The smoke script remains non-mutating: it does not trigger `/upload`, `/docs`, inventory changes, or the budget alarm.
- Produces: a `main()` CLI entrypoint invoked by `WORKER_BASE_URL=... ADMIN_ROUTE_TOKEN=... LINE_CHANNEL_SECRET=... npm run smoke`; no other code depends on this script.

- [ ] **Step 1: Write the failing unit test for the smoke check logic**

```ts
// test/acceptance/smoke.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  runSmokeChecks,
  signLineBodyForSmoke,
} from "../../scripts/smoke-test";

const baseUrl = "https://worker.example";
const adminToken = "admin-secret";
const lineSecret = "line-secret";

describe("runSmokeChecks", () => {
  it("checks auth rejection, setup, usage, and real LINE HMAC", async () => {
    const lineBody = JSON.stringify({ events: [] });
    const expectedSignature = await signLineBodyForSmoke(
      lineSecret,
      lineBody,
    );
    const fakeFetch = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const authorization = new Headers(init?.headers)
        .get("authorization");
      if (url.endsWith("/health")) {
        return Response.json({ ok: true });
      }
      if (url.endsWith("/setup") && !authorization) {
        return Response.json(
          { error: "unauthorized" },
          { status: 401 },
        );
      }
      if (url.endsWith("/setup")) {
        expect(authorization).toBe(`Bearer ${adminToken}`);
        return Response.json({ ok: true, checks: [] });
      }
      if (url.endsWith("/usage")) {
        expect(authorization).toBe(`Bearer ${adminToken}`);
        return Response.json({
          yearMonth: "2026-09",
          estimatedUsd: 0,
          estimatedThb: 0,
          overBudget: false,
          breakdown: {},
        });
      }
      if (url.endsWith("/line/webhook")) {
        expect(init?.body).toBe(lineBody);
        expect(new Headers(init?.headers).get("x-line-signature"))
          .toBe(expectedSignature);
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const result = await runSmokeChecks(
      baseUrl,
      adminToken,
      lineSecret,
      fakeFetch as typeof fetch,
    );

    expect(result.passed).toBe(true);
    expect(result.steps.map((step) => step.name)).toEqual([
      "health",
      "setup_auth",
      "setup",
      "usage",
      "line_signature",
    ]);
  });

  it("fails fast and names failed setup dependency", async () => {
    const fakeFetch = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return Response.json({ ok: true });
      }
      if (
        url.endsWith("/setup") &&
        !new Headers(init?.headers).has("authorization")
      ) {
        return Response.json(
          { error: "unauthorized" },
          { status: 401 },
        );
      }
      return Response.json({
        ok: false,
        checks: [{
          name: "claude_credential",
          ok: false,
          detail: "missing",
        }],
      }, { status: 503 });
    });

    const result = await runSmokeChecks(
      baseUrl,
      adminToken,
      lineSecret,
      fakeFetch as typeof fetch,
    );

    expect(result.passed).toBe(false);
    expect(result.steps.find((step) => step.name === "setup")?.detail)
      .toContain("claude_credential");
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/acceptance/smoke.test.ts`
Expected: FAIL — `runSmokeChecks` not exported.

- [ ] **Step 3: Implement the smoke script**

```ts
// scripts/smoke-test.ts
import { z } from "zod";

const HealthSchema = z.object({ ok: z.boolean() });
const SetupSchema = z.object({
  ok: z.boolean(),
  checks: z.array(z.object({
    name: z.string(),
    ok: z.boolean(),
    detail: z.string(),
  })),
});
const UsageSchema = z.object({
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
  estimatedUsd: z.number().nonnegative(),
  estimatedThb: z.number().nonnegative(),
  overBudget: z.boolean(),
  breakdown: z.record(z.string(), z.number()),
});

export interface SmokeStep {
  name: string;
  ok: boolean;
  detail: string;
}
export interface SmokeResult {
  passed: boolean;
  steps: SmokeStep[];
}

export async function signLineBodyForSmoke(
  secret: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  ));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export async function runSmokeChecks(
  baseUrl: string,
  adminToken: string,
  lineChannelSecret: string,
  fetchFn: typeof fetch,
): Promise<SmokeResult> {
  const steps: SmokeStep[] = [];
  const stop = () => ({ passed: false, steps });
  const adminHeaders = {
    authorization: `Bearer ${adminToken}`,
  };

  const healthResponse = await fetchFn(`${baseUrl}/health`);
  const health = HealthSchema.parse(await healthResponse.json());
  steps.push({
    name: "health",
    ok: healthResponse.ok && health.ok,
    detail: healthResponse.ok ? "reachable" : `HTTP ${healthResponse.status}`,
  });
  if (!steps.at(-1)!.ok) return stop();

  const unauthorizedSetup = await fetchFn(`${baseUrl}/setup`);
  steps.push({
    name: "setup_auth",
    ok: unauthorizedSetup.status === 401,
    detail: `missing bearer returned HTTP ${unauthorizedSetup.status}`,
  });
  if (!steps.at(-1)!.ok) return stop();

  const setupResponse = await fetchFn(`${baseUrl}/setup`, {
    headers: adminHeaders,
  });
  const setup = SetupSchema.parse(await setupResponse.json());
  const failing = setup.checks.filter((check) => !check.ok);
  steps.push({
    name: "setup",
    ok: setupResponse.ok && setup.ok,
    detail: setup.ok
      ? "all eleven checks ok"
      : failing.map((check) =>
          `${check.name}: ${check.detail}`,
        ).join("; "),
  });
  if (!steps.at(-1)!.ok) return stop();

  const usageResponse = await fetchFn(`${baseUrl}/usage`, {
    headers: adminHeaders,
  });
  const usage = UsageSchema.parse(await usageResponse.json());
  steps.push({
    name: "usage",
    ok: usageResponse.ok,
    detail: `${usage.yearMonth}: ${usage.estimatedThb.toFixed(2)} THB`,
  });
  if (!steps.at(-1)!.ok) return stop();

  const lineBody = JSON.stringify({ events: [] });
  const lineSignature = await signLineBodyForSmoke(
    lineChannelSecret,
    lineBody,
  );
  const webhookResponse = await fetchFn(`${baseUrl}/line/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-line-signature": lineSignature,
    },
    body: lineBody,
  });
  steps.push({
    name: "line_signature",
    ok: webhookResponse.ok,
    detail: webhookResponse.ok
      ? "valid HMAC accepted"
      : `HTTP ${webhookResponse.status}`,
  });

  return {
    passed: steps.every((step) => step.ok),
    steps,
  };
}

async function main(): Promise<void> {
  const baseUrl = process.env.WORKER_BASE_URL;
  const adminToken = process.env.ADMIN_ROUTE_TOKEN;
  const lineSecret = process.env.LINE_CHANNEL_SECRET;
  if (!baseUrl || !adminToken || !lineSecret) {
    throw new Error(
      "Set WORKER_BASE_URL, ADMIN_ROUTE_TOKEN, and LINE_CHANNEL_SECRET",
    );
  }
  const result = await runSmokeChecks(
    baseUrl.replace(/\/$/, ""),
    adminToken,
    lineSecret,
    fetch,
  );
  for (const step of result.steps) {
    console.log(
      `${step.ok ? "PASS" : "FAIL"} ${step.name}: ${step.detail}`,
    );
  }
  console.log(
    result.passed ? "SMOKE TEST PASSED" : "SMOKE TEST FAILED",
  );
  if (!result.passed) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/acceptance/smoke.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Fresh-account rehearsal**

Execute the full Deployment Runbook (Task 11) end-to-end against a throwaway/free-tier Cloudflare account distinct from the customer's real account — this proves the runbook contains no undocumented manual step and no hidden dependency on prior account state:

1. Follow `docs/runbooks/deployment.md` steps 1–10 exactly as written, using a dedicated test Airtable base, LINE channel/group, Google Drive folder/template, Anthropic workspace key, and iCloud Shared Album. Record their exact IDs while following the runbook; do not invent placeholder IDs.
2. At step 10, run `npm run smoke` with the exported `WORKER_BASE_URL`, `ADMIN_ROUTE_TOKEN`, and `LINE_CHANNEL_SECRET`, then confirm `SMOKE TEST PASSED`.
3. Note any step in the runbook that required tribal knowledge not written down; fix `docs/runbooks/deployment.md` to close the gap.
4. After recording the successful rehearsal, delete only the dedicated Cloudflare test resources:
   ```bash
   npx wrangler delete --env staging
   npx wrangler d1 delete snazzy-automation-staging
   npx wrangler r2 bucket delete snazzy-automation-staging-images
   ```
   Remove dedicated external test resources through their owning consoles only after confirming they are not shared with production.

- [ ] **Step 6: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 7: Commit**

```bash
git add scripts/smoke-test.ts test/acceptance/smoke.test.ts
git commit -m "feat: add authenticated deployment smoke checks"
```

---

### Task 16: Handoff acceptance checklist and full suite run

**Files:**
- Create: `docs/runbooks/handoff-acceptance.md`

**Interfaces:**
- Consumes: Phase 0 report, all focused and acceptance suites, six D1 migration files, real staging/production bindings, setup and smoke results, rotation rehearsals, Cloudflare notifications, and customer-owned credential evidence from Tasks 1–15.
- Produces: final auditable release gate; production handoff is complete only when every checklist item is checked with actual evidence.

- [ ] **Step 1: Write the checklist, mirroring the index's Plan Completion Definition and spec §18 handoff acceptance**

```markdown
# Handoff Acceptance Checklist

Run in order. Every item must be checked before customer handoff is considered complete.

- [ ] Phase 0 report (`docs/feasibility/icloud-phase-0-report.md`) says `PASS`.
- [ ] `npm run check` passes on `main` with zero failing tests.
- [ ] `npm run test:acceptance` passes, covering:
  - [ ] `test/acceptance/retry-exhaustion.test.ts` — retry exhaustion and sibling-group isolation.
  - [ ] `test/acceptance/import-batches.test.ts` — all 10 production-sized batches.
  - [ ] `test/acceptance/publication.test.ts` — missing-field block, first-four ordering, one-doc-per-date.
  - [ ] `test/acceptance/line-acceptance.test.ts` — at least 30 parser/command cases.
  - [ ] `test/icloud/redaction-audit.test.ts` — no secret or signed URL logged by the iCloud boundary.
  - [ ] `test/acceptance/smoke.test.ts` — smoke-check logic unit tests.
- [ ] D1 migrations apply cleanly to a fresh local database: `npm run db:migrate:local` from a dropped/recreated local D1.
- [ ] D1 migrations apply cleanly to fresh staging and production databases (proven during Task 15's fresh-account rehearsal).
- [ ] Real staging and production D1 `database_id` values are present in `wrangler.jsonc`; neither binding contains an omitted or example ID.
- [ ] Missing and wrong bearer tokens return HTTP 401 from `/setup` and `/usage` before any dependency access.
- [ ] Authenticated `GET /setup` on staging returns `"ok": true` for all eleven named checks.
- [ ] Authenticated `GET /setup` on production returns `"ok": true` for all eleven named checks.
- [ ] Staging `npm run smoke`, with staging environment variables exported, prints `SMOKE TEST PASSED` and proves a real LINE HMAC is accepted.
- [ ] Production `npm run smoke`, with production environment variables exported, prints `SMOKE TEST PASSED` and proves a real LINE HMAC is accepted.
- [ ] Fresh-account rehearsal (Task 15, Step 5) completed on a dedicated Cloudflare test account using only `docs/runbooks/deployment.md`, with zero undocumented manual steps.
- [ ] `ADMIN_ROUTE_TOKEN` rotated on production with no code change; old token returns HTTP 401 and new token succeeds on authenticated `/setup`, `/usage`, and `npm run smoke`.
- [ ] One external-service credential rotated on production following `docs/runbooks/credential-rotation.md` with no code change, verified via authenticated `/setup` and `npm run smoke`.
- [ ] `docs/runbooks/operations.md` change log has both native Cloudflare Notification policies recorded (Billing Usage Alert, R2 Storage).
- [ ] Authenticated `GET /usage` on production returns a validated monthly report with plausible `estimatedThb` (`฿0–1000` for a fresh environment with no traffic yet).
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

This plan is complete only when every box in `docs/runbooks/handoff-acceptance.md` (Task 16) is checked, matching the index's global "Plan Completion Definition":

- Phase 0 report passes every iCloud gate.
- `npm run check` passes.
- D1 migrations apply to fresh local, staging, and production databases.
- Ten production-sized import batches meet acceptance criteria.
- Publication tests prove missing-data block and one-final-document invariant.
- Thirty LINE parser/command cases pass.
- Fresh customer-owned deployment succeeds from runbook.
- One credential rotation succeeds without code changes.
