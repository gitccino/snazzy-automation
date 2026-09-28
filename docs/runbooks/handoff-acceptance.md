# Handoff Acceptance Checklist

Run in order and retain evidence for each item. Production handoff is complete only when every item is checked with actual evidence. Local checks recorded here apply to this worktree; they do not establish that `main` or customer environments passed.

## Local verification

- [x] Phase 0 report (`docs/feasibility/icloud-phase-0-report.md`) says `PASS` (final verdict at line 24).
- [ ] `npm run check` passes on `main` with zero failing tests.
- [ ] `npm run test:acceptance` passes on `main`.
- [x] On the feature worktree, `npm run check` passed: 69 files, 714 tests.
- [x] On the feature worktree, `npm run test:acceptance` passed: 6 files, 66 tests.
- [x] `test/acceptance/retry-exhaustion.test.ts` passes in the feature worktree.
- [x] `test/acceptance/import-batches.test.ts` passes in the feature worktree.
- [x] `test/acceptance/publication.test.ts` passes in the feature worktree.
- [x] `test/acceptance/line-acceptance.test.ts` passes in the feature worktree.
- [x] `test/icloud/redaction-audit.test.ts` passes in the full feature-worktree suite.
- [x] `test/acceptance/smoke.test.ts` passes in the feature worktree.
- [x] D1 migrations applied to a fresh isolated local database with `wrangler d1 migrations apply snazzy-automation-local --local --persist-to <isolated-dir>`; `d1_migrations` lists all six files through `0005_usage_metrics.sql`.

## Customer environment verification

- [ ] D1 migrations apply to fresh staging and production databases, evidenced by the Task 15 fresh-account rehearsal.
- [ ] Real staging and production D1 `database_id` values are present in `wrangler.jsonc`; neither binding has an example ID.
- [ ] Missing and incorrect bearer tokens return HTTP 401 on `/setup` and `/usage` before dependency access.
- [ ] Authenticated staging `GET /setup` returns `"ok": true` and all eleven checks pass.
- [ ] Authenticated production `GET /setup` returns `"ok": true` and all eleven checks pass.
- [ ] Customer owner confirms account recovery access and available My Drive storage; staging and production use separate Picker-selected folders and templates, with `GOOGLE_OAUTH_CLIENT_ID` bound per environment and `GOOGLE_OAUTH_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN` stored only as Worker secrets.
- [ ] Google consent screen is **In production** with `drive.file`; any Google verification requirement is resolved. The owner completes `npm run google:drive-setup -- --expected-owner <owner-email>` for each environment and retains the refresh tokens only in the customer secret store.
- [ ] `google_template_access` passes the disposable copy/read/edit/rename/delete rehearsal in both environments. A staging generated document is owned by the personal account, and a collaborator with folder access can open it without authorizing the app.
- [ ] Owner rehearses refresh-token reconnect/rotation using [credential rotation](credential-rotation.md), including an invalid or revoked grant and recovery before resuming Google publication.
- [ ] Staging `npm run smoke` prints `SMOKE TEST PASSED` and accepts the real LINE HMAC.
- [ ] Production `npm run smoke` prints `SMOKE TEST PASSED` and accepts the real LINE HMAC.
- [ ] Fresh-account rehearsal proves deployment from `docs/runbooks/deployment.md` using customer-owned resources.
- [ ] One production external-service credential is rotated using `docs/runbooks/credential-rotation.md` without code changes, then verified through authenticated `/setup` and `npm run smoke`.
- [ ] Rotate production `ADMIN_ROUTE_TOKEN`: the old token returns HTTP 401; the new token authenticates `/setup` and `/usage`; production smoke passes with the new token.
- [ ] `docs/runbooks/operations.md` records both native Cloudflare Notification policies: Billing Usage Alert and R2 Storage.
- [ ] Authenticated production `GET /usage` returns a validated monthly report with plausible `estimatedThb` (expected ฿0–1000 before traffic).
- [ ] Customer staff receive printed `SNAZZY_PRODUCT_START_V1` marker cards and confirm marker placement in a live test shoot.
- [ ] Customer walks through `docs/runbooks/operations.md`, `docs/runbooks/album-rotation.md`, and `docs/runbooks/credential-rotation.md` at least once.
- [ ] Airtable, Google, LINE, Anthropic, Cloudflare, and iCloud credentials are confirmed customer-owned, not contractor-owned.
