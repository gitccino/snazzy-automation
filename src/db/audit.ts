import type { Clock, IdGenerator } from "../env";

export interface AuditEntry {
  correlationId: string;
  actor: string;
  action: string;
  beforeValue: string | null;
  afterValue: string | null;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

export function createAuditLog(db: D1Database, ids: IdGenerator, clock: Clock): AuditLog {
  return {
    async record(entry) {
      await db
        .prepare(
          `INSERT INTO audit_events (id, correlation_id, actor, action, before_value, after_value, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(ids.next(), entry.correlationId, entry.actor, entry.action, entry.beforeValue, entry.afterValue, clock.now().toISOString())
        .run();
    },
  };
}
