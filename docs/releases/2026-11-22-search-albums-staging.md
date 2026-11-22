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
