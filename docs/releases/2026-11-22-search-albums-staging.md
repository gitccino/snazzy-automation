# Search albums staging deployment — 2026-11-22

Source: `feature/search-icloud-albums`, code commit `b5e7626`.

- Automation Worker: `snazzy-automation-staging`, version `5067a6c7-1c7a-4fc5-9067-50b14a839526`, tag `b5e7626`, 100% traffic.
- Settings Worker: `snazzy-settings-staging`, version `937f86e3-83e1-4cd1-be8e-c50c6d9fa379`, tag `b5e7626`.
- Previous automation version: `68459d6d-7393-40b8-9052-4d634563f41a` (`43ffffc`).
- Staging D1 settings advanced atomically from revision 13 to 14. Only `ICLOUD_ALBUMS` changed. Saved 20 verified date-added ranges, with 11 existing website links. User authorized assuming Airtable Upload Date means album-added date. Public sharing settings were not changed.
- Public-link entries use the app's deterministic source-ID derivation for that exact URL; entries without a link use documented legacy aliases. **None of the existing staging import source IDs matched these derived IDs.** Such imported products remain unknown until exact source mappings can be established. Date mapping is available for products without matching import provenance. Do not alias existing imported sources to an album by guesswork.

## Checks

- Preflight: zero running imports, active publication rows, unresolved queue entries and unmaterialized notices. No running or queued Workflow instances across import/publication/LINE/follow-up bindings.
- No pending D1 migrations; no migration required by this feature. Fresh private D1 export retained outside Git under `.t3/userdata/album-inspection/snazzy-albums-staging-*/private/staging-before.sql`.
- Typecheck passed. Search/resolver/repository/settings acceptance: 53/53. Settings-site tests: 19/19. Settings production build and automation dry run passed.
- Post-deploy automation `/health`: HTTP 200, `ok: true`, `importRunning: false`.
- Settings API without authentication: HTTP 302 to `yoppa.cloudflareaccess.com`; Access protection retained.
- Post-deploy D1 readback: revision 14, 20 albums, 11 website links, zero unresolved queue results and zero running imports.
- Prior completed full suite: 1,392 passing and the nine recorded baseline failures (two LINE parser, one inventory daily-sales fields and six sold-price assertions). No new full run was needed for deployment of unchanged code. Existing source-map and Miniflare warnings remain recorded in the implementation ledger.
- No unsolicited LINE message was sent. The earlier one-off reply-button test confirmed iPhone browser opening. Fresh `/search` through LINE after deployment remains a manual staging check.

## Rollback

Before restoring older code, quiesce admissions and inspect/drain accepted Workflows; new captured contexts include the registry field. Retain D1 and dispatch evidence. Older strict settings schemas reject `ICLOUD_ALBUMS`, so restore the previous non-secret settings document using a revision-guarded update before running incompatible code. Do not erase provenance or queue rows. The private backup retains the pre-deployment settings and data; avoid wholesale restore over newer business writes. Revert the compatible settings Worker as needed only after considering its service binding and schema compatibility.

Production was not changed. No source push, PR or merge was performed.

## Staging mock album addition

The user explicitly approved adding `Snazzy mock album II` to staging. Photos Activity showed sharing dates 2026-09-30 through 2026-11-22, and the owner sharing sheet supplied an existing `photos.icloud.com/shared/album/…` URL. No album sharing option was changed. The link and observed timestamps are retained privately outside Git in `.t3/userdata/album-inspection/mock-album-inspection.json`.

The copied current-generation Apple URL was rejected by the original legacy-only validator. A regression failed first, then passed after supporting the exact `https://photos.icloud.com/shared/album/<URL-safe-token>` form, with the existing canonical URL, no credentials/port/query, length, and host/path guards retained. Lookalike hosts, extra path components, queries and fragments are rejected. Code commit: `271db43`.

The deterministic source ID from that existing URL matches a saved staging import source. Its full observed date range overlaps real albums 55 and 56, so enabling it for historical date fallback would violate the maximum-two rule. Registered the mock album **by exact source ID only**, with both registry dates null; observed date evidence is kept separately. All original 20 registry entries and unrelated settings remain unchanged. Staging settings advanced atomically from revision 14 to 15: 21 entries and 12 links. Target-scoped saved product evidence includes `A-12686`, `A-12685`, and `A-12677` for this source. A fresh private D1 export was retained before this change.

Latest automation version: `356cae6b-3a56-4135-951e-13b26f1803bd`. Latest compatible settings version: `74490f54-8e7b-44b1-9066-530562c312b6`. Both tagged `271db43`. Post-change health: HTTP 200, `ok: true`, `importRunning: false`. Pre-change active import/publication/queue counts were zero.

Verification: 80 focused tests, 19 settings-site tests, typecheck, build and diff check passed. The root test command's owner CLI check passed; Vitest completed 1,393 passing and the same nine established baseline failures. No LINE search message was sent; user testing through fresh `/search` remains appropriate. Production and the active upload-album secret were not changed. Production has an independent registry and does not inherit this staging entry automatically.

## Approved album-name placement

The user approved the visual refinement: remove the separate album heading and place the album name in black, right-aligned directly below the upload date. Implemented in `0e801a2`; two matching names use the same placement and retain a separate uncertainty note. Unknown and unavailable guidance stays full-width and readable; soldout cards and button actions are unchanged.

Deployed automation version `f6505c18-294b-40bf-a0e6-24662b1f99c4`, tag `0e801a2`. The settings Worker did not require redeployment for this rendering-only change. Private D1 backup was retained before deployment; no settings or schema changes were made. Readback confirms revision 15, 21 albums and zero unresolved queue entries. Health returned HTTP 200 with `ok: true`, `importRunning: false`.

Both new placement regressions failed before the patch and passed afterward. Focused search/resolver/D1 suites passed 53 tests; typecheck, dry run and diff check passed. Root Node owner CLI passed, and Vitest completed with 1,395 passing and the same nine baseline failures documented above. Existing Miniflare and source-map warnings remained. The final live mobile layout requires a fresh `/search`; old LINE cards are immutable. Production was not changed.
