import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stages = vi.hoisted(() => {
  // Workflow binding registration preloads the Worker modules before this test.
  vi.resetModules();
  return {
    validatePublication: vi.fn(),
    notifyPublicationValidationFailure: vi.fn(),
    preparePublicationOutputs: vi.fn(),
    ensureTemporaryDocument: vi.fn(),
    fillAndVerifyDocument: vi.fn(),
    finalizePublication: vi.fn(),
    notifyPublicationSuccess: vi.fn(),
    failPublicationAfterExhaustion: vi.fn(),
  };
});

vi.mock("../../src/publication/service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/publication/service")>(),
  ...stages,
}));

import { PublicationWorkflow, runPublicationWorkflow } from "../../src/publication/workflow";
import type { PublicationServiceDeps } from "../../src/publication/service";
import type { PublicationWorkflowParams } from "../../src/publication/types";
import { OperationalError } from "../../src/shared/errors";
import { createTestEnv, testEnv } from "../helpers/env";

const params = { publicationRunId: "rec-run-1", trigger: "admin" as const };
const deps = { config: { publicationRetryLimit: 5 } } as PublicationServiceDeps;
const validated = {
  run: { airtableRunId: "rec-run-1", publicationDate: "2026-09-02", status: "Ready", products: [] },
  thaiDate: "2 กันยายน 2569",
};
const prepared = { ...validated, outputs: [] };
const result = {
  publicationRunId: "rec-run-1",
  googleDocId: "temp-doc-1",
  googleDocUrl: "https://docs.google.com/document/d/temp-doc-1/edit",
  productIds: [],
};

function retryingStep(serializeErrors = false) {
  return {
    do: vi.fn(async (
      _name: string,
      options: { retries: { limit: number } },
      callback: () => Promise<unknown>,
    ) => {
      for (let call = 0; ; call += 1) {
        try {
          return await callback();
        } catch (error) {
          if (call === options.retries.limit || error instanceof NonRetryableError) {
            if (serializeErrors && error instanceof Error) {
              const reconstructed = new Error(error.message);
              reconstructed.name = error.name;
              throw reconstructed;
            }
            throw error;
          }
        }
      }
    }),
  };
}

describe("runPublicationWorkflow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stages.validatePublication.mockResolvedValue({ kind: "valid", value: validated });
    stages.notifyPublicationValidationFailure.mockResolvedValue(undefined);
    stages.preparePublicationOutputs.mockResolvedValue(prepared);
    stages.ensureTemporaryDocument.mockResolvedValue("temp-doc-1");
    stages.fillAndVerifyDocument.mockResolvedValue(undefined);
    stages.finalizePublication.mockResolvedValue(result);
    stages.notifyPublicationSuccess.mockResolvedValue(undefined);
    stages.failPublicationAfterExhaustion.mockResolvedValue(undefined);
  });

  it("runs six named durable stages with five exponential retries after the initial call", async () => {
    const step = retryingStep();

    await expect(runPublicationWorkflow(params, step as unknown as WorkflowStep, deps)).resolves.toEqual(result);

    expect(step.do.mock.calls.map(([name]) => name)).toEqual([
      "validate publication",
      "prepare outputs",
      "ensure temporary document",
      "fill and verify document",
      "finalize publication",
      "notify publication success",
    ]);
    for (const [, options] of step.do.mock.calls) {
      expect(options).toEqual({
        retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
        timeout: "5 minutes",
      });
    }
    expect(stages.validatePublication).toHaveBeenCalledWith(deps, "rec-run-1", "publication-rec-run-1");
    expect(stages.preparePublicationOutputs).toHaveBeenCalledWith(deps, validated);
    expect(stages.ensureTemporaryDocument).toHaveBeenCalledWith(deps, prepared);
    expect(stages.fillAndVerifyDocument).toHaveBeenCalledWith(deps, prepared, "temp-doc-1");
    expect(stages.finalizePublication).toHaveBeenCalledWith(deps, prepared, "temp-doc-1");
    expect(stages.notifyPublicationSuccess).toHaveBeenCalledWith(deps, prepared, result);
    expect(stages.failPublicationAfterExhaustion).not.toHaveBeenCalled();
  });

  it.each([
    ["validatePublication", "Unable to read or validate publication data.", null],
    ["preparePublicationOutputs", "Unable to prepare publication images and captions.", "2 กันยายน 2569"],
    ["ensureTemporaryDocument", "Unable to create the temporary Google document.", "2 กันยายน 2569"],
    ["fillAndVerifyDocument", "Unable to fill or verify the Google document.", "2 กันยายน 2569"],
    ["finalizePublication", "Unable to finalize the publication.", "2 กันยายน 2569"],
  ] as const)("exhausts six %s attempts before one durable cleanup with a safe reason", async (stage, reason, displayDate) => {
    const upstream = new Error("private response Bearer SECRET-AIRTABLE sk-ant-SECRET -----BEGIN PRIVATE KEY-----");
    stages[stage].mockRejectedValue(upstream);
    const step = retryingStep();

    await expect(runPublicationWorkflow(params, step as unknown as WorkflowStep, deps)).rejects.toThrow(new Error(reason));

    expect(stages[stage]).toHaveBeenCalledTimes(6);
    expect(stages.failPublicationAfterExhaustion).toHaveBeenCalledExactlyOnceWith(deps, "rec-run-1", reason, displayDate);
    expect(step.do.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      "record exhausted publication failure",
      { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
    ]);
    expect(stages.notifyPublicationSuccess).not.toHaveBeenCalled();
  });

  it("converts a permanent stage error to NonRetryableError at the durable boundary", async () => {
    stages.ensureTemporaryDocument.mockRejectedValue(new OperationalError(
      "google_copy_failed", "private response SECRET-GOOGLE", false,
    ));

    const failure = runPublicationWorkflow(params, retryingStep() as unknown as WorkflowStep, deps);
    await expect(failure).rejects.toBeInstanceOf(NonRetryableError);
    await expect(failure).rejects.toMatchObject({
      name: "google_copy_failed", message: "Unable to create the temporary Google document.",
    });
    expect(stages.ensureTemporaryDocument).toHaveBeenCalledTimes(1);
    expect(stages.failPublicationAfterExhaustion).toHaveBeenCalledExactlyOnceWith(
      deps, "rec-run-1", "Unable to create the temporary Google document.", "2 กันยายน 2569",
    );
  });

  it.each([
    ["validatePublication", "publication_job_locked", false],
    ["validatePublication", "publication_job_locked", true],
    ["validatePublication", "publication_job_terminal", false],
    ["validatePublication", "publication_job_terminal", true],
    ["preparePublicationOutputs", "publication_job_terminal", true],
  ] as const)("does not clean up a %s contender rejected with %s (serialized: %s)", async (stage, code, serializeErrors) => {
    stages[stage].mockRejectedValue(new OperationalError(code, "private contender details", false));
    const step = retryingStep(serializeErrors);

    await expect(runPublicationWorkflow(params, step as unknown as WorkflowStep, deps)).rejects.toMatchObject({ name: code });

    expect(stages[stage]).toHaveBeenCalledTimes(1);
    expect(stages.failPublicationAfterExhaustion).not.toHaveBeenCalled();
    expect(step.do.mock.calls.map(([name]) => name)).not.toContain("record exhausted publication failure");
    expect(stages.notifyPublicationSuccess).not.toHaveBeenCalled();
  });

  it("returns the stored result without regenerating a succeeded publication", async () => {
    stages.validatePublication.mockResolvedValue({ kind: "already_succeeded", result });
    const step = retryingStep();

    await expect(runPublicationWorkflow(params, step as unknown as WorkflowStep, deps)).resolves.toEqual(result);

    expect(step.do.mock.calls.map(([name]) => name)).toEqual(["validate publication"]);
    expect(stages.preparePublicationOutputs).not.toHaveBeenCalled();
  });

  it.each([null, "transient", "permanent"] as const)("keeps invalid products in Draft when their notification is %s", async (failureKind) => {
    const validation = { valid: false, productsMissingFields: [{ productId: "A-1001", missingFields: ["Description"] }] };
    stages.validatePublication.mockResolvedValue({ kind: "validation_failed", thaiDate: "2 กันยายน 2569", validation });
    if (failureKind) {
      stages.notifyPublicationValidationFailure.mockRejectedValue(new OperationalError("line_push_failed", "LINE unavailable", failureKind === "transient"));
    }
    const step = retryingStep();
    const outcome = runPublicationWorkflow(params, step as unknown as WorkflowStep, deps);

    if (failureKind === "permanent") await expect(outcome).rejects.toBeInstanceOf(NonRetryableError);
    else if (failureKind) await expect(outcome).rejects.toThrow(new Error("Unable to send the publication validation notification."));
    else await expect(outcome).resolves.toBeNull();

    expect(stages.notifyPublicationValidationFailure).toHaveBeenCalledWith(deps, "rec-run-1", "2 กันยายน 2569", validation);
    expect(stages.notifyPublicationValidationFailure).toHaveBeenCalledTimes(failureKind === "transient" ? 6 : 1);
    expect(stages.preparePublicationOutputs).not.toHaveBeenCalled();
    expect(stages.failPublicationAfterExhaustion).not.toHaveBeenCalled();
  });

  it.each([true, false])("does not downgrade success when its notification fails (retryable: %s)", async (retryable) => {
    stages.notifyPublicationSuccess.mockRejectedValue(new OperationalError("line_push_failed", "LINE unavailable", retryable));

    await expect(runPublicationWorkflow(params, retryingStep() as unknown as WorkflowStep, deps)).rejects.toMatchObject({ message: "Unable to send the publication success notification." });

    expect(stages.finalizePublication).toHaveBeenCalledTimes(1);
    expect(stages.notifyPublicationSuccess).toHaveBeenCalledTimes(retryable ? 6 : 1);
    expect(stages.failPublicationAfterExhaustion).not.toHaveBeenCalled();
  });

  it.each([true, false])("applies the retry policy to exhausted-failure cleanup (retryable: %s)", async (retryable) => {
    stages.fillAndVerifyDocument.mockRejectedValue(new Error("Google unavailable"));
    stages.failPublicationAfterExhaustion.mockRejectedValue(new OperationalError("line_push_failed", "LINE unavailable", retryable));

    await expect(runPublicationWorkflow(params, retryingStep() as unknown as WorkflowStep, deps)).rejects.toMatchObject({ message: "Unable to record the publication failure." });

    expect(stages.fillAndVerifyDocument).toHaveBeenCalledTimes(6);
    expect(stages.failPublicationAfterExhaustion).toHaveBeenCalledTimes(retryable ? 6 : 1);
  });

  it("constructs the official Anthropic client with SDK retries disabled in the bound Workflow", async () => {
    const env = { ...testEnv(), ...createTestEnv() };

    // The platform owns WorkflowEntrypoint construction; exercise its run boundary with test bindings.
    await expect(PublicationWorkflow.prototype.run.call(
      { env } as unknown as PublicationWorkflow,
      { payload: params } as WorkflowEvent<PublicationWorkflowParams>,
      retryingStep() as unknown as WorkflowStep,
    )).resolves.toEqual(result);

    const actualDeps = stages.validatePublication.mock.calls[0]?.[0] as PublicationServiceDeps;
    expect(actualDeps.anthropic).toBeInstanceOf(Anthropic);
    expect((actualDeps.anthropic as Anthropic).maxRetries).toBe(0);
    expect(actualDeps.db).toBe(env.DB);
    expect(actualDeps.clock.now()).toBeInstanceOf(Date);
  });
});
