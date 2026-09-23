# iCloud Shared Album Rotation Runbook

Apple limits a Shared Album to 5,000 items. Check the active album's item count in Photos and rotate before about 4,500. At 100–500 new photos/day, 5,000 items lasts roughly 10–50 days (a 4,500-item rotation point is about 9–45 days from empty); use the measured count and recent daily additions to schedule the change.

## Production rotation

1. Finish the current import. Check the public Worker health response is HTTP 200 with `"ok": true` and `"importRunning": false`:

   ```bash
   curl --fail-with-body "$WORKER_BASE_URL/health"
   ```

   Pause staff uploads during the switch and schedule it away from the import cron. A failed `/health` also needs investigation before rotation.
2. On the staff device, create and publicly share the new album with the required contributors. Put a marker card before the first intended product and upload at least one photo; `/setup` requires a nonempty album. Record the timestamp immediately before the first photo you intend to import.
3. Save the complete existing `APP_CONFIG_JSON` securely, changing only `FIRST_IMPORT_CUTOFF_DATE` to that timestamp as a full UTC ISO 8601 datetime, for example `2026-09-23T00:00:00.000Z`. The field rejects a date-only value. Photos with missing capture time or earlier capture time are excluded, so check that the first marker is within the cutoff. The new album's source ID already gets its own checkpoint; the cutoff only limits its first eligible photos.
4. Update production secrets, supplying the new public album token and then the full edited config at the prompts:

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

`sourceAlbumId` is SHA-256 of the album token. D1 identifies each `photo_assets` row by `(source_album_id, apple_photo_id)`, so Apple photo IDs reused across distinct albums cannot collide. Changing the public link token for the *same* album changes that source ID and may import its photos again; verify the token truly points to the new album.

| Date | Old album name | New album name | First import result |
|---|---|---|---|

Record names and outcome only; never record public links or tokens.
