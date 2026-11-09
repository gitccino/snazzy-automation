# Configuration variables

Reference for the current application configuration, credentials, and Cloudflare resource bindings. Defaults and restrictions describe the code; they are not a fresh read of live secret values. No credential values are included here.

## Inside `APP_CONFIG_JSON`: connections

- `AIRTABLE_BASE_ID` — Airtable base containing the business data.
- `AIRTABLE_PRODUCTS_TABLE_ID` — Table containing products, inventory, prices, and sales.
- `AIRTABLE_PUBLICATION_RUNS_TABLE_ID` — Table tracking publication runs.
- `GOOGLE_DRIVE_FOLDER_ID` — Destination folder for generated documents.
- `GOOGLE_TEMPLATE_DOC_ID` — Google Docs template copied when generating documents.
- `LINE_ALLOWED_GROUP_ID` — LINE group authorized to use the bot and receive notifications.
- `PUBLIC_BASE_URL` — Worker's public address, used to construct image and other application links.

## Inside `APP_CONFIG_JSON`: imports and product IDs

- `PRODUCT_ID_PREFIX` — Prefix before the product number, such as `A`.
- `PRODUCT_ID_INITIAL_NUMBER` — Minimum starting number during first-time sequence initialization. It does not reset an initialized sequence; see the [initial product-ID runbook](../runbooks/product-id-initial-number.md).
- `FIRST_IMPORT_CUTOFF_DATE` — Earliest eligible photo capture timestamp. Despite its name, the current code applies this filter on subsequent imports too; `null` disables it.
- `UPLOAD_CUTOFF_MINUTES` — Currently expected to be `30` by setup validation. It does not control photo filtering or other operational behavior. Keep it until the schema requirement and setup check are removed.
- `IMPORT_RETRY_LIMIT` — Retry limit for import processing; currently restricted to `5`.

## Inside `APP_CONFIG_JSON`: scheduling and publication

- `TIME_ZONE` — Business timezone; currently restricted to `Asia/Bangkok`.
- `IMPORT_CRON` — Cron expression identifying scheduled imports. The configuration helper uses `0 23 * * *`: daily at 06:00 Bangkok time.
- `PUBLICATION_CRON` — Cron expression identifying scheduled document generation. The configuration helper uses `30 23 * * *`: daily at 06:30 Bangkok time.
- `PUBLICATION_RETRY_LIMIT` — Retry limit for publication processing; currently restricted to `5`.
- `SOLDOUT_CONFIRMATION_ENABLED` — Whether `/soldout` requires confirmation before updating inventory.

Cron expressions use UTC and must match Cloudflare's configured triggers. Editing these fields alone does not change the actual schedules. A separate budget-alert trigger, `45 22 * * *` (05:45 Bangkok time), is defined in deployment configuration and handled in code.

To disable all scheduled jobs, set the intended environment's `triggers.crons` to `[]` in `wrangler.jsonc` and deploy that environment. Keep `IMPORT_CRON` and `PUBLICATION_CRON` in `APP_CONFIG_JSON`: configuration validation still requires them. Manual `/upload` and `/docs` commands remain available.

## Inside `APP_CONFIG_JSON`: AI and estimated costs

- `CLAUDE_MODEL` — Model used for caption generation; currently restricted to `claude-opus-5`.
- `CLAUDE_REQUEST_INPUT_TOKEN_LIMIT` — Maximum planned input tokens per caption request; capped at `150000`.
- `MONTHLY_BUDGET_THB` — Threshold for estimated spending alerts; it does not automatically stop processing.
- `USD_TO_THB_RATE` — Exchange rate used for cost estimates.
- `CLAUDE_INPUT_PRICE_USD_PER_MTOK` — Estimated cost per million input tokens.
- `CLAUDE_OUTPUT_PRICE_USD_PER_MTOK` — Estimated cost per million output tokens.
- `R2_PRICE_USD_PER_GB_MONTH` — Storage rate used to estimate image storage costs.

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
- `APP_CONFIG_JSON` — Currently stores the configuration fields listed above.

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

## Source references

- [`src/config.ts`](../../src/config.ts): configuration schema and application field mapping.
- [`src/env.ts`](../../src/env.ts): Worker variables, secrets, and bindings.
- [`scripts/worker-app-config.ts`](../../scripts/worker-app-config.ts): generated configuration defaults; currently hardcodes the initial product number to `1`.
- [`src/scheduled.ts`](../../src/scheduled.ts) and [`wrangler.jsonc`](../../wrangler.jsonc): scheduled handlers and deployment triggers.
- [`src/routes/setup.ts`](../../src/routes/setup.ts): setup validation and sequence initialization.
- [`src/import/service.ts`](../../src/import/service.ts): photo cutoff filtering.
- [`src/monitoring/usage-report.ts`](../../src/monitoring/usage-report.ts): estimated cost calculations.
