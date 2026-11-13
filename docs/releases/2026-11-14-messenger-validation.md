# Messenger implementation validation — 2026-11-14

Local implementation only, on `messenger-demo`; no rollout performed.

- Root typecheck: PASS.
- Feature/integration/configuration gate: 158 tests PASS across 18 files.
- Settings typecheck, 19 tests and production build: PASS.
- Full root suite: 1,001 passed, 28 failed (1,029 total). All 28 failure names match the pre-implementation baseline (936 passed, 28 failed, 964 total); no new failures. This is not a green full suite.
- Acceptance uses real local D1 and mocked Airtable/LINE. Covers sanitized durable handoff, registration/redelivery, today/tomorrow, provider pagination, completion permissions, reply failure, repeated buttons, persistent Done rows, all-Done overview and group isolation.
- Manual live LINE Flex validation/mobile layout, live Airtable provisioning and Book identity setup remain rollout checks. See [runbook](../runbooks/messenger-delivery.md).
- Independent review found three P2 issues; all were fixed in one pass with failing-then-passing regression tests: registration reauthorization, successful-save bookkeeping, and uncertainty-preserving recovery. Concurrent recovery and duplicate-notice regressions also pass. No deferred minor findings.
- No second reviewer was dispatched; fixes were verified through tests and the full-suite baseline comparison.

## Rulings made during implementation

- Validate an enabled delivery table through the Settings connection validator, not global `/setup`; rollout must run that connection check.
- Carry the pinned Airtable connection explicitly through service dependencies; a settings change requires a fresh request instead of using a stale adapter.
- Keep LINE conversion/dispatch in one focused messenger module; this adds one module without changing the existing commands' behavior.
- Leave the exact 28 pre-existing root failures outside this slice; the full suite remains non-green.
- D1 does not fence arbitrary Airtable editors; concurrent manual edits can require operator reconciliation.
- Never automatically release ambiguous write claims; uncertain provider outcomes can require manual inspection.
- Live LINE rendering, quoting and provider permissions remain rollout checks; live integration is unverified until authorized staging validation.



## Unchanged baseline failures

- `test/acceptance/import-acceptance.test.ts :: import acceptance 10. processes 500 photos and sends the exact success and failure summary`
- `test/acceptance/import-acceptance.test.ts :: import acceptance 2. preserves 9, 12, and 15-photo attachment counts`
- `test/acceptance/import-acceptance.test.ts :: import acceptance 3. applies first-run cutoff then saves explicit snapshot checkpoint`
- `test/acceptance/import-acceptance.test.ts :: import acceptance 4. unchanged repeated /upload downloads nothing and creates no duplicate`
- `test/acceptance/import-acceptance.test.ts :: import acceptance 5. resumes the same durable run after interruption following download`
- `test/acceptance/import-acceptance.test.ts :: import acceptance 6. exhausted failure leaves successful sibling intact`
- `test/acceptance/import-acceptance.test.ts :: import acceptance 7. reports every exhausted group with burned Product ID and code`
- `test/acceptance/import-acceptance.test.ts :: import acceptance 8. later /upload resets a failed group with a fresh ID and imports its new sibling`
- `test/acceptance/import-acceptance.test.ts :: import acceptance 9. keeps Product IDs unique across three cumulative batches`
- `test/acceptance/line-acceptance.test.ts :: LINE acceptance: exactly 30 cases parser: /search A1234`
- `test/acceptance/line-acceptance.test.ts :: LINE acceptance: exactly 30 cases parser: /soldout A1234 ราคา 1290`
- `test/acceptance/publication.test.ts :: publication acceptance allows only one of two different runs to publish the same date, including concurrent Workflows`
- `test/acceptance/publication.test.ts :: publication acceptance clears previous validation errors when staff corrects data and publication succeeds`
- `test/acceptance/publication.test.ts :: publication acceptance deduplicates authorized /docs calls under one Workflow ID and one Bangkok date`
- `test/acceptance/publication.test.ts :: publication acceptance exhausts six Google 429 attempts before cleanup, then restarts a unknown Workflow using cached products`
- `test/acceptance/publication.test.ts :: publication acceptance exhausts six Google 503 attempts before cleanup, then restarts a errored Workflow using cached products`
- `test/acceptance/publication.test.ts :: publication acceptance places the first four Airtable-ordered images in the white 1080-square collage and reuses its private cache`
- `test/acceptance/publication.test.ts :: publication acceptance preserves old Docs through replacement and saved-finalization retry (lost response: false)`
- `test/acceptance/publication.test.ts :: publication acceptance preserves old Docs through replacement and saved-finalization retry (lost response: true)`
- `test/acceptance/publication.test.ts :: publication acceptance recovers uncertain copy and fill responses into one final dated document with the template suffix per product`
- `test/acceptance/publication.test.ts :: publication acceptance regenerates edited Airtable inputs after Failed restart while preserving matching product outputs`
- `test/line/airtable-inventory.test.ts :: reads every daily-sales page with Bangkok boundaries and requested fields`
- `test/line/soldout.test.ts :: does not persist or mutate for invalid sold price %p`
