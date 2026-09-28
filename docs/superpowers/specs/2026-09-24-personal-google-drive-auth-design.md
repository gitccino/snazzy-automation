# Personal Google Drive Authorization Design

**Date:** 2026-09-24
**Status:** Approved
**Supersedes:** Google Drive account and storage assumptions only in [the system design](2026-09-01-snazzy-automation-design.md) and related deployment documentation. All other approved product and workflow behavior remains unchanged.

## 1. Decision

Use one personal Google account as the Google Drive principal for each deployment. That account owns a folder in My Drive and all generated publication documents. The owner may share that folder with other Google accounts; those collaborators do not authorize the application or provide credentials.

The application will use user OAuth authorization on behalf of that one account. It will not use a Google service account, a Workspace Shared Drive, domain-wide delegation, or impersonation.

Staging and production remain separate environments and use separate My Drive publication folders and template IDs. The same personal account may own both folders. This keeps staging output separate while preserving a single account owner.

Google Workspace is not required. The owner account's available Drive storage and account recovery remain operational dependencies; this design does not promise unlimited storage or account continuity.

## 2. Context and motivation

The current implementation authenticates with a service-account key. Its publication setup contract requires a Shared Drive because a service account cannot own files or use a personal account's storage quota. The setup validator rejects folders without a `driveId` and checks that the service account is a Shared Drive organizer. Those assumptions require Workspace and do not support the requested personal-account ownership model.

Google's Drive and Docs APIs support OAuth on behalf of a user. The recommended `drive.file` scope grants access only to files the user selects or creates for the app; Google lists this scope as non-sensitive for both Drive and Docs. A one-time file-selection step is therefore part of setup. The broad `drive` scope would grant access to all Drive files and is classified as restricted, so it is not the chosen approach.

References: [Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Docs API scopes](https://developers.google.com/workspace/docs/api/auth), [Google Picker overview](https://developers.google.com/workspace/drive/picker/guides/overview).

## 3. Goals

- Let scheduled Worker jobs create, read, edit, rename, and delete publication documents in a personal account's My Drive folder.
- Keep generated documents owned by that personal account and shareable with other accounts through normal folder sharing.
- Limit the application's Drive access to the selected publication folder, selected template, and files it creates, using `drive.file`.
- Preserve the existing publication workflow, document template format, retry behavior, and one-document-per-publication-run semantics.
- Keep OAuth refresh credentials out of source control, application configuration JSON, D1, logs, and HTTP responses.
- Make setup prove the actual Drive operations the publication workflow needs before publication is enabled.

## 4. Non-goals

- OAuth sign-in or account linking for every customer, staff member, or collaborator.
- Multi-tenant Google credential storage.
- Access to the owner's entire Drive.
- A general-purpose admin dashboard.
- Workspace provisioning, Shared Drives, service-account keys, domain-wide delegation, or user impersonation.
- Changes to Airtable, LINE, iCloud, image processing, captions, scheduling, or publication content beyond the Google authorization changes required here.

## 5. Proposed architecture

### 5.1 One-time owner authorization and selection

Provide a one-time operator setup utility for the account owner. It performs an OAuth authorization-code flow requesting offline access and the `drive.file` scope, then uses Google Picker to grant the app access to:

1. The existing publication output folder in My Drive.
2. The Google Docs template within that folder.

The utility records the selected folder and template IDs for `APP_CONFIG_JSON` and obtains the refresh token for the Worker secret. It must show which Google account was authorized before completing setup. It is an operator-only setup path, not a customer-facing account-linking feature.

The Drive/Docs data scope is exactly `drive.file`; the setup utility may request the basic `openid` and `email` identity scopes solely to confirm the authorized owner. The exact local utility interface and credential handoff mechanics are implementation details. The refresh token must be entered into Cloudflare as a secret and must not be printed to persistent logs, checked into files, or returned by the deployed Worker. Bind `GOOGLE_OAUTH_CLIENT_ID` as a non-secret variable and `GOOGLE_OAUTH_CLIENT_SECRET` plus `GOOGLE_REFRESH_TOKEN` as Worker secrets in each environment.

Google requires offline access for jobs that run when the account owner is absent. Access tokens are short-lived; the Worker exchanges the stored refresh token for access tokens and keeps them only in memory. See [Google's OAuth server-side flow](https://developers.google.com/identity/protocols/oauth2/web-server).

### 5.2 Worker authentication

Replace service-account JWT signing in `src/publication/google-auth.ts` with a refresh-token-backed `AccessTokenProvider`. The provider:

- Accepts the OAuth client ID, OAuth client secret, and refresh token from Worker bindings.
- Exchanges the refresh token for an access token when no valid cached token exists.
- Caches the access token only in Worker memory until shortly before expiry.
- Never writes access or refresh tokens to D1, R2, Airtable, application logs, error details, or setup responses.
- Maps invalid/revoked refresh credentials to a non-retryable configuration error that instructs the operator to reconnect the account; transient transport, quota, and Google server errors retain retryable handling.

The existing `AccessTokenProvider` seam remains the interface consumed by Google Drive and Docs operations. Publication workflows continue to request Google operations through that provider rather than handling OAuth themselves.

### 5.3 Drive configuration and ownership

Keep `GOOGLE_DRIVE_FOLDER_ID` and `GOOGLE_TEMPLATE_DOC_ID` as environment-specific configuration. Require the selected folder and template to be authorized through Picker before configuring those IDs. Generated document copies are created in the configured My Drive folder and are owned by the authorized personal account. Folder members receive access according to Google Drive's sharing rules.

Staging and production must use distinct folders and templates. Other accounts may be granted access to the folder by its owner, but they do not need to be OAuth users. The setup utility and runbook must not ask the owner to make the folder public.

### 5.4 Setup validation

Retain the `google_template_access` readiness check, but replace Shared Drive-specific assertions. It must verify that:

1. The configured folder is an accessible Drive folder. A missing `driveId` is expected for My Drive and is not an error.
2. The configured template is an accessible Google Doc located in the configured folder and contains the required publication markers.
3. The authorized account has `canAddChildren` for the My Drive folder; the disposable rehearsal proves deletion without relying on a Shared Drive-only capability field.
4. A disposable template copy can be created in the folder, edited and read back through Docs API to verify the edit, renamed, and permanently deleted. If cleanup after a partial setup probe fails, the check reports a safe copy or probe ID for manual cleanup without including credentials or raw Google response bodies.
5. The check performs all required operations using the same `drive.file` grant used by publication; a successful OAuth token exchange alone is not sufficient.

Remove organizer-membership checks, service-account email checks, and requirements that the folder have a `driveId`. Remove Shared Drive-only membership lookups and list flags; all create, lookup, update, and delete operations must work using the selected My Drive files and the narrow OAuth grant.

## 6. OAuth consent and token lifecycle

- OAuth authorization must request offline access so scheduled jobs can refresh access tokens without an interactive user.
- A Google OAuth project left in **Testing** issues refresh tokens that expire after seven days for this non-basic Drive scope. Testing status is not acceptable for unattended ongoing publication. The OAuth consent project must be moved to the appropriate production status before the production handoff; the operator must complete whatever verification Google requires for this single-account personal-use app.
- `drive.file` is the selected least-privilege scope. Do not silently fall back to `drive` or add `documents` if Picker-based access fails. Stop and review a scope change before proceeding.
- Google documents a personal-use exception to some scope-verification requirements. Eligibility is not assumed from this spec; the operator must check the current Cloud Console status and Google policy for the deployed app. See [OAuth app policies](https://developers.google.com/identity/protocols/oauth2/policies) and [restricted-scope verification exceptions](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).
- If the refresh token expires or is revoked, setup reports the Google authorization check as failed and publication remains disabled until the owner reauthorizes and replaces the Worker secret. A normal refresh-token secret replacement is verified with `/setup` and a controlled publication.
- Replacing one environment's `GOOGLE_REFRESH_TOKEN` does not call for revoking the old OAuth grant: Google grant revocation invalidates project-granted scopes and tokens across clients and can interrupt other environments. If grant revocation is intentional or required, pause Google publication in every affected environment, revoke the grant, reauthorize each environment, update each refresh-token secret, verify each `/setup` and controlled publication, then resume. After the new path is verified, remove the obsolete `GOOGLE_SERVICE_ACCOUNT_JSON` secret and revoke any no-longer-needed service-account key.

## 7. Security and operational ownership

- The personal account is a deliberate single point of ownership and authorization. Continuity depends on maintaining access to that account, its recovery methods, and available Drive storage.
- The owner is responsible for account security and for sharing the publication folder with the intended collaborators. The application does not manage collaborator membership.
- The refresh token grants the application ongoing access to the selected app-authorized files. Store it only as a Cloudflare Worker secret; never paste it into chat, source files, `APP_CONFIG_JSON`, or a shell command that records it in shell history.
- Setup and operational reports may include the Google check name, safe file IDs, and outcome, but never OAuth tokens, authorization codes, signed asset URLs, or raw Google response bodies.
- If the owner loses access or revokes authorization, imports and other non-Google operations may continue, but Google publication must fail closed and surface a reconnect action. It must not publish to another account or folder implicitly.

## 8. Compatibility and rollout

The existing product and publication state model remains intact. This change affects only Google authorization, the Google setup probe, environment bindings, and related deployment/operations instructions.

Before resuming deployment:

1. Update the implementation plan and runbooks so they no longer instruct the operator to create a service account or Shared Drive.
2. Implement and test the OAuth provider and operator setup utility locally.
3. Authorize the staging personal-account folder and template, then run the authenticated setup probe and a staging publication rehearsal.
4. Confirm the output document is owned by the selected personal account and accessible to the intended folder collaborators.
5. Configure production with its separate folder/template and environment-scoped OAuth secrets; run readiness checks before enabling publication traffic.
6. Remove the old service-account credential only after the new staging and production paths have passed their acceptance checks.

Do not enable publication using the old Shared Drive assumptions.

## 9. Acceptance criteria

### Authorization and security

- The Worker can obtain and refresh Google access tokens on behalf of the selected personal account without a service-account private key.
- The only requested Drive/Docs scope is `drive.file`; the app does not request whole-Drive access.
- Token refresh success, expiry, transient failure, invalid grant, and revoked-token behavior have automated tests.
- No tests, logs, setup responses, or diagnostics expose OAuth client secrets, refresh tokens, or access tokens.

### Setup and publication

- A My Drive folder with no `driveId` passes the folder-type check when the account has the needed capabilities.
- A folder/template not authorized through the owner selection flow fails setup with a clear operator action.
- Setup successfully creates, edits, renames, and deletes a disposable document copy under the selected account.
- A staging publication copies the template into the configured My Drive folder, preserves retry/idempotency behavior, and produces a document owned by the personal account.
- A collaborator account shared on the folder can access the generated document; no collaborator OAuth credential is required.
- Revoking the owner's OAuth grant causes the Google check and publication to fail closed with a clear reconnect instruction.

### Handoff documentation

- Deployment, publication setup, credential rotation, operations, and handoff instructions describe personal-account OAuth and folder sharing, with no requirement for Google Workspace or Shared Drives.
- The docs explain the single-owner continuity risk, consent-screen production requirement, refresh-token rotation, and how to recover from revoked authorization.

## 10. Affected artifacts

The implementation plan will identify exact edits, but the change is expected to touch:

- Google auth provider, publication wiring, Worker environment types, and setup validator/tests.
- Deployment, publication setup, credential rotation, operations, and handoff runbooks.
- Existing hardening/handoff plan steps that provision `GOOGLE_SERVICE_ACCOUNT_JSON` or require a Shared Drive.
- The approved system design's Google account ownership and cost assumptions.

This document does not authorize code changes. After the spec is approved, a separate implementation plan must be written and reviewed before implementation starts.
