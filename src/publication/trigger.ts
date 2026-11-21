import { advanceUnconfirmedPublicationRestart, bindInitialPublicationCreate, claimPublicationVerification } from '../db/publication-repository';
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
  readPublicationJob,
} from "../db/publication-repository";
import type { Env } from "../env";
import { todayBangkokDate, type Clock } from "../shared/time";
import { findPublicationRunForDate } from "./airtable-runs";
import { publicationWorkflowId } from "./types";
import { OperationalError } from "../shared/errors";

export type DocsTriggerResult =
  | { status: "no_runnable_run" }
  | { status: "failed_to_start"; publicationRunId: string }
  | { status: "owner_review"; publicationRunId: string }
  | { status: "checking"; publicationRunId: string }
  | { status: "busy" }
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
    const state = await instance.status();
    if (state.status === "unknown") throw new Error("publication_workflow_status_unavailable");
    return { instance, state };
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
  trustedEventId?: string,
): Promise<DocsTriggerResult> {
  const trustedGroupId = context?.replyGroupId;
  if (trigger === "line" && trustedEventId) {
    const ingress = await env.DB.prepare("SELECT group_id, operation FROM line_command_ingress WHERE event_id = ?")
      .bind(trustedEventId).first<{ group_id: string; operation: string }>();
    const binding = await env.DB.prepare("SELECT publication_run_id, generation, workflow_id, action, handoff_status, group_id, ingress_operation FROM publication_regeneration_events WHERE event_id = ?")
      .bind(trustedEventId).first<{ publication_run_id: string; generation: number; workflow_id: string; action: string; handoff_status: string | null; group_id: string | null; ingress_operation: string | null }>();
    if (binding) {
      const operation = ingress ? JSON.parse(ingress.operation) : null;
      if (!ingress || !context?.replyGroupId || ingress.group_id !== context.replyGroupId ||
          operation?.type !== "docs" || operation.publicationDate !== publicationDate || !["regenerate", "create", "restart"].includes(binding.action) ||
          (binding.action !== "regenerate" && (binding.group_id !== ingress.group_id || binding.ingress_operation !== ingress.operation)))
        throw new Error("publication_event_identity_mismatch");
      const publicationRunId = binding.publication_run_id;
      if (binding.handoff_status === "failed_to_start") return { status: "failed_to_start", publicationRunId };
      if ((binding.action === "create" || binding.action === "restart") && binding.handoff_status === "started")
        return { status: binding.action === "restart" ? "restarted" : "started", publicationRunId };
      if (binding.handoff_status === "regenerating")
        return { status: "regenerating", publicationRunId, generation: binding.generation };
      if (binding.handoff_status === "already_running") return { status: "already_running", publicationRunId };
      const workflow = await lookupWorkflow(env, binding.workflow_id);
      if (workflow && activeStatuses.includes(workflow.state.status))
        return { status: "already_running", publicationRunId };
      throw new Error("publication_handoff_unconfirmed");
    }
  }
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
    const job = run && trigger === "line" && (run.status === "Generated" || run.status === "Generating")
      ? await readPublicationJob(env.DB, run.airtableRunId) : null;
    const needsVerification = run?.status === "Generating" ||
      (run?.status === "Generated" && job?.state !== "succeeded" && !!job?.finalizationJson);
    if (run && trigger === "line" && run.status === "Generated" && !needsVerification)
      return {
        status: "already_generated",
        publicationRunId: run.airtableRunId,
      };
    if (run && trigger === "line" && needsVerification) {
      const owner = job && await readPublicationContext(env.DB, run.airtableRunId);
      if (!job || !owner?.replyGroupId || owner.replyGroupId !== trustedGroupId)
        return { status: "busy" };
      try {
        const originalId = publicationWorkflowId(run.airtableRunId, job.generation);
        if (job.correlationId !== originalId) return { status: "owner_review", publicationRunId: run.airtableRunId };
        const workflow = await lookupWorkflow(env, originalId);
        if (workflow && activeStatuses.includes(workflow.state.status))
          return { status: "already_running", publicationRunId: run.airtableRunId };
        if (workflow && ["errored", "terminated", "complete"].includes(workflow.state.status)) {
          const attempt = { runId: run.airtableRunId, generation: job.generation, notificationCycle: job.notificationCycle, groupId: trustedGroupId! };
          let claim = await claimPublicationVerification(env.DB, attempt);
          if (claim.status === "held") {
            const saved = await env.DB.prepare(`SELECT verifier_id, context_json FROM publication_verification_claims c
              WHERE publication_run_id=? AND generation=? AND notification_cycle=? AND group_id=? AND completed=0 AND origin_workflow_id=?
                AND EXISTS (SELECT 1 FROM publication_jobs j WHERE j.publication_run_id=c.publication_run_id AND j.generation=c.generation AND j.notification_cycle=c.notification_cycle AND j.correlation_id=c.origin_workflow_id AND j.settings_context_json=c.context_json)`)
              .bind(run.airtableRunId, job.generation, job.notificationCycle, trustedGroupId, originalId).first<{ verifier_id: string; context_json: string }>();
            const verifier = saved && await lookupWorkflow(env, saved.verifier_id);
            if (verifier && activeStatuses.includes(verifier.state.status))
              return { status: "checking", publicationRunId: run.airtableRunId };
            if (saved && !verifier)
              claim = { status: "claimed", verifierId: saved.verifier_id, originWorkflowId: originalId, contextJson: saved.context_json };
            if (saved && verifier && ["errored", "terminated"].includes(verifier.state.status))
              claim = await claimPublicationVerification(env.DB, attempt, { verifierId: saved.verifier_id, status: "interrupted" });
          }
          if (claim.status === "claimed" && claim.originWorkflowId === originalId) {
            try {
              await env.PUBLICATION_WORKFLOW.create({ id: claim.verifierId, params: { kind: "verification", publicationRunId: run.airtableRunId, generation: job.generation, notificationCycle: job.notificationCycle, groupId: trustedGroupId!, verifierId: claim.verifierId } });
              return { status: "checking", publicationRunId: run.airtableRunId };
            } catch {
              const verifier = await lookupWorkflow(env, claim.verifierId);
              if (verifier && activeStatuses.includes(verifier.state.status))
                return { status: "checking", publicationRunId: run.airtableRunId };
            }
          }
        }
      } catch {
        // An unavailable lookup cannot establish that the original attempt stopped.
      }
      return { status: "owner_review", publicationRunId: run.airtableRunId };
    }
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
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(replacing ? publicationWorkflowId(publicationRunId, acquired.job.generation + 1) : id)) {
    if (trigger === "line" && trustedEventId && !trustedGroupId) throw new Error("publication_event_identity_mismatch");
    if (trigger === "line" && trustedEventId && trustedGroupId) {
      const binding = await bindInitialPublicationCreate(env.DB, trustedEventId, trustedGroupId, publicationDate, publicationRunId, acquired.job.generation, acquired.job.notificationCycle, "create", "failed_to_start");
      if (!binding) throw new Error("publication_event_identity_mismatch");
      if (!binding.bindingCreated) return handleDocsTrigger(env, trigger, clock, publicationDate, fetcher, context, trustedEventId);
    }
    return { status: "failed_to_start", publicationRunId };
  }
  let workflow = await lookupWorkflow(env, id);
  if (workflow && activeStatuses.includes(workflow.state.status))
    return { status: "already_running", publicationRunId };
  if (replacing) {
    const replacement = await reopenSuccessfulJobForRegeneration(
      env.DB,
      clock,
      publicationRunId,
      acquired.job.generation,
      trustedEventId,
    );
    if (replacement && trustedEventId && !replacement.bindingCreated)
      return handleDocsTrigger(env, trigger, clock, publicationDate, fetcher, context, trustedEventId);
    if (!replacement || replacement.publicationRunId !== publicationRunId)
      return { status: "already_running", publicationRunId };
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
  if (trigger === "line" && trustedEventId && !trustedGroupId) throw new Error("publication_event_identity_mismatch");
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
      current.job.notificationCycle,
      trigger === "line" && trustedEventId && trustedGroupId && !replacing ? { id: trustedEventId, groupId: trustedGroupId, publicationDate, action: canRestart ? "restart" : "create" } : undefined,
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

  let bindingCycle = current.job.notificationCycle + (current.job.state === "failed" || current.job.state === "validation_failed" ? 1 : 0);
  if(current.job.state!=='failed' && current.job.state!=='validation_failed') {
    const advanced=await advanceUnconfirmedPublicationRestart(env.DB,clock,publicationRunId,acquired.job.generation,current.job.notificationCycle);
    if(advanced==='advanced') bindingCycle++;
    if(advanced==='contended')return {status:'already_running',publicationRunId};
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
    if (trigger === "line" && trustedEventId && !replacing) {
      if (!trustedGroupId) throw new Error("publication_event_identity_mismatch");
      if (current.job.state !== "failed" && current.job.state !== "validation_failed") {
        const binding = await bindInitialPublicationCreate(env.DB, trustedEventId, trustedGroupId, publicationDate, publicationRunId, acquired.job.generation, bindingCycle, "restart");
        if (!binding) throw new Error("publication_event_identity_mismatch");
        if (!binding.bindingCreated) return handleDocsTrigger(env, trigger, clock, publicationDate, fetcher, { ...context, replyGroupId: trustedGroupId }, trustedEventId);
      }
    }
    await workflow.instance.restart();
    if (trigger === "line" && trustedEventId) await env.DB.prepare("UPDATE publication_regeneration_events SET handoff_status = ? WHERE event_id = ?").bind(replacing ? "regenerating" : "started", trustedEventId).run();
    return { status: "restarted", publicationRunId };
  }

  if (trigger === "line" && trustedEventId && !replacing && current.job.state !== "failed" && current.job.state !== "validation_failed") {
    if (!trustedGroupId) throw new Error("publication_event_identity_mismatch");
    const binding = await bindInitialPublicationCreate(env.DB, trustedEventId, trustedGroupId, publicationDate, publicationRunId, acquired.job.generation, bindingCycle);
    if (!binding) throw new Error("publication_event_identity_mismatch");
    if (!binding.bindingCreated) return handleDocsTrigger(env, trigger, clock, publicationDate, fetcher, { ...context, replyGroupId: trustedGroupId }, trustedEventId);
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
    if (raced && activeStatuses.includes(raced.state.status)) {
      if (trigger === "line" && trustedEventId) await env.DB.prepare("UPDATE publication_regeneration_events SET handoff_status = 'already_running' WHERE event_id = ?").bind(trustedEventId).run();
      return { status: "already_running", publicationRunId };
    }
    throw error;
  }
  if (replacing && trustedEventId) await env.DB.prepare("UPDATE publication_regeneration_events SET handoff_status = 'regenerating' WHERE event_id = ?").bind(trustedEventId).run();
  if (!replacing && trigger === "line" && trustedEventId) await env.DB.prepare("UPDATE publication_regeneration_events SET handoff_status = 'started' WHERE event_id = ?").bind(trustedEventId).run();
  return replacing
    ? {
        status: "regenerating",
        publicationRunId,
        generation: acquired.job.generation,
      }
    : { status: "started", publicationRunId };
}
