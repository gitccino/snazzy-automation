# Task 9 report: retry-safe conflict-checked `/revert`

## Implementation summary

Created `src/line/revert.ts` with a confirmation-only revert flow. Preparation selects the latest unreverted sold-out action for the requester's LINE group, confirms the Airtable sale state still matches the action, and saves a ten-minute pending command containing the exact before/after values and target action ID.

Approval claims the pending command, refuses conflicts rather than overwriting Airtable, restores the exact original values, finalizes the reversible action, and treats an already-restored Airtable record as recovery from a previous post-write D1 failure. Once an Airtable write might have occurred, applying ownership remains intact on errors so the same event can retry safely.

## Files

- Created `src/line/revert.ts`
- Created `test/line/revert.test.ts`

## RED evidence

Command:

```text
npx vitest run test/line/revert.test.ts
```

Observed expected failure before implementation:

```text
Error: Cannot find module '../../src/line/revert'
```

## GREEN evidence

Command:

```text
npx vitest run test/line/revert.test.ts
```

Result: 1 test file passed; 5 tests passed.

## Full check

Command:

```text
npm run check
```

Result: passed (`tsc --noEmit`; 56 test files and 548 tests passed).

## Self-review

- Confirmation buttons encode the `revert` action and only use a saved target from the same group.
- Preparation and approval compare all four persisted sale fields through `matchesSaleValues`, preventing a newer Airtable edit from being overwritten.
- A missing target action is explicitly rejected without Airtable mutation or action finalization.
- The already-restored state retries finalization without repeating the Airtable update.
- Errors before a potentially applied Airtable side effect reset the pending claim; errors after that boundary retain applying ownership.
- New files pass whitespace validation (`git diff --check` equivalent against `/dev/null`).

## Commit

```text
b1cc7df feat(line): add retry-safe revert
```

## Concerns

- The full Vitest run emitted the existing missing Standard Webhooks sourcemap notice and Miniflare workflow teardown diagnostics (`Engine was never started`, `instance.not_found`, and a canceled-request message). The command exited 0 with all tests passing.
- `/revert` command routing is intentionally not changed here; this task owns only the reusable preparation/resolution flow.

## Fix Round 1: atomic latest-target claim and duplicate preparation recovery

### Scope

- Updated `src/db/line-repository.ts`
- Updated `src/line/revert.ts`
- Updated `test/db/line-repository.test.ts`
- Updated `test/line/revert.test.ts`

### RED evidence

Command:

```text
npx vitest run test/db/line-repository.test.ts test/line/revert.test.ts
```

Observed expected failures before the production changes:

- A revert prepared for one sold-out action was claimed even after a newer unreverted sold-out action was finalized for the same group.
- The second of two concurrent `prepareRevert` calls returned the duplicate-confirmation text instead of the saved confirmation buttons.

### GREEN evidence

Command:

```text
npx vitest run test/db/line-repository.test.ts test/line/revert.test.ts
```

Result: 2 test files passed; 22 tests passed.

### Full check

Command:

```text
npm run check
```

Result: passed (`tsc --noEmit`; 56 test files and 551 tests passed).

### Self-review

- The single `UPDATE ... RETURNING` that transitions a pending command to `applying` now requires a revert target to be the latest unreverted sold-out action in its group. It uses the same descending `created_at, rowid` ordering as `latestReversible`.
- The latestness predicate applies only to a `pending` transition. An already-applying same-event retry remains valid if a later action was written after ownership was claimed, as required.
- `finalizeAction` retains its existing target group, product, type, and unreverted-state validation. Its malformed/invalid-pending tests now set up owned applying rows directly, because the stronger claim gate correctly rejects those rows earlier.
- When `createPending` loses the initial-read/insert race, `prepareRevert` reloads by source event and returns the durable revert confirmation. A concurrent preparation test verifies both callers receive the same token/buttons.
- A declined claim exits `resolveRevert` before any Airtable read, update, or D1 finalization; the revert unit test covers that no-write path.

### Remaining concern

- Airtable has no compare-and-swap update. The revert flow still performs its scoped immediate pre-write comparison, but a human edit can occur after that read and before PATCH; this residual external TOCTOU risk is intentionally not addressed with a local lock.
