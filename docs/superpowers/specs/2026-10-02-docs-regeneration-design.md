# Docs regeneration

## Approved user workflow

Keep one Publication Runs record per publication date. To correct a completed publication, the user edits its Products or product data, changes Generated to Ready, and sends `/docs` in the allowed LINE group. Ready is an explicit request to regenerate, even if the inputs have not changed. No additional confirmation is required.

Create a new Google Doc and preserve previous successful Docs. The original remains `Publication YYYY-MM-DD`; subsequent successful generations are named `Publication YYYY-MM-DD (v2)`, `(v3)`, etc. The Airtable Google Doc URL points to the latest successful version.

Only the LINE `/docs` trigger starts a new revision of a completed run. Cron continues to generate new publications and skips runs that already have a successful Doc, including those set back to Ready. Existing administrative triggers do not implicitly request regeneration.

The existing today-in-Bangkok selection rule remains. This feature does not add regeneration by date, another LINE command, or multiple Airtable runs for the same date.

## Approach

Extend the existing publication job with generation metadata and reuse the current pipeline, date ownership, input fingerprints, and retry behavior. Retain successful document references while a replacement is being generated.

Alternatives considered:

- Reopen the succeeded job and restart the original Workflow without generation identity. This is a small patch but makes durable-step recovery and temporary-document discovery ambiguous across revisions.
- Add a full revision-history subsystem. This provides richer history queries but is unnecessary for preserving old Docs and linking to the latest success.

Use generation metadata on the existing job, with a distinct Workflow identity and temporary-document discovery identity for each generation. No new Airtable fields or full revision-history table are required.

## State and compatibility

- Existing jobs represent generation 1 after migration; their Workflow ID and temporary-copy property remain compatible with the current implementation.
- Atomically transition a succeeded job to a new active generation only for LINE + Ready. Increment the generation once, clear the previous temporary-copy and validation state, reset attempt bookkeeping, and retain the date claim and last successful Doc references.
- Use a deterministic per-generation Workflow identity. Repeated commands and concurrent requests must converge on the same generation; only one request may allocate it.
- A failed generation is retried within the same version. It does not allocate another version until it has succeeded and the user requests another regeneration.
- A job with an active generation must not be reopened or allocated another generation, even if the Airtable status remains Ready temporarily.
- Workflow parameters and ownership checks must fence an old generation from modifying, finalizing, or cleaning up a newer one. Legacy generation-1 payloads remain supported.
- The publication-date uniqueness constraint remains owned by the same Airtable run across generations. A changed date on a previously successful run is rejected without losing its prior successful result.

## Generation and output

Read the latest Products and product data when the new generation validates. Those inputs are the snapshot for that generation; edits during Generating belong to a subsequent explicit request.

Reuse collage and caption caches only when their existing fingerprints match. Removed products do not appear in the replacement Doc. A fresh Doc is always created, including when all inputs are unchanged.

Temporary-copy discovery must distinguish generations. A new generation must never discover, refill, rename, or delete a previous successful Doc. Lost copy responses are recovered by the current generation's deterministic discovery identity.

Apply the formatting shipped in PR #7: revised Thai product text, filtered labelled description details, gapless collage, template content width, and a new page for each product.

## Publication and failure safety

Keep the previous successful Doc and Airtable URL throughout validation and generation. Change the Google Doc URL and Generated At only when the replacement has been filled and verified successfully. On success, mark the run Generated and persist the new successful result.

Google Drive, Airtable, and D1 cannot commit atomically. Finalization must therefore be idempotent and reconcile partial success. In particular, an uncertain Airtable update must not cause cleanup to delete a Doc that Airtable already references. A retry resumes finalization or reports an actionable failure rather than publishing a broken link.

Validation failure reports the missing fields and preserves the old Doc/link. Exhausted generation failure marks the current attempt Failed, preserves the old successful result, and removes only an unreferenced temporary Doc owned by that generation. Failure to send the LINE completion notification must not delete or downgrade a successful replacement.

Cron must not start or restart replacement work for a previously successful run. LINE `/docs` can retry the failed replacement without increasing its version.

## LINE behavior

- Generated: reply that the publication is already generated; do not create a Doc.
- Ready with previous success: start regeneration and reply with the version being generated.
- Active generation: reply that generation is already running.
- Failed replacement: retry the same version on an explicit `/docs` request.
- Duplicate publication dates: retain the explanatory reply added in PR #7.
- Completion: send the latest successful Doc link and current selected product IDs.

## Validation criteria

1. Existing first-generation behavior, old documents, and migration defaults remain compatible.
2. LINE + Ready regenerates a succeeded run; Generated and cron do not.
3. Concurrent requests allocate one generation and one Workflow.
4. Added/removed products and changed data appear in the new Doc; unchanged input caches remain reusable.
5. Successful generations produce the agreed versioned names and update the latest link; older Docs remain intact.
6. Failed generation/retry preserves the old link and reuses the same version.
7. Lost copy, fill, and finalization responses recover without duplicate or deleted published Docs.
8. An older Workflow cannot mutate or clean up a newer generation.
9. The same run retains its date claim; conflicting or changed dates cannot publish.
10. Run the applicable repository checks before deployment or PR merge. Review the new behavior in staging on an existing generated run after setting it to Ready.

## Delivery scope

Implement on `feat/docs-regeneration` as a separate PR from the merged layout changes. Preserve unrelated workspace changes. No deployment, remote D1 migration, or live regeneration is performed during the design stage.
