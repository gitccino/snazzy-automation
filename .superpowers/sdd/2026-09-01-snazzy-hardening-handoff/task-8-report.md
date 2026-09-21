# Task 8 report

## Delivered

- Added approved cost configuration parsing with exact defaults and camel-case `AppConfig` mapping.
- Added pure monthly cost reporting for Claude input/output tokens and all-time retained R2 bytes.
- Added authenticated `GET /usage`; bearer verification runs before D1 and config access.
- Registered `GET /usage` in the native router.

## TDD evidence

- RED: `npx vitest run test/monitoring/usage-report.test.ts test/routes/usage.test.ts` failed because both new modules were absent.
- GREEN: focused cost, route, and config suites pass (16 tests).
- Full verification: `npm run check` passed (exit 0).

## Coverage

- Defaults and string-to-number mapping for all approved cost settings.
- USD/THB arithmetic, breakdown fields, and strict over-budget threshold.
- Exact bearer authentication short-circuits before unavailable D1/config dependencies.
- Retained R2 cost includes a prior-month `r2_bytes_added` increment through the all-time total.

## Note

The brief's first illustrative assertion labels a 362.70 THB estimate as over a 1,000 THB budget; implementation follows its stated `estimatedThb > monthlyBudgetThb` rule, so that case is correctly not over budget.
