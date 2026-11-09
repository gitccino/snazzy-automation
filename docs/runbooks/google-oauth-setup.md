# Google OAuth setup for staging

Google creates these values; do not generate them randomly. The client ID and secret come from Google Cloud. The refresh token comes from authorizing the Google account that will own the generated documents.

## 1. Prepare a Google Cloud project

Enable **Google Drive API**, **Google Docs API**, and **Google Picker API** in the same project.

## 2. Configure Google Auth Platform

Set up the consent screen. Our authorization helper requests:

- `openid`
- `email`
- `https://www.googleapis.com/auth/drive.file`

For ongoing use, set the publishing status to **In production** and address any verification requirements Google shows. External apps in **Testing** receive refresh tokens that expire after seven days with these scopes. Publishing does not make a refresh token permanent; access can still expire or be revoked.

## 3. Create the OAuth client

Create a client of type **Web application** with:

- Authorized JavaScript origin: `http://127.0.0.1:8765`
- Authorized redirect URI: `http://127.0.0.1:8765/oauth/callback`

Save the resulting `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` securely.

## 4. Prepare the authorization helper

Create a Google Picker API key in the same project and note its **project number**. Restrict the key to Google Drive API and Google Picker API, with these website referrers:

- `http://127.0.0.1:8765/*`
- `https://docs.google.com/*`

Load the following as exported variables in an interactive local terminal, using your private credential store rather than placing real secrets in shell history:

```text
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_PICKER_API_KEY
GOOGLE_CLOUD_PROJECT_NUMBER
```

The Picker API key and project number are required by the local setup helper; they are not additional Worker bindings in the current application.

## 5. Authorize the Google account

Create a staging output folder in **My Drive** and put the publication Google Docs template inside it. The template must follow the [publication template requirements](publication-setup.md).

From the repository root, run:

```sh
npm run google:drive-setup -- --expected-owner your-email@gmail.com
```

Replace the example email with the intended owner. Open the printed authorization URL, sign in as that owner, approve access, and select the staging folder and template in Picker.

The helper prints `GOOGLE_REFRESH_TOKEN` once, along with `GOOGLE_DRIVE_FOLDER_ID` and `GOOGLE_TEMPLATE_DOC_ID`. Save the refresh token in your private credential store. Do not capture the session in logs or commit any credentials.

## 6. Configure staging and verify

If replacing existing credentials, pause manual and scheduled document jobs and wait for active/retrying jobs to finish before changing values.

In Cloudflare, set `GOOGLE_OAUTH_CLIENT_ID` as a normal variable on **snazzy-automation-staging**. Upload the matching client secret and refresh token using the interactive prompts:

```sh
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET --env staging
npx wrangler secret put GOOGLE_REFRESH_TOKEN --env staging
```

Put the selected folder and template IDs into the complete staging `APP_CONFIG_JSON`, preserving every other field. Secret updates deploy new versions using the existing deployed code; no separate local-code deployment is needed.

With the staging admin token securely loaded into `ADMIN_ROUTE_TOKEN`, verify setup:

```sh
curl --fail-with-body \
  --header "Authorization: Bearer $ADMIN_ROUTE_TOKEN" \
  https://snazzy-automation-staging.clicky-worker.workers.dev/setup
```

Require `"ok": true`, including a successful `google_template_access` check, before resuming jobs or testing `/docs`. Setup creates and removes temporary probe resources, including a disposable Google Doc copy.

## References

- [Project publication setup](publication-setup.md)
- [Google OAuth documentation](https://developers.google.com/identity/protocols/oauth2)
- [Google Picker setup](https://developers.google.com/workspace/drive/picker/guides/web-picker)
