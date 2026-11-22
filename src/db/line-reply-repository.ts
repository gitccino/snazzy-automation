import { validateReplyMessages } from '../line/client';
import type { Clock } from '../shared/time';
import type { LineReplyMessage, RejectionDisposition, TerminalResultV1 } from '../line/reply-types';

export type ReplyProviderEvidence={status:number|null;requestId:string|null};
export type OutboxHead = {
  sequence: number; groupId: string; state: string; result: TerminalResultV1;
};
export type PrepareDispatchInput = {
  eventId: string; groupId: string; workflowId: string; receivedAt: string;
  candidateSequence: number | null; messages: LineReplyMessage[];
};
export function createLineReplyRepository(db: D1Database, clock: Clock) {
  const now = () => clock.now().toISOString();
  async function transition(eventId: string, phase: string, state: string, disposition: string | null = null, evidence:ReplyProviderEvidence={status:null,requestId:null}) {
    await db.batch([
      db.prepare(`UPDATE line_reply_dispatches SET phase=?, disposition=?, request_id=?, http_status=?, rejection_proven=?, updated_at=?
        WHERE event_id=? AND phase IN ('dispatched','uncertain')`)
        .bind(phase, disposition, evidence.requestId?.slice(0,200)??null, evidence.status, phase === 'rejected' && evidence.status !== null && evidence.status >= 300 && evidence.status < 500 ? 1 : 0, now(), eventId),
      db.prepare(`UPDATE line_result_outbox SET state=?, owner_event_id=CASE WHEN ?='pending' THEN NULL ELSE owner_event_id END
        WHERE owner_event_id=? AND NOT EXISTS(SELECT 1 FROM line_reply_owner_dispositions d WHERE d.sequence=line_result_outbox.sequence) AND EXISTS(SELECT 1 FROM line_reply_dispatches WHERE event_id=? AND phase=?)`)
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
      const row = await db.prepare(`SELECT * FROM line_result_outbox WHERE group_id=? AND state!='accepted' AND NOT EXISTS(SELECT 1 FROM line_reply_owner_dispositions d WHERE d.sequence=line_result_outbox.sequence) ORDER BY sequence LIMIT 1`)
        .bind(groupId).first<{sequence:number;group_id:string;state:string;result_json:string}>();
      return row ? { sequence: row.sequence, groupId: row.group_id, state: row.state, result: JSON.parse(row.result_json) as TerminalResultV1 } : null;
    },
    async prepareDispatch(input: PrepareDispatchInput): Promise<'prepared' | 'duplicate' | 'head_changed'> {
      const { eventId, groupId, workflowId, receivedAt, candidateSequence, messages } = input;
      const results = await db.batch([
        db.prepare(`INSERT INTO line_reply_dispatches(event_id,group_id,workflow_id,received_at,candidate_sequence,messages_json,phase,updated_at)
          SELECT ?,?,?,?,?,?,'prepared',? WHERE ? IS NULL OR EXISTS(
            SELECT 1 FROM line_result_outbox WHERE sequence=? AND group_id=? AND state='pending'
              AND NOT EXISTS(SELECT 1 FROM workflow_feedback_results f WHERE f.group_id=line_result_outbox.group_id AND f.materialized=0 AND NOT EXISTS(SELECT 1 FROM workflow_feedback_results older WHERE older.result_key=line_result_outbox.result_key AND older.group_id=f.group_id AND older.kind=f.kind AND older.run_id=f.run_id AND older.generation=f.generation AND older.notification_cycle=f.notification_cycle AND older.revision<f.revision))
              AND sequence=(SELECT MIN(sequence) FROM line_result_outbox WHERE group_id=? AND state!='accepted' AND NOT EXISTS(SELECT 1 FROM line_reply_owner_dispositions d WHERE d.sequence=line_result_outbox.sequence)))
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
    async recordOwnerDisposition(input: { eventId: string; sequence: number; groupId: string; decision: 'confirmed_acceptance' | 'close_unverifiable'; actor: string; reason: string }): Promise<boolean> {
      if (!input.actor.trim() || !input.reason.trim() || !['confirmed_acceptance', 'close_unverifiable'].includes(input.decision)) throw new Error('invalid_owner_disposition');
      const result = await db.prepare(`INSERT INTO line_reply_owner_dispositions(event_id,sequence,group_id,decision,actor,reason,created_at)
        SELECT d.event_id,o.sequence,o.group_id,?,?,?,? FROM line_result_outbox o
        JOIN line_reply_dispatches d ON d.event_id=o.owner_event_id AND d.candidate_sequence=o.sequence AND d.group_id=o.group_id
        WHERE d.event_id=? AND o.sequence=? AND o.group_id=?
          AND ((o.state='reserved' AND d.phase='prepared') OR (o.state='dispatched' AND d.phase='dispatched') OR (o.state='uncertain' AND d.phase='uncertain') OR (o.state='blocked' AND d.phase='rejected'))
          AND o.sequence=(SELECT MIN(sequence) FROM line_result_outbox WHERE group_id=o.group_id AND state!='accepted' AND NOT EXISTS(SELECT 1 FROM line_reply_owner_dispositions x WHERE x.sequence=line_result_outbox.sequence))
        ON CONFLICT DO NOTHING`).bind(input.decision, input.actor, input.reason, now(), input.eventId, input.sequence, input.groupId).run();
      return result.meta.changes === 1;
    },
    async beginDispatch(eventId: string): Promise<boolean> {
      const results = await db.batch([
        db.prepare(`UPDATE line_reply_dispatches SET phase='dispatched',updated_at=? WHERE event_id=? AND phase='prepared' AND NOT EXISTS(SELECT 1 FROM line_reply_owner_dispositions d WHERE d.event_id=line_reply_dispatches.event_id)`).bind(now(), eventId),
        db.prepare(`UPDATE line_result_outbox SET state='dispatched' WHERE owner_event_id=? AND state='reserved' AND NOT EXISTS(SELECT 1 FROM line_reply_owner_dispositions d WHERE d.sequence=line_result_outbox.sequence)
          AND EXISTS(SELECT 1 FROM line_reply_dispatches WHERE event_id=? AND phase='dispatched')`).bind(eventId, eventId),
      ]);
      return results[0]!.meta.changes === 1;
    },
    accept: (eventId: string, requestId: string | null) => transition(eventId, 'accepted', 'accepted', null, {status:200,requestId}),
    reject: (eventId: string, disposition: RejectionDisposition, evidence?:ReplyProviderEvidence) => transition(eventId, 'rejected', disposition === 'retry_on_new_event' ? 'pending' : 'blocked', disposition, evidence),
    markUncertain: (eventId: string,evidence?:ReplyProviderEvidence) => transition(eventId, 'uncertain', 'uncertain',null,evidence),
    async abandonPrepared(eventId: string) {
      await db.batch([
        db.prepare(`UPDATE line_reply_dispatches SET phase='abandoned',updated_at=? WHERE event_id=? AND phase='prepared'`).bind(now(), eventId),
        db.prepare(`UPDATE line_result_outbox SET state='pending',owner_event_id=NULL WHERE owner_event_id=? AND state='reserved' AND NOT EXISTS(SELECT 1 FROM line_reply_owner_dispositions d WHERE d.sequence=line_result_outbox.sequence)
          AND EXISTS(SELECT 1 FROM line_reply_dispatches WHERE event_id=? AND phase='abandoned')`).bind(eventId, eventId),
      ]);
    },
  };
}
export type LineReplyRepository = ReturnType<typeof createLineReplyRepository>;
