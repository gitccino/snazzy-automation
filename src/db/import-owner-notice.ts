import { earlySetupResult } from '../line/early-setup-notice';

/** Materialize only an existing early-setup intent under its unchanged captured owner and target. */
export async function repairImportOwnerNotice(db:D1Database, input:{runId:string;ownerGroupId:string;baseId:string;tableId:string;actor:string;reason:string}):Promise<boolean> {
  const {runId,ownerGroupId,baseId,tableId,actor,reason}=input;
  if (![runId,ownerGroupId,baseId,tableId,actor,reason].every(v => typeof v === 'string' && v.trim().length > 0 && v.length <= 500 && !v.includes('\0'))) return false;
  const key=JSON.stringify(['import',runId,1,1,'terminal']);
  const result=JSON.stringify(earlySetupResult({kind:'import',runId,generation:1,notificationCycle:1,groupId:ownerGroupId}));
  const write=await db.prepare(`INSERT INTO import_owner_notice_repairs(result_key,run_id,group_id,actor,reason,result_json)
    SELECT f.result_key,f.run_id,f.group_id,?,?,? FROM workflow_feedback_results f
    JOIN workflow_feedback w ON w.kind=f.kind AND w.run_id=f.run_id AND w.generation=f.generation AND w.notification_cycle=f.notification_cycle AND w.group_id=f.group_id
    JOIN import_runs r ON r.id=f.run_id AND r.trigger='line' AND r.settings_context_json=w.context_json
    WHERE f.kind='import' AND f.run_id=? AND f.group_id=? AND f.generation=1 AND f.notification_cycle=1 AND f.revision=0 AND f.result_key=? AND f.materialized=0
    AND json_valid(w.context_json) AND json_extract(w.context_json,'$.replyGroupId')=?
    AND json_extract(w.context_json,'$.settings.config.airtableBaseId')=? AND json_extract(w.context_json,'$.settings.config.airtableProductsTableId')=?
    AND w.stage='settings-context' AND w.failure_code='setup_failed'
    AND EXISTS(SELECT 1 FROM line_command_ingress i WHERE i.event_id=w.event_id AND i.group_id=f.group_id AND i.workflow_id=f.run_id AND json_valid(i.operation) AND json_extract(i.operation,'$.type')='upload')
    AND json_valid(f.outcome_json) AND json_extract(f.outcome_json,'$.references.notice')='early_setup'
    AND json_extract(f.outcome_json,'$.stage')='settings-context' AND json_extract(f.outcome_json,'$.failureCode')='setup_failed'
    AND json_extract(f.outcome_json,'$.eventId')=w.event_id AND json_extract(f.outcome_json,'$.resultKey')=f.result_key
    AND json_extract(f.outcome_json,'$.action')='verify' AND json_extract(f.outcome_json,'$.outcome')='unconfirmed'
    AND NOT EXISTS(SELECT 1 FROM line_result_outbox WHERE result_key=f.result_key)
    AND NOT EXISTS(SELECT 1 FROM line_result_outbox o WHERE o.group_id=f.group_id AND o.state!='accepted' AND NOT EXISTS(SELECT 1 FROM line_reply_owner_dispositions d WHERE d.sequence=o.sequence))
    AND NOT EXISTS(SELECT 1 FROM workflow_feedback_results earlier WHERE earlier.group_id=f.group_id AND earlier.materialized=0 AND earlier.rowid<f.rowid)
    ON CONFLICT(result_key) DO NOTHING RETURNING result_key`)
    .bind(actor,reason,result,runId,ownerGroupId,key,ownerGroupId,baseId,tableId).all();
  return write.results.length === 1;
}
