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
