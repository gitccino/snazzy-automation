# Search iCloud Albums Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task.

**Goal:** Resolve and display album names and links in `/search` safely.
**Architecture:** Validated registry in existing settings; target-scoped D1 provenance read; pure resolver; optional command enrichment and Flex rendering.
**Tech Stack:** TypeScript, Zod, D1, Vitest, existing LINE Flex builders.
**Spec:** `docs/superpowers/specs/2026-11-22-search-albums-design.md`

## Global Constraints
Inclusive Gregorian Bangkok dates. Maximum two date matches. No invented registry data. Keep product replies on enrichment failure. `/search` only. No remote writes.

## Review Focus
- Invalid calendar dates must not normalize into another day.
- Source identity must override overlapping dates and remain scoped to Airtable target.
- Failed enrichment must not suppress product details or expose provider errors.
- Existing settings and stored contexts must load without registry data.
- Two names with missing links must still render useful and valid Flex content.

### Task 1: Registry and resolution
Files: `src/line/album-lookup.ts`, `src/settings/schema.ts`, `src/settings/runtime.ts`, `test/line/album-lookup.test.ts`.
Interfaces: `albumRegistrySchema`; `resolveAlbum(registry, sourceAlbumIds, uploadDate): AlbumLookup`; registry runtime field `icloudAlbums`.
- [x] Write failing schema/resolution tests for Review Focus dates, overlaps, unsafe URLs, exact/unknown source and missing dates.
- [x] Run `npx vitest run test/line/album-lookup.test.ts`, observe failure.
- [x] Implement validation and pure resolution; add default-empty stored setting and connections update field, runtime projection.
- [x] Rerun focused tests and typecheck.

### Task 2: Provenance and command rendering
Files: `src/db/album-lookup.ts`, `src/routes/line.ts`, `src/line/search.ts`, `src/line/search-card.ts`, `test/db/album-lookup.test.ts`, `test/line/search.test.ts`.
Interfaces: `lookupProductAlbum(db, target, product, registry): Promise<AlbumLookup>`; optional `ReadOnlyDeps.lookupAlbum(product)`.
- [x] Add failing real-D1 tests for exact product/record/target identity, foreign targets, unknown source and query failure; command tests for names/buttons, missing links, two matches and sanitized failure.
- [x] Observe failures, implement scoped lookup and real dependency wiring, add Flex fields and alt text.
- [x] Run focused DB/search/settings tests and typecheck.

### Task 3: Review and evidence
Files: plan and `docs/runbooks/search-albums.md`.
- [x] Document registry update via existing settings API and verified data prerequisites.
- [x] Self-review all changes; test command wiring and settings compatibility.
- [x] Run root tests, disclose baseline failures and runtime warnings. Record results here, commit local feature only.

## Execution evidence

Implemented on `feature/search-icloud-albums` without deployment, remote writes or album changes.

- Red/green: missing resolver/repository, missing enrichment and thrown dependency regressions observed failing; then passed. URL length and raw-whitespace validation regressions also observed failing, then passed.
- Focused validation: 80 tests across 12 suites passed before the final raw-whitespace and settings-persistence tests; final affected resolver/repository/command run passed 49 tests. Both final additions pass in the completed full run.
- Root `npm test` ran the seeded Node owner CLI successfully and completed Vitest with nine known failures; it caught the new context compatibility defect, which was fixed and rerun. Final all-file Vitest run after the final input hardening and persistence test: **1,391 passed, 9 failed**, 125 files completed. Same nine baseline failure names: LINE acceptance `/search A1234` and `/soldout A1234 ราคา 1290`; inventory `reads every daily-sales page with Bangkok boundaries and requested fields`; six soldout `does not persist or mutate for invalid sold price %p` cases (0, -1, 1.5, NaN, Infinity, above MAX_SAFE_INTEGER). These remain unresolved outside this feature.
- Typecheck and diff check passed. Settings-site tests: 19/19 passed; production build passed.
- Runtime emitted the existing Miniflare Workflow engine/instance warnings and the existing standardwebhooks missing source-map warning. No live LINE/iCloud provider checks performed.
- Self-review and independent read-only review completed. Review identified an unbounded URI input; fixed with a 1,000-character application cap. Current LINE URI limit is higher, so this is intentionally a stricter application limit, not a claim about the current provider maximum. Raw whitespace silently discarded by URL parsing is also rejected.

Ruling: extend `src/db/execution-context-repository.ts`'s strict context schema with optional `icloudAlbums`; otherwise new D1 settings snapshots break accepted Workflow context persistence. Preserve old contexts without inventing the field. New regression covers both formats.

Ruling: retain default-empty registry, API-only configuration, and no guessed real album IDs/dates/URLs. See `docs/runbooks/search-albums.md` for data prerequisites, exact PATCH endpoint, revision semantics, compatibility and rollback. The twenty requested albums still require date-added verification and configured mappings before this can identify them in use. LINE configuration commands and a registry settings form remain outside scope.

## Follow-up: real Photos link inspection

Photos exposed existing website URLs for 11 of the 20 albums. Nine albums exposed no URL in this account's participant settings; no sharing options were changed. Actual links are saved privately outside Git in `/Users/gitccino/.t3/userdata/album-inspection/2026-11-22-icloud-album-links.json`; do not publish them as repository fixtures. Date-added evidence is recorded separately in `docs/research/2026-11-22-icloud-album-date-ranges.json`.

The actual tokens use URL-safe `_` and `-`, which the original alphanumeric-only fragment validator rejected. A synthetic regression failed first, then passed after allowing these two characters within the same strict origin/path/canonical URL and length guards. All 11 retrieved links were checked locally against the corrected schema without contacting their websites. Focused tests: 57/57; typecheck and diff check passed. Root `npm test`: Node owner CLI passed; Vitest completed 1,392 passed and the same nine baseline failures listed above. Existing Miniflare Workflow errors and missing-source-map warnings remain. No mobile opening, deployment or live registry configuration was performed.

LINE's documented URI action opens its in-app browser and supports http/https/line/tel; no supported Photos-specific URI action is configured. Native handoff to a specific shared album is not promised. See https://developers.line.biz/en/reference/messaging-api/#uri-action and Apple's shared album documentation https://support.apple.com/en-us/108314.

## Approved website-only behavior

The user tested the actual iCloud URL button in the staging LINE group on iPhone and observed browser opening. The agreed behavior is album name plus website button, with name-only fallback when no URL exists. Updated labels to `เปิดบน iCloud.com`, or numbered variants for two candidates; no Photos-app redirect is promised. Updated the existing second-candidate regression first (observed failing), then changed the label. All 50 tests across search, resolver and D1 lookup suites passed; typecheck and diff check passed. This copy-only follow-up did not rerun the full suite; the previous completed run retains nine baseline failures. No deployment or live registry changes were performed.
