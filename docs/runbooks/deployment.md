# Deployment Runbook

Deploy staging completely before creating or changing production. This runbook uses only customer-owned Cloudflare, Airtable, Google, LINE, Anthropic, and iCloud resources. Do not place real D1 IDs or credentials in committed files until Cloudflare has created the resources.

## Prerequisites

- Customer Cloudflare account with the Workers Paid plan ($5/month minimum), and `npx wrangler login` completed against that account.
- Customer-owned Airtable base with `Products` and `Publication Runs` tables that match the required schema.
- Customer-owned Google Cloud service account with the Docs and Drive APIs enabled. Add its `client_email` as an organizer to a dedicated customer-owned Shared Drive; the configured folder must be in that Shared Drive. Do not use domain-wide delegation or user impersonation.
- Customer-owned LINE Official Account and Messaging API channel with an admin group created.
- Printed `SNAZZY_PRODUCT_START_V1` QR marker cards (`npm run generate-marker`).
- Review the [publication setup contract](publication-setup.md). The authenticated setup check must prove the service account can copy, edit, rename, and permanently delete a disposable template copy; readable access alone is insufficient.

## Staging deployment

1. Create the staging D1 database and private R2 bucket, then upload the checked-in 1080×1080 JPEG base canvas:

   ```bash
   npx wrangler d1 create snazzy-automation-staging
   npx wrangler r2 bucket create snazzy-automation-staging-images
   npx wrangler r2 object put \
     snazzy-automation-staging-images/assets/collage-base-1080.jpg \
     --file docs/runbooks/collage-base-1080.jpg \
     --remote
   ```

   Copy the exact `database_id` returned by the D1 creation command into `env.staging.d1_databases[0].database_id` in `wrangler.jsonc`. Do not continue while that property is absent; never make up an ID. Validate the actual named-environment bindings before migrating or deploying:

   ```bash
   npx wrangler deploy --dry-run --env staging
   ```

2. Apply the staging migrations:

   ```bash
   npm run db:migrate:staging
   ```

   Expect `0001_initial.sql`, `0002_import_run_terminal_details.sql`, `0003_line_inventory.sql`, `0003_publication.sql`, `0004_line_recovery.sql`, and `0005_usage_metrics.sql`. The publication migration establishes the date claim and per-output input fingerprints.

3. Install every staging secret. Keep the LINE secret and admin token in this shell for the smoke commands.

   ```bash
   npx wrangler secret put AIRTABLE_TOKEN --env staging

   read -r -s -p "LINE channel secret: " LINE_CHANNEL_SECRET
   printf '%s' "$LINE_CHANNEL_SECRET" |
     npx wrangler secret put LINE_CHANNEL_SECRET --env staging
   export LINE_CHANNEL_SECRET

   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --env staging
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON --env staging
   npx wrangler secret put ANTHROPIC_API_KEY --env staging
   npx wrangler secret put ICLOUD_SHARED_ALBUM_TOKEN --env staging

   read -r -s -p "Asset URL signing secret: " ASSET_URL_SIGNING_SECRET
   printf '%s' "$ASSET_URL_SIGNING_SECRET" |
     npx wrangler secret put ASSET_URL_SIGNING_SECRET --env staging

   read -r -s -p "Admin route token: " ADMIN_ROUTE_TOKEN
   printf '%s' "$ADMIN_ROUTE_TOKEN" |
     npx wrangler secret put ADMIN_ROUTE_TOKEN --env staging
   export ADMIN_ROUTE_TOKEN
   ```

4. Deploy once and record the exact Worker origin, without a trailing slash:

   ```bash
   npm run deploy:staging
   read -r -p "Exact staging Worker base URL: " WORKER_BASE_URL
   export WORKER_BASE_URL
   ```

5. Read the customer-owned non-secret IDs and first import cutoff into the current shell:

   ```bash
   read -r -p "Airtable base ID: " AIRTABLE_BASE_ID
   read -r -p "Airtable Products table ID: " AIRTABLE_PRODUCTS_TABLE_ID
   read -r -p "Airtable Publication Runs table ID: " AIRTABLE_PUBLICATION_RUNS_TABLE_ID
   read -r -p "Allowed LINE group ID: " LINE_ALLOWED_GROUP_ID
   read -r -p "Google Drive folder ID: " GOOGLE_DRIVE_FOLDER_ID
   read -r -p "Google template document ID: " GOOGLE_TEMPLATE_DOC_ID
   read -r -p "First import cutoff ISO timestamp: " FIRST_IMPORT_CUTOFF_DATE
   export AIRTABLE_BASE_ID AIRTABLE_PRODUCTS_TABLE_ID
   export AIRTABLE_PUBLICATION_RUNS_TABLE_ID LINE_ALLOWED_GROUP_ID
   export GOOGLE_DRIVE_FOLDER_ID GOOGLE_TEMPLATE_DOC_ID
   export FIRST_IMPORT_CUTOFF_DATE
   ```

6. Generate the complete `APP_CONFIG_JSON`, install it as a secret, and redeploy:

   ```bash
   APP_CONFIG_JSON="$(node <<'NODE'
   const required = [
     "AIRTABLE_BASE_ID",
     "AIRTABLE_PRODUCTS_TABLE_ID",
     "AIRTABLE_PUBLICATION_RUNS_TABLE_ID",
     "LINE_ALLOWED_GROUP_ID",
     "GOOGLE_DRIVE_FOLDER_ID",
     "GOOGLE_TEMPLATE_DOC_ID",
     "WORKER_BASE_URL",
     "FIRST_IMPORT_CUTOFF_DATE",
   ];
   for (const name of required) {
     if (!process.env[name]) throw new Error(`${name} missing`);
   }
   process.stdout.write(JSON.stringify({
     AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
     AIRTABLE_PRODUCTS_TABLE_ID: process.env.AIRTABLE_PRODUCTS_TABLE_ID,
     AIRTABLE_PUBLICATION_RUNS_TABLE_ID: process.env.AIRTABLE_PUBLICATION_RUNS_TABLE_ID,
     LINE_ALLOWED_GROUP_ID: process.env.LINE_ALLOWED_GROUP_ID,
     GOOGLE_DRIVE_FOLDER_ID: process.env.GOOGLE_DRIVE_FOLDER_ID,
     GOOGLE_TEMPLATE_DOC_ID: process.env.GOOGLE_TEMPLATE_DOC_ID,
     PUBLIC_BASE_URL: process.env.WORKER_BASE_URL,
     TIME_ZONE: "Asia/Bangkok",
     IMPORT_CRON: "0 23 * * *",
     PUBLICATION_CRON: "30 23 * * *",
     UPLOAD_CUTOFF_MINUTES: 30,
     IMPORT_RETRY_LIMIT: 5,
     PUBLICATION_RETRY_LIMIT: 5,
     PRODUCT_ID_PREFIX: "A",
     PRODUCT_ID_INITIAL_NUMBER: 1,
     CLAUDE_MODEL: "claude-opus-5",
     CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 150000,
     SOLDOUT_CONFIRMATION_ENABLED: true,
     FIRST_IMPORT_CUTOFF_DATE: process.env.FIRST_IMPORT_CUTOFF_DATE,
     MONTHLY_BUDGET_THB: 1000,
     USD_TO_THB_RATE: 36,
     CLAUDE_INPUT_PRICE_USD_PER_MTOK: 5,
     CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: 25,
     R2_PRICE_USD_PER_GB_MONTH: 0.015,
   }));
   NODE
   )"
   printf '%s' "$APP_CONFIG_JSON" |
     npx wrangler secret put APP_CONFIG_JSON --env staging
   npm run deploy:staging
   ```

7. Bootstrap the Product ID sequence once. Pause staff imports while this scans Airtable:

   ```bash
   curl --fail-with-body \
     -X POST \
     -H "Authorization: Bearer $ADMIN_ROUTE_TOKEN" \
     "$WORKER_BASE_URL/setup/bootstrap-sequence"
   ```

   Expect `{"ok":true,"bootstrappedFrom":N}`, where `N` is one greater than the largest valid Airtable `A-<NUMBER>` or `PRODUCT_ID_INITIAL_NUMBER` when no valid ID exists. A second request must return HTTP 409.

8. Run the authenticated setup validator:

   ```bash
   curl --fail-with-body \
     -H "Authorization: Bearer $ADMIN_ROUTE_TOKEN" \
     "$WORKER_BASE_URL/setup"
   ```

   Expect HTTP 200 and all eleven checks with `ok: true`: `d1_migrations`, `r2_access`, `asset_delivery`, `images_binding`, `airtable_schema`, `sequence_consistency`, `line_webhook_config`, `google_template_access`, `claude_credential`, `icloud_phase_zero`, and `cron_timezone`. `r2_access` remotely verifies the private `assets/collage-base-1080.jpg` asset as a 1080×1080 JPEG. `google_template_access` performs the Shared Drive membership and disposable copy/edit/rename/delete rehearsal. Missing and wrong bearer values must return HTTP 401. Stop on any failed check; separately confirm `docs/feasibility/icloud-phase-0-report.md` says `PASS` before enabling publication traffic.

9. Register `$WORKER_BASE_URL/line/webhook` in the LINE Developers console for the staging channel.

10. Run the non-mutating smoke test:

    ```bash
    WORKER_BASE_URL="$WORKER_BASE_URL" \
    ADMIN_ROUTE_TOKEN="$ADMIN_ROUTE_TOKEN" \
    LINE_CHANNEL_SECRET="$LINE_CHANNEL_SECRET" \
    npm run smoke
    ```

    Expect `SMOKE TEST PASSED`.

## Production deployment

11. Create `snazzy-automation-production` and `snazzy-automation-production-images`, then repeat steps 1–10 with each `--env staging` changed to `--env production`, `npm run db:migrate:staging` changed to `npm run db:migrate:production`, and `npm run deploy:staging` changed to `npm run deploy:production`. At step 4, set `WORKER_BASE_URL` to the exact production Worker origin. Use production customer IDs and secrets. Copy the exact returned production `database_id` into `env.production.d1_databases[0].database_id` and rerun this before migration or deployment:

    ```bash
    npx wrangler deploy --dry-run --env production
    ```

    Commit both real D1 IDs in `wrangler.jsonc` after their dry-run validations. Those customer-owned resource IDs are not secrets.

## Rollback

Restore the prior Worker version with one of these commands:

```bash
npx wrangler rollback --env staging
npx wrangler rollback --env production
```

D1 migrations are additive-only. A Worker rollback neither deletes D1 data nor runs a reverse migration. Do not delete a publication date claim to force a second final publication; reconcile the conflicting Airtable row and retry instead.
