# iCloud album switching in Snazzy Settings

## Purpose

An approved Settings user can see the iCloud Shared Album that supplies `/upload`, review all album mappings, and switch to a new album when the current one fills up. The outgoing album stays available for product lookup with its verified date range. The client completes the switch in Settings without needing access to Cloudflare.

## Current behavior

The active import source comes from the automation Worker's `ICLOUD_SHARED_ALBUM_TOKEN` secret. The album mapping is already in the `ICLOUD_ALBUMS` field of the D1 `app_settings` record. Each entry has a source ID, name, optional share URL, and optional date range. Product lookup uses the recorded source ID for products with matching import history. Otherwise it looks for the product's Airtable **Upload Date** in the mapped ranges.

The sample legacy iCloud link opened Apple's page but did not return album data during testing. Automatic name and photo-added date retrieval is deferred. The client supplies those values from Apple Photos. Link verification is still required to activate an album.

## Settings experience

### Album list

Add an **iCloud Albums** section to the existing Access-protected Settings site. Show every saved mapping with its name, start and end dates, and a link when present. Display missing dates as **No date range**. Mark the album actually used by `/upload` as **Active for uploads**. Resolve that status from the effective import source, including existing installations still using the Worker secret. If the source has no matching entry, show that the active source has no mapping and allow the user to complete its mapping during the switch.

Allow ordinary edits to any mapping's name or photo-added date range, including the active album. A name edit updates the label used in Settings and product lookup. A range edit can change lookup results for products that rely on Airtable's **Upload Date**. Preserve the mapping's source ID, link, active status, import cutoff, and checkpoint on these saves.

### Switch album

1. **Review the current album.** Prefill its saved name and date range. Preserve its source ID and existing link. Ask the client to confirm or correct its dates. If it has no mapping, collect its name and dates, then save it under its actual source ID.
2. **Enter the new album.** Require a name and share link. Ask for the first and last dates photos were added if the album already contains photos. A verified empty album may start with both dates blank. If the source already has a mapping, prefill it and update that entry when saving.
3. **Verify and confirm.** Check the new link from the automation Worker. A readable album with zero photos passes. Show an actionable error for a private, invalid, or temporarily unreachable link. The confirmation shows which album will become active and the range that will be saved for the outgoing album. For a populated album that has never been used for imports, explain that it already contains photos and require the client to review and confirm a capture-time cutoff. Show the cutoff as a date and time in Bangkok and make clear that existing photos captured after it may be imported. A verified empty album needs no cutoff confirmation. If the album was used before, show the cutoff and checkpoint that will be reused.
4. **Save the switch.** Before switching, ask the client to pause LINE commands and wait for queued and active uploads to finish. Save the outgoing mapping, incoming mapping, active source, and any new cutoff together. On success, refresh Settings with the new active album and let the client know they can resume commands. If verification or saving fails, retain the draft and keep serving the prior source.

For an outgoing album with photos, require both dates before saving. An outgoing album confirmed empty may have both dates blank. Use inclusive dates as shown in Apple Photos, interpreted as Bangkok calendar dates for product matching. Reject incomplete or reversed ranges and explain any conflict with the existing registry's overlap limit. Same-day overlap is valid within that limit. Keep ranges editable in Settings so the client can fill in or correct them later.

### Date and time controls

- Use the [shadcn/ui Base UI Date Picker](https://ui.shadcn.com/docs/components/base/date-picker) patterns so the controls fit the existing Settings toolkit. Use its calendar range picker for photo-added dates. The range can be cleared where both dates may be blank.
- Use the date picker with a labeled time input for capture-time cutoffs in the switch form and the existing Import settings. Show **Bangkok time** and the selected date and time before saving. Save a UTC instant and preserve the precision of an unchanged cutoff. Keep mapping dates as date-only values.
- Check that the pickers work with a keyboard and fit on a narrow mobile screen. Verify that a selected cutoff displays the same Bangkok date and time after save and reload, even when the browser uses a different time zone.

## Storage and runtime behavior

- Reuse the revisioned D1 settings record. Store an active source ID that points to an album mapping. The mapping's validated share URL is the import source for a Settings-managed album. Derive the source ID server-side using the existing derivation rules.
- Continue using the Worker secret as the import source until a Settings-managed source is saved. A configured source with a missing mapping or unusable URL should produce a clear error. Existing deployments keep their current effective source and cutoff during rollout.
- Apply the switch in one revision-checked save. A stale revision leaves the active source and mapping as they were and asks the client to reload. The first release relies on the manual pause and drain procedure. A command sent during a switch can race with the save. System-enforced coordination between upload admission and album switching is deferred.
- Resolve the same effective source for `/upload` and setup verification. Bind each started import and its retries to its recorded source and cutoff. If a retry cannot access the original source, give an actionable error. Preserve source-scoped checkpoints and deduplication. Keep old mapping source IDs so existing products still resolve. If a share link changes the derived ID for a previously imported album, preserve the historical source lookup and require an explicit decision about import continuity before activating the changed link.
- Keep date ranges separate from import eligibility. Mapping dates describe when photos were added to the album. A cutoff compares capture timestamps. A new empty source starts with its own import state. A newly activated populated source uses the confirmed cutoff. A previously used source keeps its cutoff and checkpoint when reactivated. Selecting the current source is a mapping edit.
- Enforce these rules in the Settings API. Ordinary saves allow name and date corrections. Changes to the effective source, its link, or its cutoff go through the guarded switch or cutoff flow. Validate that the resulting active source still points to a usable mapping.
- Use the existing Settings authorization and same-origin save controls. Verify only supported iCloud share URLs through the existing iCloud client. Treat share URLs as access-bearing values. Display them only where the existing album-link behavior or an authenticated Settings action calls for them. Keep them out of logs and user-facing error details.

## Pending production cutover for Shared Album 57

This cutover is a separate operational task and can proceed independently of the Settings feature. The client still needs to share the link for **Shared Album 57**. The last recorded production import used **Snazzy mock album II**. Album 57's existing mapping was November 4–20, 2026 without a saved share link when checked. Recheck the live configuration before making the change.

1. Verify production can read Album 57 through the import snapshot reader. Obtain the full range of dates photos were added from Apple Photos, including photos already in the album that Snazzy has never imported. Update the existing Album 57 entry with the verified range and link. Check whether its existing mapping ID differs from the ID derived from the link and whether import history references either ID. Preserve referenced IDs for lookup and keep a single Album 57 entry for date matching.
2. Pause uploads, wait for active or queued imports to finish, and record the exact production cutover instant in UTC. Use it as Album 57's capture-time boundary. The first and later `/upload` commands may import eligible photos captured **strictly after** that instant. Photos captured at or before it stay out even if added to the album later. Import and verification must use the same exclusive instant comparison. Keep the existing comparison behavior for legacy sources and reuse the original cutover instant if the operation is interrupted.
3. Switch the production import source to Album 57 and remove the **Snazzy mock album II** entry from the mapping as explicitly requested for this cutover. Keep the rest of the mapping, import history, and inventory records. Verify the effective source, cutoff, and saved mapping before resuming uploads. For the first test, use a fresh product marker followed by its photos, all captured after the cutoff.

## Acceptance checks

- An approved user can see all mappings and identify the current source before and after switching. An existing installation that still uses the Worker secret displays the correct active album.
- A successful switch updates the outgoing entry, adds or updates the incoming entry, and changes the effective source in one save. Older products still resolve to the outgoing album by recorded source ID or, where applicable, by date range.
- A readable empty album can activate with blank dates and pass `/setup`. A nonempty album requires a valid range. A populated source with no prior import state requires cutoff confirmation. Missing required dates or cutoff, an invalid or private link, a timeout, an overlap conflict, or a stale revision leaves the prior setup intact.
- Ordinary edits preserve source and import settings. Test the same restrictions through the Settings API. A retry uses its recorded source and cutoff, or stops if the original source is unavailable.
- With the Album 57 cutoff, test captures before, exactly at, and after the recorded instant in both import and verification. Include equivalent timestamp representations and missing or invalid capture dates. Confirm the full historical range remains available for lookups and Album 57 appears once.
- Test the self-service feature in the owner's staging account before releasing it to the client's production account. Confirm each target account and Worker before deploying or changing settings.
