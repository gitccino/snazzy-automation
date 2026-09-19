# Task 0 report: Register operational scripts

## Implementation

Added the three requested operational scripts to `package.json`:

- `setup:verify`: `tsx scripts/verify-airtable-schema.ts`
- `smoke`: `tsx scripts/smoke-test.ts`
- `test:acceptance`: `vitest run test/acceptance`

All existing scripts were preserved. No `usage:alarms` script was added, per the brief.

## Tests/results

- Focused registration check: PASS (`operational scripts registered`)
- `npm run check`: PASS
  - Typecheck passed.
  - 61 test files passed.
  - 638 tests passed.

The test run emitted existing Cloudflare/Miniflare uncaught-exception and missing-sourcemap warnings before completing successfully; they did not fail the check.

## Files changed

- `package.json`
- `.superpowers/sdd/2026-09-01-snazzy-hardening-handoff/task-0-report.md`

## Self-review

- Confirmed the exact script names and command values match the task brief.
- Confirmed the diff is limited to the requested package script registrations.
- Confirmed no existing script was removed or changed.

## Concerns

- The newly registered scripts depend on implementation files/tasks supplied elsewhere; this task only registers them.
- Existing test-run warnings noted above remain outside this configuration-only change.
