import { describe, expect, it, vi } from "vitest";
import { runImportWorkflow } from "../../src/import/workflow";
import type { PersistedGroup, ProcessGroupDeps } from "../../src/import/service";
import { OperationalError } from "../../src/shared/errors";
import { retryingStep } from "../helpers/workflow-step";

function group(id: string, ordinal: number): PersistedGroup {
  return {
    groupId: id,
    groupRowId: `row-${id}`,
    ordinal,
    markerPhotoId: `marker-${id}`,
    attachablePhotos: [{
      applePhotoId: `photo-${id}`,
      r2Key: `assets/${id}.jpg`,
    }],
  };
}

function forwardedDeps(): ProcessGroupDeps {
  return Object.create(null) as ProcessGroupDeps;
}

const payload = {
  importRunId: "run-retry-acceptance",
  sourceAlbumId: "album-1",
  trigger: "admin" as const,
};

describe("Workflow-owned import retries", () => {
  it("succeeds after three transient failures within five retries", async () => {
    const step = retryingStep();
    const process = vi.fn()
      .mockRejectedValueOnce(new OperationalError(
        "airtable_rate_limited",
        "rate limited",
        true,
      ))
      .mockRejectedValueOnce(new OperationalError(
        "airtable_rate_limited",
        "rate limited",
        true,
      ))
      .mockRejectedValueOnce(new OperationalError(
        "airtable_rate_limited",
        "rate limited",
        true,
      ))
      .mockResolvedValue({ outcome: "succeeded", productId: "A-501" });

    const result = await runImportWorkflow(forwardedDeps(), payload, step, {
      retryLimit: 5,
      downloadAndGroup: async () => ({
        pendingGroups: [group("g1", 0)],
        orphanRange: null,
        checkpointPosition: 10,
      }),
      recordRunFailure: vi.fn(),
      processGroupAttempt: process,
      recordExhaustedFailure: vi.fn(),
      finalize: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn().mockResolvedValue(undefined),
    });

    expect(result).toEqual({
      importRunId: payload.importRunId,
      succeededProductIds: ["A-501"],
      failedGroups: [],
    });
    expect(process).toHaveBeenCalledTimes(4);
    expect(step.calls.find(({ name }) => name === "process-group-row-g1"))
      .toMatchObject({ retryLimit: 5, attempts: 4 });
  });

  it("records one failed group after six attempts and continues its sibling", async () => {
    const step = retryingStep();
    const process = vi.fn(async (_deps, current: PersistedGroup) => {
      if (current.groupId === "g1") {
        throw new OperationalError("airtable_rate_limited", "rate limited", true);
      }
      return { outcome: "succeeded" as const, productId: "A-502" };
    });
    const record = vi.fn().mockResolvedValue({
      productId: "A-501",
      errorCode: "airtable_rate_limited",
    });

    const result = await runImportWorkflow(forwardedDeps(), payload, step, {
      retryLimit: 5,
      downloadAndGroup: async () => ({
        pendingGroups: [group("g1", 0), group("g2", 1)],
        orphanRange: null,
        checkpointPosition: 20,
      }),
      recordRunFailure: vi.fn(),
      processGroupAttempt: process,
      recordExhaustedFailure: record,
      finalize: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn().mockResolvedValue(undefined),
    });

    expect(step.calls.find(({ name }) => name === "process-group-row-g1"))
      .toMatchObject({ retryLimit: 5, attempts: 6 });
    expect(record).toHaveBeenCalledTimes(1);
    expect(result.failedGroups).toEqual([{
      groupId: "row-g1",
      productId: "A-501",
      errorCode: "airtable_rate_limited",
    }]);
    expect(result.succeededProductIds).toEqual(["A-502"]);
  });
});
