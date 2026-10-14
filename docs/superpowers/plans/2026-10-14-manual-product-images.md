# Manual Product Image Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task using the user's preserved Native execution preference. Steps use checkbox syntax for tracking.

**Goal:** Make `/docs` archive manually attached JPEG originals in R2, replace Airtable images with ordered previews, and generate documents from the original-image mappings.

**Architecture:** Add a durable preparation stage to PublicationWorkflow between validation and output generation. Reuse AssetStore and the signed preview route; use D1 per-product ownership, attachment mappings, and replacement intent for recovery. Keep raw attachment metadata distinct from prepared original keys.

**Tech Stack:** TypeScript, Cloudflare Workers/Workflows, D1, R2, Images binding, Airtable API, Zod, existing Vitest Cloudflare harness. No dependency additions.

**Spec:** `docs/superpowers/specs/2026-10-14-manual-product-images-design.md` (approved; JPEG-only existing-contract clarification added during planning).

## Global Constraints

- Archive every attached image, including images beyond the first four.
- Preserve attachment count and order after a successful replacement.
- Preserve the original downloaded bytes in R2; preview rendering must not overwrite them.
- Change only the Product Images field during replacement. Do not modify Product ID, prices, descriptions, links, or System Group ID.
- Complete ordinary run validation before replacing attachments. Paid caption generation starts only after image preparation succeeds.
- Use `airtable-preview-v1`: JPEG quality 80, at most 600 × 600, aspect ratio preserved, no upscaling.
- Maximum input: 20,000,000 bytes. Initial supported input: JPEG, detected from bytes and validated by transformation.
- Preview filename = original R2 key without `assets/`; signed preview URL TTL = existing 900 seconds.
- Use existing publication retry settings: configuration-controlled limit, 10-second initial delay, exponential backoff, 5-minute step timeout.
- Do not persist signed URLs or image buffers in D1 or durable step results.
- Do not delete originals on failures. No new LINE command, scheduler, Airtable field, secret, bucket, or workflow binding.
- Plan only in this change. Commands and tests below are future execution instructions; none are run while writing this plan. Follow session authorization before adding or running tests or changing live data.

## Review Focus

- Duplicate attachments with identical hashes: keep both positions and associate new IDs by position (Tasks 2 and 5).
- JPEG response with misleading filename/MIME or truncated bytes: validate bytes and preview output before replacement (Task 3).
- PATCH finishes but workflow crashes before saving new IDs: reconcile persisted intent without downloading previews (Task 5).
- Old instance is paused or its status cannot be read: do not take ownership based on elapsed time (Task 4).
- Staff reorder/add/remove images during preparation: do not submit a stale field; document the unavoidable final-read/PATCH race (Tasks 5 and 7).

---

## File map and contracts

Modify existing files narrowly; do not refactor publication finalization or LINE command routing.

| File | Responsibility |
| --- | --- |
| `src/publication/types.ts` | Raw attachment metadata, raw product, prepared product/run types. |
| `src/publication/airtable-runs.ts` | Read attachment metadata, read one product, patch only image field. |
| `src/publication/validator.ts` | Count raw attachments; retain all ordinary field requirements. |
| `migrations/0009_product_image_preparation.sql` | Add preparation operations and image mappings. |
| `src/db/product-image-repository.ts` | D1 ownership, snapshots, intent, alias mappings, legacy provenance query. |
| `src/publication/product-images.ts` | Durable image preparation orchestration and safe diagnostic rendering. |
| `src/publication/attachment-download.ts` | Bounded trusted download and JPEG validation. |
| `src/import/preview.ts` | Shared preview renderer extracted from existing asset route. |
| `src/routes/assets.ts` | Use shared renderer, retain signed URL behavior. |
| `src/publication/service.ts` | Accept prepared products for outputs; persist safe preparation failure reasons. |
| `src/publication/workflow.ts` | Inject actual instance ownership/status and execute preparation before captions. |
| `test/publication/product-images.test.ts` | State/recovery/ordering tests with real D1 and fake HTTP/Images. |
| `test/publication/attachment-download.test.ts` | Download limits, host/redirect validation, image rejection. |
| `test/db/product-image-repository.test.ts` | Migration, fencing, mapping, import provenance. |
| Existing publication/asset/acceptance tests | Update fixtures and pin preserved behavior. |
| `docs/runbooks/publication-setup.md` | Manual-product instructions, limits, migration/rollback cautions. |

## Task 1: Retain raw attachments and validate them before preparation

**Files:** Modify `src/publication/types.ts`, `src/publication/airtable-runs.ts`, `src/publication/validator.ts`, `src/publication/service.ts`; update `test/publication/airtable-runs.test.ts`, `test/publication/validator.test.ts`, and their product fixtures.

**Interfaces:** Keep `PublicationProduct` as the downstream prepared type with required `orderedImageKeys`. Add the following raw types:

```ts
export interface ProductAttachment {
  id: string;
  filename: string;
  size?: number;
  type?: string;
}
export type RawPublicationProduct = Omit<PublicationProduct, "orderedImageKeys"> & {
  attachments: ProductAttachment[];
};
export interface DownloadableProductAttachment extends ProductAttachment { url: string }
export interface ProductAttachmentRecord {
  airtableRecordId: string;
  productId: string;
  attachments: DownloadableProductAttachment[];
}
export type ProductImagePatch = { id: string } | { url: string; filename: string };
```

Keep existing `PublicationRun` and `ValidatedPublication` as prepared types. Add `RawPublicationRun = Omit<PublicationRun, "products"> & { products: RawPublicationProduct[] }` in types and `RawValidatedPublication = Omit<ValidatedPublication, "run"> & { run: RawPublicationRun }` in service types. `preparePublicationOutputs` continues consuming `ValidatedPublication`, never raw inputs. This lets Tasks 1–5 remain independently testable before the workflow switches to raw reads in Task 6.

Adapter exports:

```ts
loadRawRunById(fetcher: Fetcher, config: AirtablePublicationConfig,
  token: string, airtableRunId: string): Promise<RawPublicationRun>;
readProductAttachments(fetcher: Fetcher, config: AirtablePublicationConfig,
  token: string, recordId: string): Promise<ProductAttachmentRecord>;
replaceProductImages(fetcher: Fetcher, config: AirtablePublicationConfig,
  token: string, recordId: string, images: ProductImagePatch[]): Promise<void>;
```

- [ ] Add a regression in the existing Airtable adapter test using its `productRecord`, `config`, and `jsonResponse` helpers:

```ts
it("keeps manual filenames and omits expiring URLs from run output", async () => {
  const row = productRecord("recProd1", "A-11361");
  const body = { ...row, fields: { ...row.fields, "Product Images": [
    { id: "att1", filename: "ภาพ ด้านหน้า.jpg", url: "https://v5.airtableusercontent.com/x", size: 8000, type: "image/jpeg" },
  ] } };
  const fetcher = vi.fn<Fetcher>()
    .mockResolvedValueOnce(jsonResponse({ id: "recRun1", fields: {
      "Publication Date": "2026-10-14", Status: "Ready", Products: ["recProd1"],
    } }))
    .mockResolvedValueOnce(jsonResponse({ records: [body] }));
  const run = await loadRawRunById(fetcher, config, "token", "recRun1");
  expect(run?.products[0]?.attachments).toEqual([
    { id: "att1", filename: "ภาพ ด้านหน้า.jpg", size: 8000, type: "image/jpeg" },
  ]);
  expect(JSON.stringify(run)).not.toContain("airtableusercontent");
});
```

- [ ] Once test execution is authorized, run `npm test -- test/publication/airtable-runs.test.ts test/publication/validator.test.ts`; expect the new raw-attachment assertion to fail before implementation.
- [ ] Introduce a shared raw linked-product parser beneath `loadRawRunById`; extend its Zod attachment schema with optional nonnegative size and type. Strip URLs from returned run products. Reuse that schema for `readProductAttachments`; preserve current response-ID mismatch checks. Keep existing `loadRunById` and its filename-key compatibility behavior until Task 6, so intermediate commits do not change live workflow behavior. Implement Product Images PATCH with `{ fields: { "Product Images": images } }`, the same API auth and status classification as other adapter writes.
- [ ] Extend `validateRunCompleteness` to accept `Array<PublicationProduct | RawPublicationProduct>`, with image count determined by `"attachments" in product ? product.attachments.length : product.orderedImageKeys.length`. Share existing text/price rules. Add cases for 3/4/5 images and missing IG Price without weakening required fields. Add raw fixtures separately from prepared fixtures.
- [ ] Run the targeted tests and `npm run typecheck` when authorized; commit `refactor: preserve Airtable attachment metadata for publication` with only this task's files.

## Task 2: Persist preparation ownership, mappings, and replacement intent

**Files:** Create `migrations/0009_product_image_preparation.sql`, `src/db/product-image-repository.ts`, `test/db/product-image-repository.test.ts`.

**Interfaces:** Define these types in the new repository and import them in later tasks:

```ts
export type ImagePreparationState = "preparing" | "replacing" | "ready" | "failed" | "conflicted";
export type AttachmentSnapshot = Array<{ id: string; filename: string }>;
export type ImageReplacement = { kind: "retain"; attachmentId: string; filename: string }
  | { kind: "preview"; sourceAttachmentId: string; r2Key: string; filename: string };
export interface ImageOwner { recordId: string; workflowId: string; generation: number }
export interface OriginalImage {
  recordId: string; attachmentId: string; originalFilename: string;
  attachmentKind: "source" | "preview";
  contentHash: string; r2Key: string; mediaType: "image/jpeg";
  byteLength: number; previewFilename: string; variant: "airtable-preview-v1";
}
export interface ImagePreparation extends ImageOwner {
  state: ImagePreparationState; snapshot: AttachmentSnapshot;
  fingerprint: string; intent: ImageReplacement[] | null; safeError: string | null;
}
```

Export functions with explicit signatures:

```ts
readImagePreparation(db: D1Database, recordId: string): Promise<ImagePreparation | null>;
claimImagePreparation(db: D1Database, clock: Clock, recordId: string, workflowId: string,
  snapshot: AttachmentSnapshot, fingerprint: string, observed: ImagePreparation | null): Promise<ImageOwner | null>;
findOriginalImage(db: D1Database, recordId: string, attachmentId: string): Promise<OriginalImage | null>;
saveOriginalImage(db: D1Database, clock: Clock, owner: ImageOwner, image: OriginalImage): Promise<void>;
persistImageIntent(db: D1Database, clock: Clock, owner: ImageOwner, intent: ImageReplacement[]): Promise<void>;
completeImagePreparation(db: D1Database, clock: Clock, owner: ImageOwner,
  aliases: Array<{ sourceAttachmentId: string; previewAttachmentId: string }>): Promise<void>;
failImagePreparation(db: D1Database, clock: Clock, owner: ImageOwner,
  state: "failed" | "conflicted", safeError: string): Promise<void>;
assertImageOwner(db: D1Database, owner: ImageOwner): Promise<void>;
findImportedOriginal(db: D1Database, recordId: string, filename: string): Promise<{ contentHash: string; r2Key: string } | null>;
```

- [ ] Add real-D1 tests using `testEnv()` and the fixed clock from existing repository tests. Minimum fencing test:

```ts
const snapshot = [{ id: "att1", filename: "front view.jpg" }];
const first = await claimImagePreparation(env.DB, clock, "rec1", "wf1", snapshot, "fp1", null);
expect(first).not.toBeNull();
expect(await claimImagePreparation(env.DB, clock, "rec1", "wf2", snapshot, "fp1", null)).toBeNull();
const observed = await readImagePreparation(env.DB, "rec1");
const next = await claimImagePreparation(env.DB, clock, "rec1", "wf2", snapshot, "fp1", observed);
expect(next?.generation).toBe((first?.generation ?? 0) + 1);
await expect(assertImageOwner(env.DB, first!)).rejects.toMatchObject({ code: "product_image_owner_changed" });
```

The repository accepts an observed predecessor only after the caller has authorized terminal-owner recovery; it must CAS the exact observed owner/generation/state. Add concurrent claim, ready-owner reuse/release, immutable mapping conflict, and two source IDs sharing one hash with two preview aliases.

- [ ] Run `npm test -- test/db/product-image-repository.test.ts` when authorized; expect missing exports/tables to fail.
- [ ] Create additive tables with this storage shape:

```sql
CREATE TABLE product_image_preparations (
  record_id TEXT PRIMARY KEY, owner_workflow_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation > 0),
  state TEXT NOT NULL CHECK(state IN ('preparing','replacing','ready','failed','conflicted')),
  snapshot_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
  intent_json TEXT, safe_error TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE product_image_originals (
  record_id TEXT NOT NULL, attachment_id TEXT NOT NULL,
  attachment_kind TEXT NOT NULL CHECK(attachment_kind IN ('source','preview')),
  original_filename TEXT NOT NULL, content_hash TEXT NOT NULL, r2_key TEXT NOT NULL,
  media_type TEXT NOT NULL, byte_length INTEGER NOT NULL,
  preview_filename TEXT NOT NULL, variant TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(record_id, attachment_id)
);
```

- [ ] Implement Zod parsing and parameterized SQL. Fence every mutation with current owner/generation; each alias INSERT must use INSERT SELECT with an ownership predicate, in the same D1 batch as the ready transition, so a failed CAS cannot leave unowned mappings. Source and resulting preview IDs each point to the same original metadata, with attachmentKind distinguishing originals awaiting replacement from already converted previews. Reject conflicting existing mappings. Ready state permits the next operation to claim without terminal-status lookup; generation still increments. Keep intent on unknown failures.
- [ ] Implement provenance query by `product_groups.airtable_record_id`, group first/last photo endpoints, shared source album, and `photo_assets.position` inclusive range; require a succeeded group, valid endpoints, non-marker photo, exact canonical basename match, and nonnull key. Do not match unrelated R2 objects merely because filenames coincide. Verify R2 separately in Task 4.
- [ ] Run repository tests/typecheck when authorized; commit `feat: persist product image preparation and original mappings`.

## Task 3: Bound attachment downloads and reuse preview rendering

**Files:** Create `src/publication/attachment-download.ts`, `src/import/preview.ts`, `test/publication/attachment-download.test.ts`; modify `src/routes/assets.ts`, `test/routes/assets.test.ts`.

**Interfaces:**

```ts
downloadJpegAttachment(fetcher: Fetcher, attachment: DownloadableProductAttachment):
  Promise<{ bytes: ArrayBuffer; mediaType: "image/jpeg"; extension: "jpg" }>;
renderAirtablePreview(images: ImagesBinding, body: ReadableStream<Uint8Array>): Promise<Response>;
```

- [ ] Write download tests with a fake Fetcher: valid JPEG magic, non-JPEG magic, over-limit declared length, a streamed body crossing the limit, missing Content-Length, redirect to localhost, and timeout. Add this security regression:

```ts
it("does not fetch arbitrary attachment hosts", async () => {
  const fetcher = vi.fn<Fetcher>();
  await expect(downloadJpegAttachment(fetcher, {
    id: "att1", filename: "front.jpg", url: "https://127.0.0.1/private",
  })).rejects.toMatchObject({ code: "product_image_source_invalid" });
  expect(fetcher).not.toHaveBeenCalled();
});
```

- [ ] Run the new test and existing asset-route tests when authorized; expect missing helper to fail.
- [ ] Implement HTTPS host checks allowing `airtableusercontent.com` and its subdomains, reject credentials/nonstandard ports, request `redirect: "manual"`, and validate each of at most three redirects. Never send Authorization. Use one AbortController deadline of 30 seconds across fetch and stream reads; always clear the timer and cancel failed streams. Reject a declared or actual length above 20,000,000; detect JPEG `FF D8 FF` bytes regardless of filename. Transformation in the next step remains the decoder check; magic bytes alone are not proof of a valid image. HTTP 429/5xx and transport failures are retryable; invalid URL/format/size are not. Return only safe OperationalError messages.
- [ ] Extract the asset-route transformation unchanged into `renderAirtablePreview`: width/height 600, scale-down, JPEG quality 80, validate response status and `image/jpeg`. Keep route signatures, auth, original streaming, private cache headers and failure status unchanged. Preparation preflight must drain the preview body to expose streaming failures.
- [ ] Add corrupt/truncated JPEG preflight failure and misleading extension/MIME tests; preserve original bytes. Run authorized targeted tests/typecheck; commit `feat: validate manual image downloads and share preview rendering`.

## Task 4: Archive originals and coordinate product preparation

**Files:** Create `src/publication/product-images.ts`, `test/publication/product-images.test.ts`; modify `src/publication/workflow.ts` dependency wiring and `src/publication/service.ts` types.

**Interfaces:** Add to `product-images.ts`:

```ts
export type ImageExecutionStatus = "active" | "terminal" | "unknown";
export type ImagePreparationDeps = Pick<PublicationServiceDeps,
  "db" | "clock" | "fetcher" | "config" | "airtableToken" | "bucket" | "assets" | "images"> & {
  executionStatus(workflowId: string): Promise<ImageExecutionStatus>;
};
export interface ImagePreparationContext {
  owner: ImageOwner; product: RawPublicationProduct;
}
beginProductImagePreparation(deps: ImagePreparationDeps, workflowId: string,
  product: RawPublicationProduct): Promise<ImagePreparationContext>;
ensureProductOriginal(deps: ImagePreparationDeps, context: ImagePreparationContext,
  attachment: ProductAttachment, position: number): Promise<OriginalImage>;
```

- [ ] Build reusable fixtures inside the new test file using `testEnv()` for D1/R2, a fixed clock, `createAssetStore` from the existing helper, and a `vi.fn<Fetcher>` that serves one record and source bytes. Import `nonMarkerJpegBytes` from `test/helpers/marker-fixtures.ts` for decodable source bytes; use `.slice().buffer` for owned ArrayBuffers. Fake Images must record transform options, return an image/jpeg Response, and allow injected failures. Clear only the new tables in beforeEach.
- [ ] Test owner classification explicitly: active and paused => retryable `product_image_busy`; status exception/unknown => retryable `product_image_owner_unknown`; terminal => exact observed-owner takeover. Ready mappings are reusable despite an active previous publication owner. Wire `env.PUBLICATION_WORKFLOW.get(id).status()` using actual `event.instanceId`; whitelist terminal complete/errored/terminated, treat other recognized live states as active and unrecognized states as unknown. Do not reuse LINE instance lookups.
- [ ] Run authorized product-image tests; expect missing exported functions to fail.
- [ ] Implement begin: read current Airtable attachments, reject snapshot differences from validated metadata, hash JSON ordered `{id, filename}` entries with `sha256Hex`, consult current operation/status, reconcile replacing intent using Task 5 before admitting a new generation, then claim by CAS. Keep the caller workflow ID in every context.
- [ ] Implement ensure: assert owner; find existing mapping then verify R2 head; otherwise query verified import provenance and verify head, saving current attachment as attachmentKind preview; otherwise re-read URL for the same source attachment ID, verify the entire snapshot, download, hash original bytes, `putIfAbsent(hash, "jpg", bytes, "image/jpeg")`, verify head byte length, render/drain preview from R2, and persist mapping as attachmentKind source. Use the same safe missing-original error for known managed originals absent in R2; never download their preview as fallback.
- [ ] Add these assertions after a manual successful ensure:

```ts
expect(original.r2Key).toMatch(/^assets\/[a-f0-9]{64}\.jpg$/);
expect(original.previewFilename).toBe(original.r2Key.slice("assets/".length));
expect(await (await deps.bucket.get(original.r2Key))!.arrayBuffer()).toEqual(sourceBytes);
expect(JSON.stringify(await readImagePreparation(deps.db, "rec1"))).not.toContain("https://");
```

Add legacy same-product provenance/no-download, unrelated-record same filename rejection, missing R2 original, retry after R2 put before mapping, image 3 transform failure, and no Authorization on source fetch tests.
- [ ] Run authorized targeted tests/typecheck; commit `feat: archive product attachments with durable ownership`.

## Task 5: Replace previews and reconcile unknown PATCH outcomes

**Files:** Modify `src/publication/product-images.ts`, `test/publication/product-images.test.ts`.

**Interfaces:**

```ts
reconcileProductImageIntent(deps: ImagePreparationDeps, owner: ImageOwner):
  Promise<"ready" | "original" | "pending" | "conflicted">;
replaceProductImagePreviews(deps: ImagePreparationDeps, context: ImagePreparationContext):
  Promise<PublicationProduct>;
```

`pending` means ingestion has not completed and throws a retryable verification error at the caller. `original` authorizes retry of the existing intent only, not replacing it with a new snapshot. Conflict persists a safe error and prohibits a stale replacement. Terminal-owner takeover reconciles the predecessor intent before starting a different snapshot.

- [ ] Add scenarios using a mutable Airtable fake that changes IDs when accepting URL attachments and preserves retained entries. Have it throw after applying a PATCH to simulate unknown outcome. Pin both count/order and exactly one write:

```ts
const product = await replaceProductImagePreviews(deps, context);
expect(product.orderedImageKeys).toEqual(originals.map(image => image.r2Key));
expect(currentAttachments.map(image => image.filename)).toEqual(originals.map(image => image.previewFilename));
expect(currentAttachments).toHaveLength(5);
expect(patchBodies).toHaveLength(1);
expect(Object.keys(patchBodies[0].fields)).toEqual(["Product Images"]);
```

In this fixture declare `originals` as the five saved mappings, `currentAttachments` as fake server state, and `patchBodies` as parsed PATCH body captures. Reuse them for restart by reconstructing context from D1, not cached in-memory IDs.

- [ ] Run authorized product-image tests; the injected crash case must fail without reconciliation.
- [ ] Build intent only after every snapshot attachment has a verified mapping/object. Retain only mappings whose attachmentKind is preview; source mappings still require replacement even when archival completed on an earlier attempt. New source descriptors hold source ID, key, basename. Persist intent, re-read exact source snapshot, reassert owner, then sign new preview URLs at TTL 900 and submit the single Product Images patch.
- [ ] Compare readback by ordered descriptors: retained IDs must match; preview filename, nonempty URL, positive size, JPEG type, and width/height metadata at most 600 must be complete. Extend the adapter schema with optional thumbnail/dimension metadata needed for verification. Match duplicate preview filenames by position, not a Map keyed by hash. Persist all preview aliases and ready transition in one fenced D1 batch. Return prepared product with keys from these mappings and ordinary text/prices from validated product data.
- [ ] Reconcile before every retry: complete intended tuple => ready; original ID/filename tuple => retry same intent with fresh URLs; incomplete intended tuple => pending bounded by normal retries; unexpected tuple => conflict. Do not persist an error that erases intent. On retry exhaustion, retain unresolved intent for a new attempt to inspect. Do not auto-restore originals or erase current attachments.
- [ ] Add crash-after-PATCH-before-alias, PATCH timeout with original unchanged, saved source mapping still needs replacement, partial ingestion that eventually completes, permanent partial ingestion, staff reorder before patch/no writes, staff additions after unknown PATCH/conflict, duplicate hash/two aliases, and source URL expiry/same-ID refresh tests. Ensure conflict outputs contain no URL.
- [ ] Run authorized targeted tests/typecheck; commit `feat: reconcile Airtable preview replacement after interruptions`.

## Task 6: Insert durable preparation before publication outputs

**Files:** Modify `src/publication/product-images.ts`, `src/publication/workflow.ts`, `src/publication/service.ts`; update `test/publication/workflow.test.ts`, `test/publication/service.test.ts`, `test/publication/collage.test.ts`, `test/acceptance/publication.test.ts`.

**Interface:**

```ts
preparePublicationImages(deps: ImagePreparationDeps, validated: RawValidatedPublication,
  workflowId: string, step: WorkflowStep): Promise<ValidatedPublication>;
```

- [ ] Switch `validatePublication` to `loadRawRunById` and make its valid outcome contain `RawValidatedPublication`. Extend workflow stage mocks to expose preparation; make it return a prepared run. Assert its call occurs after validation and before captions/outputs, and validation_failed/already_succeeded/recovered-finalization skip preparation entirely. Test preparation failure prevents `preparePublicationOutputs`, temporary docs, and paid caption calls.
- [ ] Run authorized workflow tests; expect the new stage ordering assertion to fail.
- [ ] Implement orchestration outside `step.do` callbacks, with named steps for each product begin, each attachment ensure, and preview replacement. Example name shapes: `images <recordId> begin`, `images <recordId> <attachmentId> archive`, `images <recordId> replace`. Never nest step.do. Each callback returns metadata only. Process products/images sequentially and use the existing retry/timeout options. Put only prepared products/original keys in the resulting durable outputs.
- [ ] Use actual WorkflowEvent.instanceId for preparation ownership; keep current publication-generation checks intact. In `runPublicationWorkflow` add an optional trailing instance ID defaulting to `publicationWorkflowId(...)` for existing test/direct callers; the entrypoint passes the real ID. Add the status dependency in `depsFor` through the existing PUBLICATION_WORKFLOW binding, without altering env configuration.
- [ ] Preserve safe image reason across durable serialization: persist product ID, position and whitelisted category in D1; on exhausted stage read its safe diagnostic before calling `failPublicationAfterExhaustion`. Do not expose arbitrary Error.message. Keep existing post-success notification failure behavior and finalization recovery unchanged. Convert nonretryable preparation errors to NonRetryableError using fixed sanitized messages; transient contention/errors use existing bounded retries.
- [ ] Keep output generation's prepared `ValidatedPublication` input and pass only preparation's resolved result. Remove the obsolete filename-to-key conversion and prepared `loadRunById` path after `rg -n 'loadRunById|findRunnableRunForDate' src test` identifies and migrates every consumer to raw reads or an explicit prepared fixture; raw date lookup returns `RawPublicationRun`. Do not run paid captions for any product until preparation of all products succeeds. Retain first-four collage input behavior; reordering known previews changes key order/fingerprint, adding fifth image alone leaves first-four fingerprint unchanged.
- [ ] Add end-to-end fake tests: valid five-photo manual row, existing import-only run, mixed run, missing IG Price/no R2 or PATCH side effects, corrupt fifth image/no image PATCH or caption call, known preview reorder/no source download, newly added image/preserve existing IDs, and Docs failure after ready/retry reuses archived originals.
- [ ] Run authorized targeted publication/asset/import regression tests and typecheck; commit `feat: prepare manual product images in docs workflow`.

## Task 7: Validate complete behavior and document rollout

**Files:** Update `docs/runbooks/publication-setup.md` and `test/acceptance/publication.test.ts`; review the entire branch against all 15 spec acceptance criteria.

- [ ] Add runbook instructions: complete required fields, attach at least four JPEGs of at most 20,000,000 bytes each, link to the run, finish editing, send `/docs`; all images are archived and first four used. Describe filenames becoming hash basenames, retry/conflict correction, missing originals, and current per-row atomicity limitation. Do not suggest manually resetting D1 locks.
- [ ] Add a coverage table mapping each spec criterion to the test file/case implementing it. Verify all five Review Focus items have explicit tests. Scan changed callers/fixtures with `rg -n 'orderedImageKeys|attachments|preparePublicationOutputs|runPublicationWorkflow' src test` and resolve type/contract drift.
- [ ] With validation authorization, run these exact commands and record results separately:

```bash
npm run typecheck
npm test -- test/db/product-image-repository.test.ts test/publication test/routes/assets.test.ts test/import/service.test.ts test/acceptance/publication.test.ts
git diff --check
```

Distinguish existing failures from new regressions using the same commands on the unmodified base; do not silently accept failing relevant tests or repair unrelated features.

- [ ] Before any deployment, run `npx wrangler deploy --dry-run --env staging`. Inspect the additive migration and stage configuration. The eventual authorized deployment order is `npm run db:migrate:staging` followed by `npm run deploy:staging`; production requires the corresponding existing scripts and explicit target authorization.
- [ ] For an authorized live smoke test, create a disposable linked product/run containing five JPEG attachments with spaced/Thai filenames and valid text/prices. Snapshot record IDs, ordered source IDs, original byte hashes, and ordinary fields. Run `/docs` in LINE; verify successful document, five ordered previews within 600 × 600, five original mappings/R2 hashes, unchanged metadata, and first-four collage. Repeat using the existing supported regeneration/retry behavior and verify no new source downloads. Do not use A-11361 or another client record as a destructive fixture without authorization.
- [ ] Record the observed MIME, size, dimension metadata and attachment-ingestion behavior from the smoke test. If Airtable omits verification metadata required by Task 5, stop rollout and adapt verification using an authenticated record re-read plus bounded preview download/decode; never weaken verification to filename/count alone. This platform behavior must be proven before replacing client originals.
- [ ] Document rollback: preserve mapping-aware source resolution after conversion; keep additive tables and R2 originals. Do not roll back to filename-only code after manual rows have converted. Do not automatically delete live fixture records or R2 objects; cleanup is an explicitly scoped action.
- [ ] Commit `docs: document manual product image preparation and rollout`. Report validation evidence, any failures, live checks performed, and the external staff-edit/late-PATCH race. Stop after the authorized scope; do not automatically deploy, create a PR, or merge.

## Handoff

Implementation uses Native execution as previously requested. Review this plan before execution, as required by the writing-plans skill. Planning does not modify product code, Airtable attachments, R2 objects, or deployed Workers.

## Native execution record — 2026-10-14

Product code and runbook are implemented on `docs/manual-product-images-spec`. Typecheck, local D1 migrations (including 0009), and staging deploy dry run pass. A fresh whole-branch review identified recovery/provenance issues; the fix pass addressed them. Automated tests, fault-injection tests, and the disposable live Airtable/LINE smoke check were not added or run: session developer instructions require an explicit testing request. Remote migration, deployment, PR, and merge remain outside this implementation turn.

Review-driven refinements:

- Immutable `product_group_image_members` are recorded from current import snapshots before the succeeded-group skip. Historical position ranges are only candidates and must reproduce the stored group hash. Unprovable legacy candidates require exact preview-byte matching before original reuse; unknown hash filenames use ordinary source archival.
- Read-only mapped-preview reuse permits a completed operation to return after another workflow reclaims ready ownership. Every write remains fenced.
- Sanitized error product/position/category is saved in `publication_jobs.image_error_json` and reloaded after durable failure replay.
- Cached pre-upgrade validated products hydrate current attachment metadata in a durable step. Legacy prepared adapter exports remain for compatibility; production validation uses the raw path.
- Ambiguous unmatched previews after a conflict require original-image correction; the implementation will not guess which full-resolution original belongs to them.

The implementation is not evidence of live attachment ingestion or crash-recovery correctness. Those acceptance checks remain pending before rollout to client data.
