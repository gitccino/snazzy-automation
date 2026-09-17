# Task 10 report — LINE webhook orchestration

## Delivered

- Added `POST /line/webhook` dispatch to the Worker router.
- Added raw-byte HMAC verification before JSON parsing; invalid signatures return 401 and signed malformed payloads return 400.
- Filters the signed payload to supported, schema-valid group message/postback events.
- Claims each supported event before allowlist, profile lookup, or command execution. Duplicate and intentionally ignored events retain their claim; a processing exception releases the claim and rethrows.
- Wires parsed commands through the existing read-only, soldout, confirmation, and revert services while retaining their Thai responses.
- Wires LINE `/upload` and `/docs` to the real internal trigger services.

## Contract decision

The current `src/line/search.ts` types take precedence over the stale adapter examples in the task brief:

- Upload results preserve `importRunId` and all five statuses: `started`, `already_running`, `sequence_not_bootstrapped`, `workflow_start_failed`, and `import_trigger_failed`.
- Docs results preserve `publicationRunId` and `no_runnable_run` unchanged.

## TDD evidence

- RED: `npx vitest run test/routes/line.test.ts test/line/webhook.test.ts` failed because `src/routes/line` and `src/line/webhook` did not exist.
- GREEN: the same command passed with 18 tests.
- Final: `npm run check` passed: typecheck plus 58 test files / 569 tests.

## Notes

The successful full Vitest run emitted existing Miniflare workflow diagnostics (including `Engine was never started` and `instance.not_found`), but exited 0 with all tests passing. No task-specific validation failures remain.
