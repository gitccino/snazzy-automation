# Deployment Runbook9

Deploy staging completely before creating or changing production. This runbook uses only customer-owned Cloudflare, Airtable, Google, LINE, Anthropic, and iCloud resources. Do not place real D1 IDs or credentials in committed files until Cloudflare has created the resources.

## Prerequisites

- Customer Cloudflare account with the Workers Paid plan ($5/month minimum), and `npx wrangler login` completed against that account.
- Customer-owned Airtable base with `Products` and `Publication Runs` tables that match the required schema.
- Customer-owned Google Cloud project with Drive, Docs, and Picker APIs enabled, OAuth consent **In production**, and a Web OAuth client. The owner needs account recovery access and available My Drive storage. Prepare separate staging and production folders and templates; see [publication setup](publication-setup.md).
- Customer-owned LINE Official Account and Messaging API channel with an admin group created.
- Printed `SNAZZY_PRODUCT_START_V1` QR marker cards (`npm run generate-marker`).
- Review the [publication setup contract](publication-setup.md). The authenticated setup check must prove the owner's OAuth grant can copy, edit, rename, and permanently delete a disposable template copy; readable access alone is insufficient.

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

3. In an interactive local terminal, set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_PICKER_API_KEY`, and `GOOGLE_CLOUD_PROJECT_NUMBER`. Run `npm run google:drive-setup -- --expected-owner <owner-email>` and select the staging My Drive folder and template. Enter `GOOGLE_OAUTH_CLIENT_ID` as a non-secret value in `env.staging.vars` in `wrangler.jsonc` before deploying. Use the printed staging IDs at step 5 and enter the refresh token only through Wrangler's interactive prompt below. Install every staging secret. Keep the LINE secret and admin token in this shell for the smoke commands. These prompts work in zsh and do not use Bash-only `read -p`.

   ```bash
   npx wrangler secret put AIRTABLE_TOKEN --env staging

   printf '%s' 'LINE channel secret: '
   IFS= read -r -s LINE_CHANNEL_SECRET
   printf '\n'
   printf '%s' "$LINE_CHANNEL_SECRET" |
     npx wrangler secret put LINE_CHANNEL_SECRET --env staging
   export LINE_CHANNEL_SECRET

   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --env staging
   npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET --env staging
   npx wrangler secret put GOOGLE_REFRESH_TOKEN --env staging
   npx wrangler secret put ANTHROPIC_API_KEY --env staging
   npx wrangler secret put ICLOUD_SHARED_ALBUM_TOKEN --env staging

   printf '%s' 'Asset URL signing secret: '
   IFS= read -r -s ASSET_URL_SIGNING_SECRET
   printf '\n'
   printf '%s' "$ASSET_URL_SIGNING_SECRET" |
     npx wrangler secret put ASSET_URL_SIGNING_SECRET --env staging

   printf '%s' 'Admin route token: '
   IFS= read -r -s ADMIN_ROUTE_TOKEN
   printf '\n'
   printf '%s' "$ADMIN_ROUTE_TOKEN" |
     npx wrangler secret put ADMIN_ROUTE_TOKEN --env staging
   export ADMIN_ROUTE_TOKEN
   ```

4. Deploy once and record the exact Worker origin, without a trailing slash:

   ```bash
   npm run deploy:staging
   printf '%s' 'Exact staging Worker base URL: '
   IFS= read -r WORKER_BASE_URL
   export WORKER_BASE_URL
   ```

5. Read the customer-owned non-secret IDs and first import cutoff into the current shell. For the Google IDs, use the values printed by the staging setup utility:

   ```bash
   printf '%s' 'Airtable base ID: '
   IFS= read -r AIRTABLE_BASE_ID
   printf '%s' 'Airtable Products table ID: '
   IFS= read -r AIRTABLE_PRODUCTS_TABLE_ID
   printf '%s' 'Airtable Publication Runs table ID: '
   IFS= read -r AIRTABLE_PUBLICATION_RUNS_TABLE_ID
   printf '%s' 'Allowed LINE group ID: '
   IFS= read -r LINE_ALLOWED_GROUP_ID
   printf '%s' 'Google Drive folder ID: '
   IFS= read -r GOOGLE_DRIVE_FOLDER_ID
   printf '%s' 'Google template document ID: '
   IFS= read -r GOOGLE_TEMPLATE_DOC_ID
   printf '%s' 'First import cutoff ISO timestamp: '
   IFS= read -r FIRST_IMPORT_CUTOFF_DATE
   export AIRTABLE_BASE_ID AIRTABLE_PRODUCTS_TABLE_ID
   export AIRTABLE_PUBLICATION_RUNS_TABLE_ID LINE_ALLOWED_GROUP_ID
   export GOOGLE_DRIVE_FOLDER_ID GOOGLE_TEMPLATE_DOC_ID
   export FIRST_IMPORT_CUTOFF_DATE
   ```

6. Generate `APP_CONFIG_JSON` from the exported values, upload it as a staging secret, and redeploy staging:

   ```bash
   npm run configure:staging
   ```

   The helper validates the required values, pipes the config directly to Wrangler without printing it, and redeploys only if the secret upload succeeds.

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
   env ADMIN_ROUTE_TOKEN="$ADMIN_ROUTE_TOKEN" npm run staging:check
   ```

   This forwards the shell-only token to the helper without echoing or saving it. `WORKER_BASE_URL` is exported in step 4. The helper verifies missing and wrong bearer tokens are rejected with HTTP 401, then checks all eleven setup checks pass: `d1_migrations`, `r2_access`, `asset_delivery`, `images_binding`, `airtable_schema`, `sequence_consistency`, `line_webhook_config`, `google_template_access`, `claude_credential`, `icloud_phase_zero`, and `cron_timezone`. The R2/Images checks test the private collage base asset and transform; the Google check creates and removes a disposable template copy. Stop on any failure, and confirm `docs/feasibility/icloud-phase-0-report.md` says `PASS` before enabling publication traffic.

9. Register `$WORKER_BASE_URL/line/webhook` in the LINE Developers console for the staging channel.

10. Run smoke checks. `/setup` temporarily writes an R2 probe object and a Google Doc copy, then cleans them up; the smoke run makes no business import or publication changes:

    ```bash
    WORKER_BASE_URL="$WORKER_BASE_URL" \
    ADMIN_ROUTE_TOKEN="$ADMIN_ROUTE_TOKEN" \
    LINE_CHANNEL_SECRET="$LINE_CHANNEL_SECRET" \
    npm run smoke
    ```

    Expect `SMOKE TEST PASSED`.

## Production deployment

11. Create the production resources and upload the same private collage base canvas:

    ```bash
    npx wrangler d1 create snazzy-automation-production
    npx wrangler r2 bucket create snazzy-automation-production-images
    npx wrangler r2 object put \
      snazzy-automation-production-images/assets/collage-base-1080.jpg \
      --file docs/runbooks/collage-base-1080.jpg \
      --remote
    ```

    Copy the exact returned production `database_id` into `env.production.d1_databases[0].database_id` and rerun this before migration or deployment:

    ```bash
    npx wrangler deploy --dry-run --env production
    ```

Repeat staging steps 2–5 using production IDs and secrets. At step 3, rerun owner authorization for the separate production folder and template, and set `GOOGLE_OAUTH_CLIENT_ID` in `env.production.vars` before deployment. At step 4, set `WORKER_BASE_URL` to the exact production Worker origin. After exporting the production values, apply migrations and configure/deploy:

```bash
npm run db:migrate:production
npm run configure:production
```

Then continue with staging steps 7–10 using production values: bootstrap, setup validation, LINE webhook configuration, and smoke test.

`configure:production` uploads `APP_CONFIG_JSON` to the production Worker and deploys only production. Do not use `configure:staging` for this step. Commit both real D1 IDs in `wrangler.jsonc` after their dry-run validations. Those customer-owned resource IDs are not secrets.

## Rollback

Restore the prior Worker version with one of these commands:

```bash
npx wrangler rollback --env staging
npx wrangler rollback --env production
```

D1 migrations are additive-only. A Worker rollback neither deletes D1 data nor runs a reverse migration. Do not delete a publication date claim to force a second final publication; reconcile the conflicting Airtable row and retry instead.
