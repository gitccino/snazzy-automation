# Snazzy Automation System Design

**Date:** 2026-09-01  
**Status:** Approved design  
**Deployment model:** Dedicated customer-owned deployment  
**Primary stack:** TypeScript on Cloudflare

## 1. Executive summary

Snazzy Automation moves product photos from an iCloud Shared Album into Airtable, supports human product enrichment, generates publication-ready Google Docs, and manages inventory through LINE commands.

Recommended architecture:

- Cloudflare Workers for cron triggers, HTTP endpoints, and LINE webhooks
- Cloudflare Workflows for durable import and publication jobs
- Cloudflare D1 for checkpoints, idempotency, Product ID allocation, command state, and audit history
- Cloudflare R2 for permanent original and generated images
- Cloudflare Images for 4-in-1 image composition
- Airtable as customer-facing product and inventory workspace
- Google Docs as first publication output
- Claude API for three Thai caption drafts from verified Airtable fields
- LINE Messaging API for commands, confirmations, and operational logs

Main risk: Apple provides no supported server API for unattended iCloud Shared Album ingestion. Phase 0 must prove a replaceable, undocumented public-album connector from Cloudflare before the rest of the system depends on it. If this gate fails, only the image-source adapter changes.

Architecture diagrams:

- [System architecture](https://app.excalidraw.com/s/5PnxQlNdrPe/7u26XV3cNtx)
- [Upload to Airtable workflow](https://app.excalidraw.com/s/5PnxQlNdrPe/6Ez0wkDNEBF)

## 2. Goals

1. Import 100–500 newly uploaded photos per day from iCloud Shared Album.
2. Split ordered photos into products using explicit marker photos.
3. Create one complete Airtable Product row per product group.
4. Generate unique Product IDs using `A-<NUMBER>`.
5. Prevent duplicate images, Product IDs, Airtable rows, documents, and command execution.
6. Preserve successful product imports when another product group fails.
7. Let staff enrich product data and reorder images in Airtable.
8. Generate one Google Doc per publication date after all linked products are complete.
9. Generate one 4-in-1 image and three editable Thai captions per product.
10. Support LINE commands for search, sold-out handling, retry triggers, help, and safe revert.
11. Keep monthly infrastructure and AI spend under ฿1,000, excluding Airtable, Google Workspace, and LINE plan fees.
12. Make customer handoff reproducible through configuration, migrations, and a setup runbook.

## 3. Non-goals

- Multi-customer SaaS tenancy
- Native iOS or macOS application
- Always-on Mac bridge
- Human review of marker-based product grouping
- AI-based visual grouping in first release
- Automatic social-media publishing
- Custom admin dashboard
- Multiple publication destinations in first release
- Multiple Product IDs in one `/soldout` command
- Kubernetes, VPS management, Redis, Postgres, n8n, or Make

## 4. Confirmed operating assumptions

- iCloud Shared Album remains first image source.
- Staff bulk-uploads all shoot photos into iCloud.
- Staff photographs an explicit reusable marker before every product.
- Marker boundaries are trusted. Human marker mistakes are accepted operational risk.
- Each product normally contains 9–15 photos.
- Typical daily image volume is 100–500 photos.
- LINE OC handles roughly 22–24 products per day.
- Staff finishes iCloud upload at least 30 minutes before scheduled import.
- Scheduled time alone closes the upload window; no end-of-shoot marker or manual close step is required.
- First-ever import uses an admin-selected cutoff date.
- Later imports use saved photo checkpoints.
- Original photos remain in R2 indefinitely.
- Airtable paid plan and existing base are available.
- Google Docs is required initially but may be replaced later.
- Customer owns a dedicated deployment and all service accounts.
- All members of the allowlisted LINE admin group may run commands.

## 5. System boundaries

### Cloudflare owns automation state

Cloudflare holds everything required to run, retry, resume, audit, and revert work:

- scheduled and manual triggers
- iCloud polling state
- asset deduplication
- workflow states
- Product ID sequence
- publication idempotency
- pending LINE confirmations
- command before/after values
- immutable audit events

Airtable must not be used as the workflow engine or retry ledger.

### Airtable owns human product data

Airtable remains the staff workspace for:

- product enrichment
- inventory visibility
- image ordering
- publication date assignment
- readiness control
- generated-output links

### R2 owns master image files

R2 stores:

- imported product photos
- marker photos where needed for diagnosis
- generated 4-in-1 images
- failed-group source images

Airtable may hold attachment copies or references, but R2 remains the durable source.

### External integrations stay behind narrow adapters

- `ImageSource`: iCloud Shared Album first; replaceable later
- `InventoryWorkspace`: Airtable
- `PublicationExporter`: Google Docs first
- `CaptionGenerator`: Claude API
- `CommandChannel`: LINE Messaging API

These are code boundaries, not speculative plugin frameworks. Each has one implementation in first release.

## 6. Cloudflare components

### Worker API

Responsibilities:

- cron handlers
- `/upload` and `/docs` workflow triggers
- LINE webhook verification and routing
- signed R2 attachment URLs
- health and setup checks

### Workflows

Two durable workflows:

1. `ImportWorkflow`
2. `PublicationWorkflow`

Workflows provide step retries, persisted progress, and safe resume after Worker restarts.

### D1

Minimal tables:

- `sequences` — atomic next Product ID number
- `import_runs` — one row per album snapshot/import trigger
- `photo_assets` — Apple photo ID, content hash, R2 key, import state
- `product_groups` — ordered asset range, allocated Product ID, state, Airtable row ID, failure details
- `publication_jobs` — Airtable publication-run ID, Google document ID, state, validation result
- `line_commands` — pending/approved/rejected/expired command payloads and one-time tokens
- `audit_events` — append-only actor, action, before value, after value, timestamp, and correlation ID

Required indexes cover Apple photo ID, content hash, Product ID, Airtable row ID, publication date/run ID, LINE event ID, and command state.

### R2

Private bucket layout:

```text
imports/<import-run-id>/<apple-photo-id>/original.jpg
products/<product-id>/source/<sequence>.jpg
products/<product-id>/collage/1080x1080.jpg
failed/<import-run-id>/<group-id>/<sequence>.jpg
```

Exact file extension follows detected media type. Signed access URLs are short-lived and never logged.

### Images binding

4-in-1 output:

- 1080×1080 JPEG
- first four Airtable-ordered images
- 2×2 layout
- `contain` fit to prevent product cropping
- white padding and consistent gutters
- deterministic transformation parameters for caching and idempotency

## 7. iCloud feasibility gate

### Why a gate is required

Apple documents Shared Album access through PhotoKit on authorized Apple devices. No supported server REST API or webhook exists for a Cloudflare-only deployment. The proposed connector must imitate the public Shared Album webpage's undocumented metadata and asset requests.

### Phase 0 pass criteria

Before production implementation continues, a Cloudflare-based probe must prove:

1. Album metadata can be fetched consistently from target Cloudflare execution locations.
2. Photo identifiers and ordering remain stable across repeated polls.
3. New photos can be discovered from a saved checkpoint.
4. 100–500 photos can be streamed into R2 without loading the batch into Worker memory.
5. Marker images can be detected deterministically.
6. Repeated polls create zero duplicate R2 objects or D1 asset records.
7. Endpoint redirects, timeouts, and transient errors recover through retries.
8. Album token, derivative URLs, and signed R2 URLs never enter logs.
9. Public Shared Album quality is acceptable: photos are reduced by Apple to 2048 px on the long edge and may lose metadata.
10. Album rotation is operationally possible before Apple's 5,000-item Shared Album limit is reached.

### Gate result

- **Pass:** continue with iCloud adapter.
- **Fail:** replace only `ImageSource` with direct upload or supported cloud-folder ingestion. Keep D1, R2, Workflows, Airtable, Docs, and LINE design unchanged.

## 8. Import workflow

### Trigger and snapshot

1. Cron runs after the documented 30-minute upload cutoff.
2. `/upload` starts or resumes the same workflow manually.
3. Workflow reads latest D1 checkpoint.
4. Connector fetches one stable album snapshot.
5. Already recorded Apple photo IDs are skipped.
6. Content hashes provide second-layer duplicate protection.

### Download and grouping

1. Stream each unseen image directly to R2.
2. Record Apple ID, content hash, order, and R2 key in D1.
3. Detect explicit marker photos.
4. Discard marker images from Product image lists while retaining diagnostic copies where useful.
5. Build ordered product groups from each marker to the next marker.
6. No human review screen is created.

### Product creation

For each group:

1. Set state to `pending`, then `importing`.
2. Allocate next `A-<NUMBER>` atomically in D1.
3. Continue sequence from highest valid existing Airtable Product ID during initial setup.
4. Never reuse an allocated number, including failed imports.
5. Build complete Airtable payload before creating row.
6. Create Product row once.
7. Verify required system fields and image references.
8. Mark D1 group `succeeded` only after verification.

### Retry and rollback

- Retry transient failures up to five attempts with exponential backoff.
- Successful Product rows remain untouched when another group fails.
- On exhausted group failure:
  - delete any partial Airtable row;
  - mark D1 group `failed`;
  - preserve R2 originals;
  - preserve allocated Product ID as burned;
  - continue remaining groups;
  - report failed group position, source photo range, attempted Product ID, reason, and Airtable/import link to LINE.
- A later `/upload`:
  - skips `succeeded` groups;
  - retries `failed` groups with a fresh five-attempt cycle;
  - processes genuinely new groups.

### Checkpoint finalization

Checkpoint advances after every group in snapshot reaches terminal `succeeded` or `failed` state. Terminal failures remain explicitly retryable and cannot be mistaken for unseen photos.

## 9. Airtable model

### Products table

System-owned fields:

- `Product ID`
- `System Group ID`
- `Upload Date`
- `Product Images`
- `Inventory Status` — `In | Out`
- `Import Result` — `Imported | Failed`
- `4-in-1 Image`
- `Publication Run`
- `Sold Price`
- `Sold At`
- `Sold By`
- `Last System Update`

Human-owned fields:

- `Brand Name`
- `Model Name`
- `Condition Type`
- `Size`
- `Description`
- `LINE Square Price`
- `IG Price`

Computed fields:

- `Data Complete`
- `Missing Fields`

### Publication Runs table

One row per publication date:

- `Publication Date`
- `Status` — `Draft | Ready | Generating | Generated | Failed`
- linked `Products`
- `Google Doc URL`
- `Generated At`
- `Error Summary`

### Human workflow

1. Imported products appear with `Inventory Status = In`.
2. Staff fills human-owned fields.
3. Staff rearranges `Product Images`; first four drive collage.
4. Staff links Products to a Publication Run.
5. `Missing Fields` exposes incomplete data.
6. Staff changes Publication Run from `Draft` to `Ready` once complete.

## 10. Publication workflow

### Trigger and validation

1. Cron or `/docs` finds Publication Run with today's date and `Ready` status.
2. D1 acquires an idempotency lock.
3. Duplicate trigger exits without creating another document.
4. Workflow validates every linked Product before any document is created.
5. If any required field is missing:
   - create no Google Doc;
   - return run to `Draft` or mark `Failed` with validation details;
   - send LINE report grouped by Product ID and missing fields;
   - include Airtable link and instruction to run `/docs` after correction.

### Collage generation

For each valid Product:

1. Read first four ordered images.
2. Generate deterministic 1080×1080 2×2 collage.
3. Save output to R2.
4. Store/reference output in Airtable.

### Caption generation

- Claude API receives verified Airtable text only; no images.
- One structured request covers whole publication run where practical.
- Output schema returns exactly three Thai caption drafts keyed by Product ID.
- Every returned Product ID must match requested set.
- Invalid or missing output retries only affected product where possible.
- Captions remain editable drafts; no automatic social publication occurs.

### Google Docs template

Customer maintains one master template containing:

- branding and formatting
- document title structure
- fixed instructions
- editable global suffix
- placeholders such as `{{PUBLICATION_DATE}}` and `{{PRODUCTS}}`

System copies template for each publication date. Template edits affect future documents only.

Each Product section contains:

1. 4-in-1 collage
2. Product ID
3. condition
4. description
5. LINE Square and IG prices
6. three Thai caption drafts
7. template-controlled suffix

### Completion and retries

- Build temporary document first.
- Verify every expected Product ID exists in generated document.
- Rename/publish as final document only after verification.
- Store one Google Doc ID and URL per Publication Run.
- Never create second final document for same date.
- Retry failed steps up to five times.
- Reuse valid collages and captions.
- Delete incomplete temporary document after exhausted failure.
- `/docs` resumes failed run.

## 11. LINE command system

### Channel security

- One allowlisted LINE admin group initially.
- Every member in that group may run all commands.
- Worker validates LINE webhook signature.
- D1 deduplicates webhook event IDs and postback tokens.
- Commands from other groups are ignored and audited.

### Commands

#### `/help`

Returns supported commands and accepted examples.

#### `/search A-XXXX`

Returns:

- Inventory Status
- Upload Date
- Product ID
- Airtable row link where possible
- optional iCloud date link only if Phase 0 proves stable link construction

Unknown Product ID returns explicit Thai not-found message.

#### `/upload`

Starts/resumes ImportWorkflow. It skips successful groups, retries failed groups, and imports new groups.

#### `/docs`

Starts/resumes eligible PublicationWorkflow.

#### `/soldout`

Accepts exactly one Product ID and one required sold price.

Accepted Product ID forms:

```text
A-1234
รหัส 1234
รหัสสินค้า 1234
```

Rejected Product ID forms:

```text
A1234
A 1234
```

Accepted sold-price forms, case-insensitive:

```text
thb 1290
THB 1,290
ราคา 1290
ราคา 1,290 บาท
```

Price rules:

- whole baht only
- comma separators accepted
- optional trailing `บาท`
- normalized and stored as integer
- multiple or ambiguous prices rejected

Parser behavior:

- Multiple Product IDs are rejected.
- Missing Product ID or price returns incomplete-data error.
- Ambiguous Product ID or price returns explicit format guidance.
- Failed extraction never sends confirmation buttons.
- Product already `Out` is rejected without overwrite; response shows existing Sold Price, Sold At, and Airtable row link.

Confirmation flow:

1. Read Product and verify current state is `In`.
2. Store pending command in D1 with requester, group, Product ID, normalized price, old values, expiry, and one-time token.
3. Send Approve and Reject buttons showing Product ID and price.
4. Pending confirmation expires after 10 minutes.
5. Reject marks command cancelled and sends log.
6. Approve writes:
   - `Inventory Status = Out`
   - `Sold Price`
   - `Sold At`
   - `Sold By`
7. Confirmation mode can be disabled through configuration without code change.

#### `/revert`

- Targets latest successful reversible LINE command in same group.
- Never targets `/upload` or `/docs`.
- Shows exact Product ID and before/after values.
- Requires second confirmation.
- Reverts only if current Airtable values still match command's after-values.
- Refuses when newer changes would be overwritten.
- Restores inventory and sale fields from stored before-values.

## 12. Idempotency and consistency

### Import

Unique constraints and checks:

- Apple photo ID
- content hash
- System Group ID
- Product ID
- Airtable row ID

### Publication

Unique key: Airtable Publication Run ID. One final Google Doc ID per run.

### LINE

Unique keys:

- LINE webhook event ID
- pending-command token
- approved-command ID
- revert target command ID

### Airtable transaction limitation

Airtable does not provide cross-row transactions. System compensates through:

- complete payload construction before row creation
- verification after write
- stored before-values
- deletion/restoration on partial failure
- D1 state machine and audit log

## 13. Error handling and LINE logs

Every workflow and command receives a correlation ID.

LINE success messages include:

- date in Thai locale
- action name
- count
- Product IDs where useful
- output or Airtable link

LINE failure messages include:

- action name
- affected Product ID or failed group
- human-readable reason
- Airtable link
- safe retry command

No message includes secrets, public-album token, signed R2 URL, or raw stack trace.

## 14. Security

- Customer owns every account and credential.
- Secrets use Cloudflare secret storage.
- R2 bucket stays private.
- Airtable receives temporary signed URLs long enough for attachment ingestion.
- Google service account accesses only dedicated publication folder.
- LINE signatures are mandatory.
- Only allowlisted group ID is accepted.
- Public iCloud link is treated as sensitive but cannot provide real authentication.
- Logs redact tokens, signed URLs, images, and message content not needed for diagnosis.
- Audit events are append-only at application level.
- Credential rotation procedure is part of handoff.

## 15. Deployment and configuration

### Environments

- `staging`
- `production`

Each environment has separate D1 database, R2 namespace/prefix, cron configuration, LINE group/channel, Airtable base or test tables, and Google output folder.

### Secrets

```text
AIRTABLE_TOKEN
LINE_CHANNEL_SECRET
LINE_CHANNEL_ACCESS_TOKEN
GOOGLE_SERVICE_ACCOUNT_JSON
ANTHROPIC_API_KEY
ICLOUD_SHARED_ALBUM_TOKEN
```

### Non-secret configuration

```text
AIRTABLE_BASE_ID
AIRTABLE_PRODUCTS_TABLE_ID
AIRTABLE_PUBLICATION_RUNS_TABLE_ID
LINE_ALLOWED_GROUP_ID
GOOGLE_DRIVE_FOLDER_ID
GOOGLE_TEMPLATE_DOC_ID
TIME_ZONE=Asia/Bangkok
IMPORT_CRON
PUBLICATION_CRON
UPLOAD_CUTOFF_MINUTES=30
IMPORT_MAX_ATTEMPTS=5
PUBLICATION_MAX_ATTEMPTS=5
PRODUCT_ID_PREFIX=A
SOLDOUT_CONFIRMATION_ENABLED=true
FIRST_IMPORT_CUTOFF_DATE
```

Cloudflare bindings configure Worker, Workflows, D1, R2, and Images.

### Setup validation

A setup command must verify:

- D1 migrations applied
- R2 access
- Images binding
- Airtable base/table/field mappings
- highest existing Product ID
- LINE webhook signature and group ID
- Google template/folder permissions
- Claude API credential
- iCloud connector Phase 0 status
- cron timezone and cutoff

## 16. Monitoring

Initial monitoring uses:

- Cloudflare structured logs
- D1 workflow and audit tables
- LINE operational notifications
- Cloudflare usage alarms

Track:

- import duration and outcome
- photos discovered/downloaded/deduplicated
- products succeeded/failed
- Airtable API retries
- publication validation failures
- collage and caption failures
- Google Docs failures
- LINE command parsing and confirmation outcomes
- monthly R2, Images, Workflows, and Claude usage

No Sentry in first release. Add external error tracking only if Cloudflare logs and D1 run history prove insufficient.

## 17. Cost model

Expected at roughly 22–24 products/day:

- Workers Paid minimum: $5/month
- D1 and Workflows: expected inside included quotas
- Cloudflare Images: likely within 5,000 included transformations/month
- Claude Opus 5 captions: approximately $5–10/month depending caption length
- R2: 10 GB free, then $0.015/GB-month; indefinite storage likely reaches roughly $1–5/month by end of year one if average image is approximately 2 MB

Expected total: roughly $11–22/month, approximately ฿400–800 depending exchange rate, excluding Airtable, Google Workspace, and LINE plan fees.

Cost controls:

- deterministic image transformations
- no AI vision input
- one structured caption request per publication run where practical
- output token limits and schema validation
- usage alarms
- Batch API at 50% token pricing if caption spend approaches budget
- R2 storage reporting and later archive policy only if customer changes indefinite-retention requirement

## 18. Test strategy

### Phase 0 iCloud tests

- repeated metadata polling
- stable ordering
- checkpoint discovery
- 100–500 image download
- marker detection
- deduplication
- redirects, timeouts, and rate limits
- secret redaction

### Import acceptance

Ten varied real-sized batches covering:

- 100–500 photos
- 9–15 images per product
- first-run cutoff
- repeated `/upload`
- interrupted workflow
- one and multiple failed groups
- Airtable timeouts/rate limits
- per-group rollback
- Product ID uniqueness
- exact LINE reports

Pass condition: correct grouping, no duplicates, successful rows preserved, failed rows absent, failures retryable.

### Publication acceptance

- missing field blocks entire document
- first-four image ordering
- collage layout
- three captions per Product ID
- suffix changes
- Google API failure
- duplicate `/docs`
- one final document per date

### LINE acceptance

At least 30 representative customer messages covering:

- every accepted/rejected Product ID form
- every accepted price form
- missing/ambiguous price
- multiple IDs
- unknown Product ID
- already-Out Product
- Approve/Reject/expiry
- duplicate postback
- Airtable failure
- safe and blocked revert

Acceptance criterion covers both Product ID and price extraction.

### Handoff acceptance

Deploy into fresh customer-owned environment from runbook, then smoke-test import, publication, soldout, search, and revert. Rotate one credential to prove recovery instructions.

## 19. Delivery plan

### Phase 0 — iCloud feasibility spike, 2–4 days

Prove or reject Cloudflare-only connector. No production dependency before gate passes.

### Phase 1 — foundation and import, 1–2 weeks

- Cloudflare project and environments
- D1 schema
- R2 storage
- Product ID sequence
- ImportWorkflow
- marker grouping
- Airtable Product creation
- LINE import logs

### Phase 2 — Airtable and publication, 1–2 weeks

- Airtable field mapping
- Publication Runs
- completeness validation
- 4-in-1 generation
- Claude captions
- Google Docs template/export
- `/docs`

### Phase 3 — LINE inventory commands, 1 week

- OA/channel setup
- webhook validation
- `/help`
- `/search`
- one-product `/soldout` with required price
- confirmations
- `/revert`
- 30-message parser suite

### Phase 4 — hardening and handoff, 1–2 weeks

- failure injection
- ten-batch pilot
- cost alarms
- setup validator
- operations runbook
- customer-owned deployment rehearsal
- credential rotation test

Expected total for one experienced developer: 4–7 weeks. iCloud feasibility and customer credential setup are largest schedule risks.

## 20. Final decisions

- Cloudflare-native architecture approved.
- TypeScript approved.
- iCloud remains first source but must pass Phase 0 gate.
- No always-on Mac dependency.
- Explicit marker grouping; no human review.
- Scheduled snapshot with 30-minute upload cutoff.
- First import uses cutoff date; later imports use checkpoint.
- Per-group rollback; successful products remain.
- `/upload` retries failed groups and processes new groups.
- R2 stores originals indefinitely.
- Airtable uses Products and Publication Runs tables.
- Incomplete publication blocks whole Google Doc.
- One Google Doc per publication date.
- Claude uses verified text fields only and returns three Thai drafts.
- `/soldout` accepts one Product ID and required whole-baht price.
- Everyone in allowlisted LINE admin group may run commands.
- Already-Out Product is never overwritten.
- `/revert` affects latest confirmed reversible LINE command only.
- Dedicated customer-owned deployment approved.
- Infrastructure and AI target remains under ฿1,000/month.

## 21. References

- Apple Shared Albums: https://support.apple.com/en-mide/108314
- Apple PhotoKit cloud-shared assets: https://developer.apple.com/documentation/photos/phassetsourcetype/typecloudshared
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Workflows pricing: https://developers.cloudflare.com/workflows/reference/pricing/
- Cloudflare D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Cloudflare Images binding: https://developers.cloudflare.com/images/optimization/binding/
- Cloudflare Images overlays: https://developers.cloudflare.com/images/optimization/draw-overlays/
- Cloudflare Images pricing: https://developers.cloudflare.com/images/pricing/
- Claude API pricing: https://docs.anthropic.com/en/docs/about-claude/pricing
