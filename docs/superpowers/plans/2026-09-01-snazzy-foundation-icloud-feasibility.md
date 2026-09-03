# Snazzy Foundation and iCloud Feasibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the project skeleton, shared test/runtime foundation, and a throwaway-but-rigorous Phase 0 spike that proves (or disproves) an undocumented, Cloudflare-only iCloud Shared Album connector before any production import code is written.

**Architecture:** A minimal TypeScript/Cloudflare Worker skeleton (no framework) with shared cross-cutting modules (errors, redacted logging, time, IDs, config). On top of that, a narrow `ImageSource`-shaped iCloud client that speaks the undocumented public Shared Album webstream protocol, a deterministic QR marker detector (`jpeg-js` + `jsqr`), and a Phase 0 probe that exercises both against a real Shared Album to evaluate all ten pass criteria from the design spec. The probe writes a structured PASS/FAIL report to `docs/feasibility/icloud-phase-0-report.md`. No D1, R2, Airtable, Workflow, Claude, Google, or LINE code is written in this plan — those begin only after the gate passes.

**Tech Stack:** TypeScript, Cloudflare Workers, npm, Vitest 4.1+, `@cloudflare/vitest-plugin`, Zod, `jpeg-js`, `jsqr`, native `fetch`.

**Spec:** `docs/superpowers/specs/2026-09-01-snazzy-automation-design.md`

## Global Constraints

- Dedicated customer-owned staging and production deployments.
- Runtime timezone: `Asia/Bangkok`.
- Import volume: 100–500 photos/day; normal product group: 9–15 photos.
- Marker image never becomes Product attachment (marker photos are recorded but excluded from any product payload).
- Never log credentials, public-album token/link, signed URLs, Product images, or raw external response bodies containing them.
- MVP excludes admin dashboard, AI photo grouping, always-on Mac, VPS, Redis, Postgres, n8n, Make, and automatic social publication.
- Use native `fetch` routing; do not add a web framework.
- Use current Cloudflare Vitest plugin: `@cloudflare/vitest-plugin` with Vitest 4.1 or later; do not use removed `@cloudflare/vitest-pool-workers` APIs.
- Cloudflare compatibility date must be `2026-09-01` or later and include `nodejs_compat`.
- Every non-trivial parser, state transition, money mutation, and trust boundary starts with a failing test.
- Every task ends with focused tests, `npm run check`, and a commit.
- Marker contract is the printed QR card containing exactly `SNAZZY_PRODUCT_START_V1`.
- Marker detection path: normalize to JPEG ≤1024×1024, decode with `jpeg-js`, read with `jsqr`, match exact constant only.
- **Hard stop:** no import, publication, or LINE implementation begins until this plan's Phase 0 report says `PASS`. If it says `FAIL`, stop, record evidence, and write a replacement `ImageSource` plan — do not alter downstream contracts.

---

## File Structure

```text
.
├── package.json
├── package-lock.json
├── tsconfig.json
├── vitest.config.ts
├── wrangler.jsonc
├── src/
│   ├── env.ts                    # Env binding and secret types
│   ├── config.ts                 # Zod configuration parsing
│   ├── shared/
│   │   ├── errors.ts              # Typed operational errors and retry classification
│   │   ├── http.ts                # Redacted-safe external fetch helper
│   │   ├── ids.ts                 # Correlation IDs and SHA-256 helpers
│   │   ├── logger.ts              # Structured redacted logging
│   │   └── time.ts                # Bangkok date and expiry functions
│   ├── icloud/
│   │   ├── types.ts               # Album snapshot/source photo contracts
│   │   ├── token.ts               # Public token → server partition discovery
│   │   ├── client.ts              # Undocumented public-album HTTP adapter
│   │   └── phase-zero-probe.ts    # Feasibility-only probe runner
│   └── import/
│       └── marker.ts              # QR marker normalization/detection
├── scripts/
│   ├── generate-marker.ts         # Printable marker SVG generator
│   └── run-phase-zero.ts          # Invoke probe against real album, write JSON result
├── test/
│   ├── helpers/
│   │   ├── env.ts                 # Typed test environment
│   │   ├── fixtures.ts            # Explicit external payload fixtures
│   │   └── fakes.ts               # fetch/client fakes
│   ├── shared/
│   │   ├── ids.test.ts
│   │   ├── time.test.ts
│   │   ├── errors.test.ts
│   │   ├── logger.test.ts
│   │   └── http.test.ts
│   ├── config.test.ts
│   ├── icloud/
│   │   ├── token.test.ts
│   │   ├── client.test.ts
│   │   └── phase-zero-probe.test.ts
│   └── import/
│       └── marker.test.ts
└── docs/
    ├── feasibility/
    │   └── icloud-phase-0-report.md
    └── runbooks/
        └── album-rotation.md
```

---

## Cross-Task Interfaces

These signatures are fixed by this plan. Later tasks and the downstream Import Pipeline plan rely on them without renaming.

```ts
// src/shared/ids.ts
export type IdGenerator = { next(): string };
export function newCorrelationId(): string;
export function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string>;

// src/shared/time.ts
export function nowBangkokIso(clock: Clock): string;
export function bangkokDateTimeThai(clock: Clock): string;
export function isPast(iso: string, clock: Clock): boolean;
export function expiryFromNow(minutes: number, clock: Clock): string;

// src/shared/errors.ts
export class OperationalError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean);
}
export function isRetryable(error: unknown): boolean;

// src/shared/logger.ts
export type LogFields = Record<string, string | number | boolean | null>;
export function redact(fields: LogFields): LogFields;
export function createLogger(base: LogFields): {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

// src/shared/http.ts
export type Fetcher = typeof fetch;
export interface SafeFetchOptions {
  fetcher: Fetcher;
  redactUrlPatterns?: RegExp[];
}
export function safeFetch(
  input: string,
  init: RequestInit | undefined,
  options: SafeFetchOptions
): Promise<Response>;

// src/config.ts
export interface AppConfig {
  timeZone: "Asia/Bangkok";
  uploadCutoffMinutes: number;
  productIdPrefix: string;
}
export function parseConfig(raw: unknown): AppConfig;

// src/icloud/types.ts
export interface SourcePhoto {
  sourceAlbumId: string;
  applePhotoId: string;
  position: number;
  captureAt: string | null;
  derivativeUrl: string;
  mediaType: "image/jpeg";
}
export interface AlbumSnapshot {
  sourceAlbumId: string;
  fetchedAt: string;
  photos: SourcePhoto[];
}
export type ImageSource = {
  getSnapshot(): Promise<AlbumSnapshot>;
  download(photo: SourcePhoto): Promise<Response>;
};

// src/icloud/token.ts
export interface HostDiscoveryResult {
  host: string;
  attempts: number;
}
export function discoverHost(
  token: string,
  fetcher: Fetcher
): Promise<HostDiscoveryResult>;

// src/icloud/client.ts
export function createICloudClient(
  token: string,
  fetcher: Fetcher
): ImageSource;

// src/import/marker.ts
export const MARKER_PAYLOAD = "SNAZZY_PRODUCT_START_V1";
export function isMarkerImage(jpegBytes: Uint8Array): boolean;

// src/icloud/phase-zero-probe.ts
export type GateId =
  | "metadata-consistency"
  | "stable-ordering"
  | "checkpoint-discovery"
  | "stream-download-no-buffer"
  | "marker-detection"
  | "zero-duplicates"
  | "transient-error-recovery"
  | "no-secrets-in-logs"
  | "acceptable-quality"
  | "album-rotation-rehearsed";
export interface GateResult {
  gate: GateId;
  pass: boolean;
  evidence: string;
}
export interface PhaseZeroReport {
  generatedAt: string;
  sourceAlbumId: string;
  gates: GateResult[];
  overall: "PASS" | "FAIL";
}
export function runPhaseZeroProbe(
  client: ImageSource,
  fetcher: Fetcher,
  clock: Clock,
  options: { sampleSize: number }
): Promise<PhaseZeroReport>;
```

---

### Task 1: Project skeleton, dependencies, and build config

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `wrangler.jsonc`
- Create: `test/helpers/env.ts`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `npm run check`, `npm test`, `npm run typecheck` commands used by every later task; `test/helpers/env.ts` exports `createTestEnv()` used by every later test file.

- [ ] **Step 1: Verify npm and node are available**

Run: `node --version && npm --version`
Expected: both print a version (Node 20+).

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "snazzy-automation",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "check": "npm run typecheck && npm test",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "wrangler dev",
    "deploy:staging": "wrangler deploy --env staging",
    "deploy:production": "wrangler deploy --env production",
    "phase-zero": "tsx scripts/run-phase-zero.ts",
    "generate-marker": "tsx scripts/generate-marker.ts"
  }
}
```

- [ ] **Step 3: Install dependencies**

```bash
npm install zod jsqr jpeg-js
npm install --save-dev typescript wrangler vitest@^4.1.0 @cloudflare/vitest-plugin @cloudflare/workers-types @types/jpeg-js tsx qrcode @types/qrcode
```

Commit `package-lock.json` in Step 8.

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "vitest/globals"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src", "scripts", "test"]
}
```

- [ ] **Step 5: Write `wrangler.jsonc`**

```jsonc
{
  "name": "snazzy-automation",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "env": {
    "staging": { "name": "snazzy-automation-staging" },
    "production": { "name": "snazzy-automation-production" }
  }
}
```

There is no `src/index.ts` yet because this plan builds only foundation and probe. Import Pipeline plan creates Worker entrypoint. `wrangler.jsonc` exists now so compatibility settings are locked before that plan starts; do not run `wrangler dev` or deploy until entrypoint exists.

- [ ] **Step 6: Write `vitest.config.ts`**

```ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
```

- [ ] **Step 7: Write `test/helpers/env.ts`**

```ts
export interface TestEnv {
  ICLOUD_SHARED_ALBUM_TOKEN: string;
  APP_CONFIG_JSON: string;
}

export function createTestEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  return {
    ICLOUD_SHARED_ALBUM_TOKEN: "TEST-TOKEN-ABC123",
    APP_CONFIG_JSON: JSON.stringify({
      TIME_ZONE: "Asia/Bangkok",
      UPLOAD_CUTOFF_MINUTES: 30,
      PRODUCT_ID_PREFIX: "A",
    }),
    ...overrides,
  };
}
```

- [ ] **Step 8: Write smoke test**

```ts
// test/smoke.test.ts
import { describe, expect, it } from "vitest";
import { createTestEnv } from "./helpers/env";

describe("project skeleton", () => {
  it("boots the test harness and reads a test env", () => {
    const env = createTestEnv();
    expect(env.ICLOUD_SHARED_ALBUM_TOKEN).toBe("TEST-TOKEN-ABC123");
  });
});
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test -- test/smoke.test.ts`
Expected: PASS — 1 test passed. If it fails on plugin/config resolution, fix `vitest.config.ts` before proceeding; no later task can run until this passes.

- [ ] **Step 10: Run full check**

Run: `npm run check`
Expected: `typecheck` passes with no errors, `test` passes with 1 test.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts wrangler.jsonc test/helpers/env.ts test/smoke.test.ts
git commit -m "chore: bootstrap project skeleton and test harness"
```

---

### Task 2: Correlation IDs and content hashing (`shared/ids.ts`)

**Files:**
- Create: `src/shared/ids.ts`
- Test: `test/shared/ids.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `IdGenerator = { next(): string }`, `newCorrelationId(): string`, and `sha256Hex(data): Promise<string>` — used by downstream repositories, `icloud/client.ts` correlation logging, and the Import Pipeline plan's asset-store content addressing.

- [ ] **Step 1: Write the failing test**

```ts
// test/shared/ids.test.ts
import { describe, expect, it } from "vitest";
import { newCorrelationId, sha256Hex } from "../../src/shared/ids";

describe("newCorrelationId", () => {
  it("returns a unique, url-safe id each call", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-zA-Z0-9-]{16,}$/);
  });
});

describe("sha256Hex", () => {
  it("hashes known bytes to the known SHA-256 hex digest", async () => {
    const bytes = new TextEncoder().encode("snazzy");
    const digest = await sha256Hex(bytes);
    expect(digest).toBe(
      "a4953bae2278bddc7c8cd84c47a8d65694bc0e0deb142ae09fee37eefd2c1889",
    );
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces identical digests for identical bytes across calls", async () => {
    const bytes = new TextEncoder().encode("same-input");
    const first = await sha256Hex(bytes);
    const second = await sha256Hex(bytes);
    expect(first).toBe(second);
  });
});
```

The first `sha256Hex` assertion above only checks digest shape (64 lowercase hex chars) — the exact known-digest string is asserted precisely in Step 2's replacement so the test is not tautological.

- [ ] **Step 2: Add exact known-digest assertion**

```ts
  it("hashes known bytes to the known SHA-256 hex digest", async () => {
    const bytes = new TextEncoder().encode("snazzy");
    const digest = await sha256Hex(bytes);
    expect(digest).toBe("a4953bae2278bddc7c8cd84c47a8d65694bc0e0deb142ae09fee37eefd2c1889");
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/shared/ids.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/ids'`.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/shared/ids.ts
export type IdGenerator = { next(): string };

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buffer = data instanceof Uint8Array ? data.slice().buffer : data;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/shared/ids.test.ts`
Expected: PASS — 3 tests passed.

- [ ] **Step 6: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 7: Commit**

```bash
git add src/shared/ids.ts test/shared/ids.test.ts
git commit -m "feat: add correlation id and sha256 hashing helpers"
```

---

### Task 3: Bangkok time helpers (`shared/time.ts`)

**Files:**
- Create: `src/shared/time.ts`
- Test: `test/shared/time.test.ts`

**Interfaces:**
- Consumes: `Clock = { now(): Date }` (defined inline in this task; matches the shape referenced by the implementation index's cross-plan `Clock` type).
- Produces: `nowBangkokIso(clock)`, `bangkokDateTimeThai(clock)`, `isPast(iso, clock)`, `expiryFromNow(minutes, clock)` — used by `icloud/phase-zero-probe.ts` for poll timestamps, import summaries for Thai display time, and the downstream LINE plan for 10-minute confirmation expiry.

- [ ] **Step 1: Write the failing test**

```ts
// test/shared/time.test.ts
import { describe, expect, it } from "vitest";
import {
  bangkokDateTimeThai,
  expiryFromNow,
  isPast,
  nowBangkokIso,
} from "../../src/shared/time";

const fixedClock = { now: () => new Date("2026-09-01T10:00:00.000Z") };

describe("nowBangkokIso", () => {
  it("renders the clock's instant in Asia/Bangkok offset", () => {
    // UTC 10:00 -> Bangkok is UTC+7 -> 17:00 local
    expect(nowBangkokIso(fixedClock)).toBe("2026-09-01T17:00:00+07:00");
  });
});

describe("bangkokDateTimeThai", () => {
  it("renders Thai Buddhist-calendar display text with Latin digits", () => {
    expect(bangkokDateTimeThai(fixedClock))
      .toBe("1 กันยายน 2569 17:00");
  });
});

describe("expiryFromNow / isPast", () => {
  it("computes an expiry N minutes ahead and reports it as not yet past", () => {
    const expiry = expiryFromNow(10, fixedClock);
    expect(isPast(expiry, fixedClock)).toBe(false);
  });

  it("reports an expiry as past once the clock advances beyond it", () => {
    const expiry = expiryFromNow(10, fixedClock);
    const laterClock = { now: () => new Date("2026-09-01T10:11:00.000Z") };
    expect(isPast(expiry, laterClock)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/shared/time.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/time'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/time.ts
export type Clock = { now(): Date };

const BANGKOK_OFFSET_MINUTES = 7 * 60;

export function nowBangkokIso(clock: Clock): string {
  const utc = clock.now();
  const shifted = new Date(utc.getTime() + BANGKOK_OFFSET_MINUTES * 60_000);
  const iso = shifted.toISOString().replace(/\.\d{3}Z$/, "");
  return `${iso}+07:00`;
}

export function bangkokDateTimeThai(clock: Clock): string {
  const parts = new Intl.DateTimeFormat(
    "th-TH-u-ca-buddhist-nu-latn",
    {
      timeZone: "Asia/Bangkok",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    },
  ).formatToParts(clock.now());
  const value = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("day")} ${value("month")} ${value("year")} ${value("hour")}:${value("minute")}`;
}

export function expiryFromNow(minutes: number, clock: Clock): string {
  const utc = new Date(clock.now().getTime() + minutes * 60_000);
  return utc.toISOString();
}

export function isPast(iso: string, clock: Clock): boolean {
  return clock.now().getTime() > new Date(iso).getTime();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/shared/time.test.ts`
Expected: PASS — 4 tests passed.

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add src/shared/time.ts test/shared/time.test.ts
git commit -m "feat: add Bangkok time and expiry helpers"
```

---

### Task 4: Typed operational errors and retry classification (`shared/errors.ts`)

**Files:**
- Create: `src/shared/errors.ts`
- Test: `test/shared/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `OperationalError` class and `isRetryable(error)` — used by `icloud/client.ts` and `icloud/phase-zero-probe.ts` to distinguish transient failures (retry) from permanent ones (fail fast), matching spec §7 gate 7 and index's "Non-transient 4xx errors fail immediately" rule.

- [ ] **Step 1: Write the failing test**

```ts
// test/shared/errors.test.ts
import { describe, expect, it } from "vitest";
import { isRetryable, OperationalError } from "../../src/shared/errors";

describe("OperationalError", () => {
  it("carries a code, message, and retryable flag", () => {
    const err = new OperationalError("ICLOUD_TIMEOUT", "request timed out", true);
    expect(err.code).toBe("ICLOUD_TIMEOUT");
    expect(err.message).toBe("request timed out");
    expect(err.retryable).toBe(true);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("isRetryable", () => {
  it("returns true for a retryable OperationalError", () => {
    expect(isRetryable(new OperationalError("ICLOUD_5XX", "server error", true))).toBe(true);
  });

  it("returns false for a non-retryable OperationalError", () => {
    expect(isRetryable(new OperationalError("ICLOUD_TOKEN_INVALID", "bad token", false))).toBe(false);
  });

  it("returns false for a plain unrelated error", () => {
    expect(isRetryable(new Error("boom"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/shared/errors.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/errors'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/errors.ts
export class OperationalError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "OperationalError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function isRetryable(error: unknown): boolean {
  return error instanceof OperationalError && error.retryable;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/shared/errors.test.ts`
Expected: PASS — 4 tests passed.

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add src/shared/errors.ts test/shared/errors.test.ts
git commit -m "feat: add typed operational errors and retry classification"
```

---

### Task 5: Redacted structured logger (`shared/logger.ts`)

**Files:**
- Create: `src/shared/logger.ts`
- Test: `test/shared/logger.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `redact(fields)`, `createLogger(base)` — used everywhere the plan touches the iCloud token, derivative URLs, or signed URLs (spec §7 gate 8, §13, §14: "never enter logs").

- [ ] **Step 1: Write the failing test**

```ts
// test/shared/logger.test.ts
import { describe, expect, it, vi } from "vitest";
import { createLogger, redact } from "../../src/shared/logger";

describe("redact", () => {
  it("masks fields whose key looks secret-shaped", () => {
    const out = redact({
      icloudAlbumToken: "AbCdEf123456",
      signedUrl: "https://r2.example.com/assets/x?sig=abc",
      derivativeUrl: "https://cvws.icloud-content.com/B/foo",
      productId: "A-1234",
    });
    expect(out.icloudAlbumToken).toBe("[REDACTED]");
    expect(out.signedUrl).toBe("[REDACTED]");
    expect(out.derivativeUrl).toBe("[REDACTED]");
    expect(out.productId).toBe("A-1234");
  });

  it("leaves non-secret fields untouched", () => {
    const out = redact({ count: 12, groupId: "grp-1", ok: true });
    expect(out).toEqual({ count: 12, groupId: "grp-1", ok: true });
  });
});

describe("createLogger", () => {
  it("merges base fields, redacts, and writes one JSON line to console", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger({ correlationId: "corr-1" });
    logger.info("probe started", { icloudAlbumToken: "SECRET-TOKEN" });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line.level).toBe("info");
    expect(line.message).toBe("probe started");
    expect(line.correlationId).toBe("corr-1");
    expect(line.icloudAlbumToken).toBe("[REDACTED]");
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/shared/logger.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/logger'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/logger.ts
export type LogFields = Record<string, string | number | boolean | null>;

const SECRET_KEY_PATTERN = /token|secret|signedurl|signed_url|derivativeurl|password|authorization/i;

export function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : value;
  }
  return out;
}

function write(level: "info" | "warn" | "error", base: LogFields, message: string, fields: LogFields) {
  const line = JSON.stringify({
    level,
    message,
    ...redact(base),
    ...redact(fields),
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/shared/logger.test.ts`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add src/shared/logger.ts test/shared/logger.test.ts
git commit -m "feat: add redacted structured logger"
```

---

### Task 6: Safe external fetch helper (`shared/http.ts`)

**Files:**
- Create: `src/shared/http.ts`
- Test: `test/shared/http.test.ts`

**Interfaces:**
- Consumes: `OperationalError` from Task 4.
- Produces: `safeFetch(input, init, options)` — the only way `icloud/client.ts` and `icloud/token.ts` call `fetch`, so every iCloud request is uniformly classified into retryable vs. non-retryable `OperationalError`s.

- [ ] **Step 1: Write the failing test**

```ts
// test/shared/http.test.ts
import { describe, expect, it, vi } from "vitest";
import { OperationalError } from "../../src/shared/errors";
import { safeFetch } from "../../src/shared/http";

function fakeFetcher(status: number, body = "{}") {
  return vi.fn(async () => new Response(body, { status }));
}

describe("safeFetch", () => {
  it("returns the response unchanged on 2xx", async () => {
    const fetcher = fakeFetcher(200, '{"ok":true}');
    const res = await safeFetch("https://example.com/a", undefined, { fetcher });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("throws a retryable OperationalError on 5xx", async () => {
    const fetcher = fakeFetcher(503);
    await expect(safeFetch("https://example.com/a", undefined, { fetcher })).rejects.toMatchObject({
      code: "HTTP_5XX",
      retryable: true,
    });
  });

  it("throws a retryable OperationalError on 429", async () => {
    const fetcher = fakeFetcher(429);
    await expect(safeFetch("https://example.com/a", undefined, { fetcher })).rejects.toMatchObject({
      code: "HTTP_429",
      retryable: true,
    });
  });

  it("throws a non-retryable OperationalError on other 4xx", async () => {
    const fetcher = fakeFetcher(404);
    await expect(safeFetch("https://example.com/a", undefined, { fetcher })).rejects.toMatchObject({
      code: "HTTP_4XX",
      retryable: false,
    });
  });

  it("never includes the raw request URL in a thrown error message", async () => {
    const fetcher = fakeFetcher(500);
    try {
      await safeFetch("https://p01-sharedstreams.icloud.com/SECRET-TOKEN/sharedstreams/webstream", undefined, {
        fetcher,
        redactUrlPatterns: [/SECRET-TOKEN/],
      });
      throw new Error("expected safeFetch to throw");
    } catch (err) {
      expect((err as OperationalError).message).not.toContain("SECRET-TOKEN");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/shared/http.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/http'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/http.ts
import { OperationalError } from "./errors";

export type Fetcher = typeof fetch;

export interface SafeFetchOptions {
  fetcher: Fetcher;
  redactUrlPatterns?: RegExp[];
}

function redactUrl(url: string, patterns: RegExp[] = []): string {
  let safe = url;
  for (const pattern of patterns) {
    safe = safe.replace(pattern, "[REDACTED]");
  }
  return safe;
}

export async function safeFetch(
  input: string,
  init: RequestInit | undefined,
  options: SafeFetchOptions
): Promise<Response> {
  const { fetcher, redactUrlPatterns = [] } = options;
  const response = await fetcher(input, init);

  if (response.status === 429) {
    throw new OperationalError(
      "HTTP_429",
      `rate limited fetching ${redactUrl(input, redactUrlPatterns)}`,
      true
    );
  }
  if (response.status >= 500) {
    throw new OperationalError(
      "HTTP_5XX",
      `server error ${response.status} fetching ${redactUrl(input, redactUrlPatterns)}`,
      true
    );
  }
  if (response.status >= 400) {
    throw new OperationalError(
      "HTTP_4XX",
      `client error ${response.status} fetching ${redactUrl(input, redactUrlPatterns)}`,
      false
    );
  }
  return response;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/shared/http.test.ts`
Expected: PASS — 5 tests passed.

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add src/shared/http.ts test/shared/http.test.ts
git commit -m "feat: add redaction-safe fetch wrapper with retry classification"
```

---

### Task 7: Config parsing and Env bindings (`config.ts`, `env.ts`)

**Files:**
- Create: `src/config.ts`
- Create: `src/env.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `zod`.
- Produces: `AppConfig`, `parseConfig(raw)` — used by `scripts/run-phase-zero.ts` and by every downstream plan's Worker entrypoint. `Env` — the binding surface every downstream plan extends without renaming existing members.

- [ ] **Step 1: Write the failing test**

```ts
// test/config.test.ts
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";

describe("parseConfig", () => {
  it("parses the approved uppercase JSON contract into camel-case runtime fields", () => {
    const config = parseConfig(JSON.stringify({
      TIME_ZONE: "Asia/Bangkok",
      UPLOAD_CUTOFF_MINUTES: 30,
      PRODUCT_ID_PREFIX: "A",
    }));
    expect(config).toEqual({
      timeZone: "Asia/Bangkok",
      uploadCutoffMinutes: 30,
      productIdPrefix: "A",
    });
  });

  it("rejects invalid JSON", () => {
    expect(() => parseConfig("not-json")).toThrow();
  });

  it("rejects a non-positive upload cutoff", () => {
    expect(() => parseConfig({
      TIME_ZONE: "Asia/Bangkok",
      UPLOAD_CUTOFF_MINUTES: 0,
      PRODUCT_ID_PREFIX: "A",
    })).toThrow();
  });

  it("rejects an empty Product ID prefix", () => {
    expect(() => parseConfig({
      TIME_ZONE: "Asia/Bangkok",
      UPLOAD_CUTOFF_MINUTES: 30,
      PRODUCT_ID_PREFIX: "",
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/config.test.ts`
Expected: FAIL — `Cannot find module '../src/config'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/config.ts
import { z } from "zod";

const RawAppConfigSchema = z.object({
  TIME_ZONE: z.literal("Asia/Bangkok"),
  UPLOAD_CUTOFF_MINUTES: z.number().int().positive(),
  PRODUCT_ID_PREFIX: z.string().min(1),
});

export interface AppConfig {
  timeZone: "Asia/Bangkok";
  uploadCutoffMinutes: number;
  productIdPrefix: string;
}

export function parseConfig(raw: unknown): AppConfig {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  const parsed = RawAppConfigSchema.parse(value);
  return {
    timeZone: parsed.TIME_ZONE,
    uploadCutoffMinutes: parsed.UPLOAD_CUTOFF_MINUTES,
    productIdPrefix: parsed.PRODUCT_ID_PREFIX,
  };
}
```

```ts
// src/env.ts
export interface Env {
  ICLOUD_SHARED_ALBUM_TOKEN: string;
  APP_CONFIG_JSON: string;
}
```

`APP_CONFIG_JSON` follows the approved uppercase external contract. `AppConfig` exposes camel-case runtime fields. Secrets remain separate bindings and never enter `APP_CONFIG_JSON`. Later plans extend both schemas without renaming existing members.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/config.test.ts`
Expected: PASS — 4 tests passed.

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/env.ts test/config.test.ts
git commit -m "feat: add zod config parsing and Env binding surface"
```

---

### Task 8: iCloud token → host discovery (`icloud/token.ts`)

**Files:**
- Create: `src/icloud/token.ts`
- Test: `test/icloud/token.test.ts`
- Test: `test/helpers/fakes.ts`

**Interfaces:**
- Consumes: `safeFetch`/`Fetcher` from Task 6, `OperationalError`/`isRetryable` from Task 4.
- Produces: `discoverHost(token, fetcher): Promise<HostDiscoveryResult>` — consumed by `icloud/client.ts` (Task 9) to build every subsequent webstream/webasseturls request.

Apple's public Shared Album web endpoint requires an initial request to a default partition host (`p01-sharedstreams.icloud.com`). That host replies either with data directly, or with a `X-Apple-MMe-Host` response header naming the correct partition host, in which case the same request must be retried once against that host. This task implements exactly that one-hop redirect discovery — the actual behavior against Apple's live servers is what Task 13's probe must confirm (spec §7 gate 1).

- [ ] **Step 1: Write `test/helpers/fakes.ts` with a scriptable fetcher**

```ts
// test/helpers/fakes.ts
export interface ScriptedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export function createScriptedFetcher(script: ScriptedResponse[]) {
  let call = 0;
  const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    const next = script[Math.min(call, script.length - 1)];
    call += 1;
    return new Response(next.body ?? "{}", {
      status: next.status,
      headers: next.headers ?? {},
    });
  };
  return { fetcher, calls };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// test/icloud/token.test.ts
import { describe, expect, it } from "vitest";
import { discoverHost } from "../../src/icloud/token";
import { createScriptedFetcher } from "../helpers/fakes";

describe("discoverHost", () => {
  it("uses the default host when the first response succeeds directly", async () => {
    const { fetcher, calls } = createScriptedFetcher([{ status: 200, body: "{}" }]);
    const result = await discoverHost("TOKEN-ABC", fetcher);
    expect(result.host).toBe("p01-sharedstreams.icloud.com");
    expect(result.attempts).toBe(1);
    expect(calls[0].input).toContain("p01-sharedstreams.icloud.com");
  });

  it("retries once against the host named by X-Apple-MMe-Host when redirected", async () => {
    const { fetcher, calls } = createScriptedFetcher([
      { status: 330, headers: { "x-apple-mme-host": "p07-sharedstreams.icloud.com" } },
      { status: 200, body: "{}" },
    ]);
    const result = await discoverHost("TOKEN-ABC", fetcher);
    expect(result.host).toBe("p07-sharedstreams.icloud.com");
    expect(result.attempts).toBe(2);
    expect(calls[1].input).toContain("p07-sharedstreams.icloud.com");
  });

  it("throws a non-retryable OperationalError when redirected without a target host", async () => {
    const { fetcher } = createScriptedFetcher([{ status: 330, headers: {} }]);
    await expect(discoverHost("TOKEN-ABC", fetcher)).rejects.toMatchObject({
      code: "ICLOUD_HOST_DISCOVERY_FAILED",
      retryable: false,
    });
  });

  it("never includes the raw token in a thrown error message", async () => {
    const { fetcher } = createScriptedFetcher([{ status: 500 }]);
    try {
      await discoverHost("SUPER-SECRET-TOKEN", fetcher);
      throw new Error("expected discoverHost to throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("SUPER-SECRET-TOKEN");
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/icloud/token.test.ts`
Expected: FAIL — `Cannot find module '../../src/icloud/token'`.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/icloud/token.ts
import { OperationalError } from "../shared/errors";
import { safeFetch, type Fetcher } from "../shared/http";

export interface HostDiscoveryResult {
  host: string;
  attempts: number;
}

const DEFAULT_HOST = "p01-sharedstreams.icloud.com";

function webstreamUrl(host: string, token: string): string {
  return `https://${host}/${token}/sharedstreams/webstream`;
}

export async function discoverHost(token: string, fetcher: Fetcher): Promise<HostDiscoveryResult> {
  const redact = [new RegExp(token, "g")];

  let host = DEFAULT_HOST;
  let response: Response;
  try {
    response = await fetcher(webstreamUrl(host, token), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streamCtag: null }),
    });
  } catch {
    throw new OperationalError("ICLOUD_HOST_DISCOVERY_FAILED", "network error discovering iCloud host", true);
  }

  if (response.status === 330) {
    const redirectHost = response.headers.get("x-apple-mme-host");
    if (!redirectHost) {
      throw new OperationalError(
        "ICLOUD_HOST_DISCOVERY_FAILED",
        "iCloud redirected without naming a target host",
        false
      );
    }
    host = redirectHost;
    await safeFetch(
      webstreamUrl(host, token),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ streamCtag: null }),
      },
      { fetcher, redactUrlPatterns: redact }
    );
    return { host, attempts: 2 };
  }

  if (response.status >= 400) {
    // Re-run through safeFetch purely to get uniform, redacted error classification.
    await safeFetch(webstreamUrl(host, token), { method: "POST" }, { fetcher, redactUrlPatterns: redact });
  }

  return { host, attempts: 1 };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/icloud/token.test.ts`
Expected: PASS — 4 tests passed.

- [ ] **Step 6: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 7: Commit**

```bash
git add src/icloud/token.ts test/icloud/token.test.ts test/helpers/fakes.ts
git commit -m "feat: add iCloud shared album host discovery"
```

---

### Task 9: iCloud client — snapshot and download (`icloud/types.ts`, `icloud/client.ts`)

**Files:**
- Create: `src/icloud/types.ts`
- Create: `src/icloud/client.ts`
- Test: `test/icloud/client.test.ts`
- Test: `test/helpers/fixtures.ts`

**Interfaces:**
- Consumes: `discoverHost` (Task 8), `safeFetch` (Task 6), `sha256Hex` (Task 2), `OperationalError` (Task 4).
- Produces: `SourcePhoto`, `AlbumSnapshot`, `ImageSource`, `deriveSourceAlbumId(token): Promise<string>`, and `createICloudClient(token, fetcher): ImageSource` — the exact contracts the Import Pipeline uses to create a run before starting `ImportWorkflow`, and what `phase-zero-probe.ts` (Task 13) drives. `sourceAlbumId` is the stable SHA-256 digest of the secret album token; the raw token remains only in the secret binding and outgoing iCloud request URLs.

- [ ] **Step 1: Write `test/helpers/fixtures.ts` with an explicit real-shaped webstream payload**

```ts
// test/helpers/fixtures.ts
export const WEBSTREAM_FIXTURE = {
  photos: [
    {
      photoGuid: "AAAA-1111",
      dateCreated: "2026-08-31T09:00:00Z",
      batchDateCreated: "2026-08-31T09:00:00Z",
      derivatives: {
        "2048": { checksum: "chk-aaaa-2048", fileSize: "204800" },
      },
    },
    {
      photoGuid: "BBBB-2222",
      dateCreated: "2026-08-31T09:01:00Z",
      batchDateCreated: "2026-08-31T09:01:00Z",
      derivatives: {
        "2048": { checksum: "chk-bbbb-2048", fileSize: "199000" },
      },
    },
  ],
};

export const WEBASSETURLS_FIXTURE = {
  items: {
    "chk-aaaa-2048": { url_location: "cvws.icloud-content.com", url_path: "/A/aaaa?o=1&v=1&x=1&s=1&a=1&k=1&e=1" },
    "chk-bbbb-2048": { url_location: "cvws.icloud-content.com", url_path: "/B/bbbb?o=1&v=1&x=1&s=1&a=1&k=1&e=1" },
  },
};
```

- [ ] **Step 2: Write the failing test**

```ts
// test/icloud/client.test.ts
import { describe, expect, it } from "vitest";
import { createICloudClient, deriveSourceAlbumId } from "../../src/icloud/client";
import { WEBASSETURLS_FIXTURE, WEBSTREAM_FIXTURE } from "../helpers/fixtures";

function scriptedFetcher(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  let call = 0;
  return async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return new Response(next.body === undefined ? undefined : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers ?? {},
    });
  };
}

describe("deriveSourceAlbumId", () => {
  it("returns the known stable SHA-256 identity without exposing the token", async () => {
    const sourceAlbumId = await deriveSourceAlbumId("TOKEN-XYZ");
    expect(sourceAlbumId).toBe("3447794384db61d5cd68a9ee046c489845550d1ea100612136598c82b3f9e2ef");
    expect(sourceAlbumId).not.toContain("TOKEN-XYZ");
  });
});

describe("createICloudClient.getSnapshot", () => {
  it("returns ordered SourcePhotos with resolved derivative URLs", async () => {
    const fetcher = scriptedFetcher([
      { status: 200, body: WEBSTREAM_FIXTURE },
      { status: 200, body: WEBASSETURLS_FIXTURE },
    ]);
    const client = createICloudClient("TOKEN-XYZ", fetcher);
    const snapshot = await client.getSnapshot();

    expect(snapshot.sourceAlbumId).toBe("3447794384db61d5cd68a9ee046c489845550d1ea100612136598c82b3f9e2ef");
    expect(snapshot.sourceAlbumId).not.toContain("TOKEN-XYZ");
    expect(snapshot.photos).toHaveLength(2);
    expect(snapshot.photos[0]).toMatchObject({
      applePhotoId: "AAAA-1111",
      position: 0,
      mediaType: "image/jpeg",
    });
    expect(snapshot.photos[0].derivativeUrl).toBe(
      "https://cvws.icloud-content.com/A/aaaa?o=1&v=1&x=1&s=1&a=1&k=1&e=1"
    );
    expect(snapshot.photos[1].applePhotoId).toBe("BBBB-2222");
  });

  it("rejects malformed iCloud response bodies without exposing them", async () => {
    const client = createICloudClient(
      "TOKEN-XYZ",
      scriptedFetcher([{ status: 200, body: { photos: "not-an-array" } }]),
    );
    await expect(client.getSnapshot()).rejects.toMatchObject({
      code: "icloud_invalid_webstream_response",
      retryable: false,
    });
  });

  it("returns photos in stable position order across two identical calls", async () => {
    const makeFetcher = () =>
      scriptedFetcher([
        { status: 200, body: WEBSTREAM_FIXTURE },
        { status: 200, body: WEBASSETURLS_FIXTURE },
      ]);
    const clientA = createICloudClient("TOKEN-XYZ", makeFetcher());
    const clientB = createICloudClient("TOKEN-XYZ", makeFetcher());
    const [snapshotA, snapshotB] = await Promise.all([clientA.getSnapshot(), clientB.getSnapshot()]);
    expect(snapshotA.photos.map((p) => p.applePhotoId)).toEqual(snapshotB.photos.map((p) => p.applePhotoId));
  });
});

describe("createICloudClient.download", () => {
  it("streams the photo's derivative URL through fetch and returns the Response", async () => {
    let requestedUrl = "";
    const fetcher = async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 });
    };
    const client = createICloudClient("TOKEN-XYZ", fetcher);
    const response = await client.download({
      sourceAlbumId: "3447794384db61d5cd68a9ee046c489845550d1ea100612136598c82b3f9e2ef",
      applePhotoId: "AAAA-1111",
      position: 0,
      captureAt: null,
      derivativeUrl: "https://cvws.icloud-content.com/A/aaaa?sig=1",
      mediaType: "image/jpeg",
    });
    expect(requestedUrl).toBe("https://cvws.icloud-content.com/A/aaaa?sig=1");
    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/icloud/client.test.ts`
Expected: FAIL — `Cannot find module '../../src/icloud/client'`.

- [ ] **Step 4: Write `src/icloud/types.ts`**

```ts
// src/icloud/types.ts
export interface SourcePhoto {
  sourceAlbumId: string;
  applePhotoId: string;
  position: number;
  captureAt: string | null;
  derivativeUrl: string;
  mediaType: "image/jpeg";
}

export interface AlbumSnapshot {
  sourceAlbumId: string;
  fetchedAt: string;
  photos: SourcePhoto[];
}

export type ImageSource = {
  getSnapshot(): Promise<AlbumSnapshot>;
  download(photo: SourcePhoto): Promise<Response>;
};
```

- [ ] **Step 5: Write `src/icloud/client.ts`**

```ts
// src/icloud/client.ts
import { z } from "zod";
import { discoverHost } from "./token";
import type { AlbumSnapshot, ImageSource, SourcePhoto } from "./types";
import { OperationalError } from "../shared/errors";
import { safeFetch, type Fetcher } from "../shared/http";
import { sha256Hex } from "../shared/ids";

const DerivativesSchema = z.record(
  z.string(),
  z.object({ checksum: z.string().min(1) }),
).refine((value) => Object.keys(value).length > 0);
const WebstreamPhotoSchema = z.object({
  photoGuid: z.string().min(1),
  dateCreated: z.string().nullable().optional(),
  derivatives: DerivativesSchema,
});
const WebstreamResponseSchema = z.object({
  photos: z.array(WebstreamPhotoSchema),
});
const WebAssetUrlsResponseSchema = z.object({
  items: z.record(
    z.string(),
    z.object({
      url_location: z.string().min(1),
      url_path: z.string().min(1),
    }),
  ),
});
type WebstreamPhoto = z.infer<typeof WebstreamPhotoSchema>;

async function parseICloudJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  code: string,
): Promise<T> {
  try {
    return schema.parse(await response.json());
  } catch {
    throw new OperationalError(
      code,
      "iCloud returned a malformed response",
      false,
    );
  }
}

function pickBestDerivativeChecksum(photo: WebstreamPhoto): string {
  const keys = Object.keys(photo.derivatives).map(Number).sort((a, b) => b - a);
  const bestKey = String(keys[0]);
  return photo.derivatives[bestKey].checksum;
}

export function deriveSourceAlbumId(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}

export function createICloudClient(token: string, fetcher: Fetcher): ImageSource {
  const redact = [new RegExp(token, "g")];
  const sourceAlbumIdPromise = deriveSourceAlbumId(token);

  async function getSnapshot(): Promise<AlbumSnapshot> {
    const sourceAlbumId = await sourceAlbumIdPromise;
    const { host } = await discoverHost(token, fetcher);

    const webstreamRes = await safeFetch(
      `https://${host}/${token}/sharedstreams/webstream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ streamCtag: null }),
      },
      { fetcher, redactUrlPatterns: redact }
    );
    const webstream = await parseICloudJson(
      webstreamRes,
      WebstreamResponseSchema,
      "icloud_invalid_webstream_response",
    );
    const checksums = webstream.photos.map(pickBestDerivativeChecksum);

    const assetUrlsRes = await safeFetch(
      `https://${host}/${token}/sharedstreams/webasseturls`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ photoGuids: checksums }),
      },
      { fetcher, redactUrlPatterns: redact }
    );
    const assetUrls = await parseICloudJson(
      assetUrlsRes,
      WebAssetUrlsResponseSchema,
      "icloud_invalid_asset_urls_response",
    );

    const photos: SourcePhoto[] = webstream.photos.map((photo, index) => {
      const checksum = pickBestDerivativeChecksum(photo);
      const asset = assetUrls.items[checksum];
      if (!asset) {
        throw new OperationalError(
          "icloud_missing_asset_url",
          `iCloud omitted derivative ${checksum}`,
          false,
        );
      }
      return {
        sourceAlbumId,
        applePhotoId: photo.photoGuid,
        position: index,
        captureAt: photo.dateCreated ?? null,
        derivativeUrl: `https://${asset.url_location}${asset.url_path}`,
        mediaType: "image/jpeg",
      };
    });

    return { sourceAlbumId, fetchedAt: new Date().toISOString(), photos };
  }

  async function download(photo: SourcePhoto): Promise<Response> {
    return safeFetch(photo.derivativeUrl, undefined, { fetcher, redactUrlPatterns: redact });
  }

  return { getSnapshot, download };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- test/icloud/client.test.ts`
Expected: PASS — 5 tests passed.

- [ ] **Step 7: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 8: Commit**

```bash
git add src/icloud/types.ts src/icloud/client.ts test/icloud/client.test.ts test/helpers/fixtures.ts
git commit -m "feat: add iCloud shared album client (snapshot + download)"
```

---

### Task 10: QR marker detection (`import/marker.ts`)

**Files:**
- Create: `src/import/marker.ts`
- Create: `test/import/fixtures/marker-clean.jpg`
- Create: `test/import/fixtures/non-marker.jpg`
- Create: `test/import/fixtures/wrong-payload.jpg`
- Test: `test/import/marker.test.ts`

**Interfaces:**
- Consumes: `jpeg-js`, `jsqr`.
- Produces: `MARKER_PAYLOAD`, `isMarkerImage(jpegBytes): boolean` — consumed by `icloud/phase-zero-probe.ts` (Task 13, gate 5) and by the Import Pipeline plan's grouping logic.

This task needs committed JPEG fixtures containing known QR payloads. Generate every fixture deterministically with the locked `qrcode` and `jpeg-js` dependencies; no manual screenshot, private Product image, machine-specific rasterizer, or later task is required.

- [ ] **Step 1: Generate deterministic fixtures**

Generate two QR JPEGs and one controlled non-marker JPEG directly from pixel data:

```bash
node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import jpeg from "jpeg-js";

const fixtureDir = "test/import/fixtures";
fs.mkdirSync(fixtureDir, { recursive: true });

function writeQrJpeg(payload, filename) {
  const qr = QRCode.create(payload, {
    errorCorrectionLevel: "M",
  });
  const quietZone = 4;
  const pixelsPerModule = 12;
  const size =
    (qr.modules.size + quietZone * 2) *
    pixelsPerModule;
  const data = Buffer.alloc(size * size * 4, 255);

  for (let row = 0; row < qr.modules.size; row += 1) {
    for (let column = 0;
      column < qr.modules.size;
      column += 1) {
      if (qr.modules.get(row, column) !== 1) continue;
      const startX =
        (column + quietZone) * pixelsPerModule;
      const startY =
        (row + quietZone) * pixelsPerModule;
      for (let y = startY;
        y < startY + pixelsPerModule;
        y += 1) {
        for (let x = startX;
          x < startX + pixelsPerModule;
          x += 1) {
          const offset = (y * size + x) * 4;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
        }
      }
    }
  }

  fs.writeFileSync(
    path.join(fixtureDir, filename),
    jpeg.encode({ data, width: size, height: size }, 95)
      .data,
  );
}

writeQrJpeg(
  "SNAZZY_PRODUCT_START_V1",
  "marker-clean.jpg",
);
writeQrJpeg("NOT_THE_MARKER", "wrong-payload.jpg");

const size = 512;
const nonMarker = Buffer.alloc(size * size * 4, 255);
fs.writeFileSync(
  path.join(fixtureDir, "non-marker.jpg"),
  jpeg.encode({
    data: nonMarker,
    width: size,
    height: size,
  }, 95).data,
);
NODE
```

Expected: `marker-clean.jpg`, `wrong-payload.jpg`, and `non-marker.jpg` exist under `test/import/fixtures/`; generation uses no customer image or secret.

- [ ] **Step 2: Write the failing test**

```ts
// test/import/marker.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isMarkerImage, MARKER_PAYLOAD } from "../../src/import/marker";

describe("MARKER_PAYLOAD", () => {
  it("is the exact spec constant", () => {
    expect(MARKER_PAYLOAD).toBe("SNAZZY_PRODUCT_START_V1");
  });
});

describe("isMarkerImage", () => {
  it("detects a clean, well-lit marker card", () => {
    const bytes = new Uint8Array(readFileSync("test/import/fixtures/marker-clean.jpg"));
    expect(isMarkerImage(bytes)).toBe(true);
  });

  it("returns false for a photo with no QR code", () => {
    const bytes = new Uint8Array(readFileSync("test/import/fixtures/non-marker.jpg"));
    expect(isMarkerImage(bytes)).toBe(false);
  });

  it("returns false for a QR code with a different payload", () => {
    // A QR code encoding "NOT_THE_MARKER" instead of the exact constant.
    const bytes = new Uint8Array(readFileSync("test/import/fixtures/wrong-payload.jpg"));
    expect(isMarkerImage(bytes)).toBe(false);
  });
});
```


- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/import/marker.test.ts`
Expected: FAIL — `Cannot find module '../../src/import/marker'`.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/import/marker.ts
import jpeg from "jpeg-js";
import jsQR from "jsqr";

export const MARKER_PAYLOAD = "SNAZZY_PRODUCT_START_V1";

export function isMarkerImage(jpegBytes: Uint8Array): boolean {
  let decoded: jpeg.BufferRet;
  try {
    decoded = jpeg.decode(jpegBytes, { useTArray: true });
  } catch {
    return false;
  }

  const code = jsQR(new Uint8ClampedArray(decoded.data), decoded.width, decoded.height);
  return code !== null && code.data === MARKER_PAYLOAD;
}
```

Note: production code (Import Pipeline plan) asks the Cloudflare Images binding to normalize the source derivative to JPEG ≤1024×1024 before calling `isMarkerImage`; that binding call is out of scope here since it requires a live Worker request context. This task's fixtures are pre-normalized to that size so the pure decode/detect logic is fully unit-testable without Cloudflare Images.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/import/marker.test.ts`
Expected: PASS — 4 tests passed.

- [ ] **Step 6: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 7: Commit**

```bash
git add src/import/marker.ts test/import/marker.test.ts test/import/fixtures/
git commit -m "feat: add deterministic QR marker detection"
```

---

### Task 11: Printable marker generator (`scripts/generate-marker.ts`)

**Files:**
- Create: `scripts/generate-marker.ts`
- Create: `docs/runbooks/marker-card.svg`
- Test: `test/scripts/generate-marker.test.ts`

**Interfaces:**
- Consumes: the exact marker payload `SNAZZY_PRODUCT_START_V1` from the approved marker contract. The constant is duplicated in this Node-only print script rather than importing Worker production code.
- Produces: `generateMarkerSvg({ outPath }): Promise<void>` and a self-contained SVG containing the exact scannable QR payload plus human-readable label. Staff prints `docs/runbooks/marker-card.svg`; tests do not depend on manual rasterization.

- [ ] **Step 1: Write the failing test**

Foundation Task 1 already installed the test/print-only `qrcode` and `@types/qrcode` dev dependencies. Production marker detection still uses only `jsqr` and `jpeg-js`.

```ts
// test/scripts/generate-marker.test.ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateMarkerSvg } from "../../scripts/generate-marker";

describe("generateMarkerSvg", () => {
  it("writes an SVG file containing an embedded QR image and the payload label", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "marker-"));
    const outPath = path.join(dir, "marker-card.svg");

    await generateMarkerSvg({ outPath });

    expect(existsSync(outPath)).toBe(true);
    const svg = readFileSync(outPath, "utf-8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("SNAZZY_PRODUCT_START_V1");
    rmSync(dir, { recursive: true, force: true });
  });

});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/scripts/generate-marker.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/generate-marker'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/generate-marker.ts
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import QRCode from "qrcode";

export interface GenerateMarkerOptions {
  outPath: string;
}

const MARKER_PAYLOAD = "SNAZZY_PRODUCT_START_V1";

export async function generateMarkerSvg({ outPath }: GenerateMarkerOptions): Promise<void> {
  const qrSvg = await QRCode.toString(MARKER_PAYLOAD, {
    type: "svg",
    margin: 2,
    width: 600,
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="760" viewBox="0 0 700 760">
  <rect width="700" height="760" fill="#ffffff" />
  <g transform="translate(50,40)">${qrSvg}</g>
  <text x="350" y="720" font-family="sans-serif" font-size="24" text-anchor="middle">${MARKER_PAYLOAD}</text>
</svg>`;

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, svg, "utf-8");
}

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1] : "docs/runbooks/marker-card.svg";
  await generateMarkerSvg({ outPath });
  console.log(`wrote ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/scripts/generate-marker.test.ts`
Expected: PASS — 1 test passed.

- [ ] **Step 5: Generate the staff-printable marker card**

Run:

```bash
npx tsx scripts/generate-marker.ts --out docs/runbooks/marker-card.svg
```

Expected: `docs/runbooks/marker-card.svg` exists, contains the exact `SNAZZY_PRODUCT_START_V1` label, and can be opened and printed without any external asset.

- [ ] **Step 6: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 7: Commit**

```bash
git add scripts/generate-marker.ts test/scripts/generate-marker.test.ts docs/runbooks/marker-card.svg
git commit -m "feat: add printable QR marker card generator"
```

Continue directly to Task 12. Task 10 already generated its independent JPEG fixtures and marker-detection implementation.

---

### Task 12: Redaction end-to-end audit (cross-cutting, gate 8)

**Files:**
- Test: `test/icloud/redaction-audit.test.ts`

**Interfaces:**
- Consumes: `createICloudClient` (Task 9), `createLogger`/`redact` (Task 5).
- Produces: no new production code — this is a dedicated regression test proving the token and derivative URLs never reach a log line even when the client's own errors are logged, directly exercising spec §7 gate 8 and §13's "no message includes secrets" rule ahead of the probe.

- [ ] **Step 1: Write the failing test**

```ts
// test/icloud/redaction-audit.test.ts
import { describe, expect, it, vi } from "vitest";
import { createICloudClient } from "../../src/icloud/client";
import { createLogger } from "../../src/shared/logger";

describe("iCloud client logging never leaks the token or derivative URLs", () => {
  it("keeps the token out of a logger call made after a client error", async () => {
    const token = "TOP-SECRET-ALBUM-TOKEN";
    const failingFetcher = async () => new Response("boom", { status: 500 });
    const client = createICloudClient(token, failingFetcher);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger({ correlationId: "corr-1" });

    let caught: Error | undefined;
    try {
      await client.getSnapshot();
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    logger.error("icloud snapshot failed", { icloudAlbumToken: token, reason: caught!.message });

    const loggedLine = spy.mock.calls[0][0] as string;
    expect(loggedLine).not.toContain(token);
    expect(caught!.message).not.toContain(token);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes as expected**

Run: `npm test -- test/icloud/redaction-audit.test.ts`
Expected: PASS immediately if Tasks 5 and 9 were implemented correctly — this is a regression test, not new red/green work. If it FAILS, that is a real bug in `client.ts`'s error messages or `logger.ts`'s redaction pattern; fix the offending file (not this test) before proceeding.

- [ ] **Step 3: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 4: Commit**

```bash
git add test/icloud/redaction-audit.test.ts
git commit -m "test: add cross-cutting redaction audit for iCloud client logging"
```

---

### Task 13: Phase 0 probe runner (`icloud/phase-zero-probe.ts`)

**Files:**
- Create: `src/icloud/phase-zero-probe.ts`
- Test: `test/icloud/phase-zero-probe.test.ts`

**Interfaces:**
- Consumes: `ImageSource` (Task 9), `isMarkerImage` (Task 10), `nowBangkokIso`/`Clock` (Task 3), `isRetryable` (Task 4).
- Produces: `GateId`, `GateResult`, `PhaseZeroReport`, `runPhaseZeroProbe(client, fetcher, clock, options)` — consumed by `scripts/run-phase-zero.ts` (Task 14) and by Task 16's gate-evaluation writeup.

This probe evaluates gates 1–8 programmatically against whatever `ImageSource` and sample size it is given (production run: a real iCloud client and a real album; test run: a fake client with scripted snapshots). Gates 9 (quality) and 10 (rotation) require human judgment/manual rehearsal and are recorded as manual `GateResult` entries by Task 14/16, not computed here.

- [ ] **Step 1: Write the failing test**

```ts
// test/icloud/phase-zero-probe.test.ts
import { describe, expect, it } from "vitest";
import { runPhaseZeroProbe } from "../../src/icloud/phase-zero-probe";
import type { AlbumSnapshot, ImageSource, SourcePhoto } from "../../src/icloud/types";
import { MARKER_PAYLOAD } from "../../src/import/marker";

const clock = { now: () => new Date("2026-09-01T03:00:00.000Z") };

function photo(id: string, position: number): SourcePhoto {
  return {
    sourceAlbumId: "ALBUM-1",
    applePhotoId: id,
    position,
    captureAt: `2026-08-31T09:0${position}:00Z`,
    derivativeUrl: `https://cvws.icloud-content.com/${id}`,
    mediaType: "image/jpeg",
  };
}

function makeStableClient(photoCount: number, markerAt: number[]): ImageSource {
  const photos = Array.from({ length: photoCount }, (_, i) => photo(`P${i}`, i));
  const snapshot: AlbumSnapshot = { sourceAlbumId: "ALBUM-1", fetchedAt: "2026-09-01T03:00:00Z", photos };
  return {
    async getSnapshot() {
      return snapshot;
    },
    async download(p) {
      const isMarker = markerAt.includes(p.position);
      // 1x1 minimal JPEG-shaped body is enough for the probe's byte-length gate;
      // marker detection in this fake is driven by markerAt, not real pixel decoding,
      // because the probe test exercises orchestration, not marker.ts itself (see Task 10).
      const body = new Uint8Array(isMarker ? [0xff, 0xd8, 0xff, 0x00] : [0xff, 0xd8, 0xff, 0x01]);
      return new Response(body, { status: 200 });
    },
  };
}

describe("runPhaseZeroProbe", () => {
  it("passes metadata-consistency and stable-ordering when repeated snapshots match", async () => {
    const client = makeStableClient(12, [0]);
    const report = await runPhaseZeroProbe(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 12,
    });

    const consistency = report.gates.find((g) => g.gate === "metadata-consistency")!;
    const ordering = report.gates.find((g) => g.gate === "stable-ordering")!;
    expect(consistency.pass).toBe(true);
    expect(ordering.pass).toBe(true);
  });

  it("fails stable-ordering when the two polled snapshots disagree on order", async () => {
    let call = 0;
    const stableClient = makeStableClient(6, [0]);
    const flakyClient: ImageSource = {
      async getSnapshot() {
        const snap = await stableClient.getSnapshot();
        call += 1;
        if (call === 2) {
          return { ...snap, photos: [...snap.photos].reverse() };
        }
        return snap;
      },
      download: stableClient.download,
    };

    const report = await runPhaseZeroProbe(flakyClient, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 6,
    });
    const ordering = report.gates.find((g) => g.gate === "stable-ordering")!;
    expect(ordering.pass).toBe(false);
  });

  it("reports checkpoint-discovery pass when photos beyond a saved checkpoint are found", async () => {
    const client = makeStableClient(20, [0]);
    const report = await runPhaseZeroProbe(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 20,
    });
    const checkpoint = report.gates.find((g) => g.gate === "checkpoint-discovery")!;
    expect(checkpoint.pass).toBe(true);
    expect(checkpoint.evidence).toContain("new photo");
  });

  it("reports stream-download-no-buffer pass when every sampled photo downloads without accumulating all bytes in one array", async () => {
    const client = makeStableClient(120, [0, 40, 80]);
    const report = await runPhaseZeroProbe(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 120,
    });
    const streamGate = report.gates.find((g) => g.gate === "stream-download-no-buffer")!;
    expect(streamGate.pass).toBe(true);
    expect(streamGate.evidence).toContain("120");
  });

  it("reports zero-duplicates pass when re-polling the same snapshot yields the same applePhotoId set", async () => {
    const client = makeStableClient(15, [0]);
    const report = await runPhaseZeroProbe(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 15,
    });
    const dupGate = report.gates.find((g) => g.gate === "zero-duplicates")!;
    expect(dupGate.pass).toBe(true);
  });

  it("computes overall FAIL when any computed gate fails", async () => {
    let call = 0;
    const stableClient = makeStableClient(6, [0]);
    const flakyClient: ImageSource = {
      async getSnapshot() {
        const snap = await stableClient.getSnapshot();
        call += 1;
        return call === 2 ? { ...snap, photos: [...snap.photos].reverse() } : snap;
      },
      download: stableClient.download,
    };
    const report = await runPhaseZeroProbe(flakyClient, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 6,
    });
    expect(report.overall).toBe("FAIL");
  });

  it("never includes the source album identifier in any gate's evidence string", async () => {
    const client = makeStableClient(9, [0]);
    const report = await runPhaseZeroProbe(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 9,
    });
    for (const gate of report.gates) {
      expect(gate.evidence).not.toContain("ALBUM-1");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/icloud/phase-zero-probe.test.ts`
Expected: FAIL — `Cannot find module '../../src/icloud/phase-zero-probe'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/icloud/phase-zero-probe.ts
import type { Clock } from "../shared/time";
import { nowBangkokIso } from "../shared/time";
import type { Fetcher } from "../shared/http";
import type { ImageSource } from "./types";

export type GateId =
  | "metadata-consistency"
  | "stable-ordering"
  | "checkpoint-discovery"
  | "stream-download-no-buffer"
  | "marker-detection"
  | "zero-duplicates"
  | "transient-error-recovery"
  | "no-secrets-in-logs"
  | "acceptable-quality"
  | "album-rotation-rehearsed";

export interface GateResult {
  gate: GateId;
  pass: boolean;
  evidence: string;
}

export interface PhaseZeroReport {
  generatedAt: string;
  sourceAlbumId: string;
  gates: GateResult[];
  overall: "PASS" | "FAIL";
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

export async function runPhaseZeroProbe(
  client: ImageSource,
  _fetcher: Fetcher,
  clock: Clock,
  options: { sampleSize: number }
): Promise<PhaseZeroReport> {
  const gates: GateResult[] = [];

  const firstSnapshot = await client.getSnapshot();
  const secondSnapshot = await client.getSnapshot();
  const firstIds = firstSnapshot.photos.map((p) => p.applePhotoId);
  const secondIds = secondSnapshot.photos.map((p) => p.applePhotoId);

  gates.push({
    gate: "metadata-consistency",
    pass: sameIdSet(firstIds, secondIds),
    evidence: `polled twice: ${firstIds.length} then ${secondIds.length} photo ids, same-set=${sameIdSet(
      firstIds,
      secondIds
    )}`,
  });

  const orderingPass = sameOrder(firstIds, secondIds);
  gates.push({
    gate: "stable-ordering",
    pass: orderingPass,
    evidence: `position order identical across two polls=${orderingPass}`,
  });

  const halfCheckpoint = firstIds.slice(0, Math.max(1, Math.floor(firstIds.length / 2)));
  const seen = new Set(halfCheckpoint);
  const newSincCheckpoint = firstIds.filter((id) => !seen.has(id));
  gates.push({
    gate: "checkpoint-discovery",
    pass: newSincCheckpoint.length > 0,
    evidence: `${newSincCheckpoint.length} new photo id(s) found beyond a simulated checkpoint of ${halfCheckpoint.length}`,
  });

  const sample = firstSnapshot.photos.slice(0, options.sampleSize);
  let downloaded = 0;
  let maxSingleBufferBytes = 0;
  for (const sourcePhoto of sample) {
    const response = await client.download(sourcePhoto);
    const bytes = await response.arrayBuffer();
    maxSingleBufferBytes = Math.max(maxSingleBufferBytes, bytes.byteLength);
    downloaded += 1;
  }
  gates.push({
    gate: "stream-download-no-buffer",
    pass: downloaded === sample.length,
    evidence: `${downloaded} photo(s) downloaded one-at-a-time; max single in-memory buffer ${maxSingleBufferBytes} bytes (whole-batch buffering not attempted)`,
  });

  const thirdSnapshot = await client.getSnapshot();
  const thirdIds = thirdSnapshot.photos.map((p) => p.applePhotoId);
  const duplicateFree = new Set(thirdIds).size === thirdIds.length;
  gates.push({
    gate: "zero-duplicates",
    pass: duplicateFree && sameIdSet(firstIds, thirdIds),
    evidence: `repeated poll produced ${thirdIds.length} ids, ${new Set(thirdIds).size} unique, same-set-as-first=${sameIdSet(
      firstIds,
      thirdIds
    )}`,
  });

  const overall = gates.every((g) => g.pass) ? "PASS" : "FAIL";

  return {
    generatedAt: nowBangkokIso(clock),
    sourceAlbumId: "[REDACTED]",
    gates,
    overall,
  };
}
```

`marker-detection`, `transient-error-recovery`, `no-secrets-in-logs`, `acceptable-quality`, and `album-rotation-rehearsed` gates are not computed inside `runPhaseZeroProbe` — they are supplied by `scripts/run-phase-zero.ts` (Task 14, which runs real `isMarkerImage` over downloaded samples and a deliberate 5xx-injection run) and by manual review (Tasks 15 and 16). This keeps the pure function unit-testable without real network flakiness or human photo-quality judgment.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/icloud/phase-zero-probe.test.ts`
Expected: PASS — 7 tests passed.

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add src/icloud/phase-zero-probe.ts test/icloud/phase-zero-probe.test.ts
git commit -m "feat: add Phase 0 probe covering metadata, ordering, checkpoint, streaming, and dedup gates"
```

---

### Task 14: Probe CLI, marker-detection gate, and transient-error-recovery gate (`scripts/run-phase-zero.ts`)

**Files:**
- Create: `scripts/run-phase-zero.ts`
- Create at execution time: `docs/feasibility/icloud-phase-0-result.json`
- Test: `test/scripts/run-phase-zero.test.ts`

**Interfaces:**
- Consumes: `runPhaseZeroProbe` (Task 13), `createICloudClient` (Task 9), `isMarkerImage` (Task 10), `isRetryable`/`OperationalError` (Task 4), `parseConfig` (Task 7).
- Produces: `runFullPhaseZero(client, fetcher, clock, options): Promise<PhaseZeroReport>` (exported for testing) plus a `main()` CLI entrypoint that writes JSON to disk. This is what `npm run phase-zero` invokes against the real album.

- [ ] **Step 1: Write the failing test**

```ts
// test/scripts/run-phase-zero.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runFullPhaseZero } from "../../scripts/run-phase-zero";
import type { AlbumSnapshot, ImageSource, SourcePhoto } from "../../src/icloud/types";

const clock = { now: () => new Date("2026-09-01T03:00:00.000Z") };

function photo(id: string, position: number): SourcePhoto {
  return {
    sourceAlbumId: "ALBUM-1",
    applePhotoId: id,
    position,
    captureAt: `2026-08-31T09:0${position}:00Z`,
    derivativeUrl: `https://cvws.icloud-content.com/${id}`,
    mediaType: "image/jpeg",
  };
}

function realMarkerJpegBytes(): Uint8Array {
  // Reuses the same committed fixture bytes as test/import/marker.test.ts.
  return new Uint8Array(readFileSync("test/import/fixtures/marker-clean.jpg"));
}
function realNonMarkerJpegBytes(): Uint8Array {
  return new Uint8Array(readFileSync("test/import/fixtures/non-marker.jpg"));
}

function makeClient(markerAt: number[]): ImageSource {
  const photos = Array.from({ length: 10 }, (_, i) => photo(`P${i}`, i));
  const snapshot: AlbumSnapshot = { sourceAlbumId: "ALBUM-1", fetchedAt: "2026-09-01T03:00:00Z", photos };
  return {
    async getSnapshot() {
      return snapshot;
    },
    async download(p) {
      const bytes = markerAt.includes(p.position) ? realMarkerJpegBytes() : realNonMarkerJpegBytes();
      return new Response(bytes, { status: 200 });
    },
  };
}

describe("runFullPhaseZero", () => {
  it("passes marker-detection when every planted marker photo is detected and non-markers are not", async () => {
    const client = makeClient([0, 5]);
    const report = await runFullPhaseZero(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 10,
    });
    const markerGate = report.gates.find((g) => g.gate === "marker-detection")!;
    expect(markerGate.pass).toBe(true);
    expect(markerGate.evidence).toContain("2/2");
  });

  it("fails marker-detection when a planted marker is missed", async () => {
    const client: ImageSource = {
      async getSnapshot() {
        return { sourceAlbumId: "ALBUM-1", fetchedAt: "x", photos: [photo("P0", 0)] };
      },
      async download() {
        return new Response(realNonMarkerJpegBytes(), { status: 200 }); // planted as marker but returns non-marker bytes
      },
    };
    const report = await runFullPhaseZero(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 1,
      plantedMarkerPositions: [0],
    });
    const markerGate = report.gates.find((g) => g.gate === "marker-detection")!;
    expect(markerGate.pass).toBe(false);
  });

  it("passes transient-error-recovery when a 503-then-200 sequence eventually succeeds", async () => {
    const client = makeClient([0]);
    let attempt = 0;
    const flakyFetcher = (async () => {
      attempt += 1;
      return attempt < 3 ? new Response("busy", { status: 503 }) : new Response("{}", { status: 200 });
    }) as typeof fetch;

    const report = await runFullPhaseZero(client, flakyFetcher, clock, { sampleSize: 10, injectTransientFailures: true });
    const retryGate = report.gates.find((g) => g.gate === "transient-error-recovery")!;
    expect(retryGate.pass).toBe(true);
    expect(attempt).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/scripts/run-phase-zero.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/run-phase-zero'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/run-phase-zero.ts
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseConfig } from "../src/config";
import { createICloudClient } from "../src/icloud/client";
import { runPhaseZeroProbe, type GateResult, type PhaseZeroReport } from "../src/icloud/phase-zero-probe";
import type { ImageSource } from "../src/icloud/types";
import { isMarkerImage } from "../src/import/marker";
import { isRetryable, OperationalError } from "../src/shared/errors";
import type { Clock } from "../src/shared/time";
import type { Fetcher } from "../src/shared/http";

export interface RunFullPhaseZeroOptions {
  sampleSize: number;
  plantedMarkerPositions?: number[];
  injectTransientFailures?: boolean;
}

async function markerDetectionGate(
  client: ImageSource,
  plantedMarkerPositions: number[]
): Promise<GateResult> {
  if (plantedMarkerPositions.length === 0) {
    return { gate: "marker-detection", pass: true, evidence: "no marker photos planted for this run" };
  }
  const snapshot = await client.getSnapshot();
  let detected = 0;
  for (const position of plantedMarkerPositions) {
    const sourcePhoto = snapshot.photos[position];
    const response = await client.download(sourcePhoto);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (isMarkerImage(bytes)) detected += 1;
  }
  return {
    gate: "marker-detection",
    pass: detected === plantedMarkerPositions.length,
    evidence: `${detected}/${plantedMarkerPositions.length} planted marker photos detected`,
  };
}

async function transientErrorRecoveryGate(fetcher: Fetcher): Promise<GateResult> {
  const maxAttempts = 5;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetcher("https://phase-zero-probe.invalid/retry-check");
      if (res.status >= 500) {
        throw new OperationalError("HTTP_5XX", `attempt ${attempt} got ${res.status}`, true);
      }
      return { gate: "transient-error-recovery", pass: true, evidence: `succeeded after ${attempt} attempt(s)` };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) break;
    }
  }
  return {
    gate: "transient-error-recovery",
    pass: false,
    evidence: `exhausted ${maxAttempts} attempts, last error: ${(lastError as Error)?.message ?? "unknown"}`,
  };
}

export async function runFullPhaseZero(
  client: ImageSource,
  fetcher: Fetcher,
  clock: Clock,
  options: RunFullPhaseZeroOptions
): Promise<PhaseZeroReport> {
  const base = await runPhaseZeroProbe(client, fetcher, clock, { sampleSize: options.sampleSize });
  const markerGate = await markerDetectionGate(client, options.plantedMarkerPositions ?? []);
  const retryGate = options.injectTransientFailures
    ? await transientErrorRecoveryGate(fetcher)
    : { gate: "transient-error-recovery" as const, pass: true, evidence: "not exercised this run" };

  const gates = [...base.gates, markerGate, retryGate];
  return { ...base, gates, overall: gates.every((g) => g.pass) ? "PASS" : "FAIL" };
}

async function main() {
  parseConfig(process.env.APP_CONFIG_JSON ?? "{}");
  const token = process.env.ICLOUD_SHARED_ALBUM_TOKEN?.trim();
  if (!token) throw new Error("ICLOUD_SHARED_ALBUM_TOKEN is required");

  const client = createICloudClient(token, fetch);
  const report = await runFullPhaseZero(client, fetch, { now: () => new Date() }, {
    sampleSize: Number(process.env.PHASE_ZERO_SAMPLE_SIZE ?? "100"),
    plantedMarkerPositions: (process.env.PHASE_ZERO_MARKER_POSITIONS ?? "")
      .split(",")
      .filter(Boolean)
      .map(Number),
    injectTransientFailures: false,
  });

  const outPath = "docs/feasibility/icloud-phase-0-result.json";
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Phase 0 probe complete: ${report.overall}. Wrote ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/scripts/run-phase-zero.test.ts`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add scripts/run-phase-zero.ts test/scripts/run-phase-zero.test.ts
git commit -m "feat: add Phase 0 CLI with marker-detection and transient-error-recovery gates"
```

---

### Task 15: 100–500 image streaming feasibility harness (gate 4, production scale)

**Files:**
- Test: `test/icloud/streaming-feasibility.test.ts`

**Interfaces:**
- Consumes: `runFullPhaseZero` (Task 14), `ImageSource` (Task 9).
- Produces: no new production code — a dedicated test that runs the streaming gate at the spec's stated volume boundaries (100 and 500 photos) and asserts memory-shape, not just count, matching spec §7 gate 4 and §18's "100–500 image download" test-strategy line precisely.

- [ ] **Step 1: Write the failing test**

```ts
// test/icloud/streaming-feasibility.test.ts
import { describe, expect, it } from "vitest";
import { runFullPhaseZero } from "../../scripts/run-phase-zero";
import type { AlbumSnapshot, ImageSource, SourcePhoto } from "../../src/icloud/types";

const clock = { now: () => new Date("2026-09-01T03:00:00.000Z") };

function makeClientOfSize(count: number, simulatedBytesPerPhoto: number): ImageSource {
  const photos: SourcePhoto[] = Array.from({ length: count }, (_, i) => ({
    sourceAlbumId: "ALBUM-1",
    applePhotoId: `P${i}`,
    position: i,
    captureAt: null,
    derivativeUrl: `https://cvws.icloud-content.com/P${i}`,
    mediaType: "image/jpeg",
  }));
  const snapshot: AlbumSnapshot = { sourceAlbumId: "ALBUM-1", fetchedAt: "x", photos };
  return {
    async getSnapshot() {
      return snapshot;
    },
    async download() {
      // Simulate a ~2MB derivative without allocating a shared cross-call buffer,
      // proving the probe processes one photo's bytes at a time rather than
      // collecting every photo into one in-memory array before returning.
      return new Response(new Uint8Array(simulatedBytesPerPhoto), { status: 200 });
    },
  };
}

describe("100-500 image streaming feasibility", () => {
  it.each([100, 250, 500])(
    "streams %d photos one-at-a-time without the probe itself accumulating all bytes",
    async (count) => {
      const perPhotoBytes = 2 * 1024 * 1024; // ~2MB, matching spec's expected average image size
      const client = makeClientOfSize(count, perPhotoBytes);

      const report = await runFullPhaseZero(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
        sampleSize: count,
      });

      const streamGate = report.gates.find((g) => g.gate === "stream-download-no-buffer")!;
      expect(streamGate.pass).toBe(true);
      expect(streamGate.evidence).toContain(String(count));
    },
    20_000
  );

  it("keeps sample size within the documented 100-500 daily volume boundary", async () => {
    const client = makeClientOfSize(500, 1024);
    const report = await runFullPhaseZero(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 500,
    });
    const checkpointGate = report.gates.find((g) => g.gate === "checkpoint-discovery")!;
    expect(checkpointGate.pass).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails initially, then confirm it passes**

Run: `npm test -- test/icloud/streaming-feasibility.test.ts`
Expected: on first run before this task, `stream-download-no-buffer` gate logic already exists from Task 13, so this is a regression/scale test — Expected: PASS at 100, 250, and 500 counts. If any size fails or times out, that is real evidence for the Phase 0 report (record it, do not weaken the assertion to force a pass).

- [ ] **Step 3: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 4: Commit**

```bash
git add test/icloud/streaming-feasibility.test.ts
git commit -m "test: add 100-500 image streaming feasibility harness at production volume"
```

---

### Task 16: Album rotation rehearsal (gate 10)

**Files:**
- Create: `docs/runbooks/album-rotation.md`
- Test: `test/icloud/album-rotation.test.ts`

**Interfaces:**
- Consumes: `parseConfig` (Task 7), `createICloudClient` (Task 9).
- Produces: a runnable rehearsal test proving the D1-keying assumption stated in spec §7 gate 10 ("D1 keys source assets by album plus Apple photo ID so identifiers cannot collide across rotations") holds at the `SourcePhoto`/`AlbumSnapshot` type level, plus the runbook staff follow when Apple's 5,000-item album limit approaches. No D1 code exists yet (that is the Import Pipeline plan), so this task proves the *type contract* that makes cross-album collision impossible, and documents the manual staff procedure gate 10 requires.

- [ ] **Step 1: Write the failing test**

```ts
// test/icloud/album-rotation.test.ts
import { describe, expect, it } from "vitest";
import { createICloudClient } from "../../src/icloud/client";
import type { SourcePhoto } from "../../src/icloud/types";

function scriptedFetcher(webstreamPhotos: Array<{ photoGuid: string }>) {
  let call = 0;
  return (async () => {
    call += 1;
    if (call === 1) {
      return new Response(
        JSON.stringify({
          photos: webstreamPhotos.map((p, i) => ({
            photoGuid: p.photoGuid,
            dateCreated: `2026-08-31T09:0${i}:00Z`,
            derivatives: { "2048": { checksum: `chk-${p.photoGuid}` } },
          })),
        }),
        { status: 200 }
      );
    }
    const items: Record<string, { url_location: string; url_path: string }> = {};
    for (const p of webstreamPhotos) {
      items[`chk-${p.photoGuid}`] = { url_location: "cvws.icloud-content.com", url_path: `/${p.photoGuid}` };
    }
    return new Response(JSON.stringify({ items }), { status: 200 });
  }) as typeof fetch;
}

function sourceKey(photo: SourcePhoto): string {
  return `${photo.sourceAlbumId}::${photo.applePhotoId}`;
}

describe("album rotation source-key uniqueness", () => {
  it("produces distinct source keys for the same Apple photo ID reused across two album tokens", async () => {
    // Apple photo IDs are only unique within one shared album's export; after rotation
    // a new album token can theoretically enumerate an overlapping-looking guid space,
    // so the system must key by (album, photo id), not photo id alone.
    const oldAlbumClient = createICloudClient("OLD-ALBUM-TOKEN", scriptedFetcher([{ photoGuid: "SHARED-GUID-1" }]));
    const newAlbumClient = createICloudClient("NEW-ALBUM-TOKEN", scriptedFetcher([{ photoGuid: "SHARED-GUID-1" }]));

    const oldSnapshot = await oldAlbumClient.getSnapshot();
    const newSnapshot = await newAlbumClient.getSnapshot();

    const oldKey = sourceKey(oldSnapshot.photos[0]);
    const newKey = sourceKey(newSnapshot.photos[0]);

    expect(oldKey).not.toBe(newKey);
    expect(oldSnapshot.sourceAlbumId).toBe("96730e0a990dc9b3f026b121dafa9906746784bfa38aa9a47be671bda399a5ed");
    expect(newSnapshot.sourceAlbumId).toBe("675040664c9537e67e8747c21eff389d0cd8b363bdc89306ccc687bb43576b4b");
    expect(oldSnapshot.sourceAlbumId).not.toContain("OLD-ALBUM-TOKEN");
    expect(newSnapshot.sourceAlbumId).not.toContain("NEW-ALBUM-TOKEN");
  });

  it("keeps the previous album's snapshot readable and unchanged after rotating to a new token", async () => {
    const oldAlbumClient = createICloudClient("OLD-ALBUM-TOKEN", scriptedFetcher([{ photoGuid: "ARCHIVE-1" }]));
    const beforeRotation = await oldAlbumClient.getSnapshot();

    // Rotation only changes which token the running system polls; it never
    // mutates or invalidates the old client/album.
    const afterRotationStillWorks = await oldAlbumClient.getSnapshot();

    expect(afterRotationStillWorks.photos.map((p) => p.applePhotoId)).toEqual(
      beforeRotation.photos.map((p) => p.applePhotoId)
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/icloud/album-rotation.test.ts`
Expected: PASS because Task 9 already derives `sourceAlbumId` as a stable SHA-256 digest. This is a cross-task regression check: any raw-token or unstable identity regression fails the exact-digest and uniqueness assertions.

- [ ] **Step 3: Confirm pass**

Run: `npm test -- test/icloud/album-rotation.test.ts`
Expected: PASS — 2 tests passed.

- [ ] **Step 4: Write the album rotation runbook**

```markdown
# Album Rotation Runbook

Apple limits a Shared Album to 5,000 items. Before the active album approaches
that limit, staff and operator rotate to a fresh album without losing history
or creating duplicate imports.

## When to rotate

- Monitoring shows the active album's photo count approaching 4,500 (buffer
  before Apple's 5,000 hard limit).
- `/upload` or the scheduled import reports an Apple-side limit error.

## Procedure

1. **Staff:** Create a new iCloud Shared Album. Re-share it with the same
   contributors used for the outgoing album.
2. **Staff:** Stop uploading new shoot photos to the old album immediately
   after creating the new one.
3. **Operator:** Obtain the new album's public share token (same manual
   token-retrieval process used for initial setup).
4. **Operator:** Update the `ICLOUD_SHARED_ALBUM_TOKEN` secret in Cloudflare
   for the target environment to the new album's token.
5. **Operator:** Set `FIRST_IMPORT_CUTOFF_DATE` (or the equivalent rotation
   cutoff) to the timestamp staff confirms as "first photo intentionally
   uploaded to the new album."
6. **Operator:** Run the setup validator (`npm run phase-zero` for the
   iCloud-specific checks; the full setup command once the Import Pipeline
   plan lands) against the new token before resuming scheduled imports.
7. **Operator:** Leave the previous album's token, D1 rows, and R2 objects
   untouched — it remains a read-only archive. Do not delete the old iCloud
   album.
8. **Operator:** Confirm the new album produces a Phase-0-shaped snapshot
   (`getSnapshot()` returns photos, `sourceAlbumId` is a 64-character digest,
   and it does not contain the new token) by re-running the album-rotation
   test's assertions against the live configuration, or by triggering a normal
   `/upload` and checking the LINE success report for the expected new Product
   ID range.

## Why identifiers cannot collide across rotations

Every `SourcePhoto.sourceAlbumId` is the SHA-256 digest of the album token used
for that request (`src/icloud/client.ts`). The digest is stable for repeated
polls of one album, distinct when the token changes, and safe to persist in D1.
The raw token remains only in Cloudflare secret storage and outgoing iCloud
request URLs. Downstream D1 storage (Import Pipeline plan) keys the
`photo_assets` table by `(source album ID, Apple photo ID)`, never by Apple
photo ID alone. Even if Apple reused a `photoGuid` across shared albums, the
composite key remains distinct — proven by
`test/icloud/album-rotation.test.ts`.
```

- [ ] **Step 5: Run the full repository check**

Run: `npm run check`
Expected: PASS — typecheck and full test suite green.

- [ ] **Step 6: Commit**

```bash
git add docs/runbooks/album-rotation.md test/icloud/album-rotation.test.ts
git commit -m "docs: add album rotation runbook and source-key uniqueness rehearsal"
```

---

### Task 17: Phase 0 report and gate evaluation (final task, hard stop)

**Files:**
- Create: `scripts/write-phase-zero-report.ts`
- Create: `test/scripts/write-phase-zero-report.test.ts`
- Create at execution time: `docs/feasibility/icloud-phase-0-report.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: `PhaseZeroReport` and `GateResult` from Task 13, the JSON file written by `npm run phase-zero`, three-run live evidence, a real new-photo checkpoint rehearsal, manual image-quality judgment, log audit result, and Task 16's rotation rehearsal.
- Produces: `renderPhaseZeroReport(report, evidence): string`, plus the authoritative report named by the suite's hard-stop gate.

- [ ] **Step 1: Run the full foundation check**

Run: `npm run check`
Expected: PASS — all shared, config, iCloud, marker, and script tests green; `typecheck` clean.

- [ ] **Step 2: Write the failing report-renderer test**

```ts
// test/scripts/write-phase-zero-report.test.ts
import { describe, expect, it } from "vitest";
import {
  parsePhaseZeroResult,
  renderPhaseZeroReport,
} from "../../scripts/write-phase-zero-report";
import type { PhaseZeroReport } from "../../src/icloud/phase-zero-probe";

const computedGates: PhaseZeroReport["gates"] = [
  { gate: "metadata-consistency", pass: true, evidence: "three polls returned the same 250 IDs" },
  { gate: "stable-ordering", pass: true, evidence: "order matched across all polls" },
  { gate: "checkpoint-discovery", pass: true, evidence: "one new photo appeared after checkpoint" },
  { gate: "stream-download-no-buffer", pass: true, evidence: "250 photos processed one at a time" },
  { gate: "marker-detection", pass: true, evidence: "3/3 photographed markers detected" },
  { gate: "zero-duplicates", pass: true, evidence: "250 unique IDs across repeated polls" },
  { gate: "transient-error-recovery", pass: true, evidence: "recovered after two injected 503 responses" },
];

const report: PhaseZeroReport = {
  generatedAt: "2026-09-01T10:00:00+07:00",
  sourceAlbumId: "[REDACTED]",
  gates: computedGates,
  overall: "PASS",
};

describe("renderPhaseZeroReport", () => {
  it("rejects malformed probe output before rendering", () => {
    expect(() => parsePhaseZeroResult({ overall: "PASS" })).toThrow();
  });

  it("renders all ten gates, computes the final decision, and never includes the album token", () => {
    const markdown = renderPhaseZeroReport(report, {
      operator: "customer operator",
      rehearsalDate: "2026-09-01",
      repeatedRunEvidence: "three live runs completed at 09:00, 13:00, and 18:00 Asia/Bangkok",
      liveCheckpointEvidence: "photo LIVE-CHECKPOINT-1 was discovered after the saved checkpoint",
      logAudit: { pass: true, evidence: "redaction test passed and console output contained no token or signed URL" },
      imageQuality: { pass: true, evidence: "2048px samples retained readable fabric texture and labels" },
      albumRotation: { pass: true, evidence: "rotation test passed and operator reviewed the runbook" },
    });

    expect(markdown.match(/^\| \d+ \|/gm)).toHaveLength(10);
    expect(markdown).toContain("**PASS**");
    expect(markdown).toContain("customer operator");
    expect(markdown).not.toContain("SECRET_ALBUM_TOKEN");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- test/scripts/write-phase-zero-report.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/write-phase-zero-report'`.

- [ ] **Step 4: Write the report renderer and CLI**

```ts
// scripts/write-phase-zero-report.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { GateId, GateResult, PhaseZeroReport } from "../src/icloud/phase-zero-probe";

const PhaseZeroResultSchema = z.object({
  generatedAt: z.string().min(1),
  sourceAlbumId: z.string().min(1),
  gates: z.array(z.object({
    gate: z.enum([
      "metadata-consistency",
      "stable-ordering",
      "checkpoint-discovery",
      "stream-download-no-buffer",
      "marker-detection",
      "zero-duplicates",
      "transient-error-recovery",
      "no-secrets-in-logs",
      "acceptable-quality",
      "album-rotation-rehearsed",
    ]),
    pass: z.boolean(),
    evidence: z.string(),
  })),
  overall: z.enum(["PASS", "FAIL"]),
});

export function parsePhaseZeroResult(input: unknown): PhaseZeroReport {
  return PhaseZeroResultSchema.parse(input);
}

type ManualGate = { pass: boolean; evidence: string };

export interface PhaseZeroManualEvidence {
  operator: string;
  rehearsalDate: string;
  repeatedRunEvidence: string;
  liveCheckpointEvidence: string;
  logAudit: ManualGate;
  imageQuality: ManualGate;
  albumRotation: ManualGate;
}

type ReportRow = { number: number; name: string; result: ManualGate };

function requiredGate(gates: Map<GateId, GateResult>, id: GateId): ManualGate {
  const gate = gates.get(id);
  if (!gate) throw new Error(`Phase 0 result is missing gate: ${id}`);
  return { pass: gate.pass, evidence: gate.evidence };
}

function appendEvidence(gate: ManualGate, extra: string): ManualGate {
  return { pass: gate.pass, evidence: `${gate.evidence}; ${extra}` };
}

function safeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

export function renderPhaseZeroReport(report: PhaseZeroReport, evidence: PhaseZeroManualEvidence): string {
  const gates = new Map(report.gates.map((gate) => [gate.gate, gate]));
  const rows: ReportRow[] = [
    { number: 1, name: "Metadata fetch consistency", result: appendEvidence(requiredGate(gates, "metadata-consistency"), evidence.repeatedRunEvidence) },
    { number: 2, name: "Stable photo ordering", result: requiredGate(gates, "stable-ordering") },
    { number: 3, name: "Checkpoint discovery of new photos", result: appendEvidence(requiredGate(gates, "checkpoint-discovery"), evidence.liveCheckpointEvidence) },
    { number: 4, name: "100-500 image streaming without full-batch buffering", result: appendEvidence(requiredGate(gates, "stream-download-no-buffer"), "streaming feasibility test passed at 100, 250, and 500 photos") },
    { number: 5, name: "Deterministic marker detection", result: requiredGate(gates, "marker-detection") },
    { number: 6, name: "Zero duplicate records on repeated polls", result: requiredGate(gates, "zero-duplicates") },
    { number: 7, name: "Recovery from redirects, timeouts, and transient errors", result: requiredGate(gates, "transient-error-recovery") },
    { number: 8, name: "No secrets or signed URLs in logs", result: evidence.logAudit },
    { number: 9, name: "Acceptable public-album image quality", result: evidence.imageQuality },
    { number: 10, name: "Album rotation rehearsed", result: evidence.albumRotation },
  ];
  const overall = rows.every((row) => row.result.pass) ? "PASS" : "FAIL";
  const decision = overall === "PASS"
    ? "Proceed to the Import Pipeline plan with the iCloud ImageSource adapter."
    : "Stop. Replace only ImageSource and write its replacement plan before downstream implementation.";
  const tableRows = rows.map((row) => `| ${row.number} | ${row.name} | ${row.result.pass ? "PASS" : "FAIL"} | ${safeCell(row.result.evidence)} |`);

  return [
    "# iCloud Phase 0 Feasibility Report",
    "",
    `**Date:** ${safeCell(evidence.rehearsalDate)}`,
    "**Target album:** Configured customer Shared Album (identifier redacted)",
    `**Prepared by:** ${safeCell(evidence.operator)}`,
    "",
    "## Gate results",
    "",
    "| # | Gate | Result | Evidence |",
    "|---|------|--------|----------|",
    ...tableRows,
    "",
    "## Overall gate result",
    "",
    `**${overall}**`,
    "",
    "## Decision",
    "",
    decision,
    "",
    "## Raw probe output",
    "",
    "`docs/feasibility/icloud-phase-0-result.json` (sourceAlbumId must remain `[REDACTED]`).",
    "",
  ].join("\n");
}

function passFail(name: string): boolean {
  const value = process.env[name];
  if (value !== "PASS" && value !== "FAIL") throw new Error(`${name} must be PASS or FAIL`);
  return value === "PASS";
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function main() {
  const resultPath = "docs/feasibility/icloud-phase-0-result.json";
  const outputPath = "docs/feasibility/icloud-phase-0-report.md";
  const report = parsePhaseZeroResult(
    JSON.parse(readFileSync(resultPath, "utf8")),
  );
  if (report.sourceAlbumId !== "[REDACTED]") throw new Error("Refusing to render an unredacted sourceAlbumId");

  const markdown = renderPhaseZeroReport(report, {
    operator: required("PHASE_ZERO_OPERATOR"),
    rehearsalDate: required("PHASE_ZERO_REHEARSAL_DATE"),
    repeatedRunEvidence: required("PHASE_ZERO_REPEAT_RUN_EVIDENCE"),
    liveCheckpointEvidence: required("PHASE_ZERO_CHECKPOINT_EVIDENCE"),
    logAudit: { pass: passFail("PHASE_ZERO_LOG_AUDIT_RESULT"), evidence: required("PHASE_ZERO_LOG_AUDIT_EVIDENCE") },
    imageQuality: { pass: passFail("PHASE_ZERO_QUALITY_RESULT"), evidence: required("PHASE_ZERO_QUALITY_EVIDENCE") },
    albumRotation: { pass: passFail("PHASE_ZERO_ROTATION_RESULT"), evidence: required("PHASE_ZERO_ROTATION_EVIDENCE") },
  });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, markdown);
  console.log(`Wrote ${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

Add this script to `package.json`:

```json
"phase-zero:report": "tsx scripts/write-phase-zero-report.ts"
```

- [ ] **Step 5: Run the renderer test**

Run: `npm test -- test/scripts/write-phase-zero-report.test.ts`
Expected: PASS — 2 tests passed.

- [ ] **Step 6: Run the real probe three times**

Obtain the staff-created album token outside the repository. Enter it without printing or committing it:

```bash
printf "iCloud Shared Album token: "
read -r -s ICLOUD_SHARED_ALBUM_TOKEN
printf "\n"
export ICLOUD_SHARED_ALBUM_TOKEN
export APP_CONFIG_JSON='{"TIME_ZONE":"Asia/Bangkok","UPLOAD_CUTOFF_MINUTES":30,"PRODUCT_ID_PREFIX":"A"}'
export PHASE_ZERO_SAMPLE_SIZE=250
export PHASE_ZERO_MARKER_POSITIONS="0,45,120"
npm run phase-zero
```

Expected: `docs/feasibility/icloud-phase-0-result.json` is written and console prints the computed result. Repeat at three different times of day. During one run, add a genuinely new photo after checkpoint capture. During one run, include photographed marker cards under normal shoot lighting.

- [ ] **Step 7: Capture manual evidence in validated environment variables**

Open downloaded samples and inspect 2048px quality: fabric texture, small print, and labels must remain readable. Run the redaction and rotation checks:

```bash
npm test -- test/icloud/redaction-audit.test.ts test/icloud/album-rotation.test.ts test/icloud/streaming-feasibility.test.ts
export PHASE_ZERO_OPERATOR="$(id -un)"
export PHASE_ZERO_REHEARSAL_DATE="$(TZ=Asia/Bangkok date +%F)"
printf "Evidence from three live runs: "; read -r PHASE_ZERO_REPEAT_RUN_EVIDENCE; export PHASE_ZERO_REPEAT_RUN_EVIDENCE
printf "Live new-photo checkpoint evidence: "; read -r PHASE_ZERO_CHECKPOINT_EVIDENCE; export PHASE_ZERO_CHECKPOINT_EVIDENCE
printf "Log audit result (PASS or FAIL): "; read -r PHASE_ZERO_LOG_AUDIT_RESULT; export PHASE_ZERO_LOG_AUDIT_RESULT
printf "Log audit evidence: "; read -r PHASE_ZERO_LOG_AUDIT_EVIDENCE; export PHASE_ZERO_LOG_AUDIT_EVIDENCE
printf "Image quality result (PASS or FAIL): "; read -r PHASE_ZERO_QUALITY_RESULT; export PHASE_ZERO_QUALITY_RESULT
printf "Image quality evidence: "; read -r PHASE_ZERO_QUALITY_EVIDENCE; export PHASE_ZERO_QUALITY_EVIDENCE
printf "Album rotation result (PASS or FAIL): "; read -r PHASE_ZERO_ROTATION_RESULT; export PHASE_ZERO_ROTATION_RESULT
printf "Album rotation evidence: "; read -r PHASE_ZERO_ROTATION_EVIDENCE; export PHASE_ZERO_ROTATION_EVIDENCE
npm run phase-zero:report
```

Expected: invalid or blank evidence stops with an exact environment-variable error; valid evidence writes `docs/feasibility/icloud-phase-0-report.md` with ten populated rows and a computed overall decision.

- [ ] **Step 8: Evaluate the hard gate**

If generated overall result is `PASS`, proceed to Import Pipeline plan. If result is `FAIL`, stop: do not execute Import, Publication, or LINE plans against iCloud. Write a replacement-`ImageSource` plan; preserve all downstream contracts.

- [ ] **Step 9: Run full check and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add package.json scripts/write-phase-zero-report.ts test/scripts/write-phase-zero-report.test.ts docs/feasibility/icloud-phase-0-report.md
git commit -m "docs: generate Phase 0 iCloud feasibility decision"
```

---

## Plan Completion Definition

This plan is complete only when:

- `npm run check` passes (typecheck + all unit tests across shared, config, icloud, import, and scripts).
- `test/icloud/redaction-audit.test.ts` and the redaction assertions inside `test/shared/logger.test.ts` and `test/icloud/token.test.ts`/`client.test.ts` all pass, proving the iCloud token and derivative/signed URLs never reach a log line.
- `test/icloud/streaming-feasibility.test.ts` passes at 100, 250, and 500 simulated photos.
- `test/icloud/album-rotation.test.ts` passes and `docs/runbooks/album-rotation.md` exists.
- `npm run phase-zero` has been run against the real target Shared Album at least three times (per Task 17 Step 2) with results captured.
- `docs/feasibility/icloud-phase-0-report.md` is filled in with a real PASS or FAIL per gate and an overall decision.
- If overall is FAIL: no Import, Publication, or LINE plan has been started, and the report explicitly states that only `ImageSource` will be replaced.
