# LINE reply result outbox

Immediate command and button responses use Reply API. `/upload` and `/docs` keep their original start cards; their final results wait in D1 for the originating allowed group's next message. Ordinary text, images and stickers can trigger one oldest result. Postbacks do not drain results. A command's response goes first in the same request; if the combined bundle exceeds five objects, the result waits. Quiet groups wait indefinitely. There is no push fallback or timer.

## Inspect safely

Tables contain business notification content. Use owner-only access and private local output; never paste full `messages_json`, `result_json`, reply tokens or credentials into shared logs.

```sql
SELECT sequence, result_key, group_id, state, owner_event_id, created_at
FROM line_result_outbox WHERE state != 'accepted' ORDER BY sequence;
SELECT event_id, group_id, workflow_id, candidate_sequence, phase, updated_at, request_id, http_status, disposition
FROM line_reply_dispatches ORDER BY updated_at DESC LIMIT 30;
```

- `pending`: available for the next eligible message.
- `reserved` / dispatch `prepared`: composition saved; dispatch has not begun.
- `dispatched`: send fence crossed; acceptance may be unknown. A crash here must not cause replay.
- `accepted`: LINE accepted the request; this does not prove anyone read it.
- `uncertain`: send outcome could not be determined. Holds newer results in that group.
- `blocked`: invalid payload or configuration rejection needs investigation. Holds newer results too.
- Dispatch `rejected`: explicit LINE rejection. Invalid token / HTTP 429 returns its bundle to pending for a fresh event. Never retry that token.
- Dispatch `abandoned`: preparation safely cancelled before dispatch; old execution cannot cross its send fence.

Normal command responses still work while an older result is held. Inspect the owner Workflow and LINE request ID. A 401/403 is configuration-blocked; a 5xx/network interruption is uncertain. Do not assume all 429s mean monthly quota: inspect LINE's own evidence. HTTP status and a bounded LINE request ID are retained; raw provider message bodies are deliberately not retained. Publication uncertainty logs retain only sanitized original/cleanup error codes.

## Exact owner disposition

Use an owner-authenticated Wrangler session from the repository root. This procedure has D1 write authority and is not available to LINE users. Select the explicit target (`local`, `staging`, or `production`); remote targets require the corresponding configured D1 database and Wrangler account access. Confirm the account and database mapping privately first:

```sh
npx wrangler whoami
npx wrangler d1 list
# Choose exactly one; replace TARGET with local, staging, or production.
# For local use --local and omit --env. For remote use --remote --env TARGET.
npx wrangler d1 execute snazzy-automation-TARGET --remote --env TARGET --command "SELECT sequence, result_key, group_id, state, owner_event_id, created_at FROM line_result_outbox o WHERE state != 'accepted' AND NOT EXISTS (SELECT 1 FROM line_reply_owner_dispositions d WHERE d.sequence=o.sequence) ORDER BY group_id, sequence" --json
```

Compare the group and oldest unresolved sequence with the originating job and the intended environment. Create a private JSON input file (mode 600) containing the exact values from that row; use a JSON editor to escape values correctly. Do not include a reply token or message body. This command is read-only unless `decision` is present:

```json
{"groupId":"GROUP_ID","sequence":123,"eventId":"OWNER_EVENT_ID"}
```

```sh
chmod 600 owner-input.json
npx tsx scripts/line-reply-owner.ts TARGET < owner-input.json
```

The output includes the saved workflow ID, dispatch phase, request ID, HTTP status, provider disposition and any existing owner disposition. If it returns no row, stop and recheck the exact target and identifiers. Inspect the named LINE command Workflow using its saved ID and the environment's Workflow name from `wrangler.jsonc`, for example:

```sh
npx wrangler workflows instances describe snazzy-line-command-staging WORKFLOW_ID --env staging --step-output=false
```

Workflow output can contain sensitive details; keep it private. Compare LINE's request evidence and the saved phase. Confirm the Workflow is terminal or explicitly terminated with authorization before closing a prepared reservation; elapsed time alone is insufficient. If evidence establishes LINE accepted the exact request, choose `confirmed_acceptance` (acceptance does not prove reading). If the outcome cannot be established and the owner accepts that the notification may have been missed, choose `close_unverifiable`; this does not assert delivery. Neither choice resends the result. Record an identifiable owner and a concise evidence-based reason, excluding tokens and message bodies. Add these fields to the private JSON file:

```json
{"groupId":"GROUP_ID","sequence":123,"eventId":"OWNER_EVENT_ID","decision":"close_unverifiable","actor":"OWNER_ID","reason":"Evidence reviewed; outcome cannot be established"}
```

Run the same command again. `recorded: true` confirms the guarded write; false means the tuple, state or FIFO head changed, or a disposition already exists. Reinspect rather than retrying blindly. The immutable disposition excludes this result from FIFO; the next eligible real group message may drain the next pending result. A later provider receipt remains evidence and cannot reopen the closed result. Remove the private input file when no longer needed.

## Pre-dispatch recovery

An owner must first confirm the saved Workflow is terminal, or explicitly terminate it with authorization. Do not use elapsed time as evidence. Confirm dispatch phase is `prepared` and its result is `reserved` by that exact event. Then use the repository's `abandonPrepared(eventId)` in an owner-controlled execution against the selected DB. It uses an atomic batch to mark the dispatch abandoned and release only its own reserved result; `beginDispatch` on the old event subsequently fails. No public repair endpoint or automatic lease exists.

Do not clear the event row or reset a dispatched/uncertain result to pending. Investigate the exact send; any manual reconciliation needs explicit operator authorization and preserved evidence. A failed receipt write can leave `dispatched` even though LINE accepted it. There is no safe automatic resend in that case.

## Job and persistence recovery

Import/publication business state and notification state are separate. D1-only persistence steps retry twice with one-second delays. A failed enqueue never repeats numbering, import writes, image work or Google document work. Inspect the saved Workflow terminal snapshot before repair. Retry persistence with that exact payload, original group, date and result key; do not reconstruct from current Airtable or changed Settings.

Result key: JSON `[kind, runId, generation, notificationCycle, "terminal"]`. An identical enqueue is a no-op. Conflicting content is an operational error, never an overwrite. Imports use cycle 1. An intentional failed/validation-failed publication restart increments its notification cycle atomically, so its later result does not replace the previous attempt's result. A deliberate retry of an errored job that already queued an unconfirmed notice also allocates a new cycle, even when failed cleanup left its business state generating; existing recovery data stays intact. Successful regeneration still uses the existing new generation. Paused resume and notification-only repair must retain the original cycle.

Use the saved snapshot to call `enqueueResult` through an owner-controlled execution if the platform cannot resume the persistence step alone. A normal `/docs` restart is a new business attempt, not notification repair. Cleanup failure produces an `unconfirmed` notice and preserves the original business error; it does not claim a document was deleted or a job completed. Current Anthropic/Google credential errors require separate fixes.

## Rollout and rollback

Do not deploy or migrate from this runbook without separate rollout approval.

1. Record Worker version and private settings backup; export D1 privately. Inspect import, publication and LINE Workflow instances. Drain incompatible old executions or document their previous push behavior; never terminate them merely to simplify release.
2. Apply additive `0013_line_reply_outbox.sql` using the staging migration command, then deploy the reviewed Worker. Do not change Settings values. Pre-cutover LINE payloads without `receivedAt` are suppressed rather than adopted; finish old commands before cutover. No historical result backfill.
3. Verify queue tables and notification-cycle column. With explicit live-message authorization, exercise an unchanged start card, queued completion, later same-group message and webhook redelivery. Confirm `/message/reply`, one acceptance receipt, no push, correct permissions, and no cross-group delivery.
4. For rollback, first stop admissions through the existing maintenance mode and resolve/stop queue-enabled executions with operator authorization. Keep all queue and dispatch rows. Rolling back code requires reviewing in-flight payload compatibility and preventing older code from resending commands; do not blindly roll back into legacy push recovery. Retain the additive schema. An unresolved send remains held until investigated.

Unrelated asynchronous mutation-followup conflict alerts still use the existing push mechanism. This feature does not make the entire app push-free. No automatic retention cleanup is enabled.
