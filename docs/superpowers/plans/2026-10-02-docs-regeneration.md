# Docs Regeneration Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` for native execution or `superpowers:subagent-driven-development` if the user selects delegated execution. Complete tasks in order and track steps below.

**Goal:** Regenerate a previously successful publication when the user sets its existing Airtable row to Ready and sends `/docs`, preserving previous Docs and producing versioned replacements.

**Architecture:** Extend the existing publication job with generation counters and a recoverable finalization intent. Keep one job/date owner and the existing fingerprinted caches; give each generation its own Workflow and Google temporary-copy identity. Reuse the current generation pipeline, with generation ownership checked at every state-changing stage.

**Tech Stack:** TypeScript, Cloudflare Workers/Workflows, D1, R2/Images, Airtable REST, Google Drive/Docs REST, existing Vitest infrastructure. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-02-docs-regeneration-design.md`

## Global Constraints

- Work on `feat/docs-regeneration`; preserve unrelated workspace edits.
- One Publication Runs row per date; retain the existing D1 date ownership constraint.
- Regeneration requires LINE `/docs` and Ready; no extra confirmation.
- Cron and existing administrative triggers never allocate or restart a replacement for a run with a previous successful Doc.
- `/docs` still selects today's Bangkok date; no new date-selection command.
- Original title: `Publication YYYY-MM-DD`. Replacement titles: `Publication YYYY-MM-DD (v2)`, `(v3)`, etc.
- A failed revision retries the same version. Increment only when a successful run is explicitly reopened.
- Preserve old successful Docs and the last successful references throughout replacement preparation.
- Preserve PR #7's output formatting and legacy generation-1 compatibility.
- No live regeneration, remote migration, deployment, or PR merge during implementation without the applicable user authorization.
- The session's testing constraint takes precedence over skill defaults: the test additions/runs listed below require the user's approval of this validation plan.

## Review Focus

1. Two simultaneous Ready + `/docs` requests must allocate one revision and one Workflow (Task 1/2 concurrency checks).
2. A previous successful run changed to Failed/Ready must not be restarted by cron (Task 2 trigger checks).
3. A lost Airtable publish response must never cause deletion of the newly linked Doc (Task 4 reconciliation checks).
4. An old Workflow invoked after the next revision starts must not change job state, publish, or clean up that revision (Task 3/4 stale-owner checks).
5. A retry with finalization already prepared must publish its saved snapshot, even if Products were edited meanwhile (Task 4/5 recovery checks).

## File responsibilities

| Files | Responsibility |
|---|---|
| `migrations/0006_publication_generations.sql` | Backward-compatible generation and finalization metadata |
| `src/db/publication-repository.ts` | Atomic allocation, generation-fenced mutations, successful-result persistence |
| `src/publication/types.ts` | Shared generation identity and Workflow payload |
| `src/publication/airtable-runs.ts` | Date lookup without premature product loading; latest-link reconciliation |
| `src/publication/trigger.ts` | Manual-only allocation and current-generation Workflow lifecycle |
| `src/line/search.ts` | User-facing regeneration/version replies |
| `src/publication/service.ts` | Versioned copies, stage ownership, finalization intent, safe cleanup |
| `src/publication/workflow.ts` | Generation-aware orchestration and pending-finalization recovery |
| Existing tests in `test/db`, `test/publication`, `test/line`, `test/acceptance` | Pin migration, concurrency, compatibility, failure, and output behavior |
| `docs/runbooks/publication-setup.md`, `docs/runbooks/operations.md` | Operator instructions and rollout order |

## Task 1: Persist and atomically allocate generations

**Files:** Create `migrations/0006_publication_generations.sql`; modify `src/db/publication-repository.ts`, `src/publication/types.ts`, `test/db/publication-repository.test.ts`, `test/db/migrations.test.ts`.

**Interfaces produced:**

```ts
export interface PublicationWorkflowParams {
  publicationRunId: string;
  trigger: "cron" | "line" | "admin";
  generation?: number; // An omitted generation means legacy generation 1.
}
export function publicationWorkflowId(runId: string, generation: number): string;
// Extend PublicationJobRow: generation: number; successfulGeneration: number;
// finalizationJson: string | null.
export async function reopenSuccessfulJobForRegeneration(
  db: D1Database, clock: Clock, runId: string, expectedGeneration: number,
): Promise<PublicationJobRow | null>;
```

- [ ] Add migration-default and competing-allocation assertions to the existing repository/migration tests. Seed a successful v1 job with an old Doc and a date claim; race two allocation calls; assert one winner, generation 2, old Doc preserved, date unchanged, temporary copy cleared.

```ts
const results = await Promise.all([
  reopenSuccessfulJobForRegeneration(db, clock, runId, 1),
  reopenSuccessfulJobForRegeneration(db, clock, runId, 1),
]);
expect(results.filter(Boolean)).toHaveLength(1);
expect(results.find(Boolean)).toMatchObject({
  generation: 2, successfulGeneration: 1, state: "locked",
  googleDocId: "old-doc", tempDocId: null,
});
```

- [ ] Run the existing targeted tests before implementation and establish the expected failure: missing generation metadata/allocation function.

```bash
npm test -- test/db/publication-repository.test.ts test/db/migrations.test.ts
```

- [ ] Add these fields and backfill existing successful references:

```sql
ALTER TABLE publication_jobs ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE publication_jobs ADD COLUMN successful_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publication_jobs ADD COLUMN finalization_json TEXT;
UPDATE publication_jobs SET successful_generation = 1
WHERE google_doc_id IS NOT NULL AND google_doc_url IS NOT NULL;
```

- [ ] Implement `publicationWorkflowId`: generation 1 keeps `publication-${runId}`; later generations use `publication-${runId}-v${generation}`. Validate explicit payload generations as safe positive integers at the Workflow boundary.

```ts
return generation === 1 ? `publication-${runId}` : `publication-${runId}-v${generation}`;
```

- [ ] Implement allocation using `UPDATE … RETURNING` with a succeeded/expected-generation predicate. Set the new correlation ID to the new deterministic Workflow ID. Leave `google_doc_id`, `google_doc_url`, `successful_generation`, and `publication_date` untouched.

```sql
UPDATE publication_jobs
SET generation = generation + 1, state = 'locked', correlation_id = ?,
    temp_doc_id = NULL, validation_result_json = NULL, finalization_json = NULL,
    attempt_count = 0, updated_at = ?
WHERE publication_run_id = ? AND state = 'succeeded'
  AND generation = ? AND successful_generation = generation
RETURNING *;
```

- [ ] Extend repository mutations with an explicit expected-generation argument in production callers. Apply it to state, date, temporary-copy, retry-owner, attempt, and cache writes. Defaults may support existing v1 callers/tests, but must mean generation 1 rather than silently selecting the latest generation. Return/check mutation success where a failed ownership check could otherwise allow external side effects. Cache UPSERT writes must use an `INSERT … SELECT … WHERE EXISTS` guard on the owning active generation.
- [ ] Add successful-result persistence that records `successful_generation = generation`, latest Doc references, clears temporary/finalization state, and is idempotent for the same generation/result. A stale-generation mismatch raises `publication_generation_stale`, treated as a contender rejection, with no cleanup.
- [ ] Rerun targeted tests, run TypeScript, and commit only Task 1 files.

## Task 2: Make the trigger distinguish explicit regeneration from ordinary scheduling

**Files:** Modify `src/publication/airtable-runs.ts`, `src/publication/trigger.ts`, `src/line/search.ts`, `test/publication/airtable-runs.test.ts`, `test/publication/trigger.test.ts`, `test/line/search.test.ts`.

**Consumes:** `PublicationJobRow` generation metadata, `publicationWorkflowId`, atomic allocation from Task 1.

**Interfaces produced:**

```ts
export interface PublicationRunSelection {
  airtableRunId: string;
  publicationDate: string;
  status: PublicationRunStatus;
}
export async function findPublicationRunForDate(
  fetcher: Fetcher, config: AirtablePublicationConfig, token: string, isoDate: string,
): Promise<PublicationRunSelection | null>;
// Extend trigger result with:
// { status: "regenerating"; publicationRunId: string; generation: number }
```

- [ ] Extend existing trigger tests with the following cases: LINE + Ready + succeeded allocates v2; unchanged inputs still allocate; Generated does not allocate; cron/admin + previous success skip Ready and Failed; an active v2 reports busy; failed v2 retries v2; creation failure retains one resumable v2; two concurrent trigger calls create the same deterministic instance ID.

```ts
await expect(handleDocsTrigger(fixture.env, "line", clock)).resolves.toEqual({
  status: "regenerating", publicationRunId: "rec-run-1", generation: 2,
});
expect(fixture.create).toHaveBeenCalledWith({
  id: "publication-rec-run-1-v2",
  params: { publicationRunId: "rec-run-1", trigger: "line", generation: 2 },
});
```

- [ ] Run the targeted tests before implementation to pin the existing `already_generated` behavior.

```bash
npm test -- test/publication/trigger.test.ts test/publication/airtable-runs.test.ts test/line/search.test.ts
```

- [ ] Extract the existing duplicate-date-safe row lookup into `findPublicationRunForDate`. Keep `findRunnableRunForDate` as a compatibility wrapper for existing callers. Status inspection must not fetch products; validation later reads selected products via `loadRunById`.
- [ ] Implement trigger decisions in this order: inspect date row; read/acquire job; skip non-LINE work if `successfulGeneration > 0`; detect current active Workflow; permit atomic new allocation only for LINE + Ready + succeeded; handle Generated as already generated; otherwise start/resume/restart the current generation without incrementing it. Read again after asynchronous Workflow lookup to handle allocation races.
- [ ] For later revisions, pass explicit generation in Workflow params and use the matching deterministic ID. Generation-1 IDs remain unchanged. Do not reset a revision when an instance is active or paused.
- [ ] Reject a changed date on an existing date-owning job before allocation. Preserve both duplicate-date checks and the original job's date claim.
- [ ] Add the regeneration message and keep result types consistent in the route/LINE boundary:

```ts
case "regenerating":
  return `เริ่มสร้างเอกสารเวอร์ชัน v${result.generation} แล้ว ${result.publicationRunId}`;
```

- [ ] Rerun targeted tests and TypeScript, then commit Task 2 files.

## Task 3: Isolate each generation's inputs and Google copy

**Files:** Modify `src/publication/service.ts`, `src/publication/workflow.ts`, `test/publication/service.test.ts`, `test/publication/workflow.test.ts`, and existing Google Docs tests if needed.

**Consumes:** Current generation and Workflow identity from Tasks 1/2.

**Interfaces produced:** `ValidatedPublication` carries `generation: number`; preparation preserves it. `validatePublication(deps, runId, correlationId, generation = 1)` fences ownership. Stage helpers consume the generation from the prepared value. Temporary discovery uses `publicationWorkflowId(runId, generation)` as its existing `publicationRunId` app-property value.

- [ ] Extend the existing service tests to prove: old generation-1 app-property lookup still works; v2 discovers only its own copy; a lost copy response recovers that v2 copy; original Doc references are retained; a stale v1 call after v2 starts cannot publish or delete; latest added/removed products are reflected in the new prepared snapshot; unchanged cache fingerprints avoid extra caption/collage work.

```ts
expect(copyBody.appProperties).toEqual({ publicationRunId: "publication-rec-run-1-v2" });
// Compatibility: generation 1 retains the original run-ID property value.
expect(legacyCopyBody.appProperties).toEqual({ publicationRunId: "rec-run-1" });
```

- [ ] Run service/Workflow tests before implementation to expose reuse of the old temporary Doc and absent generation fencing.

```bash
npm test -- test/publication/service.test.ts test/publication/workflow.test.ts
```

- [ ] Pass `params.generation ?? 1` from the Workflow to validation and all failure handlers. Use the generation's deterministic correlation ID; generation 1 keeps the original value. For explicit replacement generations, require `event.instanceId === publicationWorkflowId(runId, generation)` at the entrypoint so a separately triggered duplicate instance cannot impersonate the owner. Preserve legacy generation-1 entrypoints, existing `publication_job_locked` and terminal contender behavior, and add stale-generation rejection to the same classification.
- [ ] Extend `readJob` to include generation/successful generation/finalization intent. Before every external mutation, check ownership and active state. Pass expected generation into each associated repository mutation and reject a lost CAS before continuing.
- [ ] Generation 1 uses the old Drive discovery value `runId`; generation 2+ uses the Workflow ID. Use the same value for copy, lost-response discovery, and generation-owned cleanup. This needs no Drive API signature change.
- [ ] Version the in-progress title and final title from the prepared generation:

```ts
const title = `Publication ${date}${generation === 1 ? "" : ` (v${generation})`}`;
const inProgressTitle = `${title} (in progress)`;
```

- [ ] Keep current fingerprinted caches and selected-product order. Do not clear the cache merely because a new generation starts; removal from Products changes the prepared output list, not historical cached entries.
- [ ] Rerun targeted tests and TypeScript, then commit Task 3 files.

## Task 4: Preserve successful Docs across partial finalization failures

**Files:** Modify `src/db/publication-repository.ts`, `src/publication/service.ts`, `src/publication/airtable-runs.ts`, `src/publication/workflow.ts`, `test/db/publication-repository.test.ts`, `test/publication/service.test.ts`, `test/publication/workflow.test.ts`.

**Interfaces produced:**

```ts
export interface PublicationFinalizationIntent {
  generation: number;
  publicationDate: string;
  thaiDate: string;
  docId: string;
  docUrl: string;
  title: string;
  productIds: string[];
  generatedAt: string;
}
export async function persistFinalizationIntent(
  db: D1Database, clock: Clock, runId: string,
  generation: number, intent: PublicationFinalizationIntent,
): Promise<void>;
export async function finalizeStoredPublication(
  deps: PublicationServiceDeps, runId: string, generation: number,
): Promise<PublicationResult>;
```

- [ ] Extend existing service tests to inject failures at Drive rename, Airtable PATCH-before-write, PATCH-after-write/lost response, and D1 successful-result persistence. Assert that the previous Doc is never deleted, the saved candidate is never deleted once publication may have begun, and retry completes the same candidate/version.

```ts
await expect(finalizePublication(deps, preparedV2, "candidate-v2")).rejects.toThrow();
await failPublicationAfterExhaustion(deps, runId, "Unable to finalize the publication.", thaiDate, 2);
expect(deleteCalls).not.toContain("old-doc");
expect(deleteCalls).not.toContain("candidate-v2");
expect((await readSavedJob()).finalizationJson).not.toBeNull();
```

- [ ] Run targeted tests before implementation to expose deletion of a possibly published candidate after exhausted finalization.
- [ ] After fill/verification and before Drive rename/Airtable publish, persist a validated finalization intent once, fenced to the current generation. Serialize using existing JSON/Zod patterns. Keep its original product IDs/date/time stable on retries. Reject a conflicting intent for the same generation.
- [ ] Implement finalization in this order: verify generation ownership; rename the saved candidate idempotently; reconcile Airtable's current Doc URL/status/generated timestamp; apply the intended Generated update if it is not already present; CAS the D1 successful result. Preserve the saved intent until successful D1 persistence.
- [ ] Reconciliation reads only the run metadata and published link rather than reloading changed Products. A matching Doc URL alone is not enough if status/time still require the success update. Use the same intent values for every retry.
- [ ] When finalization intent exists, failure handling retains the candidate and intent, marks the attempt Failed, and sends an actionable failure notification. Do not delete or clear the candidate on an uncertain remote outcome. The previous successful D1 references remain intact until reconciled success; Airtable may already point to a valid, verified new Doc after a lost response.
- [ ] Without an intent, cleanup removes only the current generation's unreferenced temporary copy. Clear its temp reference only after confirmed deletion. No successful/older-generation Doc can be a cleanup target.
- [ ] At the start of a restarted Workflow, check for a pending finalization intent in a durable recovery step. If present, finish it and notify using the saved date/product IDs; skip input validation, caption/collage preparation, and refill. This prevents later product edits from rewriting an already published candidate.
- [ ] Successful notification remains outside generation cleanup. A stale generation must never publish or send a misleading current-version result.
- [ ] Rerun repository/service/Workflow tests and TypeScript, then commit Task 4 files.

## Task 5: Verify the full first-generation → replacement → retry lifecycle

**Files:** Modify `test/acceptance/publication.test.ts` and relevant existing trigger/service tests.

**Consumes:** All production behavior from Tasks 1–4.

- [ ] Add a lifecycle check to the existing acceptance fixture: generate v1; edit Products and data; set Ready; trigger LINE; generate v2; verify old Doc preserved, new title, latest link, changed product list, and no duplicate date owner. Repeat for v3.
- [ ] Add a failed-v2 lifecycle check: preserve the old Doc/link, fix the cause, trigger LINE, and complete v2. Inject lost finalization response and verify no duplicate Doc, no deleted linked Doc, and no version increment on retry.
- [ ] Add a pending-finalization snapshot check: edit Products after failure; retry; verify the saved candidate/snapshot is published; only a later Ready + `/docs` allocates the next revision with the newest products.
- [ ] Add cron/admin skip and stale-owner checks using the same fixture. Keep old generation-1 notification/fill recovery checks passing.

```bash
npm run typecheck
npm test -- test/acceptance/publication.test.ts test/publication/trigger.test.ts test/publication/service.test.ts test/publication/workflow.test.ts
npm test -- --exclude '.worktrees/**'
npx wrangler deploy --env staging --dry-run --outdir /tmp/snazzy-docs-regeneration-build
```

- [ ] Resolve every failing assertion or production defect before committing Task 5 files. Do not weaken date ownership or error checks to make tests pass.

## Task 6: Document and prepare the staging handoff

**Files:** Modify `docs/runbooks/publication-setup.md`, `docs/runbooks/operations.md`.

- [ ] Document: edit the existing row, set Ready, send `/docs`; leave Generated unchanged to keep the existing Doc; never create a second row for the same date. Explain `(v2)`/`(v3)`, cron skipping replacements, same-version failure retries, snapshot behavior, and the latest successful link.
- [ ] Document deploy order: back up/review the target; apply migration `0006_publication_generations.sql` before deploying the generation-aware Worker. Rollback must preserve the new metadata; do not downgrade the Worker while a replacement generation is active or pending finalization.
- [ ] Review the complete branch against the approved spec using a fresh reviewer, fix material findings, and rerun affected checks.
- [ ] Commit only owned changes. Report commit list, tests/build evidence, migration requirement, and remaining uncertainty. Request/obtain the applicable deployment authorization before any remote migration, deployment, or live LINE notification.
- [ ] Staging user acceptance: on an existing successful run for today's Bangkok date, change Products, set Ready, send `/docs`, verify the new versioned Doc and old Doc, then confirm another `/docs` without Ready does not regenerate. Do not send the user's LINE commands on their behalf.

## Self-review

- Every approved requirement maps to Tasks 1–6; the date lock and old Docs are preserved.
- Generation-1 IDs/app properties remain compatible; replacement IDs/properties are distinct.
- The interfaces above agree across trigger, repository, service, and Workflow tasks.
- Finalization-intent recovery is explicit; an uncertain remote publish is not treated as safe deletion.
- Native execution is recommended: these tasks share generation/state interfaces and are best implemented sequentially, followed by one independent whole-branch review.
