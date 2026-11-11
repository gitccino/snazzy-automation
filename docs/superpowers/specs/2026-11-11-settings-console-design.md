# Standalone settings website and D1 configuration

Status: approved by the owner on 2026-11-11. Implementation planning is authorized; execution and deployment are not part of the planning task.

## 1. Purpose

Give the owner and approved client users a practical website for finding and changing operational settings without reconstructing `APP_CONFIG_JSON`, using a terminal, or redeploying the automation Worker for ordinary edits. Keep one Airtable base. Preserve the working import, inventory, image-preparation, and document-generation behavior.

The motivating incidents were losing the full configuration record, difficulty toggling AI captions and retries, confusing cron fields with actual schedules, and needing replies to return to the LINE group that requested work.

## 2. Agreed scope

- Editable non-sensitive configuration moves into the existing environment's D1 database.
- API tokens, OAuth secrets/refresh tokens, album access credentials, signing secrets, and admin credentials remain in Cloudflare secrets. The website does not reveal or replace them in this phase.
- Validate changes before saving. Do not build settings change history or record the identity of the person editing settings.
- Accept commands from multiple configured LINE groups. Send direct replies, Flex cards, workflow results, and delayed recovery messages only to the originating group.
- Disable all cron triggers in this phase, including automatic imports, document generation, and budget alerts. Keep manual commands working.
- Keep scheduling outside the settings UI and outside editable D1 configuration. Future schedules belong together in code/deployment configuration.
- Use Airtable's dark interface as a familiarity reference: useful navigation, readable settings, restrained visual treatment, and comfortable spacing. Use English labels initially.
- Permit Airtable base/table ID edits even after inventory exists, with an explicit impact warning and confirmation before saving. This does not include inventory migration.
- Build a brand-new standalone settings website, with its own source app, URL, deployment, and Access policy. Do not integrate it into the existing admin interface.
- Approved client users access the new settings website only. The separate existing monitoring and re-import recovery website remains owner-only.
- Export configuration so the client can retain a usable backup.

## 3. Boundaries

Build a new standalone settings application, proposed location `apps/settings`, deployed independently from both the existing admin console and the automation Worker. It has its own navigation, URL, build/deploy configuration, and Cloudflare Access policy. It is a practical settings website, not a marketing site or a replacement for Airtable or LINE. Do not add Settings routes, navigation, or client permissions to the old admin website.

Proposed implementation direction: React with the project's familiar shadcn/Tailwind controls, a small Cloudflare-compatible frontend build, and a Worker serving the site and authenticated settings API. The builder may select the simplest compatible build arrangement; reuse of the old Next.js/vinext application shell or its routing is not a requirement. Reusing suitable component patterns does not mean integrating the two websites. Avoid unrelated dependency upgrades.

Initial rollout is staging. Production requires its own subsequent rollout, Access allowlist, D1 seed, and verification. This staging-first scope is a proposed implementation decision. The new settings deployment is separate; it must not replace the existing admin deployment.

Out of scope:

- Multiple active Airtable bases, base rotation, inventory copying, or migration between bases/tables.
- Staff permission roles, user management inside the app, and settings editor attribution/history.
- Credential editing, OAuth reconnection inside the app, or storing secrets in D1.
- Scheduling controls, scheduled notifications, and workflow start/retry/cancel buttons in the settings page.
- Arbitrary SQL, arbitrary JSON editing/import, a backup-restore UI, or resetting product sequences.
- Repairing historical failures, changing caption prompts, or redesigning the existing recovery actions.

Existing inventory/re-import audit records and their established safeguards remain intact. Omitting attribution for settings edits does not remove existing business-operation audit behavior.

## 4. Access and service boundary

Proposed implementation decision: use Cloudflare Access with an explicit approved-email allowlist and emailed one-time codes. Create a separate Access application/policy for the new settings website, proposed Worker name `snazzy-settings-staging`, allowing the owner and approved client addresses across that site and its settings API. Preserve the existing admin website's owner-only policy and routes without expanding its allowlist. Every permitted settings user has the same settings permissions in this phase; there is no application-managed staff/role system. Actual email addresses are deployment inputs, not document placeholders to invent.

Protect both the new settings pages and their API routes. Verify the Access identity using the supported Worker-level Access mechanism or validated Access JWTs; a browser-supplied identity header alone is insufficient. Keep alternate origins and preview URLs protected or disabled. Protect state-changing routes against cross-origin requests and do not allow caching of authenticated settings responses.

The public automation Worker's LINE webhook remains publicly reachable with its existing LINE signature verification. Do not apply the settings or existing admin Access policy to that webhook.

Proposed implementation decision: the new settings website's server calls a private settings entrypoint on the automation Worker through a Cloudflare service binding. The automation Worker owns provider validation, settings persistence, and access to its existing credentials. No Cloudflare management token or duplicate provider-secret set is placed in the new settings Worker or browser. The automation Worker uses the existing D1 database; the standalone site must not create a separate settings database or expose a D1 binding to browser code. Existing admin monitoring/re-import D1 access remains unchanged.

## 5. Settings ownership

Use one validated settings document per environment. Canonical field names retain the existing uppercase names where applicable; runtime code may map them to the existing camel-case interfaces. The multi-group replacement is `LINE_ALLOWED_GROUP_IDS`.

| Settings | Phase-one handling |
| --- | --- |
| `AIRTABLE_BASE_ID`, `AIRTABLE_PRODUCTS_TABLE_ID`, `AIRTABLE_PUBLICATION_RUNS_TABLE_ID` | Editable together under Connections, including after imports. One configured base; require the connection-change warning and acknowledgement below. |
| `GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_TEMPLATE_DOC_ID` | Editable under Connections; validate candidate folder/template access before saving. |
| `LINE_ALLOWED_GROUP_IDS` | Editable list with at least one valid group. Accept comma/newline-separated paste, trim surrounding whitespace, reject empty entries, and remove duplicates. Store a JSON array, not a comma-separated string. |
| `FIRST_IMPORT_CUTOFF_DATE` | Editable under Import. Display Bangkok date/time, store UTC ISO timestamp or explicit `null` for no cutoff. Explain that it filters every import, not just the first. Warn before changing photo eligibility. |
| `IMPORT_RETRY_LIMIT`, `PUBLICATION_RETRY_LIMIT` | Editable per flow: `0` means one attempt; `5` means six attempts total. Seed the currently effective values, which are zero in staging. No arbitrary retry algorithms or limits in this phase. |
| `AI_CAPTIONS_ENABLED` | Editable Documents switch; seed the current effective value, off. Enabling requires the existing Claude model/credential check to pass. |
| `SOLDOUT_CONFIRMATION_ENABLED` | Editable LINE switch; keep current confirmation behavior and group-bound tokens. |
| `CLAUDE_REQUEST_INPUT_TOKEN_LIMIT` | Editable Advanced value; positive integer, maximum 150000. Explain that it matters only when captions are enabled. |
| `MONTHLY_BUDGET_THB`, `USD_TO_THB_RATE` | Editable Advanced cost-estimate values; positive finite numbers. Budget is a reporting threshold; there are no scheduled alerts in this phase. |
| `CLAUDE_INPUT_PRICE_USD_PER_MTOK`, `CLAUDE_OUTPUT_PRICE_USD_PER_MTOK`, `R2_PRICE_USD_PER_GB_MONTH` | Editable Advanced estimated rates; finite nonnegative numbers. They do not change provider prices or enforce spending limits. |
| `TIME_ZONE` | Fixed/read-only `Asia/Bangkok`; arbitrary timezones are unsupported. |
| `PRODUCT_ID_PREFIX` | Fixed/read-only `A`; current parser and publication contracts assume this format. |
| `PRODUCT_ID_INITIAL_NUMBER` | Preserve the current value in D1, but read-only after sequence bootstrap. Editing settings must never reset or reduce the live sequence. Initial setup remains an operator procedure. |
| `CLAUDE_MODEL` | Fixed/read-only to the currently supported model, `claude-opus-5`. Arbitrary model selection requires separate compatibility work. |
| `PUBLIC_BASE_URL` | Deployment-owned, read-only connection information; not a freely editable client setting. Preserve the configured origin for signed image URLs. |
| `GOOGLE_OAUTH_CLIENT_ID` | Remains a deployment-owned non-secret Worker variable paired with the secret client credential. Show as read-only connection information if useful. |
| `UPLOAD_CUTOFF_MINUTES` | Legacy setup value with no operational filtering effect. Do not expose an ineffective control or store it as an editable setting; remove its requirement from the new runtime settings/setup contract. |
| `IMPORT_CRON`, `PUBLICATION_CRON` | Excluded from D1 settings and exports of editable settings. Remove their requirement from the new runtime parser; do not use empty strings as a scheduling switch. |

The iCloud album token/URL remains sensitive and stays in secret storage. `GOOGLE_PICKER_API_KEY` and `GOOGLE_CLOUD_PROJECT_NUMBER` remain local OAuth setup inputs; they are not runtime settings or browser-delivered credentials.

Confirmed behavior: Airtable base/table IDs remain editable after products/history exist. When any of these IDs changes, show the old and proposed connection and require explicit acknowledgement of the impact before saving. The server enforces acknowledgement for the submitted candidate and expected settings revision; bypassing the dialog must not bypass the acknowledgement requirement. Connection access/schema validation is still mandatory.

The warning must explain that existing Airtable rows are not copied or moved, historical record references are not rewritten, successful import groups are not automatically re-imported into the new target, and older inventory may no longer be reachable through normal commands after the switch. Already accepted work and saved candidate-document recovery keep their captured connection context. The user can proceed after acknowledging these effects; the presence of inventory/history alone must not block saving.

Saving the new connection must not delete rows, reset the product sequence, clear deduplication state, recreate imported products, or imply that inventory migration occurred. Keep one active configured connection; browsing/querying multiple historical bases remains outside scope.

## 6. Persistence, loading, and cutover

Proposed implementation decision: one `app_settings` row containing a schema version, validated `settings_json`, a monotonically increasing revision, and `updated_at`. Do not add `updated_by`, a settings audit table, or revision history. Revisions detect concurrent edits; they do not identify users or retain old values.

All new operational reads use a shared settings loader. Apply it consistently to webhook acceptance, command execution, upload/publication triggers and workflows, delayed mutation follow-ups, setup/bootstrap checks, health, and usage reports. Read once per acceptance/request; avoid a process-global mutable-settings cache in the first version. Include the settings revision in any affected health/validation cache key. After cutover, do not silently fall back to stale `APP_CONFIG_JSON` when D1 is missing, invalid, or unavailable; return a clear configuration-unavailable error.

Initialize D1 explicitly and idempotently from the actual running Worker's configuration and effective defaults/overrides. Read `APP_CONFIG_JSON` inside the automation Worker; do not ask the client to reconstruct it, and do not treat the local reconstructed JSON as a verified live backup. Convert `LINE_ALLOWED_GROUP_ID` into a one-element array. Preserve IDs, cutoff, effective caption setting, and effective retry limits. Initialization must not overwrite an existing settings row or reset business data.

Capture the existing `PUBLIC_BASE_URL` during initialization and explicitly preserve it as a non-secret deployment variable before the new loader is activated; do not guess it from a preview URL or keep reading legacy JSON for this one field. Fixed code-supported values and deployment information compose with the D1 settings into the validated runtime configuration.

After successful initialization/cutover, D1 is authoritative. Retain the legacy secret temporarily for rollback and old workflow versions, but new readers must not consult it. Remove the temporary `WORKFLOW_RETRY_LIMIT` deployment override from new configuration loading after seeding its effective value into D1; otherwise the UI's retry controls would have no effect. Update setup/configuration scripts and runbooks so regenerating legacy JSON does not overwrite or claim to update live D1 settings.

Each accepted command or operator-triggered job pins one validated non-secret settings snapshot and revision for its execution and descendants. A workflow step retry/replay uses the same snapshot. Explicit later manual attempts capture the then-current revision. Workers continue using server-side secrets; never snapshot credentials into workflow payloads or D1. Settings changes affect subsequently accepted work, not the routing, provider IDs, or behavior of already accepted jobs.

For a previously failed publication, a later attempt may adopt current settings only if it has no saved temporary document/finalization work to resume. If such work exists, finish/reconcile that work with its original connection context before changing target folder/template; do not silently duplicate or relocate an existing candidate. Existing generation and duplicate-prevention rules remain in force.

## 7. Editing, validation, and saving

The page starts from persisted values and revision. Editing is local until the user chooses Save changes. Switches do not save immediately.

Save one section atomically: the server loads the latest document, merges only the explicitly allowed section fields, validates the complete candidate, and conditionally updates the row using the submitted revision. Reject unknown/secret fields. A stale revision returns a conflict with a Reload action; never overwrite another user's work or untouched settings. Failed validation/provider checks leave the previous document unchanged and retain the user's draft for correction.

Use existing schema checks and provider clients where practical. Validate numeric limits, supported enums, timestamps, at least one group, and connection relationships. Connection changes require server-side read-only access/schema checks for the specific changed connection; changing a cost value must not fail because an unrelated provider is down. Return bounded, safe error codes/messages, not raw upstream responses or secrets.

Provide Test connection for Airtable, Google, and LINE. Test the candidate values, not just the currently saved ones. A successful test does not save changes; saving repeats necessary checks against that exact candidate. These checks do not create products, generate captions/documents, delete files, or run workflows. The existing operator `/setup` rehearsal may still create/clean up disposable probe resources, but it is not automatically run on every settings save. A readable template check does not claim to prove every possible later document edit operation.

Export configuration downloads a versioned JSON file containing environment, revision, export time, saved non-secret settings, and clearly marked read-only deployment information. It excludes all secrets and Access identity. Do not export unsaved drafts as though they were active configuration. Restoring an export remains an operator procedure in this phase.

## 8. LINE groups and originating-group delivery

Every allowed group operates on the same inventory with the same supported commands and permissions. This is not separate inventories or a role system. Verify LINE signatures before reading/accepting events and check group membership in the allowlist before durable command creation. Reject unauthorized groups without disclosing configuration or product data.

Persist the originating group ID with each accepted command and carry it through import/publication parameters, manual retry context, deferred replies, and mutation-recovery follow-ups. Do not derive a destination from the first allowed group or a global default. Never broadcast results to all allowed groups. Removing a group blocks new commands; work already accepted retains its original destination and snapshot.

Immediate replies, Flex cards, validation failures, successful results, error summaries, and delayed recovery/conflict messages return only to the originating group. A second group requesting an already-running shared import/publication receives its own busy/already-running response; it is not subscribed to the first group's completion notification. Confirmation/postback tokens remain bound to their original group, user, and product as required by the existing inventory flow.

A notification failure must not undo successful inventory/document work or cause it to execute again. Preserve recorded success and expose a safe notification failure through existing workflow logs, following existing completion semantics; a new notification dashboard is not required.

Existing authenticated operator HTTP triggers remain available. Proposed implementation decision: when they have no originating LINE group, return the HTTP/job result without unsolicited LINE delivery. Do not guess a group or add group-selection controls to the settings UI. There are no scheduled reports/alerts in this phase.

## 9. Manual-only operation

Remove all staging Cloudflare cron triggers using `env.staging.triggers.crons: []`; retaining or omitting a schedule field is not the disabling mechanism. Verify the remote trigger list after deployment and account for propagation. Deployment/source configuration must not silently restore them later.

Remove runtime dependence on `IMPORT_CRON`/`PUBLICATION_CRON` and keep any future cron-to-operation definitions together in code/deployment configuration. A future scheduling feature is separate work. The new scheduled handler must not perform import, publication, or budget-alert side effects in this manual-only phase, including during removal propagation.

Manual `/upload`, `/docs`, and other supported LINE commands continue working in allowed groups. Disabling cron does not disable durable recovery work needed to complete already accepted manual commands. Their established inventory safety rules are not scheduling settings.

## 10. UX and visual direction

Follow the client's latest Airtable-dark reference, superseding earlier light/mood-board directions for this settings surface. This is a working console with no hero, decorative charts, large promotional cards, or ornamental motion. Use familiar, consistent controls and settings navigation in the new site; do not inherit the old website's shell, pages, or visual direction.

Proposed design tokens: background `#181A1F`, section surface `#24272E`, border `#3B404A`, primary text `#F1F3F5`, secondary text `#B4BBC6`, and action/focus blue `#74B3FF`. Verify actual contrast on the finished controls rather than assuming the palette guarantees accessibility. Prefer a familiar system UI font; no new font dependency is necessary. Use approximately 14px body/input text, 12–13px supporting text, 18px section headings, and 24px page title.

Desktop: a compact 216–232px settings sidebar and a readable main column up to roughly 960px. Sections are Connections, LINE groups, Import, Documents, and Advanced. Use dividers and aligned field rows instead of nesting every setting in a card. At narrow widths, stack labels and controls, keep long IDs within the viewport, and keep Save/Discard reachable without horizontal scrolling.

Use an 8/16/24/32px spacing rhythm: about 8px within a field, 16px between related fields, and 24–32px between sections. Inputs/buttons have approximately 44px usable height; compact icons retain a comparable hit area. Destructive list removal has a text label/accessibility name rather than an unexplained tiny icon.

Search matches friendly labels, explanations, and technical names across settings sections. Show matching sections/fields and a useful no-results state. Labels lead with the user's task (for example, “Google Docs template”); technical keys remain available as supporting information. LINE groups use add/remove rows or tokens with multi-ID paste support, not an exposed raw JSON editor.

Each editable section has Save changes and Discard actions, an unsaved indicator, and persistent saved/error feedback. Discard restores that section's persisted values. Warn before navigation/reload would lose edits. Use visible labels, keyboard navigation and focus rings, field-level errors linked to the inputs, and an accessible save-status announcement. Connection-test feedback must distinguish Not tested, Checking, Passed, and Failed and must not imply unsaved values are active.

Confirmed initial UI copy is English. Keep existing Thai LINE customer/staff messages intact. Do not add a language-switching system in this phase. Review a representative settings screen against the agreed direction before implementing the full set of forms.

## 11. Rollout and source continuity

Reconcile automation source before implementation: the root checkout is older than staging's image-preparation code. Start the backend work from the shipped staging baseline plus the documented caption-off/single-attempt changes; do not deploy the older root directly or erase unrelated working changes. Build the new settings site separately. Do not merge, redeploy, or modify the existing admin app as part of this feature. Current release provenance is in `docs/runbooks/operations.md` and `docs/releases/2026-11-11-single-attempt-staging.patch`.

Additive D1 changes must preserve sequences, imported-photo metadata, product groups, publication generations/candidates, image caches, mutation records, and existing audit history. Establish the settings row before new code serves requests. Use a bounded cutover window with no running import/publication/mutation workflows, or an explicitly verified compatibility path; do not let old and new configuration authorities write inconsistent results.

Verify Access on the new settings website's real URL and API, initialize from the live configuration, deploy new loaders/routing, remove effective override/cron triggers, and verify manual flows. Separately confirm that the old admin URL, its owner-only access, and its monitoring/re-import behavior are unchanged. Do not rotate provider credentials as part of this migration. Keep a pre-cutover operator backup and document rollback: retain D1 settings, export saved non-secret values, deliberately restore a matching legacy configuration/code pair if necessary, and keep cron triggers disabled during rollback. No automatic destructive rollback of inventory or settings.

## 12. Acceptance evidence

Required behavior checks:

1. An allowed settings email can read/save settings; a signed-out/unapproved user cannot reach pages or settings API, including alternate/preview URLs. Access to the new settings website does not grant access to the old admin website or its owner-only monitoring/recovery APIs. Verify the sites use distinct deployments and policies, and the old site remains unchanged. The LINE webhook still accepts valid signed requests.
2. D1 initialization copies live non-secret values exactly once, preserves effective captions off/retries zero, converts the singular group setting, and never copies credentials. A second initialization cannot overwrite settings.
3. Save validates the full candidate, rejects secret/unknown fields, handles revision conflicts, preserves untouched fields, and retains the old values after validation/provider failure. Normal edits do not depend on unrelated providers.
4. Export matches the saved revision and contains no secrets/editor identity. Browser network responses/bundles contain no provider credentials or Cloudflare management tokens. The new site has its own build entrypoint, deployment, and URL, with no settings integration into the old admin interface.
5. Saving a setting changes the next accepted command/job without redeployment. In-flight/replayed work retains its snapshot, destination, and candidate-document consistency. Missing/invalid settings fail clearly instead of falling back to legacy JSON.
6. Two allowed groups can use commands. Each receives only its own replies/Flex cards/completion and recovery messages; an unauthorized group receives no inventory data. Cross-group postback reuse fails. A second group does not receive the first group's delayed result.
7. No active cron triggers remain, no scheduled handler produces side effects, blank cron values are not required, and manual commands still run. Cron changes are reflected in deployment configuration.
8. A new manual import and publication use one attempt per configured durable step, with captions disabled by the seeded settings. Existing sequence/deduplication/image preparation/publication generation behavior is preserved. Controlled provider failures demonstrate clear outcomes without redoing successful work.
9. Airtable base/table IDs can be changed despite existing inventory only after the candidate passes validation and the user explicitly acknowledges the warning. A direct save without acknowledgement is rejected; a stale revision requires a fresh review. Confirm that changing the connection does not copy/delete products, reset the sequence, or clear successful import/deduplication state.
10. Airtable/Google/LINE candidate connection checks are read-only. Google reauthorization remains an operator procedure; no settings save creates a document or sends a test message unexpectedly.
11. Keyboard, narrow-screen layout, contrast, long IDs, search, validation errors, unsaved changes, and Save/Discard are practically verified on synthetic data. A staging end-to-end run verifies the actual new configuration path separately from UI mocks.

The existing full-suite baseline has unrelated failures documented in the operations runbook. Report those explicitly, demonstrate any remaining failures also occur before this feature, and do not describe a partially passing suite as fully green.

## 13. Confirmed choices and approved implementation direction

- Confirmed: English labels initially; no bilingual system in this phase.
- Confirmed: allow Airtable base/table ID changes after imports with a warning and explicit acknowledgement; do not implement inventory migration. This supersedes the earlier proposed lock.
- Confirmed: build a new standalone settings website rather than extending the current admin interface.
- Confirmed: clients access the new settings website; existing monitoring and re-import recovery remain on the separate owner-only admin website. This resolves the builder review's material permission question.
- The owner approved the complete specification, including the documented technical direction: singleton document with revision, private settings service binding, staging-first rollout, Access email-code login, read-only deployment information, and HTTP-trigger no-push behavior. The implementation plan makes the remaining implementation-level choices explicit.

An earlier draft received a read-only builder review. Its material question was the client/recovery permission boundary, now resolved through the owner's decision to keep a standalone settings website separate from the owner-only admin website. The standalone-site revision was self-reviewed for consistent access, deployment, rollout, and acceptance boundaries; the earlier review must not be represented as a review of this revised architecture. No implementation, deployment, or live setting changes are part of this specification task.

## 14. References

- `docs/superpowers/specs/2026-09-29-staging-admin-web-app-design.md` — existing admin/re-import boundaries, retained unchanged. This spec describes a different website.
- `PRODUCT.md` — prior admin-console context. Do not overwrite that product contract with the new site's purpose; document the standalone settings product separately after approval.
- `src/config.ts`, `src/env.ts`, `scripts/worker-app-config.ts` — current configuration/secret contracts.
- `src/routes/line.ts`, `src/line/webhook.ts`, `src/line/mutation-followup-workflow.ts` — current single-group acceptance and delayed delivery.
- `src/import/workflow.ts`, `src/publication/workflow.ts`, `src/publication/trigger.ts`, `src/routes/setup.ts`, `src/routes/health.ts`, `src/routes/usage.ts`, `src/scheduled.ts` — configuration consumers to migrate.
- Existing admin source: `.worktrees/staging-admin-web-app/apps/admin/` — reference only. Do not integrate the new settings website into it or treat that worktree path as the new app location.
- [Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [email-code login](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
