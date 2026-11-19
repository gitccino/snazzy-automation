# LINE reply outbox — staging deployment

User authorized deployment after reviewing the local implementation. Target: `snazzy-automation-staging`; production was not changed.

- Deployed source: `ad2104d` on `messenger-demo`.
- Active Worker version: `1253fa5c-4fd4-4ffb-99c1-86190d2e5b0c`, verified at 100% traffic.
- Previous Worker version: `c6bf4ec0-49ff-4935-a9e7-865e84afda19`.
- Endpoint: https://snazzy-automation-staging.clicky-worker.workers.dev

## Before deployment

Queried queued, running and paused instances separately for import, publication and LINE command Workflows; every filtered list was empty. No runs were terminated or restarted. Captured private deployment/version metadata and exported staging D1 under ignored, access-restricted `.wrangler/line-outbox-rollout/`. This includes a settings snapshot; no credentials or download URLs belong in this record.

Only migration `0013_line_reply_outbox.sql` was pending. Applied it successfully, creating the outbox/dispatch tables and publication notification-cycle column. Verified the dispatch HTTP-status evidence column too. Deployed with `--keep-vars` to preserve existing dashboard variables.

## After deployment

- Remote migration list reports no pending migrations.
- D1 Settings row, including revision **9**, exactly matches the pre-deployment snapshot.
- All **10** secret binding names remain present; no secret was rotated.
- Deployment API reports the new version serving 100% traffic.
- `GET /health`: **200**, `{"ok":true,"importRunning":false}`.
- Invalidly signed `POST /line/webhook`: **401**, confirming signature rejection without admitting an event or sending LINE messages.
- `GET /line/icons/image-v1.png`: **200**, `image/png`.
- Post-deployment outbox and dispatch tables were empty; no synthetic results were inserted.

Local validation for this source remains 1,090 passing tests and the same 28 pre-existing failures, with passing typecheck and staging build dry-run. See the implementation validation record for exact failure names and review fixes.

No live LINE command, business job or group message was generated as a deployment test. The first real `/upload` or `/docs` completion still needs an end-to-end check: its result should wait for the next eligible message in the originating group. Quiet groups wait indefinitely; uncertain dispatches require owner reconciliation.

## Rollback

Retain all additive schema and outbox/dispatch evidence. Follow `docs/runbooks/line-reply-outbox.md`: stop new admissions through maintenance mode, inspect queue-enabled executions and reconcile uncertain sends before considering an older binary. Worker rollback does not roll D1 back and must not revive legacy command sends or discard queued results. Backups and previous-version metadata are private in the rollout directory.
