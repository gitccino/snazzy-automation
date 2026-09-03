# Snazzy Import Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Cloudflare D1/R2-backed import pipeline that turns a stable iCloud Shared Album snapshot into marker-grouped, content-addressed R2 assets and one Airtable Product row per group, with atomic Product ID allocation, per-group retry/rollback, checkpoint-safe resumption, a Thai LINE import summary, and cron/`/upload` triggers.

**Architecture:** `ImportWorkflow` (Cloudflare Workflows) wraps a plain, dependency-injected `import/service.ts` orchestration layer in durable `step.do()` calls. D1 repositories own all import state (sequence, runs, assets, groups, audit). R2 stores every original once under its content hash; Airtable is written to only after a group's full payload is built and verified. Retries are owned by the Workflow step boundary, not by the service functions or the Airtable/LINE clients.

**Tech Stack:** TypeScript, Cloudflare Workers, Cloudflare Workflows, D1, R2, npm, Vitest 4.1+, `@cloudflare/vitest-plugin`, Zod, native `fetch`.

**Spec:** `docs/superpowers/specs/2026-09-01-snazzy-automation-design.md`

## Global Constraints

- Dedicated customer-owned staging and production deployments.
- Runtime timezone: `Asia/Bangkok`.
- Import volume: 100–500 photos/day; normal product group: 9–15 photos.
- Import starts only after documented 30-minute upload cutoff.
- Product IDs use `A-<NUMBER>`; D1 becomes sole sequence authority after one-time Airtable bootstrap.
- Original images remain in private R2 indefinitely under content hash.
- Marker image never becomes Product attachment.
- Successful Product rows remain when another group fails.
- Retry transient workflow steps five times with exponential backoff.
- `/soldout` and `/revert` rules are out of scope for this plan (LINE inventory plan).
- Only allowlisted LINE group may execute commands; every LINE webhook signature is verified — webhook handling itself is out of scope for this plan, but the import summary push message reuses the same channel access token and must never log it.
- Never log credentials, public-album token/link, signed URLs, Product images, or raw external response bodies containing them.
- MVP excludes admin dashboard, AI photo grouping, always-on Mac, VPS, Redis, Postgres, n8n, Make, and automatic social publication.
- Use native `fetch` routing; do not add a web framework.
- Use current Cloudflare Vitest plugin: `@cloudflare/vitest-plugin` with Vitest 4.1 or later; do not use removed `@cloudflare/vitest-pool-workers` APIs.
- Cloudflare compatibility date must be `2026-09-01` or later and include `nodejs_compat`.
- Every non-trivial parser, state transition, money mutation, and trust boundary starts with a failing test.
- Every task ends with focused tests, `npm run check`, and a commit.

---

## Foundation Interfaces This Plan Extends

Phase 0 must have passed before this plan starts. Foundation already provides `OperationalError`, `isRetryable`, `sha256Hex`, `newCorrelationId`, `Clock`, `nowBangkokIso`, `createLogger`, `MARKER_PAYLOAD`, `isMarkerImage`, `SourcePhoto`, `AlbumSnapshot`, `ImageSource`, `deriveSourceAlbumId`, and `createICloudClient`. This plan extends `AppConfig`, `Env`, Bangkok date helpers, and test helpers once in Task 0; Task 8 adds the production Cloudflare Images marker-normalization adapter; later tasks consume those exact names without redefining them.

---

### Task 0: Extend shared configuration, bindings, time, and test helpers

**Files:**
- Modify: `src/config.ts`
- Modify: `src/env.ts`
- Modify: `src/shared/time.ts`
- Modify: `test/config.test.ts`
- Modify: `test/shared/time.test.ts`
- Modify: `test/helpers/env.ts`
- Modify: `test/helpers/fakes.ts`

**Interfaces:**
- Consumes: foundation `AppConfig`, `parseConfig`, `Clock`, `Env`, and `createTestEnv`.
- Produces: import runtime config fields `importCron`, `importRetryLimit`, `productIdInitialNumber`, `firstImportCutoffDate`, `airtableBaseId`, `airtableProductsTableId`, `lineAllowedGroupId`, `publicBaseUrl`; bindings `DB`, `IMAGES_BUCKET`, `IMAGES`, `IMPORT_WORKFLOW`, `AIRTABLE_TOKEN`, `LINE_CHANNEL_ACCESS_TOKEN`, `ASSET_URL_SIGNING_SECRET`, `ADMIN_ROUTE_TOKEN`; `todayBangkokDate(clock)`; and reusable `testEnv`, `fixedClock`, `sequentialIdGenerator`, `fakeFetch` helpers.

- [ ] **Step 1: Extend the failing config and time tests**

```ts
// replace the successful parse case in test/config.test.ts
const validRawConfig = {
  TIME_ZONE: "Asia/Bangkok",
  UPLOAD_CUTOFF_MINUTES: 30,
  PRODUCT_ID_PREFIX: "A",
  IMPORT_CRON: "0 23 * * *",
  IMPORT_RETRY_LIMIT: 5,
  PRODUCT_ID_INITIAL_NUMBER: 1,
  FIRST_IMPORT_CUTOFF_DATE: "2026-09-01T00:00:00.000Z",
  AIRTABLE_BASE_ID: "appBase",
  AIRTABLE_PRODUCTS_TABLE_ID: "tblProducts",
  LINE_ALLOWED_GROUP_ID: "Cgroup",
  PUBLIC_BASE_URL: "https://snazzy-staging.example.workers.dev",
} as const;

it("parses the import uppercase JSON contract into camel-case runtime fields", () => {
  const config = parseConfig(JSON.stringify(validRawConfig));

  expect(config).toEqual({
    timeZone: "Asia/Bangkok",
    uploadCutoffMinutes: 30,
    productIdPrefix: "A",
    importCron: "0 23 * * *",
    importRetryLimit: 5,
    productIdInitialNumber: 1,
    firstImportCutoffDate: "2026-09-01T00:00:00.000Z",
    airtableBaseId: "appBase",
    airtableProductsTableId: "tblProducts",
    lineAllowedGroupId: "Cgroup",
    publicBaseUrl: "https://snazzy-staging.example.workers.dev",
  });
});

it("rejects any import retry count other than five", () => {
  expect(() => parseConfig({
    ...validRawConfig,
    IMPORT_RETRY_LIMIT: 4,
  })).toThrow();
});
```

```ts
// append to test/shared/time.test.ts
import { todayBangkokDate } from "../../src/shared/time";

it("returns the Bangkok calendar date across a UTC day boundary", () => {
  const clock = { now: () => new Date("2026-09-01T18:30:00.000Z") };
  expect(todayBangkokDate(clock)).toBe("2026-09-02");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/config.test.ts test/shared/time.test.ts`
Expected: FAIL because import config fields and `todayBangkokDate` do not exist.

- [ ] **Step 3: Replace `src/config.ts` with the extended exact schema**

```ts
import { z } from "zod";

const RawAppConfigSchema = z.object({
  TIME_ZONE: z.literal("Asia/Bangkok"),
  UPLOAD_CUTOFF_MINUTES: z.number().int().positive(),
  PRODUCT_ID_PREFIX: z.string().min(1),
  IMPORT_CRON: z.string().min(1),
  IMPORT_RETRY_LIMIT: z.literal(5),
  PRODUCT_ID_INITIAL_NUMBER: z.number().int().positive(),
  FIRST_IMPORT_CUTOFF_DATE: z.string().datetime().nullable(),
  AIRTABLE_BASE_ID: z.string().min(1),
  AIRTABLE_PRODUCTS_TABLE_ID: z.string().min(1),
  LINE_ALLOWED_GROUP_ID: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url(),
});

export interface AppConfig {
  timeZone: "Asia/Bangkok";
  uploadCutoffMinutes: number;
  productIdPrefix: string;
  importCron: string;
  importRetryLimit: 5;
  productIdInitialNumber: number;
  firstImportCutoffDate: string | null;
  airtableBaseId: string;
  airtableProductsTableId: string;
  lineAllowedGroupId: string;
  publicBaseUrl: string;
}

export function parseConfig(raw: unknown): AppConfig {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  const parsed = RawAppConfigSchema.parse(value);
  return {
    timeZone: parsed.TIME_ZONE,
    uploadCutoffMinutes: parsed.UPLOAD_CUTOFF_MINUTES,
    productIdPrefix: parsed.PRODUCT_ID_PREFIX,
    importCron: parsed.IMPORT_CRON,
    importRetryLimit: parsed.IMPORT_RETRY_LIMIT,
    productIdInitialNumber: parsed.PRODUCT_ID_INITIAL_NUMBER,
    firstImportCutoffDate: parsed.FIRST_IMPORT_CUTOFF_DATE,
    airtableBaseId: parsed.AIRTABLE_BASE_ID,
    airtableProductsTableId: parsed.AIRTABLE_PRODUCTS_TABLE_ID,
    lineAllowedGroupId: parsed.LINE_ALLOWED_GROUP_ID,
    publicBaseUrl: parsed.PUBLIC_BASE_URL,
  };
}
```

- [ ] **Step 4: Extend `src/env.ts` without moving secrets into config**

```ts
import type { Workflow } from "cloudflare:workers";
export type { Clock } from "./shared/time";
export type IdGenerator = { next(): string };
export type Fetcher = typeof fetch;

export interface Env {
  DB: D1Database;
  IMAGES_BUCKET: R2Bucket;
  IMAGES: ImagesBinding;
  IMPORT_WORKFLOW: Workflow<{ importRunId: string; sourceAlbumId: string; trigger: "cron" | "line" | "admin" }>;
  AIRTABLE_TOKEN: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  ICLOUD_SHARED_ALBUM_TOKEN: string;
  ASSET_URL_SIGNING_SECRET: string;
  ADMIN_ROUTE_TOKEN: string;
  APP_CONFIG_JSON: string;
}
```

- [ ] **Step 5: Add the Bangkok date helper**

```ts
// append to src/shared/time.ts
export function todayBangkokDate(clock: Clock): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(clock.now());
}
```

- [ ] **Step 6: Extend deterministic test helpers**

```ts
// replace test/helpers/env.ts
import { env } from "cloudflare:test";
import type { Env } from "../../src/env";

export interface TestEnvConfig {
  ICLOUD_SHARED_ALBUM_TOKEN: string;
  AIRTABLE_TOKEN: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  ASSET_URL_SIGNING_SECRET: string;
  ADMIN_ROUTE_TOKEN: string;
  APP_CONFIG_JSON: string;
}

export function createTestEnv(overrides: Partial<TestEnvConfig> = {}): TestEnvConfig {
  return {
    ICLOUD_SHARED_ALBUM_TOKEN: "TEST-TOKEN-ABC123",
    AIRTABLE_TOKEN: "test-airtable-token",
    LINE_CHANNEL_ACCESS_TOKEN: "test-line-token",
    ASSET_URL_SIGNING_SECRET: "test-signing-secret",
    ADMIN_ROUTE_TOKEN: "test-admin-route-token",
    APP_CONFIG_JSON: JSON.stringify({
      TIME_ZONE: "Asia/Bangkok",
      UPLOAD_CUTOFF_MINUTES: 30,
      PRODUCT_ID_PREFIX: "A",
      IMPORT_CRON: "0 23 * * *",
      IMPORT_RETRY_LIMIT: 5,
      PRODUCT_ID_INITIAL_NUMBER: 1,
      FIRST_IMPORT_CUTOFF_DATE: null,
      AIRTABLE_BASE_ID: "appTest",
      AIRTABLE_PRODUCTS_TABLE_ID: "tblProducts",
      LINE_ALLOWED_GROUP_ID: "CtestGroup",
      PUBLIC_BASE_URL: "https://example.workers.dev",
    }),
    ...overrides,
  };
}

export function testEnv(): Env {
  return env as Env;
}
```

```ts
// test/helpers/fakes.ts
import type { Clock, Fetcher, IdGenerator } from "../../src/env";

export function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

export function sequentialIdGenerator(prefix: string): IdGenerator {
  let next = 1;
  return { next: () => `${prefix}-${next++}` };
}

export function fakeFetch(
  handlers: Array<{
    match(request: Request): boolean;
    respond(request: Request): Response | Promise<Response>;
  }>,
): Fetcher {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const handler = handlers.find((candidate) => candidate.match(request));
    if (!handler) throw new Error(`No fake fetch handler for ${request.method} ${request.url}`);
    return handler.respond(request);
  }) as Fetcher;
}
```

- [ ] **Step 7: Run focused and full checks**

Run: `npm test -- test/config.test.ts test/shared/time.test.ts test/smoke.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/env.ts src/shared/time.ts test/config.test.ts test/shared/time.test.ts test/helpers/env.ts test/helpers/fakes.ts
git commit -m "feat(import): extend shared import configuration and helpers"
```

---

### Task 1: D1 schema for import state

**Files:**
- Create: `migrations/0001_initial.sql`
- Modify: `wrangler.jsonc`
- Modify: `vitest.config.ts`
- Create: `test/apply-migrations.ts`
- Test: `test/db/migrations.test.ts`

**Interfaces:**
- Consumes: current `cloudflareTest` plugin setup and `testEnv()` from Task 0.
- Produces: local D1/R2 test bindings, `TEST_MIGRATIONS`, automatic migration application, and tables `sequences`, `import_runs`, `photo_assets`, `product_groups`, `audit_events` consumed by every later task through `env.DB`.

- [ ] **Step 1: Add local D1/R2 test bindings and migration setup**

```jsonc
// add these top-level members to wrangler.jsonc
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
]
```

```ts
// replace vitest.config.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(root, "migrations")),
          ASSET_URL_SIGNING_SECRET: "test-secret",
          ADMIN_ROUTE_TOKEN: "test-admin-route-token",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
```

```ts
// test/apply-migrations.ts
import { applyD1Migrations, env } from "cloudflare:test";

const bindings = env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
```

- [ ] **Step 2: Write the failing test**

```ts
// test/db/migrations.test.ts
import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";

describe("0001_initial migration", () => {
  it("creates every import-scope table", async () => {
    const env = testEnv();
    const rows = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
    ).all<{ name: string }>();
    const names = rows.results.map((r) => r.name);
    for (const table of ["sequences", "import_runs", "import_checkpoints", "photo_assets", "product_groups", "audit_events"]) {
      expect(names).toContain(table);
    }
  });

  it("allows one photo_assets row per (source_album_id, apple_photo_id)", async () => {
    const env = testEnv();
    const runId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO import_runs (id, source_album_id, trigger, status, started_at) VALUES (?, 'album-1', 'cron', 'running', '2026-09-01T00:00:00.000Z')`
    ).bind(runId).run();
    await env.DB.prepare(
      `INSERT INTO photo_assets (id, source_album_id, apple_photo_id, content_hash, r2_key, position, is_marker, import_run_id, created_at)
       VALUES (?, 'album-1', 'apple-1', 'hash-1', 'assets/hash-1.jpg', 1, 0, ?, '2026-09-01T00:00:00.000Z')`
    ).bind(crypto.randomUUID(), runId).run();
    await expect(
      env.DB.prepare(
        `INSERT INTO photo_assets (id, source_album_id, apple_photo_id, content_hash, r2_key, position, is_marker, import_run_id, created_at)
         VALUES (?, 'album-1', 'apple-1', 'hash-2', 'assets/hash-2.jpg', 2, 0, ?, '2026-09-01T00:00:00.000Z')`
      ).bind(crypto.randomUUID(), runId).run()
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/db/migrations.test.ts`
Expected: FAIL — `no such table: sequences` (migration file does not exist yet, so `d1_migrations` table has nothing to apply).

- [ ] **Step 4: Write the migration**

```sql
-- migrations/0001_initial.sql

CREATE TABLE sequences (
  name TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL,
  bootstrapped_at TEXT
);

CREATE TABLE import_runs (
  id TEXT PRIMARY KEY,
  source_album_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'line', 'admin')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'completed_with_failures', 'start_failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  orphan_photo_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_import_runs_album ON import_runs(source_album_id, started_at);
CREATE UNIQUE INDEX idx_import_runs_one_running_album
  ON import_runs(source_album_id)
  WHERE status = 'running';

CREATE TABLE import_checkpoints (
  source_album_id TEXT PRIMARY KEY,
  last_position INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE photo_assets (
  id TEXT PRIMARY KEY,
  source_album_id TEXT NOT NULL,
  apple_photo_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  is_marker INTEGER NOT NULL DEFAULT 0,
  import_run_id TEXT NOT NULL REFERENCES import_runs(id),
  created_at TEXT NOT NULL,
  UNIQUE (source_album_id, apple_photo_id)
);
CREATE INDEX idx_photo_assets_content_hash ON photo_assets(content_hash);
CREATE INDEX idx_photo_assets_album_position ON photo_assets(source_album_id, position);

CREATE TABLE product_groups (
  id TEXT PRIMARY KEY,
  import_run_id TEXT NOT NULL REFERENCES import_runs(id),
  ordinal INTEGER NOT NULL,
  group_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'importing', 'succeeded', 'failed')),
  product_id TEXT,
  airtable_record_id TEXT,
  first_photo_id TEXT NOT NULL,
  last_photo_id TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_product_groups_product_id ON product_groups(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_product_groups_airtable_record ON product_groups(airtable_record_id);
CREATE INDEX idx_product_groups_state ON product_groups(state);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  before_value TEXT,
  after_value TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_events_correlation ON audit_events(correlation_id);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/db/migrations.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Apply the migration to the local D1 database used by `wrangler dev`**

Run: `npm run db:migrate:local`
Expected: `Migrations to be applied: 0001_initial.sql` then `✅ ... Executed`

- [ ] **Step 7: Run full check and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add migrations/0001_initial.sql wrangler.jsonc vitest.config.ts test/apply-migrations.ts test/db/migrations.test.ts
git commit -m "feat(db): add import-scope D1 schema"
```

---

### Task 2: Product ID sequence repository

**Files:**
- Create: `src/db/sequence-repository.ts`
- Test: `test/db/sequence-repository.test.ts`

**Interfaces:**
- Consumes: `env.DB: D1Database` (foundation).
- Produces:

```ts
export interface SequenceRepository {
  isBootstrapped(name: string): Promise<boolean>;
  bootstrap(name: string, initialNextValue: number): Promise<void>;
  allocateNext(name: string): Promise<number>;
}
export function createSequenceRepository(db: D1Database): SequenceRepository;
```

Consumed by Task 12 (`import/service.ts`) as `deps.sequences.allocateNext("product_id")`.

- [ ] **Step 1: Write the failing test**

```ts
// test/db/sequence-repository.test.ts
import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";
import { createSequenceRepository } from "../../src/db/sequence-repository";

describe("sequence-repository", () => {
  it("reports not bootstrapped before bootstrap() runs", async () => {
    const repo = createSequenceRepository(testEnv().DB);
    const name = `seq-${crypto.randomUUID()}`;
    expect(await repo.isBootstrapped(name)).toBe(false);
  });

  it("bootstrap sets the starting next_value exactly once", async () => {
    const repo = createSequenceRepository(testEnv().DB);
    const name = `seq-${crypto.randomUUID()}`;
    await repo.bootstrap(name, 500);
    await repo.bootstrap(name, 999); // second call must not move an already-bootstrapped sequence
    expect(await repo.allocateNext(name)).toBe(500);
  });

  it("allocateNext returns strictly increasing, non-repeating numbers under concurrent calls", async () => {
    const repo = createSequenceRepository(testEnv().DB);
    const name = `seq-${crypto.randomUUID()}`;
    await repo.bootstrap(name, 1);
    const allocated = await Promise.all(Array.from({ length: 10 }, () => repo.allocateNext(name)));
    const unique = new Set(allocated);
    expect(unique.size).toBe(10);
    expect(Math.max(...allocated)).toBe(10);
  });

  it("throws when allocating from a sequence that was never bootstrapped", async () => {
    const repo = createSequenceRepository(testEnv().DB);
    await expect(repo.allocateNext(`seq-${crypto.randomUUID()}`)).rejects.toThrow(/not bootstrapped/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/sequence-repository.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/sequence-repository'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/db/sequence-repository.ts

export interface SequenceRepository {
  isBootstrapped(name: string): Promise<boolean>;
  bootstrap(name: string, initialNextValue: number): Promise<void>;
  allocateNext(name: string): Promise<number>;
}

export function createSequenceRepository(db: D1Database): SequenceRepository {
  return {
    async isBootstrapped(name) {
      const row = await db
        .prepare(`SELECT bootstrapped_at FROM sequences WHERE name = ?`)
        .bind(name)
        .first<{ bootstrapped_at: string | null }>();
      return row !== null && row.bootstrapped_at !== null;
    },

    async bootstrap(name, initialNextValue) {
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO sequences (name, next_value, bootstrapped_at) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             next_value = excluded.next_value,
             bootstrapped_at = excluded.bootstrapped_at
           WHERE sequences.bootstrapped_at IS NULL`
        )
        .bind(name, initialNextValue, now)
        .run();
    },

    async allocateNext(name) {
      const result = await db
        .prepare(
          `UPDATE sequences SET next_value = next_value + 1
           WHERE name = ? AND bootstrapped_at IS NOT NULL
           RETURNING next_value - 1 AS allocated`
        )
        .bind(name)
        .first<{ allocated: number }>();
      if (result === null) {
        throw new Error(`sequence "${name}" not bootstrapped`);
      }
      return result.allocated;
    },
  };
}
```

The single `UPDATE ... RETURNING` statement is the atomicity guarantee: D1 serializes writes to one SQLite file, so two concurrent `allocateNext` calls cannot read the same `next_value` before either writes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/db/sequence-repository.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add src/db/sequence-repository.ts test/db/sequence-repository.test.ts
git commit -m "feat(db): add atomic Product ID sequence repository"
```

---

### Task 3: Audit log writer

**Files:**
- Create: `src/db/audit.ts`
- Test: `test/db/audit.test.ts`

**Interfaces:**
- Consumes: `env.DB: D1Database`, `IdGenerator`, `Clock` (foundation).
- Produces:

```ts
export interface AuditEntry {
  correlationId: string;
  actor: string;
  action: string;
  beforeValue: string | null;
  afterValue: string | null;
}
export interface AuditLog { record(entry: AuditEntry): Promise<void>; }
export function createAuditLog(db: D1Database, ids: IdGenerator, clock: Clock): AuditLog;
```

Consumed by Task 12/13 (`import/service.ts`) for `product_id_allocated`, `product_group_succeeded`, and `product_group_failed` events.

- [ ] **Step 1: Write the failing test**

```ts
// test/db/audit.test.ts
import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";
import { createAuditLog } from "../../src/db/audit";
import { fixedClock, sequentialIdGenerator } from "../helpers/fakes";

describe("audit log", () => {
  it("appends one immutable row per record() call", async () => {
    const env = testEnv();
    const log = createAuditLog(env.DB, sequentialIdGenerator("audit"), fixedClock("2026-09-01T09:00:00.000Z"));
    const correlationId = crypto.randomUUID();

    await log.record({ correlationId, actor: "system:import", action: "product_id_allocated", beforeValue: null, afterValue: "A-501" });

    const row = await env.DB
      .prepare(`SELECT correlation_id, actor, action, before_value, after_value, created_at FROM audit_events WHERE correlation_id = ?`)
      .bind(correlationId)
      .first<{ correlation_id: string; actor: string; action: string; before_value: string | null; after_value: string | null; created_at: string }>();

    expect(row).toEqual({
      correlation_id: correlationId,
      actor: "system:import",
      action: "product_id_allocated",
      before_value: null,
      after_value: "A-501",
      created_at: "2026-09-01T09:00:00.000Z",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/audit.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/audit'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/db/audit.ts
import type { Clock, IdGenerator } from "../env";

export interface AuditEntry {
  correlationId: string;
  actor: string;
  action: string;
  beforeValue: string | null;
  afterValue: string | null;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

export function createAuditLog(db: D1Database, ids: IdGenerator, clock: Clock): AuditLog {
  return {
    async record(entry) {
      await db
        .prepare(
          `INSERT INTO audit_events (id, correlation_id, actor, action, before_value, after_value, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(ids.next(), entry.correlationId, entry.actor, entry.action, entry.beforeValue, entry.afterValue, clock.now().toISOString())
        .run();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/db/audit.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add src/db/audit.ts test/db/audit.test.ts
git commit -m "feat(db): add append-only audit log writer"
```

---

### Task 4: Import repository (runs, assets, groups)

**Files:**
- Create: `src/db/import-repository.ts`
- Test: `test/db/import-repository.test.ts`

**Interfaces:**
- Consumes: `env.DB: D1Database`.
- Produces (consumed by Task 12/13 `import/service.ts`):

```ts
export type ProductGroupState = "pending" | "importing" | "succeeded" | "failed";

export interface PhotoAssetRow {
  id: string; sourceAlbumId: string; applePhotoId: string; contentHash: string;
  r2Key: string; position: number; isMarker: boolean; importRunId: string; createdAt: string;
}

export interface ProductGroupRow {
  id: string; importRunId: string; ordinal: number; groupHash: string; state: ProductGroupState;
  productId: string | null; airtableRecordId: string | null; firstPhotoId: string; lastPhotoId: string;
  attemptCount: number; failureReason: string | null; createdAt: string; updatedAt: string;
}

export interface ImportRepository {
  createImportRun(input: { id: string; sourceAlbumId: string; trigger: "cron" | "line" | "admin" }): Promise<void>;
  hasRunningImportRun(sourceAlbumId: string): Promise<boolean>;
  markImportRunStartFailed(id: string): Promise<void>;
  getCheckpoint(sourceAlbumId: string): Promise<number | null>;
  finalizeImportRun(input: {
    id: string;
    sourceAlbumId: string;
    status: "completed" | "completed_with_failures";
    orphanPhotoCount: number;
    checkpointPosition: number;
  }): Promise<void>;

  findAssetByContentHash(contentHash: string): Promise<PhotoAssetRow | null>;
  findAssetByApplePhotoId(sourceAlbumId: string, applePhotoId: string): Promise<PhotoAssetRow | null>;
  listAssetsForAlbum(sourceAlbumId: string): Promise<PhotoAssetRow[]>;
  recordPhotoAsset(input: Omit<PhotoAssetRow, "createdAt">): Promise<void>;

  findGroupByHash(groupHash: string): Promise<ProductGroupRow | null>;
  upsertPendingGroup(input: { id: string; importRunId: string; ordinal: number; groupHash: string; firstPhotoId: string; lastPhotoId: string }): Promise<ProductGroupRow>;
  setGroupState(id: string, state: ProductGroupState, patch?: Partial<{ productId: string; airtableRecordId: string; failureReason: string | null; attemptCount: number }>): Promise<void>;
}

export function createImportRepository(db: D1Database, ids: IdGenerator, clock: Clock): ImportRepository;
```

- [ ] **Step 1: Write the failing test**

```ts
// test/db/import-repository.test.ts
import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";
import { createImportRepository } from "../../src/db/import-repository";
import { fixedClock, sequentialIdGenerator } from "../helpers/fakes";

function repo() {
  return createImportRepository(testEnv().DB, sequentialIdGenerator("row"), fixedClock("2026-09-01T09:00:00.000Z"));
}

describe("import-repository", () => {
  it("creates a running import run and reports it as running", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();
    await r.createImportRun({ id: runId, sourceAlbumId: albumId, trigger: "cron" });
    expect(await r.hasRunningImportRun(albumId)).toBe(true);
    await r.finalizeImportRun({
      id: runId,
      sourceAlbumId: albumId,
      status: "completed",
      orphanPhotoCount: 0,
      checkpointPosition: 42,
    });
    expect(await r.hasRunningImportRun(albumId)).toBe(false);
    expect(await r.getCheckpoint(albumId)).toBe(42);
  });

  it("rejects a second running import for the same album at the database boundary", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    await r.createImportRun({ id: crypto.randomUUID(), sourceAlbumId: albumId, trigger: "cron" });

    await expect(
      r.createImportRun({ id: crypto.randomUUID(), sourceAlbumId: albumId, trigger: "line" }),
    ).rejects.toThrow();
  });

  it("records a photo asset and finds it by apple photo id and by content hash", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();
    await r.createImportRun({ id: runId, sourceAlbumId: albumId, trigger: "cron" });
    await r.recordPhotoAsset({
      id: crypto.randomUUID(), sourceAlbumId: albumId, applePhotoId: "apple-1",
      contentHash: "hash-1", r2Key: "assets/hash-1.jpg", position: 1, isMarker: false, importRunId: runId,
    });

    const byApple = await r.findAssetByApplePhotoId(albumId, "apple-1");
    expect(byApple?.r2Key).toBe("assets/hash-1.jpg");
    const byHash = await r.findAssetByContentHash("hash-1");
    expect(byHash?.applePhotoId).toBe("apple-1");
  });

  it("upsertPendingGroup is idempotent by group hash and preserves existing state", async () => {
    const r = repo();
    const albumId = `album-${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();
    await r.createImportRun({ id: runId, sourceAlbumId: albumId, trigger: "cron" });
    const groupHash = `hash-${crypto.randomUUID()}`;

    const first = await r.upsertPendingGroup({ id: crypto.randomUUID(), importRunId: runId, ordinal: 0, groupHash, firstPhotoId: "apple-1", lastPhotoId: "apple-9" });
    expect(first.state).toBe("pending");

    await r.setGroupState(first.id, "succeeded", { productId: "A-501", airtableRecordId: "rec123" });
    await r.finalizeImportRun({
      id: runId,
      sourceAlbumId: albumId,
      status: "completed",
      orphanPhotoCount: 0,
      checkpointPosition: 9,
    });
    const secondRunId = crypto.randomUUID();
    await r.createImportRun({ id: secondRunId, sourceAlbumId: albumId, trigger: "line" });

    const second = await r.upsertPendingGroup({ id: crypto.randomUUID(), importRunId: secondRunId, ordinal: 0, groupHash, firstPhotoId: "apple-1", lastPhotoId: "apple-9" });
    expect(second.id).toBe(first.id);
    expect(second.state).toBe("succeeded");
    expect(second.productId).toBe("A-501");
  });

  it("setGroupState updates failureReason and attemptCount independently", async () => {
    const r = repo();
    const runId = crypto.randomUUID();
    await r.createImportRun({ id: runId, sourceAlbumId: `album-${crypto.randomUUID()}`, trigger: "cron" });
    const group = await r.upsertPendingGroup({ id: crypto.randomUUID(), importRunId: runId, ordinal: 0, groupHash: `hash-${crypto.randomUUID()}`, firstPhotoId: "apple-1", lastPhotoId: "apple-2" });

    await r.setGroupState(group.id, "failed", { failureReason: "airtable_timeout", attemptCount: 1 });
    const failed = await r.findGroupByHash(group.groupHash);
    expect(failed).toMatchObject({ state: "failed", failureReason: "airtable_timeout", attemptCount: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/import-repository.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/import-repository'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/db/import-repository.ts
import { z } from "zod";
import type { Clock, IdGenerator } from "../env";

export type ProductGroupState = "pending" | "importing" | "succeeded" | "failed";

export interface PhotoAssetRow {
  id: string; sourceAlbumId: string; applePhotoId: string; contentHash: string;
  r2Key: string; position: number; isMarker: boolean; importRunId: string; createdAt: string;
}

export interface ProductGroupRow {
  id: string; importRunId: string; ordinal: number; groupHash: string; state: ProductGroupState;
  productId: string | null; airtableRecordId: string | null; firstPhotoId: string; lastPhotoId: string;
  attemptCount: number; failureReason: string | null; createdAt: string; updatedAt: string;
}

export interface ImportRepository {
  createImportRun(input: { id: string; sourceAlbumId: string; trigger: "cron" | "line" | "admin" }): Promise<void>;
  hasRunningImportRun(sourceAlbumId: string): Promise<boolean>;
  markImportRunStartFailed(id: string): Promise<void>;
  getCheckpoint(sourceAlbumId: string): Promise<number | null>;
  finalizeImportRun(input: {
    id: string;
    sourceAlbumId: string;
    status: "completed" | "completed_with_failures";
    orphanPhotoCount: number;
    checkpointPosition: number;
  }): Promise<void>;
  findAssetByContentHash(contentHash: string): Promise<PhotoAssetRow | null>;
  findAssetByApplePhotoId(sourceAlbumId: string, applePhotoId: string): Promise<PhotoAssetRow | null>;
  listAssetsForAlbum(sourceAlbumId: string): Promise<PhotoAssetRow[]>;
  recordPhotoAsset(input: Omit<PhotoAssetRow, "createdAt">): Promise<void>;
  findGroupByHash(groupHash: string): Promise<ProductGroupRow | null>;
  upsertPendingGroup(input: { id: string; importRunId: string; ordinal: number; groupHash: string; firstPhotoId: string; lastPhotoId: string }): Promise<ProductGroupRow>;
  setGroupState(id: string, state: ProductGroupState, patch?: Partial<{ productId: string; airtableRecordId: string; failureReason: string | null; attemptCount: number }>): Promise<void>;
}

const PhotoAssetDbRowSchema = z.object({
  id: z.string().min(1),
  source_album_id: z.string().min(1),
  apple_photo_id: z.string().min(1),
  content_hash: z.string().min(1),
  r2_key: z.string().min(1),
  position: z.number().int().nonnegative(),
  is_marker: z.union([z.literal(0), z.literal(1)]),
  import_run_id: z.string().min(1),
  created_at: z.string().min(1),
});

const ProductGroupDbRowSchema = z.object({
  id: z.string().min(1),
  import_run_id: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  group_hash: z.string().min(1),
  state: z.enum(["pending", "importing", "succeeded", "failed"]),
  product_id: z.string().min(1).nullable(),
  airtable_record_id: z.string().min(1).nullable(),
  first_photo_id: z.string().min(1),
  last_photo_id: z.string().min(1),
  attempt_count: z.number().int().nonnegative(),
  failure_reason: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

function toAssetRow(input: unknown): PhotoAssetRow {
  const r = PhotoAssetDbRowSchema.parse(input);
  return {
    id: r.id,
    sourceAlbumId: r.source_album_id,
    applePhotoId: r.apple_photo_id,
    contentHash: r.content_hash,
    r2Key: r.r2_key,
    position: r.position,
    isMarker: r.is_marker === 1,
    importRunId: r.import_run_id,
    createdAt: r.created_at,
  };
}

function toGroupRow(input: unknown): ProductGroupRow {
  const r = ProductGroupDbRowSchema.parse(input);
  return {
    id: r.id,
    importRunId: r.import_run_id,
    ordinal: r.ordinal,
    groupHash: r.group_hash,
    state: r.state,
    productId: r.product_id,
    airtableRecordId: r.airtable_record_id,
    firstPhotoId: r.first_photo_id,
    lastPhotoId: r.last_photo_id,
    attemptCount: r.attempt_count,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createImportRepository(db: D1Database, ids: IdGenerator, clock: Clock): ImportRepository {
  return {
    async createImportRun({ id, sourceAlbumId, trigger }) {
      await db
        .prepare(`INSERT INTO import_runs (id, source_album_id, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)`)
        .bind(id, sourceAlbumId, trigger, clock.now().toISOString())
        .run();
    },

    async hasRunningImportRun(sourceAlbumId) {
      const row = await db
        .prepare(`SELECT 1 AS present FROM import_runs WHERE source_album_id = ? AND status = 'running' LIMIT 1`)
        .bind(sourceAlbumId)
        .first<{ present: number }>();
      return row !== null;
    },

    async markImportRunStartFailed(id) {
      await db
        .prepare(
          `UPDATE import_runs
           SET status = 'start_failed', finished_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .bind(clock.now().toISOString(), id)
        .run();
    },

    async getCheckpoint(sourceAlbumId) {
      const row = await db
        .prepare(`SELECT last_position FROM import_checkpoints WHERE source_album_id = ?`)
        .bind(sourceAlbumId)
        .first<{ last_position: number }>();
      return row?.last_position ?? null;
    },

    async finalizeImportRun(input) {
      const now = clock.now().toISOString();
      await db.batch([
        db.prepare(
          `UPDATE import_runs
           SET status = ?, finished_at = ?, orphan_photo_count = ?
           WHERE id = ? AND source_album_id = ? AND status = 'running'`,
        ).bind(input.status, now, input.orphanPhotoCount, input.id, input.sourceAlbumId),
        db.prepare(
          `INSERT INTO import_checkpoints (source_album_id, last_position, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(source_album_id) DO UPDATE SET
             last_position = MAX(import_checkpoints.last_position, excluded.last_position),
             updated_at = excluded.updated_at`,
        ).bind(input.sourceAlbumId, input.checkpointPosition, now),
      ]);
    },

    async findAssetByContentHash(contentHash) {
      const row = await db.prepare(`SELECT * FROM photo_assets WHERE content_hash = ? LIMIT 1`).bind(contentHash).first();
      return row === null ? null : toAssetRow(row as Record<string, unknown>);
    },

    async findAssetByApplePhotoId(sourceAlbumId, applePhotoId) {
      const row = await db
        .prepare(`SELECT * FROM photo_assets WHERE source_album_id = ? AND apple_photo_id = ? LIMIT 1`)
        .bind(sourceAlbumId, applePhotoId)
        .first();
      return row === null ? null : toAssetRow(row as Record<string, unknown>);
    },

    async listAssetsForAlbum(sourceAlbumId) {
      const rows = await db
        .prepare(`SELECT * FROM photo_assets WHERE source_album_id = ? ORDER BY position ASC`)
        .bind(sourceAlbumId)
        .all();
      return rows.results.map((r) => toAssetRow(r as Record<string, unknown>));
    },

    async recordPhotoAsset(input) {
      await db
        .prepare(
          `INSERT INTO photo_assets (id, source_album_id, apple_photo_id, content_hash, r2_key, position, is_marker, import_run_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(input.id, input.sourceAlbumId, input.applePhotoId, input.contentHash, input.r2Key, input.position, input.isMarker ? 1 : 0, input.importRunId, clock.now().toISOString())
        .run();
    },

    async findGroupByHash(groupHash) {
      const row = await db.prepare(`SELECT * FROM product_groups WHERE group_hash = ? LIMIT 1`).bind(groupHash).first();
      return row === null ? null : toGroupRow(row as Record<string, unknown>);
    },

    async upsertPendingGroup(input) {
      const now = clock.now().toISOString();
      await db
        .prepare(
          `INSERT INTO product_groups (id, import_run_id, ordinal, group_hash, state, first_photo_id, last_photo_id, attempt_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?)
           ON CONFLICT(group_hash) DO UPDATE SET
             import_run_id = excluded.import_run_id,
             updated_at = excluded.updated_at`
        )
        .bind(input.id, input.importRunId, input.ordinal, input.groupHash, input.firstPhotoId, input.lastPhotoId, now, now)
        .run();
      const row = await db.prepare(`SELECT * FROM product_groups WHERE group_hash = ?`).bind(input.groupHash).first();
      return toGroupRow(row as Record<string, unknown>);
    },

    async setGroupState(id, state, patch = {}) {
      await db
        .prepare(
          `UPDATE product_groups SET
             state = ?,
             product_id = COALESCE(?, product_id),
             airtable_record_id = COALESCE(?, airtable_record_id),
             failure_reason = ?,
             attempt_count = COALESCE(?, attempt_count),
             updated_at = ?
           WHERE id = ?`
        )
        .bind(
          state,
          patch.productId ?? null,
          patch.airtableRecordId ?? null,
          "failureReason" in patch ? patch.failureReason ?? null : null,
          patch.attemptCount ?? null,
          clock.now().toISOString(),
          id
        )
        .run();
    },
  };
}
```

Note the `upsertPendingGroup` insert-or-noop is deliberate: `group_hash` is a deterministic function of `(sourceAlbumId, orderedPhotoIds)`, so re-running grouping on the same photos across import runs always resolves to the same row instead of creating a duplicate — this is what lets `/upload` "resume" without a special resume flag on the Workflow itself.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/db/import-repository.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add src/db/import-repository.ts test/db/import-repository.test.ts
git commit -m "feat(db): add import runs, assets, and product groups repository"
```

---

### Task 5: Import domain types

**Files:**
- Create: `src/import/types.ts`

**Interfaces:**
- Consumes: `SourcePhoto` from `src/icloud/types.ts` (foundation).
- Produces (fixed by the implementation index, must match exactly):

```ts
export interface ImportWorkflowParams { importRunId: string; sourceAlbumId: string; trigger: "cron" | "line" | "admin"; }
export type ProductGroupState = "pending" | "importing" | "succeeded" | "failed";
export interface OrphanRange {
  firstApplePhotoId: string;
  lastApplePhotoId: string;
  count: number;
}
export interface ProductGroup {
  groupId: string;
  ordinal: number;
  sourceAlbumId: string;
  photos: SourcePhoto[];
}
export interface ImportRunResult {
  importRunId: string;
  succeededProductIds: string[];
  failedGroups: Array<{ groupId: string; productId: string | null; errorCode: string }>;
}
```

This task has no behavior to test — it is a pure type module. It is still its own task because Tasks 8–14 all import from it and none may redefine these shapes locally.

- [ ] **Step 1: Write the file**

```ts
// src/import/types.ts
import type { SourcePhoto } from "../icloud/types";

export interface ImportWorkflowParams {
  importRunId: string;
  sourceAlbumId: string;
  trigger: "cron" | "line" | "admin";
}

export type ProductGroupState = "pending" | "importing" | "succeeded" | "failed";

export interface OrphanRange {
  firstApplePhotoId: string;
  lastApplePhotoId: string;
  count: number;
}

export interface ProductGroup {
  groupId: string;
  ordinal: number;
  sourceAlbumId: string;
  photos: SourcePhoto[];
}

export interface ImportRunResult {
  importRunId: string;
  succeededProductIds: string[];
  failedGroups: Array<{ groupId: string; productId: string | null; errorCode: string }>;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors attributable to `src/import/types.ts`.

- [ ] **Step 3: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 4: Commit**

```bash
git add src/import/types.ts
git commit -m "feat(import): add shared import domain types"
```

---

### Task 6: Content-addressed R2 asset store with signed URLs

**Files:**
- Create: `src/import/asset-store.ts`
- Test: `test/import/asset-store.test.ts`

**Interfaces:**
- Consumes: `env.IMAGES_BUCKET: R2Bucket`, `env.ASSET_URL_SIGNING_SECRET`, `AppConfig.publicBaseUrl`, and `Clock`. Secret and public origin are passed explicitly to `createAssetStore`; neither is persisted with an object.
- Produces (consumed by Task 12 `import/service.ts` and Task 7 `routes/assets.ts`):

```ts
export interface AssetPutResult { r2Key: string; created: boolean; }
export interface AssetStore {
  putIfAbsent(contentHash: string, extension: string, body: ArrayBuffer, contentType: string): Promise<AssetPutResult>;
  signUrl(r2Key: string, ttlSeconds: number): Promise<string>;
}
export function createAssetStore(bucket: R2Bucket, config: { signingSecret: string; publicBaseUrl: string }, clock: Clock): AssetStore;
export function verifyAssetToken(r2Key: string, expiresAtEpochSeconds: number, signatureHex: string, signingSecret: string, nowEpochSeconds: number): Promise<boolean>;
```

- [ ] **Step 1: Write the failing test**

```ts
// test/import/asset-store.test.ts
import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";
import { createAssetStore, verifyAssetToken } from "../../src/import/asset-store";
import { fixedClock } from "../helpers/fakes";

describe("asset-store", () => {
  it("stores a new object once and reports created=true", async () => {
    const store = createAssetStore(testEnv().IMAGES_BUCKET, { signingSecret: "test-secret", publicBaseUrl: "https://example.workers.dev" }, fixedClock("2026-09-01T09:00:00.000Z"));
    const hash = `hash-${crypto.randomUUID()}`;
    const body = new TextEncoder().encode("fake-jpeg-bytes").buffer;

    const first = await store.putIfAbsent(hash, "jpg", body, "image/jpeg");
    expect(first).toEqual({ r2Key: `assets/${hash}.jpg`, created: true });

    const second = await store.putIfAbsent(hash, "jpg", body, "image/jpeg");
    expect(second).toEqual({ r2Key: `assets/${hash}.jpg`, created: false });
  });

  it("signs a URL that verifies before expiry and rejects after expiry", async () => {
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const store = createAssetStore(testEnv().IMAGES_BUCKET, { signingSecret: "test-secret", publicBaseUrl: "https://example.workers.dev" }, clock);
    const url = await store.signUrl("assets/hash-1.jpg", 300);

    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://example.workers.dev");
    const exp = Number(parsed.searchParams.get("exp"));
    const sig = parsed.searchParams.get("sig")!;

    const validNow = Math.floor(new Date("2026-09-01T09:04:00.000Z").getTime() / 1000);
    expect(await verifyAssetToken("assets/hash-1.jpg", exp, sig, "test-secret", validNow)).toBe(true);

    const expiredNow = Math.floor(new Date("2026-09-01T09:06:00.000Z").getTime() / 1000);
    expect(await verifyAssetToken("assets/hash-1.jpg", exp, sig, "test-secret", expiredNow)).toBe(false);
  });

  it("rejects a signature for a different key", async () => {
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const store = createAssetStore(testEnv().IMAGES_BUCKET, { signingSecret: "test-secret", publicBaseUrl: "https://example.workers.dev" }, clock);
    const url = await store.signUrl("assets/hash-1.jpg", 300);
    const parsed = new URL(url);
    const exp = Number(parsed.searchParams.get("exp"));
    const sig = parsed.searchParams.get("sig")!;
    const now = Math.floor(new Date("2026-09-01T09:01:00.000Z").getTime() / 1000);
    expect(await verifyAssetToken("assets/other-key.jpg", exp, sig, "test-secret", now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/import/asset-store.test.ts`
Expected: FAIL — `Cannot find module '../../src/import/asset-store'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/import/asset-store.ts
import type { Clock } from "../env";

export interface AssetPutResult {
  r2Key: string;
  created: boolean;
}

export interface AssetStore {
  putIfAbsent(contentHash: string, extension: string, body: ArrayBuffer, contentType: string): Promise<AssetPutResult>;
  signUrl(r2Key: string, ttlSeconds: number): Promise<string>;
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createAssetStore(bucket: R2Bucket, config: { signingSecret: string; publicBaseUrl: string }, clock: Clock): AssetStore {
  return {
    async putIfAbsent(contentHash, extension, body, contentType) {
      const r2Key = `assets/${contentHash}.${extension}`;
      const created = await bucket.put(r2Key, body, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType },
      });
      return { r2Key, created: created !== null };
    },

    async signUrl(r2Key, ttlSeconds) {
      const expiresAt = Math.floor(clock.now().getTime() / 1000) + ttlSeconds;
      const payload = `${r2Key}:${expiresAt}`;
      const signature = await hmacHex(config.signingSecret, payload);
      const url = new URL(`${config.publicBaseUrl}/assets/${encodeURIComponent(r2Key)}`);
      url.searchParams.set("exp", String(expiresAt));
      url.searchParams.set("sig", signature);
      return url.toString();
    },
  };
}

export async function verifyAssetToken(
  r2Key: string,
  expiresAtEpochSeconds: number,
  signatureHex: string,
  signingSecret: string,
  nowEpochSeconds: number
): Promise<boolean> {
  if (nowEpochSeconds > expiresAtEpochSeconds) {
    return false;
  }
  const expected = await hmacHex(signingSecret, `${r2Key}:${expiresAtEpochSeconds}`);
  if (expected.length !== signatureHex.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signatureHex.charCodeAt(i);
  }
  return diff === 0;
}
```

The signature check uses a constant-time comparison (`diff |=`) so a timing side-channel cannot leak the correct signature one character at a time — this is a trust boundary (Airtable/anyone with the URL fetches through it), so it is not shortened even though the rest of the module is intentionally small.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/import/asset-store.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add src/import/asset-store.ts test/import/asset-store.test.ts
git commit -m "feat(import): add content-addressed R2 asset store with signed URLs"
```

---

### Task 7: Signed asset route

**Files:**
- Create: `src/routes/assets.ts`
- Test: `test/routes/assets.test.ts`
- Modify: `src/router.ts` — register `GET /assets/:key` (see Task 15 for the exact router wiring point; the handler here is written and tested standalone first).

**Interfaces:**
- Consumes: `verifyAssetToken` from Task 6, `env.IMAGES_BUCKET: R2Bucket`, and secret binding `env.ASSET_URL_SIGNING_SECRET`.
- Produces:

```ts
export async function handleGetAsset(request: Request, env: Env, clock: Clock): Promise<Response>;
```

- [ ] **Step 1: Write the failing test**

```ts
// test/routes/assets.test.ts
import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";
import { createAssetStore } from "../../src/import/asset-store";
import { handleGetAsset } from "../../src/routes/assets";
import { fixedClock } from "../helpers/fakes";

describe("GET /assets/:key", () => {
  it("streams the object for a valid, unexpired signature", async () => {
    const env = testEnv();
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const store = createAssetStore(env.IMAGES_BUCKET, { signingSecret: env.ASSET_URL_SIGNING_SECRET, publicBaseUrl: "https://example.workers.dev" }, clock);
    const body = new TextEncoder().encode("fake-jpeg-bytes").buffer;
    const { r2Key } = await store.putIfAbsent(`hash-${crypto.randomUUID()}`, "jpg", body, "image/jpeg");
    const url = await store.signUrl(r2Key, 300);

    const response = await handleGetAsset(new Request(url), env, clock);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("fake-jpeg-bytes");
  });

  it("returns 403 for a missing signature", async () => {
    const env = testEnv();
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const response = await handleGetAsset(new Request("https://example.workers.dev/assets/assets%2Fhash-1.jpg"), env, clock);
    expect(response.status).toBe(403);
  });

  it("returns 403 for an expired signature", async () => {
    const env = testEnv();
    const store = createAssetStore(env.IMAGES_BUCKET, { signingSecret: env.ASSET_URL_SIGNING_SECRET, publicBaseUrl: "https://example.workers.dev" }, fixedClock("2026-09-01T09:00:00.000Z"));
    const { r2Key } = await store.putIfAbsent(`hash-${crypto.randomUUID()}`, "jpg", new ArrayBuffer(0), "image/jpeg");
    const url = await store.signUrl(r2Key, 60);

    const response = await handleGetAsset(new Request(url), env, fixedClock("2026-09-01T09:05:00.000Z"));
    expect(response.status).toBe(403);
  });

  it("returns 404 when the signature is valid but the object was never stored", async () => {
    const env = testEnv();
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const store = createAssetStore(env.IMAGES_BUCKET, { signingSecret: env.ASSET_URL_SIGNING_SECRET, publicBaseUrl: "https://example.workers.dev" }, clock);
    const url = await store.signUrl("assets/never-stored.jpg", 300);
    const response = await handleGetAsset(new Request(url), env, clock);
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routes/assets.test.ts`
Expected: FAIL — `Cannot find module '../../src/routes/assets'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/routes/assets.ts
import type { Env, Clock } from "../env";
import { verifyAssetToken } from "../import/asset-store";

export async function handleGetAsset(request: Request, env: Env, clock: Clock): Promise<Response> {
  const url = new URL(request.url);
  const r2Key = decodeURIComponent(url.pathname.replace(/^\/assets\//, ""));
  const expParam = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");

  if (r2Key === "" || expParam === null || sig === null) {
    return new Response("forbidden", { status: 403 });
  }

  const expiresAt = Number(expParam);
  const nowSeconds = Math.floor(clock.now().getTime() / 1000);
  const valid = await verifyAssetToken(r2Key, expiresAt, sig, env.ASSET_URL_SIGNING_SECRET, nowSeconds);
  if (!valid) {
    return new Response("forbidden", { status: 403 });
  }

  const object = await env.IMAGES_BUCKET.get(r2Key);
  if (object === null) {
    return new Response("not found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=60");
  return new Response(object.body, { status: 200, headers });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/routes/assets.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add src/routes/assets.ts test/routes/assets.test.ts
git commit -m "feat(routes): serve R2 assets behind HMAC-signed, expiring URLs"
```

---

### Task 8: Cloudflare Images marker normalization and marker-to-marker grouping

**Files:**
- Modify: `src/import/marker.ts`
- Create: `src/import/grouping.ts`
- Test: `test/import/marker.test.ts`
- Test: `test/import/grouping.test.ts`

**Interfaces:**
- Consumes: Foundation `isMarkerImage(jpegBytes)`; Cloudflare Images binding chain; pure caller-supplied photo list.
- Produces `MarkerDetector.detect(bytes: ArrayBuffer): Promise<boolean>` and `createMarkerDetector(images: MarkerImagesBinding): MarkerDetector`, consumed by Task 12 and Task 14.
- Produces (consumed by Task 12 `import/service.ts`):

```ts
export interface GroupingPhoto {
  applePhotoId: string;
  position: number;
  isMarker: boolean;
  r2Key: string;
}
export interface GroupedProduct {
  ordinal: number;
  markerPhotoId: string;
  photos: GroupingPhoto[]; // includes the marker photo at index 0
}
export interface GroupingResult {
  groups: GroupedProduct[];
  orphanPhotos: GroupingPhoto[]; // photos before the first marker in this snapshot
}
export function groupByMarkers(photos: GroupingPhoto[]): GroupingResult;
export function computeGroupHash(sourceAlbumId: string, photos: GroupingPhoto[]): Promise<string>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/import/marker.test.ts
// Replace the existing marker import with this expanded import, then append the test.
import {
  createMarkerDetector,
  isMarkerImage,
  MARKER_PAYLOAD,
  type MarkerImagesBinding,
  type MarkerImageTransformer,
} from "../../src/import/marker";

it("normalizes source bytes through Cloudflare Images before QR detection", async () => {
  const calls: Array<{ op: string; value: unknown }> = [];
  const normalized = readFileSync(
    "test/import/fixtures/marker-clean.jpg",
  );
  let transformer: MarkerImageTransformer;
  transformer = {
    transform(options) {
      calls.push({ op: "transform", value: options });
      return transformer;
    },
    async output(options) {
      calls.push({ op: "output", value: options });
      return {
        response: () => new Response(normalized),
      };
    },
  };
  const images: MarkerImagesBinding = {
    input(value) {
      calls.push({ op: "input", value });
      return transformer;
    },
  };
  const source = new ArrayBuffer(8);

  await expect(
    createMarkerDetector(images).detect(source),
  ).resolves.toBe(true);
  expect(calls).toEqual([
    { op: "input", value: source },
    {
      op: "transform",
      value: {
        width: 1024,
        height: 1024,
        fit: "contain",
      },
    },
    { op: "output", value: { format: "image/jpeg" } },
  ]);
});
```

```ts
// test/import/grouping.test.ts
import { describe, expect, it } from "vitest";
import { groupByMarkers, computeGroupHash, type GroupingPhoto } from "../../src/import/grouping";

function photo(id: string, position: number, isMarker = false): GroupingPhoto {
  return { applePhotoId: id, position, isMarker, r2Key: `assets/${id}.jpg` };
}

describe("groupByMarkers", () => {
  it("splits photos into marker-to-marker groups, marker included in each group", () => {
    const photos = [
      photo("m1", 1, true), photo("p1", 2), photo("p2", 3),
      photo("m2", 4, true), photo("p3", 5), photo("p4", 6), photo("p5", 7),
    ];
    const result = groupByMarkers(photos);
    expect(result.orphanPhotos).toEqual([]);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]).toMatchObject({ ordinal: 0, markerPhotoId: "m1" });
    expect(result.groups[0]!.photos.map((p) => p.applePhotoId)).toEqual(["m1", "p1", "p2"]);
    expect(result.groups[1]).toMatchObject({ ordinal: 1, markerPhotoId: "m2" });
    expect(result.groups[1]!.photos.map((p) => p.applePhotoId)).toEqual(["m2", "p3", "p4", "p5"]);
  });

  it("the final group ends at the snapshot boundary, no trailing marker required", () => {
    const photos = [photo("m1", 1, true), photo("p1", 2), photo("p2", 3)];
    const result = groupByMarkers(photos);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.photos.map((p) => p.applePhotoId)).toEqual(["m1", "p1", "p2"]);
  });

  it("photos before the first marker are reported as orphans, not a group", () => {
    const photos = [photo("stray1", 1), photo("stray2", 2), photo("m1", 3, true), photo("p1", 4)];
    const result = groupByMarkers(photos);
    expect(result.orphanPhotos.map((p) => p.applePhotoId)).toEqual(["stray1", "stray2"]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.markerPhotoId).toBe("m1");
  });

  it("a snapshot with no marker at all is entirely orphaned", () => {
    const photos = [photo("stray1", 1), photo("stray2", 2)];
    const result = groupByMarkers(photos);
    expect(result.groups).toEqual([]);
    expect(result.orphanPhotos).toHaveLength(2);
  });

  it("sorts by position before grouping, independent of input array order", () => {
    const photos = [photo("p1", 2), photo("m1", 1, true)];
    const result = groupByMarkers(photos);
    expect(result.groups[0]!.photos.map((p) => p.applePhotoId)).toEqual(["m1", "p1"]);
  });

  it("back-to-back markers with no photos between them produce a single-photo group", () => {
    const photos = [photo("m1", 1, true), photo("m2", 2, true), photo("p1", 3)];
    const result = groupByMarkers(photos);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]!.photos.map((p) => p.applePhotoId)).toEqual(["m1"]);
    expect(result.groups[1]!.photos.map((p) => p.applePhotoId)).toEqual(["m2", "p1"]);
  });
});

describe("computeGroupHash", () => {
  it("is deterministic for the same album and ordered photo IDs", async () => {
    const photos = [photo("m1", 1, true), photo("p1", 2)];
    const a = await computeGroupHash("album-1", photos);
    const b = await computeGroupHash("album-1", photos);
    expect(a).toBe(b);
  });

  it("differs when the album differs", async () => {
    const photos = [photo("m1", 1, true), photo("p1", 2)];
    const a = await computeGroupHash("album-1", photos);
    const b = await computeGroupHash("album-2", photos);
    expect(a).not.toBe(b);
  });

  it("differs when photo order differs", async () => {
    const a = await computeGroupHash("album-1", [photo("m1", 1, true), photo("p1", 2)]);
    const b = await computeGroupHash("album-1", [photo("p1", 2), photo("m1", 1, true)]);
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/import/marker.test.ts test/import/grouping.test.ts`
Expected: FAIL — `createMarkerDetector` is not exported and `../../src/import/grouping` does not exist.

- [ ] **Step 3: Write minimal implementation**

Append the production adapter to Foundation's pure marker decoder:

```ts
// src/import/marker.ts (append)
export interface MarkerImageTransformer {
  transform(options: {
    width: number;
    height: number;
    fit: "contain";
  }): MarkerImageTransformer;
  output(options: {
    format: "image/jpeg";
  }): Promise<{ response(): Response }>;
}

export interface MarkerImagesBinding {
  input(value: ArrayBuffer | ReadableStream): MarkerImageTransformer;
}

export interface MarkerDetector {
  detect(bytes: ArrayBuffer): Promise<boolean>;
}

export function createMarkerDetector(
  images: MarkerImagesBinding,
): MarkerDetector {
  return {
    async detect(bytes) {
      const result = await images
        .input(bytes)
        .transform({
          width: 1024,
          height: 1024,
          fit: "contain",
        })
        .output({ format: "image/jpeg" });
      const normalized = new Uint8Array(
        await result.response().arrayBuffer(),
      );
      return isMarkerImage(normalized);
    },
  };
}
```

```ts
// src/import/grouping.ts
import { sha256Hex } from "../shared/ids";

export interface GroupingPhoto {
  applePhotoId: string;
  position: number;
  isMarker: boolean;
  r2Key: string;
}

export interface GroupedProduct {
  ordinal: number;
  markerPhotoId: string;
  photos: GroupingPhoto[];
}

export interface GroupingResult {
  groups: GroupedProduct[];
  orphanPhotos: GroupingPhoto[];
}

export function groupByMarkers(photos: GroupingPhoto[]): GroupingResult {
  const sorted = [...photos].sort((a, b) => a.position - b.position);
  const firstMarkerIndex = sorted.findIndex((p) => p.isMarker);

  if (firstMarkerIndex === -1) {
    return { groups: [], orphanPhotos: sorted };
  }

  const orphanPhotos = sorted.slice(0, firstMarkerIndex);
  const groups: GroupedProduct[] = [];
  let currentMarkerPhotoId: string | null = null;
  let currentPhotos: GroupingPhoto[] = [];

  for (const photo of sorted.slice(firstMarkerIndex)) {
    if (photo.isMarker) {
      if (currentMarkerPhotoId) {
        groups.push({
          ordinal: groups.length,
          markerPhotoId: currentMarkerPhotoId,
          photos: currentPhotos,
        });
      }

      currentMarkerPhotoId = photo.applePhotoId;
      currentPhotos = [photo];
      continue;
    }

    currentPhotos.push(photo);
  }

  if (currentMarkerPhotoId) {
    groups.push({
      ordinal: groups.length,
      markerPhotoId: currentMarkerPhotoId,
      photos: currentPhotos,
    });
  }

  return { groups, orphanPhotos };
}

export async function computeGroupHash(sourceAlbumId: string, photos: GroupingPhoto[]): Promise<string> {
  const payload = `${sourceAlbumId}:${photos.map((p) => p.applePhotoId).join(",")}`;
  return sha256Hex(new TextEncoder().encode(payload));
}
```

- [ ] **Step 4: Run focused and full checks**

Run: `npx vitest run test/import/marker.test.ts test/import/grouping.test.ts`
Expected: PASS (14 tests).

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/import/marker.ts src/import/grouping.ts test/import/marker.test.ts test/import/grouping.test.ts
git commit -m "feat(import): normalize marker images and group products"
```

---

### Task 9: Airtable Products client

**Files:**
- Create: `src/import/airtable-products.ts`
- Test: `test/import/airtable-products.test.ts`

**Interfaces:**
- Consumes: `Fetcher` (foundation), `AppConfig.airtableBaseId`, `AppConfig.airtableProductsTableId`, `env.AIRTABLE_TOKEN`.
- Produces (consumed by Task 13 `import/service.ts`):

```ts
export interface AirtableProductPayload {
  productId: string;
  systemGroupId: string;
  uploadDate: string; // "YYYY-MM-DD"
  productImages: Array<{ url: string; filename: string }>;
}
export interface AirtableProductsClient {
  findBySystemGroupId(systemGroupId: string): Promise<{ recordId: string; productId: string } | null>;
  createProduct(payload: AirtableProductPayload): Promise<{ recordId: string }>;
  verifyProduct(recordId: string, expectedImageCount: number): Promise<boolean>;
  deleteProduct(recordId: string): Promise<void>;
}
export function createAirtableProductsClient(config: { baseId: string; tableId: string; token: string; fetch: Fetcher }): AirtableProductsClient;
```

Each attachment `filename` is the persisted R2 key basename: `assets/<filename>`. Airtable preserves attachment order and filename when staff rearranges `Product Images`; Publication Task 2 reconstructs the first four private R2 keys without trusting expiring Airtable attachment URLs.

- [ ] **Step 1: Write the failing test**

```ts
// test/import/airtable-products.test.ts
import { describe, expect, it } from "vitest";
import { createAirtableProductsClient } from "../../src/import/airtable-products";
import { fakeFetch } from "../helpers/fakes";

const config = { baseId: "base123", tableId: "tblProducts", token: "test-token" };

describe("airtable-products client", () => {
  it("createProduct posts the required system fields and Inventory Status = In", async () => {
    let capturedBody: unknown;
    const fetchFake = fakeFetch([
      {
        match: (req) => req.method === "POST" && req.url === `https://api.airtable.com/v0/${config.baseId}/${config.tableId}`,
        respond: async (req) => {
          capturedBody = await req.json();
          return new Response(JSON.stringify({ id: "recNEW" }), { status: 200 });
        },
      },
    ]);
    const client = createAirtableProductsClient({ ...config, fetch: fetchFake });

    const result = await client.createProduct({
      productId: "A-501",
      systemGroupId: "grouphash-1",
      uploadDate: "2026-09-01",
      productImages: [
        { url: "https://example.workers.dev/assets/a.jpg", filename: "a.jpg" },
        { url: "https://example.workers.dev/assets/b.jpg", filename: "b.jpg" },
      ],
    });

    expect(result).toEqual({ recordId: "recNEW" });
    expect(capturedBody).toMatchObject({
      fields: {
        "Product ID": "A-501",
        "System Group ID": "grouphash-1",
        "Upload Date": "2026-09-01",
        "Inventory Status": "In",
        "Product Images": [
          { url: "https://example.workers.dev/assets/a.jpg", filename: "a.jpg" },
          { url: "https://example.workers.dev/assets/b.jpg", filename: "b.jpg" },
        ],
      },
    });
  });

  it("findBySystemGroupId returns null when no record matches", async () => {
    const fetchFake = fakeFetch([
      {
        match: (req) => req.method === "GET",
        respond: () => new Response(JSON.stringify({ records: [] }), { status: 200 }),
      },
    ]);
    const client = createAirtableProductsClient({ ...config, fetch: fetchFake });
    expect(await client.findBySystemGroupId("missing-hash")).toBeNull();
  });

  it("findBySystemGroupId returns the matching record and Product ID", async () => {
    const fetchFake = fakeFetch([
      {
        match: (req) => req.method === "GET",
        respond: () =>
          new Response(
            JSON.stringify({ records: [{ id: "recEXISTING", fields: { "Product ID": "A-500" } }] }),
            { status: 200 }
          ),
      },
    ]);
    const client = createAirtableProductsClient({ ...config, fetch: fetchFake });
    expect(await client.findBySystemGroupId("grouphash-1")).toEqual({ recordId: "recEXISTING", productId: "A-500" });
  });

  it("verifyProduct checks the record has exactly the expected attachment count", async () => {
    const fetchFake = fakeFetch([
      {
        match: (req) => req.method === "GET" && req.url.includes("recNEW"),
        respond: () =>
          new Response(
            JSON.stringify({ id: "recNEW", fields: { "Product Images": [{ url: "a" }, { url: "b" }] } }),
            { status: 200 }
          ),
      },
    ]);
    const client = createAirtableProductsClient({ ...config, fetch: fetchFake });
    expect(await client.verifyProduct("recNEW", 2)).toBe(true);
    expect(await client.verifyProduct("recNEW", 3)).toBe(false);
  });

  it("deleteProduct issues a DELETE against the record", async () => {
    let deletedUrl: string | null = null;
    const fetchFake = fakeFetch([
      {
        match: (req) => req.method === "DELETE",
        respond: (req) => {
          deletedUrl = req.url;
          return new Response(JSON.stringify({ id: "recNEW", deleted: true }), { status: 200 });
        },
      },
    ]);
    const client = createAirtableProductsClient({ ...config, fetch: fetchFake });
    await client.deleteProduct("recNEW");
    expect(deletedUrl).toBe(`https://api.airtable.com/v0/${config.baseId}/${config.tableId}/recNEW`);
  });

  it("createProduct throws OperationalError with retryable=true on a 429", async () => {
    const fetchFake = fakeFetch([
      { match: (req) => req.method === "POST", respond: () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }) },
    ]);
    const client = createAirtableProductsClient({ ...config, fetch: fetchFake });
    await expect(
      client.createProduct({ productId: "A-501", systemGroupId: "g1", uploadDate: "2026-09-01", productImages: [] })
    ).rejects.toMatchObject({ code: "airtable_rate_limited", retryable: true });
  });

  it("rejects a malformed successful Airtable response", async () => {
    const fetchFake = fakeFetch([
      {
        match: (req) => req.method === "POST",
        respond: () => new Response(JSON.stringify({ id: 42 }), { status: 200 }),
      },
    ]);
    const client = createAirtableProductsClient({ ...config, fetch: fetchFake });

    await expect(
      client.createProduct({ productId: "A-501", systemGroupId: "g1", uploadDate: "2026-09-01", productImages: [] }),
    ).rejects.toMatchObject({
      code: "airtable_create_invalid_response",
      retryable: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/import/airtable-products.test.ts`
Expected: FAIL — `Cannot find module '../../src/import/airtable-products'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/import/airtable-products.ts
import { z } from "zod";
import type { Fetcher } from "../env";
import { OperationalError } from "../shared/errors";

const FindResponseSchema = z.object({
  records: z.array(z.object({
    id: z.string().min(1),
    fields: z.object({ "Product ID": z.string().min(1) }),
  })),
});

const CreateResponseSchema = z.object({
  id: z.string().min(1),
});

const VerifyResponseSchema = z.object({
  fields: z.object({
    "Product Images": z.array(z.object({ url: z.string().min(1) })).optional(),
  }),
});

export interface AirtableProductPayload {
  productId: string;
  systemGroupId: string;
  uploadDate: string;
  productImages: Array<{ url: string; filename: string }>;
}

export interface AirtableProductsClient {
  findBySystemGroupId(systemGroupId: string): Promise<{ recordId: string; productId: string } | null>;
  createProduct(payload: AirtableProductPayload): Promise<{ recordId: string }>;
  verifyProduct(recordId: string, expectedImageCount: number): Promise<boolean>;
  deleteProduct(recordId: string): Promise<void>;
}

function baseUrl(baseId: string, tableId: string): string {
  return `https://api.airtable.com/v0/${baseId}/${tableId}`;
}

async function throwOnError(response: Response, action: string): Promise<never> {
  const retryable = response.status === 429 || response.status >= 500;
  const code = response.status === 429 ? "airtable_rate_limited" : `airtable_${action}_failed`;
  throw new OperationalError(code, `Airtable ${action} failed with status ${response.status}`, retryable);
}

async function parseAirtableJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  action: string,
): Promise<T> {
  try {
    return schema.parse(await response.json());
  } catch {
    throw new OperationalError(
      `airtable_${action}_invalid_response`,
      `Airtable returned a malformed ${action} response`,
      false,
    );
  }
}

export function createAirtableProductsClient(config: { baseId: string; tableId: string; token: string; fetch: Fetcher }): AirtableProductsClient {
  const headers = { Authorization: `Bearer ${config.token}`, "content-type": "application/json" };

  return {
    async findBySystemGroupId(systemGroupId) {
      const url = new URL(baseUrl(config.baseId, config.tableId));
      url.searchParams.set("filterByFormula", `{System Group ID} = "${systemGroupId}"`);
      url.searchParams.set("maxRecords", "1");
      const response = await config.fetch(url.toString(), { headers });
      if (!response.ok) await throwOnError(response, "find");
      const body = await parseAirtableJson(response, FindResponseSchema, "find");
      if (body.records.length === 0) return null;
      return { recordId: body.records[0].id, productId: body.records[0].fields["Product ID"] };
    },

    async createProduct(payload) {
      const response = await config.fetch(baseUrl(config.baseId, config.tableId), {
        method: "POST",
        headers,
        body: JSON.stringify({
          fields: {
            "Product ID": payload.productId,
            "System Group ID": payload.systemGroupId,
            "Upload Date": payload.uploadDate,
            "Inventory Status": "In",
            "Product Images": payload.productImages,
          },
        }),
      });
      if (!response.ok) await throwOnError(response, "create");
      const body = await parseAirtableJson(response, CreateResponseSchema, "create");
      return { recordId: body.id };
    },

    async verifyProduct(recordId, expectedImageCount) {
      const response = await config.fetch(`${baseUrl(config.baseId, config.tableId)}/${recordId}`, { headers });
      if (!response.ok) await throwOnError(response, "verify");
      const body = await parseAirtableJson(response, VerifyResponseSchema, "verify");
      return (body.fields["Product Images"]?.length ?? 0) === expectedImageCount;
    },

    async deleteProduct(recordId) {
      const response = await config.fetch(`${baseUrl(config.baseId, config.tableId)}/${recordId}`, { method: "DELETE", headers });
      if (!response.ok) await throwOnError(response, "delete");
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/import/airtable-products.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add src/import/airtable-products.ts test/import/airtable-products.test.ts
git commit -m "feat(import): add Airtable Products client with idempotent create"
```

---

### Task 10: Minimal LINE push client

**Files:**
- Create: `src/line/client.ts`
- Test: `test/line/client.test.ts`

**Interfaces:**
- Consumes: `Fetcher`, `env.LINE_CHANNEL_ACCESS_TOKEN`.
- Produces (consumed by Task 11 `import/notify.ts`; the full LINE inventory bot plan extends this file with `replyMessage`/`flexMessage` without renaming `pushMessage`):

```ts
export interface LineClient { pushMessage(toGroupId: string, text: string): Promise<void>; }
export function createLineClient(config: { channelAccessToken: string; fetch: Fetcher }): LineClient;
```

- [ ] **Step 1: Write the failing test**

```ts
// test/line/client.test.ts
import { describe, expect, it } from "vitest";
import { createLineClient } from "../../src/line/client";
import { fakeFetch } from "../helpers/fakes";

describe("line client", () => {
  it("pushMessage posts the group id and text to the LINE push endpoint with bearer auth", async () => {
    let capturedRequest: { url: string; headers: Headers; body: unknown } | null = null;
    const fetchFake = fakeFetch([
      {
        match: (req) => req.url === "https://api.line.me/v2/bot/message/push",
        respond: async (req) => {
          capturedRequest = { url: req.url, headers: req.headers, body: await req.json() };
          return new Response("{}", { status: 200 });
        },
      },
    ]);
    const client = createLineClient({ channelAccessToken: "test-token", fetch: fetchFake });

    await client.pushMessage("group-1", "นำเข้าสำเร็จ 3 รายการ");

    expect(capturedRequest?.headers.get("authorization")).toBe("Bearer test-token");
    expect(capturedRequest?.body).toEqual({ to: "group-1", messages: [{ type: "text", text: "นำเข้าสำเร็จ 3 รายการ" }] });
  });

  it("throws a retryable OperationalError when LINE returns a 5xx", async () => {
    const fetchFake = fakeFetch([{ match: () => true, respond: () => new Response("{}", { status: 503 }) }]);
    const client = createLineClient({ channelAccessToken: "test-token", fetch: fetchFake });
    await expect(client.pushMessage("group-1", "text")).rejects.toMatchObject({ code: "line_push_failed", retryable: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/line/client.test.ts`
Expected: FAIL — `Cannot find module '../../src/line/client'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/line/client.ts
import type { Fetcher } from "../env";
import { OperationalError } from "../shared/errors";

export interface LineClient {
  pushMessage(toGroupId: string, text: string): Promise<void>;
}

export function createLineClient(config: { channelAccessToken: string; fetch: Fetcher }): LineClient {
  return {
    async pushMessage(toGroupId, text) {
      const response = await config.fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.channelAccessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ to: toGroupId, messages: [{ type: "text", text }] }),
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new OperationalError("line_push_failed", `LINE push failed with status ${response.status}`, retryable);
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/line/client.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add src/line/client.ts test/line/client.test.ts
git commit -m "feat(line): add minimal push-message client for import summaries"
```

---

### Task 11: Thai import summary builder and sender

**Files:**
- Create: `src/import/notify.ts`
- Test: `test/import/notify.test.ts`

**Interfaces:**
- Consumes: `LineClient`, `ImportRunResult` and `OrphanRange` (Task 5), `bangkokDateTimeThai` (foundation), `AppConfig.lineAllowedGroupId`.
- Produces (consumed by Task 13 `import/workflow.ts`):

```ts
export function buildImportSummaryMessage(input: {
  result: ImportRunResult;
  orphanRange: OrphanRange | null;
  nowThaiText: string;
}): string;
export async function sendImportSummary(
  line: LineClient,
  groupId: string,
  input: { result: ImportRunResult; orphanRange: OrphanRange | null; nowThaiText: string }
): Promise<void>;
```

- [ ] **Step 1: Write the failing test**

```ts
// test/import/notify.test.ts
import { describe, expect, it, vi } from "vitest";
import { buildImportSummaryMessage, sendImportSummary } from "../../src/import/notify";
import type { ImportRunResult } from "../../src/import/types";

describe("buildImportSummaryMessage", () => {
  it("reports a clean success with imported Product IDs", () => {
    const result: ImportRunResult = { importRunId: "run-1", succeededProductIds: ["A-501", "A-502"], failedGroups: [] };
    const message = buildImportSummaryMessage({ result, orphanRange: null, nowThaiText: "1 กันยายน 2569 09:00" });
    expect(message).toContain("นำเข้ารูปภาพ");
    expect(message).toContain("A-501");
    expect(message).toContain("A-502");
    expect(message).toContain("สำเร็จ 2 รายการ");
    expect(message).not.toContain("ล้มเหลว");
  });

  it("reports failed groups with position, attempted Product ID, and reason", () => {
    const result: ImportRunResult = {
      importRunId: "run-1",
      succeededProductIds: ["A-501"],
      failedGroups: [{ groupId: "group-2", productId: "A-502", errorCode: "airtable_rate_limited" }],
    };
    const message = buildImportSummaryMessage({ result, orphanRange: null, nowThaiText: "1 กันยายน 2569 09:00" });
    expect(message).toContain("ล้มเหลว 1 รายการ");
    expect(message).toContain("A-502");
    expect(message).toContain("airtable_rate_limited");
    expect(message).toContain("/upload");
  });

  it("reports an orphan photo range separately with no Product ID", () => {
    const result: ImportRunResult = { importRunId: "run-1", succeededProductIds: [], failedGroups: [] };
    const message = buildImportSummaryMessage({
      result,
      orphanRange: { firstApplePhotoId: "apple-1", lastApplePhotoId: "apple-3", count: 3 },
      nowThaiText: "1 กันยายน 2569 09:00",
    });
    expect(message).toContain("3 รูป");
    expect(message).toContain("apple-1");
    expect(message).toContain("apple-3");
  });

  it("never includes a signed URL or token substring", () => {
    const result: ImportRunResult = { importRunId: "run-1", succeededProductIds: ["A-501"], failedGroups: [] };
    const message = buildImportSummaryMessage({ result, orphanRange: null, nowThaiText: "1 กันยายน 2569 09:00" });
    expect(message).not.toMatch(/sig=/);
    expect(message).not.toMatch(/token/i);
  });
});

describe("sendImportSummary", () => {
  it("pushes the built message to the allowlisted group", async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const result: ImportRunResult = { importRunId: "run-1", succeededProductIds: ["A-501"], failedGroups: [] };
    await sendImportSummary({ pushMessage: push }, "group-1", { result, orphanRange: null, nowThaiText: "1 กันยายน 2569 09:00" });
    expect(push).toHaveBeenCalledWith("group-1", expect.stringContaining("A-501"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/import/notify.test.ts`
Expected: FAIL — `Cannot find module '../../src/import/notify'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/import/notify.ts
import type { LineClient } from "../line/client";
import type { ImportRunResult, OrphanRange } from "./types";

export function buildImportSummaryMessage(input: { result: ImportRunResult; orphanRange: OrphanRange | null; nowThaiText: string }): string {
  const { result, orphanRange, nowThaiText } = input;
  const lines: string[] = [];
  lines.push(`นำเข้ารูปภาพ — ${nowThaiText}`);
  lines.push(`สำเร็จ ${result.succeededProductIds.length} รายการ`);
  if (result.succeededProductIds.length > 0) {
    lines.push(result.succeededProductIds.join(", "));
  }

  if (result.failedGroups.length > 0) {
    lines.push(`ล้มเหลว ${result.failedGroups.length} รายการ`);
    for (const failure of result.failedGroups) {
      const productLabel = failure.productId ?? "ไม่ทราบรหัส";
      lines.push(`- กลุ่ม ${failure.groupId} (${productLabel}): ${failure.errorCode}`);
    }
    lines.push("แก้ไขแล้วพิมพ์ /upload เพื่อลองใหม่");
  }

  if (orphanRange !== null) {
    lines.push(`พบรูปก่อนมาร์กเกอร์แรก ${orphanRange.count} รูป (${orphanRange.firstApplePhotoId} ถึง ${orphanRange.lastApplePhotoId}) — ยังไม่สร้างสินค้า`);
  }

  return lines.join("\n");
}

export async function sendImportSummary(
  line: LineClient,
  groupId: string,
  input: { result: ImportRunResult; orphanRange: OrphanRange | null; nowThaiText: string }
): Promise<void> {
  await line.pushMessage(groupId, buildImportSummaryMessage(input));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/import/notify.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add src/import/notify.ts test/import/notify.test.ts
git commit -m "feat(import): add Thai LINE import summary builder"
```

---

### Task 12: Import service — download, dedupe, and group a snapshot

**Files:**
- Create: `src/import/service.ts` (this task adds `downloadAndGroupSnapshot`; Task 13 adds the rest of the file)
- Test: `test/import/service.test.ts` (this task adds the `downloadAndGroupSnapshot` describe block; Task 13 appends more)

**Interfaces:**
- Consumes: `ImageSource`, `MarkerDetector` (foundation); `ImportRepository` (Task 4); `AssetStore` (Task 6); `groupByMarkers`, `computeGroupHash` (Task 8); `sha256Hex` (foundation); `Clock`, `IdGenerator` (foundation).
- Produces (consumed by Task 13 and by `import/workflow.ts` in Task 14):

```ts
export interface ImportServiceDeps {
  imageSource: ImageSource;
  marker: MarkerDetector;
  repo: ImportRepository;
  assets: AssetStore;
  clock: Clock;
  ids: IdGenerator;
  sourceAlbumId: string;
  firstImportCutoffDate: string | null;
}
export interface PersistedGroup {
  groupId: string;
  groupRowId: string;
  ordinal: number;
  markerPhotoId: string;
  attachablePhotos: Array<{ applePhotoId: string; r2Key: string }>;
}
export interface DownloadAndGroupOutcome {
  pendingGroups: PersistedGroup[];
  orphanRange: { firstApplePhotoId: string; lastApplePhotoId: string; count: number } | null;
  checkpointPosition: number;
}
export async function downloadAndGroupSnapshot(deps: ImportServiceDeps, importRunId: string): Promise<DownloadAndGroupOutcome>;
```

- [ ] **Step 1: Write the failing test**

```ts
// test/import/service.test.ts
import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";
import { fixedClock, sequentialIdGenerator } from "../helpers/fakes";
import { createImportRepository } from "../../src/db/import-repository";
import { createAssetStore } from "../../src/import/asset-store";
import { downloadAndGroupSnapshot, type ImportServiceDeps } from "../../src/import/service";
import type { AlbumSnapshot, ImageSource, SourcePhoto } from "../../src/icloud/types";
import type { MarkerDetector } from "../../src/import/marker";

function sourcePhoto(id: string, position: number): SourcePhoto {
  return { sourceAlbumId: "album-1", applePhotoId: id, position, captureAt: null, derivativeUrl: `https://icloud.example/${id}.jpg`, mediaType: "image/jpeg" };
}

function stubImageSource(snapshot: AlbumSnapshot, markerIds: Set<string>): ImageSource {
  return {
    async getSnapshot() {
      return snapshot;
    },
    async download(photo) {
      const label = markerIds.has(photo.applePhotoId) ? "marker" : "product";
      return new Response(new TextEncoder().encode(`${label}-${photo.applePhotoId}`), { headers: { "content-type": "image/jpeg" } });
    },
  };
}

function stubMarker(markerIds: Set<string>): MarkerDetector {
  return {
    async detect(bytes) {
      const text = new TextDecoder().decode(bytes);
      return text.startsWith("marker-");
    },
  };
}

async function buildDeps(sourceAlbumId: string, snapshot: AlbumSnapshot, markerIds: Set<string>): Promise<ImportServiceDeps> {
  const env = testEnv();
  const clock = fixedClock("2026-09-01T09:00:00.000Z");
  return {
    imageSource: stubImageSource(snapshot, markerIds),
    marker: stubMarker(markerIds),
    repo: createImportRepository(env.DB, sequentialIdGenerator("row"), clock),
    assets: createAssetStore(env.IMAGES_BUCKET, { signingSecret: "test-secret", publicBaseUrl: "https://example.workers.dev" }, clock),
    clock,
    ids: sequentialIdGenerator("id"),
    sourceAlbumId,
    firstImportCutoffDate: null,
  };
}

describe("downloadAndGroupSnapshot", () => {
  it("downloads new photos, groups them, and excludes the marker from attachablePhotos", async () => {
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const snapshot: AlbumSnapshot = {
      sourceAlbumId,
      fetchedAt: "2026-09-01T08:00:00.000Z",
      photos: [sourcePhoto("m1", 1), sourcePhoto("p1", 2), sourcePhoto("p2", 3)].map((p) => ({ ...p, sourceAlbumId })),
    };
    const deps = await buildDeps(sourceAlbumId, snapshot, new Set(["m1"]));
    await deps.repo.createImportRun({ id: "run-1", sourceAlbumId, trigger: "cron" });

    const outcome = await downloadAndGroupSnapshot(deps, "run-1");

    expect(outcome.orphanRange).toBeNull();
    expect(outcome.pendingGroups).toHaveLength(1);
    expect(outcome.pendingGroups[0].markerPhotoId).toBe("m1");
    expect(outcome.pendingGroups[0].attachablePhotos.map((p) => p.applePhotoId)).toEqual(["p1", "p2"]);

    const stored = await deps.repo.listAssetsForAlbum(sourceAlbumId);
    expect(stored).toHaveLength(3);
    expect(stored.find((s) => s.applePhotoId === "m1")?.isMarker).toBe(true);
  });

  it("skips photos already recorded for this album from a previous run", async () => {
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const env = testEnv();
    const repo = createImportRepository(env.DB, sequentialIdGenerator("row"), clock);
    await repo.createImportRun({ id: "run-0", sourceAlbumId, trigger: "cron" });
    await repo.recordPhotoAsset({ id: "existing-1", sourceAlbumId, applePhotoId: "m1", contentHash: "hash-m1", r2Key: "assets/hash-m1.jpg", position: 1, isMarker: true, importRunId: "run-0" });
    await repo.finalizeImportRun({
      id: "run-0",
      sourceAlbumId,
      status: "completed",
      orphanPhotoCount: 0,
      checkpointPosition: 1,
    });

    const snapshot: AlbumSnapshot = {
      sourceAlbumId,
      fetchedAt: "2026-09-01T09:00:00.000Z",
      photos: [
        { sourceAlbumId, applePhotoId: "m1", position: 1, captureAt: null, derivativeUrl: "https://icloud.example/m1.jpg", mediaType: "image/jpeg" },
        { sourceAlbumId, applePhotoId: "p1", position: 2, captureAt: null, derivativeUrl: "https://icloud.example/p1.jpg", mediaType: "image/jpeg" },
      ],
    };
    const deps: ImportServiceDeps = {
      imageSource: stubImageSource(snapshot, new Set(["m1"])),
      marker: stubMarker(new Set(["m1"])),
      repo,
      assets: createAssetStore(env.IMAGES_BUCKET, { signingSecret: "test-secret", publicBaseUrl: "https://example.workers.dev" }, clock),
      clock,
      ids: sequentialIdGenerator("id"),
      sourceAlbumId,
      firstImportCutoffDate: null,
    };
    await repo.createImportRun({ id: "run-1", sourceAlbumId, trigger: "cron" });

    await downloadAndGroupSnapshot(deps, "run-1");

    const stored = await repo.listAssetsForAlbum(sourceAlbumId);
    expect(stored).toHaveLength(2); // m1 still just once, p1 newly added
  });

  it("reports photos before the first marker as an orphan range and creates no group", async () => {
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const snapshot: AlbumSnapshot = {
      sourceAlbumId,
      fetchedAt: "2026-09-01T09:00:00.000Z",
      photos: [
        { sourceAlbumId, applePhotoId: "stray1", position: 1, captureAt: null, derivativeUrl: "https://icloud.example/stray1.jpg", mediaType: "image/jpeg" },
        { sourceAlbumId, applePhotoId: "m1", position: 2, captureAt: null, derivativeUrl: "https://icloud.example/m1.jpg", mediaType: "image/jpeg" },
        { sourceAlbumId, applePhotoId: "p1", position: 3, captureAt: null, derivativeUrl: "https://icloud.example/p1.jpg", mediaType: "image/jpeg" },
      ],
    };
    const deps = await buildDeps(sourceAlbumId, snapshot, new Set(["m1"]));
    await deps.repo.createImportRun({ id: "run-1", sourceAlbumId, trigger: "cron" });

    const outcome = await downloadAndGroupSnapshot(deps, "run-1");

    expect(outcome.orphanRange).toEqual({ firstApplePhotoId: "stray1", lastApplePhotoId: "stray1", count: 1 });
    expect(outcome.pendingGroups).toHaveLength(1);
  });

  it("reuses one R2 object for identical product bytes under different Apple photo IDs", async () => {
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const snapshot: AlbumSnapshot = {
      sourceAlbumId,
      fetchedAt: "2026-09-01T09:00:00.000Z",
      photos: [
        { sourceAlbumId, applePhotoId: "m1", position: 1, captureAt: null, derivativeUrl: "https://icloud.example/m1.jpg", mediaType: "image/jpeg" },
        { sourceAlbumId, applePhotoId: "p1", position: 2, captureAt: null, derivativeUrl: "https://icloud.example/p1.jpg", mediaType: "image/jpeg" },
        { sourceAlbumId, applePhotoId: "dup", position: 3, captureAt: null, derivativeUrl: "https://icloud.example/dup.jpg", mediaType: "image/jpeg" },
      ],
    };
    const imageSource: ImageSource = {
      async getSnapshot() { return snapshot; },
      async download(photo) {
        const label = photo.applePhotoId === "m1"
          ? "marker-m1"
          : "identical-product-bytes";
        return new Response(new TextEncoder().encode(label), {
          headers: { "content-type": "image/jpeg" },
        });
      },
    };
    const env = testEnv();
    const clock = fixedClock("2026-09-01T09:00:00.000Z");
    const repo = createImportRepository(env.DB, sequentialIdGenerator("row"), clock);
    await repo.createImportRun({ id: "run-1", sourceAlbumId, trigger: "cron" });
    const deps: ImportServiceDeps = {
      imageSource,
      marker: stubMarker(new Set(["m1"])),
      repo,
      assets: createAssetStore(env.IMAGES_BUCKET, { signingSecret: "test-secret", publicBaseUrl: "https://example.workers.dev" }, clock),
      clock,
      ids: sequentialIdGenerator("id"),
      sourceAlbumId,
      firstImportCutoffDate: null,
    };

    const outcome = await downloadAndGroupSnapshot(deps, "run-1");
    const stored = await repo.listAssetsForAlbum(sourceAlbumId);
    expect(stored).toHaveLength(3);
    expect(stored.find((row) => row.applePhotoId === "p1")?.r2Key)
      .toBe(stored.find((row) => row.applePhotoId === "dup")?.r2Key);
    expect(outcome.pendingGroups[0].attachablePhotos).toHaveLength(2);
  });

  it("applies FIRST_IMPORT_CUTOFF_DATE only when no checkpoint exists", async () => {
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const snapshot: AlbumSnapshot = {
      sourceAlbumId,
      fetchedAt: "2026-09-01T09:00:00.000Z",
      photos: [
        { ...sourcePhoto("old", 1), sourceAlbumId, captureAt: "2026-08-31T23:59:59.000Z" },
        { ...sourcePhoto("m1", 2), sourceAlbumId, captureAt: "2026-09-01T00:00:00.000Z" },
        { ...sourcePhoto("p1", 3), sourceAlbumId, captureAt: "2026-09-01T00:01:00.000Z" },
      ],
    };
    const deps = await buildDeps(sourceAlbumId, snapshot, new Set(["m1"]));
    deps.firstImportCutoffDate = "2026-09-01T00:00:00.000Z";
    await deps.repo.createImportRun({ id: "run-cutoff", sourceAlbumId, trigger: "cron" });

    const outcome = await downloadAndGroupSnapshot(deps, "run-cutoff");

    expect((await deps.repo.listAssetsForAlbum(sourceAlbumId)).map((row) => row.applePhotoId))
      .toEqual(["m1", "p1"]);
    expect(outcome.pendingGroups).toHaveLength(1);
    expect(outcome.checkpointPosition).toBe(3);
  });

  it("rejects a snapshot whose safe album digest differs from the Workflow payload", async () => {
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const snapshot: AlbumSnapshot = {
      sourceAlbumId: "different-album-digest",
      fetchedAt: "2026-09-01T09:00:00.000Z",
      photos: [],
    };
    const deps = await buildDeps(sourceAlbumId, snapshot, new Set());
    await deps.repo.createImportRun({ id: "run-mismatch", sourceAlbumId, trigger: "cron" });

    await expect(downloadAndGroupSnapshot(deps, "run-mismatch"))
      .rejects.toMatchObject({ code: "source_album_identity_mismatch", retryable: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/import/service.test.ts`
Expected: FAIL — `Cannot find module '../../src/import/service'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/import/service.ts
import type { AlbumSnapshot, ImageSource, SourcePhoto } from "../icloud/types";
import type { OrphanRange } from "./types";
import type { MarkerDetector } from "./marker";
import type { ImportRepository } from "../db/import-repository";
import type { AssetStore } from "./asset-store";
import { groupByMarkers, computeGroupHash, type GroupingPhoto } from "./grouping";
import { sha256Hex } from "../shared/ids";
import { OperationalError } from "../shared/errors";
import type { Clock, IdGenerator } from "../env";

export interface ImportServiceDeps {
  imageSource: ImageSource;
  marker: MarkerDetector;
  repo: ImportRepository;
  assets: AssetStore;
  clock: Clock;
  ids: IdGenerator;
  sourceAlbumId: string;
  firstImportCutoffDate: string | null;
}

export interface PersistedGroup {
  groupId: string;
  groupRowId: string;
  ordinal: number;
  markerPhotoId: string;
  attachablePhotos: Array<{ applePhotoId: string; r2Key: string }>;
}

export interface DownloadAndGroupOutcome {
  pendingGroups: PersistedGroup[];
  orphanRange: OrphanRange | null;
  checkpointPosition: number;
}

function extensionFor(mediaType: SourcePhoto["mediaType"]): string {
  return mediaType === "image/jpeg" ? "jpg" : "bin";
}

export async function downloadAndGroupSnapshot(deps: ImportServiceDeps, importRunId: string): Promise<DownloadAndGroupOutcome> {
  const snapshot: AlbumSnapshot = await deps.imageSource.getSnapshot();
  if (snapshot.sourceAlbumId !== deps.sourceAlbumId) {
    throw new OperationalError("source_album_identity_mismatch", "Snapshot album identity changed", false);
  }

  const savedCheckpoint = await deps.repo.getCheckpoint(deps.sourceAlbumId);
  const firstImportCutoffDate = deps.firstImportCutoffDate;
  const checkpointPosition = snapshot.photos.reduce(
    (highest, photo) => Math.max(highest, photo.position),
    savedCheckpoint ?? -1,
  );
  const eligiblePhotos = savedCheckpoint !== null
    ? snapshot.photos.filter((photo) => photo.position > savedCheckpoint)
    : firstImportCutoffDate !== null
      ? snapshot.photos.filter((photo) =>
          photo.captureAt !== null && photo.captureAt >= firstImportCutoffDate,
        )
      : snapshot.photos;

  for (const photo of eligiblePhotos) {
    const alreadyRecorded = await deps.repo.findAssetByApplePhotoId(deps.sourceAlbumId, photo.applePhotoId);
    if (alreadyRecorded !== null) {
      continue;
    }

    const response = await deps.imageSource.download(photo);
    const bytes = await response.arrayBuffer();
    const contentHash = await sha256Hex(bytes);
    const isMarker = await deps.marker.detect(bytes);

    const existingByHash = await deps.repo.findAssetByContentHash(contentHash);
    const r2Key = existingByHash?.r2Key ?? (await deps.assets.putIfAbsent(contentHash, extensionFor(photo.mediaType), bytes, photo.mediaType)).r2Key;

    await deps.repo.recordPhotoAsset({
      id: deps.ids.next(),
      sourceAlbumId: deps.sourceAlbumId,
      applePhotoId: photo.applePhotoId,
      contentHash,
      r2Key,
      position: photo.position,
      isMarker,
      importRunId,
    });
  }

  const allAssets = await deps.repo.listAssetsForAlbum(deps.sourceAlbumId);
  const groupingPhotos: GroupingPhoto[] = allAssets.map((a) => ({
    applePhotoId: a.applePhotoId,
    position: a.position,
    isMarker: a.isMarker,
    r2Key: a.r2Key,
  }));

  const { groups, orphanPhotos } = groupByMarkers(groupingPhotos);

  const pendingGroups: PersistedGroup[] = [];
  for (const group of groups) {
    const groupHash = await computeGroupHash(deps.sourceAlbumId, group.photos);
    const row = await deps.repo.upsertPendingGroup({
      id: deps.ids.next(),
      importRunId,
      ordinal: group.ordinal,
      groupHash,
      firstPhotoId: group.photos[0].applePhotoId,
      lastPhotoId: group.photos[group.photos.length - 1].applePhotoId,
    });
    if (row.state === "succeeded") {
      continue; // already imported in an earlier run; nothing to reprocess
    }
    pendingGroups.push({
      groupId: groupHash,
      groupRowId: row.id,
      ordinal: group.ordinal,
      markerPhotoId: group.markerPhotoId,
      attachablePhotos: group.photos.filter((p) => !p.isMarker).map((p) => ({ applePhotoId: p.applePhotoId, r2Key: p.r2Key })),
    });
  }

  const orphanRange: OrphanRange | null =
    orphanPhotos.length === 0
      ? null
      : {
          firstApplePhotoId: orphanPhotos[0].applePhotoId,
          lastApplePhotoId: orphanPhotos[orphanPhotos.length - 1].applePhotoId,
          count: orphanPhotos.length,
        };

  return { pendingGroups, orphanRange, checkpointPosition };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/import/service.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add src/import/service.ts test/import/service.test.ts
git commit -m "feat(import): download, dedupe, and group a snapshot"
```

---

### Task 13: Retry-safe Product creation and exhausted-failure recording

**Files:**
- Modify: `src/db/import-repository.ts`
- Modify: `test/db/import-repository.test.ts`
- Modify: `src/import/service.ts`
- Modify: `test/import/service.test.ts`

**Interfaces:**
- Consumes: `PersistedGroup`, `SequenceRepository`, `AuditLog`, `AssetStore.signUrl`, `AirtableProductsClient`, `OperationalError`, `todayBangkokDate`.
- Produces:

```ts
export interface ProcessGroupDeps extends ImportServiceDeps {
  sequences: SequenceRepository;
  audit: AuditLog;
  airtable: AirtableProductsClient;
  productIdPrefix: string;
  assetUrlTtlSeconds: number;
}
export interface ProcessGroupOutcome { outcome: "succeeded"; productId: string; }
export async function processProductGroupAttempt(
  deps: ProcessGroupDeps,
  group: PersistedGroup,
  importRunId: string,
): Promise<ProcessGroupOutcome>;
export async function recordExhaustedGroupFailure(
  deps: Pick<ProcessGroupDeps, "repo" | "audit">,
  group: PersistedGroup,
  importRunId: string,
  error: unknown,
): Promise<{ productId: string | null; errorCode: string }>;
export async function finalizeImportRun(
  repo: ImportRepository,
  importRunId: string,
  sourceAlbumId: string,
  hadFailures: boolean,
  orphanPhotoCount: number,
  checkpointPosition: number,
): Promise<void>;
```

`processProductGroupAttempt` performs one Workflow attempt. It never converts an error into a successful return value. Product ID stays on the D1 group while Workflow retries, so all retries in one cycle reuse one burned-or-succeeded ID. Only `recordExhaustedGroupFailure` moves the group to `failed`. A later `/upload` creates a new import run; `upsertPendingGroup` resets that failed row to `pending` and clears its old Product ID, causing the new five-retry cycle to allocate a fresh ID.

- [ ] **Step 1: Add failing repository and service tests**

```ts
// append to test/db/import-repository.test.ts
it("resets an exhausted group only when a later import run sees the same group hash", async () => {
  const r = repo();
  const albumId = `album-${crypto.randomUUID()}`;
  const firstRunId = crypto.randomUUID();
  const secondRunId = crypto.randomUUID();
  const groupHash = `hash-${crypto.randomUUID()}`;
  await r.createImportRun({ id: firstRunId, sourceAlbumId: albumId, trigger: "cron" });

  const first = await r.upsertPendingGroup({
    id: crypto.randomUUID(), importRunId: firstRunId, ordinal: 0, groupHash,
    firstPhotoId: "m1", lastPhotoId: "p9",
  });
  await r.setGroupState(first.id, "failed", {
    productId: "A-501", failureReason: "airtable_rate_limited", attemptCount: 6,
  });

  const sameRun = await r.upsertPendingGroup({
    id: crypto.randomUUID(), importRunId: firstRunId, ordinal: 0, groupHash,
    firstPhotoId: "m1", lastPhotoId: "p9",
  });
  expect(sameRun).toMatchObject({
    id: first.id,
    state: "failed",
    productId: "A-501",
    attemptCount: 6,
  });

  await r.finalizeImportRun({
    id: firstRunId,
    sourceAlbumId: albumId,
    status: "completed_with_failures",
    orphanPhotoCount: 0,
    checkpointPosition: 9,
  });
  await r.createImportRun({ id: secondRunId, sourceAlbumId: albumId, trigger: "line" });

  const retried = await r.upsertPendingGroup({
    id: crypto.randomUUID(), importRunId: secondRunId, ordinal: 0, groupHash,
    firstPhotoId: "m1", lastPhotoId: "p9",
  });

  expect(retried).toMatchObject({
    id: first.id,
    importRunId: secondRunId,
    state: "pending",
    productId: null,
    airtableRecordId: null,
    attemptCount: 0,
    failureReason: null,
  });
});
```

```ts
// append to test/import/service.test.ts
import { NonRetryableError } from "cloudflare:workflows";
import { OperationalError } from "../../src/shared/errors";
import {
  processProductGroupAttempt,
  recordExhaustedGroupFailure,
  finalizeImportRun,
  type ProcessGroupDeps,
  type PersistedGroup,
} from "../../src/import/service";
import { createSequenceRepository } from "../../src/db/sequence-repository";
import { createAuditLog } from "../../src/db/audit";
import type { AirtableProductsClient } from "../../src/import/airtable-products";

function fakeAirtable(overrides: Partial<AirtableProductsClient> = {}): AirtableProductsClient {
  return {
    findBySystemGroupId: async () => null,
    createProduct: async () => ({ recordId: "rec-created" }),
    verifyProduct: async () => true,
    deleteProduct: async () => {},
    ...overrides,
  };
}

async function buildProcessDeps(
  airtableOverrides: Partial<AirtableProductsClient> = {},
): Promise<{ deps: ProcessGroupDeps; group: PersistedGroup }> {
  const env = testEnv();
  const clock = fixedClock("2026-09-01T09:00:00.000Z");
  const repo = createImportRepository(env.DB, sequentialIdGenerator("row"), clock);
  const sequences = createSequenceRepository(env.DB);
  await sequences.bootstrap("product_id", 501);
  const sourceAlbumId = `album-${crypto.randomUUID()}`;
  const importRunId = `run-${crypto.randomUUID()}`;
  await repo.createImportRun({ id: importRunId, sourceAlbumId, trigger: "cron" });
  const groupHash = `group-${crypto.randomUUID()}`;
  const row = await repo.upsertPendingGroup({
    id: crypto.randomUUID(), importRunId, ordinal: 0, groupHash,
    firstPhotoId: "m1", lastPhotoId: "p2",
  });
  return {
    deps: {
      imageSource: {} as ImageSource,
      marker: {} as MarkerDetector,
      repo,
      assets: createAssetStore(
        env.IMAGES_BUCKET,
        { signingSecret: "test-secret", publicBaseUrl: "https://example.workers.dev" },
        clock,
      ),
      clock,
      ids: sequentialIdGenerator("id"),
      sourceAlbumId,
      firstImportCutoffDate: null,
      sequences,
      audit: createAuditLog(env.DB, sequentialIdGenerator("audit"), clock),
      airtable: fakeAirtable(airtableOverrides),
      productIdPrefix: "A",
      assetUrlTtlSeconds: 300,
    },
    group: {
      groupId: groupHash,
      groupRowId: row.id,
      ordinal: 0,
      markerPhotoId: "m1",
      attachablePhotos: [
        { applePhotoId: "p1", r2Key: "assets/p1.jpg" },
        { applePhotoId: "p2", r2Key: "assets/p2.jpg" },
      ],
    },
  };
}

describe("processProductGroupAttempt", () => {
  it("reuses one Product ID across a transient Workflow retry", async () => {
    let createCalls = 0;
    const { deps, group } = await buildProcessDeps({
      createProduct: async () => {
        createCalls += 1;
        if (createCalls === 1) {
          throw new OperationalError("airtable_rate_limited", "rate limited", true);
        }
        return { recordId: "rec-ok" };
      },
    });

    await expect(processProductGroupAttempt(deps, group, "run-correlation"))
      .rejects.toMatchObject({ code: "airtable_rate_limited", retryable: true });
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "importing", productId: "A-501", attemptCount: 1,
    });

    await expect(processProductGroupAttempt(deps, group, "run-correlation"))
      .resolves.toEqual({ outcome: "succeeded", productId: "A-501" });
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "succeeded", productId: "A-501", attemptCount: 2,
    });
  });

  it("deletes a known partial Airtable row and rethrows instead of returning failed", async () => {
    let deletedRecordId: string | null = null;
    const { deps, group } = await buildProcessDeps({
      verifyProduct: async () => false,
      deleteProduct: async (recordId) => { deletedRecordId = recordId; },
    });

    await expect(processProductGroupAttempt(deps, group, "run-correlation"))
      .rejects.toMatchObject({ code: "airtable_verification_failed", retryable: true });
    expect(deletedRecordId).toBe("rec-created");
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "importing", productId: "A-501",
    });
  });

  it("surfaces partial-row cleanup failure as retryable instead of hiding it", async () => {
    const { deps, group } = await buildProcessDeps({
      verifyProduct: async () => false,
      deleteProduct: async () => { throw new Error("delete unavailable"); },
    });

    await expect(processProductGroupAttempt(deps, group, "run-correlation"))
      .rejects.toMatchObject({ code: "airtable_cleanup_failed", retryable: true });
  });

  it("recovers a response-lost Airtable create by System Group ID without another allocation", async () => {
    const { deps, group } = await buildProcessDeps({
      findBySystemGroupId: async () => ({ recordId: "rec-existing", productId: "A-501" }),
    });
    await deps.repo.setGroupState(group.groupRowId, "importing", { productId: "A-501" });

    await expect(processProductGroupAttempt(deps, group, "run-correlation"))
      .resolves.toEqual({ outcome: "succeeded", productId: "A-501" });
  });
});

describe("recordExhaustedGroupFailure", () => {
  it("marks failed only after Workflow gives up and preserves the burned Product ID", async () => {
    const { deps, group } = await buildProcessDeps();
    await deps.repo.setGroupState(group.groupRowId, "importing", { productId: "A-501", attemptCount: 6 });

    const result = await recordExhaustedGroupFailure(
      deps,
      group,
      "run-correlation",
      new OperationalError("airtable_rate_limited", "rate limited", true),
    );

    expect(result).toEqual({ productId: "A-501", errorCode: "airtable_rate_limited" });
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "failed", productId: "A-501", failureReason: "airtable_rate_limited",
    });
  });

  it("recovers the operational code from NonRetryableError.name", async () => {
    const { deps, group } = await buildProcessDeps();
    const wrapped = new NonRetryableError(
      "Product group row is missing",
      "product_group_missing",
    );

    const result = await recordExhaustedGroupFailure(
      deps,
      group,
      "run-correlation",
      wrapped,
    );

    expect(result).toEqual({
      productId: null,
      errorCode: "product_group_missing",
    });
    expect(await deps.repo.findGroupByHash(group.groupId)).toMatchObject({
      state: "failed",
      failureReason: "product_group_missing",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/db/import-repository.test.ts test/import/service.test.ts`
Expected: FAIL because failed-run reset and attempt/exhaustion functions do not exist.

- [ ] **Step 3: Make `upsertPendingGroup` reset only failed groups entering a new run**

Replace the `ON CONFLICT(group_hash) DO UPDATE` clause in `src/db/import-repository.ts` with:

```sql
ON CONFLICT(group_hash) DO UPDATE SET
  import_run_id = excluded.import_run_id,
  ordinal = excluded.ordinal,
  first_photo_id = excluded.first_photo_id,
  last_photo_id = excluded.last_photo_id,
  state = CASE
    WHEN product_groups.state = 'failed'
      AND product_groups.import_run_id <> excluded.import_run_id
    THEN 'pending' ELSE product_groups.state END,
  product_id = CASE
    WHEN product_groups.state = 'failed'
      AND product_groups.import_run_id <> excluded.import_run_id
    THEN NULL ELSE product_groups.product_id END,
  airtable_record_id = CASE
    WHEN product_groups.state = 'failed'
      AND product_groups.import_run_id <> excluded.import_run_id
    THEN NULL ELSE product_groups.airtable_record_id END,
  attempt_count = CASE
    WHEN product_groups.state = 'failed'
      AND product_groups.import_run_id <> excluded.import_run_id
    THEN 0 ELSE product_groups.attempt_count END,
  failure_reason = CASE
    WHEN product_groups.state = 'failed'
      AND product_groups.import_run_id <> excluded.import_run_id
    THEN NULL ELSE product_groups.failure_reason END,
  updated_at = excluded.updated_at
```

This preserves `succeeded` rows forever, preserves one Product ID during one Workflow cycle, and starts a failed group with a fresh ID only when a later import run sees it.

- [ ] **Step 4: Append the one-attempt and exhausted-failure implementation**

```ts
// append to src/import/service.ts
import type { SequenceRepository } from "../db/sequence-repository";
import type { AuditLog } from "../db/audit";
import type { AirtableProductsClient } from "./airtable-products";
import { todayBangkokDate } from "../shared/time";

export interface ProcessGroupDeps extends ImportServiceDeps {
  sequences: SequenceRepository;
  audit: AuditLog;
  airtable: AirtableProductsClient;
  productIdPrefix: string;
  assetUrlTtlSeconds: number;
}

export interface ProcessGroupOutcome {
  outcome: "succeeded";
  productId: string;
}

function operationalizeGroupError(error: unknown): OperationalError {
  return error instanceof OperationalError
    ? error
    : new OperationalError(
        "product_group_attempt_failed",
        error instanceof Error ? error.message : "Product group attempt failed",
        true,
      );
}

export async function processProductGroupAttempt(
  deps: ProcessGroupDeps,
  group: PersistedGroup,
  importRunId: string,
): Promise<ProcessGroupOutcome> {
  const current = await deps.repo.findGroupByHash(group.groupId);
  if (current === null) {
    throw new OperationalError("product_group_missing", "Product group row is missing", false);
  }

  let productId = current.productId;
  if (productId === null) {
    const nextNumber = await deps.sequences.allocateNext("product_id");
    productId = `${deps.productIdPrefix}-${nextNumber}`;
    await deps.repo.setGroupState(group.groupRowId, "importing", { productId });
    await deps.audit.record({
      correlationId: importRunId,
      actor: "system:import",
      action: "product_id_allocated",
      beforeValue: null,
      afterValue: productId,
    });
  }

  await deps.repo.setGroupState(group.groupRowId, "importing", {
    attemptCount: current.attemptCount + 1,
    failureReason: null,
  });

  const existing = await deps.airtable.findBySystemGroupId(group.groupId);
  if (existing !== null) {
    await deps.repo.setGroupState(group.groupRowId, "succeeded", {
      productId: existing.productId,
      airtableRecordId: existing.recordId,
    });
    return { outcome: "succeeded", productId: existing.productId };
  }

  let createdRecordId: string | null = null;
  try {
    const productImages = await Promise.all(
      group.attachablePhotos.map(async (photo) => {
        if (!/^assets\/[A-Za-z0-9._-]+$/.test(photo.r2Key)) {
          throw new OperationalError(
            "invalid_asset_key",
            `Cannot expose malformed asset key for ${photo.applePhotoId}`,
            false,
          );
        }
        return {
          url: await deps.assets.signUrl(
            photo.r2Key,
            deps.assetUrlTtlSeconds,
          ),
          filename: photo.r2Key.slice("assets/".length),
        };
      }),
    );
    const created = await deps.airtable.createProduct({
      productId,
      systemGroupId: group.groupId,
      uploadDate: todayBangkokDate(deps.clock),
      productImages,
    });
    createdRecordId = created.recordId;
    await deps.repo.setGroupState(group.groupRowId, "importing", {
      airtableRecordId: createdRecordId,
    });

    if (!await deps.airtable.verifyProduct(createdRecordId, group.attachablePhotos.length)) {
      throw new OperationalError(
        "airtable_verification_failed",
        "Airtable Product verification failed",
        true,
      );
    }

    await deps.repo.setGroupState(group.groupRowId, "succeeded", {
      productId,
      airtableRecordId: createdRecordId,
      failureReason: null,
    });
    await deps.audit.record({
      correlationId: importRunId,
      actor: "system:import",
      action: "product_group_succeeded",
      beforeValue: "importing",
      afterValue: productId,
    });
    return { outcome: "succeeded", productId };
  } catch (error) {
    let operational = operationalizeGroupError(error);
    if (createdRecordId !== null) {
      try {
        await deps.airtable.deleteProduct(createdRecordId);
      } catch (cleanupError) {
        operational = new OperationalError(
          "airtable_cleanup_failed",
          cleanupError instanceof Error
            ? cleanupError.message
            : "Airtable partial-row cleanup failed",
          true,
        );
      }
    }
    await deps.audit.record({
      correlationId: importRunId,
      actor: "system:import",
      action: "product_group_attempt_failed",
      beforeValue: productId,
      afterValue: operational.code,
    });
    throw operational;
  }
}

export async function recordExhaustedGroupFailure(
  deps: Pick<ProcessGroupDeps, "repo" | "audit">,
  group: PersistedGroup,
  importRunId: string,
  error: unknown,
): Promise<{ productId: string | null; errorCode: string }> {
  const current = await deps.repo.findGroupByHash(group.groupId);
  const errorCode = error instanceof OperationalError
    ? error.code
    : error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.name)
      ? error.name
      : "unknown_error";
  await deps.repo.setGroupState(group.groupRowId, "failed", { failureReason: errorCode });
  await deps.audit.record({
    correlationId: importRunId,
    actor: "system:import",
    action: "product_group_failed",
    beforeValue: "importing",
    afterValue: errorCode,
  });
  return { productId: current?.productId ?? null, errorCode };
}

export async function finalizeImportRun(
  repo: ImportRepository,
  importRunId: string,
  sourceAlbumId: string,
  hadFailures: boolean,
  orphanPhotoCount: number,
  checkpointPosition: number,
): Promise<void> {
  await repo.finalizeImportRun({
    id: importRunId,
    sourceAlbumId,
    status: hadFailures ? "completed_with_failures" : "completed",
    orphanPhotoCount,
    checkpointPosition,
  });
}
```

- [ ] **Step 5: Run focused and full checks**

Run: `npm test -- test/db/import-repository.test.ts test/import/service.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/import-repository.ts test/db/import-repository.test.ts src/import/service.ts test/import/service.test.ts
git commit -m "feat(import): preserve Product IDs through durable group retries"
```

---

### Task 14: ImportWorkflow durable retries and sibling isolation

**Files:**
- Create: `src/import/workflow.ts`
- Test: `test/import/workflow.test.ts`

**Interfaces:**
- Consumes: `downloadAndGroupSnapshot`, `processProductGroupAttempt`, `recordExhaustedGroupFailure`, `finalizeImportRun`, `isRetryable`, `sendImportSummary`, `Env`, and `AppConfig`.
- Produces:

```ts
export class ImportWorkflow extends WorkflowEntrypoint<Env, ImportWorkflowParams> {
  run(event: WorkflowEvent<ImportWorkflowParams>, step: WorkflowStep): Promise<ImportRunResult>;
}
```

Each group gets its own `step.do()` with five exponential retries. Attempt errors must escape the callback. The outer loop catches only after the step has exhausted retries or thrown `NonRetryableError`, records that group failed, and continues sibling groups.

- [ ] **Step 1: Write failing orchestration tests**

```ts
// test/import/workflow.test.ts
import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it, vi } from "vitest";
import { OperationalError } from "../../src/shared/errors";
import { runImportWorkflow } from "../../src/import/workflow";
import type { ProcessGroupDeps, PersistedGroup } from "../../src/import/service";

function retryingStep() {
  const calls: Array<{ name: string; retryLimit: number | null; attempts: number }> = [];
  return {
    calls,
    async do<T>(
      name: string,
      optionsOrCallback: unknown,
      maybeCallback?: () => Promise<T>,
    ): Promise<T> {
      const hasOptions = typeof optionsOrCallback !== "function";
      const callback = (hasOptions ? maybeCallback : optionsOrCallback) as () => Promise<T>;
      const retryLimit = hasOptions
        ? (optionsOrCallback as { retries?: { limit: number } }).retries?.limit ?? 0
        : 0;
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          const value = await callback();
          calls.push({ name, retryLimit, attempts: attempt });
          return value;
        } catch (error) {
          if (attempt > retryLimit || error instanceof NonRetryableError) {
            calls.push({ name, retryLimit, attempts: attempt });
            throw error;
          }
        }
      }
    },
  };
}

function group(id: string, ordinal: number): PersistedGroup {
  return {
    groupId: id,
    groupRowId: `row-${id}`,
    ordinal,
    markerPhotoId: `marker-${id}`,
    attachablePhotos: [{ applePhotoId: `photo-${id}`, r2Key: `assets/${id}.jpg` }],
  };
}

describe("runImportWorkflow", () => {
  it("lets a transient group error escape step.do so retry succeeds with one Product ID", async () => {
    const step = retryingStep();
    const process = vi.fn()
      .mockRejectedValueOnce(new OperationalError("airtable_rate_limited", "rate limited", true))
      .mockResolvedValue({ outcome: "succeeded", productId: "A-501" });
    const finalize = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    const deps = {
      repo: {}, clock: { now: () => new Date("2026-09-01T09:00:00.000Z") },
    } as ProcessGroupDeps;

    const result = await runImportWorkflow(
      deps,
      { importRunId: "run-1", sourceAlbumId: "album-1", trigger: "cron" },
      step,
      {
        retryLimit: 5,
        downloadAndGroup: async () => ({ pendingGroups: [group("g1", 0)], orphanRange: null, checkpointPosition: 10 }),
        processGroupAttempt: process,
        recordExhaustedFailure: vi.fn(),
        finalize,
        notify,
      },
    );

    expect(process).toHaveBeenCalledTimes(2);
    expect(result.succeededProductIds).toEqual(["A-501"]);
    expect(result.failedGroups).toEqual([]);
    expect(step.calls.find((call) => call.name === "process-group-row-g1"))
      .toMatchObject({ retryLimit: 5, attempts: 2 });
    expect(finalize).toHaveBeenCalledWith(false, 0, 10);
  });

  it("records an exhausted group then continues the next sibling", async () => {
    const step = retryingStep();
    const process = vi.fn(async (_deps, current: PersistedGroup) => {
      if (current.groupId === "g1") {
        throw new OperationalError("airtable_rate_limited", "rate limited", true);
      }
      return { outcome: "succeeded" as const, productId: "A-502" };
    });
    const record = vi.fn().mockResolvedValue({
      productId: "A-501", errorCode: "airtable_rate_limited",
    });

    const result = await runImportWorkflow(
      { repo: {}, clock: { now: () => new Date() } } as ProcessGroupDeps,
      { importRunId: "run-1", sourceAlbumId: "album-1", trigger: "line" },
      step,
      {
        retryLimit: 5,
        downloadAndGroup: async () => ({
          pendingGroups: [group("g1", 0), group("g2", 1)], orphanRange: null, checkpointPosition: 10,
        }),
        processGroupAttempt: process,
        recordExhaustedFailure: record,
        finalize: vi.fn().mockResolvedValue(undefined),
        notify: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(record).toHaveBeenCalledTimes(1);
    expect(result.failedGroups).toEqual([
      { groupId: "row-g1", productId: "A-501", errorCode: "airtable_rate_limited" },
    ]);
    expect(result.succeededProductIds).toEqual(["A-502"]);
  });

  it("uses NonRetryableError once while preserving the operational code", async () => {
    const step = retryingStep();
    const process = vi.fn().mockRejectedValue(
      new OperationalError(
        "product_group_missing",
        "Product group row is missing",
        false,
      ),
    );
    const record = vi.fn().mockResolvedValue({
      productId: null,
      errorCode: "product_group_missing",
    });

    await runImportWorkflow(
      { repo: {}, clock: { now: () => new Date() } } as ProcessGroupDeps,
      { importRunId: "run-1", sourceAlbumId: "album-1", trigger: "cron" },
      step,
      {
        retryLimit: 5,
        downloadAndGroup: async () => ({
          pendingGroups: [group("g1", 0)],
          orphanRange: null,
          checkpointPosition: 10,
        }),
        processGroupAttempt: process,
        recordExhaustedFailure: record,
        finalize: vi.fn().mockResolvedValue(undefined),
        notify: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(process).toHaveBeenCalledTimes(1);
    expect(step.calls.find((call) => call.name === "process-group-row-g1"))
      .toMatchObject({ attempts: 1 });
    expect(record.mock.calls[0][3]).toMatchObject({
      name: "product_group_missing",
      message: "Product group row is missing",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/import/workflow.test.ts`
Expected: FAIL because `runImportWorkflow` does not exist.

- [ ] **Step 3: Write durable orchestration and Worker entrypoint**

```ts
// src/import/workflow.ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "../env";
import { parseConfig } from "../config";
import { isRetryable, OperationalError } from "../shared/errors";
import { newCorrelationId } from "../shared/ids";
import { createICloudClient } from "../icloud/client";
import { createMarkerDetector } from "./marker";
import { createImportRepository } from "../db/import-repository";
import { createSequenceRepository } from "../db/sequence-repository";
import { createAuditLog } from "../db/audit";
import { createAssetStore } from "./asset-store";
import { createAirtableProductsClient } from "./airtable-products";
import { createLineClient, type LineClient } from "../line/client";
import { bangkokDateTimeThai } from "../shared/time";
import { sendImportSummary } from "./notify";
import type { ImportRunResult, ImportWorkflowParams } from "./types";
import {
  downloadAndGroupSnapshot,
  finalizeImportRun,
  processProductGroupAttempt,
  recordExhaustedGroupFailure,
  type DownloadAndGroupOutcome,
  type ProcessGroupDeps,
  type PersistedGroup,
} from "./service";

interface WorkflowStepLike {
  do<T>(
    name: string,
    optionsOrCallback: unknown,
    maybeCallback?: () => Promise<T>,
  ): Promise<T>;
}

interface ImportWorkflowOperations {
  retryLimit: number;
  downloadAndGroup(): Promise<DownloadAndGroupOutcome>;
  processGroupAttempt(deps: ProcessGroupDeps, group: PersistedGroup, importRunId: string): Promise<{ outcome: "succeeded"; productId: string }>;
  recordExhaustedFailure(deps: ProcessGroupDeps, group: PersistedGroup, importRunId: string, error: unknown): Promise<{ productId: string | null; errorCode: string }>;
  finalize(hadFailures: boolean, orphanPhotoCount: number, checkpointPosition: number): Promise<void>;
  notify(result: ImportRunResult, orphanRange: DownloadAndGroupOutcome["orphanRange"]): Promise<void>;
}

export async function runImportWorkflow(
  deps: ProcessGroupDeps,
  payload: ImportWorkflowParams,
  step: WorkflowStepLike,
  operations: ImportWorkflowOperations,
): Promise<ImportRunResult> {
  const { pendingGroups, orphanRange, checkpointPosition } = await step.do(
    "download-and-group",
    () => operations.downloadAndGroup(),
  );
  const succeededProductIds: string[] = [];
  const failedGroups: ImportRunResult["failedGroups"] = [];

  for (const group of pendingGroups) {
    try {
      const outcome = await step.do(
        `process-group-${group.groupRowId}`,
        {
          retries: {
            limit: operations.retryLimit,
            delay: "10 seconds",
            backoff: "exponential",
          },
        },
        async () => {
          try {
            return await operations.processGroupAttempt(deps, group, payload.importRunId);
          } catch (error) {
            if (!isRetryable(error)) {
              const code = error instanceof OperationalError
                ? error.code
                : "non_retryable_group_error";
              const message = error instanceof Error
                ? error.message
                : "Non-retryable group error";
              throw new NonRetryableError(message, code);
            }
            throw error;
          }
        },
      );
      succeededProductIds.push(outcome.productId);
    } catch (error) {
      const failure = await step.do(
        `record-failed-group-${group.groupRowId}`,
        () => operations.recordExhaustedFailure(deps, group, payload.importRunId, error),
      );
      failedGroups.push({
        groupId: group.groupRowId,
        productId: failure.productId,
        errorCode: failure.errorCode,
      });
    }
  }

  const result: ImportRunResult = {
    importRunId: payload.importRunId,
    succeededProductIds,
    failedGroups,
  };
  await step.do("finalize-checkpoint", () =>
    operations.finalize(
      failedGroups.length > 0,
      orphanRange?.count ?? 0,
      checkpointPosition,
    ),
  );
  await step.do("send-import-summary", () => operations.notify(result, orphanRange));
  return result;
}

export class ImportWorkflow extends WorkflowEntrypoint<Env, ImportWorkflowParams> {
  async run(event: WorkflowEvent<ImportWorkflowParams>, step: WorkflowStep): Promise<ImportRunResult> {
    const config = parseConfig(this.env.APP_CONFIG_JSON);
    const clock = { now: () => new Date() };
    const ids = { next: () => newCorrelationId() };
    const repo = createImportRepository(this.env.DB, ids, clock);
    const deps: ProcessGroupDeps = {
      imageSource: createICloudClient(this.env.ICLOUD_SHARED_ALBUM_TOKEN, fetch),
      marker: createMarkerDetector(this.env.IMAGES),
      repo,
      assets: createAssetStore(
        this.env.IMAGES_BUCKET,
        {
          signingSecret: this.env.ASSET_URL_SIGNING_SECRET,
          publicBaseUrl: config.publicBaseUrl,
        },
        clock,
      ),
      clock,
      ids,
      sourceAlbumId: event.payload.sourceAlbumId,
      firstImportCutoffDate: config.firstImportCutoffDate,
      sequences: createSequenceRepository(this.env.DB),
      audit: createAuditLog(this.env.DB, ids, clock),
      airtable: createAirtableProductsClient({
        baseId: config.airtableBaseId,
        tableId: config.airtableProductsTableId,
        token: this.env.AIRTABLE_TOKEN,
        fetch,
      }),
      productIdPrefix: config.productIdPrefix,
      assetUrlTtlSeconds: 300,
    };
    const line: LineClient = createLineClient({
      channelAccessToken: this.env.LINE_CHANNEL_ACCESS_TOKEN,
      fetch,
    });

    return runImportWorkflow(deps, event.payload, step, {
      retryLimit: config.importRetryLimit,
      downloadAndGroup: () => downloadAndGroupSnapshot(deps, event.payload.importRunId),
      processGroupAttempt: processProductGroupAttempt,
      recordExhaustedFailure: recordExhaustedGroupFailure,
      finalize: (hadFailures, orphanPhotoCount, checkpointPosition) =>
        finalizeImportRun(
          repo,
          event.payload.importRunId,
          event.payload.sourceAlbumId,
          hadFailures,
          orphanPhotoCount,
          checkpointPosition,
        ),
      notify: (result, orphanRange) => sendImportSummary(
        line,
        config.lineAllowedGroupId,
        { result, orphanRange, nowThaiText: bangkokDateTimeThai(clock) },
      ),
    });
  }
}
```

Task 5 and the implementation index already define `ImportWorkflowParams` with `sourceAlbumId`; route creation and Workflow execution therefore use the same safe digest for concurrency and identity checks.

- [ ] **Step 4: Run focused and full checks**

Run: `npm test -- test/import/workflow.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/import/types.ts src/import/workflow.ts test/import/workflow.test.ts docs/superpowers/plans/2026-09-01-snazzy-automation-implementation-index.md
git commit -m "feat(import): add durable group retries with sibling isolation"
```

---

### Task 15: Authenticated cron and `/upload` Workflow triggers

**Files:**
- Create: `src/shared/admin-auth.ts`
- Create: `src/routes/upload.ts`
- Create: `src/scheduled.ts`
- Create: `src/router.ts`
- Create: `src/index.ts`
- Modify: `wrangler.jsonc`
- Test: `test/shared/admin-auth.test.ts`
- Test: `test/routes/upload.test.ts`
- Test: `test/router.test.ts`
- Test: `test/scheduled.test.ts`

**Interfaces:**
- Consumes: `Env.IMPORT_WORKFLOW`, `Env.ADMIN_ROUTE_TOKEN`, `deriveSourceAlbumId`, `ImportRepository`, `SequenceRepository.isBootstrapped`, `parseConfig`, `newCorrelationId`, and `handleGetAsset`.
- Produces:

```ts
export function verifyAdminBearer(request: Request, expectedToken: string): Promise<boolean>;
export async function handleUploadTrigger(env: Env, trigger: "cron" | "line" | "admin"): Promise<Response>;
export async function handleScheduled(env: Env, cron: string): Promise<void>;
export async function routeRequest(request: Request, env: Env): Promise<Response>;
```

`POST /upload` is an operator route and requires a bearer value read from secret binding `ADMIN_ROUTE_TOKEN`. LINE command handling calls `handleUploadTrigger(env, "line")` directly inside the Worker after LINE signature and group validation; it never loops through the public HTTP route.

- [ ] **Step 1: Write failing authentication and trigger tests**

```ts
// test/shared/admin-auth.test.ts
import { describe, expect, it } from "vitest";
import { verifyAdminBearer } from "../../src/shared/admin-auth";

describe("verifyAdminBearer", () => {
  it("accepts only the exact bearer token", async () => {
    expect(await verifyAdminBearer(
      new Request("https://worker.example/upload", {
        headers: { authorization: "Bearer admin-secret" },
      }),
      "admin-secret",
    )).toBe(true);
    expect(await verifyAdminBearer(
      new Request("https://worker.example/upload", {
        headers: { authorization: "Bearer wrong" },
      }),
      "admin-secret",
    )).toBe(false);
  });
});
```

```ts
// test/routes/upload.test.ts
import { describe, expect, it, vi } from "vitest";
import { testEnv } from "../helpers/env";
import { createSequenceRepository } from "../../src/db/sequence-repository";
import { deriveSourceAlbumId } from "../../src/icloud/client";
import { handleUploadTrigger } from "../../src/routes/upload";

async function readyEnv() {
  const env = testEnv();
  await createSequenceRepository(env.DB).bootstrap(
    "product_id",
    1,
  );
  return env;
}

describe("handleUploadTrigger", () => {
  it("rejects every trigger before Product ID bootstrap", async () => {
    const env = testEnv();
    const create = vi.fn();
    env.IMPORT_WORKFLOW = { create } as typeof env.IMPORT_WORKFLOW;

    const response = await handleUploadTrigger(env, "cron");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "sequence_not_bootstrapped",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("persists the safe album digest and starts ImportWorkflow", async () => {
    const env = await readyEnv();
    const create = vi.fn().mockResolvedValue({ id: "instance-1" });
    env.IMPORT_WORKFLOW = { create } as typeof env.IMPORT_WORKFLOW;

    const response = await handleUploadTrigger(env, "line");

    expect(response.status).toBe(202);
    const [{ id, params }] = create.mock.calls[0];
    const expectedSourceAlbumId = await deriveSourceAlbumId(
      env.ICLOUD_SHARED_ALBUM_TOKEN,
    );
    expect(id).toMatch(/^import-/);
    expect(params).toMatchObject({
      sourceAlbumId: expectedSourceAlbumId,
      trigger: "line",
    });
    expect(JSON.stringify(params)).not.toContain(
      env.ICLOUD_SHARED_ALBUM_TOKEN,
    );
  });

  it("allows only one concurrent running import per album", async () => {
    const env = await readyEnv();
    const create = vi.fn().mockResolvedValue({ id: "instance-1" });
    env.IMPORT_WORKFLOW = { create } as typeof env.IMPORT_WORKFLOW;

    const responses = await Promise.all([
      handleUploadTrigger(env, "cron"),
      handleUploadTrigger(env, "cron"),
    ]);

    expect(responses.map((response) => response.status).sort())
      .toEqual([202, 409]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("releases the running-run lock when Workflow creation fails", async () => {
    const env = await readyEnv();
    const create = vi.fn()
      .mockRejectedValueOnce(new Error("workflow unavailable"))
      .mockResolvedValueOnce({ id: "instance-2" });
    env.IMPORT_WORKFLOW = { create } as typeof env.IMPORT_WORKFLOW;

    expect((await handleUploadTrigger(env, "admin")).status).toBe(502);
    expect((await handleUploadTrigger(env, "admin")).status).toBe(202);
  });
});
```

```ts
// test/router.test.ts
import { describe, expect, it, vi } from "vitest";
import { testEnv } from "./helpers/env";
import { createSequenceRepository } from "../src/db/sequence-repository";
import { routeRequest } from "../src/router";

describe("routeRequest", () => {
  it("rejects an unauthenticated direct /upload request", async () => {
    const env = testEnv();
    const create = vi.fn();
    env.IMPORT_WORKFLOW = { create } as typeof env.IMPORT_WORKFLOW;

    const response = await routeRequest(
      new Request("https://worker.example/upload", { method: "POST" }),
      env,
    );

    expect(response.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it("starts an admin-triggered import for the valid bearer token", async () => {
    const env = testEnv();
    await createSequenceRepository(env.DB).bootstrap(
      "product_id",
      1,
    );
    const create = vi.fn().mockResolvedValue({ id: "instance-1" });
    env.IMPORT_WORKFLOW = { create } as typeof env.IMPORT_WORKFLOW;

    const response = await routeRequest(
      new Request("https://worker.example/upload", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.ADMIN_ROUTE_TOKEN}`,
        },
      }),
      env,
    );

    expect(response.status).toBe(202);
    expect(create.mock.calls[0][0].params.trigger).toBe("admin");
  });
});
```

```ts
// test/scheduled.test.ts
import { describe, expect, it, vi } from "vitest";
import { testEnv } from "./helpers/env";
import { createSequenceRepository } from "../src/db/sequence-repository";
import { handleScheduled } from "../src/scheduled";

describe("handleScheduled", () => {
  it("starts ImportWorkflow only for IMPORT_CRON", async () => {
    const env = testEnv();
    await createSequenceRepository(env.DB).bootstrap(
      "product_id",
      1,
    );
    const create = vi.fn().mockResolvedValue({ id: "instance-1" });
    env.IMPORT_WORKFLOW = { create } as typeof env.IMPORT_WORKFLOW;

    await handleScheduled(env, "0 23 * * *");
    await handleScheduled(env, "15 4 * * *");

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].params.trigger).toBe("cron");
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run test/shared/admin-auth.test.ts test/routes/upload.test.ts test/router.test.ts test/scheduled.test.ts`
Expected: FAIL because authentication, routes, scheduler, and Worker entrypoint do not exist.

- [ ] **Step 3: Implement constant-time bearer verification**

```ts
// src/shared/admin-auth.ts
function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return new Uint8Array(digest);
}

export async function verifyAdminBearer(
  request: Request,
  expectedToken: string,
): Promise<boolean> {
  const providedToken = bearerToken(request);
  if (providedToken === null || expectedToken.length === 0) {
    return false;
  }
  const [providedHash, expectedHash] = await Promise.all([
    sha256(providedToken),
    sha256(expectedToken),
  ]);
  let difference = 0;
  for (let index = 0; index < expectedHash.length; index += 1) {
    difference |= providedHash[index] ^ expectedHash[index];
  }
  return difference === 0;
}
```

- [ ] **Step 4: Implement race-safe Workflow creation**

```ts
// src/routes/upload.ts
import type { Env } from "../env";
import { createImportRepository } from "../db/import-repository";
import { createSequenceRepository } from "../db/sequence-repository";
import { deriveSourceAlbumId } from "../icloud/client";
import type { ImportWorkflowParams } from "../import/types";
import { newCorrelationId } from "../shared/ids";

function json(status: number, body: Record<string, string>): Response {
  return Response.json(body, { status });
}

export async function handleUploadTrigger(
  env: Env,
  trigger: "cron" | "line" | "admin",
): Promise<Response> {
  const clock = { now: () => new Date() };
  const ids = { next: () => newCorrelationId() };
  const repo = createImportRepository(env.DB, ids, clock);
  const sequences = createSequenceRepository(env.DB);

  if (!await sequences.isBootstrapped("product_id")) {
    return json(503, {
      status: "sequence_not_bootstrapped",
    });
  }

  const sourceAlbumId = await deriveSourceAlbumId(
    env.ICLOUD_SHARED_ALBUM_TOKEN,
  );

  if (await repo.hasRunningImportRun(sourceAlbumId)) {
    return json(409, { status: "already_running" });
  }

  const importRunId = ids.next();
  try {
    await repo.createImportRun({
      id: importRunId,
      sourceAlbumId,
      trigger,
    });
  } catch (error) {
    if (await repo.hasRunningImportRun(sourceAlbumId)) {
      return json(409, { status: "already_running" });
    }
    throw error;
  }

  const params: ImportWorkflowParams = {
    importRunId,
    sourceAlbumId,
    trigger,
  };
  try {
    const instance = await env.IMPORT_WORKFLOW.create({
      id: `import-${importRunId}`,
      params,
    });
    return Response.json({
      status: "started",
      importRunId,
      workflowInstanceId: instance.id,
    }, { status: 202 });
  } catch {
    await repo.markImportRunStartFailed(importRunId);
    return json(502, { status: "workflow_start_failed" });
  }
}
```

- [ ] **Step 5: Implement complete router, scheduler, and entrypoint**

```ts
// src/scheduled.ts
import type { Env } from "./env";
import { parseConfig } from "./config";
import { handleUploadTrigger } from "./routes/upload";

export async function handleScheduled(
  env: Env,
  cron: string,
): Promise<void> {
  const config = parseConfig(env.APP_CONFIG_JSON);
  if (cron === config.importCron) {
    await handleUploadTrigger(env, "cron");
  }
}
```

```ts
// src/router.ts
import type { Env } from "./env";
import { handleGetAsset } from "./routes/assets";
import { handleUploadTrigger } from "./routes/upload";
import { verifyAdminBearer } from "./shared/admin-auth";

export async function routeRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  if (
    request.method === "GET" &&
    url.pathname.startsWith("/assets/")
  ) {
    return handleGetAsset(request, env, { now: () => new Date() });
  }

  if (request.method === "POST" && url.pathname === "/upload") {
    if (!await verifyAdminBearer(request, env.ADMIN_ROUTE_TOKEN)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return handleUploadTrigger(env, "admin");
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}
```

```ts
// src/index.ts
import type { Env } from "./env";
import { routeRequest } from "./router";
import { handleScheduled } from "./scheduled";

export { ImportWorkflow } from "./import/workflow";

export default {
  fetch(request, env) {
    return routeRequest(request, env);
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(handleScheduled(env, controller.cron));
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 6: Add exact local Workflow binding**

Add this top-level property to the `wrangler.jsonc` object created in Task 1:

```jsonc
"workflows": [
  {
    "name": "snazzy-import-workflow-local",
    "binding": "IMPORT_WORKFLOW",
    "class_name": "ImportWorkflow"
  }
]
```

Staging and production resource names and IDs are created and inserted by the hardening plan; this task contains no remote-resource placeholder.

- [ ] **Step 7: Run focused and full checks**

Run: `npx vitest run test/shared/admin-auth.test.ts test/routes/upload.test.ts test/router.test.ts test/scheduled.test.ts`
Expected: PASS (8 tests).

Run: `npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/shared/admin-auth.ts src/routes/upload.ts src/scheduled.ts src/router.ts src/index.ts wrangler.jsonc test/shared/admin-auth.test.ts test/routes/upload.test.ts test/router.test.ts test/scheduled.test.ts
git commit -m "feat(routes): secure import workflow triggers"
```

---

### Task 16: Import acceptance tests

**Files:**
- Create: `test/helpers/import-fixtures.ts`
- Create: `test/acceptance/import-acceptance.test.ts`

**Interfaces:**
- Consumes: exact `runImportWorkflow(deps, payload, step, operations)` contract from Task 14 plus all import repositories and clients from Tasks 2–13.
- Produces: no production code. Ten executable cases prove cutoff, explicit checkpoint, durable retry, sibling isolation, failed-group reset, Product ID burning, 100–500-photo volume, and LINE summary behavior.

- [ ] **Step 1: Write mutable stable-snapshot fixtures**

```ts
// test/helpers/import-fixtures.ts
import type {
  AlbumSnapshot,
  ImageSource,
  SourcePhoto,
} from "../../src/icloud/types";
import type { MarkerDetector } from "../../src/import/marker";

export interface BatchPhotoSpec {
  id: string;
  isMarker?: boolean;
  captureAt?: string | null;
}

export class MutableBatchSource implements ImageSource {
  downloads: string[] = [];

  constructor(
    readonly sourceAlbumId: string,
    private specs: BatchPhotoSpec[],
  ) {}

  setSpecs(specs: BatchPhotoSpec[]): void {
    this.specs = specs;
  }

  async getSnapshot(): Promise<AlbumSnapshot> {
    const photos: SourcePhoto[] = this.specs.map((spec, index) => ({
      sourceAlbumId: this.sourceAlbumId,
      applePhotoId: spec.id,
      position: index + 1,
      captureAt: spec.captureAt ?? null,
      derivativeUrl: `https://icloud.example/${spec.id}.jpg`,
      mediaType: "image/jpeg",
    }));
    return {
      sourceAlbumId: this.sourceAlbumId,
      fetchedAt: "2026-09-01T09:00:00.000Z",
      photos,
    };
  }

  async download(photo: SourcePhoto): Promise<Response> {
    this.downloads.push(photo.applePhotoId);
    const spec = this.specs.find((candidate) =>
      candidate.id === photo.applePhotoId,
    );
    const label = spec?.isMarker ? "marker" : "product";
    return new Response(
      new TextEncoder().encode(`${label}-${photo.applePhotoId}`),
      { headers: { "content-type": "image/jpeg" } },
    );
  }
}

export const fakeMarkerDetector: MarkerDetector = {
  async detect(bytes) {
    return new TextDecoder().decode(bytes).startsWith("marker-");
  },
};

export function productGroupOf(
  photoCount: number,
  groupIndex: number,
  captureAt: string | null = null,
): BatchPhotoSpec[] {
  const specs: BatchPhotoSpec[] = [{
    id: `g${groupIndex}-marker`,
    isMarker: true,
    captureAt,
  }];
  for (let index = 0; index < photoCount; index += 1) {
    specs.push({
      id: `g${groupIndex}-photo-${index}`,
      captureAt,
    });
  }
  return specs;
}
```

- [ ] **Step 2: Write exact acceptance harness and ten failing cases**

```ts
// test/acceptance/import-acceptance.test.ts
import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it, vi } from "vitest";
import { testEnv } from "../helpers/env";
import { fixedClock, sequentialIdGenerator } from "../helpers/fakes";
import {
  MutableBatchSource,
  fakeMarkerDetector,
  productGroupOf,
  type BatchPhotoSpec,
} from "../helpers/import-fixtures";
import { createImportRepository } from "../../src/db/import-repository";
import { createSequenceRepository } from "../../src/db/sequence-repository";
import { createAuditLog } from "../../src/db/audit";
import { createAssetStore } from "../../src/import/asset-store";
import {
  downloadAndGroupSnapshot,
  finalizeImportRun,
  processProductGroupAttempt,
  recordExhaustedGroupFailure,
  type ProcessGroupDeps,
} from "../../src/import/service";
import { sendImportSummary } from "../../src/import/notify";
import { runImportWorkflow } from "../../src/import/workflow";
import { OperationalError } from "../../src/shared/errors";
import type {
  AirtableProductPayload,
  AirtableProductsClient,
} from "../../src/import/airtable-products";
import type {
  ImportRunResult,
  ImportWorkflowParams,
} from "../../src/import/types";

function retryingStep() {
  return {
    async do<T>(
      _name: string,
      optionsOrCallback: unknown,
      maybeCallback?: () => Promise<T>,
    ): Promise<T> {
      const hasOptions = typeof optionsOrCallback !== "function";
      const callback = (hasOptions
        ? maybeCallback
        : optionsOrCallback) as () => Promise<T>;
      const retryLimit = hasOptions
        ? (optionsOrCallback as { retries?: { limit: number } })
            .retries?.limit ?? 0
        : 0;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await callback();
        } catch (error) {
          if (
            attempt >= retryLimit ||
            error instanceof NonRetryableError
          ) {
            throw error;
          }
        }
      }
    },
  };
}

interface CreatedProduct {
  recordId: string;
  productId: string;
  imageCount: number;
}

interface Harness {
  deps: ProcessGroupDeps;
  source: MutableBatchSource;
  created: Map<string, CreatedProduct>;
  push: ReturnType<typeof vi.fn>;
  startAndRun(
    runId: string,
    trigger: ImportWorkflowParams["trigger"],
  ): Promise<ImportRunResult>;
  resumeRun(
    runId: string,
    trigger: ImportWorkflowParams["trigger"],
  ): Promise<ImportRunResult>;
}

async function buildHarness(
  sourceAlbumId: string,
  specs: BatchPhotoSpec[],
  options: {
    firstImportCutoffDate?: string | null;
    createProduct?: (
      payload: AirtableProductPayload,
    ) => Promise<{ recordId: string }>;
  } = {},
): Promise<Harness> {
  const env = testEnv();
  const clock = fixedClock("2026-09-01T09:00:00.000Z");
  const repo = createImportRepository(
    env.DB,
    sequentialIdGenerator("row"),
    clock,
  );
  const sequences = createSequenceRepository(env.DB);
  await sequences.bootstrap("product_id", 501);
  const created = new Map<string, CreatedProduct>();
  const airtable: AirtableProductsClient = {
    async findBySystemGroupId(systemGroupId) {
      const row = created.get(systemGroupId);
      return row === undefined
        ? null
        : { recordId: row.recordId, productId: row.productId };
    },
    async createProduct(payload) {
      const response = options.createProduct === undefined
        ? { recordId: `rec-${payload.productId}` }
        : await options.createProduct(payload);
      created.set(payload.systemGroupId, {
        recordId: response.recordId,
        productId: payload.productId,
        imageCount: payload.productImages.length,
      });
      return response;
    },
    async verifyProduct(recordId, expectedImageCount) {
      return [...created.values()].some((row) =>
        row.recordId === recordId &&
        row.imageCount === expectedImageCount,
      );
    },
    async deleteProduct(recordId) {
      for (const [key, row] of created) {
        if (row.recordId === recordId) {
          created.delete(key);
        }
      }
    },
  };
  const source = new MutableBatchSource(sourceAlbumId, specs);
  const push = vi.fn().mockResolvedValue(undefined);
  const deps: ProcessGroupDeps = {
    imageSource: source,
    marker: fakeMarkerDetector,
    repo,
    assets: createAssetStore(
      env.IMAGES_BUCKET,
      {
        signingSecret: "test-secret",
        publicBaseUrl: "https://example.workers.dev",
      },
      clock,
    ),
    clock,
    ids: sequentialIdGenerator("id"),
    sourceAlbumId,
    firstImportCutoffDate:
      options.firstImportCutoffDate ?? null,
    sequences,
    audit: createAuditLog(
      env.DB,
      sequentialIdGenerator("audit"),
      clock,
    ),
    airtable,
    productIdPrefix: "A",
    assetUrlTtlSeconds: 300,
  };

  async function resumeRun(
    runId: string,
    trigger: ImportWorkflowParams["trigger"],
  ): Promise<ImportRunResult> {
    const payload: ImportWorkflowParams = {
      importRunId: runId,
      sourceAlbumId,
      trigger,
    };
    return runImportWorkflow(deps, payload, retryingStep(), {
      retryLimit: 5,
      downloadAndGroup: () =>
        downloadAndGroupSnapshot(deps, runId),
      processGroupAttempt: processProductGroupAttempt,
      recordExhaustedFailure: recordExhaustedGroupFailure,
      finalize: (
        hadFailures,
        orphanPhotoCount,
        checkpointPosition,
      ) => finalizeImportRun(
        repo,
        runId,
        sourceAlbumId,
        hadFailures,
        orphanPhotoCount,
        checkpointPosition,
      ),
      notify: (result, orphanRange) => sendImportSummary(
        { pushMessage: push },
        "CtestGroup",
        {
          result,
          orphanRange,
          nowThaiText: "2026-09-01 16:00 ICT",
        },
      ),
    });
  }

  return {
    deps,
    source,
    created,
    push,
    async startAndRun(runId, trigger) {
      await repo.createImportRun({
        id: runId,
        sourceAlbumId,
        trigger,
      });
      return resumeRun(runId, trigger);
    },
    resumeRun,
  };
}

describe("import acceptance", () => {
  it("1. imports a 100-photo snapshot into nine deterministic Products", async () => {
    const specs = [
      ...Array.from({ length: 8 }, (_, index) =>
        productGroupOf(10, index + 1),
      ).flat(),
      ...productGroupOf(11, 9),
    ];
    expect(specs).toHaveLength(100);
    const harness = await buildHarness(
      `album-${crypto.randomUUID()}`,
      specs,
    );

    const result = await harness.startAndRun("run-1", "cron");

    expect(result.succeededProductIds).toHaveLength(9);
    expect(harness.created).toHaveSize(9);
  });

  it("2. preserves 9, 12, and 15-photo attachment counts", async () => {
    const harness = await buildHarness(
      `album-${crypto.randomUUID()}`,
      [
        ...productGroupOf(9, 1),
        ...productGroupOf(12, 2),
        ...productGroupOf(15, 3),
      ],
    );

    await harness.startAndRun("run-1", "cron");

    expect([...harness.created.values()]
      .map((row) => row.imageCount)
      .sort((left, right) => left - right))
      .toEqual([9, 12, 15]);
  });

  it("3. applies first-run cutoff then saves explicit snapshot checkpoint", async () => {
    const old = productGroupOf(
      9,
      1,
      "2026-08-31T23:59:59.000Z",
    );
    const current = productGroupOf(
      9,
      2,
      "2026-09-01T00:00:00.000Z",
    );
    const harness = await buildHarness(
      `album-${crypto.randomUUID()}`,
      [...old, ...current],
      {
        firstImportCutoffDate: "2026-09-01T00:00:00.000Z",
      },
    );

    const result = await harness.startAndRun("run-1", "cron");

    expect(result.succeededProductIds).toHaveLength(1);
    expect(harness.created).toHaveSize(1);
    expect(await harness.deps.repo.getCheckpoint(
      harness.source.sourceAlbumId,
    )).toBe(20);
  });

  it("4. unchanged repeated /upload downloads nothing and creates no duplicate", async () => {
    const harness = await buildHarness(
      `album-${crypto.randomUUID()}`,
      productGroupOf(9, 1),
    );
    await harness.startAndRun("run-1", "cron");
    const downloadsAfterFirstRun = harness.source.downloads.length;

    const repeated = await harness.startAndRun("run-2", "line");

    expect(repeated.succeededProductIds).toEqual([]);
    expect(harness.created).toHaveSize(1);
    expect(harness.source.downloads).toHaveLength(
      downloadsAfterFirstRun,
    );
  });

  it("5. resumes the same durable run after interruption following download", async () => {
    const sourceAlbumId = `album-${crypto.randomUUID()}`;
    const harness = await buildHarness(
      sourceAlbumId,
      productGroupOf(9, 1),
    );
    await harness.deps.repo.createImportRun({
      id: "run-interrupted",
      sourceAlbumId,
      trigger: "cron",
    });
    await downloadAndGroupSnapshot(
      harness.deps,
      "run-interrupted",
    );
    const downloadsBeforeResume = harness.source.downloads.length;

    const result = await harness.resumeRun(
      "run-interrupted",
      "cron",
    );

    expect(result.succeededProductIds).toHaveLength(1);
    expect(harness.source.downloads).toHaveLength(
      downloadsBeforeResume,
    );
  });

  it("6. exhausted failure leaves successful sibling intact", async () => {
    const harness = await buildHarness(
      `album-${crypto.randomUUID()}`,
      [...productGroupOf(9, 1), ...productGroupOf(9, 2)],
      {
        createProduct: async (payload) => {
          if (payload.productId === "A-501") {
            throw new OperationalError(
              "airtable_rate_limited",
              "rate limited",
              true,
            );
          }
          return { recordId: `rec-${payload.productId}` };
        },
      },
    );

    const result = await harness.startAndRun("run-1", "cron");

    expect(result.succeededProductIds).toEqual(["A-502"]);
    expect(result.failedGroups).toHaveLength(1);
    expect(harness.created.size).toBe(1);
  });

  it("7. reports every exhausted group with burned Product ID and code", async () => {
    const harness = await buildHarness(
      `album-${crypto.randomUUID()}`,
      [
        ...productGroupOf(9, 1),
        ...productGroupOf(9, 2),
        ...productGroupOf(9, 3),
      ],
      {
        createProduct: async () => {
          throw new OperationalError(
            "airtable_rate_limited",
            "rate limited",
            true,
          );
        },
      },
    );

    const result = await harness.startAndRun("run-1", "cron");

    expect(result.succeededProductIds).toEqual([]);
    expect(result.failedGroups.map((failure) => failure.productId))
      .toEqual(["A-501", "A-502", "A-503"]);
    expect(result.failedGroups.every((failure) =>
      failure.errorCode === "airtable_rate_limited",
    )).toBe(true);
  });

  it("8. later /upload gives failed group fresh ID and imports new sibling", async () => {
    let failBurnedGroup = true;
    const firstSpecs = productGroupOf(9, 1);
    const harness = await buildHarness(
      `album-${crypto.randomUUID()}`,
      firstSpecs,
      {
        createProduct: async (payload) => {
          if (failBurnedGroup) {
            throw new OperationalError(
              "airtable_timeout",
              "timeout",
              true,
            );
          }
          return { recordId: `rec-${payload.productId}` };
        },
      },
    );
    const first = await harness.startAndRun("run-1", "cron");
    const burnedId = first.failedGroups[0].productId;
    failBurnedGroup = false;
    harness.source.setSpecs([
      ...firstSpecs,
      ...productGroupOf(9, 2),
    ]);

    const second = await harness.startAndRun("run-2", "line");

    expect(second.succeededProductIds).toHaveLength(2);
    expect(second.succeededProductIds).not.toContain(burnedId);
    expect(new Set(second.succeededProductIds).size).toBe(2);
  });

  it("9. keeps Product IDs unique across three cumulative batches", async () => {
    const cumulative: BatchPhotoSpec[] = [];
    cumulative.push(...productGroupOf(10, 1));
    const harness = await buildHarness(
      `album-${crypto.randomUUID()}`,
      cumulative,
    );
    const allProductIds: string[] = [];

    for (let batch = 1; batch <= 3; batch += 1) {
      if (batch > 1) {
        cumulative.push(...productGroupOf(10, batch));
        harness.source.setSpecs([...cumulative]);
      }
      const result = await harness.startAndRun(
        `run-${batch}`,
        "cron",
      );
      allProductIds.push(...result.succeededProductIds);
    }

    expect(allProductIds).toHaveLength(3);
    expect(new Set(allProductIds).size).toBe(3);
  });

  it("10. processes 500 photos and summarizes exact success/failure sets", async () => {
    const specs = [
      ...Array.from({ length: 44 }, (_, index) =>
        productGroupOf(10, index + 1),
      ).flat(),
      ...productGroupOf(15, 45),
    ];
    expect(specs).toHaveLength(500);
    const harness = await buildHarness(
      `album-${crypto.randomUUID()}`,
      specs,
      {
        createProduct: async (payload) => {
          if (payload.productId === "A-502") {
            throw new OperationalError(
              "airtable_rate_limited",
              "rate limited",
              true,
            );
          }
          return { recordId: `rec-${payload.productId}` };
        },
      },
    );

    const result = await harness.startAndRun("run-500", "cron");

    expect(result.succeededProductIds).toHaveLength(44);
    expect(result.failedGroups).toHaveLength(1);
    expect(harness.push).toHaveBeenCalledTimes(1);
    const message = harness.push.mock.calls[0][1] as string;
    for (const productId of result.succeededProductIds) {
      expect(message).toContain(productId);
    }
    expect(message).toContain("A-502");
    expect(message).toContain("airtable_rate_limited");
  });
});
```

- [ ] **Step 3: Run test and verify failure**

Run: `npx vitest run test/acceptance/import-acceptance.test.ts`
Expected: FAIL because fixture and acceptance files do not exist before this task.

- [ ] **Step 4: Save fixture and acceptance files without changing production code**

Create the two files exactly as shown in Steps 1 and 2. All required production behavior was built test-first in Tasks 1–15.

- [ ] **Step 5: Run focused and full checks**

Run: `npx vitest run test/acceptance/import-acceptance.test.ts`
Expected: PASS (10 tests).

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/helpers/import-fixtures.ts test/acceptance/import-acceptance.test.ts
git commit -m "test(import): cover production-sized import lifecycle"
```

---

## Self-Review Notes

- **Spec coverage:** Section 8 (trigger/snapshot, download/grouping, product creation, retry/rollback, checkpoint) is covered by Tasks 1, 4, 6, 8, 12, 13, 14. Section 9's system-owned Product fields (`Product ID`, `System Group ID`, `Upload Date`, `Product Images`, `Inventory Status = In`) are covered by Task 9's `AirtableProductPayload`; the remaining Products-table fields (`4-in-1 Image`, `Publication Run`, sold fields) belong to the publication and LINE plans and are intentionally absent here. Section 12's import idempotency keys (Apple photo ID, content hash, System Group ID, Product ID, Airtable row ID) are covered by Task 1's unique constraints plus Task 13's `findBySystemGroupId` guard. Section 18's "Import acceptance" bullet list maps one-to-one onto Task 16's ten cases.
- **Placeholder scan:** no `TBD`/`TODO`/"add appropriate" phrasing remains; every step has runnable code or an exact command.
- **Type consistency:** `ProcessGroupDeps` (Task 13) extends `ImportServiceDeps` (Task 12) rather than redeclaring its fields; `PersistedGroup` is defined once in Task 12 and reused verbatim in Tasks 13, 14, and 16; Task 14 repeats Task 5's `ImportWorkflowParams` shape only as an explicit cross-task consistency check.
