# Publication run reconciliation — 2026-11-19

User authorized reconciliation of staging run `rec9PHkzRunQ7820v` after `/docs` incorrectly reported it as running.

Verified the original `publication-rec9PHkzRunQ7820v` Workflow was Errored, ending at 14:34:18 Asia/Bangkok. Its output-preparation step failed with `anthropic_create_message_failed`; failure recording then failed with `google_token_exchange_failed`. The trace never reached document creation. D1 had generation 1, notification cycle 1, successful generation 0, and no saved temporary/final document or finalization intent. Airtable still showed Generating with no document URL.

Backed up the affected D1 job and Airtable record privately under ignored `.wrangler/publication-rec9PHkzRunQ7820v-check/`. Applied a guarded D1 update matching the original timestamp, generation/cycle and absent document fields; it changed only the job state to failed and its update timestamp. Updated Airtable Status to Failed and retained both error codes plus the unverified-cleanup limitation in Error Summary.

Read-back verified both stores now indicate failure. Generation, notification cycle and document metadata are preserved. The original Workflow remains terminal with its original end time. No workflow was restarted, no product/cache was edited, no document was deleted, and no historical notification was queued.

This clears this run's stale running status. It does not change the `/docs` status-check algorithm or establish that the Claude/Google errors are now resolved. Google document discovery/cleanup and current provider credentials were not retested. Retrying generation remains a separate user action.
