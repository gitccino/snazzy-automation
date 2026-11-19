# Observed /docs provider failure — 2026-11-19

User authorized triggering and observing document generation to identify errors and fixes. Restarted the existing underlying publication Workflow for `rec9PHkzRunQ7820v`, preserving its original publication date and captured configuration. This was not a fabricated LINE event or a call to the admin HTTP endpoint. A guarded claim advanced notification cycle 2 to 3, retaining generation 1 and the prior immutable result.

The Workflow ran 17:34:50–17:35:06 Asia/Bangkok and ended Errored. No document-creation stage was reached; no temporary/final document or finalization intent was saved. The new unconfirmed terminal result was persisted as outbox sequence 2 and remained pending at inspection.

## Observed errors

- Live tail: `Anthropic request failed`, operation `create_message`, HTTP **400**, type `invalid_request_error`, request ID `req_011ChC8wwhWzhkGgX2tZUcm9`.
- Captured and current settings both selected **claude-opus-5-5**, with AI captions enabled, settings revision 9.
- The request builder in `src/publication/captions.ts` sends `tool_choice: {type:'tool',name:'submit_captions'}`. Anthropic's current tool-use documentation explicitly says Opus 5.5 rejects forced tool use with HTTP 400. This is a concrete request/API incompatibility consistent with the live error; the raw Anthropic response message was not retained.
- Failure cleanup then errored with `google_token_exchange_failed`. Current code discards Google's response body, so its exact rejection code and HTTP status were not recoverable from this run. Do not claim `invalid_grant` was observed in this attempt.
- Actual durable runtime logs fell back to generic original/recording codes despite local tests; Workflow step errors retained the named stage codes. Error diagnostics should account for the actual serialized shape.

## Recommended fixes (not implemented)

1. Use supported `tool_choice:auto` for Opus 5.5; retain strict tool schema, explicit prompt and existing draft validation. Avoid replacing it with `any`, which is also rejected on this model.
2. Log only bounded Google OAuth `error`/`error_subtype` and HTTP status, without tokens, credentials or raw response bodies. If the actual result is `invalid_grant`, reauthorize and replace the refresh token for the matching OAuth client. External Testing-mode consent with Drive scopes issues seven-day refresh tokens; verify the project's publishing status rather than assuming this is the current cause.
3. Record terminal job failure even if Google cleanup fails, preserving cleanup uncertainty separately; the current ordering leaves both stores Generating on cleanup error.

After observing the terminal failure, reconciled D1 and Airtable to **Failed**, retaining products/cache/document metadata and queued results. Added the evidence and cleanup limitation to Airtable Error Summary. Stopped the temporary log tail. No code, credential, model or deployment change was applied.

References:
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#forcing-tool-use
- https://developers.google.com/identity/protocols/oauth2#expiration
