# Inspect a held import group

An owner with authenticated Wrangler access to the selected Cloudflare account and D1 database can inspect a LINE import using its exact run reference, originating LINE group ID, and product-group reference. Use a private workstation and keep the input and output private. This procedure reads D1 only; it does not access iCloud, R2, Airtable, or Workflow status.

Create a private input file (restrict its permissions) containing:

```json
{"runId":"RUN_REFERENCE","ownerGroupId":"ORIGINATING_LINE_GROUP_ID","groupId":"PRODUCT_GROUP_REFERENCE","baseId":"CAPTURED_BASE_ID","tableId":"CAPTURED_PRODUCTS_TABLE_ID"}
```

Run `npx tsx scripts/import-group-owner.ts local < owner-input.json` for local D1, or replace `local` with `staging` or `production` after authenticating Wrangler for that environment. Remove the input file after use. The output shows the captured album and Airtable base/table identifiers, run and group state, safe failure codes, checkpoint, verification claim, product and record identifiers, create claim, first/last photo references, and saved ordered original photo/R2 references. It also shows the current owning LINE group queue head and its saved dispatch evidence; this head may belong to a different run. The feedback failure code is the first recorded code, while its stage is the latest saved stage. Unsafe or absent codes are null. External liveness is unknown. Sync and cleanup state are not established by this inspection. An empty membership list or null R2 key is missing evidence, not proof that an original exists. References are identifiers, not verified provider content; do not publish the output. Credentials, private URLs, and raw failure text are not printed.

A null result with a nonzero exit means the tuple does not match the group's current owning LINE run, or captured context/references are malformed or unsafe to display. Groups can be reassigned by a later matching scan; a stale run reference must not be used to claim the current group. Recheck the originating reference and investigate privately. A valid result does not prove the Workflow stopped, that R2 objects still exist, or that Airtable matches. Do not clear a hold, change a checkpoint, or retry a group based on this inspection.

For missing originals, retain the hold. Case 15 still needs a durable, owner-scoped historical group disposition and audit/replay behavior, proof of the captured target and original membership/availability, and a safe resolution that preserves successful products and checkpoints. No such product-group repair is available through this command. Spec line 69 still requires independent provider evidence and scoped verified repairs; use [LINE reply owner recovery](line-reply-outbox.md) for its separately supported delivery disposition. This inspection and the narrow notice repair below do not satisfy that broader requirement.

## Inspect an import run or publication attempt

Use the same private input and authenticated environment. For a group-less import, supply `{"kind":"import","runId":"RUN_REFERENCE","ownerGroupId":"ORIGINATING_LINE_GROUP_ID","baseId":"CAPTURED_BASE_ID","tableId":"CAPTURED_PRODUCTS_TABLE_ID"}`. For publication, supply `{"kind":"publication","runId":"RUN_REFERENCE","ownerGroupId":"ORIGINATING_LINE_GROUP_ID","baseId":"CAPTURED_BASE_ID","tableId":"CAPTURED_PUBLICATION_RUNS_TABLE_ID","generation":1,"notificationCycle":1}` with the exact saved generation and notification cycle. Run `npx tsx scripts/import-group-owner.ts local inspect-run < owner-input.json`; substitute the selected authenticated environment as above. Remove the input afterward.

The output contains captured owner and target, saved state and attempt identity, safe first failure code and latest stage, notice intents, verification and the owning group's current queue head and dispatch evidence. Publication additionally includes safe document identifiers, Google write evidence, finalization and cleanup intent, dispatch and deletion receipt when recorded. An older attempt is inspectable only when its feedback retains the matching captured context; its current execution state is unknown. Legacy or malformed context that cannot establish the owner and target is held with a null result. Unsafe codes and identifiers are null; private URLs and credentials are never returned. Sync state is not durably recorded by this tooling. A missing cleanup receipt is not proof of deletion or non-deletion. Queries are separate reads and can observe concurrent changes. These are D1 records, not external liveness or provider verification; do not infer a safe retry from them. Independently verify provider state before any supported repair.

## Repair a saved early-setup notice

After migration `0037_import_owner_notice_repair.sql` is applied, an authenticated owner can materialize an already-recorded import early-setup notice for its exact run and originating LINE group. This applies before product groups exist as well as later; it is not a product-group disposition. Confirm the saved run and its captured Airtable base and products table privately, then supply those exact identifiers and a non-secret operator name and reason in a private input file:

```json
{"runId":"RUN_REFERENCE","ownerGroupId":"ORIGINATING_LINE_GROUP_ID","baseId":"CAPTURED_BASE_ID","tableId":"CAPTURED_PRODUCTS_TABLE_ID","actor":"OPERATOR","reason":"Reviewed saved early-setup intent"}
```

Run `npx tsx scripts/import-group-owner.ts local repair-notice < owner-input.json`, substituting the authenticated environment where appropriate. Remove the input file afterward. `result: true` means the saved intent, a pending outbox entry and an audit were committed together. A false result and nonzero exit mean the owner, target, saved intent or queue state did not match, or the operation was already applied; inspect again. The procedure refuses a conflicting result or an unresolved queue head. It does not send a LINE message; ordinary queue delivery rules still apply. The audit retains the actor and reason, so do not enter credentials or private URLs.

Historical product resolution remains unavailable: the create claim and saved ordered photo/R2 identifiers do not establish that Airtable attachments contain the original images. The existing provider verification checks attachment count, not attachment identity. Missing originals or unverifiable attachment identity remain on hold; this notice repair does not resolve them. Spec line 69 still needs independent provider evidence and other scoped repairs.

The historical evidence verifier in source is a read-only building block and is not an owner CLI action. Its result alone does not authorize a repair: provider adapters and an atomic, concurrency-fenced audited disposition are still required. Continue to hold unresolved groups and use the inspection procedure above.
