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
- [ ] Implement validated safe boundary encoding/decoding and native non-retryable errors in publication, image and affected import paths; map Claude errors before the boundary.
- [ ] Preserve primary failures across identity and persistence faults and use fenced recovery, with one actionable Thai instruction.
- [ ] Run regression, focused tests, typecheck, Node CLI, acceptance and bounded full suite; compare exact baseline failures.
- [ ] Review entire diff, correct findings, update evidence and commit local changes.

## Unresolved implementation detail

Prove a recoverable intent exists after a primary outcome persistence failure, including when D1 is unavailable throughout the original attempt. Current feedback delivery repairs only already persisted records; it cannot reconstruct missing facts by itself. Do not infer a destination or claim automatic recovery until a fenced trigger and durable source are demonstrated.
