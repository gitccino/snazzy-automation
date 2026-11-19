# LINE replies and queued job results

Date: 2026-11-19
Status: User approved the product direction and requested this specification. Implementation planning, application changes and rollout are separate steps.
Branch: `messenger-demo`

## Purpose

Keep normal LINE group operations usable on the Free plan by replying to incoming events instead of sending quota-consuming push messages. Long-running import and publication jobs retain their final notifications until a later message supplies a fresh reply token in the originating group.

Job completion and notification delivery are separate outcomes. A missing or uncertain notification must never rerun work, reverse successful work, or falsely report a completed job as failed.

## Approved behavior

- Immediate responses to all supported commands and their buttons use the Reply API.
- `/upload` and `/docs` keep their existing first message, including current Flex content and wording, sent as a reply. Do not add queue explanations, disclaimers or new start-card text.
- Final success, validation failure, partial-success summary and terminal failure notifications from these jobs are persisted for later delivery instead of pushed. A job that was not started returns its existing immediate validation/refusal response normally.
- A later incoming message from any user in the same allowed group can trigger a queued result. It does not need to be a command or come from the job initiator.
- Choose the oldest queued result first, scoped strictly to that group. Never send it privately or in another group.
- A quiet group retains its results until another eligible message arrives. No timer, cron or automatic push fallback delivers them.
- Preserve current job results, notification content, messenger layout, permissions and existing business-write deduplication.

## Approaches considered

1. **Reply immediately, push final results.** Simple and prompt, but final notifications still consume allowance and can fail under the current LINE 429 condition. This was discussed before the user selected queueing.
2. **Reply immediately, deliver queued results on later group messages — selected.** Uses fresh tokens without pushing. Results survive restarts, but delivery depends on subsequent group activity.
3. **Require a dedicated status command.** Predictable and explicit, but requires an extra deliberate user action. Not selected for this phase; no new status command is required.

Use existing D1 and Workflow infrastructure. A separate Cloudflare Queue, scheduler, website, AI parser or new dependency is unnecessary for this slice.

## Conversation and reply composition

The following details are engineering defaults proposed by this specification, rather than additional user requirements:

1. Ordinary message: reply with at most one oldest eligible final-result bundle. If none exists, remain silent.
2. Supported command: prepare its normal response first, then append at most one oldest queued bundle in the **same** Reply API request if both fit. The command response takes precedence; never omit or truncate it to make room.
3. If the command response consumes the capacity, or preparation cannot finish in time, retain the queued result for a later event. If a command already has a prepared error response, it can accompany a queued bundle under the same capacity rule.
4. Button postbacks retain their own Reply API response and are not queue-drain triggers in this phase. This avoids expanding the approved “later message” trigger into unrelated event types.
5. One reply token has one owner and one outbound reply attempt. Do not let command delivery and queue delivery independently call the Reply API for the same event. Existing quote-error fallbacks must not attempt a second send after a combined reply may have been accepted.
6. LINE allows at most five message objects per reply request. Preserve each final result as an indivisible bundle. The current import/publication final cards each fit in one message object. Refuse unsupported oversized bundles with an operational error before dispatch; never drop their tail or silently split a single result across future messages.
7. Ready results are selected at reply composition time. Do not hold a reply token while waiting for a job to finish. A result queued later waits for the next eligible message.
8. Date/job identity and result content continue to identify the completed run even if notification delivery occurs on another day. FIFO is by durable enqueue sequence, not job start time; tie-breaking must be deterministic. Retried enqueueing preserves the original position.

A final result may therefore appear alongside a different command's response. This is an intentional consequence of delivering on the group's next message. No extra explanation is inserted into existing start cards.

## Eligible incoming events and group boundaries

Verify the LINE signature before using any event. Only currently allowed groups are eligible. Bot messages, redelivered already-handled events and events without a usable reply token must not trigger duplicate sends.

Support incoming LINE message events, including ordinary text and non-text messages such as images or stickers, without downloading their media or storing their conversational content. Use only the event ID, group ID and reply token needed for coordination. Ordinary queue triggers do not need an actor profile lookup or a completion-user permission check. Existing commands and mutations still require their current actor and permission validation; do not turn ordinary text into a privileged command.

Extend the currently text-only group event schema deliberately: non-text messages are queue triggers, not inputs to existing text command parsers. Never fabricate a user ID when a source event lacks one. An event that cannot authorize a command may still serve as an ordinary group trigger, without exposing or executing a command.

Queued results retain their immutable originating group and job identity from the captured operation context. Recheck the current group allowlist before dispatch. If the group was removed, hold its result; do not reroute or silently delete it. A base/configuration change must not retarget an old job or reconstruct its result from unrelated current inventory.

No private-chat support, cross-group aggregation, cron schedules or automatic alerts are introduced.

## Persistent outbox contract

Add an additive D1 outbox and durable reply-dispatch coordination. Exact table/column names are implementation choices. The implementation must represent:

- A unique result key including job kind, durable run/generation identity and terminal-notification identity.
- Original destination group, immutable result data/message bundle, enqueue order/time and schema version.
- Delivery state and associated event/dispatch identity.
- Dispatch attempts and LINE acceptance/error evidence sufficient for safe reconciliation, without logging tokens or complete message bodies.

Repeated Workflow execution/recovery must enqueue the same terminal notification once. A genuinely new run/generation may enqueue a new result. If an early validation refusal is returned directly and no job starts, do not also enqueue a duplicate refusal. Preserve existing job identities and generation rules rather than inferring new identity from a display date alone.

Persist results after business finalization. If enqueueing fails, retry persistence independently using the same result key; do not redo imports, numbering, image processing, captions or Google document publication. The result must not be silently lost because a notification error was swallowed. Queue persistence failure may be an operational Workflow failure, but must remain distinguishable from failure of the business operation.

Do not require LINE access tokens, OAuth secrets or reply tokens in the result payload. Do not persist ordinary incoming message bodies. Reuse current private R2 and document access rules. Store durable asset references where notification URLs can expire; render/refresh signed links at dispatch without rerunning business work. Never make private assets public to accommodate delayed notifications.

No automatic expiry or destructive cleanup is introduced. Preserve pending, accepted and uncertain records for this phase; retention policy can be added separately.

## Concurrency, FIFO and uncertain delivery

The outbox cannot commit atomically with LINE. Do not promise exactly-once display.

Logical states:

- **Pending:** durable and available for selection.
- **Reserved:** selected for a specific incoming event, but outbound dispatch has not begun.
- **Dispatched:** a durable single-send fence was crossed; LINE may have received the request.
- **Accepted:** LINE returned a successful acceptance response. This does not prove every member viewed it.
- **Uncertain:** an interruption/timeout left acceptance unknown.

Atomically reserve at most one oldest result per group. Serialize an unresolved head result so concurrent events cannot send it twice or send newer results ahead of it. A later reservation cannot skip a still-reserved, dispatched or uncertain older result. Ordinary command responses must remain available while the queue head is held.

A reservation can be released only when durable evidence proves dispatch never began. The implementation plan must specify how abandoned pre-dispatch reservations are reconciled; elapsed time alone must never release a dispatched or uncertain send.

Fence each event's combined reply attempt durably before the external call. Do not cache an old token as a way to send the result later. If a Workflow resumes/redelivers, reuse its persisted composition/reservation and do not automatically repeat an already-dispatched reply.

- Success response: mark the queued bundle Accepted and retain its receipt.
- Explicit LINE rejection proving no messages were accepted (including an invalid/expired token or explicit HTTP 429): keep/release that bundle back to Pending for a **new** message event and fresh token. Do not retry the rejected token or push instead. Revalidate/re-render an invalid payload before future dispatch; if it cannot be fixed, hold it as an operationally blocked head rather than repeatedly sending a malformed bundle.
- Network error, ambiguous 5xx outcome, process interruption after dispatch began, or failed acceptance-record persistence: retain the dispatch evidence and hold the result as uncertain. Never automatically make it Pending because a timeout elapsed.
- Uncertain head: surface it through owner-controlled diagnostics; any manual release requires evidence/review of the exact send and explicit operator authorization. No automatic replay/reset utility is required by this feature.

If a combined reply fails, do not rerun the command's already-completed business action. A fresh command event may request current state through normal existing deduplication and business rules.

These conservative rules can delay later queued results after an ambiguous send. That is preferable to silently duplicating a final notification or reordering the queue; the limitation must be recorded in the runbook.

## Application integration

Current integration seams to cover in the implementation plan:

- `src/routes/line.ts`: signed webhook admission and idempotent Workflow handoff, with privacy-preserving non-command/non-text trigger handling.
- `src/line/types.ts`: discriminate commands/text from non-text message triggers without weakening existing command boundaries.
- `src/line/command-workflow.ts`: replace the remaining immediate push-response path with the shared single-owner reply composition and dispatch fence. Preserve mutation safety separately from notification state. Do not apply the old 30-second/one-minute push retry-notice loop to reply tokens.
- `src/line/webhook.ts` / `src/line/client.ts`: render existing command replies into a bounded message-object bundle and issue a single Reply request. Preserve quoting, validation, Flex metadata and all existing command output variants. Keep the push API available for unrelated existing features, but do not call it from the command/terminal-notification paths in this spec.
- `src/import/workflow.ts` / `src/import/notify.ts`: replace terminal summary push with idempotent outbox persistence after existing finalization, covering no-new-products, partial successes and terminal failures.
- `src/publication/workflow.ts` / `src/publication/service.ts`: replace success, validation failure and exhausted-failure notification pushes with durable outbox persistence. Remove silent notification loss while preserving publication outcome and generation identity.
- Additive migrations/repositories and focused acceptance fixtures for outbox/dispatch coordination.

Preserve existing start cards through the current builders. For every producer, document the distinction between immediate “not started” responses and an asynchronously completed run's final bundle. Audit every import/publication terminal path; stopping at the success path is incomplete.

Old queued/running Workflows and saved LINE replies need an explicit compatibility strategy in the plan. Do not redeliver previously pushed historical results into the new queue. No backfill of past completed/failed runs is enabled by default. An already-started old Workflow may still use its previous notification behavior; rollout must account for it before claiming these paths are push-free.

## Acceptance evidence required

1. All immediate commands and button responses use `/message/reply`, preserve existing content/authorization and never attach a push-only retry header.
2. `/upload` and `/docs` keep their original first messages; every terminal outcome persists one final bundle and sends no terminal push.
3. Queue survives Worker restart and Workflow recovery; duplicate enqueueing does not duplicate or reorder a result.
4. Ordinary text and non-text group messages drain one oldest result without storing message content or fetching media. A different sender can trigger it.
5. Another group, a removed group, invalid signatures, missing tokens and unsupported event types cannot drain a result into the wrong destination.
6. A command and queued result share one Reply request with the normal response first. A full five-object command response leaves the result pending. No queue record is lost when composition cannot fit.
7. Concurrent messages, webhook redelivery and Workflow interruption do not duplicate a result. Older unresolved reservations prevent newer queue sends while unrelated command responses still work.
8. Explicit invalid-token/429 rejection preserves the result for a new event; timeouts/ambiguous outcomes hold it. Acceptance-record failure cannot silently release it for replay.
9. Notification persistence/send failure cannot repeat numbering, Airtable writes or publication. Current completion-cycle, actor/group permission and source-quote protections remain covered.
10. A result completed just after selection waits for a later event. A quiet group retains results without a hidden timer/push fallback.
11. Delayed image/document messages retain access controls and usable links without recreating the job. Empty queues remain silent for ordinary conversation.
12. Existing root-suite baseline failures are reported separately from new regressions. Live LINE validation is separate from mocked-provider/local-D1 tests and must be explicitly authorized.

## Rollout and boundaries

This document authorizes no deployment or remote migration. The implementation plan must define additive schema rollout, handling of in-flight Workflows, verification with existing settings preserved, and compatible rollback. Do not erase outbox/dispatch evidence on rollback or replay uncertain messages under an older binary.

This feature does not repair the current Anthropic caption or Google OAuth failures, purchase a LINE plan, introduce private chats, add a Settings screen, enable cron jobs, or bypass LINE API rate limits. Reply messages avoid the monthly counted-message allowance, but remain subject to endpoint/token limits.

## Reference constraints

- [LINE group events and replies](https://developers.line.biz/en/docs/messaging-api/group-chats/)
- [Reply API: single-use fresh tokens and five message objects](https://developers.line.biz/en/reference/messaging-api/#send-reply-message)
- [Message-counting rules](https://developers.line.biz/en/docs/messaging-api/pricing/)
- [Supported retry-key APIs](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/)

## Specification review

A fresh read-only builder check on 2026-11-19 found nothing important left unanswered. The review covered reply ownership, group isolation, FIFO/concurrency, uncertain sends and terminal-notification producer coverage. Engineering defaults above remain identified as specification proposals; no application implementation, live LINE validation or deployment was performed.
