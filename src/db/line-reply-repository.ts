import { validateReplyMessages } from '../line/client';
import type { Clock } from '../shared/time';
import type { LineReplyMessage, RejectionDisposition, TerminalResultV1 } from '../line/reply-types';

export type OutboxHead = {
  sequence: number; groupId: string; state: string; result: TerminalResultV1;
};
export type PrepareDispatchInput = {
  eventId: string; groupId: string; workflowId: string; receivedAt: string;
  candidateSequence: number | null; messages: LineReplyMessage[];
};
export function createLineReplyRepository(db: D1Database, clock: Clock) {
  const now = () => clock.now().toISOString();
  async function transition(eventId: string, phase: string, state: string, disposition: string | null = null, requestId: string | null = null) {
    await db.batch([
      db.prepare(`UPDATE line_reply_dispatches SET phase=?, disposition=?, request_id=?, updated_at=?
        WHERE event_id=? AND phase IN ('dispatched','uncertain')`)
        .bind(phase, disposition, requestId, now(), eventId),
      db.prepare(`UPDATE line_result_outbox SET state=?, owner_event_id=CASE WHEN ?='pending' THEN NULL ELSE owner_event_id END
        WHERE owner_event_id=? AND EXISTS(SELECT 1 FROM line_reply_dispatches WHERE event_id=? AND phase=?)`)
        .bind(state, state, eventId, eventId, phase),
    ]);
  }
  return {
    async enqueueResult({ resultKey, groupId, result }: { resultKey: string; groupId: string; result: TerminalResultV1 }) {
      validateReplyMessages(result.messages);
      if(result.schemaVersion!==1 || !groupId.trim() || !resultKey.trim() || !result.runId.trim() || !Number.isSafeInteger(result.generation) || result.generation<1 || !Number.isSafeInteger(result.notificationCycle) || result.notificationCycle<1)throw new Error('outbox_invalid_result');
      const json = JSON.stringify(result);
      await db.prepare(`INSERT INTO line_result_outbox(result_key,group_id,result_json,created_at) VALUES(?,?,?,?) ON CONFLICT(result_key) DO NOTHING`)
        .bind(resultKey, groupId, json, now()).run();
      const saved = await db.prepare('SELECT group_id, result_json FROM line_result_outbox WHERE result_key=?').bind(resultKey).first<{group_id:string;result_json:string}>();
      if (!saved || saved.group_id !== groupId || saved.result_json !== json) throw new Error('outbox_result_conflict');
    },
    async head(groupId: string): Promise<OutboxHead | null> {
      const row = await db.prepare(`SELECT * FROM line_result_outbox WHERE group_id=? AND state!='accepted' ORDER BY sequence LIMIT 1`)
        .bind(groupId).first<{sequence:number;group_id:string;state:string;result_json:string}>();
      return row ? { sequence: row.sequence, groupId: row.group_id, state: row.state, result: JSON.parse(row.result_json) as TerminalResultV1 } : null;
    },
    async prepareDispatch(input: PrepareDispatchInput): Promise<'prepared' | 'duplicate' | 'head_changed'> {
      const { eventId, groupId, workflowId, receivedAt, candidateSequence, messages } = input;
      const results = await db.batch([
        db.prepare(`INSERT INTO line_reply_dispatches(event_id,group_id,workflow_id,received_at,candidate_sequence,messages_json,phase,updated_at)
          SELECT ?,?,?,?,?,?,'prepared',? WHERE ? IS NULL OR EXISTS(
            SELECT 1 FROM line_result_outbox WHERE sequence=? AND group_id=? AND state='pending'
              AND sequence=(SELECT MIN(sequence) FROM line_result_outbox WHERE group_id=? AND state!='accepted'))
          ON CONFLICT(event_id) DO NOTHING`)
          .bind(eventId, groupId, workflowId, receivedAt, candidateSequence, JSON.stringify(messages), now(), candidateSequence, candidateSequence, groupId, groupId),
        db.prepare(`UPDATE line_result_outbox SET state='reserved',owner_event_id=? WHERE sequence=? AND state='pending'
          AND EXISTS(SELECT 1 FROM line_reply_dispatches WHERE event_id=? AND candidate_sequence=? AND phase='prepared')`)
          .bind(eventId, candidateSequence, eventId, candidateSequence),
      ]);
      if (results[0]!.meta.changes === 1) return 'prepared';
      const existing = await db.prepare('SELECT event_id FROM line_reply_dispatches WHERE event_id=?').bind(eventId).first();
      return existing ? 'duplicate' : 'head_changed';
    },
    async beginDispatch(eventId: string): Promise<boolean> {
      const results = await db.batch([
        db.prepare(`UPDATE line_reply_dispatches SET phase='dispatched',updated_at=? WHERE event_id=? AND phase='prepared'`).bind(now(), eventId),
        db.prepare(`UPDATE line_result_outbox SET state='dispatched' WHERE owner_event_id=? AND state='reserved'
          AND EXISTS(SELECT 1 FROM line_reply_dispatches WHERE event_id=? AND phase='dispatched')`).bind(eventId, eventId),
      ]);
      return results[0]!.meta.changes === 1;
    },
    accept: (eventId: string, requestId: string | null) => transition(eventId, 'accepted', 'accepted', null, requestId),
    reject: (eventId: string, disposition: RejectionDisposition) => transition(eventId, 'rejected', disposition === 'retry_on_new_event' ? 'pending' : 'blocked', disposition),
    markUncertain: (eventId: string) => transition(eventId, 'uncertain', 'uncertain'),
    async abandonPrepared(eventId: string) {
      await db.batch([
        db.prepare(`UPDATE line_reply_dispatches SET phase='abandoned',updated_at=? WHERE event_id=? AND phase='prepared'`).bind(now(), eventId),
        db.prepare(`UPDATE line_result_outbox SET state='pending',owner_event_id=NULL WHERE owner_event_id=? AND state='reserved'
          AND EXISTS(SELECT 1 FROM line_reply_dispatches WHERE event_id=? AND phase='abandoned')`).bind(eventId, eventId),
      ]);
    },
  };
}
export type LineReplyRepository = ReturnType<typeof createLineReplyRepository>;
