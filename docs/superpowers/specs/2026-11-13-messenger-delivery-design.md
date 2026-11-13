# Messenger delivery tracking

Date: 2026-11-13
Status: Approved for implementation planning on 2026-11-14. Implementation and deployment are separate steps.
Branch: `messenger-demo`

## Intent

Book needs a compact LINE list of products requiring messenger delivery today or tomorrow. Staff register deliveries through `/mess`; anyone in an allowed group can request `/mess-overview`. Book can mark deliveries done.

**Completed deliveries remain visible in every fresh overview for their scheduled day.** Completion changes the status, never removes the row or changes its delivery date or sort position.

## Confirmed requirements

- All staff may use `/mess` and `/mess-overview` in allowed LINE groups.
- Capture product, delivery date/time, responsible staff, and original LINE message reference.
- `แมสเลย` means immediately today. Scheduled input includes `พรุ่งนี้ 14:00`.
- Show `ผู้รับผิดชอบ · เจ` on the same line as the time, aligned right.
- No thumbnail, recipient/contact, destination, or retained original message body.
- Compact rows have product ID and reference/completion actions.
- Completed rows show `✓ เสร็จแล้ว` and stay visible, including after a new command, pagination, or worker restart.
- Completion uses a separate configurable LINE user-ID allowlist, initially containing only Book; more users can be added later. Registration and overview access remain available to all staff in allowed groups.
- Replies and quote actions stay in the originating allowed group.

## Approaches considered

1. **Recommended: Airtable delivery table; D1 technical coordination.** Staff can inspect delivery records in the familiar existing base. Airtable holds delivery status; D1 handles webhook deduplication, action scope, and recovery. Avoid two authoritative copies of delivery status.
2. D1-only delivery table. Fewer Airtable calls and transactional writes, but delivery records would not be visible in Airtable without a separate management interface.
3. Store delivery fields directly on Products. Small schema change, but overwrites delivery history and mixes inventory state with delivery tasks. Not recommended.

Selected: Airtable delivery table with D1 technical coordination. The user accepted the proposed defaults and requested the implementation plan on 2026-11-14. No new website, cron job, AI extraction, or long-running Workflow is needed. Reuse the existing LINE command recovery Workflow where appropriate.

## Command and date contract

| Input | Result |
| --- | --- |
| `/mess` followed by `แมสเลยค่า A-12977` | Immediate delivery; scheduled timestamp is the original LINE event timestamp |
| `/mess` followed by `วันนี้ 14:00 A-12977` | Today at 14:00 Bangkok time |
| `/mess` followed by `พรุ่งนี้ 14:00 A-12977` | Tomorrow at 14:00 Bangkok time |
| `/mess-overview` | Today's deliveries, first page |
| `/mess-overview tomorrow` | Tomorrow's deliveries, first page |
| `/mess-overview 14/11/2026` | Explicit Gregorian day, first page; used by navigation |
| `/mess-overview 14/11/2026 2` | Explicit day, page two |

Accept a multiline message with exactly one explicit `A-<positive integer>` ID. Other pasted lines may be present, but do not store them or interpret phone numbers as IDs or delivery times. Schedule parsing uses explicit `วันนี้ HH:mm` / `พรุ่งนี้ HH:mm` expressions or `แมสเลย` (including `แมสเลยค่า`); it is not unrestricted natural-language inference. Missing, malformed, conflicting schedules or multiple IDs return guidance with no write. Validate hours/minutes and real calendar dates. No implicit schedule when the time is missing.

Use `Asia/Bangkok` throughout. Resolve relative dates from the original webhook event timestamp, not retry time; persist that timestamp for recovery. A day is midnight inclusive through next midnight exclusive. Past times today are accepted as overdue; do not move them to tomorrow automatically. Record both requested delivery time and actual registration time.

Product must resolve to exactly one existing Airtable product. Do not create inventory or alter inventory status, sale fields, prices, publication state, or product numbering. Delivery completion is independent of `/soldout`.

First-version responsibility rule: the sender is responsible, using their LINE user ID and a display-name snapshot from the group profile API. The `(เจ)` text in a pasted contact line does not override identity. Registering on behalf of another staff member is out of scope unless requested.

## Persistence

Create `Messenger Deliveries` in the existing configured Airtable base. Logical fields:

| Field | Purpose |
| --- | --- |
| Delivery ID | Stable opaque task ID |
| Product | Link to exactly one Products record |
| Product ID | Immutable product ID snapshot for display/history |
| Scheduled At | Delivery instant, stored in UTC |
| Schedule Type | Immediate / Scheduled |
| Registered At | Original command event timestamp |
| Responsible User ID / Name | Sender identity and display-name snapshot |
| Source Group ID / Message ID | Group boundary and original message identity |
| Source Quote Token | Optional token for quoting the original command |
| Source Event ID | Deduplication/recovery key |
| Status | Pending / Done; default Pending |
| Completed At / Completed By User ID / Name | First successful completion metadata |

No original command body, contact details, or destination is persisted as application data. Inspect existing generic event/recovery storage and logs: `/mess` must not accidentally retain the pasted text there. LINE itself retains the original message; quoting it can show its contents again to the original group.

D1 stores only coordination data needed for durable deduplication/action recovery, scoped to the existing environment. Reuse existing infrastructure where safe; do not persist another independently editable copy of Status. Never log quote tokens. Set up table/field mapping using the project's configuration conventions; implementation plan must enumerate configuration/schema/setup changes explicitly.

Webhook redelivery must not create another delivery. Reconcile ambiguous Airtable create outcomes using Source Event ID; an empty reconciliation read after a timeout does not prove a create failed, so do not blindly create again. Business duplicate rule: reject a new command for the same product, group, and scheduled Bangkok day, even if the existing row is Done; direct the user to the existing task. A separate day may have a separate task. Cross-group behavior stays isolated.

## Compact overview

Header: `แมสเซนเจอร์วันนี้` / `แมสเซนเจอร์พรุ่งนี้` / selected date, plus total count and completion count (e.g. `3 รายการ · เสร็จแล้ว 1`).

Each row:

```text
ทันที · 09:10                      ผู้รับผิดชอบ · เจ
A-12977                         [อ้างอิง] [เสร็จแล้ว]

13:00                             ผู้รับผิดชอบ · เมย์
A-12981                         [อ้างอิง] ✓ เสร็จแล้ว
```

- Time left; responsible name right. Long names truncate visually without changing stored identity.
- Two lines per item, subtle separators, no image, large empty areas, or per-item cards.
- Pending items offer `อ้างอิง` and `เสร็จแล้ว`. Completed items retain `อ้างอิง` and a non-actionable completion indicator.
- Completion uses text/checkmark, not color alone. Do not reduce hit areas just to save space.
- Sort all statuses together by Scheduled At ascending, numeric Product ID, then stable Delivery ID. Do not move Done rows to the bottom.
- Page size: five rows. Fetch all matching Airtable pages before calculating totals/selecting the requested page; never silently omit Done records or later Airtable pages.
- Footer offers previous/next pages and today/tomorrow with explicit absolute dates in actions, so old buttons do not shift meaning after midnight.
- Empty day: `ไม่มีรายการแมสเซนเจอร์สำหรับวันนี้` or the selected date. A day containing only Done items is not empty.
- Overview reads current Airtable status, restricted to the requesting group and selected scheduled day. On incomplete reads or invalid required fields, return an error rather than a misleading partial or empty list.

## Completion action

Permission is controlled by a separate configurable allowlist of LINE user IDs. Initially configure only Book's verified LINE user ID; additional users can be added later without changing the command-access policy. Never authorize using a display name, contact text, Google email, or staff name. There is no implicit Book identity: obtain and explicitly configure the actual LINE user ID during setup. A missing or empty allowlist permits nobody to complete a delivery. Check the current allowlist on every completion action, including presses on older cards, so removal takes effect without reissuing cards. Membership does not bypass the allowed-group or task/source-group checks.

Validate signature, current allowed-group membership at the application boundary, actor permission, task ID, task/source group match, and action data before writing. Do not trust a group/date/product supplied by the button. Bind actions to stored task identity and the overview's explicit date/page.

Mark Pending → Done and persist completion metadata before acknowledging success. Repeated presses, stale cards, and simultaneous requests must leave one completion and preserve the original completion metadata. The implementation plan must choose durable per-task serialization/claiming and recovery compatible with Airtable's lack of transactional conditional updates; a naive read-then-write is insufficient. An already-Done task returns current state without rewriting metadata.

Reply with a newly generated overview for the selected day/page, including the completed row. **Previously sent LINE Flex messages remain snapshots; do not promise in-place editing.** Their old buttons remain safe through server-side idempotency. If saving succeeds but replying fails, a fresh `/mess-overview` still shows Done; never undo the saved change or report that it was not saved.

Completion has no undo, deletion, rescheduling, or inventory effects in this first version. Do not automatically purge completed records.

## Reference action and LINE platform limits

`อ้างอิง` is a postback that sends a separate text message quoting the original `/mess` command using its quoteToken in the same group. Message ID alone is insufficient. It is not a direct jump-to-message URL and does not promise navigation to a product image.

If quoteToken is absent or quoting is unavailable, return a clear unavailable notice plus product ID; do not fabricate a link or expose another group's message. A quote failure does not affect delivery state. No product image is fetched for this feature.

Sources: [LINE quote tokens](https://developers.line.biz/en/docs/messaging-api/get-quote-tokens/), [Sending messages](https://developers.line.biz/en/docs/messaging-api/sending-messages/), [Messaging API reference](https://developers.line.biz/en/reference/messaging-api/).

## Integration and practical validation

Existing LINE parsing/types, webhook dispatch, group checks, member profile lookup, reply client, Flex patterns, configuration loading, Airtable adapter, and D1 event/recovery infrastructure are the integration seams. Current event schema discards timestamp/quoteToken and the LINE client has no quoted-text operation; extend those contracts and their fixtures deliberately. Do not route new commands into the existing read-only dispatcher by accident. Preserve `/upload`, `/docs`, `/soldout`, `/revert`, and report behavior.

Acceptance checks for the implementation plan:

1. Immediate, today, tomorrow, malformed/missing/conflicting schedules, multiple/unknown products, extra pasted contact text, midnight redelivery, and overdue times.
2. Responsible name comes from sender profile; missing profile fails clearly without partial registration.
3. Redelivered events and ambiguous Airtable create responses produce one task; business duplicates get a useful reply.
4. Mixed Pending/Done and all-Done overviews retain every row, preserve chronological sorting, accurate totals and paging, and reflect persisted status after restart.
5. Authorized completion, unauthorized press, forged/cross-group action, repeated and concurrent completion, partial provider failure, and save-success/reply-failure recovery.
6. Quote success/missing token/failure/group isolation; no persisted original body or token leakage in logs.
7. Validate Flex payloads and inspect compact rows, long names, five-row pages, and Done state on actual LINE mobile clients. The HTML mock is illustrative, not LINE integration proof.
8. Regression checks for existing commands; no live data mutations or deployment as part of spec review.

## Approval and setup prerequisites

- Approved: Airtable delivery table plus D1 coordination.
- Completion authorization is decided: configurable user-ID allowlist, initially Book only. Book's verified LINE user ID is a setup prerequisite, not yet configured by this specification.
- Approved: sender-as-responsible rule, group-scoped delivery lists, duplicate-per-product/group/day rule, five-row pagination, and the explicit command grammar above.

## Draft review

A separate builder review found no additional blocking questions beyond the approval decisions above. This reviewed only the specification; actual LINE behavior and provider integrations remain implementation-time validation.

After design approval, create an implementation plan. Provisioning real Airtable tables, migrations, and deployment require their own concrete rollout steps; this spec does not perform them.
