# Task 3 report: Personal My Drive requests

Removed `supportsAllDrives` from copy, rename, and delete requests, and removed both `supportsAllDrives` and `includeItemsFromAllDrives` from temporary-document lookup. Updated the Google Docs tests to assert those parameters are absent. Pagination, query escaping, the `appProperties.publicationRunId` recovery tag, and 404 cleanup handling remain unchanged.

## Validation

- TDD red: `npx vitest run test/publication/google-docs.test.ts` failed in the six expected request-parameter assertions before the implementation change.
- TDD green: the same focused command passed (27 tests).
- `npm test`: 705 passed, 8 failed across 3 files. Five existing `test/routes/setup.test.ts` failures recur (invalid/missing service-account JSON). Three additional tests have expectations for the removed Shared Drive flags: `test/publication/service.test.ts` exhaustion cleanup, and two cases in `test/acceptance/publication.test.ts` (cleanup after exhausted Google 503 attempts and workflow restart). These are outside the two assigned files and were not modified.
- Vitest also logged Miniflare uncaught workflow errors and a missing sourcemap warning during the full suite.

## Self-review

Diff is limited to the two assigned source/test files. Assertions cover every requested Drive operation; lookup's two-page recovery test checks both paginated requests. Existing recovery and missing-file behavior is retained.

## Fix round 1

Updated only `test/publication/service.test.ts` and `test/acceptance/publication.test.ts`; their cleanup URL assertions now expect the My Drive delete URL without `supportsAllDrives`.

Validation:

- Before the assertion updates, `npx vitest run test/publication/service.test.ts test/acceptance/publication.test.ts` failed in the three reported cases: one service cleanup test and two acceptance restart cases (503 and 429).
- After the updates, `npx vitest run test/publication/google-docs.test.ts test/publication/service.test.ts test/acceptance/publication.test.ts` passed: 3 files, 80 tests.
- Vitest emitted the existing missing sourcemap warning.
