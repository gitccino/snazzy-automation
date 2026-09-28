import { parseConfig } from "../config";
import { acquireOrResumeJob, reopenFailedJobForRestart } from "../db/publication-repository";
import type { Env } from "../env";
import { todayBangkokDate, type Clock } from "../shared/time";
import { findRunnableRunForDate } from "./airtable-runs";

export type DocsTriggerResult =
  | { status: "no_runnable_run" }
  | { status: "already_generated"; publicationRunId: string }
  | { status: "already_running"; publicationRunId: string }
  | { status: "started" | "restarted" | "resumed"; publicationRunId: string };

const activeStatuses = ["queued", "running", "waiting", "waitingForPause"];

async function lookupWorkflow(env: Env, id: string): Promise<{
  instance: WorkflowInstance;
  state: InstanceStatus;
} | null> {
  try {
    const instance = await env.PUBLICATION_WORKFLOW.get(id);
    return { instance, state: await instance.status() };
  } catch (error) {
    // Missing and expired instances reject get() instead of returning a handle.
    if (error instanceof Error && error.message.includes("instance.not_found")) return null;
    throw error;
  }
}

export async function handleDocsTrigger(
  env: Env,
  trigger: "cron" | "line" | "admin",
  clock: Clock = { now: () => new Date() },
): Promise<DocsTriggerResult> {
  const config = parseConfig(env.APP_CONFIG_JSON);
  const run = await findRunnableRunForDate(
    fetch.bind(globalThis), config, env.AIRTABLE_TOKEN, todayBangkokDate(clock),
  );
  if (!run || (run.status !== "Ready" && run.status !== "Failed")) {
    return { status: "no_runnable_run" };
  }

  const publicationRunId = run.airtableRunId;
  const id = `publication-${publicationRunId}`;
  const acquired = await acquireOrResumeJob(env.DB, clock, publicationRunId, id);
  if (acquired.alreadySucceeded) return { status: "already_generated", publicationRunId };

  const workflow = await lookupWorkflow(env, id);
  const status = workflow?.state.status ?? "unknown";
  if (activeStatuses.includes(status)) return { status: "already_running", publicationRunId };
  if (status === "paused" && workflow) {
    await workflow.instance.resume();
    return { status: "resumed", publicationRunId };
  }
  const canRestart = ["errored", "terminated", "complete"].includes(status);
  if (!canRestart && status !== "unknown") throw new Error("unsupported_publication_workflow_status");

  // Recheck after the Workflow lookup, then explicitly reopen only failed jobs.
  // Unknown instances may have expired from retention; the same ID can be created again.
  const current = await acquireOrResumeJob(env.DB, clock, publicationRunId, id);
  if (current.alreadySucceeded) return { status: "already_generated", publicationRunId };
  if (current.job.state === "failed") {
    const reopened = await reopenFailedJobForRestart(env.DB, clock, publicationRunId, id);
    if (!reopened) {
      const raced = await acquireOrResumeJob(env.DB, clock, publicationRunId, id);
      return { status: raced.alreadySucceeded ? "already_generated" : "already_running", publicationRunId };
    }
  }

  if (canRestart && workflow) {
    await workflow.instance.restart();
    return { status: "restarted", publicationRunId };
  }

  try {
    await env.PUBLICATION_WORKFLOW.create({
      id, params: { publicationRunId, trigger },
    });
  } catch (error) {
    const raced = await lookupWorkflow(env, id);
    if (raced && activeStatuses.includes(raced.state.status)) return { status: "already_running", publicationRunId };
    throw error;
  }
  return { status: "started", publicationRunId };
}
