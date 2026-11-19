# LINE reply outbox validation — 2026-11-19

Scope: native local implementation of approved reply-result queue. No deployment, remote migration, live LINE messages, credentials repair or historical backfill authorized/performed.

Baseline: HEAD 249e51d, typecheck passed; root suite 1044 passed / 28 failed. Exact baseline failure names and final comparison appear below after verification. Existing messenger Reply API edits were preserved and integrated; unrelated .serena/ remains untouched.

Local checks cover actual D1 FIFO/reservations/CAS, indivisible reply composition/capacity, token rejection vs unknown acceptance, actorless/non-text privacy, signed webhook handoff, cross-group isolation, durable enqueue idempotency, publication restart cycles, and notification persistence independent of business work. External providers are mocked. Live LINE behavior is not proven by these tests.

Rollout commands for a separately approved staging window:

```bash
npx wrangler workflows list --env staging
npx wrangler d1 export snazzy-automation-staging --remote --env staging --output .wrangler/line-outbox-pre-migration.sql
npm run db:migrate:staging
npm run deploy:staging
```

Before running mutations, record the deployed version and current settings privately and inspect instances of every listed import/publication/LINE Workflow. Require no incompatible in-flight execution; earlier messenger rollout permission does not cover this migration. Use the owner recovery procedures in docs/runbooks/line-reply-outbox.md. Maintenance mode stops new admissions for rollback while preserving all outbox/dispatch evidence. Do not run an older binary against active queue-enabled executions without reviewing compatibility.

## Verification

Root suite: 1090 passed / 28 failed. The failure-name multiset exactly matches baseline; no new failing tests. Typecheck and staging deployment dry-run passed. Source-only audit found terminal cards contain static icons and durable document/Airtable URLs; no expiring image field needs refreshing.

Remaining baseline failures (repeated names represent parameterized cases):

- LINE acceptance: exactly 30 cases parser: /search A1234
- LINE acceptance: exactly 30 cases parser: /soldout A1234 ราคา 1290
- does not persist or mutate for invalid sold price %p
- does not persist or mutate for invalid sold price %p
- does not persist or mutate for invalid sold price %p
- does not persist or mutate for invalid sold price %p
- does not persist or mutate for invalid sold price %p
- does not persist or mutate for invalid sold price %p
- import acceptance 10. processes 500 photos and sends the exact success and failure summary
- import acceptance 2. preserves 9, 12, and 15-photo attachment counts
- import acceptance 3. applies first-run cutoff then saves explicit snapshot checkpoint
- import acceptance 4. unchanged repeated /upload downloads nothing and creates no duplicate
- import acceptance 5. resumes the same durable run after interruption following download
- import acceptance 6. exhausted failure leaves successful sibling intact
- import acceptance 7. reports every exhausted group with burned Product ID and code
- import acceptance 8. later /upload resets a failed group with a fresh ID and imports its new sibling
- import acceptance 9. keeps Product IDs unique across three cumulative batches
- publication acceptance allows only one of two different runs to publish the same date, including concurrent Workflows
- publication acceptance clears previous validation errors when staff corrects data and publication succeeds
- publication acceptance deduplicates authorized /docs calls under one Workflow ID and one Bangkok date
- publication acceptance exhausts six Google 429 attempts before cleanup, then restarts a unknown Workflow using cached products
- publication acceptance exhausts six Google 503 attempts before cleanup, then restarts a errored Workflow using cached products
- publication acceptance places the first four Airtable-ordered images in the white 1080-square collage and reuses its private cache
- publication acceptance preserves old Docs through replacement and saved-finalization retry (lost response: false)
- publication acceptance preserves old Docs through replacement and saved-finalization retry (lost response: true)
- publication acceptance recovers uncertain copy and fill responses into one final dated document with the template suffix per product
- publication acceptance regenerates edited Airtable inputs after Failed restart while preserving matching product outputs
- reads every daily-sales page with Bangkok boundaries and requested fields


## Implementation decisions

- Kept the unused legacy command-recovery helper for its existing consumers/tests; production command routing no longer invokes it.
- Used a focused green gate excluding two files with seven pre-existing failures, then compared the full-suite failure-name multiset against baseline.
- Reused publication's existing notify rendering seam behind a queue-only production adapter, with explicit outcome metadata, instead of changing every service consumer to a new method name.
- Captured failure-card data durably before enqueueing; cleanup exhaustion yields an unconfirmed diagnostic and preserves the original business failure.
- D1/settings backups and authoritative in-flight checks belong immediately before an approved rollout; backups captured during implementation would become stale. Read-only staging Workflow inventory was inspected without changing runs.

The final fresh-context review is recorded after all local gates. The review scope starts at 249e51d (this queue feature's approved-plan baseline), including the pre-existing messenger reply changes integrated by Task 4, rather than re-reviewing unrelated earlier branch features.


## Fresh review and regression fixes

One independent read-only review found no Critical issues and five Important issues. All five were reproduced by failing tests and fixed:

- An errored generating publication with an existing unconfirmed result now atomically allocates a new notification cycle before an explicit business restart, preserving its old result and temporary-document recovery data.
- Unconfirmed cards now use verify-first title, alternative text and body throughout; no failure assertion or direct retry footer remains.
- Historical saved-reply-only webhook IDs are suppressed before business preparation, including redelivery after old Workflow retention expires.
- Definite rejections and ambiguous provider responses retain HTTP status and bounded LINE request ID in dispatch evidence.
- Publication diagnostics preserve both sanitized original-stage and cleanup error codes across durable serialization, without raw provider messages or credentials.

The two review suggestions about command reservation races and delayed real cards were treated as acceptance-test gaps and completed: deterministic reservation loss preserves the command reply, and a stored terminal card retains original date/group/URLs after a configuration change. No minor findings remain deferred. Ten baseline message fixtures captured using the pre-refactor renderer at 249e51d verify every rendered variant, including both unchanged start cards; the existing card builders were not changed except for the new uncertainty-specific builder.

Reviewer exclusions remain intentional: the 28 baseline failures, unrelated mutation-followup pushes, live provider credentials, and historical branch work outside this queue range are not repaired or re-audited. Live LINE acceptance, remote migration compatibility, current backups and authoritative in-flight checks remain separately authorized rollout gates. All application changes are committed locally on messenger-demo; nothing was pushed, merged, migrated or deployed remotely.
