# Snazzy Automation Implementation Plan Suite

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build customer-owned Cloudflare automation that imports marker-grouped iCloud photos into Airtable, generates publication-ready Google Docs, and manages inventory through safe LINE commands.

**Architecture:** Native Cloudflare Worker routes trigger two durable Workflows. D1 owns state and idempotency, R2 owns image originals, Airtable owns human product data, and narrow clients isolate iCloud, Airtable, Claude, Google, and LINE. Scope is split into five sequential plans so each subsystem can be reviewed and accepted independently.

**Tech Stack:** TypeScript, Cloudflare Workers, Cloudflare Workflows, D1, R2, Cloudflare Images, npm, Vitest 4.1+, `@cloudflare/vitest-plugin`, Zod, `@anthropic-ai/sdk`, `jpeg-js`, `jsqr`, Airtable REST API, Google Docs/Drive REST APIs, LINE Messaging API.

**Spec:** `docs/superpowers/specs/2026-09-01-snazzy-automation-design.md`

## Global Constraints

- Dedicated customer-owned staging and production deployments.
- Runtime timezone: `Asia/Bangkok`.
- Import volume: 100–500 photos/day; normal product group: 9–15 photos.
- Import starts only after documented 30-minute upload cutoff.
- Product IDs use `A-<NUMBER>`; D1 becomes sole sequence authority after one-time Airtable bootstrap.
- Original images remain in private R2 indefinitely under content hash.
- Marker image never becomes Product attachment.
- Each Airtable `Product Images` attachment uses a temporary signed ingestion URL plus `filename` equal to the private R2 object basename; publication reconstructs `assets/<filename>` and never treats the temporary URL as object identity.
- Successful Product rows remain when another group fails.
- Retry transient workflow steps up to five times after the initial attempt, with exponential backoff.
- One final Google Doc per Airtable Publication Run.
- Missing Product data blocks whole publication and creates no Google Doc.
- Claude model defaults to `claude-opus-5`; text fields only; exactly three Thai drafts per Product ID.
- `/soldout` accepts exactly one Product ID and one whole-baht price.
- Already-Out Product is never overwritten.
- Only allowlisted LINE group may execute commands; every LINE webhook signature is verified.
- Never log credentials, public-album token/link, signed URLs, Product images, or raw external response bodies containing them.
- MVP excludes admin dashboard, AI photo grouping, always-on Mac, VPS, Redis, Postgres, n8n, Make, and automatic social publication.
- Use native `fetch` routing; do not add web framework.
- Private R2 delivery uses an HMAC-signed Worker route backed by secret `ASSET_URL_SIGNING_SECRET` and non-secret `PUBLIC_BASE_URL`; do not call nonexistent `R2Bucket.createSignedUrl`.
- Direct operator routes `/upload`, `/docs`, `/setup`, and `/usage` require constant-time bearer verification against secret `ADMIN_ROUTE_TOKEN`; LINE handlers call internal trigger services only after LINE trust checks.
- Import progress uses explicit `import_checkpoints`; partially persisted assets never advance the checkpoint.
- Use official `@anthropic-ai/sdk`; do not call Claude through raw HTTP.
- Use Web Crypto for Google service-account JWT; do not add Node-only Google SDK.
- Use current Cloudflare Vitest plugin: `@cloudflare/vitest-plugin` with Vitest 4.1 or later; do not use removed `@cloudflare/vitest-pool-workers` APIs.
- Cloudflare compatibility date must be `2026-09-01` or later and include `nodejs_compat`.
- Every non-trivial parser, state transition, money mutation, and trust boundary starts with failing test.
- Every task ends with focused tests, `npm run check`, and a commit.

---

## Plan Order and Stop Gates

1. **[Foundation and iCloud feasibility](2026-09-01-snazzy-foundation-icloud-feasibility.md)**
   - Creates project skeleton, configuration, shared test harness, marker contract, and throwaway iCloud probe.
   - **Hard stop:** no import implementation until Phase 0 report says `PASS`.
2. **[Import pipeline](2026-09-01-snazzy-import-pipeline.md)**
   - Creates D1/R2 state, marker grouping, Product IDs, Airtable Product rows, durable retries, rollback, and import logs.
   - Produces independently useful Upload → Airtable release.
3. **[Publication pipeline](2026-09-01-snazzy-publication-pipeline.md)**
   - Creates completeness validation, 4-in-1 composition, Claude captions, Google Docs output, and `/docs` trigger.
4. **[LINE inventory bot](2026-09-01-snazzy-line-inventory.md)**
   - Creates LINE webhook security, `/help`, `/search`, `/soldout`, confirmation, audit, and `/revert`.
5. **[Hardening and customer handoff](2026-09-01-snazzy-hardening-handoff.md)**
   - Creates failure-injection suite, production-sized acceptance harness, setup validator, monitoring, cost controls, and runbooks.

If Phase 0 fails, record evidence in `docs/feasibility/icloud-phase-0-report.md`, stop, and write a replacement `ImageSource` plan. Do not alter import, publication, or LINE contracts.

## Fixed Low-Level Decisions

### Package and runtime

Install with npm and commit `package-lock.json`:

```bash
npm install @anthropic-ai/sdk zod jpeg-js jsqr
npm install --save-dev typescript wrangler vitest@^4.1.0 @cloudflare/vitest-plugin @cloudflare/workers-types @types/jpeg-js tsx qrcode @types/qrcode
```

`package.json` scripts:

```json
{
  "scripts": {
    "check": "npm run typecheck && npm test",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:acceptance": "vitest run test/acceptance",
    "phase-zero": "tsx scripts/run-phase-zero.ts",
    "phase-zero:report": "tsx scripts/write-phase-zero-report.ts",
    "generate-marker": "tsx scripts/generate-marker.ts",
    "setup:verify": "tsx scripts/verify-airtable-schema.ts",
    "smoke": "tsx scripts/smoke-test.ts",
    "dev": "wrangler dev",
    "deploy:staging": "wrangler deploy --env staging",
    "deploy:production": "wrangler deploy --env production",
    "db:migrate:local": "wrangler d1 migrations apply snazzy-automation-local --local",
    "db:migrate:staging": "wrangler d1 migrations apply snazzy-automation-staging --remote",
    "db:migrate:production": "wrangler d1 migrations apply snazzy-automation-production --remote"
  }
}
```

### Marker contract

Reusable marker is printed QR card containing exactly:

```text
SNAZZY_PRODUCT_START_V1
```

Detection path:

1. Ask Cloudflare Images to normalize source derivative to JPEG, maximum 1024×1024.
2. Decode one image at a time with `jpeg-js`.
3. Read QR payload with `jsqr`.
4. Return marker only when payload equals exact constant.
5. Record marker in D1/R2 but never attach it to Airtable Product.

This is deterministic and avoids AI vision. Phase 0 must prove marker detection against controlled distance, angle, blur, and lighting samples before production code depends on it.

### External boundaries

Each client is concrete and narrow. Workflow functions accept structural client types so tests can pass fakes without factories or dependency-injection framework.

```ts
// src/shared/time.ts
export type Clock = { now(): Date };

// src/shared/ids.ts
export type IdGenerator = { next(): string };

// src/shared/http.ts
export type Fetcher = typeof fetch;
```

### Retry ownership

- Cloudflare Workflow `step.do()` owns durable retry count and backoff.
- External SDK automatic retries are disabled where Workflow retries same call; Anthropic client uses `maxRetries: 0`.
- Pure parsers and validation functions never retry.
- Non-transient 4xx errors fail immediately and produce actionable error codes.

### Idempotency keys

- Source album: `sourceAlbumId = sha256(ICLOUD_SHARED_ALBUM_TOKEN)`; raw token never enters D1, logs, hashes, or reports.
- Source image: `(sourceAlbumId, applePhotoId)` plus unique content hash.
- Product group: deterministic `sha256(sourceAlbumId + ordered source photo IDs)`.
- Workflow instance: `import-<importRunId>` or `publication-<airtablePublicationRunId>`; Cloudflare custom Workflow IDs do not allow colons.
- Publication final output: Airtable Publication Run ID.
- LINE webhook: LINE event ID.
- LINE confirmation: random one-time token stored in D1.

## Repository File Map

```text
.
├── package.json
├── package-lock.json
├── tsconfig.json
├── vitest.config.ts
├── wrangler.jsonc
├── migrations/
│   ├── 0001_initial.sql
│   ├── 0002_import_run_terminal_details.sql
│   ├── 0003_line_inventory.sql
│   ├── 0003_publication.sql
│   ├── 0004_line_recovery.sql
│   └── 0005_usage_metrics.sql
├── src/
│   ├── index.ts
│   ├── env.ts
│   ├── config.ts
│   ├── router.ts
│   ├── scheduled.ts
│   ├── shared/
│   │   ├── admin-auth.ts
│   │   ├── errors.ts
│   │   ├── http.ts
│   │   ├── ids.ts
│   │   ├── logger.ts
│   │   └── time.ts
│   ├── db/
│   │   ├── audit.ts
│   │   ├── import-repository.ts
│   │   ├── line-repository.ts
│   │   ├── publication-repository.ts
│   │   ├── sequence-repository.ts
│   │   └── usage-repository.ts
│   ├── icloud/
│   │   ├── types.ts
│   │   ├── token.ts
│   │   ├── client.ts
│   │   └── phase-zero-probe.ts
│   ├── import/
│   │   ├── types.ts
│   │   ├── marker.ts
│   │   ├── grouping.ts
│   │   ├── asset-store.ts
│   │   ├── airtable-products.ts
│   │   ├── notify.ts
│   │   ├── service.ts
│   │   └── workflow.ts
│   ├── publication/
│   │   ├── types.ts
│   │   ├── airtable-runs.ts
│   │   ├── validator.ts
│   │   ├── collage.ts
│   │   ├── captions.ts
│   │   ├── google-auth.ts
│   │   ├── google-docs.ts
│   │   ├── service.ts
│   │   ├── trigger.ts
│   │   └── workflow.ts
│   ├── line/
│   │   ├── types.ts
│   │   ├── signature.ts
│   │   ├── parser.ts
│   │   ├── client.ts
│   │   ├── airtable-inventory.ts
│   │   ├── messages.ts
│   │   ├── search.ts
│   │   ├── soldout.ts
│   │   ├── revert.ts
│   │   └── webhook.ts
│   ├── monitoring/
│   │   └── usage-report.ts
│   └── routes/
│       ├── assets.ts
│       ├── docs.ts
│       ├── health.ts
│       ├── line.ts
│       ├── setup.ts
│       ├── upload.ts
│       └── usage.ts
├── scripts/
│   ├── generate-marker.ts
│   ├── run-phase-zero.ts
│   ├── smoke-test.ts
│   ├── verify-airtable-schema.ts
│   └── write-phase-zero-report.ts
├── test/
│   ├── apply-migrations.ts
│   ├── config.test.ts
│   ├── router.test.ts
│   ├── scheduled.test.ts
│   ├── smoke.test.ts
│   ├── helpers/
│   │   ├── env.ts
│   │   ├── fakes.ts
│   │   ├── fixtures.ts
│   │   ├── import-fixtures.ts
│   │   └── workflow-step.ts
│   ├── shared/
│   │   ├── admin-auth.test.ts
│   │   ├── errors.test.ts
│   │   ├── http.test.ts
│   │   ├── ids.test.ts
│   │   ├── logger.test.ts
│   │   └── time.test.ts
│   ├── db/
│   │   ├── audit.test.ts
│   │   ├── import-repository.test.ts
│   │   ├── line-repository.test.ts
│   │   ├── migrations.test.ts
│   │   ├── publication-repository.test.ts
│   │   ├── sequence-repository.test.ts
│   │   └── usage-repository.test.ts
│   ├── icloud/
│   │   ├── album-rotation.test.ts
│   │   ├── client.test.ts
│   │   ├── phase-zero-probe.test.ts
│   │   ├── redaction-audit.test.ts
│   │   ├── streaming-feasibility.test.ts
│   │   └── token.test.ts
│   ├── import/
│   │   ├── fixtures/
│   │   │   ├── marker-clean.jpg
│   │   │   ├── non-marker.jpg
│   │   │   └── wrong-payload.jpg
│   │   ├── airtable-products.test.ts
│   │   ├── asset-store.test.ts
│   │   ├── grouping.test.ts
│   │   ├── marker.test.ts
│   │   ├── notify.test.ts
│   │   ├── service.test.ts
│   │   └── workflow.test.ts
│   ├── publication/
│   │   ├── airtable-runs.test.ts
│   │   ├── captions.test.ts
│   │   ├── collage.test.ts
│   │   ├── google-auth.test.ts
│   │   ├── google-docs.test.ts
│   │   ├── service.test.ts
│   │   ├── trigger.test.ts
│   │   ├── validator.test.ts
│   │   └── workflow.test.ts
│   ├── line/
│   │   ├── airtable-inventory.test.ts
│   │   ├── client.test.ts
│   │   ├── messages.test.ts
│   │   ├── parser.test.ts
│   │   ├── publication-messages.test.ts
│   │   ├── revert.test.ts
│   │   ├── search.test.ts
│   │   ├── signature.test.ts
│   │   ├── soldout.test.ts
│   │   ├── types.test.ts
│   │   └── webhook.test.ts
│   ├── monitoring/
│   │   └── usage-report.test.ts
│   ├── routes/
│   │   ├── assets.test.ts
│   │   ├── docs.test.ts
│   │   ├── health.test.ts
│   │   ├── line.test.ts
│   │   ├── setup.test.ts
│   │   ├── upload.test.ts
│   │   └── usage.test.ts
│   ├── scripts/
│   │   ├── generate-marker.test.ts
│   │   ├── run-phase-zero.test.ts
│   │   └── write-phase-zero-report.test.ts
│   └── acceptance/
│       ├── import-acceptance.test.ts
│       ├── import-batches.test.ts
│       ├── line-acceptance.test.ts
│       ├── publication.test.ts
│       ├── retry-exhaustion.test.ts
│       └── smoke.test.ts
└── docs/
    ├── superpowers/
    │   ├── specs/
    │   │   └── 2026-09-01-snazzy-automation-design.md
    │   └── plans/
    │       ├── 2026-09-01-snazzy-automation-implementation-index.md
    │       ├── 2026-09-01-snazzy-foundation-icloud-feasibility.md
    │       ├── 2026-09-01-snazzy-import-pipeline.md
    │       ├── 2026-09-01-snazzy-publication-pipeline.md
    │       ├── 2026-09-01-snazzy-line-inventory.md
    │       └── 2026-09-01-snazzy-hardening-handoff.md
    ├── feasibility/
    │   ├── icloud-phase-0-result.json
    │   └── icloud-phase-0-report.md
    └── runbooks/
        ├── album-rotation.md
        ├── collage-base-1080.jpg
        ├── credential-rotation.md
        ├── deployment.md
        ├── handoff-acceptance.md
        ├── marker-card.svg
        └── operations.md
```

## Cross-Plan Interfaces

### Environment

`src/env.ts` defines bindings once; all plans extend this file without renaming existing members. `PUBLIC_BASE_URL` remains a validated non-secret member of `APP_CONFIG_JSON` (`AppConfig.publicBaseUrl`), not a duplicate top-level binding.

```ts
import type { Workflow } from "cloudflare:workers";

export interface Env {
  DB: D1Database;
  IMAGES_BUCKET: R2Bucket;
  IMAGES: ImagesBinding;
  IMPORT_WORKFLOW: Workflow<ImportWorkflowParams>;
  PUBLICATION_WORKFLOW: Workflow<PublicationWorkflowParams>;
  AIRTABLE_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  ANTHROPIC_API_KEY: string;
  ICLOUD_SHARED_ALBUM_TOKEN: string;
  ASSET_URL_SIGNING_SECRET: string;
  ADMIN_ROUTE_TOKEN: string;
  APP_CONFIG_JSON: string;
}
```

### Import contracts

`src/icloud/types.ts`:

```ts
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
export function deriveSourceAlbumId(token: string): Promise<string>;
export function createICloudClient(token: string, fetcher: Fetcher): ImageSource;
```

`src/import/types.ts`:

```ts
export interface ImportWorkflowParams { importRunId: string; sourceAlbumId: string; trigger: "cron" | "line" | "admin"; }
export type ProductGroupState = "pending" | "importing" | "succeeded" | "failed";
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

export interface AirtableProductPayload {
  productId: string;
  systemGroupId: string;
  uploadDate: string;
  productImages: Array<{
    url: string;
    filename: string;
  }>;
}
```

`AirtableProductPayload.productImages[].url` is temporary and exists only for Airtable attachment ingestion. `filename` is the stable private R2 basename preserved by Airtable when staff reorder attachments; publication validates it and reconstructs `assets/<filename>`.

### Publication contracts

`src/publication/types.ts`:

```ts
export interface PublicationWorkflowParams { publicationRunId: string; trigger: "cron" | "line" | "admin"; }
export interface PublicationProduct {
  airtableRecordId: string;
  productId: string;
  /** Staff-ordered private R2 keys reconstructed as assets/<attachment filename>; never Airtable URLs. */
  orderedImageKeys: string[];
  brandName: string;
  modelName: string;
  conditionType: string;
  size: string;
  description: string;
  lineSquarePrice: number;
  igPrice: number;
}
export interface CaptionSet { productId: string; drafts: [string, string, string]; }
export interface PublicationResult { publicationRunId: string; googleDocId: string; googleDocUrl: string; productIds: string[]; }
```

### LINE contracts

`src/line/types.ts`:

```ts
export type ParsedCommand =
  | { type: "help" }
  | { type: "search"; productId: string }
  | { type: "upload" }
  | { type: "docs" }
  | { type: "soldout"; productId: string; soldPrice: number }
  | { type: "revert" };

export interface LineActor { userId: string; displayName: string; groupId: string; }
export interface SaleValues { inventoryStatus: "In" | "Out"; soldPrice: number | null; soldAt: string | null; soldBy: string | null; }
```

`Sold By` stores stable LINE user ID plus current display name as `"<display name> (<user ID>)"`. With confirmation enabled, actor is Approve-button user; otherwise actor is `/soldout` sender.

## Approved-Spec Coverage Matrix

This matrix is the final coverage check against `docs/superpowers/specs/2026-09-01-snazzy-automation-design.md`. Sections 1–3 define scope and non-goals rather than standalone code; every later requirement maps to concrete tasks and runnable proof.

| Approved spec section | Implemented by | Runnable or review proof |
|---|---|---|
| §§1–3 Executive summary, goals, non-goals | This index plus every plan's Goal and Global Constraints | Full file-map review and `npm run check`; no local daemon, VPS, Redis, Postgres, n8n, Make, AI grouping, or automatic social posting appears in any task. |
| §4 Operating assumptions | Foundation Tasks 1, 7; Import Task 0; Hardening Tasks 10–16 | Config tests, staging/production bindings, deployment and handoff checklists. |
| §5 System boundaries | Foundation Tasks 1, 7; Import Tasks 6–7, 14–15; Publication Tasks 1, 4A, 10; LINE Task 10 | Worker route tests, Workflow tests, D1 migration tests, private asset-route tests. |
| §6 Cloudflare components | Import Tasks 1, 6–8, 14–15; Publication Tasks 1, 4, 4A, 10; LINE Tasks 2, 10; Hardening Tasks 1, 8–10 | D1, R2, Images, Workflow, cron, route, and usage endpoint focused tests. |
| §7 iCloud feasibility gate | Foundation Tasks 8–17 | Phase 0 JSON/report, redaction audit, 100–500 image streaming harness, transient-recovery gate, album-rotation rehearsal, hard stop on any failed gate. |
| §8 Import workflow | Import Tasks 1–16 | Import unit tests plus `test/acceptance/import-acceptance.test.ts` and `test/acceptance/import-batches.test.ts`. |
| §9 Airtable model and ownership | Import Task 9; Publication Task 2; LINE Task 6; Hardening Task 7 | Airtable payload tests and setup schema validator covering every system-, human-, and computed field. |
| §10 Publication workflow | Publication Tasks 1–11; Hardening Tasks 2, 6 | Publication unit/Workflow tests and seven-case publication acceptance suite, including one-document and exhausted-cleanup invariants. |
| §11 LINE command system | LINE Tasks 1–11 | Signature-before-parse, allowlist, parser, confirmation, sold-out, revert, dedupe, and thirty-case acceptance tests. |
| §12 Idempotency and consistency | Import Tasks 1–4, 6, 12–15; Publication Tasks 1, 7, 9–10; LINE Tasks 2, 8–10 | D1 uniqueness/state tests, atomic R2 conditional write, Drive `appProperties` recovery, one-time LINE tokens, duplicate-trigger acceptance cases. |
| §13 Error handling and LINE logs | Foundation Tasks 4–6; Import Tasks 10–14; Publication Tasks 2, 5–10; LINE Tasks 5, 7–10; Hardening Tasks 4, 6 | Retryable/permanent error classification, six-attempt Workflow tests, sibling isolation, Thai success/failure logs, cleanup only after exhaustion. |
| §14 Security | Foundation Tasks 7, 12; Import Tasks 6–7, 15; LINE Tasks 3, 10; Hardening Tasks 3, 7, 10, 14 | Secret-redaction audit, HMAC signatures, constant-time admin bearer checks, auth-before-I/O tests, customer-owned secrets and credential-rotation rehearsal. |
| §15 Deployment and configuration | Foundation Tasks 1, 7; Import Tasks 0, 15; Publication Tasks 2, 10; LINE Task 1; Hardening Tasks 7, 9–16 | Exact `wrangler.jsonc` environments, cron bindings, migrations, setup verification, deploy/smoke commands, runbooks, fresh-account rehearsal. |
| §16 Monitoring | Hardening Tasks 1–3, 8–9, 15–16 | Usage repository, authenticated `/usage`, daily budget alarm, health/smoke checks, full handoff acceptance. |
| §17 Cost model | Hardening Tasks 1–2, 8–9 | Claude token and newly retained R2-byte metrics, monthly cost calculation tests, threshold notification tests. |
| §18 Test strategy | Foundation Tasks 12–17; Import Task 16; Publication Task 11; LINE Task 11; Hardening Tasks 4–6, 15–16 | Focused tests, acceptance suites, production-sized batches, retry exhaustion, smoke test, and final `npm run check`. |
| §19 Delivery plan | Plan Order and Stop Gates in this index; all five implementation plans; Hardening Tasks 10–16 | Phase 0 blocks deployment; each task ends with focused checks, full check, and commit; final handoff checklist gates production acceptance. |
| §20 Final decisions | Fixed Low-Level Decisions and Cross-Plan Interfaces in this index | Exact migration order, IDs, marker payload, Bangkok-time helpers, workflow states, signed assets, model, and parser contracts are repeated in task interfaces and tests. |

## Plan Completion Definition

Public `/health` reads D1 import/sequence state on every request. Its Airtable drift probe uses one filtered request capped at one record, with a 30-second single-flight cache (including unavailable results) per Worker isolate. Sequence/configuration/credential changes invalidate the cache. Airtable edits or recovery can take up to 30 seconds to appear; cold or distinct isolates each make their own bounded request, so this is not a global rate limiter. Authenticated setup/bootstrap retain the complete Product ID scan.

Suite is complete only when:

- Phase 0 report passes every iCloud gate.
- `npm run check` passes.
- D1 migrations apply to fresh local, staging, and production databases.
- Ten production-sized import batches meet acceptance criteria.
- Publication tests prove missing-data block and one-final-document invariant.
- Authenticated `/usage` returns a validated monthly cost report and rejects missing or incorrect bearer tokens.
- Thirty LINE parser/command cases pass.
- Fresh customer-owned deployment succeeds from runbook.
- One credential rotation succeeds without code changes.

## Source References

- Cloudflare Workflows API: https://developers.cloudflare.com/workflows/build/workers-api/
- Cloudflare Workflow rules: https://developers.cloudflare.com/workflows/build/rules-of-workflows/
- Cloudflare Images binding: https://developers.cloudflare.com/images/transform-images/bindings/
- Cloudflare Vitest integration: https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/
- Anthropic TypeScript SDK: https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript
