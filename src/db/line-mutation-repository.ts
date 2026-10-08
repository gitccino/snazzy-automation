import type { Clock } from '../shared/time';
import { OperationalError } from '../shared/errors';
import type { SaleValues } from '../line/types';
import { parseAction, parsePending } from './line-repository';

export function createLineMutationRepository(db: D1Database, clock: Clock) {
  const now = () => clock.now().toISOString();
  return {
    async operation(token: string) {
      const row = await db.prepare('SELECT * FROM pending_line_commands WHERE token = ?').bind(token).first<Record<string, unknown>>();
      return row ? parsePending(row) : null;
    },
    async findApplying(productId: string) {
      const row = await db.prepare("SELECT * FROM pending_line_commands WHERE product_id = ? AND status = 'applying'").bind(productId).first<Record<string, unknown>>();
      return row ? parsePending(row) : null;
    },
    async context(token: string) {
      return db.prepare('SELECT workflow_id, mutation_actor, mutation_correlation_id, monitoring_state FROM pending_line_commands WHERE token = ?')
        .bind(token).first<{ workflow_id: string | null; mutation_actor: string | null; mutation_correlation_id: string | null; monitoring_state: string | null }>();
    },
    async setOperationOwner(token: string, owner: string, actor?: string, correlationId?: string) {
      const result = await db.prepare(`UPDATE pending_line_commands SET workflow_id = ?,
        mutation_actor = COALESCE(mutation_actor, ?), mutation_correlation_id = COALESCE(mutation_correlation_id, ?)
        WHERE token = ? AND status = 'applying' AND (workflow_id IS NULL OR workflow_id = ?)
          AND NOT EXISTS (SELECT 1 FROM line_product_control WHERE product_id = pending_line_commands.product_id)`)
        .bind(owner, actor ?? null, correlationId ?? null, token, owner).run();
      if (!result.meta.changes) throw new OperationalError('line_mutation_owner_changed', 'Operation no longer owned', false);
    },
    async control(productId: string) {
      return db.prepare('SELECT owner_workflow_id, mode, pending_token FROM line_product_control WHERE product_id = ?')
        .bind(productId).first<{ owner_workflow_id: string; mode: 'recovery' | 'repair'; pending_token: string }>();
    },
    async acquire(productId: string, owner: string, mode: 'recovery' | 'repair', token: string) {
      const result = await db.prepare(`INSERT OR IGNORE INTO line_product_control
        (product_id, owner_workflow_id, mode, pending_token, acquired_at)
        SELECT ?, ?, ?, ?, ? WHERE (? = 'recovery' AND EXISTS (SELECT 1 FROM pending_line_commands WHERE token = ? AND product_id = ? AND status = 'applying')) OR NOT EXISTS (
          SELECT 1 FROM pending_line_commands WHERE product_id = ? AND status IN ('pending','applying'))`)
        .bind(productId, owner, mode, token, now(), mode, token, productId, productId).run();
      if (result.meta.changes) return true;
      const existing = await db.prepare('SELECT owner_workflow_id, mode, pending_token FROM line_product_control WHERE product_id = ?').bind(productId).first<{owner_workflow_id:string;mode:string;pending_token:string}>();
      return existing?.owner_workflow_id === owner && existing.mode === mode && existing.pending_token === token;
    },
    async reclaim(productId: string, previous: string, owner: string) {
      return (await db.prepare('UPDATE line_product_control SET owner_workflow_id = ?, acquired_at = ? WHERE product_id = ? AND owner_workflow_id = ?')
        .bind(owner, now(), productId, previous).run()).meta.changes === 1;
    },
    async release(productId: string, owner: string) {
      return (await db.prepare('DELETE FROM line_product_control WHERE product_id = ? AND owner_workflow_id = ?').bind(productId, owner).run()).meta.changes === 1;
    },
    async assertWritable(token: string, owner: string, repair = false) {
      const row = await db.prepare(`SELECT p.token FROM pending_line_commands p WHERE p.token = ? AND
        ((? = 0 AND p.status = 'applying' AND p.workflow_id = ? AND NOT EXISTS (SELECT 1 FROM line_product_control WHERE product_id = p.product_id))
        OR (? = 1 AND EXISTS (SELECT 1 FROM line_product_control WHERE product_id = p.product_id AND mode = 'repair' AND owner_workflow_id = ?)))`)
        .bind(token, repair ? 1 : 0, owner, repair ? 1 : 0, owner).first();
      if (!row) throw new OperationalError('line_mutation_owner_changed', 'Operation no longer owned', false);
    },
    async beginAttempt(input: { id: string; token: string; recordId: string; intended: SaleValues; owner: string; repair?: boolean }) {
      await this.assertWritable(input.token, input.owner, input.repair);
      await db.prepare(`INSERT INTO line_mutation_attempts (id,pending_token,record_id,intended_json,started_at) VALUES (?,?,?,?,?)`)
        .bind(input.id, input.token, input.recordId, JSON.stringify(input.intended), now()).run();
    },
    async finishAttempt(id: string, outcome: 'acknowledged' | 'rejected', category: string) {
      await db.prepare("UPDATE line_mutation_attempts SET outcome = ?, completed_at = ?, response_category = ? WHERE id = ? AND outcome = 'unknown'")
        .bind(outcome, now(), category, id).run();
    },
    async hasUnknownAttempt(token: string) {
      const row = await db.prepare("SELECT COUNT(*) AS total, SUM(outcome = 'unknown') AS uncertain FROM line_mutation_attempts WHERE pending_token = ?")
        .bind(token).first<{total:number;uncertain:number|null}>();
      return !row?.total || !!row.uncertain;
    },
    async failOwned(token: string, owner: string, reason: string) {
      return (await db.prepare(`UPDATE pending_line_commands SET status = 'failed', resolution_reason = ?, resolved_at = ?,
        resolution_action_seq = (SELECT COALESCE(MAX(commit_seq),0) FROM line_actions WHERE product_id = pending_line_commands.product_id)
        WHERE token = ? AND status = 'applying' AND EXISTS (
          SELECT 1 FROM line_product_control WHERE product_id = pending_line_commands.product_id AND owner_workflow_id = ? AND mode = 'recovery')`)
        .bind(reason, now(), token, owner).run()).meta.changes === 1;
    },
    async latestConfirmed(productId: string) {
      const row = await db.prepare('SELECT * FROM line_actions WHERE product_id = ? ORDER BY commit_seq DESC LIMIT 1').bind(productId).first<Record<string, unknown>>();
      return row ? { ...parseAction(row), commitSeq: Number(row.commit_seq) } : null;
    },
    async superseded(productId: string) {
      const rows = await db.prepare("SELECT * FROM pending_line_commands WHERE product_id = ? AND status = 'failed' AND monitoring_state IS NOT NULL ORDER BY rowid")
        .bind(productId).all<Record<string, unknown>>();
      return rows.results.map(row => ({ ...parsePending(row), resolutionSeq: Number(row.resolution_action_seq ?? 0) }));
    },
    async monitors(productId: string) {
      return (await db.prepare("SELECT token FROM pending_line_commands WHERE product_id = ? AND monitoring_state = 'registered'").bind(productId).all<{token:string}>()).results;
    },
    async markMonitoring(token: string, state: 'registered' | 'ended' | 'unresolved') {
      await db.prepare('UPDATE pending_line_commands SET monitoring_state = ? WHERE token = ?').bind(state, token).run();
    },
    async audit(token: string, action: string, before: SaleValues, after: SaleValues, id: string) {
      await db.prepare(`INSERT OR IGNORE INTO audit_events (id,correlation_id,actor,action,before_value,after_value,created_at) VALUES (?,?, 'system',?,?,?,?)`)
        .bind(id, token, action, JSON.stringify(before), JSON.stringify(after), now()).run();
    },
  };
}
export type LineMutationRepository = ReturnType<typeof createLineMutationRepository>;
