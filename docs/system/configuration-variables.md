# Configuration ownership

The authoritative editable field list and constraints are `src/settings/schema.ts`. After cutover, a singleton `app_settings` row in the existing D1 database owns the non-secret configuration. Edit it through the standalone settings site; export before changes. Do not edit raw JSON or regenerate APP_CONFIG_JSON as a substitute for saving D1 settings.

- Connections: Airtable base/products/publication-table IDs; Google folder/template IDs.
- LINE: allowed group ID array, soldout confirmation switch. Paste commas/newlines in the UI; storage is a deduplicated array.
- Import: UTC photo cutoff or null; retry limit 0 or 5.
- Documents: captions switch, editable Claude model ID; retry limit 0 or 5. Zero is one attempt; five is six attempts per durable step.
- Advanced: caption input limit (integer 1–150000), monthly budget and exchange rate (positive), three estimated provider cost rates (nonnegative).
- Read-only: historical initial product number; fixed Asia/Bangkok timezone and A prefix. The Import section provides a separately guarded next-product-number control; it does not rewrite the historical initial value.
- Deployment: CONFIGURATION_MODE (legacy/maintenance/d1), ENVIRONMENT, PUBLIC_BASE_URL, GOOGLE_OAUTH_CLIENT_ID. Preserve the actual original public origin.
- Secrets: provider tokens, Google client/refresh secrets, LINE channel/signing secrets, iCloud access, asset signing secret, admin bearer token. Never copy them into D1, exports, workflow snapshots or frontend code.

IMPORT_CRON, PUBLICATION_CRON and UPLOAD_CUTOFF_MINUTES are legacy-only, not new controls. Staging schedules are disabled in Wrangler and the scheduled handler has no side effects. WORKFLOW_RETRY_LIMIT exists only for the temporary bridge seed; D1 mode always uses the saved per-flow values. Keep the effective staging zero override while seeding, then remove it as specified in the cutover runbook.

The independent settings Worker needs ASSETS, the private SETTINGS_SERVICE binding and real ACCESS_TEAM_DOMAIN/ACCESS_AUD/SETTINGS_ORIGIN deployment values. It has no D1 or provider credential bindings. Local Vite development uses disposable samples. See [the full runbook](../runbooks/settings-console.md).

## Separate Worker secrets

- `AIRTABLE_TOKEN` — Credential allowing access to Airtable.
- `GOOGLE_OAUTH_CLIENT_SECRET` — Secret identifying the Google OAuth application.
- `GOOGLE_REFRESH_TOKEN` — Allows continued access to the connected Google account.
- `ANTHROPIC_API_KEY` — Credential for caption generation.
- `LINE_CHANNEL_ACCESS_TOKEN` — Allows the bot to send LINE messages and access permitted LINE APIs.
- `LINE_CHANNEL_SECRET` — Verifies incoming webhooks came from LINE.
- `ICLOUD_SHARED_ALBUM_TOKEN` — Source album token or supported shared-album URL. Treat it as sensitive because it enables album access.
- `ASSET_URL_SIGNING_SECRET` — Signs and verifies temporary image-access URLs.
- `ADMIN_ROUTE_TOKEN` — Protects administrative API routes.
- `APP_CONFIG_JSON` — Legacy configuration and bridge seed; D1 is authoritative after cutover.

## Separate non-secret Worker variable

- `GOOGLE_OAUTH_CLIENT_ID` — Identifies the Google OAuth application; paired with its client secret.

## Cloudflare resource bindings

These connect the Worker to infrastructure rather than storing ordinary settings.

- `DB` — D1 database holding sequences, processing state, and history.
- `IMAGES_BUCKET` — R2 storage for images.
- `IMAGES` — Image transformation service.
- `IMPORT_WORKFLOW` — Durable import processing.
- `PUBLICATION_WORKFLOW` — Durable document generation.
- `LINE_COMMAND_WORKFLOW` — Durable LINE command processing and retries.
- `LINE_MUTATION_FOLLOWUP_WORKFLOW` — Reconciles uncertain inventory updates.
