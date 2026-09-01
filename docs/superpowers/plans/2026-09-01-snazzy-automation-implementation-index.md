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
- Every task ends with focused tests, full test command, and commit.

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
    "dev": "wrangler dev",
    "deploy:staging": "wrangler deploy --env staging",
    "deploy:production": "wrangler deploy --env production",
    "db:migrate:local": "wrangler d1 migrations apply snazzy-automation --local",
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
│   └── 0001_initial.sql
├── src/
│   ├── index.ts                         # Worker fetch/scheduled entrypoint only
│   ├── env.ts                           # Env binding and secret types
│   ├── config.ts                        # Zod configuration parsing
│   ├── router.ts                        # Native method/path dispatch
│   ├── shared/
│   │   ├── errors.ts                    # Typed operational errors and retry class
│   │   ├── http.ts                      # JSON response and safe external fetch helpers
│   │   ├── ids.ts                       # Correlation IDs and SHA-256 helpers
│   │   ├── logger.ts                    # Structured redacted logging
│   │   └── time.ts                      # Bangkok date and expiry functions
│   ├── db/
│   │   ├── audit.ts                     # Append-only audit writes
│   │   ├── import-repository.ts         # Import runs, assets, groups, checkpoint
│   │   ├── line-repository.ts           # Events, pending commands, reversible actions
│   │   ├── publication-repository.ts    # Publication locks and cached outputs
│   │   └── sequence-repository.ts       # Atomic Product ID allocation/bootstrap
│   ├── icloud/
│   │   ├── types.ts                     # Album snapshot/source photo contracts
│   │   ├── token.ts                     # Public token partition derivation
│   │   ├── client.ts                    # Undocumented public-album HTTP adapter
│   │   └── phase-zero-probe.ts          # Feasibility-only probe runner
│   ├── import/
│   │   ├── types.ts                     # Import params, group, result types
│   │   ├── marker.ts                    # QR marker normalization/detection
│   │   ├── grouping.ts                  # Marker-to-marker grouping
│   │   ├── asset-store.ts               # Content-addressed R2 writes/signed URLs
│   │   ├── airtable-products.ts          # Product read/create/delete/verify
│   │   ├── service.ts                   # Testable import orchestration
│   │   └── workflow.ts                  # ImportWorkflow step boundaries
│   ├── publication/
│   │   ├── types.ts                     # Publication/Product/caption contracts
│   │   ├── airtable-runs.ts              # Ready runs, Product fields, status writes
│   │   ├── validator.ts                  # Whole-run completeness validation
│   │   ├── collage.ts                    # Cloudflare Images 2×2 composition
│   │   ├── captions.ts                   # Official Anthropic SDK call and validation
│   │   ├── google-auth.ts                # Service-account JWT with Web Crypto
│   │   ├── google-docs.ts                # Drive copy, Docs batchUpdate, verification
│   │   ├── service.ts                    # Testable publication orchestration
│   │   └── workflow.ts                   # PublicationWorkflow step boundaries
│   ├── line/
│   │   ├── types.ts                      # Webhook and command contracts
│   │   ├── signature.ts                  # HMAC request verification
│   │   ├── parser.ts                     # Command, Product ID, and price grammar
│   │   ├── client.ts                     # Reply/push/flex-message REST client
│   │   ├── messages.ts                   # Thai response builders
│   │   ├── search.ts                     # /search handler
│   │   ├── soldout.ts                    # pending and approval mutation
│   │   ├── revert.ts                     # conflict-safe reverse mutation
│   │   └── webhook.ts                    # deduplication and command routing
│   ├── routes/
│   │   ├── health.ts                     # liveness and dependency readiness
│   │   ├── setup.ts                      # authenticated setup validator
│   │   ├── upload.ts                     # manual ImportWorkflow trigger
│   │   ├── docs.ts                       # manual PublicationWorkflow trigger
│   │   └── line.ts                       # LINE webhook route
│   └── scheduled.ts                      # cron routing by expression
├── scripts/
│   ├── generate-marker.ts                # printable marker HTML/SVG generator
│   ├── run-phase-zero.ts                 # invoke probe and write JSON result
│   └── verify-airtable-schema.ts         # field-ID mapping check
├── test/
│   ├── helpers/
│   │   ├── env.ts                        # typed test environment
│   │   ├── fixtures.ts                   # explicit external payload fixtures
│   │   └── fakes.ts                      # fetch/client fakes
│   ├── shared/
│   ├── icloud/
│   ├── import/
│   ├── publication/
│   ├── line/
│   └── acceptance/
└── docs/
    ├── feasibility/
    │   └── icloud-phase-0-report.md
    └── runbooks/
        ├── deployment.md
        ├── operations.md
        ├── album-rotation.md
        └── credential-rotation.md
```

## Cross-Plan Interfaces

### Environment

`src/env.ts` defines bindings once; all plans extend this file without renaming existing members.

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
```

### Publication contracts

`src/publication/types.ts`:

```ts
export interface PublicationWorkflowParams { publicationRunId: string; trigger: "cron" | "line" | "admin"; }
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

## Plan Completion Definition

Suite is complete only when:

- Phase 0 report passes every iCloud gate.
- `npm run check` passes.
- D1 migrations apply to fresh local, staging, and production databases.
- Ten production-sized import batches meet acceptance criteria.
- Publication tests prove missing-data block and one-final-document invariant.
- Thirty LINE parser/command cases pass.
- Fresh customer-owned deployment succeeds from runbook.
- One credential rotation succeeds without code changes.

## Source References

- Cloudflare Workflows API: https://developers.cloudflare.com/workflows/build/workers-api/
- Cloudflare Workflow rules: https://developers.cloudflare.com/workflows/build/rules-of-workflows/
- Cloudflare Images binding: https://developers.cloudflare.com/images/transform-images/bindings/
- Cloudflare Vitest integration: https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/
- Anthropic TypeScript SDK: https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript
