# Standalone Settings Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separate protected settings website backed by the existing D1 database, with multiple LINE groups and manual-only operation.

**Architecture:** The new `apps/settings` Worker serves a React website and authenticated same-origin API. Its server uses a private `SettingsService` RPC entrypoint on the automation Worker, which owns settings validation, D1 persistence, and provider credentials. A staged bootstrap/cutover preserves the live configuration and binds each accepted operation to a non-secret settings snapshot and originating group.

**Tech Stack:** TypeScript, existing Cloudflare Workers/D1/Workflows, Zod, React, Vite, Tailwind, suitable shadcn primitives, Vitest, React Testing Library, and `jose` for Access JWT verification. No integration into the old admin app.

**Spec:** `docs/superpowers/specs/2026-11-11-settings-console-design.md` (owner approved 2026-11-11).

## Global Constraints

- Staging first; no production deployment or existing admin-site changes.
- English labels; Airtable-inspired dark UI; no decorative dashboard or scheduling controls.
- Secrets stay in Worker secrets, never D1 settings, workflow snapshots, exports, browser responses, or logs.
- Clients access the new Settings website only; old monitoring/recovery stays owner-only.
- One Airtable base. Connection changes are permitted after imports with warning and acknowledgement, without migration, sequence resets, or deduplication resets.
- At least one allowed LINE group; results and delayed messages go only to the originating group.
- Seed captions off and both retry limits at their actual effective values (currently zero); support only 0 or 5 retries.
- No settings editor attribution/history. Revision and update time support concurrency, not auditing.
- Remove all staging cron triggers and scheduled side effects. Preserve manual commands and durable inventory recovery.
- Respect the existing 0009 image-preparation migration and deployed image behavior; do not deploy the older root baseline.
- Each task follows red/green verification and ends in a focused commit. Do not commit unrelated existing working changes.

## Review Focus

1. Two tabs editing the same revision: reject the second save without losing either draft or silently overwriting fields (Tasks 2, 7).
2. Base changes while a confirmation or document candidate exists: preserve the operation's original target and never redirect a saved candidate (Tasks 4–5).
3. Removed LINE group with already accepted work: reject new events but finish accepted work only to its recorded origin (Task 5).
4. Forged Access headers or an old-admin JWT: reject wrong signature/audience/issuer/expiry before calling the settings service (Task 6).
5. Partial rollout or D1 outage: fail explicitly in D1 mode; never restore stale legacy settings or scheduled side effects (Tasks 3, 8–9).

## Delivery order and file map

This is one coordinated plan because the website, routing, and migration share the settings/context contract. Backend tasks precede the site; no remote cutover occurs until the complete local slice passes.

- `src/settings/schema.ts`: pure data schemas/types and section field ownership; browser-safe, no Worker/credential imports.
- `src/settings/runtime.ts`: compose settings with fixed/deployment values and load execution snapshots.
- `src/db/settings-repository.ts`: singleton settings reads, initialization, conditional updates.
- `src/settings/validation.ts`, `src/settings/service.ts`: candidate provider checks and save/export use cases.
- `src/settings/entrypoint.ts`: private RPC adapter; exported from `src/index.ts`.
- `src/routes/settings-bootstrap.ts`: existing-admin-bearer-protected, one-time live configuration initialization.
- `src/db/execution-context-repository.ts`: persisted import/publication/pending-confirmation context handling.
- `migrations/0010_app_settings.sql`, `migrations/0011_settings_execution_contexts.sql`: additive tables/columns, after shipped 0009.
- Existing configuration consumers, triggers, workflow payloads, and LINE recovery files: use the shared runtime/context contracts below.
- `apps/settings/`: independent package, static frontend, Worker API, Access verification, tests, and deployment configuration. No provider secrets or direct D1 binding.
- `docs/runbooks/settings-console.md`: bootstrap, cutover, exports, Access, verification, and rollback.

## Shared interfaces

Define these in Task 1; subsequent tasks use exactly these names:

- `SettingsSection = 'connections' | 'line' | 'import' | 'documents' | 'advanced'`.
- `StoredSettings`: strict uppercase schema covering the spec's D1 fields, including `PRODUCT_ID_INITIAL_NUMBER`; excludes cron fields, `UPLOAD_CUTOFF_MINUTES`, secrets, and deployment-owned information.
- `RuntimeSettings`: camel-case operational settings plus fixed `timeZone: 'Asia/Bangkok'`, `productIdPrefix: 'A'`, `claudeModel: 'claude-opus-5'`, and deployment `publicBaseUrl`; uses `lineAllowedGroupIds: string[]`, without a singular destination or cron fields.
- `SettingsRecord = { schemaVersion: 1; revision: number; updatedAt: string; settings: StoredSettings }`.
- `SettingsSnapshot = { schemaVersion: 1; revision: number; config: RuntimeSettings }`.
- `OperationContext = { settings: SettingsSnapshot; replyGroupId: string | null }`.
- `SaveSectionRequest = { expectedRevision: number; section: SettingsSection; changes: Record<string, unknown>; acknowledgeAirtableChange?: boolean }`; parse with strict section-specific schemas.
- `ConnectionTestRequest = { expectedRevision: number; connection: 'airtable' | 'google' | 'line'; changes: Record<string, unknown> }`; candidate values only within that connection's permitted fields.
- `SettingsView = { record: SettingsRecord; deployment: { environment: string; publicBaseUrl: string; googleOAuthClientId: string; schedulingEnabled: false } }`; fixed runtime values are shown read-only.
- `SettingsErrorCode = 'invalid_settings' | 'revision_conflict' | 'confirmation_required' | 'connection_validation_failed' | 'settings_unavailable' | 'provider_unavailable' | 'internal_error'`.
- `SettingsResult<T> = { ok: true; value: T } | { ok: false; code: SettingsErrorCode; fieldErrors?: Record<string, string> }`. No raw exception/body or identity in this result.
- `ConfigurationExport = { schemaVersion: 1; environment: string; revision: number; exportedAt: string; settings: StoredSettings; deployment: SettingsView['deployment'] }`.

Exact section ownership: Connections owns the three Airtable and two Google IDs; LINE owns allowed groups and soldout confirmation; Import owns cutoff and import retries; Documents owns captions and publication retries; Advanced owns token limit, budget, exchange rate, and three cost rates. Initial product number is seeded and read-only in this first UI; preserve the existing operator bootstrap procedure.

### Task 1: Establish the release baseline and settings contract

**Files:** Create `src/settings/schema.ts`, `test/settings/schema.test.ts`; modify `src/config.ts`, `test/helpers/env.ts` only as required to expose legacy parsing separately. Preserve shipped files/migration 0009 from the current staging baseline.

**Interfaces:** Produce all shared types above; `parseStoredSettings(value: unknown): StoredSettings`, `parseSaveSectionRequest(value: unknown): SaveSectionRequest`, and `normalizeGroupIds(input: string | string[]): string[]`. Retain `parseConfig` solely as the legacy parser until cutover tasks migrate callers.

- [ ] Establish isolated execution using the chosen execution skill. Capture the actual current staging deployment/version before planning a code deployment. Reconstruct the shipped source from `98c79fdf184501fc370e4318ae7ec122dc7daed3` plus `docs/releases/2026-11-11-single-attempt-staging.patch`, then reconcile newer live changes and this approved spec without overwriting unrelated local work. Do not blindly apply that patch to an already patched tree.
- [ ] Record baseline `npm run typecheck` and `npm test -- --exclude '**/.worktrees/**'` results. The known release had 28 failures in five files documented in the operations runbook; establish the current baseline instead of assuming that count still applies.
- [ ] Write schema tests: comma/newline input `' C1, C2\nC1 '` becomes `['C1','C2']`; an empty-only group list, secret/unknown keys, invalid timestamps, fractional retries, retry limit 1, and token limit 150001 fail; null cutoff and retry limits 0/5 succeed. Resolve delimiter whitespace without accepting an empty group ID as an entry.
- [ ] Run `npm test -- test/settings/schema.test.ts --exclude '**/.worktrees/**'`; expect failure before implementation.
- [ ] Implement the pure schemas using installed Zod. Apply the spec's exact numeric/fixed constraints; do not add free-form model/timezone/prefix editing.
- [ ] Repeat that test and typecheck; expect pass. Commit the reconciled baseline separately from the contract if needed, documenting provenance, then commit the tested contract.

### Task 2: Add singleton D1 persistence and atomic section saves

**Files:** Create `migrations/0010_app_settings.sql`, `src/db/settings-repository.ts`, `src/settings/service.ts`, `test/db/settings-repository.test.ts`, `test/settings/service.test.ts`; modify `test/db/migrations.test.ts` and fixtures as needed.

**Interfaces:** `readSettings(db): Promise<SettingsRecord | null>`; `initializeSettings(db, settings, now): Promise<SettingsRecord>`; `compareAndSetSettings(db, expectedRevision, candidate, now): Promise<SettingsRecord | null>`. Service `saveSettingsSection(env, request, now): Promise<SettingsResult<SettingsView>>`, with candidate checks supplied by Task 3. Initialization is insert-if-absent, never overwrite.

- [ ] Write tests proving singleton revision starts at 1; repeat initialization preserves it; updating revision 1 succeeds once and advances to 2; a second revision-1 save conflicts. Assert unaffected fields and all inventory/sequence tables remain unchanged.
- [ ] Add tests rejecting connection changes without acknowledgement even with existing products, allowing validated acknowledged changes without copying/deleting/resetting data, and rejecting read-only field changes. Exercise no-op edits without demanding a connection-change acknowledgement.
- [ ] Run `npm test -- test/db/settings-repository.test.ts test/settings/service.test.ts --exclude '**/.worktrees/**'`; expect fail.
- [ ] Add `app_settings` with singleton ID, schema version, JSON settings, revision, and update time only. Merge only whitelisted section fields into the latest complete document; validate it before a revision-conditional update. Check affected-row count to detect races. Do not insert settings audit records.
- [ ] Run the tests, migration tests, and typecheck; expect pass. Commit persistence and save semantics.

### Task 3: Add read-only provider checks, export, and private bootstrap/RPC

**Files:** Create `src/settings/validation.ts`, `src/settings/entrypoint.ts`, `src/routes/settings-bootstrap.ts`, `test/settings/validation.test.ts`, `test/settings/entrypoint.test.ts`, `test/routes/settings-bootstrap.test.ts`; modify `src/settings/service.ts`, `src/index.ts`, `src/router.ts`, `src/env.ts`.

**Interfaces:** `validateSettingsConnections(env, current, candidate, changedKeys): Promise<SettingsResult<void>>`; `getSettingsView(env): Promise<SettingsResult<SettingsView>>`; `testSettingsConnection(env, request): Promise<SettingsResult<{ connection: ConnectionTestRequest['connection']; status: 'passed' }>>`; `exportSettings(env, now): Promise<SettingsResult<ConfigurationExport>>`.

`SettingsService extends WorkerEntrypoint<Env>` exposes `get()`, `saveSection(request)`, `testConnection(request)`, and `exportConfiguration()`, forwarding the corresponding typed results. It exposes no generic fetch proxy, SQL, arbitrary provider URL, or credential method. Bootstrap is **not** a client RPC method.

- [ ] Write tests: candidate Airtable table/schema checks use candidate IDs; Google folder/template checks and LINE group checks are read-only; enabling captions checks the supported Claude model/credential; editing a cost field succeeds while unrelated Google access is down; provider failure leaves the old revision unchanged.
- [ ] Assert provider mocks receive no create/delete/document-generation/message-send calls. Return fixed safe errors even if an upstream body contains a sentinel secret. Export contains only saved values and metadata, never drafts or credentials.
- [ ] Bootstrap tests: `POST /setup/settings-bootstrap` requires the existing admin bearer token; it reads the actual live `APP_CONFIG_JSON` and effective `WORKFLOW_RETRY_LIMIT`, maps the singular LINE group, preserves current values, seeds once, and never returns secrets. Missing/invalid legacy config leaves D1 untouched. A second call returns the existing record.
- [ ] Run those tests before implementing; expect fail. Implement with existing provider clients/probes, separating read-only checks from `/setup`'s disposable-document rehearsal. Validate opaque IDs and construct provider URLs from fixed endpoints, not arbitrary browser URLs.
- [ ] Add explicit deployment-only `CONFIGURATION_MODE: 'legacy' | 'maintenance' | 'd1'`: bridge legacy mode retains old operational readers, maintenance refuses new manual admissions, and D1 mode has no missing-row fallback. Settings RPC is unavailable before D1 cutover. This is rollout control, not a client setting.
- [ ] Export the private RPC class from `src/index.ts`; do not add public settings CRUD routes to the automation Worker. Add only the bearer-protected bootstrap route. Test unauthorized requests and all RPC request schemas; repeat tests/typecheck, then commit.

### Task 4: Persist execution settings and migrate runtime readers

**Files:** Create `migrations/0011_settings_execution_contexts.sql`, `src/settings/runtime.ts`, `src/db/execution-context-repository.ts`, `test/settings/runtime.test.ts`, `test/db/execution-context-repository.test.ts`; modify `src/config.ts`, `src/env.ts`, `src/import/types.ts`, `src/publication/types.ts`, `src/db/publication-repository.ts`, `src/db/line-repository.ts`, `src/line/types.ts`, `src/line/mutation-recovery.ts` and associated tests.

**Interfaces:** `loadSettingsSnapshot(env): Promise<SettingsSnapshot>`; `toRuntimeSettings(settings: StoredSettings, publicBaseUrl: string): RuntimeSettings`. Add optional `context?: OperationContext` to durable import/publication/LINE/follow-up payloads for old-payload compatibility; new admissions always supply it. Persist `settings_context_json` on `import_runs`, `publication_jobs`, and `pending_line_commands` using validated serialization, without credentials.

- [ ] Write tests: D1 mode missing/corrupt/unavailable row fails `settings_unavailable` even when valid legacy JSON exists; an explicit legacy bridge works; a persisted snapshot survives a settings edit and uses its original base, retry limit, and public origin.
- [ ] Add publication restart tests: no temp/finalization work permits a terminal run's next manual attempt to replace its context; existing temp/finalization work keeps its original context. A competing active attempt cannot overwrite it. Pending confirmations and their follow-ups retain the context captured at creation, even if the confirming event has newer settings.
- [ ] Run the new tests before code. Add nullable columns without changing historical rows or resetting sequence/cache/deduplication tables. Provide `readImportContext(db: D1Database, runId: string): Promise<OperationContext | null>`, `saveImportContextIfAbsent(db: D1Database, runId: string, context: OperationContext): Promise<OperationContext>`, `readPublicationContext(db: D1Database, runId: string): Promise<OperationContext | null>`, `savePublicationAttemptContext(db: D1Database, runId: string, generation: number, context: OperationContext): Promise<boolean>`, and `readPendingContext(db: D1Database, token: string): Promise<OperationContext | null>`, with workflow ownership checks and exact-condition updates matching existing locks. Extend pending-command creation to persist its context atomically with the command, not as a later best-effort write.
- [ ] Add `resolveImportContext(env: Env, params: ImportWorkflowParams): Promise<OperationContext>` and `resolvePublicationContext(env: Env, params: PublicationWorkflowParams): Promise<OperationContext>`. At execution start, resolve the authoritative persisted run context in a durable step; an existing instance restart cannot receive new params, so its original payload context must not override the context safely saved by the trigger for the new attempt. Read the saved context once per execution and pass it through descendants. A replay does not reload D1 settings. Test this explicitly using an old payload and a newer terminal-attempt context.
- [ ] Implement context composition and strict parsing. Only a quiescent cutover is supported for legacy null contexts: reject incompatible old pending work with a clear operator error rather than silently sending it to a new target. Drain/resolve those records before rollout; do not delete them.
- [ ] Repeat tests and migration checks; commit. Do not enable D1 mode remotely yet.

### Task 5: Migrate all command/workflow consumers and originating-group delivery

**Files:** Modify `src/routes/line.ts`, `src/line/webhook.ts`, `src/line/command-workflow.ts`, `src/line/mutation-followup-workflow.ts`, `src/routes/upload.ts`, `src/routes/docs.ts`, `src/publication/trigger.ts`, `src/import/workflow.ts`, `src/publication/workflow.ts`, `src/publication/product-images.ts`, `src/routes/setup.ts`, `src/routes/health.ts`, `src/routes/usage.ts`, `src/router.ts`; update their tests and `test/helpers/env.ts`, `test/helpers/workflow-step.ts`, acceptance fixtures.

**Interfaces:** `createWebhookDeps(env, requestId?, context?): Promise<WebhookDeps>`; replace `allowedGroupId` with `allowedGroupIds: string[]`. Add optional final `context?: OperationContext` parameter to `handleUploadTrigger` and `handleDocsTrigger`, preserving other existing arguments. New LINE admissions attach one snapshot and `replyGroupId = event.source.groupId`; operator HTTP admissions use null. Descendant triggers do not reload configuration.

- [ ] Write failure-first integration tests for two allowed groups and one unauthorized group: signature validation precedes admission; A's delayed results never reach B; B's busy response doesn't subscribe it to A; a removed group cannot submit new work, while already accepted work finishes at its original destination.
- [ ] Test soldout/revert cross-group confirmation rejection and delayed mutation warnings using the pending command's group/context, not the current first allowed group. Preserve existing user/product-bound confirmation rules and business audit behavior.
- [ ] Test all consumers of `parseConfig`/`APP_CONFIG_JSON`: setup, health, usage, bootstrap sequence, command recovery, and import/publication/image preparation use loaded settings consistently. Health's existing cache includes revision and preserves credential/sequence invalidation; no global mutable-settings cache is introduced.
- [ ] Test actual retry behavior at 0 and 5, captions off with no Anthropic calls, and HTTP triggers with no unsolicited LINE push. Notification failure leaves successful product/document state intact; log a bounded safe failure without rerunning completed business work.
- [ ] Run the affected tests before implementation; change shared consumers and payload construction once. Ensure every import step explicitly uses the chosen limit rather than Cloudflare defaults, and image-preparation steps use the same snapshot as publication. Route finalization recovery and saved candidates through their persisted original connection.
- [ ] Refresh outdated acceptance fixtures for preserved image preparation and context columns where this feature breaks them; distinguish actual new failures from baseline failures. Preserve the old admin site's API/data contracts. Run all import/publication/LINE/settings tests and typecheck; commit.

### Task 6: Create the independent protected website/API shell

**Files:** Create `apps/settings/package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `postcss.config.mjs`, `wrangler.jsonc`, `index.html`, `worker/index.ts`, `worker/access.ts`, `worker/api.ts`, `src/main.tsx`, `src/app.tsx`, `test/access.test.ts`, `test/api.test.ts`, `vitest.config.ts`, `README.md`.

**Interfaces:** Settings Worker `Env` has `ASSETS`, `SETTINGS_SERVICE` (named RPC binding), `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `SETTINGS_ORIGIN`. No provider secrets or DB binding. `requireAccess(request, env): Promise<void>` validates the signed `Cf-Access-Jwt-Assertion` with configured issuer, audience, expiry, and RS256 keys from the fixed team JWKS URL.

API: GET `/api/settings`; PATCH `/api/settings/sections/:section`; POST `/api/settings/test-connection`; GET `/api/settings/export`. Responses use `SettingsResult` (export downloads JSON). Map invalid inputs to 400, revision/ack conflicts to 409, provider validation to 422, unavailable settings/provider to 503, and unexpected failures to generic 500. Never return upstream bodies.

- [ ] Create signed test JWTs with ephemeral local keys: absent/forged/expired/wrong-audience/wrong-issuer tokens fail before RPC; a genuine token for the configured audience passes. Mock only the fixed-URL JWKS fetch to return the generated public key; do not mock verification away. An old-admin audience cannot authorize this site.
- [ ] API tests reject cross-origin or missing-Origin writes and unknown/secret fields; require JSON for writes, enforce a 32 KiB request-body cap, and assert `Cache-Control: no-store`. Verify section path and body cannot disagree. Unknown `/api/*` paths return JSON 404, never SPA HTML.
- [ ] Run `npm --prefix apps/settings test` before implementing the API; expect failures. Implement signed validation with `jose`, not custom crypto. Cloudflare docs warn Static Assets routing does not pass `ctx.access` through to the user Worker; do not rely only on that field or an unsigned email header.
- [ ] Use React/Vite/Tailwind independently. Existing installed reference versions are React/DOM 19.3.0, Vite 8.3.1, plugin-react 6.1.1, Tailwind/PostCSS 4.3.3, Testing Library 16.3.3, and jsdom 30.1.1; resolve compatibility and lock exact dependencies locally. Use project-compatible Vitest/Workers testing versions; do not upgrade the root suite. Add `jose` as a direct dependency because token verification is a security boundary; lock its resolved compatible version. Do not install an auth framework, router/state library, or new font dependency.
- [ ] Build with Vite; deploy static `dist` plus a plain Worker entrypoint through the project's local Wrangler, avoiding an unnecessary SSR framework/plugin. Configure assets to execute the Worker before serving them, validate Access there, and then delegate static requests to ASSETS. No permissive production auth bypass. Local tests inject verified fixture keys; local UI development uses disposable settings and never remote D1.
- [ ] Name the new Worker `snazzy-settings-staging`, initially `workers_dev: false`, `preview_urls: false`, no custom domain guessed. Bind only the private `SettingsService` on `snazzy-automation-staging`. Exclude the new app from root test discovery; its tests run through its own scripts.
- [ ] Run app tests/typecheck/build and `npx wrangler deploy --dry-run` from `apps/settings`; all must pass. Commit the independent shell/API and its lockfile, without deploying or touching the old admin app.

### Task 7: Implement the usable dark settings interface

**Files:** Create `apps/settings/src/settings/fields.ts`, `api.ts`, `settings-page.tsx`, `section-form.tsx`, `group-list.tsx`, `connection-warning.tsx`, `styles.css`; copy/adapt only needed isolated shadcn primitives into `src/components/ui/`; create `test/settings-page.test.tsx`, `test/group-list.test.tsx`.

**Interfaces:** `getSettings(): Promise<SettingsResult<SettingsView>>`, `saveSection(request)`, and `testConnection(request)` wrap same-origin API requests; no browser RPC or Worker binding. `fields.ts` owns friendly English labels, technical-key aliases, descriptions, section ownership, and form types, matching Task 1 exactly.

- [ ] Write component tests: render persisted fields; search by “template” and `GOOGLE_TEMPLATE_DOC_ID`; show empty search results; change a switch without saving; Save commits only its section; Discard restores saved values; failures preserve drafts; a revision conflict offers Reload without automatic overwrite.
- [ ] Test concurrent drafts in different sections: a successful save updates the known revision without replacing unrelated dirty fields; stale external updates still conflict. Test unsaved navigation/reload protection and accessible field errors/focus/status announcements.
- [ ] Test LINE comma/newline paste, duplicates, add/remove, rejection of removing the final group, and keyboard operation. Test Bangkok date/time ↔ UTC conversion and explicit “No cutoff” null; reject calendar rollover rather than silently normalizing an invalid date.
- [ ] Test connection edits with existing inventory: show old/new IDs, explain no migration/reimport/sequence reset, require acknowledgement, and submit the acknowledged exact candidate. Test connection status remains separate from saved status and is cleared when candidate values change. Export downloads persisted configuration, not unsaved drafts.
- [ ] Run app tests before implementation. Build the spec's five-section UI using local draft state, one explicit Save/Discard pair per section, ordinary semantic form controls and the needed existing component patterns. Show read-only fixed/deployment fields and no credential inputs or cron controls.
- [ ] Use the approved tokens `#181A1F`, `#24272E`, `#3B404A`, `#F1F3F5`, `#B4BBC6`, `#74B3FF`; 8/16/24/32px spacing, approximately 44px hit areas, 216–232px sidebar, roughly 960px content maximum, and English copy. Review one representative screen against the spec before expanding all forms. No inherited admin shell, hero, ornamental animation, or dashboard widgets.
- [ ] Run component tests/typecheck/build; verify narrow widths, long IDs, contrast, focus, and loading/error/saved/dirty states on synthetic data. Commit the UI. Record practical browser evidence during authorized implementation QA; do not claim a mocked save changed D1.

### Task 8: Complete manual-only behavior and migration tools/runbooks

**Files:** Modify `src/scheduled.ts`, `src/index.ts`, `wrangler.jsonc`, `scripts/configure-worker.ts`, `scripts/worker-app-config.ts`, `scripts/staging-setup-check.ts`, `test/scheduled.test.ts`, `test/scripts/configure-staging.test.ts`, `test/routes/setup.test.ts`; create `docs/runbooks/settings-console.md`; update `docs/system/configuration-variables.md`, `docs/runbooks/operations.md`, `docs/runbooks/publication-setup.md`.

**Interfaces:** Final runtime settings have no cron fields or upload-cutoff-minutes placeholder. `handleScheduled` performs no import/publication/budget side effects. The legacy parser remains available only for explicit bridge initialization/rollback, not normal D1-mode reads.

- [ ] Write tests: events for all three old cron expressions and an unknown expression produce no side effects; setup succeeds without cron/cutoff-minutes fields; all ordinary manual triggers still function. Existing durable LINE mutation recovery remains functional.
- [ ] Test configuration-mode admissions: maintenance rejects signed LINE/new HTTP workflow triggers with a retryable 503, without claiming events or allocating products; health/bootstrap remain available; legacy accepted work can drain. In D1 mode, temporary WORKFLOW_RETRY_LIMIT and stale APP_CONFIG_JSON cannot override saved settings.
- [ ] Run tests to observe failure; implement explicit mode handling and `env.staging.triggers.crons: []`. Leave production configuration alone. Remove the temporary retry override from the final D1-mode deployment source.
- [ ] Update the configure helper to refuse legacy-secret regeneration in D1 mode rather than pretending it updates settings. Runbook instructions export first, update fields through the site, preserve secrets, and identify fixed/deployment-only values. Remove advice that a future `AI_CAPTIONS_ENABLED` change requires replacing APP_CONFIG_JSON after cutover.
- [ ] Document bridge/maintenance/D1 operation, actual live seed provenance, settings backup, unsupported inventory migration, and restoring matching legacy code/config without restoring cron jobs. Include Access policy setup and expected audience/issuer/origin inputs; obtain real approved emails and domain/audience values during rollout, never invent them.
- [ ] Run scheduled/setup/configuration tests and both project checks; commit code and operator documentation.

### Task 9: Rehearse and perform the staging cutover

**Files:** Create `test/acceptance/settings-console.test.ts`, `test/helpers/settings-fixtures.ts`; modify acceptance fixture cleanup for the additive settings/context tables; record results in `docs/runbooks/settings-console.md`.

**Interfaces:** End-to-end tests use the actual settings loader/save service and command/workflow paths with controlled provider boundaries. Do not replace the configuration path with a fake that would hide a legacy JSON read.

- [ ] Build a local disposable DB with migration 0009 followed by 0010/0011 and synthetic business state. Rehearse idempotent live-shape seeding, revision conflict, missing D1, connection failure, two groups, pending confirmation across edits, and saved-document recovery across a folder/base edit. Verify every preserved business table and sequence.
- [ ] Run root `npm run typecheck` and full tests excluding `.worktrees`; run app test/typecheck/build and both deploy dry-runs. Compare failures by name with Task 1's baseline; explain new failures and fix them before rollout. Record remaining baseline failures explicitly.
- [ ] Prepare all code, migrations, runbooks, and a concrete deployment diff before any remote rollout approval required by the chosen execution workflow. This plan itself authorizes no live deployment. Do not touch the old admin Worker or its Access policy.
- [ ] After rollout authorization: back up staging D1, deploy additive migrations, and deploy the bootstrap bridge in legacy mode with cron side effects disabled. Keep the settings website unexposed. Bootstrap from the running Worker's real legacy config through the bearer-protected endpoint; verify effective captions/retries/group and obtain the original public origin without logging secrets.
- [ ] Set PUBLIC_BASE_URL as that exact non-secret deployment variable. Enter maintenance mode; verify no active import/publication/LINE/follow-up workflows and no applying or pending confirmations remain. Let work finish or have the owner explicitly resolve it—never delete it to pass the check. Validate no unrecorded temporary/finalization document work will lose its context.
- [ ] Export/retain the seeded non-secret settings, then switch automation to D1 mode and remove the temporary retry override. Check health/setup, zero cron triggers, and absence of admission drops. Keep legacy secrets for rollback; do not rotate credentials or create another database.
- [ ] Deploy the new settings Worker with public access still disabled; attach its own approved-email Access policy and configure its real issuer/audience/origin. Then expose its intended URL, keep preview URLs disabled, and verify signed-out/unapproved/approved requests to pages and every API method. A settings JWT must not unlock the existing owner-only admin site.
- [ ] With owner-authorized staging evidence, test settings save without redeployment, two allowed groups and one unauthorized group, one controlled import/publication, origin-only completion, captions off/one attempt, and configuration export. Do not send messages to third-party groups without explicit authorization. Check the generated document and preserved inventory behavior. End with no synthetic scheduled jobs, open diagnostic streams, or temporary exposure.
- [ ] If a gate fails, keep admissions paused and restore a matching legacy settings/code pair from the actual backup; do not reset D1 or revive cron triggers. Record final deployment IDs, safe checks, remaining baseline failures, and rollback status; commit only the runbook evidence.

## Self-review and execution handoff

Before handing this plan to an implementer, check: every spec section maps to a task; every referenced type is defined above or in that task; all configuration consumers move together; no browser dependency imports provider credentials; no old-admin integration remains; initialization never uses a reconstructed JSON as live truth; accepted work and saved candidates retain original context; all five Review Focus cases have tests; staging rollback keeps cron disabled.

Tasks 1–8 produce reviewable local changes. Task 9 is the explicit staging verification/cutover gate, not permission to deploy now. No implementation or dependency installation has been performed while writing this plan.

References checked while planning:
- [Cloudflare Access and Static Assets context limitations](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#ctxaccess-limitations).
- [Cloudflare Access JWT validation using jose](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
- [Cloudflare cron trigger removal](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
