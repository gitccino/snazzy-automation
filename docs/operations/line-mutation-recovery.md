# LINE sale/revert recovery

## What happens on the next command

For a product with an old `applying` operation, the Worker queries its original Cloudflare command Workflow. Queued, running, waiting, or paused executions retain ownership. Complete, errored, or terminated executions can be reconciled. A complete Workflow can contain an application result of failed.

After acquiring recovery ownership, the Worker reads all four sale fields from Airtable. Matching the intended tuple completes the old D1 action and approval without another PATCH. Matching the original tuple fails the abandoned operation and permits normal new-command confirmation. Other current values are preserved; the old operation is closed as conflicted and the new command is evaluated normally with a warning.

Do not restart an old Workflow while another Workflow is recovering or repairing that product. Failed confirmation tokens cannot reopen the old operation. Unknown/missing Workflow provenance produces an explicit diagnostic rather than an unsafe takeover.

## Evidence and follow-up

A PATCH attempt is saved as unknown before transmission. A 2xx response acknowledges it. Known rejection responses record rejected. A timeout, connection failure, ambiguous server error, or crash leaves unknown. Existing operations without attempt evidence are also uncertain.

Before releasing an uncertain old operation (including one reconciled as approved), the Worker durably registers a follow-up Workflow. It checks at 30 seconds, 1 minute, and 5 minutes from registration. New successfully committed sales/reverts also attempt an immediate check. Later scheduled checks continue after an early unchanged result.

A repair occurs only when Airtable exactly matches a monitored operation's intended tuple or an uncertain repair request's intended tuple, and a newer committed action exists. Each request captures the current action sequence before transmission. Repair restores that newer action's entire tuple, including its original actor and date. It records request evidence and an audit entry, without creating another sale/revert action. Pending/applying confirmations or mutations exclude repair. Unresolved monitoring sends one warning using a persisted LINE retry key. Registration keeps its Workflow ID in D1; recovery creates a fresh generation when the previous monitor has finished. An older generation cannot repair, end, or notify for its replacement.

## Read-only inspection

Use the relevant environment's D1 database. Replace the example token and Product ID with the affected values:

```sql
SELECT token, status, apply_event_id, workflow_id, mutation_actor,
       resolution_reason, resolution_action_seq, monitoring_state, monitor_workflow_id
FROM pending_line_commands WHERE product_id = 'A-16' ORDER BY rowid;

SELECT id, outcome, started_at, completed_at, response_category, intended_action_seq, intended_json
FROM line_mutation_attempts WHERE pending_token = 'example-token' ORDER BY rowid;

SELECT * FROM line_product_control WHERE product_id = 'A-16';

SELECT id, kind, commit_seq, before_json, after_json, actor, reverted_by_action_id
FROM line_actions WHERE product_id = 'A-16' ORDER BY commit_seq;
```

Look up `workflow_id` in Cloudflare Workflows. Product-control ownership may belong to the command or follow-up Workflow. Legacy context without an identifiable owner needs operator investigation; do not equate a missing instance with termination. Do not directly delete ownership rows as a routine unlock.

## Staging verification

After separately authorized migration/deployment, use controlled staging records and a controlled provider fixture. Trigger a sale, simulate a client timeout while retaining its server-side update, let a new confirmed sale complete, then release the old server-side update. Verify the follow-up restores the new tuple and D1 contains one action for each actually confirmed operation. Repeat with a newer confirmed revert, conflicting manual tuple, active confirmation, registration outage, and terminated recovery owner.

The automated tests run this flow locally with real D1 and a fake external provider. They do not constitute live LINE evidence. Never alter production tokens or induce production provider outages to exercise this feature.

## Limits and deployment order

Apply migration 0008 before publishing compatible Worker code. Preserve/export existing data before a remote migration and verify its outcome. Do not rewrite already applied migrations. Review code rollback compatibility with the new failed status and ownership tables.

These are bounded, best-effort checks: an update later than the checking window can be missed; wrong data can briefly appear. An exact staff edit to an old tuple is indistinguishable from a late system write. A concurrent Airtable UI edit between read and PATCH can also race with repair. Conflicting other tuples are preserved, but the integration cannot guarantee protection of all concurrent manual edits. A provider outage or unknown execution provenance can still prevent a command; recovery removes abandoned operation locks when the evidence is available, not every availability constraint.
