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

## Review fix round 1

- Corrected the Shared Drive membership request to Drive v3 `files/{driveId}/permissions` and paginates every permission page.
- The Google probe now reads and validates the three literal template markers as single text runs. Disposable copies carry a unique `setupProbeId`; successful copies are deleted directly, while response-loss copies are found by that property and deleted.
- R2 verification compares temporary readback bytes and requires the configured collage-base object. Bootstrap now returns a single atomic winner, so concurrent route calls receive one `200` and one `409`.
- TDD RED: the new setup/repository tests failed against the original endpoint, non-paginated lookup, missing marker/recovery checks, weak R2 check, and non-atomic bootstrap. GREEN: focused setup/health/repository suite passed 19 tests.
- `npm run check` passed: 66 files, 679 tests. The existing Miniflare workflow cancellation messages and third-party sourcemap warning remain non-fatal.
