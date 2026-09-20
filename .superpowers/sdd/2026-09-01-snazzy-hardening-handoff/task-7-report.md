# Task 7 report

## Delivered

- Added public `GET /health`, authenticated `GET /setup`, and authenticated one-time `POST /setup/bootstrap-sequence` routes.
- The setup report keeps the eleven required check names, including D1 checks for `line_event_replies` and `usage_metrics`.
- Google validation uses direct service-account authentication and rejects My Drive folders; it verifies exact organizer membership, Shared Drive capabilities, the template parent/type, and a disposable copy/edit/rename/delete rehearsal.
- Added the post-deploy `npm run setup:verify` CLI wrapper.

## TDD evidence

- RED: `npx vitest run test/routes/setup.test.ts test/routes/health.test.ts` failed because both new route modules were absent.
- GREEN: focused suite passed: 2 files, 8 tests.

## Verification

- `npm run check` passed: 66 files, 672 tests; `tsc --noEmit` passed.
- The test runner emitted existing Miniflare workflow-engine cancellation messages and an existing third-party sourcemap warning, but exited successfully with all tests green.

## Deployment follow-up

Run `ADMIN_ROUTE_TOKEN="$ADMIN_ROUTE_TOKEN" npm run setup:verify` with `WORKER_BASE_URL` set after deploying to each customer environment. Local tests cannot prove the customer Shared Drive role or remote R2 asset availability.
