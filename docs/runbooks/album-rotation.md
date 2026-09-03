# Album Rotation Runbook

Apple limits a Shared Album to 5,000 items. Before the active album approaches
that limit, staff and operator rotate to a fresh album without losing history
or creating duplicate imports.

## When to rotate

- Monitoring shows the active album's photo count approaching 4,500 (buffer
  before Apple's 5,000 hard limit).
- `/upload` or the scheduled import reports an Apple-side limit error.

## Procedure

1. **Staff:** Create a new iCloud Shared Album. Re-share it with the same
   contributors used for the outgoing album.
2. **Staff:** Stop uploading new shoot photos to the old album immediately
   after creating the new one.
3. **Operator:** Obtain the new album's public share token (same manual
   token-retrieval process used for initial setup).
4. **Operator:** Update the `ICLOUD_SHARED_ALBUM_TOKEN` secret in Cloudflare
   for the target environment to the new album's token.
5. **Operator:** Set `FIRST_IMPORT_CUTOFF_DATE` (or the equivalent rotation
   cutoff) to the timestamp staff confirms as "first photo intentionally
   uploaded to the new album."
6. **Operator:** Run the setup validator (`npm run phase-zero` for the
   iCloud-specific checks; the full setup command once the Import Pipeline
   plan lands) against the new token before resuming scheduled imports.
7. **Operator:** Leave the previous album's token, D1 rows, and R2 objects
   untouched — it remains a read-only archive. Do not delete the old iCloud
   album.
8. **Operator:** Confirm the new album produces a Phase-0-shaped snapshot
   (`getSnapshot()` returns photos, `sourceAlbumId` is a 64-character digest,
   and it does not contain the new token) by re-running the album-rotation
   test's assertions against the live configuration, or by triggering a normal
   `/upload` and checking the LINE success report for the expected new Product
   ID range.

## Why identifiers cannot collide across rotations

Every `SourcePhoto.sourceAlbumId` is the SHA-256 digest of the album token used
for that request (`src/icloud/client.ts`). The digest is stable for repeated
polls of one album, distinct when the token changes, and safe to persist in D1.
The raw token remains only in Cloudflare secret storage and outgoing iCloud
request URLs. Downstream D1 storage (Import Pipeline plan) keys the
`photo_assets` table by `(source album ID, Apple photo ID)`, never by Apple
photo ID alone. Even if Apple reused a `photoGuid` across shared albums, the
composite key remains distinct — proven by
`test/icloud/album-rotation.test.ts`.
