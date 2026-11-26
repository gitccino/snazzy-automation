# iCloud Album Switching Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans, or superpowers:subagent-driven-development if delegation is authorized. Complete and verify each task in order.

**Goal** — Let clients review, edit, and switch iCloud album mappings from Settings, and prepare the separate Shared Album 57 cutover.

**Architecture** — Keep the active source, album mappings, and per-album cutoffs in the existing revisioned D1 settings record. Pin the source and cutoff in the import's saved context, and expose album operations through the existing private Settings service.

**Stack** — Cloudflare Workers, D1, TypeScript, Zod, React, shadcn/ui Base UI, and Vitest.

**Spec** — [iCloud album switching design](../specs/2026-11-26-icloud-album-switching-design.md).

## Global constraints

- Start from `main` at or after `330515a`. The deployed Automation baseline and Base UI Settings redesign are in `main` through PRs #40 and #41. Keep unrelated local edits out of the implementation branch.
- Reuse the current Settings Access policy, service binding, and revision check. Keep the first release's manual pause and drain. Staff pause commands, wait for queued and active uploads, and resume after verification. Keep system-enforced coordination out of this release.
- Album names and photo-added ranges are entered manually. Verify link accessibility through the existing Apple client. A readable empty album is valid. Keep supported URL formats and the current registry range validation.
- Keep saved mapping dates as Bangkok calendar dates and capture cutoffs as UTC instants. Keep share links and credentials out of logs, validation errors, and unrestricted responses. Never return the raw Worker secret through Settings.
- Rehearse in the owner's Cloudflare account `supitchaklanpradit@outlook.com`. The client production account is `snazzybrandnamedev@gmail.com`. Confirm the account, Worker, and database before remote commands. Implementing this plan does not authorize the live cutover.

## Review focus

| Case | Expected outcome |
|---|---|
| A queued upload or retry runs after a switch | It uses the recorded source and cutoff or stops with a specific error. |
| A prior album is reactivated | Its own cutoff, checkpoint, and deduplication state still apply. |
| A direct Settings request tries to change the active link or cutoff | It must use the corresponding validated action. |
| A timestamp has different precision but represents the exact cutover instant | Import and verification both exclude it for Album 57. |
| Album 57's existing mapping ID differs from the share link's ID | Existing references still resolve and date lookup lists the album once. |

## Task 1 — Resolve the active album and pin the import source

**Files** — `src/settings/schema.ts`, `src/settings/runtime.ts`, `src/db/execution-context-repository.ts`, `src/routes/upload.ts`, `src/import/workflow.ts`, `src/routes/setup.ts`, and `src/icloud/client.ts`. Add `src/settings/icloud-source.ts`.

**Contracts** — Add optional `ICLOUD_ACTIVE_SOURCE_ID` and `ICLOUD_IMPORT_CUTOFFS` settings. The cutoff map is keyed by source ID and stores `CaptureCutoff = { instant: string; mode: "legacy-inclusive" | "exclusive" } | null`. A present null entry means the source has no cutoff. Add `resolveICloudSource(env, config)` returning `{ sourceAlbumId, input, cutoff }` for internal use. The import-only saved context records `{ sourceAlbumId, cutoff, link? }`. Include the link only for a Settings-managed source. For a legacy source, read the secret at execution and verify it still derives the recorded ID.

- [ ] Add tests to `test/routes/upload.test.ts`, `test/import/verification-entry.test.ts`, and `test/routes/setup.test.ts`. Assert legacy settings and contexts still load. Assert a managed run uses its saved link after a switch. Assert a retry with a changed legacy secret stops before scanning. Assert a readable empty active album passes setup.
- [ ] Run `npx vitest run test/routes/upload.test.ts test/import/verification-entry.test.ts test/routes/setup.test.ts` and confirm the new cases fail for the expected reason.
- [ ] Use the resolver for new uploads and setup. Retain the captured source and cutoff through LINE handoff, durable run storage, workflow dispatch, and retries. Resolve a legacy queued context using its recorded source ID when one exists. Stop before scanning when the resolved snapshot ID differs from the recorded ID. An incomplete managed configuration fails closed. Treat a successful zero-photo response as readable and skip the legacy asset URL request when there are no photos.
- [ ] Rerun the tests and `npm run typecheck`. Commit this slice separately.

## Task 2 — Match capture cutoffs in import and verification

**Files** — Add `src/import/capture-cutoff.ts`. Update `src/import/service.ts`, `src/import/workflow.ts`, and `src/db/import-repository.ts`.

**Contract** — `isCaptureEligible(captureAt: string | null, cutoff: CaptureCutoff): boolean`. Use it in both import scanning and independent verification. Save the comparison mode with the run's grouping evidence. Missing mode in existing evidence means the existing inclusive behavior.

- [ ] Add cases to `test/import/service.test.ts` and `test/db/import-verification-evidence.test.ts`. For an exclusive cutoff at `2026-11-26T07:00:00.000Z`, reject an earlier capture, both spellings of the same instant (`07:00:00Z` and `14:00:00+07:00` on that date), missing timestamps, and invalid timestamps. Accept a capture 1 ms later. Also replay original inclusive evidence.
- [ ] Run `npx vitest run test/import/service.test.ts test/db/import-verification-evidence.test.ts` and confirm the new exclusive cases fail.
- [ ] Implement strict comparison of parsed instants for exclusive mode. Preserve the existing comparison exactly for legacy evidence. Add the saved cutoff mode to both evidence writing and decoding. Verify the verifier reads the mode from saved evidence instead of live Settings.
- [ ] Rerun the tests and typecheck. Commit this slice separately.

## Task 3 — Add validated Settings operations

**Files** — Add `src/settings/icloud-albums.ts` and `test/settings/icloud-albums.test.ts`. Update `src/settings/schema.ts`, `src/settings/service.ts`, `src/settings/entrypoint.ts`, `apps/settings/worker/api.ts`, and `apps/settings/test/api.test.ts`.

**Contracts** — Extend `SettingsView` with `activeICloudSourceId: string | null`. Expose four JSON POST actions under `/api/settings/icloud-albums/` through `SettingsService`. Use the existing Settings result envelope.

| Action | Request fields | Result on success |
|---|---|---|
| `inspect` | `shareUrl` | Server-derived `sourceAlbumId`, `isEmpty`, optional existing mapping, and saved import state if previously used |
| `edit` | `expectedRevision`, `sourceAlbumId`, `name`, `startDate`, `endDate` | Updated Settings view |
| `switch` | `expectedRevision`, outgoing `{ name, startDate, endDate }`, incoming `{ name, shareUrl, startDate, endDate }`, `captureAfterUtc` or null | Updated Settings view |
| `cutoff` | `expectedRevision`, `sourceAlbumId`, `captureAfterUtc` or null | Updated Settings view |

- [ ] Add tests for a legacy source with no mapping, empty and populated destinations, returning to an old album, and selecting the current source. Assert an already-active selection only edits metadata. Assert stale revision, invalid range, failed link verification, or a missing cutoff for a new populated source leaves D1 unchanged. Check same-origin enforcement and the existing generic save routes.
- [ ] Run `npx vitest run test/settings/icloud-albums.test.ts test/settings/service.test.ts` and `npm --prefix apps/settings test -- test/api.test.ts`. Confirm the new cases fail.
- [ ] Implement using `readSettings` and `compareAndSetSettings`. Validate the URL and derive its ID on the server. Recheck the destination on switch save. Confirm blank outgoing dates only for a readable empty album. Update both mappings and the active reference in one save. Preserve the outgoing legacy cutoff under its source ID, and on reactivation keep the destination's saved cutoff and checkpoint. A previously imported source without recoverable cutoff data requires operator review before reactivation. Use the exclusive mode for newly confirmed cutoffs. Keep known share-link changes that would change an imported album's ID on an explicit operator path.
- [ ] Route managed cutoff writes through the dedicated action. Reject generic writes that remove the active mapping, change its link, or alter its effective cutoff outside the validated flow. Keep ordinary name and range edits. If the installation still uses the Worker secret, keep the existing import cutoff save semantics.
- [ ] Rerun both suites and typecheck. Commit this slice separately.

## Task 4 — Build the iCloud Albums page and date controls

**Files** — Add `apps/settings/src/components/icloud-albums.tsx`, `apps/settings/src/components/date-time-picker.tsx`, and `apps/settings/test/icloud-albums.test.tsx`. Update `apps/settings/src/app.tsx`, `apps/settings/vite.config.ts`, and the Settings package and lockfile.

**Contracts** — `ICloudAlbums({ view, onSaved })` uses Task 3's actions and returns updated Settings through `onSaved`. `AlbumDateRangePicker` uses `{ startDate, endDate }` as date-only strings or nulls. `BangkokCutoffPicker` receives and returns an ISO UTC instant or null. Use the same cutoff picker in the album form and the existing Import section.

- [ ] Add tests for the active badge, absent links, empty date ranges, manual outgoing range edits, populated album cutoff confirmation, and errors that preserve the form. Test a browser in another time zone selecting Bangkok `2026-11-26 14:00` and saving `2026-11-26T07:00:00.000Z`. Confirm an unchanged cutoff retains its seconds and milliseconds.
- [ ] Run `npm --prefix apps/settings test -- test/icloud-albums.test.tsx` and confirm the new cases fail.
- [ ] Build the album list and switch form using the agreed flow. Use the shadcn/ui Base UI calendar range picker and date picker with a labeled time input. Review the paused-commands instruction, outgoing range, new source, and applicable cutoff on the confirmation screen. Use the existing theme, labels, and save/error patterns. Add disposable local sample responses in Vite for the album actions.
- [ ] Run `npm --prefix apps/settings test`, `npm --prefix apps/settings run typecheck`, and `npm --prefix apps/settings run build`. Check keyboard entry and selection, clearing an optional range, focus on errors, and layout at 390 px. Commit this slice separately.

## Task 5 — Rehearse and prepare the separate Album 57 cutover

**Files** — Update `src/line/album-lookup.ts`, `docs/runbooks/album-rotation.md`, and `docs/runbooks/settings-console.md`. Use the existing test fixtures and the cutover controls from Tasks 1–3.

- [ ] Add a staging fixture where a historical mapping uses a placeholder ID and the verified link derives a different ID. Confirm an unreferenced key can be replaced in place. If referenced, preserve direct lookup through an alias to the same canonical entry and confirm date lookup returns that entry once. Test in `test/db/album-lookup.test.ts` and `test/line/album-lookup.test.ts`.
- [ ] Run `npx vitest run test/db/album-lookup.test.ts test/line/album-lookup.test.ts` and confirm the alias case fails. Add optional `sourceAliases: string[]` to the existing album schema. Require uniqueness across aliases and canonical IDs. Resolve recorded aliases to their canonical entry and match date ranges only against canonical entries.
- [ ] Document the operator sequence and rehearse with fixtures or an authorized staging album. Specify an authenticated operator save using the same registry validation and `compareAndSetSettings`, since the client switch action keeps the outgoing mapping. Run both lookup suites and `npm run check`. Reproduce and report any baseline failures separately. Verify a signed-out request cannot reach the new Settings actions.
- [ ] Once the client provides Album 57's link, verify production can read its full snapshot and obtain the photo-added range from Apple Photos. Check the current mapping IDs, history references, production health, and revision. The live cutover needs the deployed backend from Tasks 1–3 and the alias support if historical references require it. It can proceed while the album-management frontend is still being built.
- [ ] For the separately authorized live cutover, pause and drain uploads, record one UTC instant, and save the replacement album mapping, strictly-after cutoff, and active source with the mock mapping removed. Validate the final registry and use the recorded revision for the write. If interrupted, resume with the same recorded instant. Verify production readback before resuming commands.
- [ ] With approval for a real import, photograph a fresh product marker and then its photos after the cutoff. Confirm only the expected group imports. If cutover validation fails, keep uploads paused, restore the prior source and mapping from the pre-switch backup, and keep inventory and import history intact. Restoring settings cannot reverse an import that already wrote records.
