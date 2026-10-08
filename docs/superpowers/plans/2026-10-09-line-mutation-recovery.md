# Unfinished LINE Mutation Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover abandoned sale/revert ownership on the next LINE command and correct recognizable late Airtable writes without replaying an old price or indefinitely blocking new commands.

**Architecture:** Persist PATCH attempt evidence before network access. Coordinate recovery and repair through one per-product D1 ownership record, consult Cloudflare status, and reuse existing before/after comparisons and atomic action finalization. A separate durable follow-up Workflow provides the approved bounded checking window; it never counts an unapproved message as a committed sale.

**Tech Stack:** TypeScript, Cloudflare Workers/Workflows, D1 SQLite, Airtable REST API, existing Vitest Cloudflare plugin. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-09-line-mutation-recovery-design.md` (approved by the user on 2026-10-09).

## Global Constraints

- Preserve the initial command attempt and two retries: 30 seconds, then 1 minute.
- Only terminal Cloudflare execution states (`complete`, `errored`, `terminated`) allow recovery; application failure may have Cloudflare status `complete`.
- Compare Inventory Status, Sold Price, Sold At, and Sold By exactly; available means `In`.
- Preserve the original actor, price, snapshots, audit, sale date, and revert linkage when completing an old operation.
- New command means normal validation and confirmation; latest means latest successfully confirmed operation.
- Persist unknown PATCH attempt evidence before sending; never infer rejection from a timeout or ambiguous 5xx.
- Follow-up checks occur at 30 seconds, 1 minute, and 5 minutes after replacement, plus an immediate check after a newer committed mutation.
- Do not overwrite arbitrary conflicting tuples or a product with an active normal confirmation/mutation.
- Never introduce a new permanent recovery lock or silently allow missing execution provenance.
- Implementation does not include deployment, production fault injection, a new LINE command, or unrelated refactoring.

## Review Focus

1. An `In` product retaining old Sold Price/Sold At/Sold By must preserve those values when matching snapshots (Task 3).
2. Two actions committed at the same clock time must have deterministic per-product ordering, including reverts (Task 1).
3. An old approval button clicked after replacement must not reopen or mutate the failed operation (Task 3).
4. A new confirmation left unclicked during the entire monitoring window must never be treated as a committed target (Task 4).
5. A recovery Workflow that dies after acquiring ownership must be reclaimable only after Cloudflare confirms its owner ended (Tasks 1 and 3).

## File map

| File | Responsibility |
| --- | --- |
| `migrations/0008_line_mutation_recovery.sql` | Preserve existing data while adding failed status, operation provenance, attempt evidence, committed ordering, and recovery/repair ownership |
| `src/db/line-mutation-repository.ts` (new) | Atomic product coordination and request evidence; keep existing event-delivery repository behavior unchanged |
| `src/db/line-repository.ts` | Read/apply terminal guards, recovery finalization, commit ordering, failed-token behavior |
| `src/line/mutation-recovery.ts` (new) | Compare/resolve abandoned operations, track PATCH outcomes, execute one repair check |
| `src/line/soldout.ts`, `src/line/revert.ts` | Call coordinator before inventory preparation and approval; use tracked PATCH and committed-action hook |
| `src/routes/line.ts`, `src/line/command-workflow.ts`, `src/line/webhook.ts` | Propagate real execution identity, resolve Workflow status, construct coordinator dependencies |
| `src/line/mutation-followup-workflow.ts` (new) | Idempotent follow-up registration, bounded scheduling, stable warning delivery |
| `src/env.ts`, `src/index.ts`, `wrangler.jsonc` | Export and bind follow-up Workflow in local/staging/production |
| `test/db/line-mutation-recovery.test.ts` (new), `test/db/line-recovery-migration.test.ts` | Real D1 atomicity, migration compatibility, action ordering |
| `test/line/mutation-recovery.test.ts`, `test/line/mutation-followup-workflow.test.ts` (new) | Decision table, crash evidence, scheduling, repair policy |
| Existing soldout/revert/inventory/repository/webhook/route tests | Compatibility and full integration with actual command flow |

The base is `78e286f` (PR #28). Main working checkout has unrelated edits; execute in this feature's isolated worktree. Use the worktrees skill before implementation setup. Existing test fixtures that construct `SoldoutDeps` must explicitly supply the new coordinator; do not make production recovery optional just to preserve mocks.

## Shared interfaces

Define these in `src/line/mutation-recovery.ts`, importing the existing `SaleValues`, `PendingLineCommand`, and `ReversibleLineAction` types:

```ts
export type ExecutionOwner =
  | { provenance: 'workflow'; workflowId: string }
  | { provenance: 'legacy'; workflowId: null };
export type RequestOutcome = 'unknown' | 'acknowledged' | 'rejected';
export type RecoveryResult =
  | { status: 'ready'; warning?: string }
  | { status: 'busy' };
export type RepairResult =
  | { status: 'unchanged' | 'repaired' | 'busy' }
  | { status: 'unresolved'; productId: string };
export type FollowupParams = { pendingToken: string; productId: string };
export interface MutationCoordinator {
  recover(productId: string, groupId: string, owner: ExecutionOwner): Promise<RecoveryResult>;
  write(pending: PendingLineCommand, recordId: string, owner: ExecutionOwner): Promise<void>;
  committed(action: ReversibleLineAction): Promise<void>;
  check(params: FollowupParams, owner: ExecutionOwner): Promise<RepairResult>;
}
```

`SoldoutDeps` gains `mutation: MutationCoordinator` and `executionOwner: ExecutionOwner`. `createWebhookDeps(env, requestId)` assigns Workflow provenance only when called with the actual command instance ID. Legacy/test processing supplies explicit legacy provenance. All same-event recovery still uses the existing apply event; the product coordinator supplements, not replaces, the current active-operation uniqueness index.

## Task 1: Persist mutation evidence and atomic product ownership

**Files:** migration, new mutation repository, existing line repository/types, D1 tests.

**Interfaces:** Create `createLineMutationRepository(db, clock)` returning:

```ts
interface LineMutationRepository {
  findApplying(productId: string): Promise<PendingLineCommand | null>;
  ownerOf(token: string): Promise<ExecutionOwner | null>;
  acquire(productId: string, owner: ExecutionOwner, mode: 'recovery' | 'repair'): Promise<boolean>;
  productOwner(productId: string): Promise<ExecutionOwner | null>;
  release(productId: string, owner: ExecutionOwner): Promise<boolean>;
  setOperationOwner(token: string, owner: ExecutionOwner): Promise<void>;
  assertWritable(token: string, owner: ExecutionOwner): Promise<void>;
  beginAttempt(input: { id: string; token: string; recordId: string; intended: SaleValues; owner: ExecutionOwner }): Promise<void>;
  finishAttempt(id: string, outcome: 'acknowledged' | 'rejected', responseCategory: string): Promise<void>;
  hasUnknownAttempt(token: string): Promise<boolean>;
  failOwned(token: string, owner: ExecutionOwner, reason: 'replaced' | 'conflict' | 'missing_product'): Promise<boolean>;
  latestConfirmed(productId: string): Promise<ReversibleLineAction | null>;
  uncertainSuperseded(productId: string): Promise<PendingLineCommand[]>;
  markMonitoring(token: string, state: 'registered' | 'ended' | 'unresolved'): Promise<void>;
}
```

- [ ] **1. Add failing real-D1 tests.** Follow `test/db/line-repository.test.ts`'s `testEnv`, `pendingCommand`, and `createApplyingCommand` fixtures. Include duplicate acquisition, wrong-owner release, failed operation releasing the partial uniqueness constraint, failed-token finalization denial, pending confirmation preventing repair acquisition, and same-clock action ordering. A minimal acquisition assertion:

```ts
const repo = createLineMutationRepository(testEnv().DB, fixedClock('2026-10-09T07:00:00Z'));
const a = { provenance: 'workflow', workflowId: 'line-a' } as const;
const b = { provenance: 'workflow', workflowId: 'line-b' } as const;
expect(await Promise.all([
  repo.acquire('A-16', a, 'recovery'), repo.acquire('A-16', b, 'recovery'),
])).toEqual([true, false]);
expect(await repo.release('A-16', b)).toBe(false);
expect(await repo.release('A-16', a)).toBe(true);
```

For scheduling-independent parallel results, assert one `true` and one `false`, then release with the winning owner rather than assuming a particular scheduling order.

- [ ] **2. Run the failing tests:** `npm test -- test/db/line-mutation-recovery.test.ts`. Expected failure: missing module/schema.
- [ ] **3. Write migration and minimal repository.** Rebuild `pending_line_commands` with the original columns plus failed status, resolution reason, and explicit Workflow provenance. Copy existing rows without changing their status. Recreate all indexes, including `idx_one_active_line_mutation_per_product` and `idx_one_active_revert_per_action`. Store legacy provenance as unknown until established, not guessed from age. Add attempt table with immutable snapshots and an unknown default. Add one product-control table for recovery/repair ownership. Atomic acquisition uses insert/update-if-unowned; same owner can resume. Normal pending creation and normal apply claims must refuse an active control owner. Recovery/repair acquisition requires a real non-null Workflow ID; explicit legacy execution cannot acquire these controls and returns an owner-verification diagnostic if recovery is needed. No in-memory mutex.

```sql
CREATE TABLE line_mutation_attempts (
  id TEXT PRIMARY KEY,
  pending_token TEXT NOT NULL,
  record_id TEXT NOT NULL,
  intended_json TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'unknown'
    CHECK(outcome IN ('unknown','acknowledged','rejected')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  response_category TEXT
);
CREATE TABLE line_product_control (
  product_id TEXT PRIMARY KEY,
  owner_workflow_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('recovery','repair')),
  acquired_at TEXT NOT NULL
);
```

Track failed-operation monitoring state and immutable recovery/repair audit in D1; use existing `audit_events` for records. Add a per-product monotonically incremented committed sequence, assigned in the same D1 batch as `finalizeAction`; existing actions get deterministic ordering by `created_at, rowid`. Avoid ordering equal timestamps lexicographically by random IDs.

Recovery finalization must reuse `finalizeAction`'s transaction semantics and original apply event, with an additional conditional recovery owner. Guard the action INSERT as well as the pending UPDATE; a zero-row conditional UPDATE must never leave an inserted action. A stale normal event cannot finalize when recovery owns the product. Reclaiming ownership requires coordinator-confirmed terminal owner and compare-and-set on the exact old owner.

- [ ] **4. Test migrations against a database at migration 0007.** Populate pending/applying/approved/rejected/expired rows and linked sale/revert actions before applying 0008. Assert snapshot equality, all indexes, failed status, single active owner, attempt defaults, and history ordering. Run `npm test -- test/db/line-mutation-recovery.test.ts test/db/line-recovery-migration.test.ts test/db/line-repository.test.ts` and `npm run typecheck`; expected new cases pass.
- [ ] **5. Commit:** `git commit -m 'feat: persist LINE mutation outcomes and recovery ownership'` after staging only Task 1 files.

## Task 2: Track each Airtable PATCH without changing inventory validation

**Files:** `src/line/mutation-recovery.ts`, `src/line/airtable-inventory.ts`, mutation tests, inventory adapter tests.

**Consumes:** Task 1 attempt methods and existing `InventoryClient.updateSaleValues(recordId, values)`.
**Produces:** `writeTrackedSale(pending: PendingLineCommand, recordId: string, owner: ExecutionOwner, deps: { mutationRepo: LineMutationRepository; inventory: InventoryClient; ids: IdGenerator }): Promise<void>`. Task 3 delegates `MutationCoordinator.write` to this helper; Task 2 remains independently testable without a partially implemented coordinator.

- [ ] **1. Add failing attempt tests.** Use mocked repository methods and `InventoryClient`; construct a complete saved sale tuple (`Out`, 12000, `2026-10-09T07:00:00.000Z`, `Mint (U1)`). Assert `beginAttempt` resolves before any PATCH, success changes outcome to acknowledged, thrown timeout leaves unknown, and failure to persist intent sends no PATCH. Also test response received followed by D1 recording failure, and multiple attempts where one rejection cannot erase an earlier unknown.

```ts
const calls: string[] = [];
const beginAttempt = vi.fn(async () => { calls.push('intent'); });
const updateSaleValues = vi.fn(async () => { calls.push('patch'); throw new DOMException('timeout', 'TimeoutError'); });
// Supply beginAttempt/finishAttempt through mutationRepo and updateSaleValues through inventory.
await expect(writeTrackedSale(pending, 'rec16', owner, { mutationRepo, inventory, ids })).rejects.toThrow();
expect(calls).toEqual(['intent', 'patch']);
expect(finishAttempt).not.toHaveBeenCalled();
```

The test fixture explicitly constructs `mutationRepo`, `inventory`, `ids`, `pending`, `owner`, and `finishAttempt` from the Task 1 contracts; keep this shared fixture in this test file rather than introducing a production fixture helper.

- [ ] **2. Run:** `npm test -- test/line/mutation-recovery.test.ts test/line/airtable-inventory.test.ts`. Expected new tracking tests fail.
- [ ] **3. Implement `writeTrackedSale`.** Assert active operation/execution ownership, allocate an attempt UUID, durably begin it, then invoke the existing validated PATCH. Persist success after the adapter confirms a 2xx response. Preserve timeout/network categories from `fetchForLineCommand` instead of losing them behind one generic exception. Do not log URLs containing credentials or provider bodies.

For definite rejection, use a typed OperationalError subclass `InventoryWriteRejectedError` emitted only for known non-acceptance HTTP responses (400/401/403/404/422/429); treat 408, 409, 5xx, redirects/unexpected response contracts, and network exceptions as unknown. Preserve the original retryability policy independently of outcome classification. Validate inputs before writing intent; local validation errors do not create possible network writes.

```ts
await mutationRepo.assertWritable(pending.token, owner);
const id = ids.next();
await mutationRepo.beginAttempt({ id, token: pending.token, recordId, intended: pending.after, owner });
try {
  await inventory.updateSaleValues(recordId, pending.after);
} catch (error) {
  if (error instanceof InventoryWriteRejectedError) {
    await mutationRepo.finishAttempt(id, 'rejected', error.code);
  }
  throw error;
}
await mutationRepo.finishAttempt(id, 'acknowledged', 'http_2xx');
```

- [ ] **4. Run focused tests and typecheck.** Pin timeout, connection drop, 429 rejection, 500 unknown, interrupted completion-recording, and invalid sale tuple behavior.
- [ ] **5. Commit:** `git commit -m 'feat: record Airtable sale update outcomes'`.

## Task 3: Recover old operations in the normal sale/revert flow

**Files:** coordinator, line repository, soldout/revert, webhook/route/workflow wiring, relevant fixtures and tests.

**Consumes:** Tasks 1–2. `createMutationCoordinator` dependencies are:

```ts
{
  repo: LineRepository;
  mutationRepo: LineMutationRepository;
  inventory: InventoryClient;
  ids: IdGenerator;
  status(owner: ExecutionOwner): Promise<'active' | 'terminal' | 'unknown'>;
  registerFollowup(params: FollowupParams): Promise<void>;
  requestImmediateCheck(productId: string): Promise<void>;
}
```

**Produces:** `recoverAbandonedMutation(productId: string, groupId: string, owner: ExecutionOwner, deps: MutationCoordinatorDeps): Promise<RecoveryResult>` plus the normal flow integration; `MutationCoordinatorDeps` is the dependency object defined above. The complete coordinator is assembled in Task 4. Busy maps to an existing processing warning, ready returns an optional conflict warning. All provider errors propagate to the existing retry policy.

- [ ] **1. Add failing recovery tests.** Test intended/original/neither/missing states for both operation kinds. For old intended values, assert one action finalization and no PATCH. For original values, assert failed old operation and no old PATCH. Include `In` with historical sale fields, incomplete soldout after snapshot before intent persistence, duplicate recovery, terminal application failure, and recovery owner interruption/reclaim. Unknown status must throw a retryable diagnostic, not return ready.

```ts
const recovered = await coordinator.recover('A-16', 'C1', newOwner);
expect(recovered).toEqual({ status: 'ready' });
expect(failOwned).toHaveBeenCalledWith('old-token', newOwner, 'replaced');
expect(inventory.updateSaleValues).not.toHaveBeenCalled();
expect(registerFollowup).toHaveBeenCalledBefore(failOwned);
```

Use an unknown-attempt fixture for this registration-order test. For acknowledged/rejected-only fixtures, assert no follow-up registration. Treat legacy applying rows without attempt evidence as uncertain, not definitely unsent.

- [ ] **2. Run the new recovery tests and targeted existing sale/revert tests; expected failures until wiring exists.**
- [ ] **3. Implement status and resolution.** Keep recovery as the exported `recoverAbandonedMutation` function. Keep this task limited to the independently testable recovery service and Workflow-ID/status adapter. Production caller/dependency wiring, durable registration, and the complete coordinator are installed together in Task 4 so no partial/no-op repair behavior can ship. Extract the existing stable `line-<sha256(event)>` construction into `lineCommandWorkflowId(eventId)` reused by router and legacy durable ID lookup. Supply real instance IDs through `createWebhookDeps`. Map Cloudflare status using the explicit terminal whitelist; missing instance and API errors are unknown. Explicit legacy provenance only permits resolution when an operator-established record confirms no Workflow owner; document the safe diagnostic for all other legacy rows.

```ts
const state = await status(oldOwner);
if (state === 'active') return { status: 'busy' };
if (state === 'unknown') throw new OperationalError('line_recovery_owner_unknown', 'Cannot verify prior execution', true);
if (!await mutationRepo.acquire(productId, owner, 'recovery')) return { status: 'busy' };
const product = await inventory.findByProductId(productId);
```

Inside ownership, resolve by the spec table. Missing old intent is not a valid intended-result match. Finish old action using original actor/correlation/apply event and existing finalize transaction. For unchanged, missing, or conflicting product, register follow-up first when uncertainty exists, then conditionally fail old operation. Preserve conflicting tuple and return the warning. A crashed owner is handled by the same terminal-status verification and D1 compare-and-set, never unconditional finally-unlock while an external write may still be in flight.

- [ ] **4. Specify command preparation and approval integration for Task 4.** Do not change production `SoldoutDeps` or its factories in this service-only commit. Recover before initial sale reads and before inventory checks for the selected revert target; repeat ownership validation when confirming. Same-event retries resume the existing operation. Failed/rejected/expired tokens return the existing expired/used response. If old applying belongs to the same operation being retried, execute current recovery logic instead of superseding itself. Only after old recovery completes reread product and construct the new confirmation. Carry conflict warning into text/button responses without changing JSON Flex styles. Approval-disabled path still uses the new price and tracking.

- [ ] **5. Define integration assertions to implement and run with Task 4 wiring.** Real command old 12000/new 13000: unchanged Airtable creates a 13000 confirmation, successful old sale returns already sold, active old Workflow produces no new confirmation, expired old button cannot write, and revert history remains correct. Update all `SoldoutDeps` fixture constructors (find via `rg 'satisfies SoldoutDeps|SoldoutDeps|createWebhookDeps' src test`) with explicit no-op coordinator mocks only where recovery is not under test. Add a production-wiring test asserting it uses the real coordinator.
- [ ] **6. Run:** `npm test -- test/line/mutation-recovery.test.ts test/db/line-repository.test.ts`; then typecheck. The production caller integration cases are gated with Task 4. Existing baseline failures must be listed separately; no broad weakening of assertions.
- [ ] **7. Commit:** `git commit -m 'feat: reconcile abandoned LINE sale and revert operations'`.

## Task 4: Durable follow-up checks and recognizable late-write repair

**Files:** new follow-up Workflow and tests, coordinator, mutation repository, env/index/wrangler, relevant client tests.

**Consumes:** `FollowupParams`, `check`, `latestConfirmed`, `uncertainSuperseded`, product ownership, attempt tracking, and existing LINE retry-key client.
**Produces:** Real `registerFollowup`/`requestImmediateCheck` implementations and a complete `committed` hook used after atomic sale/revert finalization.

- [ ] **1. Write failing tests for pure check scheduling and repair decisions.** Export `runMutationFollowup(step, operations)` with injected `check`, `notify`, and `markEnded` callbacks. Use the existing fake Workflow step style, not actual sleeping in unit tests. Assert sleeps of 30 seconds, 30 seconds, and 4 minutes between checks; checks occur at absolute offsets 30/60/300 seconds. Earlier unchanged/busy results do not skip later checks. Include immediate checks before the first timer and no duplicate warning after replay.

For repair tests, old = Out/12000/old date/old actor; latest = Out/13000/new date/new actor. Assert the full latest tuple is written only if current equals old. Latest revert = In with saved historical fields must also be restored correctly. No latest confirmed action means unresolved, never invent a target from a pending row.

```ts
expect(repairResult).toEqual({ status: 'repaired' });
expect(inventory.updateSaleValues).toHaveBeenCalledWith('rec16', latest.after);
expect(repo.finalizeAction).not.toHaveBeenCalled();
```

- [ ] **2. Run:** `npm test -- test/line/mutation-followup-workflow.test.ts test/line/mutation-recovery.test.ts`; expect new Workflow/repair assertions to fail.
- [ ] **3. Assemble the complete coordinator and install Task 3 caller wiring and integration tests.** Extend `SoldoutDeps` and all fixture constructors with explicit execution identity and coordinator, and wire production factories to the real service. `recover` delegates to `recoverAbandonedMutation`, `write` delegates to `writeTrackedSale`, `committed` records/wakes immediate follow-up checks, and `check` supplies the repair decision below. Implement the soldout/revert preparation, approval, failed-token guards, and warning behavior specified in Task 3 steps 4–5.

Implement durable registration before ownership release. Workflow ID `line-followup-<sha256(pendingToken)>` and idempotent createBatch; keep one follow-up per abandoned operation. Persist its registration in D1. An immediate check request sets a durable D1 check-request marker and wakes the registered Workflow via an idempotent event; timer checks reread D1 so a lost wake does not lose the request. On `committed`, attempt this check for all registered uncertain predecessors. Failure to wake an existing follow-up must not cause a committed sale to be reapplied: retain the durable marker and existing timer fallback. A completed monitor is not reopened; future commands can inspect its unresolved evidence.

Keep execution steps durable; do not use `waitUntil` or in-memory timers. Bind names `snazzy-line-mutation-followup-local`, `snazzy-line-mutation-followup-staging`, `snazzy-line-mutation-followup-production`, class `LineMutationFollowupWorkflow`, binding `LINE_MUTATION_FOLLOWUP_WORKFLOW`. Add test binding fixtures where required.

- [ ] **4. Implement `check` under repair ownership.** Before repair, acquire the same per-product control used in Task 1; refuse if pending/applying normal commands exist. Inside the lock, reread latest committed sequence and Airtable. Current latest tuple => unchanged. Exact superseded intended tuple plus newer committed sequence => tracked repair to latest values, audit once per repair attempt, no new reversible action. Arbitrary tuple or no latest target => unresolved, no PATCH. Persist repair intent/attempt evidence under the monitor's Workflow owner; allow tracking of a repair whose source pending token is failed without granting the old event write permission. Repair ownership must identify its intended confirmed action so replays never target stale saved values.

- [ ] **5. Handle uncertainty and end of window.** Each check/repair uses one initial attempt plus two retries at 30 seconds and 1 minute. A failed check does not stop remaining scheduled checks; retries may overlap a nominal timer deadline, so run overdue checks sequentially without extending the logical checking window with more new checks. Retry sleeps may finish beyond five minutes; this does not promise indefinite coverage. If a normal confirmation stays active through all checks, finish monitoring without touching it; retain uncertainty and send one diagnostic if reconciliation remains unresolved. Busy alone before final check is not a conflict warning. Persist ended/unresolved state explicitly.

Generate warning retry UUID in a persisted step; use existing accepted-409 LINE handling. Successful repairs are silent. Record unresolved state before notification; LINE delivery failure cannot recreate a product lock.

- [ ] **6. Pin races/crashes.** Repair vs normal approval excludes one writer; terminated repair owner can be reclaimed; pending unclicked confirmation never becomes latest confirmed. Same-clock sales use committed sequence. Exact staff tuple cannot be distinguished from late old update (documented risk); unrelated staff tuple remains unchanged. Follow-up registration failure does not release unknown old operation. Failed repair keeps attempt unknown and releases coordination only after its Workflow terminal/recovery path.
- [ ] **7. Run focused tests, typecheck, and Wrangler staging dry run.** Check local/staging/production binding definitions and exports. No remote deployment.
- [ ] **8. Commit:** `git commit -m 'feat: reconcile late Airtable writes with durable follow-up checks'`.

## Task 5: Integrate, validate crashes, and document operational limits

**Files:** existing recovery/repository/route tests, new controlled integration fixtures in `test/line/mutation-recovery.test.ts`, and `docs/operations/line-mutation-recovery.md` (new).

**Interfaces:** No new production interfaces. Exercise real repository and shared service functions, with provider/status mocks; never test only an invented parallel recovery implementation.

- [ ] **1. Add an integration scenario with a controllable deferred PATCH.** Mock the old update as a promise that times out client-side but can later change the fake Airtable record. Run actual old command preparation/approval and new command recovery/approval against real test D1. Resolve the old deferred provider write after new action finalization. Run actual `check` and verify current sale tuple equals the latest confirmed 13000 tuple, one action per confirmed operation, old operation failed, active ownership empty.

```ts
let applyLate!: () => void;
const late = new Promise<void>(resolve => { applyLate = resolve; });
// Fake provider receives old tuple, retains it, and the caller gets a TimeoutError.
// Then complete the real new approval before allowing the retained write to apply.
applyLate();
await late;
await coordinator.check({ pendingToken: old.token, productId: 'A-16' }, monitorOwner);
expect(current).toEqual(latestAction.after);
```

Build the fake provider in this test file with independent server-side completion and client-side timeout promises. Add variants: crash before PATCH send, successful PATCH before D1 response persistence, crash during finalize, crashed recovery ownership, latest confirmed revert, provider unavailable, and two new commands concurrently attempting replacement.

- [ ] **2. Write operations documentation.** Explain status vs application outcome, failed-token meaning, attempt evidence, querying a specific Workflow, monitoring window, concurrent UI edits, and legacy diagnostics. Show read-only D1 queries for pending token, attempt rows, product owner, and action sequence. Do not document direct unlock SQL as a normal fix or instruct restarting the old Workflow during recovery. Include deliberate staging-only fault injection procedure using a controlled provider fixture; no production token changes.
- [ ] **3. Run focused suite:**

```sh
npm test -- test/db/line-mutation-recovery.test.ts test/db/line-recovery-migration.test.ts test/db/line-repository.test.ts test/line/mutation-recovery.test.ts test/line/mutation-followup-workflow.test.ts test/line/airtable-inventory.test.ts test/line/soldout.test.ts test/line/revert.test.ts test/line/webhook.test.ts test/line/command-workflow.test.ts test/routes/line.test.ts
npm run typecheck
npx wrangler deploy --env staging --dry-run --outdir /tmp/snazzy-line-mutation-recovery-build
git diff --check
```

Record exact pass/fail counts. Run the whole suite once at base and once at branch only when verification is authorized; existing baseline failures are not a reason to weaken recovery assertions. No fabricated live LINE evidence. Remote D1 migration/deployment and actual staging LINE exercises are separate user-authorized actions.

- [ ] **4. Self-review whole branch.** Check migration data preservation, all callers and mocks, authorization before recovery, same-event identity, conditional INSERT/finalization, superseded token guards, recovery-owner death, latest action ordering, provider uncertainty, follow-up monitoring exhaustion, and manual edit races. Correct implementation and rerun affected checks. If Native execution is chosen, obtain the agreed independent final review before completion.
- [ ] **5. Commit:** `git commit -m 'test: cover LINE mutation recovery crashes and late writes'`.

## Completion and deployment handoff

Deliver the branch with the spec, migration, five task commits, validation evidence, and explicitly documented limitations. Deployment requires applying migration 0008 to the chosen environment before publishing compatible Worker code; verify backup/export, migration success, and health in that separately authorized deployment. Do not rewrite already applied migrations. A code rollback must preserve the expanded status schema and new evidence tables; old code cannot safely interpret new failed rows without review.

The feature resolves abandoned operation ownership automatically when execution evidence is available. It cannot guarantee no temporary wrong Airtable value, permanent detection of every delayed provider update, or preservation of an exact concurrent manual edit. These remain the approved best-effort limits, not unfinished implementation promises.
