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

function sameSaleValues(left: SaleValues, right: SaleValues): boolean {
  return left.inventoryStatus === right.inventoryStatus
    && left.soldPrice === right.soldPrice
    && left.soldAt === right.soldAt
    && left.soldBy === right.soldBy;
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
          AND ((status = 'applying' AND apply_event_id = ?)
            OR (status = 'pending' AND expires_at > ?
              AND (kind != 'revert' OR target_action_id = (
                SELECT id FROM line_actions
                WHERE group_id = ? AND kind = 'soldout'
                  AND reverted_by_action_id IS NULL
                ORDER BY created_at DESC, rowid DESC LIMIT 1
              )))) RETURNING *`)
        .bind(eventId, token, groupId, kind, eventId, nowIso, groupId).first<Record<string, unknown>>();
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
      const pendingRow = await db.prepare(
        "SELECT * FROM pending_line_commands WHERE token = ?",
      ).bind(input.pendingToken).first<Record<string, unknown>>();
      if (pendingRow === null) {
        throw new Error("pending command is not owned by this event");
      }
      const pending = parsePending(pendingRow);
      if (pending.applyEventId !== input.applyEventId) {
        throw new Error("pending command is not owned by this event");
      }
      if (pending.groupId !== input.groupId
        || pending.kind !== input.kind
        || pending.productId !== input.productId
        || pending.targetActionId !== input.targetActionId
        || !sameSaleValues(pending.before, input.before)
        || !sameSaleValues(pending.after, input.after)) {
        throw new Error("action input does not match owned pending command");
      }

      const existing = await db.prepare(
        "SELECT * FROM line_actions WHERE pending_token = ?",
      ).bind(input.pendingToken).first<Record<string, unknown>>();
      if (existing) return parseAction(existing);

      if (pending.status !== "applying") {
        throw new Error("pending command is not owned by this event");
      }

      if (pending.targetActionId !== null) {
        const target = await db.prepare(
          `SELECT id FROM line_actions
           WHERE id = ? AND group_id = ?
             AND kind = 'soldout'
             AND product_id = ?
             AND reverted_by_action_id IS NULL`,
        ).bind(
          pending.targetActionId,
          pending.groupId,
          pending.productId,
        ).first();
        if (target === null) {
          throw new Error("revert target is no longer reversible");
        }
      }

      const action: ReversibleLineAction = {
        id: ids.next(),
        pendingToken: pending.token,
        groupId: pending.groupId,
        productId: pending.productId,
        kind: pending.kind,
        before: pending.before,
        after: pending.after,
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
      if (pending.targetActionId !== null) {
        statements.splice(
          1,
          0,
          db.prepare(
            `UPDATE line_actions SET reverted_by_action_id = ?
             WHERE id = ? AND group_id = ?
               AND reverted_by_action_id IS NULL`,
          ).bind(
            action.id,
            pending.targetActionId,
            pending.groupId,
          ),
        );
      }
      try {
        await db.batch(statements);
      } catch (error) {
        const concurrent = await db.prepare(
          "SELECT * FROM line_actions WHERE pending_token = ?",
        ).bind(input.pendingToken).first<Record<string, unknown>>();
        if (concurrent) return parseAction(concurrent);
        throw error;
      }
      return action;
    },
    async latestReversible(groupId) {
      const row = await db.prepare(`SELECT * FROM line_actions WHERE group_id = ? AND kind = 'soldout' AND reverted_by_action_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`)
        .bind(groupId).first<Record<string, unknown>>();
      return row ? parseAction(row) : null;
    },
  };
}
