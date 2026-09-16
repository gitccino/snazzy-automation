# Publication deployment contract

Complete these checks in each customer-owned environment before enabling publication traffic. The live setup validator and deployment rehearsal belong to the hardening/handoff plan; local tests do not establish remote permissions or asset availability.

## Google Shared Drive

Use direct service-account authentication with the existing `GOOGLE_SERVICE_ACCOUNT_JSON`. `GOOGLE_DRIVE_FOLDER_ID` must identify a folder in a customer-owned Shared Drive. Do not configure domain-wide delegation or user impersonation. Service accounts cannot own Drive files or use personal storage quota; Shared Drive ownership supplies the storage for template copies. See [Google's Shared Drive ownership model](https://developers.google.com/workspace/drive/api/guides/about-shareddrives).

Use a dedicated Shared Drive for Snazzy and add the service account's `client_email` as a member. The account must be able to read/copy the template, create and edit documents, rename them, and permanently delete incomplete copies. The existing cleanup uses `files.delete`, which requires the `organizer` role on the parent folder in a Shared Drive; verify effective permissions, not only a successfully readable template. See [Google's delete requirements](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/delete).

The later setup validator and handoff must verify:

1. Fetch the configured folder with `files.get`, `supportsAllDrives=true`, and fields including `id,mimeType,driveId,capabilities`. Require folder MIME type and a nonempty `driveId`; reject a My Drive folder.
2. Verify that exact service-account email's Shared Drive membership and effective creation/deletion permissions. A domain-wide share or sharing only the template is insufficient.
3. Read `GOOGLE_TEMPLATE_DOC_ID` and verify a Google document in the configured folder, accessible to the service account. Keep the literal `{{PUBLICATION_DATE}}`, `{{PRODUCTS}}`, and `{{END_PRODUCTS}}` markers each within one text run. The text between the product markers is the repeated per-product suffix.
4. In staging, exercise copy, lookup by run property, Docs read/edit, final rename, and deletion of a disposable probe copy. Record only safe IDs and outcomes. Retain failure evidence without logging tokens, signed image URLs, or raw response bodies.

All Drive list/copy/update/delete requests in publication now set `supportsAllDrives=true`; list also sets `includeItemsFromAllDrives=true`, including paginated recovery queries. Setup's Drive reads and permission queries must use the same Shared Drive support. See [Google's request parameters](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives).

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
