# Messenger Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Preserve the user's earlier native execution preference unless they change it.

**Goal:** Register messenger deliveries from LINE, show compact daily lists including completed items, and allow configured staff (initially Book) to mark deliveries done safely.

**Architecture:** Airtable `Messenger Deliveries` is authoritative for task details and Pending/Done status. D1 stores immutable write intents, action bindings, connection context, and event deduplication; it is not a second delivery-status database. Reuse the existing LINE command Workflow, sanitized before persistence, without new Workflow bindings, cron jobs, or dependencies.

**Tech Stack:** TypeScript, Zod, Cloudflare Workers/Workflows/D1, Airtable REST API, LINE Messaging API/Flex, Vitest with the existing Cloudflare test pool.

**Spec:** [2026-11-13-messenger-delivery-design.md](../specs/2026-11-13-messenger-delivery-design.md)

## Global Constraints

- “Completed deliveries remain visible in every fresh overview for their scheduled day.”
- “Show `ผู้รับผิดชอบ · เจ` on the same line as the time, aligned right.”
- “No thumbnail, recipient/contact, destination, or retained original message body.”
- “Completion uses a separate configurable LINE user-ID allowlist, initially containing only Book; more users can be added later.” Empty means nobody.
- “Replies and quote actions stay in the originating allowed group.” Revalidate current policy, including older buttons.
- `Asia/Bangkok`; five rows per page; chronological sorting across both statuses. Relative schedules use the original LINE timestamp.
- Sender is responsible. One product/group/scheduled-day task, even if Done. No inventory, price, publication, or product-number writes.
- No undo, deletion, rescheduling, automatic purge, AI inference, new Settings UI, or unsolicited live commands.
- No new provider-write retry loops. Existing command recovery may re-enter services; durable intents must make re-entry safe.
- Implementation approval does not authorize staging or production rollout. Prepare migrations/runbook first; obtain separate rollout authorization before remote writes/deployment.

## Review Focus

1. Crash after claiming a write but before receiving Airtable's response: preserve uncertainty and reconcile, never duplicate (Tasks 3–4).
2. A removed completion user presses an old card whose Workflow captured older settings: deny using current policy (Task 6).
3. Pasted contact details leak through Workflow params, saved replies, or error logs despite being absent from Airtable (Tasks 1, 6).
4. Base/table settings change between rendering and pressing a button: reject stale connection actions instead of updating a different record (Tasks 3, 6).
5. Completion succeeds but the subsequent overview/LINE send fails: preserve Done and report delivery uncertainty accurately (Tasks 4, 6–7).

## File map and execution baseline

New feature files: `src/messenger/{types,parser,airtable,repository,service,card}.ts`; matching tests under `test/messenger/`. Keep boundaries: parser = pure input; Airtable = provider validation; repository = D1 claims/actions; service = orchestration; card = Flex rendering. Do not refactor unrelated inventory modules.

Integration modifications: `src/line/{types,client,webhook,command-workflow,messages,help-card}.ts`, `src/routes/line.ts`, `src/shared/logger.ts`, settings/config/context files listed in Task 2, one additive migration, and existing LINE/settings test fixtures. Inspect exact exported reply types before extending their union; preserve current variants.

- [x] Read spec and this plan, initialize the executing-plans progress ledger, and record `git status` and HEAD. Continue on isolated `messenger-demo`; preserve `.serena/` and other unrelated changes.
- [x] Capture baseline with `npm run typecheck`, `npm test -- --reporter=json --outputFile=/tmp/messenger-baseline.json`, and `npm --prefix apps/settings test -- --run`. Earlier work recorded 28 root failures; rerun rather than assuming that count is current. Record failing test names for exact later comparison.

## Shared contracts

Define in `src/messenger/types.ts` and import rather than redeclaring:

- `MessengerCommand = {type:'mess-register'; productId:string; scheduledAt:string; scheduleType:'Immediate'|'Scheduled'} | {type:'mess-overview'; day:string; page:number}`; all dates resolved before persistence.
- `MessengerInput = {ok:true; command:MessengerCommand} | {ok:false; code:'invalid_messenger_command'}`.
- `DeliveryConnection = {baseId:string; productsTableId:string; deliveriesTableId:string}`.
- `Delivery`: `id`, `recordId`, `productRecordId`, `productId`, `scheduledAt`, `registeredAt`, `scheduleType`, `responsibleUserId`, `responsibleName`, `sourceGroupId`, `sourceMessageId`, `sourceEventId`, `quoteToken:string|null`, `status:'Pending'|'Done'`, `completedAt:string|null`, `completedByUserId:string|null`, `completedByName:string|null`.
- `CreateDelivery = Omit<Delivery,'recordId'|'status'|'completedAt'|'completedByUserId'|'completedByName'>`; adapter creates Pending.
- `Completion = {at:string; userId:string; name:string}`; immutable winner metadata, generated once under a D1 claim.
- `MessengerAction = {kind:'complete'|'quote'; token:string}`; token is an opaque UUID, not a record ID supplied by the client.
- `ActionBinding = {token:string; kind:'complete'|'quote'; deliveryId:string; recordId:string; groupId:string; day:string; page:number; connection:DeliveryConnection}`.
- `Overview = {day:string; page:number; total:number; done:number; items:Delivery[]; actions:Record<string,{quote:string; complete:string|null}>}`; action values are opaque tokens, keyed by Delivery ID.
- `MessengerResult = {kind:'overview'; overview:Overview} | {kind:'text'; text:string} | {kind:'quote'; text:string; quoteToken:string}`. Convert to existing `CommandReply` variants at the LINE boundary.
- `MessengerDeps`: injected Airtable adapter, D1 repository, `Clock`, `IdGenerator`, member-profile lookup and `currentPolicy():Promise<{allowedGroupIds:string[];completionUserIds:string[];connection:DeliveryConnection|null}>`. No global fetch/time in service tests.

### Task 1: Parse and sanitize messenger inputs before persistence

**Files:** Create `src/messenger/types.ts`, `src/messenger/parser.ts`, `test/messenger/parser.test.ts`; modify `src/line/types.ts`, `test/line/types.test.ts` (create if absent).

**Interfaces:** `parseMessengerCommand(text:string,eventTimestamp:number):MessengerInput|null` (null = another command); `sanitizeMessengerEvent(event:SupportedLineEvent):SupportedLineEvent`. Extend text events with optional validated `messenger:MessengerInput`, original `timestamp`, and optional `message.quoteToken`. Require a finite millisecond timestamp for messenger inputs only; older non-messenger fixtures remain accepted. Sanitization replaces messenger `message.text` with `/mess` or `/mess-overview` and stores only the structured parsed result. Invalid messenger bodies are removed too. Preserve the original message ID and quote token.

- [x] Write failing parser/schema tests. Pin this midnight case:
  ```ts
  expect(parseMessengerCommand('/mess\nพรุ่งนี้ 14:00 A-12977\n065 663 5369 (เจ)', Date.parse('2026-11-13T16:59:00Z')))
    .toEqual({ok:true,command:{type:'mess-register',productId:'A-12977',scheduledAt:'2026-11-14T07:00:00.000Z',scheduleType:'Scheduled'}});
  ```
  Cover `แมสเลยค่า`, today/overdue, tomorrow/month/year rollover, Gregorian date/page overview syntax, IDs A-2/A-10, missing/unsafe ID or page, multiple IDs, multiple schedule expressions, 24:00, 14:60, missing time/timestamp, malformed dates, and pasted phone/contact lines. Sanitized valid/invalid event JSON must not contain `065 663 5369`, destination, or raw body; quoteToken is retained only as metadata. Ignore unrelated commands unchanged.
- [x] Run `npx vitest run test/messenger/parser.test.ts test/line/types.test.ts`; confirm missing implementation/assertions fail.
- [x] Implement pure parser using explicit grammar in the spec and real date validation; never infer schedules from contact lines. Anchor command names so `/mess-overview` is not parsed as `/mess`.
- [x] Run the same tests and `npm run typecheck`; expect new tests pass, fix only type callers affected by this contract.
- [x] Commit `feat: parse and sanitize messenger commands` with only Task 1 files.

### Task 2: Add backward-compatible operator configuration

**Files:** Modify `src/settings/{schema,runtime,validation,entrypoint}.ts`, `src/config.ts`, `src/db/execution-context-repository.ts`, `src/routes/settings-bootstrap.ts`, `scripts/worker-app-config.ts`, `src/routes/setup.ts`; extend `test/settings/{schema,runtime,validation,service}.test.ts`, `test/db/execution-context-repository.test.ts`, `test/routes/settings-bootstrap.test.ts`, `test/scripts/worker-app-config.test.ts`, and required `test/helpers` fixtures. No Settings website redesign/fields in this slice. Existing Access-authorized Settings editors may configure these keys through the API; completion permission itself is still limited to the configured LINE IDs.

**Interfaces:** D1 StoredSettings keys `AIRTABLE_MESSENGER_DELIVERIES_TABLE_ID: string|null = null` and `MESSENGER_COMPLETION_USER_IDS:string[] = []`; runtime keys `airtableMessengerDeliveriesTableId` and `messengerCompletionUserIds`. Add optional fields with identical defaults to legacy config and saved-context schemas. Completion IDs must match `^U[0-9a-f]{32}$`, be trimmed and unique. Table ID must match `^tbl[A-Za-z0-9]+$` when present. Connections section accepts the table ID; LINE section accepts completion IDs through existing Cloudflare Access-protected Settings APIs. Table null disables this feature, with clear command guidance; no rollout flag needed.

- [x] Write failing compatibility tests: old stored JSON and old execution contexts load with defaults; invalid/duplicate completion IDs rejected; empty list denies all; export/import and unrelated section saves preserve new fields. Existing settings-client full-record validation accepts new keys even though no new UI controls are added. Book is never inferred from a name.
- [x] Run `npx vitest run test/settings test/db/execution-context-repository.test.ts test/routes/settings-bootstrap.test.ts test/scripts/worker-app-config.test.ts`; confirm failures from new expectations.
- [x] Implement schema/runtime/bootstrap/export mappings. Include the new table ID in `testSettingsConnection`'s Airtable allowed keys. Connection validation checks the configured delivery table's field names/types, Pending/Done options and Product linked-table target when enabled. Extend existing metadata parsing to inspect types/options. Null skips messenger checks; malformed configured table fails closed. Do not make unrelated existing deployments require the new table.
- [x] Run targeted tests, root typecheck and `npm --prefix apps/settings run typecheck`; verify clients tolerate the expanded settings object and round trips preserve it. Use `npm --prefix apps/settings test` and `npm --prefix apps/settings run build` at the final gate.
- [x] Commit `feat: configure messenger delivery storage and completion access` with explicit changed files.

### Task 3: Implement Airtable adapter and durable D1 intent/action repository

**Files:** Create `src/messenger/{airtable,repository}.ts`, `migrations/0012_messenger_delivery_coordination.sql`, `test/messenger/{airtable,repository}.test.ts`; update `test/db/migrations.test.ts` only if its schema assertions require it. Recheck migration numbering before creating.

**Interfaces:** `createMessengerAirtable({connection:DeliveryConnection,token:string,fetch:Fetcher})` returns `findProduct(productId):Promise<{recordId:string}|null>`, `findBySourceEvent(eventId):Promise<Delivery|null>`, `findDuplicate(groupId,day,productId):Promise<Delivery|null>`, `get(recordId):Promise<Delivery|null>`, `list(groupId,day):Promise<Delivery[]>`, `create(input:CreateDelivery):Promise<Delivery>`, `complete(recordId,completion:Completion):Promise<Delivery>`.

Repository `createMessengerRepository(db:D1Database)` returns `claimRegistration(input:{delivery:CreateDelivery;connection:DeliveryConnection;day:string}):Promise<{created:boolean;intent:RegistrationIntent}>`, `claimCompletion(input:{deliveryId:string;recordId:string;groupId:string;connection:DeliveryConnection;completion:Completion}):Promise<{created:boolean;intent:CompletionIntent}>`, `beginDispatch(intentId:string):Promise<boolean>`, `recordObserved(intentId:string,recordId:string):Promise<void>`, `putAction(binding:ActionBinding):Promise<void>`, `getAction(token:string):Promise<ActionBinding|null>`. `RegistrationIntent`/`CompletionIntent` are persisted immutable inputs plus `id`, `phase:'prepared'|'dispatched'|'observed'`, `recordId:string|null`; completion recordId is required. Define/export these in types. Repository uniqueness returns the winning intent, never replaces its payload.

- [x] Write failing provider/D1 tests: full offset pagination including Done, escaping group/product filter values, repeated offset rejection, non-JSON/error responses, duplicate products/tasks as data errors, invalid required fields and Done metadata. Two parallel registration claims for a connection/group/day/product yield one intent; two completion claims yield identical winning metadata; only one `beginDispatch` returns true. Reload repository to prove durability. Tokens bind kind/group/date/page/connection/task and contain no raw command.
- [x] Run `npx vitest run test/messenger/airtable.test.ts test/messenger/repository.test.ts` and verify failure.
- [x] Implement Airtable exact fields/types from spec: Delivery ID primary single-line text; Product link to Products; Product ID/identities/source IDs/quote token text; Scheduled At/Registered At/Completed At date-time; Schedule Type single select Immediate/Scheduled; Status single select Pending/Done. Adapter always requests all required fields and validates rows, never filters out Done. Resolve products with a dedicated query that rejects >1 match rather than relying on an inventory helper that may choose the first.
- [x] Implement additive D1 tables `messenger_write_intents` and `messenger_action_tokens`. Unique registration business key includes base/products/deliveries table IDs, group, day and product ID; unique source-event key includes connection; completion key includes connection and record ID. Use unique constraints + conditional SQL, not JavaScript locks. Store only sanitized metadata/immutable provider payloads, not a second current task status. No expiring lease may authorize a second ambiguous dispatch.
- [x] Run new tests plus `npx vitest run test/db/migrations.test.ts`; expect pass on clean local DB and old migration chain. Commit `feat: persist messenger write intents and Airtable deliveries`.

### Task 4: Orchestrate registration, overview and idempotent completion

**Files:** Create `src/messenger/service.ts`, `test/messenger/service.test.ts`.

**Interfaces:** `registerDelivery(command:Extract<MessengerCommand,{type:'mess-register'}>,source:{eventId:string;messageId:string;timestamp:number;quoteToken:string|null;groupId:string;userId:string},deps:MessengerDeps):Promise<MessengerResult>`; `getOverview(day:string,page:number,groupId:string,deps:MessengerDeps):Promise<MessengerResult>`; `handleMessengerAction(action:MessengerAction,actor:{groupId:string;userId:string},deps:MessengerDeps):Promise<MessengerResult>`.

- [x] Write failing service tests with deterministic clock/IDs. Assert profile name comes from sender and profile failure creates no intent/task; duplicate registration returns existing task even if Done. Assert all-Done overview is nonempty, mixed rows retain scheduled order, A-2 precedes A-10 on equal time, totals cover all pages, invalid page errors, and five rows maximum. Reference resolves original group's token or returns unavailable without mutating state.
- [x] Add failure/concurrency tests: timeout-after-success create is reconciled by Source Event ID; timeout-before-observable create causes no second POST; crash after dispatch claim causes read-only reconciliation; concurrent complete requests preserve first Completion; current unauthorized users/groups and forged tokens cannot mutate. Save-success/reply-failure and fresh overview retain Done. Test changed connection rejects old actions, current allowlist removal denies completion and all-Done items survive a service/repository restart.
- [x] Run `npx vitest run test/messenger/service.test.ts`; verify missing functions fail.
- [x] Implement the following write algorithm, shared by registration and completion within this service (do not build a general job framework):
  1. Validate current group/policy and provider connection; resolve product/profile/duplicate before registration claim, or stored binding/current record before completion claim. Reject cross-group/mismatched identity and invalid rows.
  2. Atomically claim immutable intent. A registration business-key conflict returns the original task or an accurate processing/uncertainty notice; it must not reuse the new command's time/identity.
  3. Before first dispatch, reconcile matching provider state. For create match Source Event ID and Delivery ID; for completion read current row. An existing Done row is returned without overwriting metadata.
  4. `beginDispatch` transitions prepared → dispatched once. Only its winner makes one external write, using the stored payload. Completion updates exactly Status and the three completion fields. Do not automatically retry this fetch, including network errors/5xx.
  5. On response loss or recovery of a dispatched intent, only read provider state. Matching observed state records success. Empty/mismatched/temporarily unavailable reads remain unresolved and return `⚠️ ยังยืนยันผลการบันทึกไม่ได้ กรุณาตรวจสอบก่อนส่งคำสั่งซ้ำ`; do not send another create/PATCH or clear/steal the intent. This intentionally prefers a visible blocked task to a duplicate. Record safe intent IDs for operator inspection; never log payload/token.
  6. Generate new overview after confirmed completion. If that read fails, return `บันทึกสถานะเสร็จแล้ว แต่โหลดรายการล่าสุดไม่สำเร็จ กรุณาใช้ /mess-overview อีกครั้ง`. Never claim the save failed.
  Operator resolution must establish that the old execution/provider request is finished before any reset; no automatic reset or new recovery UI in this slice. The runbook covers ambiguous writes. Direct concurrent Airtable edits are not transactionally fenced by D1: do not claim guarantees against external editors; flag observed conflicts rather than overwrite them knowingly.
- [x] Run service/repository/provider tests together; expect pass. Commit `feat: coordinate messenger registration and completion safely`.

### Task 5: Render compact overview and quoted-text replies

**Files:** Create `src/messenger/card.ts`, `test/messenger/card.test.ts`; modify `src/line/{client,messages,help-card}.ts`, the `CommandReply` declaration in `src/line/soldout.ts`, and `test/line/{client,messages}.test.ts` plus help-card test if present.

**Interfaces:** `messengerOverviewCard(overview:Overview,today:string):{text:string;contents:Record<string,unknown>}`. Extend `CommandReply` with `{kind:'quoted-text';text:string;quoteToken:string}`; add `LineClient.replyQuotedText(replyToken:string,text:string,quoteToken:string):Promise<void>`. Existing push-reply mode must preserve quoteToken and existing notification retry key. No quoteToken on a Flex message.

- [x] Write failing tests that assert two lines/item, time/name share a horizontal box with name right-aligned, 5-item limit, Pending has complete postback, Done has `✓ เสร็จแล้ว` and no completion action, both retain quote action, totals include Done, long names truncate, and pagination/today/tomorrow actions carry explicit day/page. Assert no images/recipient details. Quote client request must contain `{type:'text',text,quoteToken}` for both direct reply and Workflow push fallback.
- [x] Run `npx vitest run test/messenger/card.test.ts test/line/client.test.ts test/line/messages.test.ts`; verify failure, then implement using existing Flex spacing/color conventions and altText. Use opaque `messenger=complete|quote&token=<uuid>` postbacks with strict key parsing in Task 6. Navigation uses explicit `/mess-overview DD/MM/YYYY N` message actions.
- [x] Add concise `/mess` examples and `/mess-overview` help without changing existing command help. Run the same tests; commit `feat: add compact messenger Flex cards and quote replies`.

### Task 6: Wire LINE ingress, policy checks and existing recovery

**Files:** Modify `src/routes/line.ts`, `src/line/{webhook,command-workflow}.ts`, `src/shared/logger.ts`; extend `test/routes/line.test.ts`, `test/line/{webhook,command-workflow}.test.ts`, `test/shared/logger.test.ts`, and `test/helpers/{env,fakes,line-mutation}.ts` only as needed.

**Interfaces:** Add `messenger?:MessengerDeps` to WebhookDeps and construct it in `createWebhookDeps`. `currentPolicy` loads current D1 settings for messenger actions; provider writes use the action/intent's immutable connection, only when it equals current configuration. Use Task 1 structured `event.messenger`; route it before generic read-only handling. Preserve `prepareLineReply`/`sendCommandReply` signatures and support quoted-text variant.

- [x] Write failing route-to-Workflow capture tests proving signature verification precedes parsing/persistence, disallowed groups never enqueue, both valid and invalid `/mess` bodies are sanitized before `createBatch`, and original timestamp/quote token survive. Inspect simulated persisted params, event replies and emitted log arguments for forbidden contact text and token leakage. Add regression assertions for upload/docs/soldout/revert/report.
- [x] Add tests for repeated recovery preparation after ambiguous writes (no extra provider write), latest policy after a Workflow settings snapshot, invalid messenger postbacks, cross-kind/unknown tokens, changed base/table, quote failure fallback, and saved completion with failed overview/send. Old soldout/revert token handling must remain unchanged; messenger tokens must not enter `readPendingContext` or trigger `legacy_context_requires_operator_resolution`.
- [x] Run `npx vitest run test/routes/line.test.ts test/line/webhook.test.ts test/line/command-workflow.test.ts`; verify failure.
- [x] Integrate sanitized event handoff in `handleLineRoute`, strict postback routing, dependencies, current authorization before returning/replaying messenger results, and quote error fallback with product ID. Messenger preparation must recompute current overview/status on a fresh command; saved event replies are transport recovery snapshots only. Keep the existing three-attempt LINE recovery policy unchanged; write-intent guard prevents those prepare attempts repeating writes. Redact quote tokens and normalize exceptions without logging messenger event bodies or provider payloads.
- [x] Run targeted integration and feature tests plus root typecheck; confirm pass. Commit `feat: integrate messenger commands with LINE recovery`.

### Task 7: Acceptance proof and rollout runbook

**Files:** Create `test/acceptance/messenger.test.ts`, `docs/runbooks/messenger-delivery.md`; modify existing setup test fixtures only if Task 2 added optional metadata checks.

- [x] Write one acceptance flow using real local D1 migrations and mocked Airtable/LINE: register immediate/tomorrow tasks, request overview, attempt unauthorized completion, complete as Book, simulate reply loss, request fresh overview and assert completed row is still present in chronological position with original metadata. Add second group, second Airtable page, all-Done day and duplicate redelivery. Prove unrelated inventory fields and raw body retention are absent.
- [x] Run `npx vitest run test/acceptance/messenger.test.ts`; implement only missing integration fixes from previous tasks, then rerun to pass.
- [x] Run `npm run typecheck`, `npm test -- --reporter=json --outputFile=/tmp/messenger-final.json`, Settings typecheck/tests/build using its package scripts. Compare exact baseline failures; fix regressions introduced here and disclose pre-existing failures. Do not label a failing full suite green. Run `git diff --check` and self-review all changed callers/config/fixtures.
- [x] Write runbook with Airtable table field types/options/link target, required existing token permissions, current settings read/export and revision-safe section PATCH procedure, local migration/config commands, Book user-ID verification from trusted signed LINE event/profile, and adding/removing IDs later. Do not embed real tokens or guess Book's ID. Use current `SettingsService`/API request contracts and auth at implementation time; no direct blind SQL update to app_settings.
- [x] Include manual staging checks: five-row compact view/long name/Done state on LINE mobile; quote original command in same group; removed-user denial on old card; midnight navigation. Validate representative Flex payloads through LINE's validation endpoint with existing credentials only during authorized rollout. An HTML mock alone is not proof.
- [x] Document unresolved-intent inspection/reconciliation and stop conditions: no bulk replay/reset; no new POST just because a read is empty; no automatic lease expiry. If provider result remains ambiguous, operator investigation is required. Document non-transactional Airtable reads/manual edits and historical Flex snapshots.
- [x] Document ordered rollout: back up D1 and export settings; create/verify Airtable table and record table ID; apply additive migration; deploy code with new settings default-disabled; configure table + Book allowlist through revision-safe settings writes; exercise approved staging commands; inspect records/logs; production separately authorized. Before changing settings, record prior values. Do not execute these remote steps under implementation-only authorization.
- [x] Document rollback: disable messenger by setting table ID null, deny completion with empty allowlist, preserve delivery rows/intents, reconcile in-flight writes, restore pre-rollout settings export before any old code that rejects new keys. Do not drop D1 tables or delete Airtable tasks. Gate rollback to an older binary on old Workflow compatibility; do not resume sanitized messenger workflows under an incompatible binary.
- [x] Commit `test: verify messenger delivery flow and document rollout` and provide implementation evidence, remaining manual checks, and deployment prerequisites for review. Follow the preserved native execution/review workflow; do not merge or deploy automatically.

## Self-review and handoff

Coverage: date/input/privacy (1,6); backward-compatible config (2); records/uniqueness/recovery (3,4); overview/Done retention/reference (4,5); permission/group/old-card boundaries (4,6); end-to-end evidence and rollout (7). New shared types/functions above are defined before their consumers. No new website, dependency, scheduled job, or Workflow binding is included.

Explicit limitation: D1 and Airtable cannot commit atomically. The immutable single-dispatch policy prevents this feature from blindly repeating an uncertain write; it can leave an intent needing operator inspection after interruption. It does not guarantee exactly-once execution against arbitrary concurrent Airtable editors.

Plan-only validation: paths and current LINE/settings/recovery architecture inspected; execution baseline, implementation tests, provider writes and mobile checks have not been run for this plan. Implementation begins only after the user reviews this plan. Rollout remains separately authorized.
