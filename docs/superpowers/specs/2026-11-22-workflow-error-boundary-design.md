# Workflow error boundary design

## Intent and constraints

Preserve safe, actionable failure facts and retry policy across real Cloudflare Workflow step serialization for publication and the affected import paths. Preserve the original failure when feedback persistence fails; retain trusted event, group, attempt, target and workflow fencing, FIFO and receipt behavior. Existing jobs and legacy errors remain supported. Never expose raw provider responses or infer codes from arbitrary provider messages. No new dependencies or broad schema changes.

## Approaches

Custom Error properties or names alone are lost at the step boundary; a D1-only bridge can itself fail. Use a validated, locally generated safe failure envelope carried across the boundary, with durable image facts where already available. Non-retryable failures must use the runtime-recognized one-argument `NonRetryableError`, and retryable failures must remain retryable. Decode only our own exact envelope, with a conservative fallback for legacy errors. Map Claude SDK failures before crossing the boundary. Preserve structured image diagnostics using the existing D1 bridge and safe fallback.

## Feedback and recovery

Persist the original failure facts before cleanup when possible. Failures in identity lookup or primary outcome persistence must preserve the original error and allow recovery once trusted storage is available; never guess a destination. Provide one consistent Thai instruction that requires owner review before retry where writes or manual edits may be ambiguous. No notice can be guaranteed while D1 is wholly unavailable; recovery depends on durable facts and a later supported recovery trigger.

## Verification

Exercise production logic in the real local Workflow runtime, including retryable Claude and permanent Claude/Google attempts, image details, stored and delivered guidance, and identity/persistence faults where the runtime supports them. Compare focused and bounded full-suite results to baseline; typecheck, Node CLI and relevant acceptance tests. Review the complete diff and preserve unrelated files.
