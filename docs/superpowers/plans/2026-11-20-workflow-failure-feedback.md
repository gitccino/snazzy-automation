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
