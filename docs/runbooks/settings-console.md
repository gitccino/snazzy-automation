# Standalone settings console

## Local development

Run `npm --prefix apps/settings ci`, then `npm --prefix apps/settings run dev` from the feature worktree. Open the URL printed by Vite. The local server uses disposable synthetic settings, not D1 or staging credentials. Restart it to reset changes. Provider tests are unavailable locally by design. Export downloads only the saved sample revision.

## Ownership

D1 holds one non-secret settings document with optimistic revision checks. Provider/API tokens, Google refresh/client secrets, LINE signing secrets, iCloud credentials and admin tokens remain Cloudflare secrets. The new site has its own deployment and Access policy; approved clients must not be added to the owner-only old console policy. The public LINE webhook continues using LINE signature verification.

There are five editable sections. Initial product number is preserved but read-only. Timezone Asia/Bangkok, prefix A and supported Claude model are fixed. Public asset origin and OAuth client ID are deployment inputs. Scheduling is not editable. Staging cron triggers are empty and delivered scheduled events do nothing. Production cron configuration is unchanged by this branch.

Export before changing connections. Changing Airtable IDs does not migrate inventory, rewrite references, reset sequences or re-import successful groups. The UI and server require acknowledgement and read-only connection validation. Old accepted operations retain their original context. A provider check does not create a document or send a LINE message. Google reconnection remains an owner procedure.

## Rollout gate — not performed

No remote rollout is authorized by the implementation plan. Before approval, retain the exact deployed version/source, inspect newer changes, back up staging D1 and export the existing non-secret configuration. Never deploy the older root checkout. This branch derives from 98c79fd plus the documented single-attempt release patch.

1. Build and test both packages; inspect both Wrangler dry runs. Confirm old admin source and policy have not changed.
2. Deploy additive migrations 0010 and 0011 on the existing database only. The checked-in staging configuration defaults to maintenance so an accidental deploy cannot admit work before the cutover. Deploy the bridge with an explicit CONFIGURATION_MODE=legacy override and cron side effects disabled. Preserve the **actual effective WORKFLOW_RETRY_LIMIT=0** as a temporary deployment override for this bridge; the final checked-in configuration removes that override. Keep the settings site unexposed.
3. Call bearer-protected `POST /setup/settings-bootstrap` on the running Worker. It reads its actual APP_CONFIG_JSON and effective retry override, inserts once, and returns revision/schema metadata and, on first initialization, the safe non-secret PUBLIC_BASE_URL copied from the live configuration. Retain that response for cutover. It does not replace an existing row. Validate saved caption/retry/group/ID values through an owner-controlled D1 read without printing secrets. Do not seed from a reconstructed local JSON.
4. Use the original public asset origin returned by the authenticated first bootstrap response and set PUBLIC_BASE_URL to that exact non-secret value. Set ENVIRONMENT=staging. Do not guess from a preview URL.
5. Enter CONFIGURATION_MODE=maintenance. Verify active import/publication/LINE/follow-up workflows are drained, plus pending/applying confirmations and saved temp/finalization documents. Resolve legacy null-context work using its matching old runtime before deploying the bridge; do not delete records to pass this gate. New signed LINE and authorized manual HTTP admissions receive retryable 503; accepted work may drain.
6. Switch CONFIGURATION_MODE=d1 and remove WORKFLOW_RETRY_LIMIT. D1 mode ignores stale legacy JSON and retry overrides. Missing or invalid D1 settings fail closed. Keep the legacy secret for rollback. Confirm health/setup, sequence state, zero cron triggers and no admission loss.
7. Deploy snazzy-settings-staging while unexposed. Configure its separate approved-email Access policy using actual owner/client addresses, actual team hostname, audience and exact site origin. Set ACCESS_TEAM_DOMAIN, ACCESS_AUD, SETTINGS_ORIGIN. Keep workers.dev/preview URLs disabled; attach only the intended protected domain. No provider secrets or D1 binding belong on this Worker.
8. Verify signed-out/unapproved/approved page and API access; verify the settings audience cannot unlock the old owner console. Test a controlled save/export, two allowed groups, an unauthorized group, originating-group completion, one controlled import and publication, captions off and one attempt. Third-party group messages require explicit owner authorization.

Do not rotate credentials, reset inventory/sequence/deduplication tables, create a new database or deploy the old admin site during this rollout. Record deployment IDs and actual live evidence here after approval.

## Turning AI captions on later

Export saved configuration. In Documents, enable AI auto-captioning and Save changes. The server checks the supported model and existing Anthropic credential before committing. The next accepted publication uses the new setting; already accepted work keeps its snapshot. Disable and Save to turn it off. Token limit and estimated rates are in Advanced. After D1 cutover, replacing APP_CONFIG_JSON does not edit these settings.

## Rollback

Pause new admissions. Retain D1 and its saved settings/export. Restore matching previously deployed legacy code and actual legacy configuration/overrides from the backup, preserving public origin and credentials. Keep cron triggers disabled; do not restore schedules with an old configuration. Never roll back by resetting D1 or deleting pending business work. Verify manual operations and the old owner console before reopening admissions.

## Verification record

Pre-feature baseline: typecheck passed; full root suite had 28 known failures in five files. Compare test names, not just counts. Local component/provider/RPC tests are not evidence of a live D1 save. Remote Access, cutover and real provider/group checks remain rollout gates.

### Local implementation evidence — 2026-11-11

- Root typecheck passes. Last full suite: 916 passed, 28 failed in the same five baseline files; sorted failing test names match the captured pre-feature baseline exactly. A subsequently added original-connection recovery test passes in its 24-test focused file; bootstrap plus settings acceptance tests pass (5/5).
- Independent website: 8 tests pass; typecheck and Vite production build pass. Tests exercise signed JWT verification with real ephemeral RSA keys, API request boundaries, drafts, conflicts, warnings, search and date/group parsing.
- Both automation staging and settings Worker deploy dry runs pass. No remote deploy, migration or provider-secret change was performed.
- Local Vite HTTP checks serve the page and frontend module, load sample settings, save a section to revision 2, and export that saved revision with captions disabled. These are disposable samples, not a real D1/provider verification.
- Final review was performed by the author; no subagent was used per the owner's instruction. Fixed a stale-generation context comparison and context-persistence failure leaving an import marked running; both were reproduced with failing regression tests before the fixes.
- Browser visual/keyboard QA, actual live deployment/version reconciliation, live Access policies and real provider/group evidence remain rollout gates. The implementation is not a claim that those external checks have happened.
- Rollout decision: source defaults staging to maintenance to prevent admitting work before bootstrap/cutover. An explicitly reviewed legacy bridge override preserves effective retries=0 during seeding; explicit D1 mode then uses saved settings. This adds a deliberate deployment input rather than guessing live configuration.
