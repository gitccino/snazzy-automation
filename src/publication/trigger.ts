import { captureOperationContext } from "../settings/runtime";
import {
  readPublicationContext,
  savePublicationAttemptContext,
} from "../db/execution-context-repository";
import type { OperationContext } from "../settings/schema";
import {
  acquireOrResumeJob,
  reopenFailedJobForRestart,
  reopenSuccessfulJobForRegeneration,
} from "../db/publication-repository";
import type { Env } from "../env";
import { todayBangkokDate, type Clock } from "../shared/time";
import { findPublicationRunForDate } from "./airtable-runs";
import { publicationWorkflowId } from "./types";
import { OperationalError } from "../shared/errors";

export type DocsTriggerResult =
  | { status: "no_runnable_run" }
  | { status: "already_generated"; publicationRunId: string }
  | { status: "already_running"; publicationRunId: string }
  | { status: "regenerating"; publicationRunId: string; generation: number }
  | { status: "started" | "restarted" | "resumed"; publicationRunId: string };

const activeStatuses = ["queued", "running", "waiting", "waitingForPause"];

async function lookupWorkflow(
  env: Env,
  id: string,
): Promise<{
  instance: WorkflowInstance;
  state: InstanceStatus;
} | null> {
  try {
    const instance = await env.PUBLICATION_WORKFLOW.get(id);
    return { instance, state: await instance.status() };
  } catch (error) {
    // Missing and expired instances reject get() instead of returning a handle.
    if (error instanceof Error && error.message.includes("instance.not_found"))
      return null;
    throw error;
  }
}

export async function handleDocsTrigger(
  env: Env,
  trigger: "cron" | "line" | "admin",
  clock: Clock = { now: () => new Date() },
  publicationDate?: string,
  fetcher: typeof fetch = fetch.bind(globalThis),
  context?: OperationContext,
): Promise<DocsTriggerResult> {
  context ??= await captureOperationContext(env, null);
  const requestedDate = publicationDate ?? todayBangkokDate(clock);
  const existing = await env.DB.prepare(
    "SELECT publication_run_id FROM publication_jobs WHERE publication_date = ? AND (temp_doc_id IS NOT NULL OR finalization_json IS NOT NULL) AND state != 'succeeded'",
  )
    .bind(requestedDate)
    .first<{ publication_run_id: string }>();
  if (existing) {
    const saved = await readPublicationContext(
      env.DB,
      existing.publication_run_id,
    );
    if (!saved && env.CONFIGURATION_MODE === "d1")
      throw new Error("legacy_context_requires_operator_resolution");
    if (saved) context = saved;
  }
  const config = context.settings.config;
  const run = await findPublicationRunForDate(
    fetcher,
    config,
    env.AIRTABLE_TOKEN,
    publicationDate ?? todayBangkokDate(clock),
  );
  if (!run || (run.status !== "Ready" && run.status !== "Failed")) {
    if (run && trigger === "line" && run.status === "Generated")
      return {
        status: "already_generated",
        publicationRunId: run.airtableRunId,
      };
    if (run && trigger === "line" && run.status === "Generating")
      return { status: "already_running", publicationRunId: run.airtableRunId };
    return { status: "no_runnable_run" };
  }

  const publicationRunId = run.airtableRunId;
  let acquired = await acquireOrResumeJob(
    env.DB,
    clock,
    publicationRunId,
    publicationWorkflowId(publicationRunId, 1),
  );
  if (acquired.job.successfulGeneration > 0 && trigger !== "line")
    return { status: "already_generated", publicationRunId };
  if (
    acquired.job.publicationDate &&
    acquired.job.publicationDate !== run.publicationDate
  ) {
    throw new OperationalError(
      "publication_date_conflict",
      "Publication date differs from its original claim",
      false,
    );
  }
  const replacing =
    acquired.alreadySucceeded && trigger === "line" && run.status === "Ready";
  if (acquired.alreadySucceeded && !replacing)
    return { status: "already_generated", publicationRunId };

  let id = publicationWorkflowId(publicationRunId, acquired.job.generation);
  let workflow = await lookupWorkflow(env, id);
  if (workflow && activeStatuses.includes(workflow.state.status))
    return { status: "already_running", publicationRunId };
  if (replacing) {
    const replacement = await reopenSuccessfulJobForRegeneration(
      env.DB,
      clock,
      publicationRunId,
      acquired.job.generation,
    );
    if (!replacement) return { status: "already_running", publicationRunId };
    acquired = { job: replacement, alreadySucceeded: false, ownsLock: true };
    id = publicationWorkflowId(publicationRunId, replacement.generation);
    workflow = await lookupWorkflow(env, id);
  }

  const status = workflow?.state.status ?? "unknown";
  if (activeStatuses.includes(status))
    return { status: "already_running", publicationRunId };
  if (status === "paused" && workflow) {
    await workflow.instance.resume();
    return { status: "resumed", publicationRunId };
  }
  const canRestart = ["errored", "terminated", "complete"].includes(status);
  if (!canRestart && status !== "unknown")
    throw new Error("unsupported_publication_workflow_status");

  // Recheck after the Workflow lookup, then explicitly reopen only failed jobs.
  // Unknown instances may have expired from retention; the same ID can be created again.
  const current = await acquireOrResumeJob(env.DB, clock, publicationRunId, id);
  if (current.alreadySucceeded)
    return { status: "already_generated", publicationRunId };
  if (current.job.generation !== acquired.job.generation)
    return { status: "already_running", publicationRunId };
  if (
    current.job.state === "failed" ||
    current.job.state === "validation_failed"
  ) {
    const reopened = await reopenFailedJobForRestart(
      env.DB,
      clock,
      publicationRunId,
      id,
      acquired.job.generation,
      context,
    );
    if (!reopened) {
      const raced = await acquireOrResumeJob(
        env.DB,
        clock,
        publicationRunId,
        id,
      );
      return {
        status: raced.alreadySucceeded
          ? "already_generated"
          : "already_running",
        publicationRunId,
      };
    }
  }

  const savedContext = await readPublicationContext(env.DB, publicationRunId);
  if (
    !savedContext &&
    !(await savePublicationAttemptContext(
      env.DB,
      publicationRunId,
      acquired.job.generation,
      context,
    ))
  )
    throw new Error("publication_context_unavailable");
  if (savedContext) context = savedContext;

  if (canRestart && workflow) {
    await workflow.instance.restart();
    return { status: "restarted", publicationRunId };
  }

  try {
    await env.PUBLICATION_WORKFLOW.create({
      id,
      params: {
        publicationRunId,
        trigger,
        context,
        ...(acquired.job.generation > 1
          ? { generation: acquired.job.generation }
          : {}),
      },
    });
  } catch (error) {
    const raced = await lookupWorkflow(env, id);
    if (raced && activeStatuses.includes(raced.state.status))
      return { status: "already_running", publicationRunId };
    throw error;
  }
  return replacing
    ? {
        status: "regenerating",
        publicationRunId,
        generation: acquired.job.generation,
      }
    : { status: "started", publicationRunId };
}
