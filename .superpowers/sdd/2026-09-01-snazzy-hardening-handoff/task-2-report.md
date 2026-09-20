# Task 2 report: usage-metrics wiring

## Claude usage RED/GREEN

- RED: `npx vitest run test/publication/captions.test.ts -t "records Claude"` failed as expected: `getMonthlyUsage(...).claude_input_tokens` was `undefined`, not `500`.
- GREEN: `npx vitest run test/publication/captions.test.ts` passed: 16 tests.
- `requestCaptionBatch` records input and output tokens after a completed SDK response, using `todayBangkokDate(clock)`. `generateCaptionsForRun` forwards optional usage context, and the production batch loop supplies the service D1/clock context.

## R2 bytes RED/GREEN

- RED: `npx vitest run test/import/asset-store.test.ts -t "newly created R2"` failed as expected: `r2_bytes_added` was `0`, not `2_500_000`.
- GREEN: `npx vitest run test/import/asset-store.test.ts test/publication/captions.test.ts` passed: 24 tests.
- `putIfAbsent` records `body.byteLength` only after the conditional R2 `put` returns an object. A `null` result returns `created: false` without a metric. Import and publication workflows pass D1; direct constructors remain compatible through an optional D1 parameter.

## Verification

- `npx vitest run test/acceptance/publication.test.ts` passed: 11 tests.
- `npm run check` passed: typecheck and 642 tests across 62 files.
- `git diff --check` passed.

## Files

- `src/publication/captions.ts`
- `src/publication/service.ts`
- `src/publication/workflow.ts`
- `src/import/asset-store.ts`
- `src/import/workflow.ts`
- `test/publication/captions.test.ts`
- `test/import/asset-store.test.ts`

## Self-review and concerns

- Traced every `createAssetStore` caller and every production caption request caller; both production paths carry D1 and the existing clock.
- The SDK guarantees `usage`; the small `response.usage` guard preserves older synthetic acceptance fixtures that omit it. Real SDK responses continue to record both counters.
- `npm run check` emits pre-existing Miniflare workflow/sourcemap warnings but exits successfully with all tests passing.

## Fix round 1: best-effort metric persistence

- Controller policy: metrics are observability only. Failed D1 writes must not retry a paid Claude request or an R2 object that was already committed.
- RED: `npx vitest run test/publication/captions.test.ts test/import/asset-store.test.ts -t "metric persistence fails"` failed as expected: both operations rejected with `Error: D1 unavailable`.
- GREEN: `npx vitest run test/publication/captions.test.ts test/import/asset-store.test.ts -t "persistence"` passed: 2 tests; the full two-file command passed: 26 tests. The Claude test makes input-token persistence succeed and output-token persistence fail, proving the completed caption request is not retried. The R2 test proves `putIfAbsent` returns `created: true` (then `false` on the duplicate) when D1 metric persistence fails.
- Implementation: both side effects now catch metric persistence errors, emit only `Usage metric recording failed`, and retain a `ponytail:` comment naming a durable outbox as the billing-grade upgrade path. The paired Claude writes share one best-effort boundary, so any partial failure cannot trigger another Anthropic request.
- Full verification: `npm run check` passed: typecheck and 644 tests across 62 files. `git diff --check` passed.
- Concern accepted by controller: an unavailable D1 can leave usage undercounted (and a partial Claude pair remains possible); a durable outbox is required if billing-grade accuracy becomes necessary. Existing Miniflare workflow/sourcemap warnings remain non-fatal.
