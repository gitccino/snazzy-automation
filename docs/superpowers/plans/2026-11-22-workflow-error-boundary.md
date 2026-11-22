# Workflow error boundary implementation plan

**Goal:** Preserve safe failure identity, retry behavior and recoverable feedback across real Workflow boundaries.

**Architecture:** Carry validated locally generated failure facts through step serialization, keep native non-retryable identity, and reuse fenced durable feedback and image diagnostics. No destination is inferred without trusted persisted identity.

**Tech stack:** TypeScript, Cloudflare Workflows, D1, Vitest/Miniflare.

**Spec:** `docs/superpowers/specs/2026-11-22-workflow-error-boundary-design.md`

## Global constraints

No new dependencies, provider calls, remote writes, schema expansion without necessity, or raw provider body logging. Preserve legacy jobs, fencing, FIFO, receipts and original failure. Owner review precedes retry for ambiguous outcomes.

## Review focus

- Unknown or malformed envelopes fall back safely; arbitrary provider text is never parsed as a code.
- Native permanent errors stop after one attempt; transient errors exhaust the configured attempts.
- Image diagnostic persistence failure falls back safely without replacing the original cause.
- Stale or ambiguous identity cannot route a notice to an untrusted group.
- D1 outage cannot promise delivery; recovered storage must allow existing supported recovery to act on durable intent.

## Tasks and progress

- [x] Run focused baseline: `npx vitest run test/publication/workflow.test.ts test/publication/captions.test.ts test/import/workflow.test.ts test/db/workflow-feedback.test.ts` — 69 passed.
- [ ] Complete bounded full-suite baseline: observed nine failures (2 LINE acceptance parser, 1 Airtable inventory, 6 soldout); runtime emitted Workflow startup/hang errors and the run was interrupted before completion.
- [ ] Add real local Workflow runtime regression for serialized failure facts, retry counts, production feedback and rendered delivery; demonstrate failures before implementation.
- [x] Implement validated safe boundary encoding/decoding and native non-retryable errors in publication, image and affected import paths; map Claude errors before the boundary.
- [x] Preserve primary failures across identity and persistence faults and use fenced recovery, with one actionable Thai instruction.
- [x] Run regression, focused tests, typecheck, Node CLI, acceptance and bounded full suite; compare exact baseline failures.
- [ ] Review entire diff, correct findings, update evidence and commit local changes.

## Unresolved implementation detail

Prove a recoverable intent exists after a primary outcome persistence failure, including when D1 is unavailable throughout the original attempt. Current feedback delivery repairs only already persisted records; it cannot reconstruct missing facts by itself. Do not infer a destination or claim automatic recovery until a fenced trigger and durable source are demonstrated.

## Local verification, 2026-11-22

The pre-change bounded baseline did not complete; the comparison uses the exact nine failure names and multiplicities recorded in the preceding workflow-feedback plan. The final 123 root Vitest files ran in 13 bounded batches: 1,370 passed, nine failed, exactly those recorded failures (two LINE parser cases, daily-sales fields, six invalid sold-price cases). The separate Node owner CLI check passed 1/1, typecheck passed, and import/publication acceptance passed 66/66. The focused boundary, captions, import, feedback, early-failure and image guidance gate passed 85/85. `git diff --check` passed.

The separate real Miniflare Workflow fixture passed 4/4: Claude 401 made one attempt, Claude 429 made six; Google authentication and changed-image failures each reached the permanent boundary once. It checks stored codes and queued safe guidance; the image case uses the production image step and D1 diagnostic bridge. The Google fixture allows a later cleanup authentication call to succeed, so a retry of the failed stage would change the observed outcome. The runtime emits expected engine error logs for failed workflow steps. Tests use simulated providers and a local outbox; they do not prove a live LINE delivery. Identity and primary persistence faults are covered by direct workflow tests rather than runtime fault injection. The new Google/image runtime cases were added after the core fix, so a pre-fix red run for those cases is not claimed.

Review traced serialization, code validation, permanent/transient mapping, image diagnostic storage, early trusted binding, generation/cycle/group fences, and primary-failure preservation. A total D1 outage before any intent is stored cannot guarantee a notice or automatic reconstruction; later recovery requires a durable supported intent and trigger. The nine known failures remain release blockers unless separately accepted. No remote operations were performed.
