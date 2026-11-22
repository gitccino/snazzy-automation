# Configure `/search` iCloud albums

The registry starts empty. Deployment alone does not identify the twenty historical albums. Verify their **date added** ranges against historical Airtable `Upload Date` semantics first. Photo capture dates are insufficient. A link is optional; names alone work. The button says `เปิดบน iCloud.com` and opens the website. The legacy-link staging test opened the browser; the newer mock-album link opened Photos on the user’s iPhone. A native handoff is not guaranteed across links and devices. Album names appear in black, right-aligned beneath the upload date, without a separate album heading.

## Registry

`ICLOUD_ALBUMS` is an array in the existing non-secret D1 settings document. Each entry has:

- `sourceAlbumId`: stable unique key. For imported albums, copy the exact saved `import_runs.source_album_id`; it is derived from the shared token and is **not** the display number such as 32. Inspect with authenticated D1 access, e.g. `SELECT DISTINCT source_album_id FROM import_runs`. Do not put credentials here. For historical albums with no import history, choose a stable unique key such as `legacy-shared-album-32`.
- `name`: displayed album name, maximum 100 characters.
- `url`: verified `https://www.icloud.com/sharedalbum/#<token>` or `https://photos.icloud.com/shared/album/<token>` public sharing URL (maximum 1,000 characters), or `null`. Never enable public sharing automatically. Confirm the link opens the intended album before saving.
- `startDate`, `endDate`: inclusive Gregorian `YYYY-MM-DD` dates, or both `null` when unverified. Use Bangkok dates. At most two albums may match a day; a shared boundary day intentionally returns both.

## Save through the existing authenticated settings API

Export the current saved settings first. In the Access-authenticated settings site's browser console, fetch `/api/settings` and use the returned `record.revision`. Then PATCH `/api/settings/sections/connections` from the **same origin**, with JSON:

```json
{
  "expectedRevision": 123,
  "section": "connections",
  "changes": {
    "ICLOUD_ALBUMS": [
      {
        "sourceAlbumId": "legacy-shared-album-32",
        "name": "Shared album 32",
        "url": null,
        "startDate": null,
        "endDate": null
      }
    ]
  }
}
```

The revision above is illustrative. Replace it with the live revision and supply the **complete intended registry**, including existing entries. Use `Content-Type: application/json`. The existing settings API applies Access, origin and revision checks. On a revision conflict, reload and reconcile before retrying. This version exposes the registry through the API/export, not a new settings form or LINE command. Registry edits do not change the active `/upload` album.

Verify `/search` with a directly imported item, a historical date match, a shared boundary date, and a missing date. A known imported album with no matching registry key stays unknown. Failed optional D1 lookup shows a retry message while retaining product details and the Airtable button. Existing accepted LINE commands retain their captured settings; use a fresh message after changing the registry.

## Release and rollback

No schema migration is required. Deploy the automation Worker and compatible settings site together; older settings schemas reject the new key. Before reverting to older code, export settings privately, quiesce accepted work as required by the existing workflow runbook, and restore a settings document without `ICLOUD_ALBUMS` through compatible tooling. Do not erase import provenance. Initial implementation was local. Staging deployment and its verified limits are recorded in `docs/releases/2026-11-22-search-albums-staging.md`.

Pending data verification: Shared album 32, 33, 34, 35, 36, 39, 40, 42, 43, 44, 45, 49, 50, 51, 52, 53, 54, 55, 56 and 57. The 20 date-added ranges were inspected in Photos Activity on 2026-11-22 and saved in `docs/research/2026-11-22-icloud-album-date-ranges.json`. Eleven existing public links were read from Photos sharing details and saved privately outside the repository at `/Users/gitccino/.t3/userdata/album-inspection/2026-11-22-icloud-album-links.json`. The remaining nine exposed no URL in this Mac account. These metadata inspections have not populated live registry settings.

Mock albums can be registered by exact source ID with both dates null. This prevents synthetic test albums from contaminating historical date fallback when their observed sharing dates overlap real albums. Save the observed dates separately as evidence. Changing or removing a registry entry uses the same revision-checked connections API above; it does not change the active import album secret or import history.

## Default external browser behavior

Following the successful `/search` trial, all newly generated cards add LINE’s `openExternalBrowser=1` option to Airtable, Google Docs and iCloud button URLs, preserving existing query parameters and album fragments. The registry retains the original canonical URL; do not add the option to saved album links. Postback and confirmation actions remain unchanged. Older already-sent cards retain their original URLs; the deployment does not rewrite queued results or delivery evidence. iOS may still hand supported album links to Photos; the option requests leaving LINE’s in-app browser.
