# Publication deployment contract

For the Google Picker API key, restrict website referrers to `http://127.0.0.1:8765/*` and `https://docs.google.com/*`. Restrict API access to both the Google Picker API and Google Drive API. The Picker iframe is hosted on `docs.google.com`, so omitting that referrer can cause an invalid developer key error.

Complete these checks in each customer-owned environment before enabling publication traffic. The live setup validator and deployment rehearsal belong to the hardening/handoff plan; local tests do not establish remote permissions or asset availability.

## Personal Google Drive

The owner uses a personal Google account with available My Drive storage and recovery access. In each environment, create a separate My Drive output folder and a Google Docs template inside it. The owner shares the folder with intended collaborators through Google Drive; collaborators need no application authorization. Keep the folder private to those collaborators.

Enable the Drive, Docs, and Picker APIs in the customer-owned Google Cloud project. Configure an OAuth consent screen with `drive.file` (plus basic `openid` and `email` for owner confirmation), a Web application OAuth client with `http://127.0.0.1:8765/oauth/callback` as its authorized redirect URI, and Picker credentials. Move the consent screen to **In production** before production handoff; a project left in **Testing** can issue refresh tokens that expire after seven days. Confirm any verification requirement in the Cloud Console.

In an interactive local terminal, set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_PICKER_API_KEY`, and `GOOGLE_CLOUD_PROJECT_NUMBER`, then run `npm run google:drive-setup -- --expected-owner <owner-email>` once per environment. Sign in as the expected owner and select that environment's folder and template in Picker. The utility confirms the account and prints the selected IDs and refresh token only to the terminal. Store the token in the customer secret store and enter it through Wrangler's interactive `GOOGLE_REFRESH_TOKEN` prompt; keep it out of shell history, files, tickets, and logs. Use the printed IDs for that environment's `GOOGLE_DRIVE_FOLDER_ID` and `GOOGLE_TEMPLATE_DOC_ID`. Bind `GOOGLE_OAUTH_CLIENT_ID` as a non-secret Worker variable and `GOOGLE_OAUTH_CLIENT_SECRET` plus `GOOGLE_REFRESH_TOKEN` as Worker secrets.

Before enabling publication, authenticated `/setup` must pass `google_template_access` using the same `drive.file` grant as publication. Verify the folder is an accessible My Drive folder; the template is a Google Doc inside it with `{{PUBLICATION_DATE}}`, `{{PRODUCTS}}`, and `{{END_PRODUCTS}}` each in one text run; and a disposable copy can be created, found by run property, read and edited through Docs, renamed, and permanently deleted. The text between the product markers is the repeated per-product suffix. Record safe IDs and outcomes only. If cleanup fails, use the reported safe probe ID for manual cleanup. Confirm a staging generated document is owned by the owner and opens for a folder collaborator without app authorization.

## Cloudflare resources and base canvas

- The top-level Wrangler configuration contains `"images": { "binding": "IMAGES" }`. The local Worker-binding smoke test verifies that it is available. Named Wrangler environments do not inherit Images, D1, R2, or Workflow bindings; the hardening deployment configuration must provide each environment's bindings and validate them with `wrangler deploy --dry-run --env <environment>` before deployment. The current staging/production entries are placeholders.
- Enable the account's Images transformations capability and verify a real JPEG transformation in staging. An HTTP error or non-JPEG response must fail without replacing the R2 collage or its D1 cache entry. See [Cloudflare's Images binding documentation](https://developers.cloudflare.com/images/optimization/binding/).
- Apply `0001_initial.sql`, `0002_import_run_terminal_details.sql`, and `0003_publication.sql` in order. Migration 0003 was edited before deployment to include date claims and cache fingerprints. A database that already applied an earlier local copy of 0003 needs a separately reviewed upgrade or a fresh disposable test database; replaying the migration name does not add the new columns.
- Upload the checked-in `docs/runbooks/collage-base-1080.jpg` to the environment's private R2 bucket at exactly `assets/collage-base-1080.jpg`. Verify the remote object is the expected 1080×1080 JPEG before enabling publication. This upload remains a deployment prerequisite; the local test suite does not perform it.

## Date ownership and retry behavior

Keep one Airtable Publication Run row per Bangkok publication date. Date lookup checks up to two rows across all statuses and rejects duplicates for staff reconciliation. Run ID remains the Workflow identity (`publication-<runId>`) and the Google document's recovery property.

After completeness validation, D1 atomically claims the date for that run. The claim survives Failed restart and success, and cannot be moved by editing Airtable. Correct or reconcile a conflicting row before retrying; never delete a date claim to force a second final publication. Incomplete runs that never passed validation have no claim yet.

A Failed restart reloads Airtable and compares input fingerprints before reusing outputs. Collages depend on the first four ordered R2 keys and the base/transform version. Caption fingerprints use exactly the text sent to Claude (Product ID, brand, model, condition, size, description), the Claude model, and the prompt/schema version. Text normalization trims surrounding whitespace, normalizes line endings, and uses Unicode NFC. Prices and images beyond the first four do not affect those respective generated outputs. Successful validation clears D1 validation details, and Generating/Generated clears Airtable Error Summary.

When changing the collage base asset or transformation parameters, bump `COLLAGE_BASE_TRANSFORM_VERSION` in `src/publication/collage.ts`. When changing the caption prompt, output schema, or validation rules, bump `CAPTION_PROMPT_SCHEMA_VERSION` in `src/publication/captions.ts`. Deploy the matching base asset and code together.
