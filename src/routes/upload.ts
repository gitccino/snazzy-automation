import { captureOperationContext } from "../settings/runtime";
import { saveImportContextIfAbsent, parseContext } from "../db/execution-context-repository";
import type { OperationContext } from "../settings/schema";
import { OperationalError } from "../shared/errors";
import type { Env } from "../env";
import { createImportRepository, claimImportVerification, renewImportVerification } from "../db/import-repository";
import { createSequenceRepository } from "../db/sequence-repository";
import { deriveSourceAlbumId } from "../icloud/client";
import type { ImportWorkflowParams } from "../import/types";
import { importWorkflowId, newCorrelationId } from "../shared/ids";

async function importWorkflowExists(env: Env, id: string): Promise<boolean> {
  try {
    const state = await (await env.IMPORT_WORKFLOW.get(id)).status();
    if (state.status !== "unknown") return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("instance.not_found")) return false;
  }
  throw new OperationalError("workflow_start_failed", "Import Workflow status unavailable", true);
}

export async function handleUploadTrigger(
  env: Env,
  trigger: "cron" | "line" | "admin",
  requestId?: string,
  context?: OperationContext,
  trustedEventId?: string,
): Promise<Response> {
  try {
    context ??= await captureOperationContext(env, null);
    return await startImport(env, trigger, requestId, context, trustedEventId);
  } catch (error) {
    if (requestId !== undefined) throw error;
    return Response.json({ status: "import_trigger_failed" }, { status: 500 });
  }
}

async function startImport(
  env: Env,
  trigger: "cron" | "line" | "admin",
  requestId?: string,
  context?: OperationContext,
  trustedEventId?: string,
): Promise<Response> {
  if (!(await createSequenceRepository(env.DB).isBootstrapped("product_id"))) {
    return Response.json(
      { status: "sequence_not_bootstrapped" },
      { status: 503 },
    );
  }
  const ids = { next: () => newCorrelationId() };
  const repo = createImportRepository(env.DB, ids, { now: () => new Date() });
  let sourceAlbumId = await deriveSourceAlbumId(env.ICLOUD_SHARED_ALBUM_TOKEN);
  const importRunId = requestId ?? ids.next();
  const existing =
    requestId === undefined
      ? null
      : await env.DB.prepare(
          "SELECT status, source_album_id FROM import_runs WHERE id = ?",
        )
          .bind(importRunId)
          .first<{ status: string; source_album_id: string }>();
  if (existing) sourceAlbumId = existing.source_album_id;
  if (
    existing &&
    existing.status !== "running" &&
    existing.status !== "start_failed"
  ) {
    return Response.json({ status: "started", importRunId }, { status: 202 });
  }
  const workflowInstanceId = importWorkflowId(importRunId);
  if (existing?.status === "running" && await importWorkflowExists(env, workflowInstanceId)) {
    return Response.json({ status: "started", importRunId, workflowInstanceId }, { status: 202 });
  }
  // The partial unique index arbitrates concurrent triggers; a preflight read cannot.
  try {
    if (existing?.status === "start_failed") {
      await env.DB.prepare(
        "UPDATE import_runs SET status = 'running', finished_at = NULL WHERE id = ? AND status = 'start_failed'",
      )
        .bind(importRunId)
        .run();
    } else if (existing === null) {
      await repo.createImportRun({ id: importRunId, sourceAlbumId, trigger });
    }
  } catch (error) {
    if (await repo.hasRunningImportRun(sourceAlbumId)) {
      if (trigger === "line" && context?.replyGroupId) {
        const owner = await env.DB.prepare("SELECT id, settings_context_json FROM import_runs WHERE source_album_id = ? AND status = 'running'")
          .bind(sourceAlbumId).first<{ id: string; settings_context_json: string | null }>();
        if (owner) {
          let ownerGroup: string | null = null;
          try { ownerGroup = parseContext(owner.settings_context_json)?.replyGroupId ?? null; } catch { /* Unreadable ownership is not evidence of ownership. */ }
          if (ownerGroup === context.replyGroupId) {
            let live = false;
            let stopped = false;
            try {
              const status = (await (await env.IMPORT_WORKFLOW.get(importWorkflowId(owner.id))).status()).status;
              stopped = ["complete", "errored", "terminated"].includes(status);
              live = status === "queued" || status === "running" || status === "waiting" || status === "waitingForPause";
            } catch { /* A failed lookup does not prove the job is live. */ }
            const terminal = await env.DB.prepare(`SELECT r.status FROM import_runs r
              JOIN import_checkpoints c ON c.source_album_id = r.source_album_id AND c.last_position >= r.checkpoint_position
              JOIN line_result_outbox o ON o.result_key = ? AND o.group_id = ?
              WHERE r.id = ? AND r.source_album_id = ? AND r.status IN ('completed', 'completed_with_failures')
                AND r.checkpoint_position IS NOT NULL AND r.failure_reason IS NULL
                AND json_valid(r.settings_context_json) AND json_extract(r.settings_context_json, '$.replyGroupId') = ?
                AND json_valid(o.result_json) AND json_extract(o.result_json, '$.schemaVersion') = 1
                AND json_extract(o.result_json, '$.kind') = 'import'
                AND json_extract(o.result_json, '$.runId') = r.id
                AND json_extract(o.result_json, '$.generation') = 1
                AND json_extract(o.result_json, '$.notificationCycle') = 1
                AND json_extract(o.result_json, '$.outcome') = CASE r.status WHEN 'completed' THEN 'success' ELSE 'partial' END`)
              .bind(JSON.stringify(["import", owner.id, 1, 1, "terminal"]), context.replyGroupId, owner.id, sourceAlbumId, context.replyGroupId)
              .first<{ status: "completed" | "completed_with_failures" }>();
            if (terminal) return Response.json({ status: terminal.status === "completed" ? "completed" : "partial", importRunId: owner.id }, { status: 409 });
            if (stopped && owner.settings_context_json) {
              const workflowId = importWorkflowId(owner.id);
              const input = {runId:owner.id, albumId:sourceAlbumId, workflowId, groupId:context.replyGroupId, contextJson:owner.settings_context_json};
              const claimed = await claimImportVerification(env.DB, input);
              let verifierId: string | null = claimed ? `import-verification-${owner.id}` : null;
              const isActive = (status: string) => ["queued", "running", "waiting", "waitingForPause"].includes(status);
              if (!claimed) {
                const saved = await env.DB.prepare(`SELECT verifier_id FROM import_verification_claims WHERE import_run_id=? AND source_album_id=? AND origin_workflow_id=? AND group_id=? AND context_json=? AND completed IS NULL`)
                  .bind(owner.id, sourceAlbumId, workflowId, context.replyGroupId, owner.settings_context_json).first<{verifier_id:string}>();
                if (saved) {
                  try {
                    const status = (await (await env.IMPORT_WORKFLOW.get(saved.verifier_id)).status()).status;
                    if (isActive(status)) return Response.json({status:"checking", importRunId:owner.id}, {status:409});
                    if (["errored", "terminated"].includes(status)) verifierId = await renewImportVerification(env.DB, input, saved.verifier_id);
                  } catch { /* Unavailable is not proof of interruption. */ }
                }
              }
              if (verifierId) {
                try {
                  await env.IMPORT_WORKFLOW.create({id:verifierId, params:{kind:'verification', importRunId:owner.id}});
                  return Response.json({status:"checking", importRunId:owner.id}, {status:409});
                } catch {
                  try {
                    const status = (await (await env.IMPORT_WORKFLOW.get(verifierId)).status()).status;
                    if (isActive(status)) return Response.json({status:"checking", importRunId:owner.id}, {status:409});
                  } catch { /* Hold uncertain dispatch. */ }
                }
              }
            }
            if (!live) return Response.json({ status: "owner_review", importRunId: owner.id }, { status: 409 });
            return Response.json({ status: "already_running" }, { status: 409 });
          }
        }
        return Response.json({ status: "busy" }, { status: 409 });
      }
      return Response.json({ status: "already_running" }, { status: 409 });
    }
    throw error;
  }
  let uncertainStart = false;
  try {
    const acceptedContext = await saveImportContextIfAbsent(
      env.DB,
      importRunId,
      context ?? (await captureOperationContext(env, null)),
    );
    const params: ImportWorkflowParams = {
      importRunId,
      sourceAlbumId,
      trigger,
      context: acceptedContext,
      ...(trigger === "line" && trustedEventId && acceptedContext.replyGroupId ? { trustedEventId, replyGroupId: acceptedContext.replyGroupId } : {}),
    };
    let acceptedInstanceId = workflowInstanceId;
    if (requestId === undefined) {
      const instance = await env.IMPORT_WORKFLOW.create({
        id: workflowInstanceId,
        params,
      });
      acceptedInstanceId = instance.id;
    } else {
      try {
        await env.IMPORT_WORKFLOW.createBatch([{ id: workflowInstanceId, params }]);
      } catch {
        uncertainStart = true;
        if (await importWorkflowExists(env, workflowInstanceId)) {
          return Response.json({ status: "started", importRunId, workflowInstanceId }, { status: 202 });
        }
        uncertainStart = false;
        throw new Error("workflow_start_failed");
      }
    }
    return Response.json(
      { status: "started", importRunId, workflowInstanceId: acceptedInstanceId },
      { status: 202 },
    );
  } catch (error) {
    if (uncertainStart) throw error;
    await repo.markImportRunStartFailed(importRunId);
    if (requestId !== undefined)
      throw new OperationalError(
        "workflow_start_failed",
        "Import Workflow start failed",
        true,
      );
    return Response.json({ status: "workflow_start_failed" }, { status: 502 });
  }
}
