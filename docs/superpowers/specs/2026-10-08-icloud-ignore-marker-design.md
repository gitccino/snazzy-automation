# iCloud ignore marker

## Intent and agreed behavior

Clients sometimes photograph extra views of products already recorded in Airtable. Those photos share the import album with new products but must not create products, become attachments, consume product IDs, or be stored in R2 by the import pipeline.

Add a QR marker with the exact payload `SNAZZY_IGNORE_START_V1`. It closes the current product group and begins an ignored section. The next `SNAZZY_PRODUCT_START_V1` closes that section and starts a new product group. Photos before the ignore marker still belong to the preceding product group and must pass validation.

This spec applies to future imports and uses the album's existing ordered snapshot. It does not edit iCloud, update existing Airtable products, or delete existing R2 objects.

## Current pipeline and correction

`src/import/marker.ts` currently recognizes only the product-start payload and returns a boolean. `downloadAndGroupSnapshot` in `src/import/service.ts` downloads and stores all new eligible photos in R2 before `groupByMarkers` groups them. Cached assets persist a boolean `is_marker`, and group hashes include the product-start marker followed by its product photos.

The earlier conversation described four photos as an existing import requirement. Inspection shows that importing currently accepts at least one product photo; four photos are required later for document generation. This design introduces the agreed minimum of four product photos at import time. That applies consistently whether a group ends at another product marker, an ignore marker, or the snapshot boundary. More than four photos remain allowed.

## Approaches considered

1. **Classify and skip during the ordered scan — recommended.** Persist typed marker classification and process sections in source order. Ignored photos can be downloaded to identify later markers, but their bytes are not stored in R2. A small additive D1 migration supports durable retries.
2. **Filter groups after uploading every photo.** Smaller grouping-only change, but stores excluded photos in R2 and misses the agreed storage behavior.
3. **A separate album for extra views.** Avoids parser changes but asks clients to maintain another album and does not support the agreed marker workflow.

Reuse the current detector, grouping function, asset repository, workflow, and QR generator. No separate workflow or service is needed.

## Marker contract and state transitions

Classify a successfully processed image as `product_start`, `ignore_start`, or `none`. Match the two QR payloads exactly. Unrelated QR codes remain ordinary photos, matching current behavior. Keep the existing image normalization and detection limits. Download or normalization failures continue through existing error handling; do not label failed scans as ignored.

Three section states govern the ordered scan:

| Current state | Ordinary photo | Product-start marker | Ignore-start marker |
| --- | --- | --- | --- |
| Before any recognized marker | Preserve existing orphan behavior | Start product group | Enter ignored section |
| Product group | Add to current group | Close group; start another | Close group; enter ignored section |
| Ignored section | Skip | Resume by starting product group | Remain ignored |

At the snapshot boundary, close an open product group. An ignored section stays ignored to the end. Consecutive ignore markers are harmless. A product marker immediately followed by an ignore marker creates an empty, invalid product group; it is not silently discarded.

The product-start marker remains part of its group hash for compatibility but is never an attachment. An ignore marker belongs to no product group or hash. Ignored photos are not orphans and do not create failed groups.

Example:

```text
PRODUCT_START
four new product photos -> import product
IGNORE_START
extra views of an existing product -> skip
PRODUCT_START
four new product photos -> import product
```

## Persistence, R2, and retries

Extend the existing photo asset metadata with a typed marker classification and allow the R2 key to be null for ignored photos and ignore markers. Keep any legacy boolean compatible during rollout: legacy `is_marker = 1` maps to `product_start`; other legacy rows map to `none`. New code derives control behavior from the typed classification.

Process eligible photos in their existing source order. For each previously unseen photo, download and detect it, then decide whether it needs R2 storage. Persist the Apple photo ID, content hash, classification, and run metadata even when storage is skipped. This prevents downloading and classifying the same ignored photo again on a normal retry.

A product-start marker retains the existing storage behavior. An ignore-start marker and ordinary photos in its ignored section create no new R2 objects or previews. Existing stored bytes are not deleted. Content-hash reuse must only select assets with a real R2 key; an ignored metadata row is not a reusable object.

Reconstruct section state from the eligible ordered snapshot and cached classifications on each run. Do not reset to product mode at the start of a retry or because a new run begins. The current full eligible snapshot remains the source of context across checkpoints; no separate persistent mode flag is necessary.

If a cached ordinary photo is later placed in a product section because the source album changed, ensure an original R2 object exists before attaching it. A null R2 key must never reach signing or Airtable attachment construction. Conversely, a previously stored photo now inside an ignored section must be excluded without deleting its object.

Existing product group hashing, deduplication, and succeeded-group skipping remain intact when group membership is unchanged. This feature does not provide retroactive reconciliation for edits to already imported group membership. Clients should place the ignore marker before uploading the extra views, without inserting new boundaries into an already imported product group.

## Incomplete product groups

Validate the minimum of four non-marker product photos before allocating a product ID or creating an Airtable product. Record an incomplete group as a normal per-group failure with code `insufficient_product_photos` and no allocated product ID. Include it in the existing failed-group summary and let unrelated valid groups continue.

This replaces the current run-level empty-group rejection with consistent per-group validation for groups containing zero through three product photos. The ignore marker must not turn those groups into successful or skipped groups.

Example:

```text
PRODUCT_START
three product photos
IGNORE_START
extra views -> skip
```

The preceding group fails with three photos; none of the later extra views can complete it. A retry follows existing group identity and retry behavior. Repairing a failed group by changing its membership is not a new reconciliation mechanism in this feature.

## User experience and scope

Extend `scripts/generate-marker.ts` to generate either supported marker while preserving its existing product-start default. Produce a clearly labeled ignore-marker card so clients can distinguish it from the product-start card.

Keep `/upload`, `/retry`, success/failure summaries, scheduling, and authorization unchanged. An import containing only ignored photos may finish with zero imported products; ignored photos do not appear as failures or orphan warnings. D1 classification provides operational evidence of intentional skipping.

No new LINE command, test command, Airtable field, photo deletion, automatic association with existing products, or retroactive cleanup is included.

## Acceptance and validation plan

- Recognize both exact QR payloads using the existing normalization path; preserve unrelated-QR behavior.
- Product marker, four photos, ignore marker, extra photos: one product, only four attachments.
- Ignore marker before any product: subsequent photos skipped, not orphaned.
- Product marker after an ignored section resumes importing.
- Repeated ignore markers and ignored sections reaching snapshot end succeed without products or IDs.
- Zero through three photos before either boundary or snapshot end fail with `insufficient_product_photos`; valid neighboring groups still import.
- Four or more photos pass; neither marker becomes an attachment.
- Ignored photos and ignore markers never call R2 storage, preview signing, product ID allocation, or Airtable product creation.
- Cached ignored metadata never satisfies content-hash R2 reuse.
- Retrying after an ignored section preserves mode and avoids re-downloading successfully classified ignored photos.
- Legacy marker rows and unchanged product groups retain their interpretation and hashes.
- Test the nullable-key guard when an ignored photo later becomes attachable after a source change.
- Check migration compatibility, type checking, and focused detector/grouping/repository/service/workflow tests during implementation.

## Limits and assumptions

Correct grouping depends on the existing album ordering and readable QR images. Unrecognized marker images behave as ordinary photos, as they do today. Ignoring still requires downloading newly seen photos to detect the next product marker; it saves R2 and Airtable storage rather than all download bandwidth. Recognition of legacy non-marker rows assumes ignore-marker cards were not already uploaded before this feature exists.

The four-photo import minimum is an intentional new validation rule requiring review with this spec. Implementation and deployment have not started.
