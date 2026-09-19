# Final LINE fix wave

## Scope

Completed the inherited final-review fixes without replacing the in-progress
durability design. The only completion change made in this pass was the stale
sale-recovery guard in `resolveSoldout`: a new command whose initial read sees
another completed sale matching its proposed values is rejected; only a retry
whose durable intent already existed can recover that match.

## Findings and changes

1. **LINE buttons length** — `replyButtons` sends the exact confirmation as
   ordinary text message(s) and uses a short buttons-template prompt; template
   text is always at most 160 characters, while `altText` is constrained to
   400. The client tests assert exact revert detail delivery and LINE message
   limits.
2. **One active mutation per product** — migration `0004` adds a partial unique
   index over `pending`/`applying` product rows. `createPending` atomically
   expires elapsed `pending` rows for that product before inserting. Applying
   rows remain owners and conflict safely across soldout and revert flows.
3. **Malformed product IDs** — parser now validates full ID candidates, so
   suffixes/additional malformed IDs (`A-1-2`, `A-1.2`, `A-1 A-02`) fail rather
   than allowing a valid numeric prefix through.
4. **Elapsed pending commands** — the same atomic cleanup permits replacement
   soldout/revert preparations after expiry; it deliberately never expires
   `applying` work.
5. **Revert recovery ownership** — once a revert is claimed, read/write
   uncertainty never resets it to pending. Exact restored values remain
   recoverable on a retry.
6. **Legacy `In` values** — Airtable sale-value validation accepts historical
   `In` records with retained sale fields and writes them back exactly; new
   `Out` values still require a positive integer price and non-empty sale time
   and actor.
7. **Webhook batch reply failures** — replies are persisted independently of
   event claims before delivery. Each event is protected individually, so later
   events still run after a failed reply; redelivery only re-sends the saved
   reply. Correlation-ID generation is now inside that protection.

## RED evidence

The inherited wave contained focused parser/client/Airtable regressions and
real-D1 recovery/webhook regressions. I confirmed the remaining RED state with:

```text
npm test -- test/line/parser.test.ts ... test/line/recovery.test.ts ...
FAIL test/line/recovery.test.ts
does not mistake a stale prepare matching another completed sale for its own recovered write
expected 2 to be 1 (line_actions)
```

The failing case proved a stale new prepare could finalize a second action when
its values happened to match an earlier completed sale. The recovery test was
already present in the inherited change set; the targeted production guard made
it pass while preserving the uncertainty-retry case.

## GREEN evidence

```text
npm test -- test/line/recovery.test.ts
11 passed

npm test -- test/line/parser.test.ts test/line/client.test.ts \
  test/line/airtable-inventory.test.ts test/line/soldout.test.ts \
  test/line/revert.test.ts test/line/webhook.test.ts \
  test/line/recovery.test.ts test/db/line-repository.test.ts \
  test/db/line-recovery-migration.test.ts test/acceptance/line-acceptance.test.ts
163 passed

npm run typecheck
passed

npm run check
passed (638 tests)
```

The full check emitted existing Miniflare/Workers workflow uncaught-runtime
warnings, but exited successfully and reported all 638 tests passing.

## Files

- Production: `src/db/line-repository.ts`, `src/line/airtable-inventory.ts`,
  `src/line/client.ts`, `src/line/parser.ts`, `src/line/revert.ts`,
  `src/line/soldout.ts`, `src/line/webhook.ts`
- Migration: `migrations/0004_line_recovery.sql`
- Coverage: LINE client/parser/inventory/soldout/revert/webhook/acceptance,
  repository migration, and end-to-end recovery tests.

## Self-review and residual risk

- The partial unique index is the durable serialization boundary; the migration
  intentionally fails closed if pre-existing data contains two `applying`
  owners for one product, rather than releasing either uncertain write.
- Reply delivery can still fail repeatedly for an expired LINE reply token. The
  saved outcome prevents re-running the mutation, and the batch continues, but
  a later delivery channel would be needed if guaranteed human notification is
  required.
- No new dependency, queue, or retry subsystem was added.
