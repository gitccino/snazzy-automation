import { inspectOwnerQueue } from './import-owner-inspection';

type OwnerInput = { kind: 'import' | 'publication'; runId: string; ownerGroupId: string; baseId: string; tableId: string; generation?: number; notificationCycle?: number };
const safe = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;

/** Inspect only evidence bound to the supplied captured owner and target. */
export async function inspectWorkflowOwner(db: D1Database, input: OwnerInput) {
  const {kind, runId, ownerGroupId, baseId, tableId} = input;
  if (!['import', 'publication'].includes(kind) || ![runId, ownerGroupId, baseId, tableId].every(safe)) return null;
  if (kind === 'import' && ((input.generation !== undefined && input.generation !== 1) || (input.notificationCycle !== undefined && input.notificationCycle !== 1))) return null;
  const generation = kind === 'import' ? 1 : input.generation;
  const cycle = kind === 'import' ? 1 : input.notificationCycle;
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(cycle) || generation! < 1 || cycle! < 1) return null;
  const rows = kind === 'import'
    ? (await db.prepare("SELECT settings_context_json, status AS state, source_album_id, failure_reason, checkpoint_position FROM import_runs WHERE id=? AND trigger='line'").bind(runId).all<any>()).results
    : (await db.prepare('SELECT settings_context_json, state, correlation_id, attempt_count, generation, notification_cycle, successful_generation, temp_doc_id, google_doc_id, finalization_json FROM publication_jobs WHERE publication_run_id=?').bind(runId).all<any>()).results;
  const row = rows[0];
  if (!row) return null;
  const current = kind === 'import' || (row.generation === generation && row.notification_cycle === cycle);
  const feedback = (await db.prepare('SELECT context_json, group_id, stage, failure_code FROM workflow_feedback WHERE kind=? AND run_id=? AND generation=? AND notification_cycle=?').bind(kind,runId,generation,cycle).all<any>()).results[0];
  const contextJson = current ? row.settings_context_json : feedback?.context_json;
  let context: any;
  try { context = JSON.parse(contextJson); } catch { return null; }
  const config = context?.settings?.config;
  const table = kind === 'import' ? config?.airtableProductsTableId : config?.airtablePublicationRunsTableId;
  if (context?.replyGroupId !== ownerGroupId || config?.airtableBaseId !== baseId || table !== tableId || (feedback && (feedback.group_id !== ownerGroupId || feedback.context_json !== contextJson))) return null;
  const results = (await db.prepare('SELECT revision, outcome_json, materialized FROM workflow_feedback_results WHERE kind=? AND run_id=? AND generation=? AND notification_cycle=? AND group_id=? ORDER BY revision').bind(kind,runId,generation,cycle,ownerGroupId).all<any>()).results.map(r => {
    let outcome: any; try { outcome = JSON.parse(r.outcome_json); } catch { outcome = null; }
    return {revision:r.revision, action:safe(outcome?.action), outcome:safe(outcome?.outcome), materialized:r.materialized === 1};
  });
  const queueHead = await inspectOwnerQueue(db, ownerGroupId);
  const base = {kind, runId, ownerGroupId, target:{baseId, tableId}, externalLiveness:'unknown', feedback:feedback ? {stage:safe(feedback.stage),failureCode:safe(feedback.failure_code)} : null, results, queueHead};
  if (kind === 'import') {
    const verification = (await db.prepare('SELECT origin_workflow_id, verifier_id, completed FROM import_verification_claims WHERE import_run_id=? AND group_id=? AND context_json=?').bind(runId,ownerGroupId,contextJson).all<any>()).results[0];
    return {...base, verification:verification ? {originWorkflowId:safe(verification.origin_workflow_id),verifierId:safe(verification.verifier_id),completed:verification.completed === 1} : null, execution:{state:safe(row.state),generation,notificationCycle:cycle}, sourceAlbumId:safe(row.source_album_id), runFailure:safe(row.failure_reason), checkpointPosition:row.checkpoint_position, syncCleanup:'not recorded'};
  }
  const cleanup = (await db.prepare('SELECT origin_workflow_id, context_json, doc_id, saved_temp_doc, dispatch_verifier_id, deletion_acknowledged FROM publication_cleanup_intents WHERE publication_run_id=? AND generation=? AND notification_cycle=?').bind(runId,generation,cycle).all<any>()).results[0];
  const write = (await db.prepare('SELECT state, protocol_version FROM publication_google_write_evidence WHERE publication_run_id=? AND generation=? AND notification_cycle=?').bind(runId,generation,cycle).all<any>()).results[0];
  const verification = (await db.prepare('SELECT origin_workflow_id, context_json, group_id, verifier_id, completed FROM publication_verification_claims WHERE publication_run_id=? AND generation=? AND notification_cycle=?').bind(runId,generation,cycle).all<any>()).results[0];
  if ((cleanup && cleanup.context_json !== contextJson) || (verification && (verification.context_json !== contextJson || verification.group_id !== ownerGroupId))) return null;
  let finalDocId = null;
  if (current && row.finalization_json) { try { const intent = JSON.parse(row.finalization_json); if (intent.generation === generation) finalDocId = safe(intent.docId); } catch { /* malformed evidence is not displayed */ } }
  return {...base, target:{baseId,tableId,driveFolderId:safe(config?.googleDriveFolderId),templateDocId:safe(config?.googleTemplateDocId)},
    execution:{state:current ? safe(row.state) : null, workflowId:current ? safe(row.correlation_id) : null, attemptCount:current ? row.attempt_count : null, generation,notificationCycle:cycle,successfulGeneration:current ? row.successful_generation : null},
    documents:current ? {temporaryId:safe(row.temp_doc_id),publishedId:safe(row.google_doc_id),finalizationIntentDocId:finalDocId} : null,
    googleWrite:write ? {state:safe(write.state),protocolVersion:write.protocol_version} : null,
    cleanup:cleanup ? {originWorkflowId:safe(cleanup.origin_workflow_id),docId:safe(cleanup.doc_id),savedTempDoc:cleanup.saved_temp_doc === 1 ? true : null,dispatchVerifierId:safe(cleanup.dispatch_verifier_id),deletionAcknowledged:cleanup.deletion_acknowledged === 1 ? true : null} : null,
    verification:verification ? {originWorkflowId:safe(verification.origin_workflow_id),verifierId:safe(verification.verifier_id),completed:verification.completed === 1} : null,
    sync:'not recorded'};
}
