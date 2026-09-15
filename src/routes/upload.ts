import type { Env } from "../env";
import { createImportRepository } from "../db/import-repository";
import { createSequenceRepository } from "../db/sequence-repository";
import { deriveSourceAlbumId } from "../icloud/client";
import type { ImportWorkflowParams } from "../import/types";
import { newCorrelationId } from "../shared/ids";

export async function handleUploadTrigger(env: Env, trigger: "cron" | "line" | "admin"): Promise<Response> {
  try {
    return await startImport(env, trigger);
  } catch {
    return Response.json({ status: "import_trigger_failed" }, { status: 500 });
  }
}

async function startImport(env: Env, trigger: "cron" | "line" | "admin"): Promise<Response> {
  if (!(await createSequenceRepository(env.DB).isBootstrapped("product_id"))) {
    return Response.json({ status: "sequence_not_bootstrapped" }, { status: 503 });
  }
  const ids = { next: () => newCorrelationId() };
  const repo = createImportRepository(env.DB, ids, { now: () => new Date() });
  const sourceAlbumId = await deriveSourceAlbumId(env.ICLOUD_SHARED_ALBUM_TOKEN);
  const importRunId = ids.next();
  // The partial unique index arbitrates concurrent triggers; a preflight read cannot.
  try {
    await repo.createImportRun({ id: importRunId, sourceAlbumId, trigger });
  } catch (error) {
    if (await repo.hasRunningImportRun(sourceAlbumId)) {
      return Response.json({ status: "already_running" }, { status: 409 });
    }
    throw error;
  }
  const params: ImportWorkflowParams = { importRunId, sourceAlbumId, trigger };
  try {
    const instance = await env.IMPORT_WORKFLOW.create({ id: `import-${importRunId}`, params });
    return Response.json({ status: "started", importRunId, workflowInstanceId: instance.id }, { status: 202 });
  } catch {
    await repo.markImportRunStartFailed(importRunId);
    return Response.json({ status: "workflow_start_failed" }, { status: 502 });
  }
}
