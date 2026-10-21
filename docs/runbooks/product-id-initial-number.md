# Change `PRODUCT_ID_INITIAL_NUMBER`

`PRODUCT_ID_INITIAL_NUMBER` is a positive integer inside the Worker secret `APP_CONFIG_JSON`. With `PRODUCT_ID_PREFIX` set to `A`, a value of `20000` requests a starting ID of `A-20000`.

## Before changing it

- Select the intended Worker/environment. The current bot uses `snazzy-automation-staging`.
- Pause manual and scheduled imports; wait for running imports to finish.
- Check the sequence in that Worker's D1 database:

  ```sql
  SELECT next_value, bootstrapped_at
  FROM sequences WHERE name = 'product_id';
  ```

If `bootstrapped_at` is populated, the sequence is already initialized. **Changing this setting will not change the next product ID.** Advancing an existing sequence requires a separate controlled D1 update after checking allocated IDs and Airtable. Do not clear `bootstrapped_at` or reuse old numbers.

## Set the initial number

1. Take a trusted copy of the **complete** current `APP_CONFIG_JSON`. Change only:

   ```json
   "PRODUCT_ID_INITIAL_NUMBER": 20000
   ```

   Keep this as a JSON number, without quotes. Preserve every other field.

2. In Cloudflare, open the intended Worker → **Settings → Variables and Secrets**. Replace `APP_CONFIG_JSON` with the complete updated JSON and save/deploy the secret change. Keep the current Worker code.

3. If the sequence is not initialized, bootstrap it once. Set `WORKER_BASE_URL` to the intended Worker's origin and securely load its `ADMIN_ROUTE_TOKEN` in your local shell:

   ```sh
   curl --fail-with-body --request POST \
     --header "Authorization: Bearer $ADMIN_ROUTE_TOKEN" \
     "$WORKER_BASE_URL/setup/bootstrap-sequence"
   ```

4. Expect `{"ok":true,"bootstrappedFrom":20000}` unless Airtable requires a higher number. Verify the D1 query shows that returned number as `next_value`, with a populated `bootstrapped_at`. Resume imports after verification.

Bootstrap chooses the **greater of the configured number and the largest valid Airtable ID plus one**. A higher result is expected if Airtable already contains `A-20000` or above. HTTP 409 means the sequence was already initialized; stop rather than resetting it. Existing product IDs remain unchanged.

## Configuration helper caveat

`scripts/worker-app-config.ts` currently hardcodes `PRODUCT_ID_INITIAL_NUMBER: 1`. Exporting a shell variable does not override it. Running `configure:staging` or `configure:production` regenerates the secret and restores that field to `1`; update the helper before using it to regenerate this configuration. This still does not reset an initialized D1 sequence.
