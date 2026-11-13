# Standalone settings console

## Local development

Run `npm --prefix apps/settings ci`, then `npm --prefix apps/settings run dev` from the feature worktree. Open the URL printed by Vite. The local server uses disposable synthetic settings, not D1 or staging credentials. Restart it to reset changes. Provider tests are unavailable locally by design. Export downloads only the saved sample revision.

## Ownership

D1 holds one non-secret settings document with optimistic revision checks. Provider/API tokens, Google refresh/client secrets, LINE signing secrets, iCloud credentials and admin tokens remain Cloudflare secrets. The new site has its own deployment and Access policy; approved clients must not be added to the owner-only old console policy. The public LINE webhook continues using LINE signature verification.

There are five editable sections. Initial product number is preserved but read-only. Timezone Asia/Bangkok, prefix A and supported Claude model are fixed. Public asset origin and OAuth client ID are deployment inputs. Scheduling is not editable. Staging cron triggers are empty and delivered scheduled events do nothing. Production cron configuration is unchanged by this branch.

Export before changing connections. Changing Airtable IDs does not migrate inventory, rewrite references, reset sequences or re-import successful groups. The UI and server require acknowledgement and read-only connection validation. Old accepted operations retain their original context. A provider check does not create a document or send a LINE message. Google reconnection remains an owner procedure.

## Rollout procedure

The implementation plan required separate rollout authorization, which the owner provided for staging on 2026-11-12. Before rollout, retain the exact deployed version/source, inspect newer changes, back up staging D1 and export the existing non-secret configuration. Never deploy the older root checkout. This branch derives from 98c79fd plus the documented single-attempt release patch.

1. Build and test both packages; inspect both Wrangler dry runs. Confirm old admin source and policy have not changed.
2. Deploy additive migrations 0010 and 0011 on the existing database only. Before the first cutover the staging configuration defaulted to maintenance. It now records the completed D1 cutover. Use an explicit maintenance override when repeating a migration. Deploy the bridge with an explicit CONFIGURATION_MODE=legacy override and cron side effects disabled. Preserve the **actual effective WORKFLOW_RETRY_LIMIT=0** as a temporary deployment override for this bridge; the final checked-in configuration removes that override. Keep the settings site unexposed.
3. Call bearer-protected `POST /setup/settings-bootstrap` on the running Worker. It reads its actual APP_CONFIG_JSON and effective retry override, inserts once, and returns revision/schema metadata and, on first initialization, the safe non-secret PUBLIC_BASE_URL copied from the live configuration. Retain that response for cutover. It does not replace an existing row. Validate saved caption/retry/group/ID values through an owner-controlled D1 read without printing secrets. Do not seed from a reconstructed local JSON.
4. Use the original public asset origin returned by the authenticated first bootstrap response and set PUBLIC_BASE_URL to that exact non-secret value. Set ENVIRONMENT=staging. Do not guess from a preview URL.
5. Enter CONFIGURATION_MODE=maintenance. Verify active import/publication/LINE/follow-up workflows are drained, plus pending/applying confirmations and saved temp/finalization documents. Resolve legacy null-context work using its matching old runtime before deploying the bridge; do not delete records to pass this gate. New signed LINE and authorized manual HTTP admissions receive retryable 503; accepted work may drain.
6. Switch CONFIGURATION_MODE=d1 and remove WORKFLOW_RETRY_LIMIT. D1 mode ignores stale legacy JSON and retry overrides. Missing or invalid D1 settings fail closed. Keep the legacy secret for rollback. Confirm health/setup, sequence state, zero cron triggers and no admission loss.
7. Deploy snazzy-settings-staging while unexposed. Configure its separate approved-email Access policy using actual owner/client addresses, actual team hostname, audience and exact site origin. Set ACCESS_TEAM_DOMAIN, ACCESS_AUD, SETTINGS_ORIGIN. For staging without a purchased domain, use the separately Access-protected snazzy-settings-staging.clicky-worker.workers.dev hostname. Keep preview URLs disabled. The Worker also verifies Access JWTs and the exact configured origin. No provider secrets or D1 binding belong on this Worker.
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

### Staging rollout preparation — 2026-11-12

Owner authorized staging deployment. Cloudflare account 6843daf936a95db0bb6eae5da844b632. Existing automation version: 7d7c996d-0a32-45ff-a69b-7c91aa0737ff; legacy retry override 0. Live source, binding metadata, schedules and D1 SQL export retained privately under the T3 userdata staging-backups/settings-2026-11-12 directory. No secret values are included here.

Separate Access app 21ea1efa-3b78-4279-bfb3-a42b9d3b715d protects snazzy-settings-staging.clicky-worker.workers.dev, audience afb03a63baf3d48818f3dde1711f5b6f1fe8d6b96c8663462434cb14e53d0d6f, organization yoppa.cloudflareaccess.com. Reusable policy 1cb7bdb1-09b4-4647-a38d-17a3a15a5922 allows only supitchaklanpradit@outlook.com and gitccino@gmail.com via existing one-time PIN identity provider. Existing Access applications were compared and unchanged.

D1 preflight: no active imports, publications or confirmations; no recovery locks or unresolved temporary/finalization documents. Product sequence next value 12658. Four workflow running-instance checks returned none. Recheck active/queued/paused instances after entering maintenance before cutover.

Validation: root typecheck passed; full suite 917 passed, 28 failed in the same five baseline files. Website 13 tests passed, typecheck/build and both deploy dry runs passed. Fixed frontend connection-test URL/payload to match the live API, and local preview no longer falsely reports provider checks passed.

The missing staging admin credential was subsequently supplied through private input after the owner rotated it. The rollout below supersedes that earlier blocker.

### Staging deployed — 2026-11-12

- Owner rotated ADMIN_ROUTE_TOKEN; deployed source comparison confirmed unchanged code. Owner console has only ASSETS and DB bindings, so it does not require that token update. CLI scripts using the token require the new value in their environment.
- Applied migrations 0010 and 0011 to the existing staging D1. Deployed legacy bridge e072eb92-771e-4abd-8474-05ae6354f438 with retries=0; authenticated bootstrap initialized revision 1 from actual live config and returned the original asset origin.
- Maintenance version 39f48128-f61e-4834-8d50-206772c37f81 returned 503 for authenticated new document admissions. All four workflows had zero running, queued and paused instances. D1 outstanding jobs, confirmations, recovery locks and unresolved temp/finalization intents totaled zero.
- Final automation version cad356b9-bdf7-4ef3-bb59-4dc95f3589d8 runs CONFIGURATION_MODE=d1 with the actual PUBLIC_BASE_URL. Removed the legacy WORKFLOW_RETRY_LIMIT override. Legacy APP_CONFIG_JSON retained for rollback. Product sequence remains 12658; captions off and both retry limits 0. Cron list empty. Production unchanged.
- Settings version 65ca6902-b0a5-4dcd-97d5-5c7006a3ba2b deployed to https://snazzy-settings-staging.clicky-worker.workers.dev with private SettingsService binding, Access JWT validation and exact origin validation. Preview URLs disabled. Existing owner Access applications compared unchanged.
- Signed-out page, settings API and export redirect to yoppa.cloudflareaccess.com. /health returned 200; authenticated /setup returned 200 with all checks passing: D1, R2, signed assets, Images, Airtable schema, sequence, LINE group access, Google template rehearsal, iCloud and timezone. Caption credential intentionally skipped while captions are off. An initial urllib probe received 403; independent curl probes consistently returned the expected Access login redirects.
- Remaining evidence: approved/unapproved email login, signed-in save/export and revision conflict through the deployed UI, two-group routing, controlled upload/docs workflows. These have not been exercised during rollout; no LINE messages or inventory operations were triggered. User must complete email-code sign-in for authenticated UI verification. Direct D1 record and deployment-mode checks are not a substitute for a UI save.

## Change the next product number

Open Import > Product numbering. This reads the live D1 product sequence; PRODUCT_ID_INITIAL_NUMBER remains historical and read-only, and the prefix remains A. Enter a positive safe integer at least as large as the current counter, then choose Save next number. This saves only the counter, separately from import configuration.

The server checks the saved active Airtable products table for any A- product number greater than or equal to the proposed number. If found, it rejects the save. Provider failures reject the save. A single D1 conditional update requires the counter and settings revision to remain unchanged during that check; an import allocation, competing counter edit or saved connection change causes a reload conflict. Numbers can only advance. Existing IDs are never rewritten; skipped numbers cannot be reclaimed here. No schema migration is needed.

Airtable manual edits are external to D1: another person inserting a conflicting ID after the provider check cannot be locked by this save. Do not manually assign IDs concurrently with automation. This control prevents backward sequence changes and checks Airtable at save time; it does not establish a cross-provider transaction.

### Next number feature deployed — 2026-11-12

Automation version 37db5f37-3356-4048-89c6-615fc745c98e; settings version c077ab15-cde0-4b95-b24d-5d7fc5826de7. No D1 migration required. Live counter remained 12658 before and after deployment. Health returned 200, signed-out Settings returns Access login redirect. Validation: 26 targeted backend tests, 17 website tests, both typechecks, build and deploy dry runs pass. Tests cover Airtable equality collision, backward/invalid input, provider failure, concurrent allocator/config changes and competing updates. No live counter save was performed, so authenticated deployed UI save still requires owner verification.

### Caption enablement diagnostic — 2026-11-12

Settings enablement was rejected by the provider validation gate. A bearer-protected, read-only GET /setup?check=caption-access probe was added and tested (three tests; root typecheck passed), deployed as automation version 7fde442b-3c24-44e0-b502-e20d124a482d. It performs only the Models API lookup with zero retries and returns safe status/category/model metadata; it does not return provider response text, credentials or generate captions.

Live probe returned Anthropic HTTP 401, category authentication, for claude-opus-5. This establishes that the deployed Anthropic credential is rejected; it does not establish whether the key was mistyped, revoked or otherwise invalid. D1 captions remain disabled because validation fails before save. Owner must provide a valid staging ANTHROPIC_API_KEY before retrying. No Google/LINE/admin/asset signing credential changes are required by this result. No provider key was replaced during diagnosis.
