# Snazzy LINE Inventory Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure Thai LINE admin bot that searches Products, triggers existing Workflows, records one-product sold-out mutations, and reverts the latest eligible mutation without overwriting newer Airtable edits.

**Architecture:** `POST /line/webhook` verifies the raw request HMAC before JSON parsing, rejects non-allowlisted groups, and deduplicates each LINE webhook event in D1. Pure command parsing feeds small handlers backed by a narrow Airtable inventory client, one-time pending confirmations, immutable `line_actions`, and the existing append-only audit log. `/upload` and `/docs` reuse existing trigger services; LINE never runs import or publication work inline.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Web Crypto HMAC-SHA256, Airtable REST API, LINE Messaging API, Zod, Vitest 4.1+, `@cloudflare/vitest-plugin`.

**Spec:** `docs/superpowers/specs/2026-09-01-snazzy-automation-design.md`

## Global Constraints

- Runtime timezone is `Asia/Bangkok`.
- One allowlisted LINE group initially; every group member may run every command.
- Validate `x-line-signature` against raw request bytes before parsing JSON.
- Deduplicate webhook event IDs and consume confirmation tokens once.
- `/soldout` accepts exactly one Product ID and one whole-baht price.
- Accepted Product IDs: `A-1234`, `รหัส 1234`, `รหัสสินค้า 1234`; reject `A1234` and `A 1234`.
- Accepted prices: `thb 1290`, `THB 1,290`, `ราคา 1290`, `ราคา 1,290 บาท`.
- Already-Out Products are never overwritten.
- Confirmation expires after 10 minutes; confirmation mode is configurable.
- `Sold By` is `"<display name> (<user ID>)"`; with confirmation, actor is approver; without confirmation, actor is `/soldout` sender.
- `/revert` targets latest successful reversible LINE command in same group, always needs confirmation, and applies only when Airtable still matches recorded after-state.
- `/upload` and `/docs` are never reversible.
- External JSON keys remain uppercase; runtime fields remain camelCase; secrets live only in `Env`.
- Thai messages never contain secrets, signed URLs, Product images, raw external responses, or stack traces.
- Every parser, state transition, money mutation, and trust boundary starts with a failing test.
- Every task ends with focused tests, `npm run check`, and a commit.

## File Map

```text
migrations/0003_line_inventory.sql       # webhook, pending confirmation, reversible action state
src/db/line-repository.ts              # atomic D1 event/token/action operations
src/line/types.ts                      # webhook, command, Product, and pending-action contracts
src/line/signature.ts                  # raw-body LINE HMAC verification
src/line/parser.ts                     # command/Product ID/price grammar
src/line/client.ts                     # existing push + reply, profile, text, and buttons
src/line/messages.ts                   # Thai text and confirmation builders
src/line/airtable-inventory.ts         # Product lookup and sale-field mutation
src/line/search.ts                     # /help and /search
src/line/soldout.ts                    # prepare/direct/approve/reject sold-out flow
src/line/revert.ts                     # prepare/approve/reject conflict-safe revert
src/line/webhook.ts                    # signature-safe event orchestration
src/routes/line.ts                     # HTTP boundary preserving raw bytes
src/router.ts                          # POST /line/webhook registration
test/db/line-repository.test.ts
test/line/signature.test.ts
test/line/parser.test.ts
test/line/client.test.ts
test/line/messages.test.ts
test/line/airtable-inventory.test.ts
test/line/search.test.ts
test/line/soldout.test.ts
test/line/revert.test.ts
test/line/webhook.test.ts
test/routes/line.test.ts
test/acceptance/line-acceptance.test.ts
```

---

### Task 1: LINE domain types and uppercase configuration contract

**Files:**
- Create: `src/line/types.ts`
- Modify: `src/config.ts`
- Modify: `src/env.ts`
- Test: `test/line/types.test.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: existing `parseConfig(raw)` and `AppConfig`.
- Produces: `ParsedCommand`, `ParseResult`, `LineActor`, `SaleValues`, `InventoryProduct`, `PendingLineCommand`, `ReversibleLineAction`; `AppConfig.lineAllowedGroupId` and `AppConfig.soldoutConfirmationEnabled` mapped from uppercase JSON keys.

- [ ] **Step 1: Write failing contract tests**

```ts
// test/line/types.test.ts
import { describe, expect, it } from "vitest";
import { parseSupportedLineEvents, type ParsedCommand, type SaleValues } from "../../src/line/types";

describe("LINE domain contracts", () => {
  it("keeps sold price as integer baht", () => {
    const command: ParsedCommand = { type: "soldout", productId: "A-1234", soldPrice: 1290 };
    const values: SaleValues = { inventoryStatus: "Out", soldPrice: 1290, soldAt: "2026-09-01T10:00:00.000Z", soldBy: "Mint (U1)" };
    expect(command.soldPrice).toBe(1290);
    expect(Number.isInteger(values.soldPrice)).toBe(true);
  });

  it("keeps only validated group text and postback events", () => {
    const events = parseSupportedLineEvents({ events: [
      { type: "message", webhookEventId: "e1", replyToken: "r1", source: { type: "group", groupId: "C1", userId: "U1" }, message: { type: "text", id: "m1", text: "/help" } },
      { type: "message", webhookEventId: "e2", replyToken: "r2", source: { type: "user", userId: "U1" }, message: { type: "text", id: "m2", text: "/help" } },
    ] });
    expect(events.map((event) => event.webhookEventId)).toEqual(["e1"]);
  });
});
```

```ts
// append to test/config.test.ts
it("maps uppercase LINE configuration to camelCase runtime fields", () => {
  const config = parseConfig(JSON.stringify({
    TIME_ZONE: "Asia/Bangkok",
    UPLOAD_CUTOFF_MINUTES: 30,
    PRODUCT_ID_PREFIX: "A",
    LINE_ALLOWED_GROUP_ID: "C-admin",
    SOLDOUT_CONFIRMATION_ENABLED: true,
  }));
  expect(config.lineAllowedGroupId).toBe("C-admin");
  expect(config.soldoutConfirmationEnabled).toBe(true);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run test/line/types.test.ts test/config.test.ts`
Expected: FAIL because `src/line/types.ts` and LINE config fields do not exist.

- [ ] **Step 3: Create domain types**

```ts
// src/line/types.ts
import { z } from "zod";

export type ParsedCommand =
  | { type: "help" }
  | { type: "search"; productId: string }
  | { type: "upload" }
  | { type: "docs" }
  | { type: "soldout"; productId: string; soldPrice: number }
  | { type: "revert" };

export type ParseErrorCode =
  | "unknown_command"
  | "missing_product_id"
  | "invalid_product_id"
  | "multiple_product_ids"
  | "missing_price"
  | "invalid_price"
  | "multiple_prices";

export type ParseResult =
  | { ok: true; command: ParsedCommand }
  | { ok: false; code: ParseErrorCode };

export interface LineActor {
  userId: string;
  displayName: string;
  groupId: string;
}

export interface SaleValues {
  inventoryStatus: "In" | "Out";
  soldPrice: number | null;
  soldAt: string | null;
  soldBy: string | null;
}

export interface InventoryProduct extends SaleValues {
  recordId: string;
  productId: string;
  uploadDate: string | null;
  airtableUrl: string;
}

export type PendingCommandKind = "soldout" | "revert";
export type PendingCommandStatus = "pending" | "applying" | "approved" | "rejected" | "expired";

export interface PendingLineCommand {
  token: string;
  sourceEventId: string;
  applyEventId: string | null;
  kind: PendingCommandKind;
  status: PendingCommandStatus;
  requesterUserId: string;
  groupId: string;
  productId: string;
  soldPrice: number | null;
  before: SaleValues;
  after: SaleValues;
  targetActionId: string | null;
  expiresAt: string;
}

export interface ReversibleLineAction {
  id: string;
  pendingToken: string;
  groupId: string;
  productId: string;
  kind: "soldout" | "revert";
  before: SaleValues;
  after: SaleValues;
  actor: string;
  correlationId: string;
  createdAt: string;
  revertedByActionId: string | null;
}

export interface LineTextEvent {
  type: "message";
  webhookEventId: string;
  replyToken: string;
  source: { type: "group"; groupId: string; userId: string };
  message: { type: "text"; id: string; text: string };
}

export interface LinePostbackEvent {
  type: "postback";
  webhookEventId: string;
  replyToken: string;
  source: { type: "group"; groupId: string; userId: string };
  postback: { data: string };
}

export type SupportedLineEvent = LineTextEvent | LinePostbackEvent;

const GroupSourceSchema = z.object({
  type: z.literal("group"),
  groupId: z.string().min(1),
  userId: z.string().min(1),
});

const SupportedLineEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    webhookEventId: z.string().min(1),
    replyToken: z.string().min(1),
    source: GroupSourceSchema,
    message: z.object({ type: z.literal("text"), id: z.string().min(1), text: z.string() }),
  }),
  z.object({
    type: z.literal("postback"),
    webhookEventId: z.string().min(1),
    replyToken: z.string().min(1),
    source: GroupSourceSchema,
    postback: z.object({ data: z.string().min(1) }),
  }),
]);

export function parseSupportedLineEvents(value: unknown): SupportedLineEvent[] {
  const body = z.object({ events: z.array(z.unknown()) }).parse(value);
  return body.events.flatMap((event) => {
    const parsed = SupportedLineEventSchema.safeParse(event);
    return parsed.success ? [parsed.data] : [];
  });
}
```

- [ ] **Step 4: Extend `src/config.ts` with exact raw/runtime fields**

Add these fields to existing Zod raw schema:

```ts
LINE_ALLOWED_GROUP_ID: z.string().min(1),
SOLDOUT_CONFIRMATION_ENABLED: z.boolean().default(true),
```

Add these fields to `AppConfig`:

```ts
lineAllowedGroupId: string;
soldoutConfirmationEnabled: boolean;
```

Add these mappings in `parseConfig`'s returned object:

```ts
lineAllowedGroupId: parsed.LINE_ALLOWED_GROUP_ID,
soldoutConfirmationEnabled: parsed.SOLDOUT_CONFIRMATION_ENABLED,
```

Add these secret bindings to the existing `Env` interface in `src/env.ts`:

```ts
LINE_CHANNEL_SECRET: string;
LINE_CHANNEL_ACCESS_TOKEN: string;
```

- [ ] **Step 5: Verify focused and full checks**

Run: `npx vitest run test/line/types.test.ts test/config.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/line/types.ts src/config.ts src/env.ts test/line/types.test.ts test/config.test.ts
git commit -m "feat(line): add inventory command contracts"
```

---

### Task 2: D1 webhook, pending-command, and reversible-action state

**Files:**
- Create: `migrations/0003_line_inventory.sql`
- Create: `src/db/line-repository.ts`
- Test: `test/db/line-repository.test.ts`

**Interfaces:**
- Consumes: `D1Database`, `Clock`, `IdGenerator`, types from Task 1.
- Produces: `LineRepository` with atomic event claim, pending token lifecycle, latest-action lookup, and immutable action insertion.

- [ ] **Step 1: Write failing repository test**

```ts
// test/db/line-repository.test.ts
import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";
import { fixedClock, sequentialIdGenerator } from "../helpers/fakes";
import { createLineRepository } from "../../src/db/line-repository";

const before = { inventoryStatus: "In" as const, soldPrice: null, soldAt: null, soldBy: null };
const after = { inventoryStatus: "Out" as const, soldPrice: 1290, soldAt: "2026-09-01T10:00:00.000Z", soldBy: "Mint (U1)" };

describe("line repository", () => {
  it("claims one webhook event once", async () => {
    const repo = createLineRepository(testEnv().DB, sequentialIdGenerator("line"), fixedClock("2026-09-01T10:00:00.000Z"));
    expect(await repo.claimEvent("evt-1", "C1")).toBe(true);
    expect(await repo.claimEvent("evt-1", "C1")).toBe(false);
    await repo.releaseEvent("evt-1");
    expect(await repo.claimEvent("evt-1", "C1")).toBe(true);
  });

  it("claims one unexpired pending token once and can reset a failed apply", async () => {
    const repo = createLineRepository(testEnv().DB, sequentialIdGenerator("line"), fixedClock("2026-09-01T10:00:00.000Z"));
    await repo.createPending({ token: "tok-1", sourceEventId: "evt-command", applyEventId: null, kind: "soldout", status: "pending", requesterUserId: "U1", groupId: "C1", productId: "A-1", soldPrice: 1290, before, after, targetActionId: null, expiresAt: "2026-09-01T10:10:00.000Z" });
    expect(await repo.claimPending("tok-1", "C1", "revert", "evt-malicious", "2026-09-01T10:05:00.000Z")).toBeNull();
    expect((await repo.claimPending("tok-1", "C1", "soldout", "evt-approve", "2026-09-01T10:05:00.000Z"))?.status).toBe("applying");
    expect(await repo.claimPending("tok-1", "C1", "soldout", "evt-other", "2026-09-01T10:05:00.000Z")).toBeNull();
    expect(await repo.claimPending("tok-1", "C1", "soldout", "evt-approve", "2026-09-01T10:11:00.000Z")).not.toBeNull();
    await repo.resetPending("tok-1", "evt-approve");
    expect(await repo.claimPending("tok-1", "C1", "soldout", "evt-retry", "2026-09-01T10:05:00.000Z")).not.toBeNull();
  });

  it("returns latest unreverted action in the same group", async () => {
    const repo = createLineRepository(testEnv().DB, sequentialIdGenerator("line"), fixedClock("2026-09-01T10:00:00.000Z"));
    await repo.createPending({ token: "tok-action", sourceEventId: "evt-command", applyEventId: null, kind: "soldout", status: "pending", requesterUserId: "U1", groupId: "C1", productId: "A-1", soldPrice: 1290, before, after, targetActionId: null, expiresAt: "2026-09-01T10:10:00.000Z" });
    await repo.claimPending("tok-action", "C1", "soldout", "evt-approve", "2026-09-01T10:05:00.000Z");
    await repo.finalizeAction({ pendingToken: "tok-action", applyEventId: "evt-approve", targetActionId: null, groupId: "C1", productId: "A-1", kind: "soldout", before, after, actor: "Mint (U1)", correlationId: "corr-1" });
    expect((await repo.latestReversible("C1"))?.productId).toBe("A-1");
    expect(await repo.latestReversible("C2")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npx vitest run test/db/line-repository.test.ts`
Expected: FAIL because migration and repository do not exist.

- [ ] **Step 3: Create migration**

```sql
-- migrations/0003_line_inventory.sql
CREATE TABLE line_events (
  event_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE pending_line_commands (
  token TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL UNIQUE,
  apply_event_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('soldout', 'revert')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'applying', 'approved', 'rejected', 'expired')),
  requester_user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  sold_price INTEGER CHECK (sold_price IS NULL OR sold_price > 0),
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  target_action_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolver_actor TEXT
);
CREATE INDEX idx_pending_line_group_status ON pending_line_commands(group_id, status, expires_at);
CREATE UNIQUE INDEX idx_one_active_revert_per_action
  ON pending_line_commands(target_action_id)
  WHERE kind = 'revert' AND status IN ('pending', 'applying');

CREATE TABLE line_actions (
  id TEXT PRIMARY KEY,
  pending_token TEXT NOT NULL UNIQUE,
  group_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('soldout', 'revert')),
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reverted_by_action_id TEXT
);
CREATE INDEX idx_line_actions_group_created ON line_actions(group_id, created_at DESC);
```

- [ ] **Step 4: Create repository**

```ts
// src/db/line-repository.ts
import type { IdGenerator } from "../shared/ids";
import type { Clock } from "../shared/time";
import type { PendingLineCommand, ReversibleLineAction, SaleValues } from "../line/types";

export interface LineRepository {
  claimEvent(eventId: string, groupId: string): Promise<boolean>;
  releaseEvent(eventId: string): Promise<void>;
  findPendingBySourceEvent(sourceEventId: string): Promise<PendingLineCommand | null>;
  createPending(command: PendingLineCommand): Promise<PendingLineCommand | null>;
  claimPending(token: string, groupId: string, kind: PendingLineCommand["kind"], eventId: string, nowIso: string): Promise<PendingLineCommand | null>;
  setPendingAfter(token: string, eventId: string, after: SaleValues): Promise<void>;
  resetPending(token: string, eventId: string): Promise<void>;
  resolvePending(token: string, eventId: string, status: "rejected" | "expired", resolverActor: string): Promise<void>;
  finalizeAction(input: Omit<ReversibleLineAction, "id" | "createdAt" | "revertedByActionId"> & {
    applyEventId: string;
    targetActionId: string | null;
  }): Promise<ReversibleLineAction>;
  latestReversible(groupId: string): Promise<ReversibleLineAction | null>;
}

function parsePending(row: Record<string, unknown>): PendingLineCommand {
  return {
    token: String(row.token), sourceEventId: String(row.source_event_id), applyEventId: row.apply_event_id === null ? null : String(row.apply_event_id),
    kind: row.kind as PendingLineCommand["kind"], status: row.status as PendingLineCommand["status"],
    requesterUserId: String(row.requester_user_id), groupId: String(row.group_id), productId: String(row.product_id),
    soldPrice: row.sold_price === null ? null : Number(row.sold_price), before: JSON.parse(String(row.before_json)) as SaleValues,
    after: JSON.parse(String(row.after_json)) as SaleValues, targetActionId: row.target_action_id === null ? null : String(row.target_action_id),
    expiresAt: String(row.expires_at),
  };
}

function parseAction(row: Record<string, unknown>): ReversibleLineAction {
  return {
    id: String(row.id), pendingToken: String(row.pending_token), groupId: String(row.group_id), productId: String(row.product_id), kind: row.kind as "soldout" | "revert",
    before: JSON.parse(String(row.before_json)) as SaleValues, after: JSON.parse(String(row.after_json)) as SaleValues,
    actor: String(row.actor), correlationId: String(row.correlation_id), createdAt: String(row.created_at),
    revertedByActionId: row.reverted_by_action_id === null ? null : String(row.reverted_by_action_id),
  };
}

export function createLineRepository(db: D1Database, ids: IdGenerator, clock: Clock): LineRepository {
  return {
    async claimEvent(eventId, groupId) {
      const result = await db.prepare("INSERT OR IGNORE INTO line_events (event_id, group_id, received_at) VALUES (?, ?, ?)")
        .bind(eventId, groupId, clock.now().toISOString()).run();
      return result.meta.changes === 1;
    },
    async releaseEvent(eventId) {
      await db.prepare("DELETE FROM line_events WHERE event_id = ?").bind(eventId).run();
    },
    async findPendingBySourceEvent(sourceEventId) {
      const row = await db.prepare("SELECT * FROM pending_line_commands WHERE source_event_id = ?")
        .bind(sourceEventId).first<Record<string, unknown>>();
      return row ? parsePending(row) : null;
    },
    async createPending(command) {
      const existing = await db.prepare("SELECT * FROM pending_line_commands WHERE source_event_id = ?")
        .bind(command.sourceEventId).first<Record<string, unknown>>();
      if (existing) return parsePending(existing);
      const result = await db.prepare(`INSERT OR IGNORE INTO pending_line_commands
        (token, source_event_id, apply_event_id, kind, status, requester_user_id, group_id, product_id, sold_price, before_json, after_json, target_action_id, expires_at, created_at)
        VALUES (?, ?, NULL, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(command.token, command.sourceEventId, command.kind, command.requesterUserId, command.groupId, command.productId, command.soldPrice,
          JSON.stringify(command.before), JSON.stringify(command.after), command.targetActionId, command.expiresAt, clock.now().toISOString()).run();
      return result.meta.changes === 1 ? { ...command, status: "pending", applyEventId: null } : null;
    },
    async claimPending(token, groupId, kind, eventId, nowIso) {
      await db.prepare(`UPDATE pending_line_commands SET status = 'expired', resolved_at = ?
        WHERE token = ? AND group_id = ? AND kind = ? AND status = 'pending' AND expires_at <= ?`)
        .bind(nowIso, token, groupId, kind, nowIso).run();
      const row = await db.prepare(`UPDATE pending_line_commands SET status = 'applying', apply_event_id = ?
        WHERE token = ? AND group_id = ? AND kind = ?
          AND ((status = 'pending' AND expires_at > ?)
            OR (status = 'applying' AND apply_event_id = ?)) RETURNING *`)
        .bind(eventId, token, groupId, kind, nowIso, eventId).first<Record<string, unknown>>();
      return row ? parsePending(row) : null;
    },
    async setPendingAfter(token, eventId, after) {
      await db.prepare("UPDATE pending_line_commands SET after_json = ? WHERE token = ? AND status = 'applying' AND apply_event_id = ?")
        .bind(JSON.stringify(after), token, eventId).run();
    },
    async resetPending(token, eventId) {
      await db.prepare("UPDATE pending_line_commands SET status = 'pending', apply_event_id = NULL WHERE token = ? AND status = 'applying' AND apply_event_id = ?")
        .bind(token, eventId).run();
    },
    async resolvePending(token, eventId, status, resolverActor) {
      await db.prepare(`UPDATE pending_line_commands SET status = ?, resolved_at = ?, resolver_actor = ?
        WHERE token = ? AND status = 'applying' AND apply_event_id = ?`)
        .bind(status, clock.now().toISOString(), resolverActor, token, eventId).run();
    },
    async finalizeAction(input) {
      const existing = await db.prepare(
        "SELECT * FROM line_actions WHERE pending_token = ?",
      ).bind(input.pendingToken).first<Record<string, unknown>>();
      if (existing) return parseAction(existing);

      const pending = await db.prepare(
        `SELECT token FROM pending_line_commands
         WHERE token = ? AND group_id = ? AND status = 'applying'
           AND apply_event_id = ?`,
      ).bind(
        input.pendingToken,
        input.groupId,
        input.applyEventId,
      ).first();
      if (pending === null) {
        throw new Error("pending command is not owned by this event");
      }

      if (input.targetActionId !== null) {
        const target = await db.prepare(
          `SELECT id FROM line_actions
           WHERE id = ? AND group_id = ?
             AND kind = 'soldout'
             AND reverted_by_action_id IS NULL`,
        ).bind(
          input.targetActionId,
          input.groupId,
        ).first();
        if (target === null) {
          throw new Error("revert target is no longer reversible");
        }
      }

      const action: ReversibleLineAction = {
        id: ids.next(),
        pendingToken: input.pendingToken,
        groupId: input.groupId,
        productId: input.productId,
        kind: input.kind,
        before: input.before,
        after: input.after,
        actor: input.actor,
        correlationId: input.correlationId,
        createdAt: clock.now().toISOString(),
        revertedByActionId: null,
      };
      const statements = [
        db.prepare(
          `INSERT INTO line_actions
             (id, pending_token, group_id, product_id, kind,
              before_json, after_json, actor, correlation_id,
              created_at, reverted_by_action_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).bind(
          action.id,
          action.pendingToken,
          action.groupId,
          action.productId,
          action.kind,
          JSON.stringify(action.before),
          JSON.stringify(action.after),
          action.actor,
          action.correlationId,
          action.createdAt,
        ),
        db.prepare(
          `UPDATE pending_line_commands
           SET status = 'approved', resolved_at = ?, resolver_actor = ?
           WHERE token = ? AND status = 'applying'
             AND apply_event_id = ?`,
        ).bind(
          action.createdAt,
          action.actor,
          action.pendingToken,
          input.applyEventId,
        ),
        db.prepare(
          `INSERT INTO audit_events
             (id, correlation_id, actor, action,
              before_value, after_value, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          ids.next(),
          action.correlationId,
          action.actor,
          action.kind === "soldout"
            ? "line_soldout"
            : "line_revert",
          JSON.stringify(action.before),
          JSON.stringify(action.after),
          action.createdAt,
        ),
      ];
      if (input.targetActionId !== null) {
        statements.splice(
          1,
          0,
          db.prepare(
            `UPDATE line_actions SET reverted_by_action_id = ?
             WHERE id = ? AND group_id = ?
               AND reverted_by_action_id IS NULL`,
          ).bind(
            action.id,
            input.targetActionId,
            input.groupId,
          ),
        );
      }
      await db.batch(statements);
      return action;
    },
    async latestReversible(groupId) {
      const row = await db.prepare(`SELECT * FROM line_actions WHERE group_id = ? AND kind = 'soldout' AND reverted_by_action_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`)
        .bind(groupId).first<Record<string, unknown>>();
      return row ? parseAction(row) : null;
    },
  };
}
```

- [ ] **Step 5: Verify focused and full checks**

Run: `npx vitest run test/db/line-repository.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/0003_line_inventory.sql src/db/line-repository.ts test/db/line-repository.test.ts
git commit -m "feat(line): add durable command state"
```

---

### Task 3: Raw-body LINE signature verification

**Files:**
- Create: `src/line/signature.ts`
- Test: `test/line/signature.test.ts`

**Interfaces:**
- Consumes: Web Crypto.
- Produces: `verifyLineSignature(rawBody, signature, channelSecret): Promise<boolean>`.

- [ ] **Step 1: Write failing test**

```ts
// test/line/signature.test.ts
import { describe, expect, it } from "vitest";
import { verifyLineSignature } from "../../src/line/signature";

async function sign(body: Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return btoa(String.fromCharCode(...bytes));
}

describe("verifyLineSignature", () => {
  it("accepts exact raw bytes and rejects a changed body", async () => {
    const body = new TextEncoder().encode('{"events":[]}');
    const signature = await sign(body, "channel-secret");
    expect(await verifyLineSignature(body.buffer, signature, "channel-secret")).toBe(true);
    expect(await verifyLineSignature(new TextEncoder().encode('{"events":[1]}').buffer, signature, "channel-secret")).toBe(false);
  });
  it("rejects missing or malformed base64", async () => {
    expect(await verifyLineSignature(new ArrayBuffer(0), "", "secret")).toBe(false);
    expect(await verifyLineSignature(new ArrayBuffer(0), "%%%", "secret")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npx vitest run test/line/signature.test.ts`
Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement verifier**

```ts
// src/line/signature.ts
function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function verifyLineSignature(rawBody: ArrayBuffer, signature: string, channelSecret: string): Promise<boolean> {
  if (!signature) return false;
  const expected = decodeBase64(signature);
  if (!expected) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(channelSecret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, expected, rawBody);
}
```

- [ ] **Step 4: Verify focused and full checks**

Run: `npx vitest run test/line/signature.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/line/signature.ts test/line/signature.test.ts
git commit -m "feat(line): verify webhook signatures"
```

---

### Task 4: Command, Product ID, and whole-baht parser

**Files:**
- Create: `src/line/parser.ts`
- Test: `test/line/parser.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `parseLineCommand(text): ParseResult`.

- [ ] **Step 1: Write table-driven failing tests**

```ts
// test/line/parser.test.ts
import { describe, expect, it } from "vitest";
import { parseLineCommand } from "../../src/line/parser";

describe("parseLineCommand", () => {
  it.each([
    ["/help", { type: "help" }], [" /upload ", { type: "upload" }], ["/docs", { type: "docs" }], ["/revert", { type: "revert" }],
    ["/search A-1234", { type: "search", productId: "A-1234" }],
    ["/soldout A-1234 thb 1290", { type: "soldout", productId: "A-1234", soldPrice: 1290 }],
    ["/soldout รหัส 1234 THB 1,290", { type: "soldout", productId: "A-1234", soldPrice: 1290 }],
    ["/soldout รหัสสินค้า 1234 ราคา 1,290 บาท", { type: "soldout", productId: "A-1234", soldPrice: 1290 }],
  ])("parses %s", (text, expected) => expect(parseLineCommand(text)).toEqual({ ok: true, command: expected }));

  it.each([
    ["/soldout thb 1290", "missing_product_id"],
    ["/soldout A1234 thb 1290", "invalid_product_id"],
    ["/soldout A 1234 thb 1290", "invalid_product_id"],
    ["/soldout A-1 A-2 thb 1290", "multiple_product_ids"],
    ["/soldout A-1", "missing_price"],
    ["/soldout A-1 thb 12.50", "invalid_price"],
    ["/soldout A-1 thb 0", "invalid_price"],
    ["/soldout A-1 thb 100 ราคา 200", "multiple_prices"],
    ["/soldout-extra A-1 thb 100", "unknown_command"],
    ["/unknown", "unknown_command"],
  ])("rejects %s", (text, code) => expect(parseLineCommand(text)).toEqual({ ok: false, code }));
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npx vitest run test/line/parser.test.ts`
Expected: FAIL because parser does not exist.

- [ ] **Step 3: Implement parser**

```ts
// src/line/parser.ts
import type { ParseResult } from "./types";

const A_ID = /\bA-([1-9]\d*)\b/gi;
const THAI_ID = /รหัส(?:สินค้า)?\s+([1-9]\d*)\b/g;
const PRICE_NUMBER = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)";
const THB_PRICE = new RegExp(`\\bTHB\\s+(${PRICE_NUMBER})(?![\\d.,])\\s*(?:บาท)?`, "gi");
const THAI_PRICE = new RegExp(`ราคา\\s+(${PRICE_NUMBER})(?![\\d.,])\\s*(?:บาท)?`, "g");

function allMatches(text: string, patterns: RegExp[]): string[] {
  return patterns.flatMap((pattern) => Array.from(text.matchAll(new RegExp(pattern.source, pattern.flags)), (match) => match[1]));
}

function extractProductIds(text: string): { values: string[]; malformed: boolean } {
  const values = allMatches(text, [A_ID, THAI_ID]).map((digits) => `A-${digits}`);
  const malformed = /\bA\d+\b|\bA\s+\d+\b|\bA-0+\b|รหัส(?:สินค้า)?\s+0+\b/i.test(text);
  return { values, malformed };
}

function extractPrices(text: string): { values: number[]; malformed: boolean } {
  const values = allMatches(text, [THB_PRICE, THAI_PRICE]).map((value) => Number(value.replaceAll(",", "")));
  const prefixCount = Array.from(text.matchAll(/\bTHB\b|ราคา/gi)).length;
  const malformed = prefixCount !== values.length || values.some((value) => !Number.isSafeInteger(value) || value <= 0);
  return { values, malformed };
}

export function parseLineCommand(input: string): ParseResult {
  const text = input.trim();
  if (text === "/help") return { ok: true, command: { type: "help" } };
  if (text === "/upload") return { ok: true, command: { type: "upload" } };
  if (text === "/docs") return { ok: true, command: { type: "docs" } };
  if (text === "/revert") return { ok: true, command: { type: "revert" } };

  if (/^\/search(?:\s|$)/.test(text)) {
    const ids = extractProductIds(text.slice(7));
    if (ids.malformed) return { ok: false, code: "invalid_product_id" };
    if (ids.values.length === 0) return { ok: false, code: "missing_product_id" };
    if (ids.values.length > 1) return { ok: false, code: "multiple_product_ids" };
    return { ok: true, command: { type: "search", productId: ids.values[0] } };
  }

  if (/^\/soldout(?:\s|$)/.test(text)) {
    const body = text.slice(8);
    const ids = extractProductIds(body);
    if (ids.malformed) return { ok: false, code: "invalid_product_id" };
    if (ids.values.length === 0) return { ok: false, code: "missing_product_id" };
    if (ids.values.length > 1) return { ok: false, code: "multiple_product_ids" };
    const prices = extractPrices(body);
    if (prices.malformed) return { ok: false, code: "invalid_price" };
    if (prices.values.length === 0) return { ok: false, code: "missing_price" };
    if (prices.values.length > 1) return { ok: false, code: "multiple_prices" };
    return { ok: true, command: { type: "soldout", productId: ids.values[0], soldPrice: prices.values[0] } };
  }

  return { ok: false, code: "unknown_command" };
}
```

- [ ] **Step 4: Verify focused and full checks**

Run: `npx vitest run test/line/parser.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/line/parser.ts test/line/parser.test.ts
git commit -m "feat(line): parse inventory commands"
```

---

### Task 5: Extend LINE client for replies, profiles, and buttons

**Files:**
- Modify: `src/line/client.ts`
- Test: `test/line/client.test.ts`

**Interfaces:**
- Consumes: existing `pushMessage`, `Fetcher`, channel access token.
- Produces: `replyText`, `replyButtons`, `getGroupMemberProfile` while preserving `pushMessage`.

- [ ] **Step 1: Add failing tests**

```ts
// add to test/line/client.test.ts
it("replies with text through the reply endpoint", async () => {
  let body: unknown;
  const client = createLineClient({ channelAccessToken: "token", fetch: async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return new Response("{}", { status: 200 });
  }});
  await client.replyText("reply-1", "พบสินค้า A-1");
  expect(body).toEqual({ replyToken: "reply-1", messages: [{ type: "text", text: "พบสินค้า A-1" }] });
});

it("loads group member display name", async () => {
  const client = createLineClient({ channelAccessToken: "token", fetch: async () =>
    new Response(JSON.stringify({ userId: "U1", displayName: "Mint", pictureUrl: "https://example.com/p.jpg" }), { status: 200 }) });
  expect(await client.getGroupMemberProfile("C1", "U1")).toEqual({ userId: "U1", displayName: "Mint" });
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npx vitest run test/line/client.test.ts`
Expected: FAIL because new methods do not exist.

- [ ] **Step 3: Replace client with extended implementation**

```ts
// src/line/client.ts
import type { Fetcher } from "../shared/http";
import { OperationalError } from "../shared/errors";

export interface LineButton { label: string; data: string; style?: "primary" | "secondary"; }
export interface LineClient {
  pushMessage(toGroupId: string, text: string): Promise<void>;
  replyText(replyToken: string, text: string): Promise<void>;
  replyButtons(replyToken: string, altText: string, text: string, buttons: LineButton[]): Promise<void>;
  getGroupMemberProfile(groupId: string, userId: string): Promise<{ userId: string; displayName: string }>;
}

export function createLineClient(config: { channelAccessToken: string; fetch: Fetcher }): LineClient {
  const headers = { Authorization: `Bearer ${config.channelAccessToken}`, "content-type": "application/json" };
  async function send(url: string, body: unknown, code: string): Promise<void> {
    const response = await config.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!response.ok) throw new OperationalError(code, `LINE API failed with status ${response.status}`, response.status === 429 || response.status >= 500);
  }
  return {
    pushMessage(toGroupId, text) {
      return send("https://api.line.me/v2/bot/message/push", { to: toGroupId, messages: [{ type: "text", text }] }, "line_push_failed");
    },
    replyText(replyToken, text) {
      return send("https://api.line.me/v2/bot/message/reply", { replyToken, messages: [{ type: "text", text }] }, "line_reply_failed");
    },
    replyButtons(replyToken, altText, text, buttons) {
      return send("https://api.line.me/v2/bot/message/reply", {
        replyToken,
        messages: [{ type: "template", altText, template: { type: "buttons", text, actions: buttons.map((button) => ({ type: "postback", label: button.label, data: button.data, displayText: button.label })) } }],
      }, "line_reply_failed");
    },
    async getGroupMemberProfile(groupId, userId) {
      const response = await config.fetch(`https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`, { headers });
      if (!response.ok) throw new OperationalError("line_profile_failed", `LINE profile failed with status ${response.status}`, response.status === 429 || response.status >= 500);
      const body = await response.json() as { userId: string; displayName: string };
      return { userId: body.userId, displayName: body.displayName };
    },
  };
}
```

- [ ] **Step 4: Verify focused and full checks**

Run: `npx vitest run test/line/client.test.ts`
Expected: PASS, including existing push tests.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/line/client.ts test/line/client.test.ts
git commit -m "feat(line): add replies and confirmation buttons"
```

---

### Task 6: Airtable inventory lookup and compare-safe mutation

**Files:**
- Create: `src/line/airtable-inventory.ts`
- Test: `test/line/airtable-inventory.test.ts`

**Interfaces:**
- Consumes: Airtable base/table/token, `Fetcher`, `InventoryProduct`, `SaleValues`.
- Produces: `InventoryClient.findByProductId`, `updateSaleValues`, `matchesSaleValues`.

- [ ] **Step 1: Write failing tests**

```ts
// test/line/airtable-inventory.test.ts
import { describe, expect, it } from "vitest";
import { createInventoryClient, matchesSaleValues } from "../../src/line/airtable-inventory";

const config = { baseId: "app1", tableId: "tbl1", token: "token" };

describe("inventory Airtable client", () => {
  it("maps missing legacy sale fields to null", async () => {
    const client = createInventoryClient({ ...config, fetch: async () => new Response(JSON.stringify({ records: [{ id: "rec1", fields: { "Product ID": "A-1", "Inventory Status": "Out", "Upload Date": "2026-09-01" } }] }), { status: 200 }) });
    expect(await client.findByProductId("A-1")).toMatchObject({ recordId: "rec1", soldPrice: null, soldAt: null, soldBy: null });
  });
  it("rejects an unknown inventory state instead of treating it as In", async () => {
    const client = createInventoryClient({ ...config, fetch: async () => new Response(JSON.stringify({ records: [{ id: "rec1", fields: { "Product ID": "A-1", "Inventory Status": "Unknown" } }] }), { status: 200 }) });
    await expect(client.findByProductId("A-1")).rejects.toMatchObject({ code: "airtable_inventory_invalid_record" });
  });
  it("writes only four system-owned sale fields", async () => {
    let body: unknown;
    const client = createInventoryClient({ ...config, now: () => new Date("2026-09-01T10:00:00.000Z"), fetch: async (_input, init) => { body = JSON.parse(String(init?.body)); return new Response("{}", { status: 200 }); } });
    await client.updateSaleValues("rec1", { inventoryStatus: "Out", soldPrice: 1290, soldAt: "2026-09-01T10:00:00.000Z", soldBy: "Mint (U1)" });
    expect(body).toEqual({ fields: { "Inventory Status": "Out", "Sold Price": 1290, "Sold At": "2026-09-01T10:00:00.000Z", "Sold By": "Mint (U1)", "Last System Update": "2026-09-01T10:00:00.000Z" } });
  });
  it("compares all sale fields", () => {
    const values = { inventoryStatus: "Out" as const, soldPrice: 1290, soldAt: "x", soldBy: "Mint (U1)" };
    expect(matchesSaleValues(values, values)).toBe(true);
    expect(matchesSaleValues(values, { ...values, soldPrice: 1300 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npx vitest run test/line/airtable-inventory.test.ts`
Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement client**

```ts
// src/line/airtable-inventory.ts
import { z } from "zod";
import type { Fetcher } from "../shared/http";
import { OperationalError } from "../shared/errors";
import type { InventoryProduct, SaleValues } from "./types";

export interface InventoryClient {
  findByProductId(productId: string): Promise<InventoryProduct | null>;
  updateSaleValues(recordId: string, values: SaleValues): Promise<void>;
}

const AirtableListSchema = z.object({
  records: z.array(z.object({
    id: z.string().min(1),
    fields: z.record(z.string(), z.unknown()),
  })),
});

const InventoryFieldsSchema = z.object({
  "Product ID": z.string().regex(/^A-[1-9]\d*$/),
  "Inventory Status": z.enum(["In", "Out"]),
  "Upload Date": z.string().optional(),
  "Sold Price": z.number().int().positive().optional(),
  "Sold At": z.string().optional(),
  "Sold By": z.string().optional(),
});

export function matchesSaleValues(actual: SaleValues, expected: SaleValues): boolean {
  return actual.inventoryStatus === expected.inventoryStatus && actual.soldPrice === expected.soldPrice && actual.soldAt === expected.soldAt && actual.soldBy === expected.soldBy;
}

export function createInventoryClient(config: { baseId: string; tableId: string; token: string; fetch: Fetcher; now?: () => Date }): InventoryClient {
  const baseUrl = `https://api.airtable.com/v0/${config.baseId}/${config.tableId}`;
  const headers = { Authorization: `Bearer ${config.token}`, "content-type": "application/json" };
  const now = config.now ?? (() => new Date());
  async function requireOk(response: Response, action: string): Promise<void> {
    if (!response.ok) throw new OperationalError(`airtable_inventory_${action}_failed`, `Airtable inventory ${action} failed with status ${response.status}`, response.status === 429 || response.status >= 500);
  }
  return {
    async findByProductId(productId) {
      const url = new URL(baseUrl);
      url.searchParams.set("filterByFormula", `{Product ID} = '${productId}'`);
      url.searchParams.set("maxRecords", "1");
      const response = await config.fetch(url.toString(), { headers });
      await requireOk(response, "find");
      const parsedBody = AirtableListSchema.safeParse(await response.json());
      if (!parsedBody.success) throw new OperationalError("airtable_inventory_invalid_response", "Airtable inventory response validation failed", false);
      if (parsedBody.data.records.length === 0) return null;
      const record = parsedBody.data.records[0];
      const parsedFields = InventoryFieldsSchema.safeParse(record.fields);
      if (!parsedFields.success) throw new OperationalError("airtable_inventory_invalid_record", "Airtable inventory record validation failed", false);
      const fields = parsedFields.data;
      return {
        recordId: record.id, productId: fields["Product ID"], uploadDate: fields["Upload Date"] ?? null,
        inventoryStatus: fields["Inventory Status"],
        soldPrice: fields["Sold Price"] ?? null,
        soldAt: fields["Sold At"] ?? null,
        soldBy: fields["Sold By"] ?? null,
        airtableUrl: `https://airtable.com/${config.baseId}/${config.tableId}/${record.id}`,
      };
    },
    async updateSaleValues(recordId, values) {
      const updatedAt = now().toISOString();
      const response = await config.fetch(`${baseUrl}/${recordId}`, { method: "PATCH", headers, body: JSON.stringify({ fields: {
        "Inventory Status": values.inventoryStatus, "Sold Price": values.soldPrice, "Sold At": values.soldAt, "Sold By": values.soldBy, "Last System Update": updatedAt,
      } }) });
      await requireOk(response, "update");
    },
  };
}
```

- [ ] **Step 4: Verify focused and full checks**

Run: `npx vitest run test/line/airtable-inventory.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/line/airtable-inventory.ts test/line/airtable-inventory.test.ts
git commit -m "feat(line): add Airtable inventory client"
```

---

### Task 7: Thai messages, `/help`, `/search`, `/upload`, and `/docs`

**Files:**
- Create: `src/line/messages.ts`
- Create: `src/line/search.ts`
- Test: `test/line/messages.test.ts`
- Test: `test/line/search.test.ts`

**Interfaces:**
- Consumes: parser error codes, `InventoryClient`, existing `handleUploadTrigger(env, "line")`, existing `handleDocsTrigger(env, "line")`.
- Produces: Thai message builders and `handleReadOnlyCommand`.

- [ ] **Step 1: Write failing tests**

```ts
// test/line/messages.test.ts
import { describe, expect, it } from "vitest";
import { alreadyOutText, helpText, parseErrorText } from "../../src/line/messages";

it("shows missing legacy values explicitly", () => {
  expect(alreadyOutText({ recordId: "r", productId: "A-1", uploadDate: null, airtableUrl: "https://airtable/r", inventoryStatus: "Out", soldPrice: null, soldAt: null, soldBy: null })).toContain("ไม่พบข้อมูลเดิม");
});
it("documents accepted soldout form", () => expect(helpText()).toContain("/soldout A-1234 ราคา 1,290 บาท"));
it("gives format guidance for ambiguous price", () => expect(parseErrorText("multiple_prices")).toContain("ราคาเดียว"));
```

```ts
// test/line/search.test.ts
import { describe, expect, it, vi } from "vitest";
import { handleReadOnlyCommand } from "../../src/line/search";

it("returns Thai not-found for unknown Product ID", async () => {
  const text = await handleReadOnlyCommand({ type: "search", productId: "A-404" }, { inventory: { findByProductId: vi.fn().mockResolvedValue(null) }, triggerUpload: vi.fn(), triggerDocs: vi.fn() });
  expect(text).toContain("ไม่พบสินค้า A-404");
});
it("triggers upload through existing trigger service", async () => {
  const triggerUpload = vi.fn().mockResolvedValue({ status: "started", id: "run-1" });
  expect(await handleReadOnlyCommand({ type: "upload" }, { inventory: { findByProductId: vi.fn() }, triggerUpload, triggerDocs: vi.fn() })).toContain("เริ่มนำเข้า");
  expect(triggerUpload).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run test/line/messages.test.ts test/line/search.test.ts`
Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement messages and read-only handlers**

```ts
// src/line/messages.ts
import type { InventoryProduct, ParseErrorCode, SaleValues } from "./types";
const old = (value: string | number | null) => value === null ? "ไม่พบข้อมูลเดิม" : String(value);
export const helpText = () => ["คำสั่งที่ใช้ได้", "/search A-1234", "/upload", "/docs", "/soldout A-1234 ราคา 1,290 บาท", "/revert"].join("\n");
export function parseErrorText(code: ParseErrorCode): string {
  const messages: Record<ParseErrorCode, string> = {
    unknown_command: "ไม่รู้จักคำสั่ง ใช้ /help", missing_product_id: "ไม่พบรหัสสินค้า ตัวอย่าง A-1234",
    invalid_product_id: "รูปแบบรหัสไม่ถูกต้อง ใช้ A-1234, รหัส 1234 หรือ รหัสสินค้า 1234",
    multiple_product_ids: "กรุณาระบุรหัสสินค้าเพียงหนึ่งรหัส", missing_price: "ไม่พบราคาขาย ตัวอย่าง ราคา 1,290 บาท",
    invalid_price: "ราคาต้องเป็นจำนวนเต็มบาท เช่น THB 1,290", multiple_prices: "กรุณาระบุราคาเดียว",
  }; return messages[code];
}
export const actorText = (displayName: string, userId: string) => `${displayName} (${userId})`;
export function searchText(product: InventoryProduct): string {
  return [`สินค้า ${product.productId}`, `สถานะ: ${product.inventoryStatus}`, `วันที่อัปโหลด: ${product.uploadDate ?? "ไม่พบข้อมูล"}`, product.airtableUrl].join("\n");
}
export const notFoundText = (productId: string) => `ไม่พบสินค้า ${productId}`;
export function alreadyOutText(product: InventoryProduct): string {
  return [`สินค้า ${product.productId} เป็น Out อยู่แล้ว`, `ราคาขาย: ${old(product.soldPrice)}`, `ขายเมื่อ: ${old(product.soldAt)}`, `บันทึกโดย: ${old(product.soldBy)}`, product.airtableUrl].join("\n");
}
export const saleValuesText = (values: SaleValues) => [`สถานะ: ${values.inventoryStatus}`, `ราคาขาย: ${old(values.soldPrice)}`, `ขายเมื่อ: ${old(values.soldAt)}`, `บันทึกโดย: ${old(values.soldBy)}`].join("\n");
```

```ts
// src/line/search.ts
import type { InventoryClient } from "./airtable-inventory";
import { helpText, notFoundText, searchText } from "./messages";
import type { ParsedCommand } from "./types";

export interface TriggerResult { status: "started" | "already_running" | "no_ready_run"; id?: string; }
export interface ReadOnlyDeps { inventory: Pick<InventoryClient, "findByProductId">; triggerUpload(): Promise<TriggerResult>; triggerDocs(): Promise<TriggerResult>; }

export async function handleReadOnlyCommand(command: Extract<ParsedCommand, { type: "help" | "search" | "upload" | "docs" }>, deps: ReadOnlyDeps): Promise<string> {
  if (command.type === "help") return helpText();
  if (command.type === "search") {
    const product = await deps.inventory.findByProductId(command.productId);
    return product ? searchText(product) : notFoundText(command.productId);
  }
  if (command.type === "upload") {
    const result = await deps.triggerUpload();
    return result.status === "started" ? `เริ่มนำเข้าแล้ว ${result.id ?? ""}`.trim() : "มีงานนำเข้ากำลังทำงานอยู่";
  }
  const result = await deps.triggerDocs();
  return result.status === "started" ? `เริ่มสร้างเอกสารแล้ว ${result.id ?? ""}`.trim() : "ยังไม่มี Publication Run ที่พร้อมวันนี้";
}
```

- [ ] **Step 4: Verify focused and full checks**

Run: `npx vitest run test/line/messages.test.ts test/line/search.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/line/messages.ts src/line/search.ts test/line/messages.test.ts test/line/search.test.ts
git commit -m "feat(line): add Thai help search and workflow commands"
```

---

### Task 8: Retry-safe sold-out prepare, direct mode, approval, and rejection

**Files:**
- Create: `src/line/soldout.ts`
- Test: `test/line/soldout.test.ts`

**Interfaces:**
- Consumes: `InventoryClient`, `LineRepository`, `Clock`, `IdGenerator`, message helpers.
- Produces:

```ts
export type CommandReply =
  | { kind: "text"; text: string }
  | {
      kind: "buttons";
      text: string;
      approveData: string;
      rejectData: string;
    };
export interface SoldoutDeps {
  inventory: InventoryClient;
  repo: LineRepository;
  clock: Clock;
  ids: IdGenerator;
}
export async function prepareSoldout(
  input: { productId: string; soldPrice: number },
  requester: LineActor,
  sourceEventId: string,
  confirmationEnabled: boolean,
  deps: SoldoutDeps,
): Promise<CommandReply>;
export async function resolveSoldout(
  decision: "approve" | "reject",
  token: string,
  actor: LineActor,
  applyEventId: string,
  correlationId: string,
  deps: SoldoutDeps,
): Promise<CommandReply>;
```

Every mutation first persists a pending command. Confirmation-disabled mode immediately approves that command with the original message event ID, so direct and confirmed paths share one recovery protocol. Before Airtable write, approval persists exact `after` values. If a retry sees Airtable already equal those values, it finalizes D1 action/audit state without writing again.

- [ ] **Step 1: Write failing behavior and recovery tests**

```ts
// test/line/soldout.test.ts
import { expect, it, vi } from "vitest";
import type { LineRepository } from "../../src/db/line-repository";
import type { InventoryClient } from "../../src/line/airtable-inventory";
import {
  prepareSoldout,
  resolveSoldout,
  type SoldoutDeps,
} from "../../src/line/soldout";
import type {
  InventoryProduct,
  PendingLineCommand,
} from "../../src/line/types";

const product: InventoryProduct = {
  recordId: "rec1",
  productId: "A-1",
  uploadDate: "2026-09-01",
  airtableUrl: "https://airtable/r",
  inventoryStatus: "In",
  soldPrice: null,
  soldAt: null,
  soldBy: null,
};
const actor = {
  userId: "U1",
  displayName: "Mint",
  groupId: "C1",
};

function soldoutPending(
  overrides: Partial<PendingLineCommand> = {},
): PendingLineCommand {
  return {
    token: "tok",
    sourceEventId: "evt-command",
    applyEventId: "evt-approve",
    kind: "soldout",
    status: "applying",
    requesterUserId: "U0",
    groupId: "C1",
    productId: "A-1",
    soldPrice: 1290,
    before: {
      inventoryStatus: "In",
      soldPrice: null,
      soldAt: null,
      soldBy: null,
    },
    after: {
      inventoryStatus: "Out",
      soldPrice: 1290,
      soldAt: null,
      soldBy: null,
    },
    targetActionId: null,
    expiresAt: "2026-09-01T10:10:00.000Z",
    ...overrides,
  };
}

function deps(found: InventoryProduct | null = product) {
  const inventory = {
    findByProductId: vi.fn().mockResolvedValue(found),
    updateSaleValues: vi.fn().mockResolvedValue(undefined),
  } satisfies InventoryClient;
  const repo = {
    claimEvent: vi.fn(),
    releaseEvent: vi.fn(),
    findPendingBySourceEvent: vi.fn().mockResolvedValue(null),
    createPending: vi.fn().mockImplementation(async (value) => value),
    claimPending: vi.fn(),
    setPendingAfter: vi.fn().mockResolvedValue(undefined),
    resetPending: vi.fn().mockResolvedValue(undefined),
    resolvePending: vi.fn().mockResolvedValue(undefined),
    finalizeAction: vi.fn().mockResolvedValue({ id: "act1" }),
    latestReversible: vi.fn(),
  } as unknown as LineRepository;
  return {
    inventory,
    repo,
    clock: {
      now: () =>
        new Date("2026-09-01T10:00:00.000Z"),
    },
    ids: { next: () => "tok" },
  } satisfies SoldoutDeps;
}

it("does not overwrite or create a command for an already-Out Product", async () => {
  const d = deps({
    ...product,
    inventoryStatus: "Out",
    soldPrice: 900,
  });

  const result = await prepareSoldout(
    { productId: "A-1", soldPrice: 1290 },
    actor,
    "evt-command",
    true,
    d,
  );

  expect(result.kind).toBe("text");
  expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  expect(d.repo.createPending).not.toHaveBeenCalled();
});

it("stores requester, source event, price, before state, and ten-minute expiry", async () => {
  const d = deps();

  const result = await prepareSoldout(
    { productId: "A-1", soldPrice: 1290 },
    actor,
    "evt-command",
    true,
    d,
  );

  expect(result.kind).toBe("buttons");
  expect(d.repo.createPending).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceEventId: "evt-command",
      requesterUserId: "U1",
      soldPrice: 1290,
      before: expect.objectContaining({
        inventoryStatus: "In",
      }),
      expiresAt: "2026-09-01T10:10:00.000Z",
    }),
  );
});

it("persists exact after state before Airtable write and uses approver as Sold By", async () => {
  const d = deps();
  d.repo.claimPending = vi.fn().mockResolvedValue(
    soldoutPending(),
  );

  await resolveSoldout(
    "approve",
    "tok",
    actor,
    "evt-approve",
    "corr",
    d,
  );

  const after = {
    inventoryStatus: "Out" as const,
    soldPrice: 1290,
    soldAt: "2026-09-01T10:00:00.000Z",
    soldBy: "Mint (U1)",
  };
  expect(d.repo.setPendingAfter)
    .toHaveBeenCalledWith("tok", "evt-approve", after);
  expect(d.inventory.updateSaleValues)
    .toHaveBeenCalledWith("rec1", after);
  expect(d.repo.finalizeAction).toHaveBeenCalledWith(
    expect.objectContaining({
      pendingToken: "tok",
      applyEventId: "evt-approve",
      after,
      actor: "Mint (U1)",
    }),
  );
});

it("keeps applying ownership when D1 finalization fails after mutation intent is durable", async () => {
  const d = deps();
  d.repo.claimPending = vi.fn().mockResolvedValue(
    soldoutPending(),
  );
  vi.mocked(d.repo.finalizeAction)
    .mockRejectedValueOnce(new Error("D1 unavailable"));

  await expect(
    resolveSoldout(
      "approve",
      "tok",
      actor,
      "evt-approve",
      "corr",
      d,
    ),
  ).rejects.toThrow("D1 unavailable");

  expect(d.repo.resetPending).not.toHaveBeenCalled();
});

it("recovers after Airtable succeeded but D1 finalization previously failed", async () => {
  const after = {
    inventoryStatus: "Out" as const,
    soldPrice: 1290,
    soldAt: "2026-09-01T09:59:00.000Z",
    soldBy: "Mint (U1)",
  };
  const d = deps({ ...product, ...after });
  d.repo.claimPending = vi.fn().mockResolvedValue(
    soldoutPending({ after }),
  );

  await resolveSoldout(
    "approve",
    "tok",
    actor,
    "evt-retry",
    "corr-retry",
    d,
  );

  expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  expect(d.repo.finalizeAction).toHaveBeenCalledTimes(1);
});

it("confirmation-disabled mode uses sender as approver through same pending protocol", async () => {
  const d = deps();
  d.repo.claimPending = vi.fn().mockResolvedValue(
    soldoutPending({ applyEventId: "evt-command" }),
  );

  await prepareSoldout(
    { productId: "A-1", soldPrice: 1290 },
    actor,
    "evt-command",
    false,
    d,
  );

  expect(d.repo.claimPending).toHaveBeenCalledWith(
    "tok",
    "C1",
    "soldout",
    "evt-command",
    "2026-09-01T10:00:00.000Z",
  );
  expect(d.repo.finalizeAction).toHaveBeenCalledWith(
    expect.objectContaining({ actor: "Mint (U1)" }),
  );
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run test/line/soldout.test.ts`
Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement sold-out flow**

```ts
// src/line/soldout.ts
import type { LineRepository } from "../db/line-repository";
import type { IdGenerator } from "../shared/ids";
import type { Clock } from "../shared/time";
import {
  matchesSaleValues,
  type InventoryClient,
} from "./airtable-inventory";
import {
  actorText,
  alreadyOutText,
  notFoundText,
} from "./messages";
import type {
  LineActor,
  PendingLineCommand,
  SaleValues,
} from "./types";

export type CommandReply =
  | { kind: "text"; text: string }
  | {
      kind: "buttons";
      text: string;
      approveData: string;
      rejectData: string;
    };

export interface SoldoutDeps {
  inventory: InventoryClient;
  repo: LineRepository;
  clock: Clock;
  ids: IdGenerator;
}

function saleReply(
  productId: string,
  soldPrice: number,
): CommandReply {
  return {
    kind: "text",
    text:
      `บันทึก ${productId} เป็น Out ราคา ` +
      `${soldPrice.toLocaleString("en-US")} บาท`,
  };
}

function confirmationReply(
  pending: PendingLineCommand,
): CommandReply {
  const price = pending.soldPrice;
  if (price === null) {
    throw new Error("soldout pending command has no price");
  }
  return {
    kind: "buttons",
    text:
      `ยืนยันขาย ${pending.productId} ราคา ` +
      `${price.toLocaleString("en-US")} บาท`,
    approveData:
      `action=soldout&decision=approve&token=${pending.token}`,
    rejectData:
      `action=soldout&decision=reject&token=${pending.token}`,
  };
}

export async function prepareSoldout(
  input: { productId: string; soldPrice: number },
  requester: LineActor,
  sourceEventId: string,
  confirmationEnabled: boolean,
  deps: SoldoutDeps,
): Promise<CommandReply> {
  const existing =
    await deps.repo.findPendingBySourceEvent(
      sourceEventId,
    );
  if (existing !== null) {
    return confirmationEnabled
      ? confirmationReply(existing)
      : resolveSoldout(
          "approve",
          existing.token,
          requester,
          sourceEventId,
          sourceEventId,
          deps,
        );
  }

  const product =
    await deps.inventory.findByProductId(
      input.productId,
    );
  if (product === null) {
    return {
      kind: "text",
      text: notFoundText(input.productId),
    };
  }
  if (product.inventoryStatus === "Out") {
    return {
      kind: "text",
      text: alreadyOutText(product),
    };
  }

  const before: SaleValues = {
    inventoryStatus: product.inventoryStatus,
    soldPrice: product.soldPrice,
    soldAt: product.soldAt,
    soldBy: product.soldBy,
  };
  const candidate: PendingLineCommand = {
    token: deps.ids.next(),
    sourceEventId,
    applyEventId: null,
    kind: "soldout",
    status: "pending",
    requesterUserId: requester.userId,
    groupId: requester.groupId,
    productId: input.productId,
    soldPrice: input.soldPrice,
    before,
    after: {
      inventoryStatus: "Out",
      soldPrice: input.soldPrice,
      soldAt: null,
      soldBy: null,
    },
    targetActionId: null,
    expiresAt: new Date(
      deps.clock.now().getTime() + 10 * 60_000,
    ).toISOString(),
  };
  const pending =
    await deps.repo.createPending(candidate) ??
    await deps.repo.findPendingBySourceEvent(
      sourceEventId,
    );
  if (pending === null) {
    throw new Error("pending soldout command was not persisted");
  }

  return confirmationEnabled
    ? confirmationReply(pending)
    : resolveSoldout(
        "approve",
        pending.token,
        requester,
        sourceEventId,
        sourceEventId,
        deps,
      );
}

export async function resolveSoldout(
  decision: "approve" | "reject",
  token: string,
  actor: LineActor,
  applyEventId: string,
  correlationId: string,
  deps: SoldoutDeps,
): Promise<CommandReply> {
  const nowIso = deps.clock.now().toISOString();
  const pending = await deps.repo.claimPending(
    token,
    actor.groupId,
    "soldout",
    applyEventId,
    nowIso,
  );
  if (pending === null) {
    return {
      kind: "text",
      text: "คำยืนยันหมดอายุหรือถูกใช้แล้ว",
    };
  }

  const resolver = actorText(
    actor.displayName,
    actor.userId,
  );
  if (decision === "reject") {
    await deps.repo.resolvePending(
      token,
      applyEventId,
      "rejected",
      resolver,
    );
    return {
      kind: "text",
      text: `ยกเลิกการขาย ${pending.productId}`,
    };
  }
  if (pending.soldPrice === null) {
    await deps.repo.resolvePending(
      token,
      applyEventId,
      "rejected",
      resolver,
    );
    return {
      kind: "text",
      text: "คำยืนยันราคาไม่ถูกต้อง",
    };
  }

  let mutationIntentPersisted =
    pending.after.soldAt !== null &&
    pending.after.soldBy !== null;
  try {
    const product =
      await deps.inventory.findByProductId(
        pending.productId,
      );
    if (product === null) {
      await deps.repo.resolvePending(
        token,
        applyEventId,
        "rejected",
        resolver,
      );
      return {
        kind: "text",
        text: notFoundText(pending.productId),
      };
    }

    const after: SaleValues =
      mutationIntentPersisted
        ? pending.after
        : {
            inventoryStatus: "Out",
            soldPrice: pending.soldPrice,
            soldAt: nowIso,
            soldBy: resolver,
          };
    if (!mutationIntentPersisted) {
      await deps.repo.setPendingAfter(
        token,
        applyEventId,
        after,
      );
      mutationIntentPersisted = true;
    }

    if (matchesSaleValues(product, pending.before)) {
      await deps.inventory.updateSaleValues(
        product.recordId,
        after,
      );
    } else if (!matchesSaleValues(product, after)) {
      await deps.repo.resolvePending(
        token,
        applyEventId,
        "rejected",
        resolver,
      );
      return {
        kind: "text",
        text:
          "ข้อมูลสินค้าเปลี่ยนแล้ว ไม่ได้เขียนทับ " +
          "กรุณาตรวจ Airtable",
      };
    }

    await deps.repo.finalizeAction({
      pendingToken: token,
      applyEventId,
      targetActionId: null,
      groupId: actor.groupId,
      productId: pending.productId,
      kind: "soldout",
      before: pending.before,
      after,
      actor: resolver,
      correlationId,
    });
    return saleReply(
      pending.productId,
      pending.soldPrice,
    );
  } catch (error) {
    if (!mutationIntentPersisted) {
      await deps.repo.resetPending(
        token,
        applyEventId,
      );
    }
    throw error;
  }
}
```

- [ ] **Step 4: Verify focused and full checks**

Run: `npx vitest run test/line/soldout.test.ts`
Expected: PASS — 6 tests.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/line/soldout.ts test/line/soldout.test.ts
git commit -m "feat(line): add retry-safe sold-out mutation"
```

---

### Task 9: Retry-safe conflict-checked `/revert`

**Files:**
- Create: `src/line/revert.ts`
- Test: `test/line/revert.test.ts`

**Interfaces:**
- Consumes: `SoldoutDeps`, latest same-group reversible action, and the pending/action protocol from Tasks 2 and 8.
- Produces:

```ts
export async function prepareRevert(
  requester: LineActor,
  sourceEventId: string,
  deps: SoldoutDeps,
): Promise<CommandReply>;
export async function resolveRevert(
  decision: "approve" | "reject",
  token: string,
  actor: LineActor,
  applyEventId: string,
  correlationId: string,
  deps: SoldoutDeps,
): Promise<CommandReply>;
```

`/revert` always creates a second confirmation. Approval accepts only the latest unreverted sold-out action from the same LINE group and only while Airtable equals either the action's recorded `after` state or the already-restored intended state from a prior partial attempt.

- [ ] **Step 1: Write failing confirmation, conflict, and recovery tests**

```ts
// test/line/revert.test.ts
import { expect, it, vi } from "vitest";
import type { LineRepository } from "../../src/db/line-repository";
import type { InventoryClient } from "../../src/line/airtable-inventory";
import {
  prepareRevert,
  resolveRevert,
} from "../../src/line/revert";
import type { SoldoutDeps } from "../../src/line/soldout";
import type {
  InventoryProduct,
  PendingLineCommand,
  ReversibleLineAction,
} from "../../src/line/types";

const original = {
  inventoryStatus: "In" as const,
  soldPrice: null,
  soldAt: null,
  soldBy: null,
};
const sold = {
  inventoryStatus: "Out" as const,
  soldPrice: 1290,
  soldAt: "2026-09-01T10:00:00.000Z",
  soldBy: "Mint (U1)",
};
const action: ReversibleLineAction = {
  id: "act1",
  pendingToken: "soldout-token",
  groupId: "C1",
  productId: "A-1",
  kind: "soldout",
  before: original,
  after: sold,
  actor: "Mint (U1)",
  correlationId: "corr-soldout",
  createdAt: "2026-09-01T10:00:00.000Z",
  revertedByActionId: null,
};
const actor = {
  userId: "U2",
  displayName: "Beam",
  groupId: "C1",
};

function product(
  values: typeof original | typeof sold,
): InventoryProduct {
  return {
    recordId: "rec1",
    productId: "A-1",
    uploadDate: null,
    airtableUrl: "https://airtable/r",
    ...values,
  };
}

function revertPending(
  overrides: Partial<PendingLineCommand> = {},
): PendingLineCommand {
  return {
    token: "tok",
    sourceEventId: "evt-revert",
    applyEventId: "evt-approve",
    kind: "revert",
    status: "applying",
    requesterUserId: "U2",
    groupId: "C1",
    productId: "A-1",
    soldPrice: null,
    before: sold,
    after: original,
    targetActionId: "act1",
    expiresAt: "2026-09-01T10:15:00.000Z",
    ...overrides,
  };
}

function deps(found: InventoryProduct | null = product(sold)) {
  const inventory = {
    findByProductId: vi.fn().mockResolvedValue(found),
    updateSaleValues: vi.fn().mockResolvedValue(undefined),
  } satisfies InventoryClient;
  const repo = {
    claimEvent: vi.fn(),
    releaseEvent: vi.fn(),
    findPendingBySourceEvent: vi.fn().mockResolvedValue(null),
    createPending: vi.fn().mockImplementation(async (value) => value),
    claimPending: vi.fn(),
    setPendingAfter: vi.fn(),
    resetPending: vi.fn().mockResolvedValue(undefined),
    resolvePending: vi.fn().mockResolvedValue(undefined),
    finalizeAction: vi.fn().mockResolvedValue({ id: "revert1" }),
    latestReversible: vi.fn().mockResolvedValue(action),
  } as unknown as LineRepository;
  return {
    inventory,
    repo,
    clock: {
      now: () =>
        new Date("2026-09-01T10:05:00.000Z"),
    },
    ids: { next: () => "tok" },
  } satisfies SoldoutDeps;
}

it("creates mandatory confirmation for latest same-group action", async () => {
  const d = deps();

  const result = await prepareRevert(
    actor,
    "evt-revert",
    d,
  );

  expect(result.kind).toBe("buttons");
  expect(d.repo.latestReversible).toHaveBeenCalledWith("C1");
  expect(d.repo.createPending).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceEventId: "evt-revert",
      kind: "revert",
      targetActionId: "act1",
      before: sold,
      after: original,
    }),
  );
});

it("refuses approval when Airtable has a newer edit", async () => {
  const d = deps(product({ ...sold, soldPrice: 1500 }));
  d.repo.claimPending = vi.fn().mockResolvedValue(
    revertPending(),
  );

  const result = await resolveRevert(
    "approve",
    "tok",
    actor,
    "evt-approve",
    "corr-revert",
    d,
  );

  expect(result.text).toContain("ข้อมูลสินค้าเปลี่ยนแล้ว");
  expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  expect(d.repo.resolvePending).toHaveBeenCalledWith(
    "tok",
    "evt-approve",
    "rejected",
    "Beam (U2)",
  );
});

it("rejects a pending row without an explicit target action", async () => {
  const d = deps();
  d.repo.claimPending = vi.fn().mockResolvedValue(
    revertPending({ targetActionId: null }),
  );

  await resolveRevert(
    "approve",
    "tok",
    actor,
    "evt-approve",
    "corr-revert",
    d,
  );

  expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  expect(d.repo.finalizeAction).not.toHaveBeenCalled();
});

it("recovers when Airtable was restored before D1 finalization", async () => {
  const d = deps(product(original));
  d.repo.claimPending = vi.fn().mockResolvedValue(
    revertPending(),
  );

  await resolveRevert(
    "approve",
    "tok",
    actor,
    "evt-approve",
    "corr-revert",
    d,
  );

  expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  expect(d.repo.finalizeAction).toHaveBeenCalledWith(
    expect.objectContaining({
      pendingToken: "tok",
      applyEventId: "evt-approve",
      targetActionId: "act1",
      kind: "revert",
      before: sold,
      after: original,
    }),
  );
});

it("does not release applying ownership after an uncertain Airtable write", async () => {
  const d = deps();
  d.repo.claimPending = vi.fn().mockResolvedValue(
    revertPending(),
  );
  d.inventory.updateSaleValues.mockRejectedValueOnce(
    new Error("response lost"),
  );

  await expect(
    resolveRevert(
      "approve",
      "tok",
      actor,
      "evt-approve",
      "corr-revert",
      d,
    ),
  ).rejects.toThrow("response lost");

  expect(d.repo.resetPending).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run test/line/revert.test.ts`
Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement revert flow**

```ts
// src/line/revert.ts
import { matchesSaleValues } from "./airtable-inventory";
import {
  actorText,
  notFoundText,
  saleValuesText,
} from "./messages";
import type {
  LineActor,
  PendingLineCommand,
} from "./types";
import type {
  CommandReply,
  SoldoutDeps,
} from "./soldout";

function confirmationReply(
  pending: PendingLineCommand,
): CommandReply {
  return {
    kind: "buttons",
    text:
      `ยืนยันย้อนกลับ ${pending.productId}\nจาก\n` +
      `${saleValuesText(pending.before)}\nเป็น\n` +
      saleValuesText(pending.after),
    approveData:
      `action=revert&decision=approve&token=${pending.token}`,
    rejectData:
      `action=revert&decision=reject&token=${pending.token}`,
  };
}

export async function prepareRevert(
  requester: LineActor,
  sourceEventId: string,
  deps: SoldoutDeps,
): Promise<CommandReply> {
  const existing =
    await deps.repo.findPendingBySourceEvent(
      sourceEventId,
    );
  if (existing !== null) {
    if (existing.kind !== "revert") {
      throw new Error(
        "source event belongs to another command",
      );
    }
    return confirmationReply(existing);
  }

  const action =
    await deps.repo.latestReversible(
      requester.groupId,
    );
  if (action === null) {
    return {
      kind: "text",
      text: "ไม่มีคำสั่งที่ย้อนกลับได้ในกลุ่มนี้",
    };
  }
  const product =
    await deps.inventory.findByProductId(
      action.productId,
    );
  if (product === null) {
    return {
      kind: "text",
      text: notFoundText(action.productId),
    };
  }
  if (!matchesSaleValues(product, action.after)) {
    return {
      kind: "text",
      text:
        "ข้อมูลสินค้าเปลี่ยนแล้ว " +
        "ไม่สามารถย้อนกลับโดยไม่เขียนทับข้อมูลใหม่",
    };
  }

  const candidate: PendingLineCommand = {
    token: deps.ids.next(),
    sourceEventId,
    applyEventId: null,
    kind: "revert",
    status: "pending",
    requesterUserId: requester.userId,
    groupId: requester.groupId,
    productId: action.productId,
    soldPrice: null,
    before: action.after,
    after: action.before,
    targetActionId: action.id,
    expiresAt: new Date(
      deps.clock.now().getTime() + 10 * 60_000,
    ).toISOString(),
  };
  const pending =
    await deps.repo.createPending(candidate);
  if (pending === null) {
    return {
      kind: "text",
      text: "มีคำยืนยันย้อนกลับรายการนี้อยู่แล้ว",
    };
  }
  return confirmationReply(pending);
}

export async function resolveRevert(
  decision: "approve" | "reject",
  token: string,
  actor: LineActor,
  applyEventId: string,
  correlationId: string,
  deps: SoldoutDeps,
): Promise<CommandReply> {
  const pending = await deps.repo.claimPending(
    token,
    actor.groupId,
    "revert",
    applyEventId,
    deps.clock.now().toISOString(),
  );
  if (pending === null) {
    return {
      kind: "text",
      text: "คำยืนยันหมดอายุหรือถูกใช้แล้ว",
    };
  }

  const resolver = actorText(
    actor.displayName,
    actor.userId,
  );
  if (decision === "reject") {
    await deps.repo.resolvePending(
      token,
      applyEventId,
      "rejected",
      resolver,
    );
    return {
      kind: "text",
      text: `ยกเลิกการย้อนกลับ ${pending.productId}`,
    };
  }
  if (pending.targetActionId === null) {
    await deps.repo.resolvePending(
      token,
      applyEventId,
      "rejected",
      resolver,
    );
    return {
      kind: "text",
      text: "คำยืนยันไม่มีรายการต้นทาง",
    };
  }

  let sideEffectMayExist = false;
  try {
    const product =
      await deps.inventory.findByProductId(
        pending.productId,
      );
    if (product === null) {
      await deps.repo.resolvePending(
        token,
        applyEventId,
        "rejected",
        resolver,
      );
      return {
        kind: "text",
        text: notFoundText(pending.productId),
      };
    }

    if (matchesSaleValues(product, pending.before)) {
      sideEffectMayExist = true;
      await deps.inventory.updateSaleValues(
        product.recordId,
        pending.after,
      );
    } else if (matchesSaleValues(product, pending.after)) {
      sideEffectMayExist = true;
    } else {
      await deps.repo.resolvePending(
        token,
        applyEventId,
        "rejected",
        resolver,
      );
      return {
        kind: "text",
        text:
          "ข้อมูลสินค้าเปลี่ยนแล้ว ไม่ได้เขียนทับ " +
          "กรุณาตรวจ Airtable",
      };
    }

    await deps.repo.finalizeAction({
      pendingToken: token,
      applyEventId,
      targetActionId: pending.targetActionId,
      groupId: actor.groupId,
      productId: pending.productId,
      kind: "revert",
      before: pending.before,
      after: pending.after,
      actor: resolver,
      correlationId,
    });
    return {
      kind: "text",
      text: `ย้อนกลับ ${pending.productId} สำเร็จ`,
    };
  } catch (error) {
    if (!sideEffectMayExist) {
      await deps.repo.resetPending(
        token,
        applyEventId,
      );
    }
    throw error;
  }
}
```

- [ ] **Step 4: Verify focused and full checks**

Run: `npx vitest run test/line/revert.test.ts`
Expected: PASS — 5 tests.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/line/revert.ts test/line/revert.test.ts
git commit -m "feat(line): add retry-safe revert"
```

---

### Task 10: Webhook orchestration, allowlist, dedupe, release-on-error, and route

**Files:**
- Create: `src/line/webhook.ts`
- Create: `src/routes/line.ts`
- Modify: `src/router.ts`
- Test: `test/line/webhook.test.ts`
- Test: `test/routes/line.test.ts`

**Interfaces:**
- Consumes: all prior LINE tasks, internal `handleUploadTrigger(env, "line")`, internal `handleDocsTrigger(env, "line")`, `AuditLog`, and `Env` secrets/config.
- Produces: `processLineEvents(events, deps)` and `handleLineRoute(request, env)`.

The route verifies HMAC over exact raw bytes before JSON parsing. Every supported event is atomically claimed before allowlist or command work. Successful and intentionally ignored events retain the claim; thrown processing errors delete it before propagating so LINE can retry safely.

- [ ] **Step 1: Write failing raw-route security and validation tests**

```ts
// test/routes/line.test.ts
import { expect, it, vi } from "vitest";
import { testEnv } from "../helpers/env";
import { handleLineRoute } from "../../src/routes/line";

async function sign(
  body: Uint8Array,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, body),
  );
  return btoa(String.fromCharCode(...bytes));
}

it("returns 401 before parsing an invalidly signed body", async () => {
  const process = vi.fn();
  const response = await handleLineRoute(
    new Request("https://worker/line/webhook", {
      method: "POST",
      headers: { "x-line-signature": "bad" },
      body: "not-json",
    }),
    {
      ...testEnv(),
      LINE_CHANNEL_SECRET: "secret",
    },
    { process },
  );

  expect(response.status).toBe(401);
  expect(process).not.toHaveBeenCalled();
});

it("passes only schema-validated supported events", async () => {
  const body = new TextEncoder().encode(
    JSON.stringify({
      events: [
        {
          type: "message",
          webhookEventId: "evt-1",
          replyToken: "reply-1",
          source: {
            type: "group",
            groupId: "C1",
            userId: "U1",
          },
          message: {
            type: "text",
            id: "msg-1",
            text: "/help",
          },
        },
        {
          type: "follow",
          webhookEventId: "ignored",
        },
      ],
    }),
  );
  const process = vi.fn().mockResolvedValue(undefined);
  const response = await handleLineRoute(
    new Request("https://worker/line/webhook", {
      method: "POST",
      headers: {
        "x-line-signature": await sign(body, "secret"),
      },
      body,
    }),
    {
      ...testEnv(),
      LINE_CHANNEL_SECRET: "secret",
    },
    { process },
  );

  expect(response.status).toBe(200);
  expect(process).toHaveBeenCalledWith([
    expect.objectContaining({ webhookEventId: "evt-1" }),
  ]);
});

it("returns 400 for a signed malformed top-level payload", async () => {
  const body = new TextEncoder().encode('{"events":"wrong"}');
  const response = await handleLineRoute(
    new Request("https://worker/line/webhook", {
      method: "POST",
      headers: {
        "x-line-signature": await sign(body, "secret"),
      },
      body,
    }),
    {
      ...testEnv(),
      LINE_CHANNEL_SECRET: "secret",
    },
    { process: vi.fn() },
  );

  expect(response.status).toBe(400);
});
```

- [ ] **Step 2: Write failing orchestration tests**

```ts
// test/line/webhook.test.ts
import { expect, it, vi } from "vitest";
import type { AuditLog } from "../../src/db/audit";
import type { LineRepository } from "../../src/db/line-repository";
import type { InventoryClient } from "../../src/line/airtable-inventory";
import type { LineClient } from "../../src/line/client";
import {
  processLineEvents,
  type WebhookDeps,
} from "../../src/line/webhook";
import type { SupportedLineEvent } from "../../src/line/types";

const event: SupportedLineEvent = {
  type: "message",
  webhookEventId: "evt-1",
  replyToken: "reply-1",
  source: {
    type: "group",
    groupId: "C1",
    userId: "U1",
  },
  message: {
    type: "text",
    id: "msg-1",
    text: "/help",
  },
};

function deps(): WebhookDeps {
  const repo = {
    claimEvent: vi.fn().mockResolvedValue(true),
    releaseEvent: vi.fn().mockResolvedValue(undefined),
    findPendingBySourceEvent: vi.fn(),
    createPending: vi.fn(),
    claimPending: vi.fn(),
    setPendingAfter: vi.fn(),
    resetPending: vi.fn(),
    resolvePending: vi.fn(),
    finalizeAction: vi.fn(),
    latestReversible: vi.fn(),
  } as unknown as LineRepository;
  const line = {
    pushMessage: vi.fn(),
    replyText: vi.fn().mockResolvedValue(undefined),
    replyButtons: vi.fn().mockResolvedValue(undefined),
    getGroupMemberProfile: vi.fn().mockResolvedValue({
      userId: "U1",
      displayName: "Mint",
    }),
  } satisfies LineClient;
  const inventory = {
    findByProductId: vi.fn(),
    updateSaleValues: vi.fn(),
  } satisfies InventoryClient;
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditLog;
  return {
    allowedGroupId: "C1",
    confirmationEnabled: true,
    clock: { now: () => new Date("2026-09-01T10:00:00.000Z") },
    ids: { next: () => "corr-1" },
    repo,
    audit,
    inventory,
    line,
    triggerUpload: vi.fn(),
    triggerDocs: vi.fn(),
  };
}

it("claims, ignores, and audits a disallowed group once", async () => {
  const d = deps();
  const disallowed: SupportedLineEvent = {
    ...event,
    source: { ...event.source, groupId: "OTHER" },
  };

  await processLineEvents([disallowed], d);

  expect(d.repo.claimEvent).toHaveBeenCalledWith(
    "evt-1",
    "OTHER",
  );
  expect(d.line.replyText).not.toHaveBeenCalled();
  expect(d.audit.record).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "line_disallowed_group",
    }),
  );
});

it("deduplicates before profile lookup and command execution", async () => {
  const d = deps();
  vi.mocked(d.repo.claimEvent)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);

  await processLineEvents([event, event], d);

  expect(d.line.getGroupMemberProfile).toHaveBeenCalledTimes(1);
  expect(d.line.replyText).toHaveBeenCalledTimes(1);
});

it("releases the event claim when command processing throws", async () => {
  const d = deps();
  vi.mocked(d.line.getGroupMemberProfile)
    .mockRejectedValueOnce(new Error("LINE unavailable"));

  await expect(
    processLineEvents([event], d),
  ).rejects.toThrow("LINE unavailable");

  expect(d.repo.releaseEvent).toHaveBeenCalledWith("evt-1");
});

it("passes source and applying webhook IDs into soldout lifecycle", async () => {
  const d = deps();
  const soldoutEvent: SupportedLineEvent = {
    ...event,
    message: {
      ...event.message,
      text: "/soldout A-1 ราคา 100",
    },
  };
  vi.mocked(d.inventory.findByProductId).mockResolvedValue({
    recordId: "rec1",
    productId: "A-1",
    uploadDate: null,
    airtableUrl: "https://airtable/r",
    inventoryStatus: "In",
    soldPrice: null,
    soldAt: null,
    soldBy: null,
  });
  vi.mocked(d.repo.findPendingBySourceEvent).mockResolvedValue(null);
  vi.mocked(d.repo.createPending).mockImplementation(
    async (value) => value,
  );

  await processLineEvents([soldoutEvent], d);

  expect(d.repo.createPending).toHaveBeenCalledWith(
    expect.objectContaining({ sourceEventId: "evt-1" }),
  );
});
```

- [ ] **Step 3: Run tests and verify failure**

Run: `npx vitest run test/routes/line.test.ts test/line/webhook.test.ts`
Expected: FAIL because route and orchestration modules do not exist.

- [ ] **Step 4: Implement orchestration**

```ts
// src/line/webhook.ts
import type { AuditLog } from "../db/audit";
import type { LineRepository } from "../db/line-repository";
import type { IdGenerator } from "../shared/ids";
import type { Clock } from "../shared/time";
import type { InventoryClient } from "./airtable-inventory";
import type { LineClient } from "./client";
import { parseErrorText } from "./messages";
import { parseLineCommand } from "./parser";
import {
  prepareRevert,
  resolveRevert,
} from "./revert";
import {
  handleReadOnlyCommand,
  type ReadOnlyDeps,
} from "./search";
import {
  prepareSoldout,
  resolveSoldout,
  type CommandReply,
  type SoldoutDeps,
} from "./soldout";
import type {
  LineActor,
  SupportedLineEvent,
} from "./types";

export interface WebhookDeps
  extends ReadOnlyDeps,
    SoldoutDeps {
  allowedGroupId: string;
  confirmationEnabled: boolean;
  line: LineClient;
  repo: LineRepository;
  audit: AuditLog;
  inventory: InventoryClient;
  clock: Clock;
  ids: IdGenerator;
}

function parsePostback(data: string): {
  action: "soldout" | "revert";
  decision: "approve" | "reject";
  token: string;
} | null {
  const values = new URLSearchParams(data);
  const action = values.get("action");
  const decision = values.get("decision");
  const token = values.get("token");
  if (
    (action !== "soldout" && action !== "revert") ||
    (decision !== "approve" && decision !== "reject") ||
    token === null ||
    token.length === 0
  ) {
    return null;
  }
  return { action, decision, token };
}

async function actorFor(
  event: SupportedLineEvent,
  line: LineClient,
): Promise<LineActor> {
  const profile =
    await line.getGroupMemberProfile(
      event.source.groupId,
      event.source.userId,
    );
  return {
    userId: profile.userId,
    displayName: profile.displayName,
    groupId: event.source.groupId,
  };
}

async function send(
  replyToken: string,
  reply: CommandReply,
  line: LineClient,
): Promise<void> {
  if (reply.kind === "text") {
    await line.replyText(replyToken, reply.text);
    return;
  }
  await line.replyButtons(
    replyToken,
    reply.text,
    reply.text,
    [
      {
        label: "ยืนยัน",
        data: reply.approveData,
        style: "primary",
      },
      {
        label: "ยกเลิก",
        data: reply.rejectData,
        style: "secondary",
      },
    ],
  );
}

export async function processLineEvents(
  events: SupportedLineEvent[],
  deps: WebhookDeps,
): Promise<void> {
  for (const event of events) {
    const claimed = await deps.repo.claimEvent(
      event.webhookEventId,
      event.source.groupId,
    );
    if (!claimed) {
      continue;
    }

    const correlationId = deps.ids.next();
    try {
      if (
        event.source.groupId !==
        deps.allowedGroupId
      ) {
        await deps.audit.record({
          correlationId,
          actor: `line:${event.source.userId}`,
          action: "line_disallowed_group",
          beforeValue: null,
          afterValue: null,
        });
        continue;
      }

      const actor = await actorFor(
        event,
        deps.line,
      );
      if (event.type === "postback") {
        const postback = parsePostback(
          event.postback.data,
        );
        if (postback === null) {
          await deps.line.replyText(
            event.replyToken,
            "คำยืนยันไม่ถูกต้อง",
          );
          continue;
        }
        const reply =
          postback.action === "soldout"
            ? await resolveSoldout(
                postback.decision,
                postback.token,
                actor,
                event.webhookEventId,
                correlationId,
                deps,
              )
            : await resolveRevert(
                postback.decision,
                postback.token,
                actor,
                event.webhookEventId,
                correlationId,
                deps,
              );
        await send(
          event.replyToken,
          reply,
          deps.line,
        );
        continue;
      }

      const parsed = parseLineCommand(
        event.message.text,
      );
      if (!parsed.ok) {
        await deps.line.replyText(
          event.replyToken,
          parseErrorText(parsed.code),
        );
        continue;
      }
      if (parsed.command.type === "soldout") {
        const reply = await prepareSoldout(
          parsed.command,
          actor,
          event.webhookEventId,
          deps.confirmationEnabled,
          deps,
        );
        await send(event.replyToken, reply, deps.line);
        continue;
      }
      if (parsed.command.type === "revert") {
        const reply = await prepareRevert(
          actor,
          event.webhookEventId,
          deps,
        );
        await send(event.replyToken, reply, deps.line);
        continue;
      }
      await deps.line.replyText(
        event.replyToken,
        await handleReadOnlyCommand(
          parsed.command,
          deps,
        ),
      );
    } catch (error) {
      await deps.repo.releaseEvent(
        event.webhookEventId,
      );
      throw error;
    }
  }
}
```

- [ ] **Step 5: Implement raw-body route and internal trigger wiring**

```ts
// src/routes/line.ts
import { z } from "zod";
import { parseConfig } from "../config";
import { createAuditLog } from "../db/audit";
import { createLineRepository } from "../db/line-repository";
import type { Env } from "../env";
import { createInventoryClient } from "../line/airtable-inventory";
import { createLineClient } from "../line/client";
import { verifyLineSignature } from "../line/signature";
import { parseSupportedLineEvents } from "../line/types";
import { processLineEvents } from "../line/webhook";
import type { SupportedLineEvent } from "../line/types";
import { handleDocsTrigger } from "./docs";
import { handleUploadTrigger } from "./upload";

const ImportTriggerResponseSchema = z.object({
  status: z.string(),
  importRunId: z.string().optional(),
});
const DocsTriggerResponseSchema = z.object({
  status: z.string(),
  publicationRunId: z.string().optional(),
});

export interface LineRouteOverride {
  process(events: SupportedLineEvent[]): Promise<void>;
}

export async function handleLineRoute(
  request: Request,
  env: Env,
  override?: LineRouteOverride,
): Promise<Response> {
  const rawBody = await request.arrayBuffer();
  const signature =
    request.headers.get("x-line-signature") ?? "";
  if (
    !await verifyLineSignature(
      rawBody,
      signature,
      env.LINE_CHANNEL_SECRET,
    )
  ) {
    return new Response("unauthorized", { status: 401 });
  }

  let events: SupportedLineEvent[];
  try {
    const body: unknown = JSON.parse(
      new TextDecoder().decode(rawBody),
    );
    events = parseSupportedLineEvents(body);
  } catch {
    return new Response("invalid payload", { status: 400 });
  }

  if (override !== undefined) {
    await override.process(events);
    return new Response("ok");
  }

  const config = parseConfig(env.APP_CONFIG_JSON);
  const clock = { now: () => new Date() };
  const ids = { next: () => crypto.randomUUID() };
  const line = createLineClient({
    channelAccessToken:
      env.LINE_CHANNEL_ACCESS_TOKEN,
    fetch,
  });
  await processLineEvents(events, {
    allowedGroupId: config.lineAllowedGroupId,
    confirmationEnabled:
      config.soldoutConfirmationEnabled,
    line,
    clock,
    ids,
    repo: createLineRepository(
      env.DB,
      ids,
      clock,
    ),
    audit: createAuditLog(env.DB, ids, clock),
    inventory: createInventoryClient({
      baseId: config.airtableBaseId,
      tableId: config.airtableProductsTableId,
      token: env.AIRTABLE_TOKEN,
      fetch,
      now: clock.now,
    }),
    async triggerUpload() {
      const response =
        await handleUploadTrigger(env, "line");
      const body = ImportTriggerResponseSchema.parse(
        await response.json(),
      );
      return {
        status:
          body.status === "started"
            ? "started"
            : "already_running",
        id: body.importRunId,
      };
    },
    async triggerDocs() {
      const response =
        await handleDocsTrigger(env, "line");
      const body = DocsTriggerResponseSchema.parse(
        await response.json(),
      );
      return {
        status:
          body.status === "started"
            ? "started"
            : "no_ready_run",
        id: body.publicationRunId,
      };
    },
  });
  return new Response("ok");
}
```

Register this exact branch in `src/router.ts` before any generic 404 return:

```ts
if (
  request.method === "POST" &&
  url.pathname === "/line/webhook"
) {
  return handleLineRoute(request, env);
}
```

Add this exact import to `src/router.ts`:

```ts
import { handleLineRoute } from "./routes/line";
```

- [ ] **Step 6: Verify focused and full checks**

Run: `npx vitest run test/routes/line.test.ts test/line/webhook.test.ts`
Expected: PASS — 7 tests.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/line/webhook.ts src/routes/line.ts src/router.ts test/line/webhook.test.ts test/routes/line.test.ts
git commit -m "feat(line): route retry-safe webhook commands"
```

---

### Task 11: Thirty-case LINE acceptance suite

**Files:**
- Create: `test/acceptance/line-acceptance.test.ts`

**Interfaces:**
- Consumes: public parser, sold-out, revert, repository, and route interfaces from Tasks 1–10.
- Produces: explicit acceptance evidence for exactly 20 parser cases and 10 command/state cases.

- [ ] **Step 1: Create exact 30-case parser and state matrix**

```ts
// test/acceptance/line-acceptance.test.ts
import { describe, expect, it, vi } from "vitest";
import type { LineRepository } from "../../src/db/line-repository";
import type { InventoryClient } from "../../src/line/airtable-inventory";
import { parseLineCommand } from "../../src/line/parser";
import {
  prepareRevert,
  resolveRevert,
} from "../../src/line/revert";
import {
  prepareSoldout,
  resolveSoldout,
  type SoldoutDeps,
} from "../../src/line/soldout";
import type {
  InventoryProduct,
  PendingLineCommand,
  ReversibleLineAction,
  SaleValues,
} from "../../src/line/types";

const parserCases: Array<[
  text: string,
  ok: boolean,
  typeOrCode: string,
]> = [
  ["/help", true, "help"],
  ["/upload", true, "upload"],
  ["/docs", true, "docs"],
  ["/revert", true, "revert"],
  ["/search A-1234", true, "search"],
  ["/search A1234", false, "invalid_product_id"],
  ["/search A 1234", false, "invalid_product_id"],
  ["/soldout A-1234 thb 1290", true, "soldout"],
  ["/soldout A-1234 THB 1,290", true, "soldout"],
  ["/soldout รหัส 1234 ราคา 1290", true, "soldout"],
  [
    "/soldout รหัสสินค้า 1234 ราคา 1,290 บาท",
    true,
    "soldout",
  ],
  ["/soldout A1234 ราคา 1290", false, "invalid_product_id"],
  ["/soldout A 1234 ราคา 1290", false, "invalid_product_id"],
  ["/soldout ราคา 1290", false, "missing_product_id"],
  ["/soldout A-1", false, "missing_price"],
  [
    "/soldout A-1 A-2 ราคา 1290",
    false,
    "multiple_product_ids",
  ],
  [
    "/soldout A-1 ราคา 100 ราคา 200",
    false,
    "multiple_prices",
  ],
  ["/soldout A-1 thb 12.50", false, "invalid_price"],
  ["/soldout A-1 ราคา 1,29 บาท", false, "invalid_price"],
  ["hello", false, "unknown_command"],
];

const original: SaleValues = {
  inventoryStatus: "In",
  soldPrice: null,
  soldAt: null,
  soldBy: null,
};
const sold: SaleValues = {
  inventoryStatus: "Out",
  soldPrice: 100,
  soldAt: "2026-09-01T10:00:00.000Z",
  soldBy: "Mint (U1)",
};

function actor() {
  return {
    userId: "U1",
    displayName: "Mint",
    groupId: "C1",
  };
}

function product(values: SaleValues): InventoryProduct {
  return {
    recordId: "rec1",
    productId: "A-1",
    uploadDate: "2026-09-01",
    airtableUrl: "https://airtable/r",
    ...values,
  };
}

function action(): ReversibleLineAction {
  return {
    id: "act1",
    pendingToken: "soldout-token",
    groupId: "C1",
    productId: "A-1",
    kind: "soldout",
    before: original,
    after: sold,
    actor: "Mint (U1)",
    correlationId: "corr-soldout",
    createdAt: "2026-09-01T10:00:00.000Z",
    revertedByActionId: null,
  };
}

function pending(
  kind: "soldout" | "revert",
): PendingLineCommand {
  return {
    token: "tok",
    sourceEventId:
      kind === "soldout"
        ? "evt-soldout"
        : "evt-revert",
    applyEventId: "evt-approve",
    kind,
    status: "applying",
    requesterUserId: "U0",
    groupId: "C1",
    productId: "A-1",
    soldPrice: kind === "soldout" ? 100 : null,
    before: kind === "soldout" ? original : sold,
    after:
      kind === "soldout"
        ? {
            inventoryStatus: "Out",
            soldPrice: 100,
            soldAt: null,
            soldBy: null,
          }
        : original,
    targetActionId: kind === "revert" ? "act1" : null,
    expiresAt: "2026-09-01T10:10:00.000Z",
  };
}

function deps(
  found: InventoryProduct | null,
): SoldoutDeps {
  const inventory = {
    findByProductId: vi.fn().mockResolvedValue(found),
    updateSaleValues: vi.fn().mockResolvedValue(undefined),
  } satisfies InventoryClient;
  const repo = {
    claimEvent: vi.fn(),
    releaseEvent: vi.fn(),
    findPendingBySourceEvent: vi.fn().mockResolvedValue(null),
    createPending: vi.fn().mockImplementation(async (value) => value),
    claimPending: vi.fn().mockResolvedValue(pending("soldout")),
    setPendingAfter: vi.fn().mockResolvedValue(undefined),
    resetPending: vi.fn().mockResolvedValue(undefined),
    resolvePending: vi.fn().mockResolvedValue(undefined),
    finalizeAction: vi.fn().mockResolvedValue({ id: "action-new" }),
    latestReversible: vi.fn().mockResolvedValue(action()),
  } as unknown as LineRepository;
  return {
    clock: {
      now: () =>
        new Date("2026-09-01T10:00:00.000Z"),
    },
    ids: { next: () => "tok" },
    inventory,
    repo,
  };
}

describe("LINE acceptance: exactly 30 cases", () => {
  it.each(parserCases)(
    "parser: %s",
    (text, ok, typeOrCode) => {
      const result = parseLineCommand(text);
      expect(result.ok).toBe(ok);
      expect(
        result.ok
          ? result.command.type
          : result.code,
      ).toBe(typeOrCode);
    },
  );

  it("21 unknown Product returns not found", async () => {
    const result = await prepareSoldout(
      { productId: "A-404", soldPrice: 100 },
      actor(),
      "evt-command",
      true,
      deps(null),
    );
    expect(result.text).toContain("ไม่พบสินค้า");
  });

  it("22 already-Out does not mutate", async () => {
    const d = deps(product(sold));
    await prepareSoldout(
      { productId: "A-1", soldPrice: 100 },
      actor(),
      "evt-command",
      true,
      d,
    );
    expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  });

  it("23 confirmation stores ten-minute expiry", async () => {
    const d = deps(product(original));
    await prepareSoldout(
      { productId: "A-1", soldPrice: 100 },
      actor(),
      "evt-command",
      true,
      d,
    );
    expect(d.repo.createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: "2026-09-01T10:10:00.000Z",
      }),
    );
  });

  it("24 disabled confirmation uses durable mutation path", async () => {
    const d = deps(product(original));
    vi.mocked(d.repo.claimPending).mockResolvedValue({
      ...pending("soldout"),
      applyEventId: "evt-command",
    });
    await prepareSoldout(
      { productId: "A-1", soldPrice: 100 },
      actor(),
      "evt-command",
      false,
      d,
    );
    expect(d.inventory.updateSaleValues).toHaveBeenCalledTimes(1);
    expect(d.repo.finalizeAction).toHaveBeenCalledTimes(1);
  });

  it("25 duplicate or expired soldout callback does nothing", async () => {
    const d = deps(product(original));
    vi.mocked(d.repo.claimPending).mockResolvedValue(null);
    await resolveSoldout(
      "approve",
      "used",
      actor(),
      "evt-approve",
      "corr",
      d,
    );
    expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  });

  it("26 soldout approver becomes Sold By", async () => {
    const d = deps(product(original));
    await resolveSoldout(
      "approve",
      "tok",
      actor(),
      "evt-approve",
      "corr",
      d,
    );
    expect(d.inventory.updateSaleValues).toHaveBeenCalledWith(
      "rec1",
      expect.objectContaining({ soldBy: "Mint (U1)" }),
    );
  });

  it("27 revert reads only same-group latest action", async () => {
    const d = deps(product(sold));
    await prepareRevert(actor(), "evt-revert", d);
    expect(d.repo.latestReversible).toHaveBeenCalledWith("C1");
  });

  it("28 revert always creates confirmation", async () => {
    const d = deps(product(sold));
    const result = await prepareRevert(
      actor(),
      "evt-revert",
      d,
    );
    expect(result.kind).toBe("buttons");
  });

  it("29 revert refuses newer Airtable edit", async () => {
    const d = deps(product({ ...sold, soldPrice: 200 }));
    vi.mocked(d.repo.claimPending).mockResolvedValue(
      pending("revert"),
    );
    await resolveRevert(
      "approve",
      "tok",
      actor(),
      "evt-approve",
      "corr",
      d,
    );
    expect(d.inventory.updateSaleValues).not.toHaveBeenCalled();
  });

  it("30 revert restores exact values and finalizes target action", async () => {
    const d = deps(product(sold));
    vi.mocked(d.repo.claimPending).mockResolvedValue(
      pending("revert"),
    );
    await resolveRevert(
      "approve",
      "tok",
      actor(),
      "evt-approve",
      "corr",
      d,
    );
    expect(d.inventory.updateSaleValues).toHaveBeenCalledWith(
      "rec1",
      original,
    );
    expect(d.repo.finalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActionId: "act1",
        kind: "revert",
      }),
    );
  });
});
```

- [ ] **Step 2: Run acceptance suite**

Run: `npx vitest run test/acceptance/line-acceptance.test.ts`
Expected: PASS — exactly 30 cases.

- [ ] **Step 3: Run all LINE tests and full check**

Run: `npx vitest run test/line test/routes/line.test.ts test/db/line-repository.test.ts test/acceptance/line-acceptance.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/acceptance/line-acceptance.test.ts
git commit -m "test(line): cover thirty command and mutation cases"
```

## Self-Review Results

### Spec coverage

- Signature before JSON parsing: Task 3 and Task 10.
- Allowlisted group and ignored-group audit: Task 10.
- Event and postback deduplication: Tasks 2 and 10.
- `/help`, `/search`, `/upload`, `/docs`: Task 7 and Task 10.
- Exact one-Product/one-price grammar: Task 4 and Task 11.
- Already-Out display with legacy missing fields: Tasks 6–8.
- Optional ten-minute confirmation and actor semantics: Task 8.
- One-time/expired callback behavior: Tasks 2, 8, and 11.
- Same-group latest reversible action, mandatory second confirmation, and newer-edit refusal: Task 9.
- Immutable command audit: Tasks 2, 8, 9, and 10.
- Thirty acceptance cases: Task 11.

### Deliberate exclusions

- No buyer identity: `Sold By` records staff actor only, per approved spec.
- No multiple-product sold-out command.
- No iCloud date link in `/search` because Shared Albums do not provide stable per-date links.
- No reversal of `/upload` or `/docs`; only successful `soldout` actions are candidates.
- No dashboard, queue, framework, or second confirmation store beyond D1.

### Type and trust-boundary checks

- `LineRepository`, `InventoryClient`, `LineClient`, `SoldoutDeps`, and `WebhookDeps` names remain identical across consuming tasks.
- Raw signature bytes are verified before `JSON.parse`.
- Money remains integer baht.
- Airtable writes touch only `Inventory Status`, `Sold Price`, `Sold At`, `Sold By`, and `Last System Update`.
- Secrets enter clients through `Env`; none enter `APP_CONFIG_JSON`, D1 rows, messages, or audit values.
