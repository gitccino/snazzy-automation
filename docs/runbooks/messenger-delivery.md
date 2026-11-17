# Messenger delivery setup and operations

Implementation reference: [specification](../superpowers/specs/2026-11-13-messenger-delivery-design.md) and [plan](../superpowers/plans/2026-11-14-messenger-delivery.md).

This runbook does not authorize remote changes. Stage and production rollout each need explicit authorization. Existing `/upload`, `/docs`, inventory state and publication jobs are independent of messenger completion.

## Required setup

- Existing Airtable base and Products table; existing Airtable token with record read/write access to the new table, product read access, and schema read permission for connection verification. Do not grant schema write to the running Worker just to provision a table.
- New `Messenger Deliveries` table in that same base, with these exact fields. Create it in Airtable during an authorized rollout, not by generating replacement inventory.

| Fields | Airtable type/options |
| --- | --- |
| Delivery ID | Primary single-line text |
| Product | Link to Products, one linked product per task |
| Product ID | Single-line text, copied product ID |
| Scheduled At, Registered At, Completed At | Date with time (stored as UTC instants) |
| Schedule Type | Single select: Immediate, Scheduled |
| Status | Single select: Pending, Done |
| Responsible User ID, Responsible Name | Single-line text |
| Source Group ID, Source Message ID, Source Event ID | Single-line text |
| Source Quote Token | Single-line text; treat as sensitive, do not publish/log |
| Completed By User ID, Completed By Name | Single-line text |

Do not add required contact, destination or original-body fields. Source Message ID refers to the `/mess` text message; it does not identify a product image. Restrict access to stored LINE identity/reference metadata appropriately for the existing base.

- Book's verified LINE user ID (`U` plus 32 lowercase hexadecimal characters). Have Book send a known command in an allowed group. Inspect only `source.userId` and group ID **after webhook signature verification**, in a trusted debugger/owner-controlled diagnostic; confirm with the group-member profile endpoint. Do not use a display name, Google email, contact number or invented placeholder as authorization. Do not log entire webhook bodies to discover the ID.

## Configuration

Changeable configuration lives in D1 settings, not secrets:

| Key | Default | Effect |
| --- | --- | --- |
| AIRTABLE_MESSENGER_DELIVERIES_TABLE_ID | null | null disables messenger commands; set to the new `tbl…` ID to enable |
| MESSENGER_COMPLETION_USER_IDS | [] | Only listed LINE IDs may complete; initially include Book only |

The existing allowed-group list still controls command access and group isolation. Completion membership never bypasses it. Existing Cloudflare Access-authorized Settings editors can update the new keys through the existing Settings API; this feature adds no new website fields.

For staging configuration, sign in to the Settings site through its existing Cloudflare Access policy. Use the browser developer console **on that site** to call its same-origin API; do not paste tokens or run this on another site:

```js
async function settingsRequest(path, init = {}) {
  const response = await fetch(path, init);
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.code || 'settings_request_failed');
  return body.value;
}
const view = await settingsRequest('/api/settings');
// Download /api/settings/export through the Settings site and retain the backup privately.
const saveSection = (section, expectedRevision, changes, acknowledgeAirtableChange = false) =>
  settingsRequest('/api/settings/sections/' + section, {
    method: 'PATCH',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({section, expectedRevision, changes, acknowledgeAirtableChange}),
  });
```

Before enabling, record the previous configuration. Replace placeholders with verified IDs; never execute examples containing placeholders:

```js
// First configure Book so enabling the table cannot accidentally grant everyone completion access.
const withBook = await saveSection('line', view.record.revision, {
  MESSENGER_COMPLETION_USER_IDS: ['<VERIFIED_BOOK_LINE_USER_ID>'],
});
const enabled = await saveSection('connections', withBook.record.revision, {
  AIRTABLE_MESSENGER_DELIVERIES_TABLE_ID: '<NEW_DELIVERY_TABLE_ID>',
}, true);
```

Browser fetch supplies Origin; Access supplies authentication. Neither an ADMIN_ROUTE_TOKEN nor a Cloudflare API token belongs in these snippets. API writes require correct Origin/content type and the current revision. On 409 refetch and review changes instead of silently overwriting someone else's edit. Connection save validates table field types, select choices and Product's linked table. Existing Airtable-change acknowledgment is required when applicable. Fix schema or permissions before retrying a rejected save; do not bypass validation with direct SQL.

To add/remove completion users later, fetch the current record and PATCH `line` with the full desired array and current revision. Empty array denies everyone. Removal affects old buttons too. Do not replace `LINE_ALLOWED_GROUP_IDS` when editing completion IDs.

Legacy-only installations may set equivalent optional keys in APP_CONFIG_JSON; `scripts/worker-app-config.ts` reads an optional comma-separated `MESSENGER_COMPLETION_USER_IDS` environment value. Existing missing keys default disabled. In D1 mode use the revision-safe Settings API, not legacy config scripts.

## Local validation

From the isolated worktree (local commands only):

```bash
npm run db:migrate:local
npm run typecheck
npx vitest run test/messenger test/acceptance/messenger.test.ts test/routes/line.test.ts test/line/webhook.test.ts test/line/command-workflow.test.ts
npm --prefix apps/settings run typecheck
npm --prefix apps/settings test
npm --prefix apps/settings run build
npm test
```

No new Worker bindings, packages or cron schedules are needed. Keep root-suite baseline failures separate from feature regressions; record exact test names and compare before/after. Tests mock providers and use local D1; they do not prove live LINE layout or Airtable access.

## Authorized rollout order

1. Confirm the intended environment and no incompatible in-flight LINE commands. Export settings and back up its D1 database using the existing deployment runbook. Keep the prior Worker version available.
2. Create the delivery table above and record its ID. Verify token access, field types/options and Product link target.
3. Apply additive D1 migration `0012_messenger_delivery_coordination.sql` in the selected environment using existing Wrangler migration procedures. Do not drop existing tables.
4. Deploy reviewed code with messenger configuration still default-disabled. Existing settings and execution contexts load with default null/empty values.
5. Configure Book and the table through the revision-safe Settings API above. Verify current allowed groups. Do not change credentials, inventory or cron configuration as part of this feature.
6. Run the following **explicitly authorized test commands** in the staging group; inspect Airtable rows and safe diagnostic IDs. Production rollout is a separate decision.

## Manual LINE acceptance

Use real existing test products and separate task/day combinations; the same product/group/day is deliberately rejected as a duplicate even after completion.

- `/mess` followed by `แมสเลยค่า A-<test ID>` records sender identity and original event time. Additional contact/address lines are ignored and not persisted by this feature.
- `/mess 14:30 A-<test ID>` means today at 14:30 Bangkok time; a past time stays today. `วันนี้` is optional. Dot times such as `14.30` also work. A pasted message may put the product ID first and the schedule on a later line, e.g. `🛵 แมส 14.30 ค่าแมสปลายทาง`. Exactly one standalone time may appear anywhere with varied wording, including `แมสออก 14:30` and `นัดแมส 14.30`. Full phone numbers and ordinary address numbers are ignored. Avoid unrelated standalone decimals formatted like a time, since they can be ambiguous. Missing, invalid or multiple times are rejected. `แมสเลย` cannot accompany `พรุ่งนี้`, `วันนี้` or an explicit time.
- `/mess พรุ่งนี้ 14:00 A-<test ID>` lands on tomorrow's Bangkok date.
- `/mess-overview` shows today only; `/mess-overview 2` selects page two of today. Date and `tomorrow` overview arguments are rejected. Tomorrow registrations appear when their scheduled day arrives.
- Inspect five-row pages, a long staff name, small phones and all-Done days. The first line is the black Thai title without MESSENGER, followed by date and completed/total count. Reference is text-only; completion uses a soft-gray `#F0F0F1` pill, and the green completed label is centered in the same column. Pending times strictly before generation time are red with `เกินกำหนด`; Done/future/exactly-due times stay black. Immediate deliveries display only their recorded time and use the same overdue rule, without a grace period. Refresh `/mess-overview` to recalculate; old messages remain snapshots. Time/name share a line; product/actions share a second line. Pending and Done remain together in scheduled order with accurate total/completion counts.
- Confirm Book can mark Done, another unlisted staff member cannot, and a removed user cannot use an old button. Repeated completion preserves the first completion metadata within the current Pending → Done cycle. Inventory remains unchanged.
- A new overview retains completed rows as green `เสร็จสิ้น` without a checkmark; previously sent LINE messages remain snapshots and cannot be assumed to update in place.
- `อ้างอิง` sends a **separate quoted text message** in the original group. Verify quote navigation on the actual mobile client; it is not a direct image/message URL. Missing/invalid quote tokens yield a product-specific notice, not a fabricated link.
- Validate representative outgoing Flex messages with LINE's `/v2/bot/message/validate/reply` endpoint, using existing credentials only during authorized validation. Check logs omit raw bodies, contact data and quote tokens.
- Check pagination after midnight queries the current Bangkok day, and an old completion card refreshes today’s first page. Confirm another group's tasks cannot be read or changed.

## Manual Airtable edits

Staff may edit Status, Scheduled At, Schedule Type and Responsible Name in Airtable. A fresh `/mess-overview` reads those values; existing cards remain snapshots. Changing the scheduled date moves the item to that day's overview. Keep the responsible user ID consistent when changing the assigned person.

- Setting Status to Done manually is valid even without Completed At / Completed By fields. The bot displays Done without inventing who completed it or when.
- To reopen a confirmed completion, set Status to Pending (old completion fields may be retained or cleared), then request a **fresh `/mess-overview`**. Its button can complete the new cycle with new metadata. Old buttons ask for a fresh overview instead of completing the reopened cycle.
- D1 preserves each previously confirmed completion receipt. Replacement of the active receipt is atomic; concurrent clicks still permit only one provider write per cycle. No new Airtable field or database migration is required.
- An unresolved dispatched write stays blocked even if Status is manually toggled. A manually set Done status confirms that particular write only when its completion time and actor metadata match the stored receipt. Investigate unresolved writes as below; do not delete their intents.

Delivery ID, Product/Product ID, Registered At and source/reference fields remain app-managed. Product reassignment and moving delivery history between bases are outside this change. Avoid changing Status while a completion request is in flight: Airtable offers no conditional transaction against manual editors.

## Interrupted or uncertain writes

Airtable owns task status. D1 `messenger_write_intents` records immutable write payloads and phases (`prepared`, `dispatched`, `observed`), not an independently editable copy of Pending/Done. `messenger_action_tokens` binds buttons to task/group/day/page/connection.

Only one D1 claim may dispatch a provider write. This deliberately trades automatic recovery of some interruptions for protection against duplicate Airtable writes. Airtable and D1 cannot commit atomically.

When the bot says `ยังยืนยันผลการบันทึกไม่ได้`:

1. Stop issuing duplicate commands. Identify the source event/task and its intent through owner-controlled diagnostics. A safe initial read is `SELECT id,kind,phase,record_id FROM messenger_write_intents`; do not dump `payload_json` or action bindings into shared logs because these include identity/reference metadata.
2. Check the **pinned base/table** from that intent privately. For registration, find exactly one Airtable row matching Source Event ID and Delivery ID. For completion, read the specific record and completion metadata. A fresh overview reads actual Airtable status.
3. Re-entry through normal service logic reconciles observed state without another write. If the matching row exists or the task is Done, keep it (completion intent confirmation also requires matching completion metadata); never recreate it to repair a failed LINE reply. If saving succeeded but sending failed, ask for a fresh overview.
4. A `dispatched` intent with no visible record is **not proof** that the request failed: it may still be in flight. There is no automatic claim expiry, second POST/PATCH, bulk replay, or lease stealing. Establish the original execution and provider request are finished before considering any operator repair. If uncertainty remains, keep it blocked and investigate; no reset utility is supplied in this release.
5. Before a manual repair, preserve the intent, original IDs/payload and any Airtable evidence, verify no late request can still arrive, and obtain explicit authorization for the exact repair. Do not delete an intent or change it back to prepared simply because a query returned no rows. Do not silently invent another delivery ID or completion actor/time.

Connection changes invalidate existing card actions; request a new overview for the current connection. Old records/intents remain in their original base. Moving delivery history or inventory between bases is outside this release.

D1 coordination fences this application's writes, not arbitrary concurrent edits in Airtable. Multi-page reads are not transactional snapshots. Avoid manually editing delivery identity/source fields or racing Status changes against button actions. Reconcile unexpected differences before mutating anything.

## Disable and rollback

Disable completion immediately by PATCHing `MESSENGER_COMPLETION_USER_IDS: []`; disable all messenger commands by setting `AIRTABLE_MESSENGER_DELIVERIES_TABLE_ID: null` through the same revision-safe settings flow. Preserve records, completion metadata, intents and action bindings. A request already accepted by Airtable may still finish; reconcile in-flight work before making stronger claims.

Prefer a forward fix or disabled feature over restoring an incompatible binary. Before reverting to old code, account for all in-flight sanitized messenger Workflow payloads and restore a pre-rollout settings export without the new keys through an authorized, revision-safe procedure supported by that binary. Merely setting new keys to null/empty does not remove them from strict JSON schemas. Do not resume new messenger Workflows under old code, drop additive tables, or delete delivery rows as rollback. Follow the existing deployment runbook for Worker-version rollback only after those compatibility checks.
