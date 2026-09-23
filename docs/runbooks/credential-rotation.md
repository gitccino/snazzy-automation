# Credential Rotation Runbook

Rotate customer-owned production secrets without a code change. Obtain the replacement from its issuing service, update one binding, verify it, and only then revoke the old credential. Keep values in the customer secret store; never put them in tickets, logs, or this file. Use [deployment](deployment.md) for the production URL and [publication setup](publication-setup.md) for Google access requirements.

## Procedure

1. Confirm the old credential is still available and identify its owner and dependent service. Schedule rotation outside the import/publication cron window. For `ADMIN_ROUTE_TOKEN`, put the new value in the operator secret store and current `ADMIN_ROUTE_TOKEN` shell variable before verification.
2. Run **only the command for the binding being rotated**; Wrangler prompts for the new value:

   ```bash
   npx wrangler secret put AIRTABLE_TOKEN --env production
   npx wrangler secret put LINE_CHANNEL_SECRET --env production
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --env production
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON --env production
   npx wrangler secret put ANTHROPIC_API_KEY --env production
   npx wrangler secret put ICLOUD_SHARED_ALBUM_TOKEN --env production
   npx wrangler secret put ASSET_URL_SIGNING_SECRET --env production
   npx wrangler secret put ADMIN_ROUTE_TOKEN --env production
   ```

   `APP_CONFIG_JSON` is configuration rather than a provider credential; its update procedure is in [deployment](deployment.md), and its album cutoff change is in [album rotation](album-rotation.md).
3. Confirm `/setup` reports `"ok": true` and inspect the relevant check: `airtable_schema`, `line_webhook_config`, `google_template_access`, `claude_credential`, `icloud_phase_zero`, or `asset_delivery`:

   ```bash
   curl --fail-with-body -H "Authorization: Bearer $ADMIN_ROUTE_TOKEN" "$WORKER_BASE_URL/setup"
   ```

   `/setup` only checks that a LINE channel secret is present; it cannot prove an incoming webhook signature. For an admin token, confirm the old bearer now receives HTTP 401 and the new bearer works on both `/setup` and `/usage`.
4. With `WORKER_BASE_URL`, `ADMIN_ROUTE_TOKEN`, and `LINE_CHANNEL_SECRET` set to current production values, run smoke checks. They verify health, setup, usage, and a signed empty LINE webhook; they do not exercise an import, publication, or LINE push. `/setup` temporarily writes an R2 probe object and a Google Doc copy, then cleans them up:

   ```bash
   npm run smoke
   ```

5. Confirm the affected live operation separately where smoke cannot prove it (for example, a real signed LINE event or a scheduled import/publication). Revoke the old provider credential only after verification. If the replacement fails, restore the old value with the same `wrangler secret put` command, verify service recovery, and investigate before retrying.

## Credential notes

| Binding | Issuer and rotation detail |
|---|---|
| `AIRTABLE_TOKEN` | Replace the customer personal access token with `data.records:read`, `data.records:write`, and `schema.bases:read` on the correct base. |
| `LINE_CHANNEL_SECRET` | Regenerate in the same LINE Messaging API channel. Test a real signed webhook; setup checks only presence. |
| `LINE_CHANNEL_ACCESS_TOKEN` | Issue for the same LINE channel; verify admin-group delivery as well as setup group access. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Add a key to the *existing* service account in Google Cloud IAM, preserving its Shared Drive permissions; disable the old key after verification. |
| `ANTHROPIC_API_KEY` | Create a key in the same Anthropic workspace and verify `claude_credential`. |
| `ICLOUD_SHARED_ALBUM_TOKEN` | Use [album rotation](album-rotation.md) for a new album and its cutoff. A new token for the same album changes its source ID and risks duplicate imports. |
| `ASSET_URL_SIGNING_SECRET` | Changing it invalidates outstanding signed asset URLs immediately; there is no dual-key grace period. Allow at least 15 minutes after the last old URL was issued before rotation, or schedule a window when old links may expire. The longest current signed URL TTL is 900 seconds. |
| `ADMIN_ROUTE_TOKEN` | Update operator secret storage and current shell, then test old-token 401 and new-token success on `/setup` and `/usage`. |

## Rotation log

| Date | Secret | Reason | Verified via |
|---|---|---|---|

Append one row per successful rotation with the checks performed; never record old or new values.
