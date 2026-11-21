# Recoverable workflow feedback implementation plan

> **For agentic workers:** Use superpowers:executing-plans for native implementation. Track each step with its checkbox.

**Goal:** Give staff an accurate result and a safe next action after every recoverable LINE publication or import failure.

**Architecture:** Keep business results, outstanding repairs, and LINE dispatch evidence independently durable in D1. Recover from captured context through existing command and Workflow entry points. Keep external verification off the LINE reply path.

**Tech stack:** TypeScript, Cloudflare Workers, Workflows and D1, existing Vitest Workers pool, Airtable, Google Drive/Docs, R2, iCloud, Claude and LINE.

**Spec:** [Recoverable results for /docs and /upload](../specs/2026-11-20-workflow-failure-feedback-design.md). [Existing reply contract](../specs/2026-11-19-line-reply-result-queue-design.md).

## Global constraints

- Keep start cards, business retry limits, Thai feedback, current group allowlist, FIFO by enqueue sequence, single-use reply ownership, and the five-message limit. Preserve non-LINE callers.
- Keep the original target, group, date, run, generation and notification cycle through repair. Preserve manual Airtable edits, verified products and earlier successful documents.
- No new staff commands, push fallback, scheduler or dependency. Owner inspection and decisions use authenticated operational tooling. Never log tokens, complete messages or provider response bodies.
- Implementation starts from a checkout containing spec commit `8d8d50a` and merged PR #36 content. Capture `npm run typecheck` and `npm test` with failure names before edits. Compare against that baseline at the end.

## Review focus

1. An accepted event in a partially rejected webhook batch is redelivered (task 2).
2. A new group or Airtable base is configured while an old run needs verification (tasks 2, 6).
3. A previous document generation finishes after staff deliberately set Ready (tasks 3, 6).
4. The import checkpoint covers an uncertain group with no product ID yet (task 4).
5. A malformed or uncertain queue head coincides with a new command and a correction (tasks 5, 7).

## Task 1 — Persist the facts needed to recover a result

**Files:** Create `migrations/0014_workflow_feedback.sql`, `src/db/workflow-feedback.ts`, and `test/db/workflow-feedback.test.ts`. Reuse the import, publication and execution-context repositories; keep existing dispatch records authoritative for delivery.

Ledger: additive repository implemented with atomic outcome writes and fenced evidence. Focused workflow-feedback and migration tests and typecheck verified; broader Task 1 plan scenarios remain to be assessed during integration.

- [ ] Write tests for fresh and upgraded databases. Seed pre-0014 running, terminal and queued records. Assert legacy rows remain readable; a repeated write is idempotent; a stale writer cannot change the current run; a result survives a fresh repository instance. Run `npx vitest run test/db/workflow-feedback.test.ts` and observe the missing behavior.
- [ ] Define the attempt key as the existing tuple of kind, run ID, generation and notification cycle (imports use 1,1). Link accepted LINE event identity and immutable group/context to it. Persist stage, first safe failure code, verified references, outstanding repair flags, immutable result revisions and pending notice intent. Use existing result keys for initial notices; append a revision only for corrections. Index pending work by group. Store bounded lookup data and per-group evidence separately from display lists.
- [ ] Expose repository operations for recording a stage, committing an outcome plus notice intent, and reading pending repair by group with an explicit limit. Fence writes against the actual owning job/group and attempt in the same D1 batch or guarded statement. A revision requires a material change to the next action or outcome. Test that a losing writer produces zero notice intents, and concurrent identical repairs produce one.
- [ ] Run repository and existing migration tests plus typecheck; commit the additive persistence contract. Keep domain-specific business state transitions in their existing repositories.

## Task 2 — Make command acceptance and setup recoverable (cases 1–4)

**Files:** `src/routes/line.ts`, `src/routes/upload.ts`, `src/publication/trigger.ts`, `src/line/command-workflow.ts`, `src/import/workflow.ts`, `src/publication/workflow.ts`. Tests in `test/routes/line.test.ts`, `test/routes/upload.test.ts`, `test/publication/trigger.test.ts`, and the three corresponding Workflow suites.

Ledger: ingress identity was persisted at `6226f08`; upload replay reconciliation was added at `6fe4c50`, and publication handoff binding and restart fencing at `d228803` and `38552a3`. The lost upload start-reply path is exercised through the LINE command adapter, including subsequent same-group feedback and one business dispatch (`test/acceptance/line-reply-outbox.test.ts`, `5e6b11f`); other acceptance boundaries remain open. The existing saved-reply-only regression deliberately suppresses historical redelivery because its dispatch history is unknown; it does not prove recovery for a newly accepted command.

- [ ] Write failing tests for D1 outage before acknowledgment, partial batch redelivery, accepted-but-timed-out Workflow creation, definite refusal, lost start reply, and settings/identity failure before the business handler. Assert one business execution per accepted event, correct HTTP response, durable origin, and no false start.
- [ ] Preserve signature and allowlist checks. At ingress durably record the minimum trusted command identity before acknowledging and connect it to the deterministic command Workflow. Return 503 for eligible events that could not be accepted; deduplicate earlier entries on redelivery. In the command Workflow, distinguish a saved reply from evidence of dispatch. A previously recorded command may require feedback repair; it must never run the command again merely to send feedback.
- [ ] Bind the intended business Workflow ID and attempt before creation. For ambiguous creation, look up that ID; a lookup outage leaves a recoverable claim. Record an early setup failure using trusted ingress identity even if normal config or identity lookup fails. Hold unverified origins for the owner. Keep admin/cron behavior and group boundaries intact. For duplicate or competing group commands expose only the permitted response.
- [ ] Run `npx vitest run test/routes/{line,upload,docs}.test.ts test/{line/command-workflow,publication/trigger,publication/workflow,import/workflow}.test.ts`; verify all new scenarios and unchanged start-card fixtures, then commit.

## Task 3 — Preserve the original publication outcome (cases 7–11)

**Files:** `src/publication/{workflow,service,google-auth,google-docs,airtable-runs}.ts`, `src/db/publication-repository.ts`, `src/line/docs-summary-card.ts`. Use existing validation, caption and product-image error types; update the originating adapter if a necessary safe code is currently discarded.

- [ ] In `test/publication/{workflow,service,google-auth}.test.ts` and `test/line/publication-messages.test.ts`, inject Claude failure followed by Google cleanup failure; swap in an unreadable Airtable table, missing field, verified doc with failed Airtable update, lost Google copy/fill response and multiple discovery matches. Assert the first cause, safe action, verified link when available, and exact create/delete counts.
- [ ] Split failure recording in `failPublicationAfterExhaustion` from Google cleanup and Airtable synchronization. Record the primary cause and outstanding repairs first. Persist the verified outcome or uncertainty and notification intent through task 1; a crash between steps must leave recoverable work. Keep validation failures distinct from provider failures. Carry allowlisted provider codes across Workflow serialization; generic auth errors must never become an assertion that a token expired.
- [ ] Reuse file ownership markers, finalization intent and document verification to adopt a matching output. Treat ambiguity as a hold, including incomplete writes without proof of safe replay. Fence cleanup, never delete the previous successful generation, and never downgrade verified success on a notification or projection failure. Produce source facts for the Thai feedback in task 5.
- [ ] Run `npx vitest run test/publication test/line/publication-messages.test.ts test/acceptance/publication.test.ts`; commit publication outcome handling.

## Task 4 — Recover the original album and product groups (cases 12–15)

**Files:** `src/import/{workflow,service,types,airtable-products,notify}.ts`, `src/db/import-repository.ts`. Tests in `test/import/{service,workflow,notify}.test.ts` and `test/db/import-repository.test.ts`.

- [ ] Add fault injection after snapshot selection, R2 put, ID allocation, Airtable create, attachment verification and group-state persistence. Cover empty, ignored-only and orphan-only complete scans separately from an incomplete scan. For a mixed run assert exact counts, one identity per group, one created row per confirmed group, and durable references for unresolved groups without product IDs.
- [ ] Persist the captured scan membership/order and scan completion evidence needed for deterministic recovery. Replay stored membership and original asset references; detect an unavailable/changed original and hold the affected work. Reuse stable group hashes and recorded allocations. Query Airtable by group identity and verify attachment evidence before adoption. Ambiguous creates, conflicting rows, and failed verification stay distinguishable from confirmed failures.
- [ ] Build the outcome from durable group records and scan evidence. Guard the existing atomic run/checkpoint finalization by coverage and independent reachability of unresolved groups. Prove an unresolved group behind the checkpoint remains selectable by owner recovery. Give historical failures the owner action if a fresh scan cannot reach them. Keep orphan counts separate from product counts.
- [ ] Run `npx vitest run test/import test/db/import-repository.test.ts test/acceptance/{import-acceptance,import-batches}.test.ts`; commit import recovery.

## Task 5 — Repair missing notices and preserve LINE send evidence (cases 5–6)

**Files:** `src/line/{reply-delivery,reply-types,command-workflow,docs-summary-card}.ts`, `src/import/notify.ts`, `src/db/{line-reply-repository,workflow-feedback}.ts`. Tests in `test/db/line-reply-repository.test.ts`, `test/line/reply-delivery.test.ts`, and `test/acceptance/line-reply-outbox.test.ts`.

- [ ] Test a crash after saving an outcome and before enqueue; render failure; concurrent duplicate repair; changed configuration; malformed head; explicit rejection; ambiguous send; failed receipt write; duplicate correction. Assert exactly one initial key, one key per material correction, original sequence and group, command reply still sent when head is held, zero business-provider calls.
- [ ] Implement bounded Thai text and Flex rendering from immutable facts. Show original run/date/attempt, one safe action, verified links and bounded details. Persist the chosen payload once so later rendering changes cannot conflict with an existing key. A broken Flex renderer falls back to text. Treat confirmed pre-start refusals separately; enqueue a missed refusal only with proof of non-delivery.
- [ ] Before queue selection on eligible messages, repair at most one missing intent for the current group with indexed local reads. Make enqueue and marking the intent materialized atomic or replay-safe. Recheck group authorization; never skip an older held queue head. Preserve ordinary command priority even when parsing/rendering the candidate fails. Repair a rejected malformed payload only after proving non-delivery, retaining earlier dispatch evidence and sequence.
- [ ] Run `npx vitest run test/db/line-reply-repository.test.ts test/line/{reply-delivery,reply-renderer}.test.ts test/acceptance/line-reply-outbox.test.ts`; commit notification repair.

## Task 6 — Reconcile on the next command or eligible message (cases 1, 3, 4, 9–11, 13–15)

**Files:** `src/publication/trigger.ts`, `src/routes/{upload,line}.ts`, `src/line/{search,command-workflow}.ts`, `src/{import,publication}/{types,workflow}.ts`; update associated trigger-response schemas and exhaustive consumers found by searching for `already_running`. Exercise via `test/publication/trigger.test.ts`, `test/routes/upload.test.ts`, `test/line/command-workflow.test.ts`.

- [ ] Table-test live, paused, terminal, confirmed missing and lookup unavailable against verified success, confirmed failure and uncertain effects. Cover stale Generating, stale album lock, changed base, deliberate Ready regeneration, old owner finishing late and simultaneous checks. Assert response, resulting state, execution identity and number of provider creates.
- [ ] Inspect the owning job before either the Generating early return or the busy album response. Use captured configuration. If external verification is required, acknowledge “กำลังตรวจสอบงานเดิม” promptly with the owner's reference. Another allowed group sees a neutral busy response only. A check-only command never falls through into a new business attempt. Preserve existing safe pause/resume and explicit retry/regeneration paths.
- [ ] Add a discriminated verification-only payload to the existing import/publication Workflow bindings; dispatch using a deterministic ID per attempt and repair request. Fence a single outstanding check with a durable claim, recover ambiguous create by ID, and allow an authorized later check after a terminated verifier. Its entry point can inspect evidence, apply verified repairs and record a result/correction; it cannot start a new business run. Keep legacy payload decoding. A normal eligible message may schedule one deduplicated outstanding check for its group after its time-sensitive reply work, with durable dispatch intent surviving interruptions.
- [ ] Before writing Airtable, re-read the matching record, honor manual transitions and fence D1 ownership. Where Airtable cannot provide a conditional write, avoid automated writes on conflicting evidence and verify the observed result after the update. Preserve prior successful files and the original target. Never release an album lock on age alone.
- [ ] Run the three targeted suites and both business Workflow suites, then commit next-command reconciliation.

## Task 7 — Owner resolution and release evidence (all 15 cases)

**Files:** `docs/runbooks/{operations,line-reply-outbox}.md`, `src/db/{line-reply-repository,workflow-feedback}.ts`, `test/db/line-reply-repository.test.ts`; add `test/acceptance/workflow-failure-feedback.test.ts` for cross-component regressions.

- [ ] Test two concurrent owner decisions, wrong group/attempt, old reserved sender resuming, uncertain dispatch with no receipt, and a correction behind a resolved head. Introduce an additive owner-disposition record keyed to the exact dispatch/sequence. Make FIFO selection and reservation use the same eligibility predicate. Explicitly closing an unverifiable send releases its head while preserving the actual unknown dispatch evidence. Audit who decided, when and why. Never manufacture LINE acceptance.
- [ ] Document executable owner-only inspection and guarded repair using existing authenticated Wrangler/D1 and Workflow tooling. Include selecting an environment and attempt, verifying origin/target, inspecting first failure and pending actions, verifying a document or product, materializing a missing result, abandoning a proven-unsent reservation, and closing an uncertain send. Exercise the procedure against local seeded data. Keep complete message bodies and credentials out of output.
- [ ] Drive the 15 numbered spec scenarios through the normal command/eligible-message entry points with injected adapters. Assert the Thai action and durable state, duplicate effects, group isolation, queue order, unchanged start cards, old payload compatibility and process restart. Run `npm run typecheck`, `npm run test:acceptance`, then `npm test`. Compare individual failures with the recorded baseline; resolve new regressions. Commit tests and runbook.
- [ ] Prepare a separately authorized staging checklist: private backup, inspect in-flight jobs, apply additive migration first, deploy compatible Worker, exercise Claude plus cleanup failure/stale Generating and mixed import interrupted after Airtable creation on isolated fixtures. Verify the next command, subsequent same-group reply, output links, counts and absence of duplicate creations. Rollback must retain evidence and prevent older code from dispatching or mutating unresolved work; quiesce admissions and review in-flight compatibility before reverting. Stop before remote migrations, deployment or live LINE exercises pending rollout approval.

### Partial implementation — publication intent repair

- Publication failure intents now capture original display facts; eligible replies repair one missing publication notice and mark existing outbox rows materialized. Targeted D1 reply and feedback tests and typecheck pass. Legacy intents without display facts, import notices, correction handling, and the remaining Task 5 cases remain open.

### Task 7 local verification — partial

At `8cd2ca9`, `keeps a malformed queue head in place while sending the ordinary command` failed with a JSON parse error before the fix and passed afterward; the reply-delivery suite passed 19/19. The head remains pending for inspection. Invalid stored message shapes are also held. This does not implement authorized correction of a proven-unsent malformed payload.

The following existing executable tests cover parts of the numbered scenarios, not their entire acceptance contracts:

1. `test/routes/line.test.ts` — `records eligible ingress before handoff and recovers a partially failed mixed batch`; business handoff replay remains open (Task 2 ledger).
2. `test/import/early-failure.test.ts` — `queues a setup failure only for the trusted LINE owner, including replay`; other setup boundaries remain open.
3. `test/publication/trigger.test.ts` — `dispatches one verifier for the owner of a stopped Generating attempt`; missing/unavailable cases and actual effect verification remain open.
4. `test/db/workflow-feedback.test.ts` — `persists an idempotent outcome for the owning publication attempt and rejects stale writers`; complete cross-entry concurrency coverage remains open.
5. `test/line/reply-delivery.test.ts` — `repairs a committed publication intent using its original display facts`; import, corrections and fallback remain open.
6. `test/line/reply-delivery.test.ts` — `network uncertainty holds FIFO but leaves command replies available` and `keeps a malformed queue head in place while sending the ordinary command`; safe payload repair remains open.
7. `test/acceptance/publication.test.ts` — run and product lookup 503s produce failure feedback rather than missing-field reports; confirmed missing fields produce the Thai validation report (`8d4f584`). Corrected-data publication still fails at image setup in the baseline.
8. `test/publication/workflow.test.ts` — `renders verify-first uncertainty and preserves both safe failure codes without secrets`; comprehensive provider-stage coverage remains open.
9. `test/publication/workflow.test.ts` — `persists the primary failure and notice intent before cleanup fails`; next-command cleanup repair remains open.
10. `test/publication/trigger.test.ts` — `dispatches one verifier for the owner of a stopped Generating attempt`; safe Airtable projection repair after proven pre-document failure is not implemented. Repository claim renewal is tested in `test/db/publication-verification-claim.test.ts` — `renews only a confirmed interrupted verifier and fences late completion`, but the trigger does not invoke renewal for a terminated verifier.
11. `test/acceptance/publication.test.ts` — `recovers uncertain copy and fill responses into one final dated document with the template suffix per product` currently fails at image setup; verification-only reconciliation remains open.
12. `test/import/workflow.test.ts` — `records a terminal download failure durably before stopping the workflow`; complete empty/ignored/orphan versus incomplete scan recovery remains open.
13. `test/import/service.test.ts` — `verifies and adopts a response-lost Airtable row before recording success`; full interruption matrix remains open.
14. `test/import/workflow.test.ts` — `records a group only after all six attempts and continues the next sibling`; unresolved groups without IDs and mixed durable summary remain open.
15. `test/import/service.test.ts` — `short-circuits a group that is already succeeded`; checkpoint coverage and independent recovery reachability remain open.

Release checklist, pending separate staging authorization:

- [ ] Privately back up D1 and inspect in-flight jobs, unresolved outbox heads and captured targets; use isolated fixtures.
- [ ] Apply additive migrations before deploying the compatible Worker; verify migration and code compatibility.
- [ ] Exercise forced Claude and cleanup failure with stale Generating, then interrupted mixed import after Airtable creation. Verify next commands, same-group replies, links, counts and no duplicate creations.
- [ ] Verify all 15 cases, group isolation, changed settings, start cards, legitimate regeneration and empty imports before rollout.
- [ ] For rollback, quiesce admissions and review running workflow compatibility; retain all D1 evidence and prevent older code from dispatching or mutating unresolved work before reverting.

Final local suite comparison: baseline e3486c7 1090/1118 passed (28 failed); after 8cd2ca9 1192/1211 passed (19 failed). No new failing names; nine baseline import acceptance names no longer fail. Typecheck passed; acceptance 64/76 passed. Exact remaining failing test names (parameterized repetitions preserved):

- `test/acceptance/line-acceptance.test.ts :: LINE acceptance: exactly 30 cases parser: /search A1234`
- `test/acceptance/line-acceptance.test.ts :: LINE acceptance: exactly 30 cases parser: /soldout A1234 ราคา 1290`
- `test/acceptance/publication.test.ts :: publication acceptance preserves old Docs through replacement and saved-finalization retry (lost response: false)`
- `test/acceptance/publication.test.ts :: publication acceptance preserves old Docs through replacement and saved-finalization retry (lost response: true)`
- `test/acceptance/publication.test.ts :: publication acceptance clears previous validation errors when staff corrects data and publication succeeds`
- `test/acceptance/publication.test.ts :: publication acceptance allows only one of two different runs to publish the same date, including concurrent Workflows`
- `test/acceptance/publication.test.ts :: publication acceptance regenerates edited Airtable inputs after Failed restart while preserving matching product outputs`
- `test/acceptance/publication.test.ts :: publication acceptance places the first four Airtable-ordered images in the white 1080-square collage and reuses its private cache`
- `test/acceptance/publication.test.ts :: publication acceptance recovers uncertain copy and fill responses into one final dated document with the template suffix per product`
- `test/acceptance/publication.test.ts :: publication acceptance deduplicates authorized /docs calls under one Workflow ID and one Bangkok date`
- `test/acceptance/publication.test.ts :: publication acceptance exhausts six Google 503 attempts before cleanup, then restarts a errored Workflow using cached products`
- `test/acceptance/publication.test.ts :: publication acceptance exhausts six Google 429 attempts before cleanup, then restarts a unknown Workflow using cached products`
- `test/line/airtable-inventory.test.ts :: reads every daily-sales page with Bangkok boundaries and requested fields`
- `test/line/soldout.test.ts :: does not persist or mutate for invalid sold price %p`
- `test/line/soldout.test.ts :: does not persist or mutate for invalid sold price %p`
- `test/line/soldout.test.ts :: does not persist or mutate for invalid sold price %p`
- `test/line/soldout.test.ts :: does not persist or mutate for invalid sold price %p`
- `test/line/soldout.test.ts :: does not persist or mutate for invalid sold price %p`
- `test/line/soldout.test.ts :: does not persist or mutate for invalid sold price %p`

### Task 6 partial — verifier renewal ownership fence

Verifier claim renewal now requires the current job's original Workflow ID and captured context to match the claim. The new regression failed before the fix and the claim suite passed 6/6 afterward; typecheck passed. This does not implement pre-Google failure eligibility, guarded Airtable projection repair, or the remaining Task 6 scenarios.
Full suite after this partial change: 1197/1216 passed, 19 failed; failing names match the recorded 19-failure baseline above. No new failing names.

Local verification note: the focused verification-entry, claim, and trigger suites passed (58 tests), and typecheck passed at 0ea7a09. Guarded projection repair remains open. `reopenFailedJobForRestart` can advance a failed attempt while its verifier is outstanding; repair must fence retry admission across the external Airtable write and confirmation, including interrupted or uncertain writes, before marking a result confirmed. Airtable has no conditional status update, so observed conflicting manual changes must be held and the remaining read-to-write race must be accounted for.

### Task 6 import recovery — investigation only

At `9946a6b`, the upload route returns `owner_review` for a stopped or unavailable owned import Workflow and `busy` for another group. Import verification dispatch, durable verifier ownership, evidence-only reconciliation, and the entry-point regressions remain unimplemented. `npm run typecheck` and `npx vitest run test/routes/upload.test.ts` passed (22 tests); these are baseline checks, not verification of recovery. The existing plan edits were preserved.

Local investigation at 9d36015: `npx vitest run test/publication/verification-entry.test.ts` failed 9/11 in isolation, matching the nine additional names reported during `npm test`. All nine fail at line 85: expected one `line_result_outbox` row, received zero. Each fixture inserts an existing revision-zero `workflow_feedback_results` row before running the verifier twice. `completePublicationVerification` deliberately stores a feedback revision instead of inserting an outbox row when feedback exists; eligible-message delivery later materializes pending feedback in order (introduced by 9946a6b). The test does not perform that delivery. The full run reported those nine and the 19 recorded baseline failures, but hung after Workflow engine errors and was interrupted; a completed full-suite name comparison is still required. No fix or assertion change has been verified.

### Reconciliation at 8d4f584

The earlier Task 6 import investigation was historical: stopped-import verification dispatch, claim renewal and read-only candidate evidence are now implemented and exercised by `test/routes/upload.test.ts` and `test/import/verification-entry.test.ts`. These do not establish full import recovery or checkpoint coverage. Publication verification feedback delivery was covered at `8648d59`; the nine obsolete outbox assertions described above no longer represent current tests. Saved LINE reply provenance and safe resumption were added at `4e03889` and `82c0ea3`. The Task 7 malformed-payload repair is now covered for proven rejection in `test/line/reply-delivery.test.ts`; uncertain sends remain held.

Case 7: publication workflow entry tests cover run and linked-product lookup 503s against a confirmed missing field, including final notification and durable job state. Focused tests passed 3/3 and typecheck passed at `8d4f584`. This does not cover every provider error or production delivery.

Suite evidence at 82c0ea3: `npm test` was interrupted after hanging with Workflow engine errors. All 114 test files were subsequently run in twelve separate Vitest processes: 1241 passed, 19 failed (1260 total). The 19 failure names and repetitions match the recorded baseline; no additional failing names. This split run began before the two new case 7 tests were added; those passed separately at 8d4f584. No remote release work was performed.

### Eligible-message scheduling investigation at 5702de9

The spec requires a bounded check after time-sensitive reply work, scoped to the authorized originating group, and requires proof of a stopped original Workflow before verification. The current command Workflow has no eligible-message verifier scheduling. The existing command-trigger claims alone do not close the interruption window between persisting a claim and creating its verifier: their held-claim paths do not reliably redispatch a saved intent when creation never occurred. A durable, replayable dispatch path and entry-point regressions remain necessary; no implementation or release-readiness claim is made here.

At 5702de9, `npm run typecheck` passed and the upload, publication trigger and LINE command Workflow suites passed 80 tests; Miniflare logged Workflow engine errors during the run. These checks do not cover the missing eligible-message scheduling or constitute a full baseline-name comparison.

### Eligible-message fairness follow-up

A durable per-group cursor rotates current import and publication claims, including when a selected origin remains active. Selector tests cover repeated selection, stale/completed claims and group isolation; the ordinary-message entry test covers three replies followed by three distinct origin checks. Typecheck and the two focused suites passed (8 tests). The acceptance run before the final test-only assertion adjustment reported 70 passed and the same 12 recorded baseline failure names. The earlier 15-case status remains partial as listed above; this fairness change does not complete those cases or authorize a remote release. Full-suite baseline-name comparison and the remaining local plan work remain open.

Full local comparison: the single `npm test` run stalled after Miniflare Workflow engine errors and was interrupted. All 115 test files were subsequently run in 12 batches: 1270 passed, 19 failed. All 19 failure names and repetitions match the recorded baseline above; no new failure names. The focused suites were rerun successfully after correcting the entry test's assumption about the cursor's initial position. Remote checks remain unperformed.

### Cleanup recovery investigation at fad166c

Case 9 remains open: `runPublicationWorkflow` persists the primary failure and queues an unconfirmed notice if `failPublicationAfterExhaustion` fails, but does not durably distinguish failed Google cleanup from failed Airtable synchronization. The verification entry only repairs `readPreGoogleFailure` candidates, which require tracked pre-Google evidence and no temporary document. It cannot retry discovery or deletion of a possibly created temporary document. A safe repair needs a durable cleanup-specific intent, verified file ownership and generation fencing before deletion, replay of an uncertain delete, and guarded Airtable projection repair. The existing failure notice mentions both possible secondary failures; it is not evidence that cleanup was repaired. Normal-entry regression coverage for the original Claude-plus-cleanup incident is still needed.

At fad166c, typecheck passed and the publication workflow, verification-entry and trigger suites passed 95 tests. Miniflare emitted Workflow engine errors despite the passing result. This is focused evidence only; it does not establish the full 15-case acceptance matrix or a new full-suite comparison.

### Cleanup projection follow-up at c6e827a

Case 9/10 update: acknowledged cleanup can now lead to a guarded projection repair on the captured Airtable row and a stored Thai correction (deff69e). `test/publication/verification-entry.test.ts` additionally covers a lost PATCH response with successful readback and an observed manual Ready conflict before PATCH; replay makes no second PATCH. The focused verification-entry suite passed 24/24. These tests seed the cleanup receipt and initial failure: they do not prove the original incident end-to-end through an eligible LINE message, nor do they cover the unavoidable Airtable read-to-write race. Cases 1–8 and 11–15 retain the partial status listed above; the 15-case acceptance contract and local release checks remain open.

At c6e827a, all 115 test files ran in 12 separate Vitest batches: 1288 passed and 19 failed. The failure names and multiplicities match the 19 listed baseline failures above. `npm run typecheck` passed. The original incident end-to-end test and remaining local acceptance/release work are still outstanding; no remote actions were taken.

### Cleanup correction delivery at 7d29e53

The verification-entry regression seeds the original failure and display facts with an acknowledged cleanup receipt in one D1 database, runs the verifier, and drains feedback via fresh eligible LINE replies. It checks group isolation, the original uncertainty notice followed by one Thai Failed correction, and replay without additional messages or provider calls. The focused suite passed 25/25 and typecheck passed. This is seeded receipt coverage, not an end-to-end exercise of the original failure and deletion; the Airtable read-to-write race remains. The other approved cases and release checklist above remain open.

Local release checks: `npm run test:acceptance` completed with 71 passed and 12 failed; all 12 failure names match the recorded baseline above and remain unresolved. `npm test` was interrupted after stalling with Miniflare Workflow engine errors, so no full-suite comparison is claimed. No remote operations were performed.

### Ordinary workflow cleanup regression at c77f4fe

The ordinary workflow now exercises a real D1 job and saved temporary document with upstream stages stubbed, a permanent document-fill failure, and the real exhaustion handler. A lost Drive delete response leaves the primary failure and exact cleanup intent persisted by the workflow itself. The same D1 state then goes through verifier cleanup, Airtable repair and eligible LINE delivery, including group isolation and replay. This is simulated provider transport, not production evidence; the Airtable read-to-write race remains.

Local checks: typecheck passed; publication workflow and verification-entry suites passed 55/55. The full suite completed with 1289 passed and 20 failed: the 19 previously recorded failures plus `test/import/terminal-replay.test.ts`, which passed on isolated rerun. This does not establish a clean full-suite baseline comparison. No remote operations were performed; the remaining acceptance matrix and release checklist remain open.

### Local comparison after c77f4fe

Typecheck passed. The complete import suite passed 136/136, including terminal replay. A single full-suite run stalled after Miniflare Workflow engine errors and was interrupted. All 116 test files subsequently completed in 12 bounded batches: 1290 passed and 19 failed, matching the recorded baseline names and multiplicities. The extra terminal-replay failure did not reproduce in its neighboring batch; its original failure trace was not found, so its cause remains undiagnosed. This comparison does not complete the acceptance matrix or authorize staging. No code or assertions were changed and no remote actions were performed.

### Publication acceptance fixture follow-up

The fixture now models individual product reads, persisted preview replacements and R2 originals, and supplies the workflow owner for Google copy admission. The corrected-data and lost copy/fill-response acceptance scenarios pass together (2/2); typecheck passes. Running the full publication acceptance file yielded 8 passed and 7 failed. The seven were among the previously recorded baseline failures: one lost-finalization retry encounters stale ownership, three restart cases encounter stale copy ownership, two collage/count assertions assume the old image path, and the trigger assertion omits captured context. These require further investigation without weakening their behavioral assertions. The 15-case contract, remaining plan tasks, full-suite comparison and release checks remain open; no remote actions were performed.

### Publication acceptance reconciliation after 9533f36

The seven remaining publication acceptance failures were fixture drift, not a demonstrated production defect. Failed restarts advance the notification cycle; the fixture now supplies cycle 2 and explicitly proves cycle 1 cannot create a document. The lost-finalization retry also uses its reopened cycle. The trigger assertion compares its dispatched context with the persisted context and checks captured Airtable and template settings. Image preparation now writes originals before the collage, so collage assertions count collage writes separately; unique source images and persisted Airtable attachment order preserve the four-image and edited-order checks. The corrected-data and lost copy/fill cases remain covered.

Local evidence: `npx vitest run test/acceptance/publication.test.ts` passed 15/15 and `npm run typecheck` passed. `npm run test:acceptance` completed 81/83; the two remaining failures are the previously listed LINE parser cases `/search A1234` and `/soldout A1234 ราคา 1290`. Case 7 now includes corrected-data publication; case 11 includes uncertain copy/fill recovery to one dated document. These do not prove the full 15-case contracts: cases 1–6, 8–10, and 12–15 retain the partial status above, and provider-stage, verification-only, release and full-suite checks remain open. No remote actions were performed.

### Current evidence matrix at 7972db7

This matrix supersedes earlier gap descriptions and incorporates the later commits and tests. Evidence uses local D1 and simulated providers. Missing fault permutations are evidence limits, not automatically implementation defects; concrete gaps and provider limitations are identified explicitly.

| Case | Current evidence | Remaining status |
|---|---|---|
| 1 | Signed import acceptance runs the real Workflow after lost creation and start replies; signed publication acceptance runs the real Workflow after a lost start reply; both prove group isolation and replay. Trigger test simulates documented invalid-ID refusal. | Definitive refusal is conservatively held, not reported as such; usable-token refusal feedback remains a concrete gap. Publication lost creation and start responses combined are not covered. |
| 2 | Import and publication early-failure suites persist trusted setup intent and repair later; 4de2c68 retains notices across failed outbox insertion. | Failures before intent persistence and additional setup boundaries lack proof; ambiguous origins stay held. |
| 3 | Publication trigger tests dispatch a verifier for stopped owners and resume paused instances; import verification tests hold a live original. | Status and effect combinations across both commands are not exhaustively tested; distinguish missing proof from a demonstrated defect. |
| 4 | D1 feedback tests fence stale writers; upload and publication tests exercise competing runs and captured ownership. | Cross-entry concurrency, changed settings and late completion combinations remain incompletely tested. |
| 5 | Reply-delivery tests repair saved intents and fallback text; 3cb43b2 holds invalid or conflicting corrections and later results while ordinary replies remain available. | The earlier reported correction bypass and conflict defects are fixed in these local tests. Other rendering and interruption combinations lack evidence. |
| 6 | Reply-delivery and signed outbox tests cover rejection, uncertainty, owner disposition, abandoned prepared senders, and malformed head repair including mixed abandoned/rejected history (7972db7). | Owner must establish the original Workflow ended before abandonment; ambiguous provider sends remain held. Exhaustive invalid-payload permutations are not established. |
| 7 | Publication acceptance distinguishes unavailable lookups from missing fields and tests correction followed by successful publication. | Authentication/access permutations and delivery through signed ingress are not all exercised. |
| 8 | Publication workflow and signed acceptance tests retain sanitized provider codes and structured image diagnostics; invalid image and post-fill semantic mismatch reach originating-group feedback (307983d, f0fd8d5). | Every provider-stage/fault permutation is not proven; simulated providers cannot establish live provider behavior. |
| 9 | Publication workflow and verification tests retain primary failure and cleanup intent after a lost delete response, repair the captured row and deliver a correction. | The exact Claude-plus-cleanup combination is not end-to-end proven; Airtable has a residual read-to-write race. |
| 10 | b2bb17c and a3f04ef verify saved finalization when Airtable is already Generated and atomically repair matching D1 success; claim and verifier tests fence changed ownership and replay. | When Airtable remains Generating, a verified document link is retained in an unconfirmed result and, if needed, a correction; projection repair remains unresolved. Conditional Airtable PATCH is unavailable; manual edits can race an automatic write. |
| 11 | Publication acceptance recovers lost copy/fill and preserves previous documents; verifier tests cover matching, conflicting, unavailable and changed finalization evidence. | Not every multiple-match and interrupted-entry permutation is proven; ambiguous evidence must remain held. |
| 12 | Import service distinguishes completed empty scans from interrupted scans; D1 atomically saves scan failure and notice; verification tests preserve checkpoint. | Individual iCloud, marker and R2 interruption combinations and empty/ignored/orphan feedback through signed entry remain incompletely tested. |
| 13 | Import service verifies a response-lost Airtable row before adoption and handles failed allocation audit and verified-success audit replay. | All allocation, R2, create, attachment and D1 failure permutations are not proven; ambiguous provider effects require a hold. |
| 14 | Signed mixed import acceptance covers success, ignored, uncertain and ID-less groups, interrupted recording, legacy notices, uncached replay and transaction rollback; no duplicate creates. | Allocation-service outage and every D1 interruption are not demonstrated; simulated provider boundaries limit evidence. |
| 15 | efe091e surfaces absent historical groups to the captured owner and target; 1b9cf19/f199c60 reconstruct uncached and legacy summaries; 9442c00 supplies read-only exact owner inspection. Import acceptance and owner-inspection tests exercise these paths. | Durable owner-scoped historical group disposition and audit/replay remain a concrete implementation gap; inspection does not verify provider originals or resolve a hold. |

### Case 1 handoff follow-up

Signed LINE entry regressions exercise `/upload` and `/docs` when business creation succeeds but its response is lost: the instance lookup finds it, duplicate ingress causes no second business dispatch, and a separately seeded outbox result reaches only a later eligible message in the original group. These tests do not run the business workflow to produce that result. Upload now retains a running claim when creation is uncertain and lookup reports missing, including replay; the regression failed before the fix because it dispatched twice. A claim interrupted before dispatch is consequently held for reconciliation rather than automatically recreated.

`npx vitest run test/routes/upload.test.ts test/acceptance/line-reply-outbox.test.ts test/publication/trigger.test.ts` passed 84 tests; Miniflare logged Workflow engine errors. `npm run typecheck` passed. Definitive provider refusal with a usable token, real business finalization, and the lost initial reply for `/docs` remain unproven; no documented refusal discriminator was established, so absence was not treated as refusal. Case 1 remains open. No remote operations were performed.

### Case 1 generated publication follow-up at 6d3ebc0

`test/acceptance/publication.test.ts` now drives a signed `/docs 2/9/2026` event through local D1 and the actual publication Workflow entry with simulated Airtable, Anthropic, Google, R2 and Images boundaries. The initial LINE reply is accepted with its response lost; replay does not resend it or dispatch another Workflow. The business Workflow produces one document and its own durable success result. A different group cannot drain it; a fresh originating-group event receives the generated document link once, and replay does not resend. The test does not combine this with a lost Workflow creation response, and simulates rather than exercises live providers.

[Cloudflare's Workers API documentation](https://developers.cloudflare.com/workflows/build/workers-api/) identifies `(instance.invalid_id)` and `(body)` as invalid creation options, and `(instance.already_exists)` as an existing instance. `test/publication/trigger.test.ts` simulates the documented invalid-ID refusal and verifies the current conservative hold and no replayed create. It does not establish a durable definitive-refusal outcome or a usable-token LINE notification: the trigger still treats this refusal as unconfirmed on replay, and a lookup outage can mask the original error. No refusal is inferred from `instance.not_found`. The documented newer object-form batch API is not exposed by the installed binding types; `/upload` uses the existing array form.

The `/upload` signed-entry tests still seed the terminal result rather than run the import business fixture; joining its separate injected dependencies to the real entry and producing/delivering its generated result remains open. Case 1 also still needs definitive refusal feedback through usable signed LINE entry for both commands, and lost creation response combined with lost start reply and business-generated final delivery. Other cases and release checks remain as recorded above.

Local focused evidence: 76 tests passed across publication acceptance, LINE outbox acceptance, and publication trigger; Miniflare logged Workflow engine/instance errors. `npm run typecheck` passed. No production code or remote state changed.

Full local `npm test` run: 1312 passed, 9 failed across 3 files. Failures: `test/acceptance/line-acceptance.test.ts` parser cases `/search A1234` and `/soldout A1234 ราคา 1290`; `test/line/airtable-inventory.test.ts` daily-sales requested fields (additional Product Cost); and six `test/line/soldout.test.ts` invalid-sold-price cases (Thai error text differs). The two parser cases were already listed above; the other seven were not compared against a fresh base run. No unrelated fixes were made.

### Case 1 generated import follow-up

`test/acceptance/import-acceptance.test.ts` now combines an accepted-but-lost Workflow creation response and an accepted-but-lost start reply through signed LINE ingress. It runs the actual `ImportWorkflow` with the dispatched parameters, local D1 and the existing simulated iCloud, marker, R2 and Airtable fixtures. One product and one generated terminal result are persisted; command redelivery and a different group do not deliver it, while a fresh event in the originating group delivers it once despite redelivery. This is simulated provider evidence, not a live integration check. No production gap was demonstrated.

The focused import acceptance, LINE outbox acceptance and upload route suites passed 47/47; typecheck passed. A full `npm test` run was interrupted after stalling with Miniflare Workflow engine errors; it had reported the same nine failures named in the prior full-run note, but did not complete. Definitive refusal feedback remains open: no typed positive refusal evidence was established, and missing lookup is not treated as refusal. Other case 1 and release gaps remain open. No remote operations were performed.

### Case 14 mixed import and interrupted recording

Signed `/upload` entry now exercises a simulated mixed batch through the real import Workflow and local D1: one confirmed product, one ignored marker group, one unconfirmed Airtable create, and one insufficient-photo group without a Product ID. The terminal rows and later eligible LINE reply show 1 success, 2 failures, 1 ignored group, a stable ID-less group reference, owner review for the uncertain create and retry wording scoped to corrected items. Cached Workflow-step replay and duplicate LINE events do not allocate or create another product or deliver another summary. The ID-less group is a non-retryable validation failure; this does not prove an allocation-service outage.

An injected interruption before exhausted-group recording persists an unconfirmed notice; resuming the same Workflow produces and delivers the final summary after that notice. Previously both notices used the terminal outbox key, causing D1 finalization to fail. The interruption test uses simulated providers and a cached step fixture; it does not simulate a D1 outage or a crash within the recording transaction. Existing interrupted notices written under the former terminal key are not migrated by this change and require separate reconciliation. Case 14's broader outage and recovery contract remains open.

Focused local evidence: `npx vitest run test/acceptance/import-acceptance.test.ts test/import/notify.test.ts test/import/workflow.test.ts` passed 40/40; `npm run typecheck` passed. No remote actions were performed.

### Legacy import notice and terminal interruption follow-up

A local D1 signed-entry regression reproduces a legacy unconfirmed notice stored under the terminal key: a repeated interruption previously inserted a duplicate, and the final summary conflicted with the old row. Replay now retains that notice and writes the final summary under a distinct key; subsequent eligible replies deliver each once. The mixed-batch fixture also interrupts before the finalization step, verifies durable group rows and no checkpoint at that point, then resumes, advances the checkpoint, finds the unresolved group by hash, and delivers the generated summary without another product creation. This uses cached workflow-step results and simulated providers. It does not inject a failure inside D1's atomic batch, reconstruct the summary without cached steps, or prove owner recovery can independently select a group no longer present in the album. Cases 14 and 15 remain open for those conditions and the broader contract above.

Focused local evidence: `npx vitest run test/acceptance/import-acceptance.test.ts test/import/notify.test.ts test/import/workflow.test.ts test/db/import-repository.test.ts test/import/verification-entry.test.ts` passed 81/81; `npm run typecheck` passed. No remote operations were performed.

### Case 15 missing historical group reproduction (unresolved)

A local D1 regression in `test/acceptance/import-acceptance.test.ts` uses the existing mutable album and provider fixtures. The first admin workflow records one successful product and one insufficient-photo failure, then advances the checkpoint. Removing the failed group from the album and starting a fresh workflow yields `failedGroups: []`, even though the failed group row remains in D1. The new regression currently fails at the expected owner-hold assertion. The confirmed product count remains one up to that assertion; the test has not yet verified delivery through LINE.

The gap is not fixed. Historical group rows are reassigned on matching scans, and a later LINE result must respect the captured originating group and avoid treating a historical hold as a newly failed group or claiming missing originals are available. A safe owner-scoped hold and its disposition/replay behavior still need implementation and verification. No commit, deployment, push, or PR was made. Prior ledger and `.serena` changes were retained.

### Case 15 uncached mixed-summary replay

A signed `/upload` mixed-batch regression now discards every cached Workflow step after interruption before finalization, and separately aborts the checkpoint insert inside the local D1 finalization batch. The transaction rolls back the run and checkpoint; a fresh executor reconstructs one success, two failures (including the stable ID-less reference), and one ignored group, then finalizes and delivers the interrupted notice and summary once to the original group. A second uncached execution preserves the terminal result; no additional Airtable create or R2 put occurs during recovery. Providers are simulated. The test also verifies the unresolved group remains addressable by hash, but does not prove independent owner recovery after its originals disappear.

The demonstrated gap was that reconstruction omitted already-succeeded groups. Successful group ownership now stays with its original run, same-run successes and recorded failures participate in replay, and the display date derives from the durable run start. Existing terminal-replay fixture timestamps were corrected to valid ISO dates. Older terminal notices rendered using the former execution-time date have not been tested with uncached replay; compatibility for those notices remains a risk. Broader cases 14 and 15 and owner disposition remain open.

Local evidence: seven targeted suites passed 139 tests; typecheck passed. The complete suite passed 1,321 and failed the same nine tests already listed in the case 1 ledger: two LINE parser cases, one daily-sales fields case, and six invalid sold-price cases. Miniflare logged Workflow engine errors. No remote operations were performed.

### Legacy terminal replay and independent owner review

A local D1 signed-entry regression retains a delivered mixed terminal summary rendered at the former execution-time date while the persisted run start differs. An uncached replay previously failed finalization on the date-only payload mismatch. Replay now uses the saved summary date to reconstruct the payload; strict comparison still checks the rest. The test retains the original payload, accepted receipt and queue sequence, and delivers the next queued result once. Providers are simulated; the old-date row is generated locally and its run start adjusted to reproduce the historical difference.

The stopped-run verifier previously gave only a run reference when group originals were missing. Its unconfirmed owner notice now includes up to ten unresolved group references. A local D1 verifier regression with no original members confirms one notice on replay, with the group still failed and the run still running. This is an owner-review aid, not restoration or disposition; groups beyond ten require inspection using the run reference. Historical completed-run disposition and the broader case 15 contract remain open.

Local verification: seven focused suites passed 94 tests; typecheck passed. Full `npm test`: 1,323 passed and the same nine previously recorded failures (two LINE parser cases, one daily-sales field case, six invalid sold-price cases); Miniflare emitted Workflow engine errors. No remote operations were performed.

### Case 15 completed-run owner entry boundary

At `f199c60`, the available import verification claim admits only running LINE imports; the verifier likewise requires that claim and running status. The separate owner-only re-import site referenced by the settings spec is not present in this checkout, and the LINE reply owner disposition applies to delivery queue entries, not import groups. No completed-run group disposition or immutable import disposition audit is available here. The local D1 regression `holds a completed historical group when the running-import verifier is requested` confirms repeated claims are rejected while the missing-photo group and checkpoint remain unchanged. It does not establish exact group selection, disposition, audit replay, or removal from fresh summaries; case 15 remains open. No product or checkpoint was repaired, and no remote operation was performed.

Local verification: scoped import, D1, upload and import acceptance suites passed 229 tests across 15 files; `npm run typecheck` passed. Providers are simulated.

### Case 8 image-stage diagnostic follow-up

A signed `/docs` acceptance regression injects invalid JPEG bytes at the actual attachment download boundary. The image layer records `product_image_format_invalid` with product and position, but the previous publication feedback replaced it with `publication_stage_failed` and generic guidance. The workflow now persists a validated structured diagnostic and renders the existing allowlisted Thai guidance in the failure notice and in unconfirmed intent repair. Local D1 evidence checks the stored fact and outbox, excludes the injected private URL and body, and verifies a later eligible signed event delivers once only in the originating group. A separate repair test starts from a committed unconfirmed image intent and retains verify-first wording. The fixture uses simulated providers and a direct Workflow step executor; it does not establish live provider behavior or a crash inside the image diagnostic write.

A post-fill semantic mismatch regression removes the expected product ID from the simulated Google document after a successful fill. Verification rejects it, cleanup removes the temporary document, and the original group receives sanitized stage guidance. The result does not establish every possible verification or ambiguous cleanup outcome. Other image-stage failure variants are covered at the guidance mapping level, not end-to-end; the broader case 8 matrix remains open.

Local verification: `npx vitest run test/publication/image-diagnostic.test.ts test/acceptance/publication.test.ts test/line/reply-delivery.test.ts test/publication/workflow.test.ts test/publication/service.test.ts test/db/workflow-feedback.test.ts` passed 157 tests across six files; `npm run typecheck` passed. Full `npm test` completed with 1,334 passed and the same nine previously recorded failures: two LINE parser cases, one daily-sales fields case, and six invalid sold-price cases. Miniflare emitted Workflow engine errors. No remote operations were performed.

### Case 10 reverse success synchronization follow-up

A stopped owned attempt with saved finalization evidence and Airtable already Generated previously returned already_generated on the next LINE trigger without verifying the unfinished D1 job. The trigger now dispatches the existing fenced verifier for this case; a different group remains busy. A real-D1 trigger and verification-entry regression with simulated Google and Airtable confirms the matching document and queues its link to the originating group without provider mutations. Existing Generated rows without an unfinished saved finalization and Ready regeneration retain their paths.

This is partial: verification does not repair the D1 job's success state, and when Airtable remains Generating the verified document still produces an unconfirmed result without its link or projection repair. A safe repair must preserve observed manual changes and account for Airtable's lack of conditional writes. Signed LINE ingress and delivery of this particular recovery were not exercised; providers were simulated. Case 10 remains open.

Local evidence: publication trigger, verification-entry, acceptance and verification-claim suites passed 121 tests; typecheck passed. Miniflare logged Workflow engine/instance errors despite the passing tests. No remote operations were performed.

### Case 6 prepared reservation recovery

Local D1 tests pause an original sender after reservation and before the dispatch fence, then exercise ordinary signed LINE replies, owner-triggered `abandonPrepared`, fresh same-group FIFO delivery and the original sender waking late. Separate signed-entry cases retain ambiguous evidence and retry a definitive 429 only on a fresh event. The existing atomic fence passed; recovery still requires an owner to verify the saved Workflow ended before abandonment.

Malformed publication repair previously held a head forever after a safely abandoned preparation, including a mix of abandoned and proven-rejected attempts. Repair now accepts only matching abandoned evidence without provider evidence or proven rejections, retaining the original history and FIFO position; contradictory and ambiguous evidence remains held. The two new malformed-history tests failed before the fix. Scoped outbox, delivery, repository and feedback suites passed 53/53; typecheck passed. Simulated LINE responses and a paused sender do not establish live provider behavior, and other case 6 variants and the release checklist remain open. No remote operations were performed.

### Local reconciliation and verified-link repair

At 7972db7, the matrix above supersedes earlier gap descriptions, including the historical missing-group reproduction and the later case 10 note. A stopped publication with a verified Google document and an unchanged Generating Airtable row now retains the link in an unconfirmed result; an earlier unconfirmed notice receives a distinct correction. A real-D1 verifier regression checks original then correction delivery, replay, and withholding the link for conflicting Airtable data or mismatched document metadata. Airtable is not written. Signed ingress and live providers were not exercised; the projection repair and owner group disposition remain open.

Local release evidence: typecheck passed; four migration and feedback suites passed 12 tests. A separate SQLite fresh and seeded pre-0014 upgrade applied all 39 migrations, preserving running, terminal, queued and publication rows with clean foreign-key checks; this is not a Wrangler/D1 remote migration. Acceptance completed 106 passed and the two recorded parser failures. Before the verified-link change, 118 test files completed in 12 bounded batches: 1,351 passed and the same nine recorded failures (two parser cases, one daily-sales requested-fields case, six invalid-price message cases). Relevant parser, inventory, soldout and test files match baseline e3486c7; the sole change in messages.ts affects a different publication message. This comparison does not establish the intended behavior of those failures. After the change, five targeted suites passed 150 tests; the updated verification suite subsequently passed 29 tests, including correction delivery. Miniflare logged Workflow engine errors in passing runs. No remote actions were performed.

### Reconciliation at 3c487cf and unknown-status regression

This section supersedes the 7972db7 matrix's remaining-status claims where they conflict. The earlier case 1 refusal statements predate 1313dc2 and 3c487cf: a locally invalid publication Workflow ID is now durably bound as `failed_to_start`, replayed without a new target, and delivered through signed LINE acceptance (including missed reply repair). This is preflight validation, not proof that arbitrary provider creation errors are definitive refusals. Upload's ID is generated internally; ambiguous creation remains held. Signed import and publication success delivery and group isolation are covered by the acceptance tests named above.

Concrete remaining implementation blockers against the approved spec:

- **Case 3:** both owner command paths hold a confirmed-missing original rather than dispatching effects verification; both verifier entries also demand a terminal status. A missing instance and an unavailable lookup must remain distinct, and neither authorizes blind recreation. Publication's Ready/Failed path still treats a missing instance as a create opportunity without first verifying outstanding effects; the unknown-status fix below does not resolve that path. Paused publication resume is covered on the Ready/Failed path; paused Generating and paused import are held, so their safe-resume behavior needs assessment against the existing ownership rules.
- **Case 10:** verified finalization with an unchanged Generating Airtable row retains a link and unconfirmed feedback but does not repair the projection. Airtable lacks a conditional PATCH, leaving a read-to-write race even after guarded reads and confirmation.
- **Case 15:** owner inspection can select a historical held group, but the documented authenticated procedure does not yet provide the approved scoped repair and recorded disposition for that group. Do not infer or add new disposition semantics from the LINE queue's separate owner procedure.
- **Task 7 release/owner procedure:** the plan requires exercising the complete authenticated inspection and guarded repair procedure against seeded local data, and the full 15-case normal-entry matrix. Existing queue disposition coverage is not evidence of complete business-state repair.

Case 4: `test/db/workflow-feedback.test.ts` rejects stale publication writers; `test/publication/trigger.test.ts` covers verifier claim renewal and late completion; `test/routes/upload.test.ts` covers concurrent album admission; `test/line/reply-delivery.test.ts` and `test/acceptance/line-reply-outbox.test.ts` cover repair and dispatch fencing. These are named evidence, not proof of every cross-entry race or changed-context interleaving. No additional case 4 defect was demonstrated in this review. Case 3's newly demonstrated defect was that a returned `unknown` publication status reopened a failed job and created a Workflow. `holds a failed job when its Workflow reports unknown status` failed before the fix and now holds the job without creation or restart. `/upload` already treats unknown status as unavailable (`test/routes/upload.test.ts`). Missing-instance fixtures now explicitly throw `instance.not_found` rather than returning unknown.

Cases 2, 5–9 and 11–14 retain the named evidence in the matrix and subsequent notes. Additional provider-stage, setup, fault-injection, changed-settings and cross-entry permutations are coverage gaps unless a specific behavior above is demonstrated missing; they are not independent proven defects. Simulated providers cannot establish live LINE, Cloudflare, Google, iCloud or Airtable behavior. Staging and rollback checks remain pending separate authorization; no remote operation was performed.

Local verification for this review: typecheck and `git diff --check` passed; publication acceptance, trigger, upload and feedback suites passed 114 tests. Acceptance completed 109 passed and the same two previously recorded parser failures. Full `npm test` completed 1,359 passed and the same nine recorded failures: two parser cases, one daily-sales fields case, and six invalid-price message cases. Miniflare emitted Workflow engine errors during passing focused runs. No live provider or remote release checks were run.

### Local missing-instance investigation

The installed Workers types expose `unknown` as a status but no typed absence result. In the installed Miniflare Workflow binding, `WorkflowBinding.get()` catches every exception from the underlying `handle.status()` and throws `instance.not_found`; its local engine emits `Engine was never started` when instance metadata is missing. Thus the local exception does not distinguish missing metadata from another status failure. This is evidence about the local implementation, not proof of production Cloudflare's failure semantics. Neither a returned `unknown` nor an arbitrary lookup failure establishes that the original stopped. The current import and publication verifier entries require an explicit terminal status; the saved-claim dispatcher does too. The verifiers can perform guarded provider repairs, so treating the ambiguous exception as proof risks acting while the original is still live. A trustworthy independent absence signal or equivalent durable fencing is still needed before enabling missing-owner dispatch and entry. No provider/API contract or live lookup was verified.

The Ready/Failed publication path now holds an existing job on a missing-looking lookup rather than recreating its business Workflow. A real-D1 regression verifies repeated LINE requests preserve the captured context, failed state and cached collage; an unconfirmed replacement creation is also held. Genuinely new jobs retain the existing creation path. This does not enable verification of a confirmed-missing original and does not close Case 3; import and publication trigger-to-verifier missing-owner tests, outage protection with an independent absence proof, paused-owner assessment, and the other previously recorded gaps remain open. Focused publication trigger, upload, both verifier entry and pending-verification suites passed 124 tests; typecheck and diff check passed. Miniflare emitted Workflow engine errors in the passing run. No remote operations were performed.

### Local owner notice repair — partial

The authenticated import owner CLI can materialize only an existing trusted early-setup notice for the exact run, originating LINE group and captured Airtable base/table. The D1 statement atomically records the operator disposition, queues the notice and marks the intent materialized; changed evidence, conflicting queue state and replay are held. A real isolated local Wrangler/D1 CLI regression and focused D1 suites cover this path. This does not reconcile historical products: saved create claims and ordered photo/R2 references do not prove Airtable attachment identity, and current provider verification checks only attachment count. Case 15 and the broader spec line 69 inspection and repair procedure remain open. No remote migration or deployment was performed.


### Local owner inspection continuation — partial

The import group inspector now requires the captured base and table as well as the exact run, LINE owner and current group. It projects saved failure codes, verification claim, create claim, checkpoint and the owner's current FIFO head and dispatch evidence without message bodies or context secrets. External liveness remains unknown; sync/cleanup is not established. The group head can belong to a different run. Local D1 coverage checks exact and wrong selections, malformed context and read-only behavior. The separate local CLI notice repair regression remains the evidence for that supported repair.

This is not the full line 69 procedure: runs without a product group and publication attempts lack equivalent inspection, original raw failure details are intentionally withheld, and provider originals, sync/cleanup and live Workflow status need independent evidence. Case 15's historical product disposition and case 10 projection repair remain unimplemented; case 3 still needs trustworthy absence evidence or fencing. Full normal-entry matrix, complete seeded owner procedure and remaining local fault/entry coverage are local deliverables, not provider-blocked rollout. Live provider validation, staging, rollback and deployment remain separately blocked by local-only scope. No new disposition semantics are implied.

### Local verification follow-up at c0d6cf4

The reported 1,356 passed/12 failed run and its third additional failure trace were not found in available local logs. A fresh complete run before fixture changes produced 1,357 passed/11 failed and the Node CLI check passed separately. In addition to the nine previously recorded LINE failures, `test/acceptance/publication.test.ts` failed `preserves old Docs through replacement and saved-finalization retry (lost response: true)` with `publication_job_terminal: Unable to finalize the publication` at `src/publication/workflow.ts:123` and `test/acceptance/publication.test.ts:537`, and `exhausts six Google 429 attempts before cleanup, then restarts a missing Workflow using cached products` with expected HTTP 202, received 200 at line 845. Both reproduced in isolation (26 passed/2 failed). The saved `/private/tmp/snazzy-workflow-feedback-tests.log` predates `a94b4b4` and `0bcfb17` and records 1,358 passed/9 failed; `0bcfb17` holds a missing existing Workflow. The first fixture incorrectly reported its already-created replacement missing; the second expected the now-disallowed recreation. The fixture now distinguishes an existing errored replacement and checks a missing owner hold before an existing errored Workflow recovers, retaining cached-product and finalization assertions. The file passes 28/28.

Vitest discovered the `node:test` CLI regression inside its Workers pool and failed at line 8 with `TypeError: test is not a function`. Renaming it to the existing standalone CLI-check convention and invoking it under Node before Vitest in `npm test` preserves the local Wrangler/D1 repair, conflict and replay assertions. The Node test passed. A subsequent bounded `npm test` completed with 1,359 passed/9 failed across 119 Vitest files, plus the passing Node test; the nine names and multiplicities match the prior baseline: the two LINE parser cases `/search A1234` and `/soldout A1234 ราคา 1290`, daily-sales requested fields, and six invalid sold-price cases. This run preceded the final strengthening of the 429 fixture to resume after the hold; that final file passed 28/28 separately. Four scoped suites passed 84 tests, typecheck and diff check passed. Miniflare logged Workflow engine errors. No remote action was performed. Group-less import and publication inspection remains open.

### Final local audit at ef4ba8e

This status supersedes conflicting historical notes above; the previous ledger is retained as history. All evidence is local and provider simulations do not establish live behavior. “Covered” refers to named tests in the matrix and follow-ups, not every permutation.

| Case | Current status |
|---|---|
| 1 | Signed import and publication success and lost-reply recovery covered; invalid publication ID preflight refusal covered. Arbitrary provider refusal is not established; combined publication creation/reply loss is untested. |
| 2 | Trusted early setup failure and notice repair covered; additional pre-persistence and setup faults untested. |
| 3 | Stopped owners can dispatch verification; unknown or missing owners are held. Mandatory confirmed-missing verification remains absent: no trustworthy independent absence proof or equivalent fence is established. Paused-owner paths require assessment. |
| 4 | Ownership, stale writer and several concurrent admission fences covered; cross-entry and changed-context combinations remain untested. |
| 5 | Saved intents, correction ordering and conflicting/invalid repair holds covered; further interruption/rendering permutations untested. |
| 6 | FIFO, uncertainty, rejection, owner decision and safe malformed-head repair covered; ambiguous sends remain held. Additional permutations untested. |
| 7 | Lookup failures versus missing fields and corrected publication covered; access and signed-entry permutations untested. |
| 8 | Sanitized failure codes, image diagnostics and selected provider-stage failures covered; broader provider-stage permutations untested. |
| 9 | Primary failure, cleanup intent/receipt and guarded failure projection correction covered locally; exact Claude-plus-cleanup incident is not proven end to end. Airtable read-to-write race remains. |
| 10 | Verified finalization and already-Generated synchronization covered. Mandatory repair of unchanged Generating projection after verified success remains absent; Airtable lacks conditional PATCH and a manual edit can race the write. |
| 11 | Lost copy/fill recovery and finalization evidence checks covered; additional ambiguity and interruption permutations untested. |
| 12 | Empty versus incomplete scan and checkpoint protection covered; individual interruption and signed-entry permutations untested. |
| 13 | Lost Airtable create response and audit replay covered; allocation, attachment and persistence fault permutations untested. |
| 14 | Signed mixed import, interrupted recording, replay and transaction rollback covered; allocation outage and further D1 interruptions untested. Legacy interrupted notices under the former terminal key require reconciliation. |
| 15 | Missing historical groups are surfaced; authenticated verified adoption and durable audited disposition are available as described below. Further seeded end-to-end procedure coverage remains open. |

Spec line 69: `ef4ba8e` adds exact captured-owner/target inspection for group-less imports and current or retained historical publication attempts, complementing group inspection, audited early-notice repair and the separate queue disposition procedure. The inspector exposes selected safe identifiers, failure codes, result revisions, queue dispatches, verification claims and publication cleanup/write evidence; it does not establish live Workflow or provider state. Sync confirmation is not durably recorded as a distinct receipt and is reported as unknown; a prior verified result is historical evidence, not proof of current provider state. Other scoped verified-state repairs and a full seeded procedure remain mandatory local work. The inspector's SQL binds selection values, checks captured context before output, holds mismatches and malformed context, suppresses raw errors/context and documents its separate-read race. No demonstrated small inspector defect was found. No new sync machinery was added without a reliable producer and consumer.

The full 15-case normal-entry matrix and complete seeded owner procedure are local deliverables, distinct from optional fault permutations and live staging validation. Rollout remains blocked by the mandatory gaps above. After local completion and separate authorization: privately back up D1 and inventory running jobs, captured targets and unresolved queue heads; apply additive migrations before compatible code; exercise the 15 cases and cross-group/configuration fencing, forced cleanup failure and interrupted mixed import with isolated staging fixtures; verify counts, links, queue order, provider creations, regeneration, empty imports and start cards. For rollback, quiesce admissions, assess running Workflow compatibility, preserve all D1 evidence and prevent older code from mutating or dispatching unresolved work before reverting. No remote action was performed.

Final audit verification: typecheck and diff check passed; five focused owner/verification suites passed 47 tests and the standalone local Wrangler/D1 CLI check passed. Fresh and seeded pre-0014 SQLite upgrades applied all 40 migrations, retained two import runs, a publication job and a queued result, and passed foreign-key checks. A single `npm test` stalled after Miniflare Workflow engine errors and was stopped; all 120 Vitest files then completed in 12 bounded batches: 1,361 passed and the same nine previously recorded failures (two LINE parser, one daily-sales fields, six invalid-price cases). The Node CLI check also passed separately. These failures remain unresolved; no live service was checked.

### Case 15 evidence verification increment (not a repair)

The read-only `verifyHistoricalImportEvidence` checks an exact captured LINE owner, run, group and Airtable target, terminal run and unresolved group, allocation audit and create claim, ordered membership and group hash, saved asset keys and original byte hashes, then compares bounded, trusted Airtable attachment downloads to rendered previews in order. It returns a held reason on missing or conflicting evidence. Local D1 and simulated provider tests cover a match and several holds; typecheck passes. The verifier takes injected provider operations and is not exposed by the owner CLI. It does not commit a disposition or fence concurrent changes, so it must not be used as authorization for a repair. At that increment, case 15 remained open pending authenticated provider adapters and an atomic audited disposition; the later increment below supersedes this limitation. No remote operations were performed.

### Case 15 authenticated resolution increment

The admin bearer Worker route now verifies the exact captured owner, run, group and target using R2 originals, Images previews and read-only Airtable evidence before applying the atomic fenced disposition. New audit evidence stores attachment IDs and preview digests without signed attachment URLs; legacy audits remain unchanged. Local D1 and simulated bindings cover authorization, foreign owner/target, mismatch, adoption, replay, provider read-only behavior and removal from fresh historical holds. External Airtable edits cannot be fenced by D1 and require operator coordination. Other spec line 69 gaps and the full seeded procedure remain open; no remote operations were performed.
