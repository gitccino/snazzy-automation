# iCloud Ignore Marker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skip extra product views between an ignore marker and the next product marker, without importing or storing them, while rejecting incomplete new product groups.

**Architecture:** Extend the existing marker classifier and photo metadata, then scan the current ordered snapshot using cached classifications. Keep grouping pure; make storage conditional during scanning and validate groups before product ID allocation. Reuse existing workflow failures, summaries, hashing, and QR generation.

**Tech Stack:** TypeScript, Cloudflare Workers/Workflows, D1 SQLite, R2, Cloudflare Images, installed `jsqr`, `jpeg-js`, `qrcode`, and Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-icloud-ignore-marker-design.md`

## Global Constraints

- Exact payloads: `SNAZZY_PRODUCT_START_V1` and `SNAZZY_IGNORE_START_V1`.
- Ignore closes the current product group; only another product marker resumes importing.
- Minimum four non-marker photos for a new import; more than four allowed.
- Incomplete groups use `insufficient_product_photos`, allocate no ID, and do not stop valid neighboring groups.
- Ignore markers and ignored photos create no new R2 object, preview, Airtable attachment, product record, or product ID.
- Persist skip classifications in D1; downloading newly seen ignored photos is necessary to detect the next marker.
- Product marker stays in group hash; ignore markers and skipped photos never enter a group hash.
- Preserve existing succeeded groups, marker defaults, orphan behavior, cutoff filtering, and LINE summary format.
- No new dependencies, workflow, command, Airtable field, or deletion of existing photos/objects.
- Implement in an isolated worktree from `docs/ignore-marker-spec` after this plan is approved. Do not change unrelated edits in the original checkout.

## Review Focus

1. A run starting after an ignored section must reconstruct mode from the full eligible snapshot, including cached rows (Task 4 retry test).
2. Repeated ignore markers and ignore-before-first-product must not become orphans or invalid product groups (Task 3).
3. A content-hash match with a null R2 key must not produce a signed URL or skip necessary storage (Task 2/4).
4. Legacy rows and unchanged product groups must retain marker interpretation and group hashes (Task 2/3).
5. A cached skipped photo later moved into a product section must obtain an original R2 object; changed downloaded bytes must fail rather than silently link the wrong hash (Task 4).

## File map

- `src/import/marker.ts`: exact typed classification, existing normalization.
- `src/import/grouping.ts`: product/ignore state transitions and unchanged hash inputs.
- `src/db/import-repository.ts`: typed classifications, nullable object keys, promotion of cached photos.
- `migrations/0007_ignore_markers.sql`: preserve existing rows while making `r2_key` nullable and adding classification.
- `src/import/service.ts`: ordered scan, conditional storage, safe attachment keys, four-photo validation.
- `scripts/generate-marker.ts`: product/ignore generation with product default.
- `docs/runbooks/ignore-marker-card.svg` and `docs/runbooks/ignore-marker.md`: usable marker and client/deployment instructions.
- Existing detector, grouping, repository, service, workflow, generator tests and fixture helpers: targeted coverage and fixture updates for changed interfaces/minimum.

## Task 1: Typed QR classification

**Files:** Modify `src/import/marker.ts`, `test/helpers/marker-fixtures.ts`, `test/import/marker.test.ts`, `test/helpers/import-fixtures.ts`, and detector stubs in `test/import/service.test.ts`.

**Interfaces:** Export `MarkerKind = "product_start" | "ignore_start" | "none"`, `IGNORE_MARKER_PAYLOAD`, and `detectMarkerImage(bytes: Uint8Array): MarkerKind`. Change `MarkerDetector.detect(bytes: ArrayBuffer): Promise<MarkerKind>`. Keep `isMarkerImage(bytes): boolean` as a product-start compatibility wrapper until its remaining test callers are updated.

- [ ] Add `ignoreMarkerJpegBytes()` using the existing private `qrJpeg` helper; add exact-payload assertions:

```ts
expect(detectMarkerImage(markerCleanJpegBytes())).toBe("product_start");
expect(detectMarkerImage(ignoreMarkerJpegBytes())).toBe("ignore_start");
expect(detectMarkerImage(wrongPayloadJpegBytes())).toBe("none");
expect(detectMarkerImage(nonMarkerJpegBytes())).toBe("none");
expect(detectMarkerImage(new Uint8Array([1, 2]))).toBe("none");
```

- [ ] Run `npx vitest run test/import/marker.test.ts`; confirm the new classifier assertions fail before implementation.
- [ ] Replace the boolean decode function with this classification after the existing JPEG decode and QR call:

```ts
export type MarkerKind = "product_start" | "ignore_start" | "none";
export const IGNORE_MARKER_PAYLOAD = "SNAZZY_IGNORE_START_V1";
// JPEG decode failure remains "none", matching existing unreadable-image behavior.
const payload = code?.data;
return payload === MARKER_PAYLOAD ? "product_start"
  : payload === IGNORE_MARKER_PAYLOAD ? "ignore_start" : "none";
```

Keep normalization at 1024×1024, `fit: "contain"`, JPEG. `createMarkerDetector` returns `detectMarkerImage(normalized)`. Update boolean stubs to return `product_start` or `none`; extend `BatchPhotoSpec` with optional `markerKind: MarkerKind` for ignore fixtures while preserving existing `isMarker` fixture shorthand. Normalize transformer failures must still throw.

- [ ] Run the detector tests, including normalization with both recognized payloads, then commit `feat: classify product and ignore markers`.

## Task 2: Persist classifications without requiring an R2 object

**Files:** Create `migrations/0007_ignore_markers.sql`; modify `src/db/import-repository.ts`, `test/db/import-repository.test.ts`, and asset fixtures found by `rg -n 'recordPhotoAsset|PhotoAssetRow' test`.

**Interfaces:** `PhotoAssetRow.r2Key: string | null`; add required `markerKind: MarkerKind`. Retain `isMarker` as the compatibility product-start flag. Add `ImportRepository.setAssetR2Key(sourceAlbumId: string, applePhotoId: string, r2Key: string): Promise<void>`.

- [ ] Add repository coverage using the existing `repo()` helper:

```ts
const r = repo();
const sourceAlbumId = `album-${crypto.randomUUID()}`;
const importRunId = crypto.randomUUID();
await r.createImportRun({ id: importRunId, sourceAlbumId, trigger: "line" });
await r.recordPhotoAsset({ id: crypto.randomUUID(), sourceAlbumId,
  applePhotoId: "ignored", contentHash: "same-hash", r2Key: null,
  markerKind: "none", position: 1, isMarker: false, importRunId });
expect((await r.findAssetByApplePhotoId(sourceAlbumId, "ignored"))?.r2Key).toBeNull();
expect(await r.findAssetByContentHash("same-hash")).toBeNull();
await r.setAssetR2Key(sourceAlbumId, "ignored", "assets/same-hash.jpg");
expect((await r.findAssetByContentHash("same-hash"))?.r2Key).toBe("assets/same-hash.jpg");
```

Also insert a legacy row with SQL omitting `marker_kind`, once with `is_marker=1` and once with `0`, then expect `product_start` and `none` on reads. A mixed hash lookup containing both null and non-null keys must return the stored object row.

- [ ] Run `npx vitest run test/db/import-repository.test.ts`; confirm nullable-key/classification behavior fails before implementation.
- [ ] Rebuild only the existing photo table, preserving IDs and constraints:

```sql
CREATE TABLE photo_assets_next (
  id TEXT PRIMARY KEY,
  source_album_id TEXT NOT NULL,
  apple_photo_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  r2_key TEXT,
  position INTEGER NOT NULL,
  is_marker INTEGER NOT NULL DEFAULT 0,
  marker_kind TEXT CHECK (marker_kind IN ('product_start', 'ignore_start', 'none')),
  import_run_id TEXT NOT NULL REFERENCES import_runs(id),
  created_at TEXT NOT NULL,
  UNIQUE (source_album_id, apple_photo_id)
);
INSERT INTO photo_assets_next
  (id, source_album_id, apple_photo_id, content_hash, r2_key, position,
   is_marker, marker_kind, import_run_id, created_at)
SELECT id, source_album_id, apple_photo_id, content_hash, r2_key, position,
  is_marker, CASE WHEN is_marker = 1 THEN 'product_start' ELSE 'none' END,
  import_run_id, created_at
FROM photo_assets;
DROP TABLE photo_assets;
ALTER TABLE photo_assets_next RENAME TO photo_assets;
CREATE INDEX idx_photo_assets_content_hash ON photo_assets(content_hash);
CREATE INDEX idx_photo_assets_album_position ON photo_assets(source_album_id, position);
```

Nullable `marker_kind` permits the old worker's inserts during the migration/deploy gap. On read, use `marker_kind ?? (is_marker ? "product_start" : "none")`. On new writes, always persist explicit classification and derive `is_marker` from `markerKind === "product_start"`.

- [ ] Update the Zod row schema and bindings; restrict hash reuse with `WHERE content_hash = ? AND r2_key IS NOT NULL`. Implement promotion with an `UPDATE photo_assets SET r2_key = ? WHERE source_album_id = ? AND apple_photo_id = ?`, leaving classification/hash intact. Require exactly one changed row and throw if the cached photo is absent.
- [ ] Run repository tests and type checking. Resolve fixture/type callers without adding placeholder keys to skipped assets. Commit `feat: persist ignored photo metadata without R2 storage`.

## Task 3: Group only product sections

**Files:** Modify `src/import/grouping.ts`, `test/import/grouping.test.ts`, `test/helpers/fixtures.ts`.

**Interfaces:** Add optional `markerKind?: MarkerKind` and nullable `r2Key` to `GroupingPhoto`. Existing callers without classification use `isMarker ? "product_start" : "none"`. `GroupingResult` additionally exposes `ignoredPhotos: GroupingPhoto[]`, including ignore markers; `groups` and `orphanPhotos` remain unchanged in meaning.

- [ ] Add a grouping test with a local input helper:

```ts
const p = (id: string, position: number, markerKind: MarkerKind): GroupingPhoto => ({
  applePhotoId: id, position, markerKind,
  isMarker: markerKind === "product_start", r2Key: null,
});
const input = [p("m1", 1, "product_start"), p("p1", 2, "none"),
  p("ignore", 3, "ignore_start"), p("extra", 4, "none"),
  p("m2", 5, "product_start"), p("p2", 6, "none")];
const result = groupByMarkers(input);
expect(result.groups.map(g => g.photos.map(p => p.applePhotoId))).toEqual([["m1", "p1"], ["m2", "p2"]]);
expect(result.ignoredPhotos.map(p => p.applePhotoId)).toEqual(["ignore", "extra"]);
expect(result.orphanPhotos).toEqual([]);
expect(await computeGroupHash("album", result.groups[0]!.photos))
  .toBe(await computeGroupHash("album", input.slice(0, 2)));
```

Add an ignore-first/repeated-ignore test with shuffled input and no product markers: `groups=[]`, `orphanPhotos=[]`, all input IDs in `ignoredPhotos` in position order. Add product-immediately-ignore: retain `[product marker]` as an empty product group. Retain existing legacy hash/order assertions.

- [ ] Run `npx vitest run test/import/grouping.test.ts` to see the new assertions fail.
- [ ] Replace the first-marker slicing algorithm with one ordered scan. Keep `currentMarkerPhotoId`, `currentPhotos`, and `ignoring`. Flush a group only when a product marker is active. On `product_start`, flush and begin `[photo]`, setting `ignoring=false`. On `ignore_start`, flush and clear the active product, setting `ignoring=true`, and add the marker to `ignoredPhotos`. Ordinary photos route to the active group, ignored list, or orphan list. Flush an active group at the end. `computeGroupHash` remains unchanged.
```ts
const groups: GroupedProduct[] = [], orphanPhotos: GroupingPhoto[] = [], ignoredPhotos: GroupingPhoto[] = [];
let currentMarkerPhotoId: string | null = null;
let currentPhotos: GroupingPhoto[] = [];
let ignoring = false;
const flush = () => {
  if (currentMarkerPhotoId !== null) groups.push({ ordinal: groups.length, markerPhotoId: currentMarkerPhotoId, photos: currentPhotos });
  currentMarkerPhotoId = null;
  currentPhotos = [];
};
for (const photo of [...photos].sort((a, b) => a.position - b.position)) {
  const kind = photo.markerKind ?? (photo.isMarker ? "product_start" : "none");
  if (kind === "product_start") {
    flush(); ignoring = false; currentMarkerPhotoId = photo.applePhotoId; currentPhotos = [photo];
  } else if (kind === "ignore_start") {
    flush(); ignoring = true; ignoredPhotos.push(photo);
  } else if (ignoring) ignoredPhotos.push(photo);
  else if (currentMarkerPhotoId !== null) currentPhotos.push(photo);
  else orphanPhotos.push(photo);
}
flush();
return { groups, orphanPhotos, ignoredPhotos };
```

- [ ] Run grouping tests and commit `feat: skip ignored sections during product grouping`.

## Task 4: Skip R2 storage and reject incomplete groups before allocating IDs

**Files:** Modify `src/import/service.ts`, `test/import/service.test.ts`, `test/import/workflow.test.ts`, and import integration/acceptance fixtures identified by `rg -n 'productGroupOf|groupSizes|attachablePhotos' test`.

**Interfaces consumed:** `MarkerDetector.detect(): Promise<MarkerKind>`, nullable asset rows, repository promotion, and updated grouping result. `DownloadAndGroupOutcome`, workflow operations, and LINE notifications retain their signatures.

- [ ] In the service test file, import `vi` and add this retry/storage scenario using existing `sourcePhoto`/`buildDeps` helpers:

```ts
const ids = ["m1", "p1", "p2", "p3", "p4", "ignore", "extra", "m2", "q1", "q2", "q3", "q4"];
const snapshot = { sourceAlbumId: "album-1", fetchedAt: "2026-10-08T00:00:00Z",
  photos: ids.map((id, index) => sourcePhoto(id, index + 1)) };
const deps = await buildDeps("album-1", snapshot, new Set(["m1", "m2"]));
await deps.repo.createImportRun({ id: "ignore-run", sourceAlbumId: "album-1", trigger: "line" });
deps.marker.detect = async bytes => {
  const label = new TextDecoder().decode(bytes);
  return label === "product-ignore" ? "ignore_start" : label.startsWith("marker-") ? "product_start" : "none";
};
const put = vi.spyOn(deps.assets, "putIfAbsent");
const download = vi.spyOn(deps.imageSource, "download");
const first = await downloadAndGroupSnapshot(deps, "ignore-run");
expect(first.pendingGroups.map(g => g.attachablePhotos.map(p => p.applePhotoId)))
  .toEqual([["p1", "p2", "p3", "p4"], ["q1", "q2", "q3", "q4"]]);
expect((await deps.repo.findAssetByApplePhotoId("album-1", "extra"))?.r2Key).toBeNull();
expect((await deps.repo.findAssetByApplePhotoId("album-1", "ignore"))?.markerKind).toBe("ignore_start");
expect(put).toHaveBeenCalledTimes(10);
put.mockClear(); download.mockClear();
await downloadAndGroupSnapshot(deps, "ignore-run");
expect(put).not.toHaveBeenCalled();
expect(download).not.toHaveBeenCalled();
```

For the cached-photo promotion test, reuse this completed metadata scan, replace `deps.imageSource` with a snapshot `[m1,p1,p2,p3,extra]`, preserving the byte labels; expect `extra` gains a non-null key and is attachable. Repeat in an isolated test with changed `extra` bytes and expect `photo_asset_content_changed`; no wrong original is signed.

- [ ] Add incomplete-group coverage with the existing process dependencies and persisted-group setup in `service.test.ts`: vary `attachablePhotos.length` over 0, 1, 2, 3 and use spies on `sequences.allocateNext` and `airtable.createProduct`. Each attempt rejects with `{ code: "insufficient_product_photos", retryable: false }`; neither spy is called. Run the existing `recordExhaustedGroupFailure` path and assert failed state and `productId: null`. A group with four photos reaches the existing successful creation path.
- [ ] Add workflow coverage using the existing fake operations: first group rejects with `OperationalError("insufficient_product_photos", "A product requires at least four photos", false)`, the neighboring valid group succeeds. Expect one failed group with null product ID and one succeeded product in the summary. Ignored-only download outcome has empty groups and no orphan range; workflow finishes with zero products without failures.
- [ ] Run `npx vitest run test/import/service.test.ts test/import/workflow.test.ts` and confirm new assertions fail before implementation.
- [ ] Refactor only the scanning loop in `downloadAndGroupSnapshot`:

```ts
let ignoring = false;
const groupingPhotos: GroupingPhoto[] = [];
for (const photo of [...eligiblePhotos].sort((a, b) => a.position - b.position)) {
  let asset = await deps.repo.findAssetByApplePhotoId(deps.sourceAlbumId, photo.applePhotoId);
  let bytes: ArrayBuffer | undefined;
  const loadBytes = async () => bytes ??= await (await deps.imageSource.download(photo)).arrayBuffer();
  const markerKind = asset?.markerKind ?? await deps.marker.detect(await loadBytes());
  if (markerKind === "product_start") ignoring = false;
  if (markerKind === "ignore_start") ignoring = true;
  const shouldStore = !ignoring;
  // For new rows, compute content hash even when skipped and record nullable R2 key.
  // For cached rows with null keys, materialize only when shouldStore is true.
  // Cached classification always changes scan mode; never continue before applying it.
  groupingPhotos.push({ applePhotoId: photo.applePhotoId, position: photo.position,
    markerKind, isMarker: markerKind === "product_start", r2Key: asset?.r2Key ?? null });
}
```

Complete the middle block using the existing storage calls: compute hash from downloaded bytes, look up non-null content-hash storage, call `putIfAbsent` only when `shouldStore`, then `recordPhotoAsset` with explicit classification. For cached null-key promotion, require downloaded hash equals cached `contentHash`, obtain/reuse R2 key, call `setAssetR2Key`, and update the local asset key before constructing the grouping photo. New ignored rows use `r2Key=null` without a hash-reuse storage call. Stored cached rows need no download.

- [ ] Remove the run-level `empty_product_group` guard. Persist all product groups, including incomplete groups. Filter attachable photos by effective `markerKind === "none"`; throw `OperationalError("invalid_asset_key", "Product photo has no stored original", false)` if a product photo has a null key before attachment construction.
- [ ] Inside `processProductGroupAttempt`'s existing `try`, before allocation, add:

```ts
if (group.attachablePhotos.length < 4) {
  throw new OperationalError("insufficient_product_photos", "A product requires at least four photos", false);
}
```

Keep the existing succeeded-group early return. Let current workflow failure recording mark the incomplete group failed. Update successful test fixtures previously using fewer than four photos; rewrite the adjacent-marker assertion to expect a persisted incomplete group, not a run-level failure.
- [ ] Run the focused import/repository tests and type checking. Commit `feat: exclude ignored photos from storage and validate import groups`.

## Task 5: Generate marker card and document deployment

**Files:** Modify `scripts/generate-marker.ts`, `test/scripts/generate-marker.test.ts`; create `docs/runbooks/ignore-marker-card.svg`, `docs/runbooks/ignore-marker.md`.

**Interfaces:** `GenerateMarkerOptions` adds optional `kind: "product_start" | "ignore_start"`, defaulting to `product_start`. CLI adds `--kind product|ignore`, retaining `--out`.

- [ ] Extend the existing generator test with a temporary ignore SVG:

```ts
await generateMarkerSvg({ outPath, kind: "ignore_start" });
const svg = readFileSync(outPath, "utf-8");
expect(svg).toContain("SNAZZY_IGNORE_START_V1");
expect(svg).not.toContain("SNAZZY_PRODUCT_START_V1");
```

Keep the existing no-kind test to pin product default. Invalid CLI `--kind` values must exit nonzero rather than silently produce the product marker.
- [ ] Run `npx vitest run test/scripts/generate-marker.test.ts` before implementation.
- [ ] Select the payload from kind using constants imported from `src/import/marker.ts`. Use the existing SVG layout and payload label. Validate CLI input, map `product`/`ignore` to the typed kind, and default the ignore output to `docs/runbooks/ignore-marker-card.svg` when no `--out` is supplied.
Use these selections inside the existing generator and CLI (with exported payload constants imported):

```ts
const payload = kind === "ignore_start" ? IGNORE_MARKER_PAYLOAD : MARKER_PAYLOAD;
const kindIndex = args.indexOf("--kind");
const selected = kindIndex < 0 ? "product" : args[kindIndex + 1];
if (selected !== "product" && selected !== "ignore") throw new Error("Use --kind product or --kind ignore");
const kind = selected === "ignore" ? "ignore_start" : "product_start";
const defaultOut = selected === "ignore" ? "docs/runbooks/ignore-marker-card.svg" : "docs/runbooks/marker-card.svg";
```

- [ ] Run generator tests, then generate the committed card:

```sh
npm run generate-marker -- --kind ignore --out docs/runbooks/ignore-marker-card.svg
```

- [ ] Write the runbook with the exact payloads, four-photo requirement, resume marker, client photo-order example, ignored-only zero-import summary, download-versus-storage distinction, and no retroactive cleanup. Include this staging rollout sequence:

```text
1. Ensure no import workflow is currently running; do not overlap old/new workers on null-key rows.
2. Inspect staged migration and current photo_assets row count; preserve a D1 export.
3. Apply migration with: npm run db:migrate:staging
4. Deploy with: npm run deploy:staging
5. Exercise one valid product, ignored extra views, then another valid product in a new album section.
6. Confirm two products, four attachments each, no ID for ignored section, no R2 objects for skipped bytes.
7. Repeat upload; confirm no duplicate products or newly stored ignored objects.
```

After new null-key rows exist, rolling back only the worker code is incompatible. Restore the matched database backup only if losing later writes is explicitly acceptable; otherwise fix forward. Production deployment remains a separate user request.

- [ ] Run `npm run typecheck`, `git diff --check`, and `npx vitest run test/import test/db/import-repository.test.ts test/scripts/generate-marker.test.ts`. Run targeted acceptance tests identified during Task 4 rather than unrelated LINE suites. Disclose pre-existing failures separately.
- [ ] Commit the generator, marker card, runbook, and focused fixture updates with `feat: generate and document ignore marker cards`.

## Completion and handoff

- [ ] Self-review nullable keys, exact payloads, retry mode, hash compatibility, minimum validation placement, and prohibited side effects against the approved spec.
- [ ] Obtain the review required by the selected execution method, fix actionable findings, and rerun affected focused checks.
- [ ] Report changed files, validation evidence, and remaining album-order/QR-readability limits. Do not deploy or merge until requested.
