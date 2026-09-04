import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";
import { createAuditLog } from "../../src/db/audit";
import { fixedClock, sequentialIdGenerator } from "../helpers/fakes";

describe("audit log", () => {
  it("appends one immutable row per record() call", async () => {
    const env = testEnv();
    const log = createAuditLog(env.DB, sequentialIdGenerator("audit"), fixedClock("2026-09-01T09:00:00.000Z"));
    const correlationId = crypto.randomUUID();

    await log.record({ correlationId, actor: "system:import", action: "product_id_allocated", beforeValue: null, afterValue: "A-501" });

    const row = await env.DB
      .prepare(`SELECT correlation_id, actor, action, before_value, after_value, created_at FROM audit_events WHERE correlation_id = ?`)
      .bind(correlationId)
      .first<{ correlation_id: string; actor: string; action: string; before_value: string | null; after_value: string | null; created_at: string }>();

    expect(row).toEqual({
      correlation_id: correlationId,
      actor: "system:import",
      action: "product_id_allocated",
      before_value: null,
      after_value: "A-501",
      created_at: "2026-09-01T09:00:00.000Z",
    });
  });
});
