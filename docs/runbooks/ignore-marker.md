# Ignore extra product views in iCloud imports

Print or display [the ignore marker card](ignore-marker-card.svg) clearly, then photograph it before any extra views that should stay out of the product database.

- Start or resume imports with `SNAZZY_PRODUCT_START_V1`.
- Start ignoring with `SNAZZY_IGNORE_START_V1`.
- Ignoring lasts until the next product-start marker, including across uploads/retries. Repeated ignore markers keep ignoring.
- Each new product needs at least **four product photos**, excluding marker cards. More than four are allowed.
- Ignore closes the preceding product group. If it contains fewer than four photos, that product fails with `insufficient_product_photos`, receives no new Product ID, and does not block neighboring valid products.

Example album order:

```text
Product-start QR → product A photos 1–4
Ignore QR → extra views of an existing product
Product-start QR → product B photos 1–4
```

This imports two products, each with four attachments. The ignored section creates no Airtable row/attachments, allocates no Product ID, and writes no new R2 objects, including for its marker card. An ignored-only upload succeeds with zero imported products and no orphan warning.

The importer still downloads new ignored photos to detect the next QR marker. It stores only classification and hash metadata in D1 so retries can reconstruct the ignore state. Previously stored R2 objects and previously imported Airtable products are not deleted. If an album edit moves a skipped photo into an importable section, its original is downloaded and verified against its cached hash before storage.

Order follows the iCloud snapshot's photo positions. Keep marker images readable and correctly ordered; an unreadable QR is an ordinary photo. Neither marker bypasses the configured first-import cutoff date.

## Generate cards

```sh
npm run generate-marker -- --kind ignore
npm run generate-marker -- --kind product
node test/scripts/check-marker-cli.mjs
```

`--out <path>` selects a different output. The default product marker remains unchanged.

## Staging rollout

1. Ensure no import workflow is running. Do not overlap old/new workers on null-key metadata rows.
2. Review `migrations/0007_ignore_markers.sql` and the current `photo_assets` row count; preserve a D1 export.
3. Apply the migration: `npm run db:migrate:staging`.
4. Deploy: `npm run deploy:staging`.
5. Exercise one valid product, ignored extra views, then another valid product in a new album section.
6. Confirm two products, four attachments each, no Product ID for the ignored section, and no R2 objects for skipped bytes.
7. Repeat `/upload`; confirm no duplicate products or newly stored ignored objects. Check an incomplete product before an ignore marker is reported as failed while the following valid product succeeds.

Migration backfills old boolean markers and retains existing rows and indexes. Nullable classification supports legacy inserts during the migration/deployment gap; it does **not** make old workers safe once null-key ignored rows exist.

After new null-key rows exist, rolling back only the worker code is incompatible. Prefer fixing forward. Restore a matched database backup only when losing later writes is explicitly acceptable. Production deployment is a separate action.
