# Operations Runbook

Use the production Worker URL as `WORKER_BASE_URL` (no trailing slash) and the current bearer token as `ADMIN_ROUTE_TOKEN`. See [deployment](deployment.md) for initial setup.

## Daily cycle

1. Finish uploading shoot photos to the active [album](album-rotation.md), with a marker before each product, at least 30 minutes before the 06:00 Bangkok import.
2. Read the import summary in the allowlisted LINE admin group. It lists successful Product IDs, failed group IDs and error codes, and photos before the first marker. Those orphan photos do not become products.
3. Complete new `In` products in Airtable: brand, model, condition, size, description, prices, and `Product Images` order.
4. Assign products to a Publication Run and set it `Ready` before the 06:30 Bangkok publication. Check LINE for the document link or missing-field report.
5. Use `/search`, `/soldout`, and `/revert` in the allowlisted LINE admin group during the day.

## Retry a run

Send `/upload` or `/docs` in the admin group. Import skips recorded photos and successful groups, retries failed groups, and picks up new photos. Publication selects an eligible `Ready` or `Failed` run for the current Bangkok date; it may report `no_runnable_run`, `already_running`, or `already_generated` instead of starting new work.

For an operator trigger outside LINE, use the same bearer token as `/setup`:

```bash
curl --fail-with-body -X POST -H "Authorization: Bearer $ADMIN_ROUTE_TOKEN" "$WORKER_BASE_URL/upload"
curl --fail-with-body -X POST -H "Authorization: Bearer $ADMIN_ROUTE_TOKEN" "$WORKER_BASE_URL/docs"
```

An import already running for the album returns HTTP 409. Check its completion before retrying.

## Cost and storage alerts

The Worker checks its estimated monthly cost daily and sends a LINE alert when it exceeds `MONTHLY_BUDGET_THB`. Read the current estimate with:

```bash
curl --fail-with-body -H "Authorization: Bearer $ADMIN_ROUTE_TOKEN" "$WORKER_BASE_URL/usage"
```

The response contains `yearMonth`, `estimatedUsd`, `estimatedThb`, `overBudget`, and `breakdown` (`claudeInputUsd`, `claudeOutputUsd`, `r2Usd`). It estimates metered Claude tokens and R2 bytes recorded by this app; use Cloudflare and provider billing for actual charges. A LINE push can fail, so check `/usage` directly when investigating spend.

Configure customer-owned Cloudflare Notifications once per environment: a billing usage alert to the operations email at the customer's measured monthly ceiling, and an R2 storage alert if the account offers one. Set the R2 threshold from current usage and expected growth. At 100–500 photos/day and roughly 2 MB/photo, 20 GB is only an early growth warning (about 20–100 days before deduplication), not two years of retention. Record the actual policies here:

| Date | Policy | Threshold | Delivery |
|---|---|---|---|

For a budget alert, inspect `/usage` and provider bills. High `claudeOutputUsd` suggests checking recent publication volume and caption length; high `r2Usd` suggests checking new asset volume for unexpected duplicate uploads. Compare D1 growth over a measured interval:

```bash
npx wrangler d1 execute snazzy-automation-production --remote --command "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS assets FROM photo_assets GROUP BY day ORDER BY day DESC LIMIT 14"
```

Escalate sustained caption costs to the developer to review the prompt or a Batch API change; neither is an operator switch in this release.

## Failed import

1. Note the failed group ID and error code from LINE. Look up its D1 state, attempt count, and failure reason:

   ```bash
   npx wrangler d1 execute snazzy-automation-production --remote --command "SELECT id, import_run_id, product_id, first_photo_id, last_photo_id, attempt_count, failure_reason, updated_at FROM product_groups WHERE state = 'failed' ORDER BY updated_at DESC LIMIT 10"
   ```

2. Check Airtable availability and permissions for API errors. For missing or misplaced markers, ask staff to inspect the source album; the LINE orphan notice identifies photos before the first marker separately. For image failures, correlate `first_photo_id`/`last_photo_id` with `photo_assets.apple_photo_id` and inspect the corresponding R2 object key. Keep customer photo content private.
3. Correct the source problem and send `/upload`. Confirm a subsequent LINE summary reports success. If the import failed before groups were recorded, inspect `import_runs` and Cloudflare Workflow logs, then retry.

## Failed publication and escalation

The LINE validation message names missing fields per Product ID and links to Airtable. Fill the fields, set the run back to `Ready`, send `/docs`, and confirm the new document link. For a workflow failure, check the `Failed` run, Cloudflare Workflow logs, and Airtable, Google, and Anthropic availability; then send `/docs` to restart or resume eligible work. Do not create a second run to mask a failed one.

If repeated retries fail or `/health` is not healthy, run authenticated `/setup` and inspect its failed checks:

```bash
curl --fail-with-body -H "Authorization: Bearer $ADMIN_ROUTE_TOKEN" "$WORKER_BASE_URL/setup"
```

`/health` checks sequence consistency and import activity; `/setup` checks service bindings and provider access. Stop new operator triggers and pause the affected scheduled trigger in Cloudflare until a failing setup check is resolved. Escalate with the run ID, Bangkok time, LINE error code, failed setup check, and relevant Worker/Workflow logs; omit tokens, public album links, and signed URLs. Re-enable the trigger after `/setup` reports `"ok": true` and a controlled retry succeeds.

If `google_template_access` fails because the owner's OAuth grant is invalid, expired, or revoked, keep Google publication paused. The owner must retain account recovery access and available My Drive storage. Follow [publication setup](publication-setup.md) to reconnect with `npm run google:drive-setup -- --expected-owner <owner-email>`, select the affected environment's folder and template, replace `GOOGLE_REFRESH_TOKEN` through Wrangler's prompt, and rerun `/setup`. Confirm the output folder is shared with intended collaborators and that one collaborator can open a generated document without authorizing the app. Use separate staging and production folders and templates.

Replacing one environment's refresh-token secret does not require grant revocation. If the Google grant was revoked, check every environment and client in that project; pause affected Google publication until each has been reauthorized, updated, and verified through `/setup` and a controlled publication. See [credential rotation](credential-rotation.md).
