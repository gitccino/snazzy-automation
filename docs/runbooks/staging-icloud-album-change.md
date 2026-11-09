# Change the staging iCloud shared album

Target Worker: `snazzy-automation-staging`.

Worker URL: `https://snazzy-automation-staging.clicky-worker.workers.dev`.

This changes the separate Worker secret `ICLOUD_SHARED_ALBUM_TOKEN`. The album URL is not stored inside `APP_CONFIG_JSON`. No application-code deployment is needed.

## 1. Prepare

- Keep the old album link in your private operator records so you can restore it. Cloudflare does not reveal saved secret values.
- Pause staff `/upload` commands and prevent scheduled imports during the switch. Wait for running import workflows and queued/retrying `/upload` commands to finish.
- Open the staging `/health` URL. Require HTTP 200, `"ok": true`, and `"importRunning": false`. Investigate errors such as `sequence_drift` before importing.
- Open the new album link in a signed-out/private browser window. It must show the photos without Apple login or approval. For iOS 27, enable access for anyone with the link.
- Prepare one small test product: photograph a marker before its product photos. The iOS 27 integration orders by capture time, not the album's display order. Use still photos and distinct capture times.

## 2. Check which photos will import

Review `FIRST_IMPORT_CUTOFF_DATE` in your trusted copy of the full staging `APP_CONFIG_JSON`. It filters photo capture timestamps on every import. The test marker and its product photos must be on or after that timestamp.

If it needs changing, preserve every other configuration field and replace the complete `APP_CONFIG_JSON` secret. Use a full UTC timestamp, such as `2026-11-09T03:00:00.000Z` for 10:00 Bangkok time on that date. Keep the marker inside the eligible range. Do not regenerate the entire configuration using the configuration helper just to change the album.

Changing a link, including upgrading the same album to an iOS 27 link, may create a new source identity. Previous checkpoints and product-group deduplication may not carry over. Photos already imported from the old source can become new products. For the first test, use an album containing only the intended test batch, or a carefully chosen cutoff.

## 3. Replace the staging secret

In Cloudflare, open **Workers & Pages → snazzy-automation-staging → Settings → Variables and Secrets**. Edit `ICLOUD_SHARED_ALBUM_TOKEN`, paste the complete new iOS 27 album URL, then save/deploy the secret change.

Use the full `https://photos.icloud.com/shared/album/...` URL, not just its final identifier. The URL format selects the iOS 27 integration.

Alternatively, from the repository root, run:

```sh
npx wrangler secret put ICLOUD_SHARED_ALBUM_TOKEN --env staging
```

Paste the full URL at Wrangler's secret prompt. Use either the dashboard or the CLI; there is no need to do both. The secret update deploys a new version using the existing deployed code. Do not run `npm run deploy:staging` afterward: that would deploy the code in your local checkout.

## 4. Verify and test

1. With the staging admin token securely loaded into `ADMIN_ROUTE_TOKEN`, run:

   ```sh
   curl --fail-with-body \
     --header "Authorization: Bearer $ADMIN_ROUTE_TOKEN" \
     https://snazzy-automation-staging.clicky-worker.workers.dev/setup
   ```

2. Require `"ok": true`, including a successful `icloud_phase_zero` check. This checks album access and visible photos, not live marker detection. Setup also performs temporary R2 and Google Docs probes and cleans them up.
3. Send `/upload` once in the allowed staging LINE group. This is a real import: it can create Airtable records, store images, and allocate product IDs.
4. Check the LINE result and Airtable: only the intended product/photo group should be imported. Resume staff uploads and schedules after success.
5. If you use local tests, update the ignored local `.env` value separately to the same full URL. A local edit alone does not update the Worker.

## Roll back

Pause imports again and wait for active/queued import work to finish. Restore the old album secret using the same procedure, restore the old full configuration if you changed the cutoff, then repeat setup verification. Keep both albums unchanged while investigating.

Restoring the secret does not undo Airtable records, R2 images, or allocated IDs from an import. Do not delete D1 checkpoints or reset the product sequence as part of this change.

References: [album rotation](album-rotation.md), [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
