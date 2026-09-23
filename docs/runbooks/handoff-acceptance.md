# Handoff Acceptance Checklist

Run in order and retain evidence for each item. Production handoff is complete only when every item is checked with actual evidence. Local checks recorded here apply to this worktree; they do not establish that `main` or customer environments passed.

## Local verification

- [ ] Phase 0 report (`docs/feasibility/icloud-phase-0-report.md`) says `PASS`.
- [ ] `npm run check` passes on `main` with zero failing tests.
- [ ] `npm run test:acceptance` passes on `main`.
- [x] `test/acceptance/retry-exhaustion.test.ts` proves retry exhaustion isolates sibling groups (worktree suite passed; see Task 16 report).
- [x] `test/acceptance/import-batches.test.ts` covers all ten production-sized batches (worktree suite passed; see Task 16 report).
- [x] `test/acceptance/publication.test.ts` proves missing-field blocking, first-four ordering, and one document per date (worktree suite passed; see Task 16 report).
- [x] `test/acceptance/line-acceptance.test.ts` covers at least 30 parser and command cases (worktree suite passed; see Task 16 report).
- [x] `test/icloud/redaction-audit.test.ts` finds no secret or signed URL in iCloud boundary logs (full worktree suite passed; see Task 16 report).
- [x] `test/acceptance/smoke.test.ts` covers smoke-check logic (worktree suite passed; see Task 16 report).
- [ ] D1 migrations apply to a fresh local database using `npm run db:migrate:local`.

## Customer environment verification

- [ ] D1 migrations apply to fresh staging and production databases, evidenced by the Task 15 fresh-account rehearsal.
- [ ] Real staging and production D1 `database_id` values are present in `wrangler.jsonc`; neither binding has an example ID.
- [ ] Missing and incorrect bearer tokens return HTTP 401 on `/setup` and `/usage` before dependency access.
- [ ] Authenticated staging `GET /setup` returns `"ok": true` and all eleven checks pass.
- [ ] Authenticated production `GET /setup` returns `"ok": true` and all eleven checks pass.
- [ ] Staging `npm run smoke` prints `SMOKE TEST PASSED` and accepts the real LINE HMAC.
- [ ] Fresh-account rehearsal proves deployment from `docs/runbooks/deployment.md` using customer-owned resources.
- [ ] One production external-service credential is rotated using `docs/runbooks/credential-rotation.md` without code changes, then verified through authenticated `/setup` and `npm run smoke`.
- [ ] `docs/runbooks/operations.md` records both native Cloudflare Notification policies: Billing Usage Alert and R2 Storage.
- [ ] Authenticated production `GET /usage` returns a validated monthly report with plausible `estimatedThb` (expected ฿0–1000 before traffic).
- [ ] Customer staff receive printed `SNAZZY_PRODUCT_START_V1` marker cards and confirm marker placement in a live test shoot.
- [ ] Customer walks through `docs/runbooks/operations.md`, `docs/runbooks/album-rotation.md`, and `docs/runbooks/credential-rotation.md` at least once.
- [ ] Airtable, Google, LINE, Anthropic, Cloudflare, and iCloud credentials are confirmed customer-owned, not contractor-owned.
