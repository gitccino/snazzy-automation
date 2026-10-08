import { OperationalError } from "../shared/errors";
import type { Env } from "../env";
import { createImportRepository } from "../db/import-repository";
import { createSequenceRepository } from "../db/sequence-repository";
import { deriveSourceAlbumId } from "../icloud/client";
import type { ImportWorkflowParams } from "../import/types";
import { newCorrelationId } from "../shared/ids";

export async function handleUploadTrigger(env: Env, trigger: "cron" | "line" | "admin", requestId?: string): Promise<Response> {
  try {
    return await startImport(env, trigger, requestId);
  } catch (error) {
    if (requestId !== undefined) throw error;
    return Response.json({ status: "import_trigger_failed" }, { status: 500 });
  }
}

async function startImport(env: Env, trigger: "cron" | "line" | "admin", requestId?: string): Promise<Response> {
  if (!(await createSequenceRepository(env.DB).isBootstrapped("product_id"))) {
    return Response.json({ status: "sequence_not_bootstrapped" }, { status: 503 });
  }
  const ids = { next: () => newCorrelationId() };
  const repo = createImportRepository(env.DB, ids, { now: () => new Date() });
  let sourceAlbumId = await deriveSourceAlbumId(env.ICLOUD_SHARED_ALBUM_TOKEN);
  const importRunId = requestId ?? ids.next();
  const existing = requestId === undefined ? null : await env.DB.prepare(
    "SELECT status, source_album_id FROM import_runs WHERE id = ?",
  ).bind(importRunId).first<{ status: string; source_album_id: string }>();
  if (existing) sourceAlbumId = existing.source_album_id;
  if (existing && existing.status !== "running" && existing.status !== "start_failed") {
    return Response.json({ status: "started", importRunId }, { status: 202 });
  }
  // The partial unique index arbitrates concurrent triggers; a preflight read cannot.
  try {
    if (existing?.status === "start_failed") {
      await env.DB.prepare("UPDATE import_runs SET status = 'running', finished_at = NULL WHERE id = ? AND status = 'start_failed'")
        .bind(importRunId).run();
    } else if (existing === null) {
      await repo.createImportRun({ id: importRunId, sourceAlbumId, trigger });
    }
  } catch (error) {
    if (await repo.hasRunningImportRun(sourceAlbumId)) {
      return Response.json({ status: "already_running" }, { status: 409 });
    }
    throw error;
  }
  const params: ImportWorkflowParams = { importRunId, sourceAlbumId, trigger };
  try {
    let workflowInstanceId = `import-${importRunId}`;
    if (requestId === undefined) {
      const instance = await env.IMPORT_WORKFLOW.create({ id: workflowInstanceId, params });
      workflowInstanceId = instance.id;
    } else await env.IMPORT_WORKFLOW.createBatch([{ id: workflowInstanceId, params }]);
    return Response.json({ status: "started", importRunId, workflowInstanceId }, { status: 202 });
  } catch {
    await repo.markImportRunStartFailed(importRunId);
    if (requestId !== undefined) throw new OperationalError("workflow_start_failed", "Import Workflow start failed", true);
    return Response.json({ status: "workflow_start_failed" }, { status: 502 });
  }
}
