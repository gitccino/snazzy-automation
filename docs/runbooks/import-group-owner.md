# Inspect a held import group

An owner with authenticated Wrangler access to the selected Cloudflare account and D1 database can inspect a LINE import using its exact run reference, originating LINE group ID, and product-group reference. Use a private workstation and keep the input and output private. This procedure reads D1 only; it does not access iCloud, R2, Airtable, or Workflow status.

Create a private input file (restrict its permissions) containing:

```json
{"runId":"RUN_REFERENCE","ownerGroupId":"ORIGINATING_LINE_GROUP_ID","groupId":"PRODUCT_GROUP_REFERENCE"}
```

Run `npx tsx scripts/import-group-owner.ts local < owner-input.json` for local D1, or replace `local` with `staging` or `production` after authenticating Wrangler for that environment. Remove the input file after use. The output shows the captured album and Airtable base/table identifiers, run and group state, product and record identifiers, first/last photo references, and saved ordered original photo/R2 references. An empty membership list or null R2 key is missing evidence, not proof that an original exists. References are identifiers, not verified provider content; do not publish the output. Credentials, private URLs, and raw failure text are not printed.

A null result with a nonzero exit means the tuple does not match the group's current owning LINE run, or captured context/references are malformed or unsafe to display. Groups can be reassigned by a later matching scan; a stale run reference must not be used to claim the current group. Recheck the originating reference and investigate privately. A valid result does not prove the Workflow stopped, that R2 objects still exist, or that Airtable matches. Do not clear a hold, change a checkpoint, or retry a group based on this inspection.

For missing originals, retain the hold. Case 15 still needs a durable, owner-scoped historical group disposition and audit/replay behavior, proof of the captured target and original membership/availability, and a safe resolution that preserves successful products and checkpoints. No such group repair is available through this command. Spec line 69 also requires broader run, failure, provider, cleanup and queue evidence plus scoped verified repairs; use [LINE reply owner recovery](line-reply-outbox.md) for its separately supported delivery disposition. This inspection does not satisfy that broader requirement.
