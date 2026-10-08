# Recover unfinished LINE inventory operations

Status: Draft for user review. This spec does not authorize implementation or deployment.

## Intent

Resolve review case 4: an interrupted `/soldout` or `/revert` can leave `pending_line_commands.status = applying`, preventing later operations for the same product. Recover using the old Cloudflare Workflow's execution status and Airtable's current sale values. The user wants new commands to proceed without an indefinite lock caused solely by an abandoned operation.

Agreed behavior for an old sale at 12,000 baht and a new sale at 13,000 baht:

- If Airtable contains the old sale's exact intended values, complete its D1 history and mark it `approved`. The new sale receives the normal already sold response.
- If Airtable still contains the exact original values and the old Workflow has ended, mark the old operation `failed`, release ownership, and process the new command normally, including confirmation where enabled.
- If an old update has an unknown outcome, arrange automatic follow-up checks. Repair a recognizable late old write to the latest successfully confirmed operation's values.
- A newly received message or an unapproved confirmation does not count as a confirmed operation.

## Context and corrections to earlier advice

The existing durable command Workflow makes an initial attempt and two retries, after 30 seconds and then 1 minute. The same apply event can resume a partially finished mutation. Exhaustion does not reconcile abandoned `applying` rows. Cloudflare status `complete` can contain an application outcome of `failed`.

D1 stores the before/after sale values and the original apply event. A unique partial index allows only one `pending` or `applying` operation per product. Finalization records the action, approval, audit, and revert linkage together. Pending confirmation expiry does not expire an `applying` operation.

Airtable's actual available status is `In`, not `Available`. Compare the complete sale tuple: Inventory Status, Sold Price, Sold At, and Sold By. An `In` record may retain historical sale details; do not reduce comparison to status alone.

A request timeout indicates a missing response, not a rejected update. A stopped Workflow cannot cancel a request already received by Airtable. Reading original values after it stops does not prove that no late write will occur. Follow-up checks provide best-effort correction; they cannot establish a permanent guarantee against every delayed write.

## Approach and alternatives

### Selected: recovery on the next command, with follow-up checks

Reuse the inventory adapter, D1 command/action history, durable Workflow steps, sale-value comparison, and atomic finalization. Add only the persisted request evidence and recovery coordination necessary for safe ownership changes. A durable follow-up execution handles uncertain superseded writes without extending the user's command response wait.

### Alternative: scheduled scanner for every unfinished operation

This can recover without a new command, but requires broader scanning, scheduling, and execution coordination. Defer it; follow-up executions created for uncertain writes are sufficient for this scope.

### Alternative: leave every uncertain write locked for manual resolution

Simpler to reason about, but inconsistent with the user's requested automatic release and new-command behavior.

## Scope

Cover abandoned applying sale and revert operations encountered during normal inventory command preparation or confirmation. Preserve existing parsing, authorization, confirmation, already sold responses, and the two-retry command policy. Recover the product needed by the incoming command; do not change `/revert`'s existing target selection to an arbitrary product.

Do not reopen failed old confirmations, replay an old price during scenario 2, add a new user command, change Airtable fields, or expire active Workflows based only on elapsed time. Ordinary provider outages can still prevent processing; the promise is removal of stale operation locks, not guaranteed availability.

## Persisted state

### Operation resolution

Add terminal operation status `failed`, with resolution reason and timestamp. Failure reasons distinguish replacement, conflicting current data, and missing product. Preserve original token, apply event, actor, snapshots, and target action for audit. A failed operation is excluded from active ownership indexes and cannot later approve or finalize through an old event.

The existing SQLite CHECK constraint must be migrated explicitly; extending the TypeScript union alone is insufficient. Preserve all existing rows, indexes, uniqueness, and foreign relationships during migration.

### Airtable update attempts

Persist each sale/revert PATCH attempt before sending it, including operation token, immutable attempt ID, record ID, intended sale values, start time, and outcome. Use:

- `unknown`: attempt intent saved; no definite outcome has been durably recorded.
- `acknowledged`: successful provider response received.
- `rejected`: response contract definitively indicates the write was not accepted.

A timeout, connection failure, ambiguous server error, or interruption before saving the response remains `unknown`. Do not classify every non-2xx response as rejection. An interruption after recording intent but before sending also remains unknown; a conservative false positive is acceptable.

Record response/error category and completion time where available. Do not save access tokens or full provider responses. Evaluate all attempts: one later rejection does not erase uncertainty from an earlier attempt. Acknowledged writes still require comparison of current Airtable values during recovery.

Associate new operations with the actual command Workflow instance ID. For existing rows created by the durable command path, the ID can be derived from the original apply event using the existing stable ID convention. Legacy pre-Workflow rows must be identified explicitly; absence of an instance is not proof that a recent execution stopped.

## Ownership and recovery sequence

1. Validate the incoming command and allowed group normally. Locate any applying operation for its target product.
2. Query the original command Workflow. `queued`, `running`, `waiting`, `paused`, `waitingForPause`, and any other nonterminal status retain ownership. Return a short processing response rather than starting another mutation.
3. Only `complete`, `errored`, or `terminated` permit recovery. A status lookup error or unexpectedly missing instance produces a temporary diagnostic response, not silent takeover. For verified legacy operations with no Workflow owner, use recorded provenance; unknown provenance needs operator resolution without pretending the operation is active.
4. Acquire recovery ownership with an atomic D1 compare-and-set on the old token, apply event, and status. Use the recovering command's durable instance as the owner, so its retries resume the same recovery. A concurrent command that loses acquisition rereads the state; it does not execute a second recovery.
5. Prevent restarts of the original Workflow from mutating a superseded operation. Every mutation/finalization path must revalidate operation ownership; old confirmation tokens cannot reopen terminal operations. Administrative restarts while recovery is in progress are unsupported and must be documented.
6. Read Airtable after establishing that the original execution is terminal. Compare current sale values with the immutable before/after snapshots.
7. Atomically resolve the old operation and release recovery ownership. Continue the incoming command from a fresh inventory read, not a stale cached product. When creating its confirmation, preserve normal product uniqueness and validation.

Recovery acquisition must have a recovery path of its own: a later command can resume it only after its owning Workflow ends. Do not introduce a second permanent lock, or allow a generic lease expiry to bypass an executing owner. Every terminal resolution must be conditional on the current recovery owner.

## Decision table

| Current Airtable values | Resolve old operation | Incoming command |
| --- | --- | --- |
| Exactly intended result | Finalize action history and mark approved atomically | Reevaluate current inventory; a new sale sees already sold |
| Exactly original values | Mark failed with replacement reason; register follow-up if any update attempt is uncertain | Continue normally; new price is used |
| Neither snapshot | Mark failed with conflict reason, preserve audit; do not overwrite current Airtable data | Reevaluate current data using normal rules and include a recovery warning |
| Product missing | Mark failed with missing-product reason | Normal product-not-found response |
| Read/status service unavailable | No irreversible recovery transition | Existing retry policy, then an explicit temporary failure response |

For an unfinished revert, matching intended values means finish the revert action and mark its original sale as reverted using the existing finalization contract. Matching original values means fail the abandoned revert, leaving its target sale reversible. Never mark only the pending row approved while omitting the action history.

A conflict ends the old recovery lock; it does not automatically authorize changing staff-edited values. An `Out` product still yields already sold. An `In` product follows normal sale validation and confirmation based on its current values. The new confirmation clearly shows the new price.

## Unknown writes and follow-up repair

Proposed review choice: create a durable follow-up execution keyed by the abandoned operation, with checks at 30 seconds, 1 minute, and 5 minutes after replacement, plus an immediate check after any newer confirmed mutation. Continue all checks even if an earlier check sees no late write. These intervals are a practical detection window, not an Airtable processing guarantee.

Register follow-up durably before releasing an uncertain old operation. Creation failure leaves recovery retryable; do not claim monitoring exists when registration failed. Repeated recovery attempts must reuse the same follow-up execution.

At each check:

1. Reread product ownership and the latest successfully confirmed D1 operation for that product, including reverts. Use a stable per-product committed ordering, not LINE message arrival time or equal wall-clock timestamps.
2. If a normal operation is pending/applying or another repair owns the product, perform no PATCH. Reschedule within the check policy. A repair uses the same product exclusion mechanism as normal mutations and must not expire or replace a user's pending confirmation.
3. If current Airtable matches the latest confirmed values, no repair is needed.
4. Repair only when current Airtable exactly matches a known superseded operation's intended tuple and a newer confirmed operation exists. Write the newer operation's entire tuple, preserving its original actor and sale date. Never treat this as a new sale or append a duplicate sale/revert action.
5. If there is no newer confirmed operation, do not invent one or silently approve a new price. Record and notify that an abandoned update appeared. If current values match neither recognizable tuple, preserve them and report a conflict.
6. Audit each repair. Its PATCH attempts also use request-outcome tracking. A failed or uncertain repair gets bounded durable retries; after exhaustion, notify and persist the unresolved outcome without restoring the old sale's normal command lock.

Do not send a message for successful silent recovery/repair. Send a deduplicated warning for an observed unresolved late update or conflicting values, including Product ID and an instruction to inspect Airtable. Suggested copy: `⚠️ ข้อมูลสินค้า A-16 ไม่ตรงกับรายการที่ระบบยืนยันล่าสุด กรุณาตรวจสอบ Airtable`.

At the end of the checking window, store that monitoring ended, not that all unknown writes were proven rejected. A future normal command may reconcile recognizable stale values again. No unbounded timer or repeated unsolicited LINE warnings.

## Limitations requiring written-spec approval

- Bounded checks can miss a write arriving after the final check. There is no permanent no-overwrite guarantee without provider-side conditional writes or a stronger authoritative mutation architecture.
- A staff edit to the exact same four-field tuple as an old operation is indistinguishable from its late update. A repair could replace that edit. Other conflicting tuples are preserved.
- A staff edit can race between a follow-up read and PATCH. D1 ownership prevents cooperating system commands from racing; it does not lock Airtable's UI. This draft provides best-effort preservation, not guaranteed preservation of concurrent manual edits.
- Unknown provenance and unavailable Cloudflare/Airtable services cannot be safely treated as stopped/unchanged. They produce explicit errors rather than automatic destructive action. The user requirement is no indefinite abandoned-operation lock when evidence is available, not a bypass of all safety checks.
- Proposed timing, conflict warning, and legacy handling are design choices for review, not previously deployed behavior.

## Files and interfaces affected

- `src/line/soldout.ts`, `src/line/revert.ts`: recovery before mutation, superseded-token handling, preserve finalization behavior.
- `src/line/airtable-inventory.ts`: durable request outcome integration for PATCH, existing sale tuple validation/comparison.
- `src/db/line-repository.ts`, `src/line/types.ts`, migrations: failed status, attempt evidence, Workflow owner, recovery coordination, committed ordering, idempotent repair audit.
- `src/line/command-workflow.ts`, `src/routes/line.ts`: propagate owning Workflow identity, query execution status, coordinate follow-up creation and failure responses.
- Follow-up Workflow export, `src/env.ts`, `src/index.ts`, `wrangler.jsonc`: local/staging/production bindings only if a separate Workflow class is selected in the plan. Reuse current Workflow facilities; no new dependency.
- Relevant repository, inventory adapter, soldout/revert, webhook, and Workflow tests; fixture/migration assertions must reflect failed status and attempt evidence.

## Acceptance evidence

- Intended result in Airtable: one finalized action, approved pending row, usual already sold response; no repeat PATCH.
- Original values: failed old row, released product ownership, new 13,000 confirmation; no replay of old 12,000 intent.
- Original values with unknown attempt: same new-command behavior only after durable follow-up registration.
- Active/waiting/paused original Workflow: no takeover; terminal Cloudflare status with failed application output permits recovery.
- Status/read failures and unknown legacy provenance: explicit diagnostic, no blind mutation.
- Both sale and revert recovery preserve actors, snapshots, audit, and reversible-action linkage.
- Two new commands race: exactly one recovery owner and at most one active new mutation. Old replay cannot finalize a failed operation.
- Crash before send, after send, after success response, during finalization, and during recovery: persisted evidence remains sufficient for an idempotent next attempt.
- Late 12,000 write after confirmed 13,000 sale: recognizable tuple repaired to confirmed 13,000 without duplicate history. Latest confirmed revert to In also wins over an old late sale.
- Pending new confirmation and unrelated manual tuples: no repair overwrites them; unresolved state is reported without recreating the abandoned lock.
- Repair network failure, duplicate follow-up creation, and notification retries: bounded retries and stable identity; no falsely recorded success.
- Existing D1 data survives schema migration; active uniqueness remains enforced; normal sale/revert/confirmation flows stay compatible.

Validate with focused automated tests, typecheck, migration execution against representative existing data, and staging fault injection using controlled records. No production fault injection is authorized by this spec.
