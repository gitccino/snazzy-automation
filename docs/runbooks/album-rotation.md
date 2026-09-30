# iCloud Shared Album Rotation Runbook

## Supported album sources

Keep using the `ICLOUD_SHARED_ALBUM_TOKEN` secret. It now accepts either:

- An existing legacy raw token (unchanged), or its full `https://www.icloud.com/sharedalbum/#...` URL.
- A full iOS 27 `https://photos.icloud.com/shared/album/...` URL. Supply the full URL, not just its sharing key, so the client can select the new protocol.

For iOS 27, enable access for anyone with the link in the album's Sharing Options. Albums requiring Apple login or approval cannot be read by the unattended import. Snazzy resolves fresh temporary credentials on each snapshot, follows pagination, joins asset/master records, and downloads JPEG derivatives rather than HEIC originals.

The new client orders photos by capture time, oldest first, regardless of the Photos display sort. Shoot each marker before its product photos and keep device clocks consistent. Identical capture timestamps or missing photo metadata stop the snapshot before processing rather than inventing a marker order. Import only still photos; unsupported media also stops the snapshot.

Existing legacy album IDs remain unchanged, including when switching from a raw token to its full legacy URL. New-format IDs are namespaced hashes of the sharing key. Upgrading a legacy album or changing its link may create a different source identity; do not assume prior checkpoints or Product deduplication carry over. Finish the prior import and set the first-import cutoff before switching. Use `/setup` and a small marker/product batch to verify the new source before resuming staff uploads.

Apple limits a Shared Album to 5,000 items. Check the active album's item count in Photos and rotate before about 4,500. At 100–500 new photos/day, 5,000 items lasts roughly 10–50 days (a 4,500-item rotation point is about 9–45 days from empty); use the measured count and recent daily additions to schedule the change.

## Production rotation

1. Finish the current import. Check the public Worker health response is HTTP 200 with `"ok": true` and `"importRunning": false`:

   ```bash
   curl --fail-with-body "$WORKER_BASE_URL/health"
   ```

   Pause staff uploads during the switch and schedule it away from the import cron. A failed `/health` also needs investigation before rotation.
2. On the staff device, create and share the new album with the required contributors. Enable Public Website for legacy albums, or access for anyone with the link for iOS 27 albums. Put a marker card before the first intended product and upload at least one photo; `/setup` requires a nonempty album. Record the timestamp immediately before the first photo you intend to import.
3. Save the complete existing `APP_CONFIG_JSON` securely, changing only `FIRST_IMPORT_CUTOFF_DATE` to that timestamp as a full UTC ISO 8601 datetime, for example `2026-09-23T00:00:00.000Z`. The field rejects a date-only value. Photos with missing capture time or earlier capture time are excluded, so check that the first marker is within the cutoff. The new album's source ID already gets its own checkpoint; the cutoff only limits its first eligible photos.
4. Update production secrets, supplying the legacy public album token or full iOS 27 album URL and then the full edited config at the prompts:

   ```bash
   npx wrangler secret put ICLOUD_SHARED_ALBUM_TOKEN --env production
   npx wrangler secret put APP_CONFIG_JSON --env production
   ```

5. Confirm the authenticated `/setup` response has `"ok": true` and its `icloud_phase_zero` check is `"ok": true`:

   ```bash
   curl --fail-with-body -H "Authorization: Bearer $ADMIN_ROUTE_TOKEN" "$WORKER_BASE_URL/setup"
   ```

   This checks album reachability and visible photos. Marker detection was proved by fixture in the [Phase 0 report](../feasibility/icloud-phase-0-report.md); `/setup` does not test live markers.
6. Send `/upload` once in the allowlisted LINE group (or authenticated `POST /upload`), and confirm the expected Product IDs and photo range in LINE and Airtable. Resume staff uploads and scheduled import after success. Keep the old album shared and unchanged as an archive.

For legacy albums, `sourceAlbumId` is SHA-256 of the album token; for iOS 27 it is SHA-256 of `icloud27:` followed by the sharing key. D1 identifies each `photo_assets` row by `(source_album_id, apple_photo_id)`, so Apple photo IDs reused across distinct albums cannot collide. Changing the public link for the *same* album changes that source ID and may import its photos again; verify the link truly points to the new album.

| Date | Old album name | New album name | First import result |
|---|---|---|---|

Record names and outcome only; never record public links or tokens.
