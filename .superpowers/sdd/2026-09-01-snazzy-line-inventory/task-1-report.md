# Task 1 report: LINE domain types and uppercase configuration contract

## Implementation summary

Added the LINE domain contracts and supported webhook event parser from the approved brief. Extended the uppercase configuration schema and runtime mapping with `SOLDOUT_CONFIRMATION_ENABLED` (defaulting to `true`), and added the `LINE_CHANNEL_SECRET` environment binding. Existing `LINE_ALLOWED_GROUP_ID`, `AppConfig.lineAllowedGroupId`, and `Env.LINE_CHANNEL_ACCESS_TOKEN` interfaces were preserved.

## Files

- Created `src/line/types.ts`
- Modified `src/config.ts`
- Modified `src/env.ts`
- Created `test/line/types.test.ts`
- Modified `test/config.test.ts`

## RED evidence

Command:

```text
npx vitest run test/line/types.test.ts test/config.test.ts
```

Expected failure observed before implementation:

- `test/line/types.test.ts`: `Error: Cannot find module '../../src/line/types'`
- `test/config.test.ts`: existing config deep-equality lacked `soldoutConfirmationEnabled`; mapping test received `undefined` instead of `false`.

## GREEN evidence

Command:

```text
npx vitest run test/line/types.test.ts test/config.test.ts
```

Result: 2 test files passed, 12 tests passed.

## Full check

Command:

```text
npm run check
```

Result: passed (`tsc --noEmit`; 48 test files and 447 tests passed).

The full run emitted the known noisy Miniflare workflow teardown messages:

```text
uncaught exception; source = Uncaught (in promise); stack = Error: Engine was never started
uncaught exception; source = Uncaught (in promise); stack = Error: Engine was never started
uncaught exception; source = Uncaught (in promise); stack = Error: instance.not_found
uncaught exception; exception = workerd/io/io-context.c++:1624: failed: jsg.Error: The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response.
```

## Self-review

- The implementation matches the brief's type definitions and Zod validation shape.
- Unsupported, malformed, and non-group events are filtered; valid group text/postback events are retained.
- The existing group ID mapping and access token binding were not duplicated or renamed.
- `git diff --check` passed.

## Concerns

- The existing Vitest environment emits a missing Standard Webhooks sourcemap notice and the known Miniflare teardown noise; neither causes test failure.

## Fix Round 1

Added a valid group postback event fixture (`e3`) and updated the parser assertion to require both the valid text event (`e1`) and postback event (`e3`). This directly covers the postback acceptance branch identified in review.

Covering tests: `test/line/types.test.ts`, with directly impacted `test/config.test.ts` rerun.

Commands and results:

```text
npx vitest run test/line/types.test.ts test/config.test.ts
2 test files passed; 12 tests passed

npm run check
tsc --noEmit passed; 48 test files passed; 447 tests passed
```

The full check again emitted the known Miniflare teardown messages (`Engine was never started`, `instance.not_found`, and the workerd canceled-request message) plus the existing missing Standard Webhooks sourcemap notice.
