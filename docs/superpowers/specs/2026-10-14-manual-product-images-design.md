# Prepare manually attached product images for /docs

Date: 2026-10-14
Status: Draft for user review

## Purpose

Allow staff to manually create a product in Airtable, attach its original photos, link it to a Publication Run, and use the existing `/docs` command. The publication workflow archives the originals in R2 and replaces Airtable attachments with small previews before generating the document.

Staff do not need to rename files, create QR markers, or run `/upload` for this product. Product ID and all product metadata remain unchanged.

## Existing behavior and evidence

- `src/publication/airtable-runs.ts` currently converts each attachment filename directly to `assets/<filename>`. Its filename validation rejects spaces and cannot resolve arbitrary manually uploaded attachments.
- `src/publication/collage.ts` reads originals from R2, using the first four ordered keys. An Airtable attachment alone does not establish that an original exists in R2.
- `src/import/asset-store.ts` already stores content-addressed originals and signs private asset URLs. `/upload` supplies preview URLs and names attachments using the original R2 key without `assets/`.
- `src/routes/assets.ts` already produces JPEG previews with quality 80, scaling down within 600 × 600 while preserving aspect ratio. Small images are not enlarged.
- Publication validation requires at least four images, required text fields, and both publication prices. Manual creation does not waive these requirements or automatically link a product to a run.

The reported A-11361 row illustrates two independent problems: its filenames contain spaces, and its IG Price is missing. Image preparation addresses the image-source problem; ordinary validation must still explain missing fields.

## Approaches considered

| Approach | Consequences |
| --- | --- |
| Read Airtable URLs directly during collage generation | Small initial change, but leaves large Airtable attachments and expiring source URLs; does not meet the storage requirement. |
| Add a separate command and image-import workflow | Durable processing, but adds another user action and workflow coordination. |
| Add durable image preparation to PublicationWorkflow | Reuses the current command, workflow retries, R2 store, and preview route. Meets the requirement with fewer new moving parts. |

Choose the third approach. Image preparation is a reusable publication service stage, executed through durable workflow steps. It does not create a separate scheduler or LINE command.

## User-visible behavior

Example: A-11361 has five original photos named `front view.jpg`, `side view.jpg`, and similar names.

1. Staff fill the required product fields and link the product to the Publication Run.
2. Staff send `/docs` as usual and receive the existing start response.
3. The workflow validates the run, then prepares every attachment requiring preparation.
4. All five original files are retained in R2. All five Airtable attachments become previews in the same order.
5. The collage uses the first four originals, following Airtable attachment order.
6. Document generation and its existing success response continue normally.

Preparation errors use the existing publication failure response, with a safe reason identifying the product and image position. Example reason: `A-11361: ไม่สามารถเตรียมรูปที่ 3 ได้ กรุณาตรวจสอบไฟล์รูปใน Airtable แล้วลอง /docs อีกครั้ง`. Never include signed URLs or raw upstream responses in LINE.

## Scope and invariants

- Archive every attached image, including images beyond the first four.
- Preserve attachment count and order after a successful replacement.
- Preserve the original downloaded bytes in R2; preview rendering must not overwrite them.
- Change only the Product Images field during replacement. Do not modify Product ID, prices, descriptions, links, or System Group ID.
- Do not reserve a new product ID, create an iCloud group, or synthesize import provenance.
- Complete ordinary run validation before replacing attachments. Paid caption generation starts only after image preparation succeeds.
- A later caption or Google Docs failure does not undo successful image preparation.
- A failure before attachment replacement leaves the Airtable image field unchanged by this operation. Originals already archived remain in R2 for recovery.

## Determine whether an attachment is managed

Track images by Airtable record ID and attachment ID. A missing System Group ID, an image's dimensions, or a filename alone is insufficient proof of origin.

Resolve each current attachment in this order:

1. A durable mapping for this record and attachment ID identifies its original R2 object; verify that object exists.
2. For legacy `/upload` products, verify import provenance against the existing D1 product-group and photo-asset records. Match a canonical attachment filename to an original belonging to that imported product and verify R2 existence. Bootstrap the attachment mapping without downloading its preview as an original.
3. Otherwise treat the attachment as an unmanaged source and archive the bytes obtained from its current Airtable download URL.

If an attachment is known to be a managed preview but its original is missing, fail with an actionable missing-original reason. Never silently archive the preview as a substitute original.

For an unmanaged attachment, the system can preserve only the bytes Airtable currently supplies. It cannot infer or recover a higher-resolution source that staff previously discarded.

## Durable state

Add D1 storage for a per-product preparation operation and its attachment mappings. Keep this separate from iCloud photo identifiers.

The operation records:

- Airtable product record ID, owning PublicationWorkflow instance ID and generation.
- A unique operation generation and state: preparing, replacing, ready, failed, or conflicted.
- Ordered source attachment IDs and filenames, and a fingerprint of that snapshot.
- Ordered intended replacement descriptors, preview variant version, and safe failure information.

Replacement descriptors contain retained attachment IDs or original R2 keys plus expected filenames, never signed URLs. Recover intended previews by ordered descriptors and verified attachment metadata; duplicate filenames are matched by position.

Each image mapping records:

- Product record ID, source attachment ID, original filename, and snapshot position.
- Original content hash, original R2 key, detected media type, and byte length.
- Expected preview filename and variant version.
- Resulting Airtable preview attachment ID when verified.

Retain source mappings when preview IDs replace them, so interrupted work can reconcile the replacement. Keep removed attachments' archived originals; removal from the current image list does not delete R2 data.

Do not persist signed download URLs as identity or workflow output. Persist identifiers and keys, then fetch or sign fresh URLs when needed.

## Processing sequence

1. Read the run and linked product records, retaining attachment metadata rather than deriving R2 keys immediately from filenames.
2. Validate required fields, prices, and attachment counts. Return existing validation failures before preparation starts.
3. Acquire per-product preparation ownership and snapshot the ordered attachment IDs and filenames.
4. Resolve already managed originals. For each unmanaged attachment, use a separate durable unit of work to download, validate, hash, store, verify, and persist its mapping. Process images sequentially to bound memory.
5. Preflight the existing preview transformation for every new original. Validate that the result is an image. Reuse the existing signed preview route for Airtable delivery; preflight output need not be permanently stored.
6. Confirm all originals exist in R2 and all mappings and preview preflights succeeded before removing any source attachments.
7. Re-read the product. If attachment IDs, order, or filenames changed from the snapshot, stop with a conflict; do not submit the stale replacement list.
8. Persist replacement intent. Create fresh signed preview URLs immediately before submitting Product Images. Preserve already managed attachments by ID and replace unmanaged entries with preview descriptors in their original positions.
9. Read back the product and verify replacement count, order, expected filenames, and completed attachment metadata. Associate returned preview attachment IDs with their original mappings. Only then mark the operation ready.
10. Supply ordered original R2 keys to caption/collage/document preparation. Keep existing output-cache fingerprints based on original keys and current order, never expiring URLs or preview IDs.

If Airtable attachment ingestion is incomplete, retry verification using the workflow's existing retry policy. Do not generate a document while replacement status is unresolved.

## Filenames and previews

Original filenames may contain spaces, Thai characters, or punctuation. They are preserved as metadata and never interpolated into R2 paths.

Original R2 keys use the existing convention: `assets/<sha256>.<detected-extension>`. A JPEG example becomes `assets/<hash>.jpg`; the Airtable preview filename becomes `<hash>.jpg`.

For compatibility with `/upload`, the preview filename is the original key with `assets/` removed. The preview bytes are JPEG even when the original key has a different extension. This existing naming convention is retained in this feature; consumers resolve originals through mappings and must not infer preview encoding from the filename.

Use the existing `airtable-preview-v1` transformation: JPEG quality 80, at most 600 × 600, aspect ratio preserved, no upscaling. Store full-resolution originals indefinitely under existing retention behavior.

Duplicate byte-identical originals reuse the same R2 object. Separate attachment entries retain separate positions and mappings; do not collapse the user's image list.

## Retries and recovery

Use the existing publication workflow retry policy; no new retry schedule is introduced. Completed per-image work is reused after restart or a new `/docs` attempt.

Airtable download URLs expire. On a download retry, re-fetch the record and obtain a fresh URL for the same attachment ID. If the source attachment disappeared or changed, report a conflict rather than silently switching sources. [Airtable attachment URL behavior](https://support.airtable.com/articles/9671148410-airtable-attachment-url-behavior)

Before retrying a replacement with an unknown outcome, re-read Airtable:

| Current images | Recovery |
| --- | --- |
| Exact intended preview sequence | Verify attachment metadata, reconcile mappings, and mark ready without downloading previews as originals. |
| Exact original snapshot | Reuse archived originals and retry the same replacement with fresh URLs, after ownership checks. |
| Neither sequence, including partial ingestion or staff edits | Do not blindly patch. Continue bounded verification if ingestion is still progressing; otherwise record a conflict and report it. |

After an operation is ready, reordering known previews changes the document order without another image conversion. Newly added unmanaged attachments are prepared under a new snapshot while existing managed entries are reused. Removed attachments are omitted from the document without deleting their archived originals.

## Coordination and concurrent edits

Two publication runs may reference the same product. Per-run ownership is insufficient: only one preparation owner may replace that product's images at a time.

Use D1 compare-and-set ownership with the actual workflow instance ID and operation generation. An active or paused owner keeps ownership. A terminal owner can be recovered by a new workflow, reconciling any persisted replacement intent first. Unknown instance status must not authorize takeover or another replacement. A competing run receives a retryable preparation-in-progress result, bounded by the existing workflow policy.

Release preparation ownership once verified ready, even while document generation continues. Other runs may immediately reuse ready mappings; a changed attachment snapshot requires a new preparation operation.

Ownership checks fence D1 updates and check permission immediately before Airtable writes. They do not cancel an HTTP request Airtable already received.

Detect staff changes with the re-read before replacement and verification afterward. On conflict, preserve the current field and require a fresh `/docs` attempt after staff finish editing. Do not restore an old attachment list automatically.

**Remaining concurrency limit:** the current Airtable adapter has no atomic conditional attachment-field update. Staff can edit between the final read and PATCH, or an earlier timed-out PATCH can finish late. D1 fencing cannot eliminate that external race. The feature must not claim guaranteed protection against simultaneous Airtable image edits. Staff should finish image edits before starting `/docs`; originals in the captured snapshot are backed up before replacement, but a concurrently added attachment may fall outside that snapshot.

## Input validation and resource bounds

- Download only HTTPS URLs returned in Airtable attachment metadata, with approved Airtable attachment hosts and redirect validation. Never forward the Airtable API bearer token to download hosts.
- Apply bounded download timeouts and enforce size limits while reading, not only through Content-Length.
- Set an initial per-image cap of 20,000,000 bytes, matching a conservative interpretation of the Images binding's documented 20 MB input limit. Files exceeding this cap fail before replacement. [Cloudflare Images limits](https://developers.cloudflare.com/images/get-started/limits/)
- Use the existing import-supported image media types and detected extensions. Reject unsupported types, corrupt files, and transformation failures with product/image context. Do not expand format support in this feature.
- The current `SourcePhoto` contract in `src/icloud/types.ts` supports JPEG only. Initial manual preparation therefore accepts JPEG bytes and stores `.jpg` originals; the filename compatibility rule above remains applicable to legacy mappings.
- Keep bytes inside the individual processing step. D1 and durable step results contain metadata and keys, not image buffers.
- Redact attachment URLs and signed asset URLs from logs and user replies. Record operation ID, product record ID, image position, state, and safe error category for diagnostics.

## Components affected

- Airtable publication adapter: retain attachment metadata, patch Product Images, and verify readback.
- Publication types and validator: distinguish raw attachment counts from prepared original keys; preserve existing field validation.
- Publication service/workflow: add durable preparation before paid/output generation and preserve recovery/finalization behavior.
- D1 repository and additive migration: preparation ownership, snapshots, replacement intent, and attachment mappings.
- Shared asset/preview helpers: reuse import behavior without changing `/upload` grouping or ID allocation.
- Collage/cache consumers: continue receiving original R2 keys in current Airtable order.
- Relevant publication fixtures and regression coverage: exercise both legacy imported and manually attached products.

No new Airtable field, LINE command, secret, R2 bucket, background scan, or separate workflow binding is required.

## Acceptance criteria

1. A valid manual product with five original images produces five ordered previews and five recoverable original mappings; its collage uses the first four originals.
2. Spaces and Thai characters in source filenames do not prevent preparation. Product ID and all other fields are unchanged.
3. A second `/docs` attempt reuses originals and mappings; it never archives managed previews as originals.
4. Legacy imported products resolve through verified import mappings without downloading their previews. Missing known originals fail explicitly.
5. Reordered previews change collage order; adding a new unmanaged image prepares that image while preserving existing managed attachments.
6. Failure downloading or transforming image 3 of 5 causes no attachment replacement; successfully archived images remain reusable.
7. Missing IG Price or another required field fails validation before image replacement or paid caption work.
8. Expired attachment URLs are refreshed by attachment ID. Deleted/replaced attachments cause a conflict.
9. Crash after R2 storage reuses the content-addressed object. Crash after PATCH but before D1 completion reconciles intended previews without another downgrade.
10. Unknown PATCH outcome is read back before retry. Unexpected attachment sequences are never treated as successful preparation.
11. Concurrent publication runs cannot both own a product's preparation operation. Terminal-owner recovery reuses durable state.
12. Detected staff edits before replacement stop the stale write. The external read/PATCH race remains explicitly documented.
13. Duplicate images retain their separate attachment positions; all images beyond the first four are archived.
14. Oversized, unsupported, or corrupt input fails with a safe actionable reason before replacement. Signed URLs never appear in LINE or durable identifiers.
15. A Google Docs or caption failure after successful preparation leaves previews and originals usable on the next attempt.

## Exclusions and rollout

This feature does not scan all Airtable records, recover unavailable originals, repair product-ID sequence drift, add QR markers, or add an interface for attaching photos through LINE. It prepares products already linked to the requested Publication Run.

Deploy the additive D1 migration before code that uses it. Retain legacy imported-image resolution so existing products remain usable. Once manual attachments have been replaced, a rollback must retain mapping-aware source resolution; reverting to filename-only resolution would lose ordering/provenance safeguards for these rows.

The specification is ready for user review. Implementation planning follows approval; no product code or live attachment data is changed by this document.
