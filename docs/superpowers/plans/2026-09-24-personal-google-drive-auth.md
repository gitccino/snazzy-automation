# Personal Google Drive OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task with a fresh reviewer between tasks. The user selected this execution method previously. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace service-account Google Drive access with least-privilege OAuth for one personal Google account that owns the publication folders and shares them with collaborators.

**Architecture:** A refresh-token-backed `AccessTokenProvider` continues to hide Google authorization from publication code. A one-time local operator utility uses OAuth and Google Picker to authorize the owner's My Drive folder and template; the Worker receives the refresh credentials as environment bindings and setup proves the real create/edit/rename/delete path. Staging and production keep separate folders and templates.

**Tech Stack:** TypeScript, Cloudflare Workers Web APIs, Node built-ins through existing `tsx`, Google OAuth 2.0, Google Drive/Docs/Picker APIs, Zod, Vitest, Wrangler.

**Spec:** [Personal Google Drive Authorization Design](../specs/2026-09-24-personal-google-drive-auth-design.md)

## Global Constraints

- One personal Google account owns each deployment's publication files in My Drive; collaborators receive access through folder sharing and do not authorize the application.
- Staging and production use separate My Drive folders and template IDs; the same personal account may own both.
- Do not use a service account, Workspace Shared Drive, domain-wide delegation, or impersonation.
- The only Drive/Docs data scope is `https://www.googleapis.com/auth/drive.file`; basic `openid` and `email` may be requested only to confirm the owner.
- Scheduled jobs use OAuth offline access; refresh tokens are Cloudflare secrets and access tokens stay in Worker memory only.
- Replace refresh-token secrets per environment without revoking the OAuth grant. If grant revocation is intentional, coordinate pause, reauthorization, secret updates, and verification for every environment using that Google project.
- Never put OAuth credentials in source control, `APP_CONFIG_JSON`, D1, R2, Airtable, logs, or deployed Worker responses.
- Do not fall back to full-Drive `drive` or Docs `documents` scopes if Picker access fails; stop for scope review.
- A production deployment must not rely on an OAuth consent project left in Testing; complete Google's applicable production/verification requirements first.
- Preserve publication content, workflow states, retries, and idempotency except where a Google API request must change for My Drive.

## Review Focus

- Invalid, missing, revoked, or malformed OAuth refresh credentials must fail non-retryably and expose no credential or raw upstream body. Test in `test/publication/google-auth.test.ts`.
- OAuth transport, 429, and 5xx failures must be retryable; ordinary 4xx and `invalid_grant` must not. Test in `test/publication/google-auth.test.ts`.
- A Picker selection with the wrong file type, a template outside the selected folder, or a Shared Drive folder must be rejected before IDs are accepted. Test in `test/scripts/google-drive-oauth-setup.test.ts`.
- A My Drive folder with no `driveId` and `canAddChildren: true` must pass the folder precheck; the disposable delete proves deletion. A Shared Drive, wrong template, missing markers, or failed copy readback must fail. Test in `test/routes/setup.test.ts`.
- A copy whose response is lost must still be found and cleaned up using its setup-probe property; token revocation must never cause a different folder/account to be used. Test in `test/routes/setup.test.ts` and `test/publication/google-auth.test.ts`.

## File Map and Module Seams

- `src/publication/google-auth.ts` — replace JWT signing with refresh-token exchange; keep `AccessTokenProvider.getAccessToken()` as the consumer interface.
- `src/publication/service.ts` and `src/publication/workflow.ts` — pass OAuth credentials to the existing provider; do not put token-refresh logic in workflow steps.
- `src/publication/google-docs.ts` — keep document operations and recovery behavior; remove Shared Drive-only request parameters.
- `src/routes/setup.ts` — validate My Drive and run the existing disposable document rehearsal without service-account membership checks.
- `scripts/google-drive-oauth-setup.ts` — local, operator-only OAuth/Picker bootstrap; no deployed sign-in endpoint or multi-user token store.
- Tests under `test/publication`, `test/routes`, `test/scripts`, and `test/acceptance` — cover the same interfaces used by production.
- Current design/runbooks and the active hardening-handoff plan — replace operational instructions that provision a service account or require a Shared Drive. Leave completed historical publication-plan examples as historical records.

---

### Task 1: Replace Service-Account JWT Auth With a Refresh-Token Provider

**Files:**

- Modify: `src/publication/google-auth.ts`
- Test: `test/publication/google-auth.test.ts`

**Interfaces:**

- Consumes: existing `Clock`, `Fetcher`, and `OperationalError` patterns.
- Produces: `GoogleOAuthCredentials` with `clientId`, `clientSecret`, and `refreshToken`; `createGoogleAuthClient(credentials, clock, fetcher)` returning the existing `AccessTokenProvider`.

- [ ] **Step 1: Add the refresh-grant request test**

Use a fake token response and assert the exact OAuth form fields:

```ts
const client = createGoogleAuthClient(
  {
    clientId: "oauth-client-id",
    clientSecret: "oauth-client-secret",
    refreshToken: "refresh-token",
  },
  { now: () => new Date("2026-09-24T05:00:00.000Z") },
  fetcher,
);

await expect(client.getAccessToken()).resolves.toBe("access-token");
const body = new URLSearchParams(String(fetcher.mock.calls[0]?.[1]?.body));
expect(body.get("grant_type")).toBe("refresh_token");
expect(body.get("client_id")).toBe("oauth-client-id");
expect(body.get("client_secret")).toBe("oauth-client-secret");
expect(body.get("refresh_token")).toBe("refresh-token");
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `npx vitest run test/publication/google-auth.test.ts`

Expected: FAIL because the provider still accepts service-account JSON and sends a JWT bearer grant.

- [ ] **Step 3: Replace JWT signing with refresh-token exchange**

Implement the declared credentials type and send `grant_type=refresh_token` to `https://oauth2.googleapis.com/token`. Retain the one-minute expiry skew and in-memory access-token cache. Remove `GoogleServiceAccountJson`, `parseServiceAccountJson`, `signServiceAccountJwt`, the private-key parser, and the broad `drive`/`documents` scope constants.

- [ ] **Step 4: Add token failure and cache tests**

Cover transport rejection, 429, 5xx, ordinary 4xx, `invalid_grant`, malformed JSON, missing `access_token`, and cache refresh after expiry. For each failure assert the `OperationalError` code/retryability and assert the raw response body and credential values are absent from its message.

- [ ] **Step 5: Run focused auth tests**

Run: `npx vitest run test/publication/google-auth.test.ts`

Expected: PASS; all refresh failures are sanitized. The repository-wide typecheck is intentionally deferred until Tasks 2 and 4 migrate the service and setup-probe consumers from the removed service-account API.

- [ ] **Step 6: Commit the auth-provider increment**

```bash
git add src/publication/google-auth.ts test/publication/google-auth.test.ts
git commit -m "feat(google): refresh user OAuth access tokens"
```

### Task 2: Wire OAuth Credentials Through Worker and Publication Services

**Files:**

- Modify: `src/env.ts`
- Modify: `src/publication/service.ts`
- Modify: `src/publication/workflow.ts`
- Modify: `test/helpers/env.ts`
- Modify: `test/publication/service.test.ts`
- Modify: `test/acceptance/publication.test.ts`

**Interfaces:**

- Consumes: `GoogleOAuthCredentials` and `createGoogleAuthClient` from Task 1.
- Produces: `Env.GOOGLE_OAUTH_CLIENT_ID`, `Env.GOOGLE_OAUTH_CLIENT_SECRET`, and `Env.GOOGLE_REFRESH_TOKEN`; `PublicationServiceDeps.googleOAuthCredentials` with the same three fields.

- [ ] **Step 1: Replace service-account fixtures with OAuth credentials**

Update test environment and publication service fixtures to provide:

```ts
googleOAuthCredentials: {
  clientId: "test-oauth-client-id",
  clientSecret: "test-oauth-client-secret",
  refreshToken: "test-refresh-token",
}
```

- [ ] **Step 2: Run the focused tests and confirm type failures**

Run: `npx vitest run test/publication/service.test.ts test/acceptance/publication.test.ts`

Expected: FAIL at compile/runtime fixture boundaries where `googleServiceAccountJson` is still required.

- [ ] **Step 3: Wire the OAuth credential object once at the existing seams**

Replace `Env.GOOGLE_SERVICE_ACCOUNT_JSON` with the three bindings. Rename `PublicationServiceDeps.googleServiceAccountJson` to `googleOAuthCredentials`; pass the object from `depsFor` in `src/publication/workflow.ts`. Update the four auth-provider constructions in `src/publication/service.ts` to use the same field. Do not change Google Docs call signatures or publication workflow step boundaries.

```ts
googleOAuthCredentials: {
  clientId: env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
  refreshToken: env.GOOGLE_REFRESH_TOKEN,
}
```

- [ ] **Step 4: Run publication tests**

Run: `npx vitest run test/publication/service.test.ts test/publication/workflow.test.ts test/acceptance/publication.test.ts`

Expected: PASS. The setup-probe consumer still uses the old API until Task 4, so the repository-wide typecheck is deferred to Task 4; no `GOOGLE_SERVICE_ACCOUNT_JSON` references should remain in `src/publication` or the migrated publication fixtures.

- [ ] **Step 5: Commit the runtime wiring increment**

```bash
git add src/env.ts src/publication/service.ts src/publication/workflow.ts test/helpers/env.ts test/publication/service.test.ts test/acceptance/publication.test.ts
git commit -m "refactor(google): wire OAuth credentials into publication"
```

### Task 3: Make Publication Drive Requests My-Drive-Only

**Files:**

- Modify: `src/publication/google-docs.ts`
- Test: `test/publication/google-docs.test.ts`
- Update stale Shared Drive request expectations in `test/publication/service.test.ts` and `test/acceptance/publication.test.ts`.

**Interfaces:**

- Consumes: unchanged `AccessTokenProvider`, folder ID, template ID, and publication run ID.
- Produces: existing copy/find/edit/finalize/delete functions operating without Shared Drive request flags.

- [ ] **Step 1: Add assertions for My Drive request parameters**

Update the Drive request tests to assert `supportsAllDrives` and `includeItemsFromAllDrives` are absent from lookup, copy, rename, and delete requests. Keep assertions for parent folder and `appProperties.publicationRunId`. Update the existing cleanup URL expectations in the service and acceptance tests to omit `supportsAllDrives` too.

- [ ] **Step 2: Run Google Docs tests and confirm the Shared Drive assertions fail**

Run: `npx vitest run test/publication/google-docs.test.ts`

Expected: FAIL because requests currently include Shared Drive flags.

- [ ] **Step 3: Remove Shared Drive-only query parameters**

Remove `supportsAllDrives` and `includeItemsFromAllDrives` from Drive list/copy/update/delete calls. Keep pagination, safe query escaping, recovery by `appProperties`, and current not-found handling unchanged.

- [ ] **Step 4: Run Google Docs tests**

Run: `npx vitest run test/publication/google-docs.test.ts test/publication/service.test.ts test/acceptance/publication.test.ts`

Expected: PASS, including duplicate-recovery and response-loss cases.

- [ ] **Step 5: Commit the My Drive request increment**

```bash
git add src/publication/google-docs.ts test/publication/google-docs.test.ts
git commit -m "refactor(google): target personal My Drive"
```

### Task 4: Rework the Setup Probe for the Authorized My Drive Folder

**Files:**

- Modify: `src/routes/setup.ts`
- Test: `test/routes/setup.test.ts`

**Interfaces:**

- Consumes: Task 1 OAuth provider and Task 2 Worker bindings; existing `SetupExternalProbes.verifyGoogleTemplateAccess()` interface.
- Produces: `google_template_access` readiness check that validates a personal My Drive folder and exercises the exact publication operations.

- [ ] **Step 1: Change setup fixtures to return a My Drive folder**

Update `googleEnv()` and `googleFetch()` so OAuth token requests use the refresh-token grant and the My Drive folder response has no `driveId`, but has `canAddChildren: true`. Do not fabricate `canDeleteChildren`; Google only populates it for Shared Drive items.

- [ ] **Step 2: Add failing My Drive and Shared Drive assertions**

Assert that a folder with no `driveId` completes the probe, and that a folder with a `driveId`, wrong MIME type, missing capabilities, an out-of-folder template, or missing template markers fails. Keep the lost-copy-response test and assert the orphan lookup/delete still occurs.

- [ ] **Step 3: Run setup tests and confirm old Shared Drive expectations fail**

Run: `npx vitest run test/routes/setup.test.ts`

Expected: FAIL because setup currently rejects My Drive and requires organizer membership.

- [ ] **Step 4: Remove service-account and organizer checks**

Use the OAuth bindings to construct the auth provider. Remove `parseServiceAccountJson`, `DrivePermissionsSchema`, and `isSharedDriveOrganizer`. Require a folder MIME type of `application/vnd.google-apps.folder`, no `driveId`, `canAddChildren`, and a Google Docs template whose parent is the configured folder. Keep marker validation and the disposable copy/edit/readback/rename/permanent-delete rehearsal. Report a safe copy or probe ID if cleanup fails. Remove Shared Drive-only list flags from setup and cleanup.

```ts
if (folder.driveId) throw new Error("Configured Google folder must be in My Drive");
if (!folder.capabilities?.canAddChildren) {
  throw new Error("Authorized account lacks required My Drive folder capabilities");
}
```

- [ ] **Step 5: Update setup result text and run the tests**

Change the successful detail to `Google My Drive template rehearsal verified` and run:

```bash
npx vitest run test/routes/setup.test.ts
npm run typecheck
```

Expected: PASS; all probe failure details remain sanitized.

- [ ] **Step 6: Commit the setup-probe increment**

```bash
git add src/routes/setup.ts test/routes/setup.test.ts
git commit -m "feat(setup): validate personal Google Drive access"
```

### Task 5: Add the Local OAuth and Google Picker Bootstrap

**Files:**

- Create: `scripts/google-drive-oauth-setup.ts`
- Create: `test/scripts/google-drive-oauth-setup.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_PICKER_API_KEY`, `GOOGLE_CLOUD_PROJECT_NUMBER`, `--expected-owner <email>`, and a browser signed in to the intended personal account.
- Produces: selected `GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_TEMPLATE_DOC_ID`, confirmed owner email, and a refresh token for entry through Wrangler's interactive secret prompt.

- [ ] **Step 1: Test target validation and OAuth callback checks**

Export and test pure helpers from the script. The selection validator accepts only one My Drive folder and one Google Doc whose parent is that folder. The callback validator rejects missing code, OAuth denial, and mismatched `state`; none of those paths exchanges or reveals credentials. Require the operator to confirm the email returned by OAuth matches the expected owner email.

```ts
expect(() => validatePickerSelection(
  { id: "folder-1", mimeType: "application/vnd.google-apps.folder" },
  { id: "template-1", mimeType: "application/vnd.google-apps.document", parents: ["other-folder"] },
)).toThrow();
```

- [ ] **Step 2: Run the setup-utility tests and confirm they fail**

Run: `npx vitest run test/scripts/google-drive-oauth-setup.test.ts`

Expected: FAIL because the utility and validators do not exist.

- [ ] **Step 3: Implement authorization URL and callback validation**

Use Node built-ins and existing `tsx`; do not add an OAuth SDK. Build the authorization URL with `openid email drive.file`, `access_type=offline`, cryptographically random `state`, and PKCE S256. Bind the callback server only to a fixed loopback origin; validate state before exchanging the authorization code server-side. Confirm the expected owner using Google's userinfo endpoint and the access token, not by trusting an unverified email claim. Keep the client secret, access token, and refresh token in process memory only.

```ts
const params = new URLSearchParams({
  client_id: clientId,
  redirect_uri: callbackUrl,
  response_type: "code",
  scope: "openid email https://www.googleapis.com/auth/drive.file",
  access_type: "offline",
  prompt: "consent",
  state,
  code_challenge_method: "S256",
  code_challenge: codeChallenge,
});
```

- [ ] **Step 4: Test authorization denial, state mismatch, and account confirmation**

Add tests proving OAuth denial/missing code/state mismatch do not call the token endpoint, mismatched expected owner email aborts setup, and a valid callback returns only the parsed token result to the local process.

- [ ] **Step 5: Add the Picker selection page**

Load Google Picker in the local loopback page with the access token, project number, and `GOOGLE_PICKER_API_KEY` restricted to the local origin and Picker API. Require the owner to select the folder and template. Keep the OAuth client secret and refresh token out of the browser page.

```ts
const folderView = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
  .setIncludeFolders(true)
  .setSelectFolderEnabled(true);
const templateView = new google.picker.DocsView(google.picker.ViewId.DOCS)
  .setMimeTypes("application/vnd.google-apps.document");
const picker = new google.picker.PickerBuilder()
  .setAppId(projectNumber)
  .setDeveloperKey(apiKey)
  .setOAuthToken(accessToken)
  .addView(folderView)
  .addView(templateView);
```

- [ ] **Step 6: Validate Picker selections against Drive metadata**

Reject a Shared Drive folder, wrong file types, a template outside the selected folder, incomplete Drive metadata, and Google errors. Show the authorized email and selected IDs for confirmation. Display the refresh token once to the local terminal for immediate entry into `npx wrangler secret put GOOGLE_REFRESH_TOKEN --env staging` or the production equivalent; enforce this once-only completion server-side even if duplicate selection submissions race. Never put the token in shell arguments, source files, persistent logs, or Worker responses.

- [ ] **Step 7: Add the package command and complete utility tests**

Add `google:drive-setup` to `package.json` as `tsx scripts/google-drive-oauth-setup.ts`. Read the named OAuth and Picker inputs from the process environment and require `--expected-owner <email>`. Cover `state` mismatch, API denial, wrong account confirmation, Shared Drive folder, wrong file types, template outside folder, sanitized Google error responses, and concurrent successful selection submissions producing the refresh token only once.

- [ ] **Step 8: Run setup utility tests and typecheck**

Run:

```bash
npx vitest run test/scripts/google-drive-oauth-setup.test.ts
npm run typecheck
```

Expected: PASS without new package dependencies or a refresh token written to disk.

- [ ] **Step 9: Commit the operator utility increment**

```bash
git add scripts/google-drive-oauth-setup.ts test/scripts/google-drive-oauth-setup.test.ts package.json
git commit -m "feat(google): add owner OAuth setup utility"
```

### Task 6: Update Current Design, Runbooks, and the Active Handoff Plan

**Files:**

- Modify: `docs/superpowers/specs/2026-09-24-personal-google-drive-auth-design.md`
- Modify: `docs/superpowers/specs/2026-09-01-snazzy-automation-design.md`
- Modify: `docs/superpowers/plans/2026-09-01-snazzy-hardening-handoff.md`
- Modify: `docs/runbooks/deployment.md`
- Modify: `docs/runbooks/publication-setup.md`
- Modify: `docs/runbooks/credential-rotation.md`
- Modify: `docs/runbooks/operations.md`
- Modify: `docs/runbooks/handoff-acceptance.md`

**Interfaces:**

- Consumes: implemented environment variable names and `npm run google:drive-setup` from Tasks 2 and 5.
- Produces: current operator instructions that never direct a reader to provision a Google service account or Shared Drive.

- [ ] **Step 1: Update the current system design's Google assumptions**

Mark the user-approved personal Drive authorization spec `Approved` (it still says `Draft for user review`). In the system design, change only Google ownership, credentials, scope, storage, and cost passages: one personal account owns My Drive output; collaborators use folder sharing; no Workspace subscription or service account is required; account storage and recovery are operator dependencies. Keep all other approved design content unchanged.

- [ ] **Step 2: Replace the publication setup contract**

Document OAuth consent, `drive.file`, Picker selection, My Drive folder/template requirements, and the disposable setup rehearsal. Remove service-account organizer, `driveId` requirement, and Shared Drive request-flag instructions.

- [ ] **Step 3: Update deployment and credential rotation steps**

Document Drive/Docs/Picker API enablement, OAuth consent and production status, the local setup utility, environment-specific folder/template IDs, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN`. Explain the seven-day Testing-token limitation, refresh-token replacement, and when to remove/revoke any legacy service-account credential. Do not place live values in docs.

- [ ] **Step 4: Update operations and handoff acceptance**

Add reconnect guidance for invalid/revoked authorization; require owner account recovery access and collaborator folder sharing; verify a collaborator can open a generated doc without authorizing the application. Preserve all non-Google operational steps.

- [ ] **Step 5: Reconcile the active hardening-handoff plan**

Add a prominent link to the approved personal-Drive design. Update active deployment prerequisites, setup acceptance, and secret/rotation instructions so they use the OAuth model. Mark old service-account implementation snippets as superseded historical examples instead of leaving executable deployment directions that conflict with the new spec. Do not rewrite completed historical publication-pipeline plans or the implementation index.

- [ ] **Step 6: Preserve the existing local deployment edits and review docs**

In `docs/runbooks/deployment.md`, edit only Google-specific passages and keep the existing unrelated user edits. Run:

```bash
git diff --check
rg -n "GOOGLE_SERVICE_ACCOUNT_JSON|service-account organizer|Shared Drive" docs/runbooks docs/superpowers/plans/2026-09-01-snazzy-hardening-handoff.md
```

Expected: no active provisioning instructions remain; any remaining matches are explicitly labeled superseded historical material.

- [ ] **Step 7: Commit documentation updates**

```bash
git add docs/superpowers/specs/2026-09-24-personal-google-drive-auth-design.md docs/superpowers/specs/2026-09-01-snazzy-automation-design.md docs/superpowers/plans/2026-09-01-snazzy-hardening-handoff.md docs/runbooks/deployment.md docs/runbooks/publication-setup.md docs/runbooks/credential-rotation.md docs/runbooks/operations.md docs/runbooks/handoff-acceptance.md
git commit -m "docs(google): document personal Drive OAuth setup"
```

### Task 7: Verify Locally and Rehearse Staging Before Production

**Files:**

- Verify: all implementation files from Tasks 1–6

**Interfaces:**

- Consumes: complete OAuth path, operator utility, and updated runbooks.
- Produces: verified staging handoff evidence; no production deployment is implied by this plan task.

- [ ] **Step 1: Run the complete local validation suite**

Run:

```bash
npm run check
npm run test:acceptance
```

Expected: typecheck and all unit/acceptance tests pass. The test suite must not contact Google or require real OAuth credentials.

- [ ] **Step 2: Verify no runtime service-account dependency remains**

Run:

```bash
rg -n "GOOGLE_SERVICE_ACCOUNT_JSON|parseServiceAccountJson|signServiceAccountJwt|googleServiceAccountJson" src test scripts
```

Expected: no active source/test references. Historical design/plan text is excluded from this source-only check.

- [ ] **Step 3: Configure Google staging prerequisites with the owner**

In the intended Google Cloud project, enable Drive API, Docs API, and Picker API; configure the OAuth consent screen and loopback OAuth client; create a Picker API key restricted to the setup utility's loopback origin and Picker API; record the project number. Keep the project in Testing only for a time-bounded staging rehearsal and note the refresh token's seven-day expiry.

- [ ] **Step 4: Authorize and configure staging**

Run `npm run google:drive-setup -- --expected-owner <owner-email>`, select the staging My Drive folder and template with the intended personal account, and confirm the owner email and selected IDs. Record only the owner email and selected IDs in protected operator notes. Set `GOOGLE_OAUTH_CLIENT_ID` as a Worker variable and `GOOGLE_OAUTH_CLIENT_SECRET` plus `GOOGLE_REFRESH_TOKEN` as staging Worker secrets; update `APP_CONFIG_JSON` with the selected staging folder/template IDs.

- [ ] **Step 5: Run staging readiness and publication rehearsal**

Run the existing Wrangler dry-run, deploy only to staging after the code review gate, and call the authorized `/setup` endpoint. Require all checks to pass, then run one disposable staging publication. Confirm the document is owned by the selected account and a folder collaborator can open it. Replacing a staging refresh-token secret must not revoke the OAuth grant: project-wide grant revocation can invalidate production and other clients. If revocation is required, pause every affected environment, revoke, reauthorize and update each environment, verify each `/setup` and controlled publication, then resume.

- [ ] **Step 6: Prepare production without deploying it**

Use a separate production folder and template. Move the OAuth consent project to the appropriate production status and complete all applicable Google verification before unattended production use. Obtain production authorization and configure production secrets only after staging succeeds. Stop and return to the user if Google requires a broader scope or verification path not covered by the approved spec.

- [ ] **Step 7: Record safe staging evidence and commit the acceptance record**

Record the staging environment, selected folder/template IDs, `/setup` result, document ownership, collaborator access, and publication outcome in `docs/runbooks/handoff-acceptance.md`. Never record tokens, authorization codes, or raw upstream responses. Run `git diff --check` and `git status --short`; confirm unrelated deployment configuration edits remain intact.

```bash
git add docs/runbooks/handoff-acceptance.md
git commit -m "docs(handoff): record personal Drive staging proof"
```

## Final Verification Gate

Before asking to enable publication traffic, run `npm run check`, `npm run test:acceptance`, and the staging `/setup` probe. The staging publication must prove My Drive ownership, collaborator folder sharing, retry/idempotency preservation, and safe revoked-token failure. Do not deploy production from this plan until the owner explicitly requests the production step and the OAuth consent requirements are satisfied.
