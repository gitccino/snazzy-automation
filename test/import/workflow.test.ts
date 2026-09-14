import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it, vi } from "vitest";
import { OperationalError } from "../../src/shared/errors";
import { runImportWorkflow } from "../../src/import/workflow";
import type {
  ProcessGroupDeps,
  PersistedGroup,
} from "../../src/import/service";

type StepCall = {
  name: string;
  options: unknown;
  attempts: number;
};

function retryingStep() {
  const calls: StepCall[] = [];
  return {
    calls,
    async do<T>(
      name: string,
      optionsOrCallback: unknown,
      maybeCallback?: () => Promise<T>,
    ): Promise<T> {
      const hasOptions = typeof optionsOrCallback !== "function";
      const callback = (
        hasOptions ? maybeCallback : optionsOrCallback
      ) as () => Promise<T>;
      const retryLimit = hasOptions
        ? ((optionsOrCallback as { retries?: { limit: number } }).retries
            ?.limit ?? 0)
        : 0;
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          const value = await callback();
          calls.push({
            name,
            options: hasOptions ? optionsOrCallback : null,
            attempts: attempt,
          });
          return value;
        } catch (error) {
          if (attempt > retryLimit || error instanceof NonRetryableError) {
            calls.push({
              name,
              options: hasOptions ? optionsOrCallback : null,
              attempts: attempt,
            });
            throw error;
          }
        }
      }
    },
  };
}

function group(id: string, ordinal: number): PersistedGroup {
  return {
    groupId: id,
    groupRowId: `row-${id}`,
    ordinal,
    markerPhotoId: `marker-${id}`,
    attachablePhotos: [
      { applePhotoId: `photo-${id}`, r2Key: `assets/${id}.jpg` },
    ],
  };
}

function processDeps(): ProcessGroupDeps {
  return {
    repo: {},
    clock: { now: () => new Date("2026-09-01T09:00:00.000Z") },
  } as ProcessGroupDeps;
}

describe("runImportWorkflow", () => {
  it("retries a transient group through its durable step then finalizes and notifies the successful result", async () => {
    // Catches a production mutation that catches a transient attempt error
    // inside the durable callback, so Workflow retries never run.
    const step = retryingStep();
    const events: string[] = [];
    const process = vi
      .fn()
      .mockRejectedValueOnce(
        new OperationalError("airtable_rate_limited", "rate limited", true),
      )
      .mockResolvedValue({ outcome: "succeeded", productId: "A-501" });
    const finalize = vi.fn(async () => {
      events.push("finalize");
    });
    const notify = vi.fn(async () => {
      events.push("notify");
    });

    const result = await runImportWorkflow(
      processDeps(),
      { importRunId: "run-1", sourceAlbumId: "album-1", trigger: "cron" },
      step,
      {
        retryLimit: 5,
        downloadAndGroup: async () => ({
          pendingGroups: [group("g1", 0)],
          orphanRange: {
            firstApplePhotoId: "orphan-1",
            lastApplePhotoId: "orphan-2",
            count: 2,
          },
          checkpointPosition: 10,
        }),
        processGroupAttempt: process,
        recordExhaustedFailure: vi.fn(),
        finalize,
        notify,
      },
    );

    expect(process).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      importRunId: "run-1",
      succeededProductIds: ["A-501"],
      failedGroups: [],
    });
    expect(
      step.calls.find((call) => call.name === "process-group-row-g1"),
    ).toEqual({
      name: "process-group-row-g1",
      options: {
        retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
      },
      attempts: 2,
    });
    expect(finalize).toHaveBeenCalledWith(false, 2, 10);
    expect(notify).toHaveBeenCalledWith(result, {
      firstApplePhotoId: "orphan-1",
      lastApplePhotoId: "orphan-2",
      count: 2,
    });
    expect(events).toEqual(["finalize", "notify"]);
  });

  it("records a group only after all six attempts and continues the next sibling", async () => {
    // Catches a production mutation that records the first failed attempt
    // instead of letting the durable step exhaust its configured retries.
    const step = retryingStep();
    const events: string[] = [];
    const process = vi.fn(async (_deps, current: PersistedGroup) => {
      events.push(`process-${current.groupId}`);
      if (current.groupId === "g1") {
        throw new OperationalError(
          "airtable_rate_limited",
          "rate limited",
          true,
        );
      }
      return { outcome: "succeeded" as const, productId: "A-502" };
    });
    const record = vi.fn(async () => {
      events.push("record-g1");
      return { productId: "A-501", errorCode: "airtable_rate_limited" };
    });

    const result = await runImportWorkflow(
      processDeps(),
      { importRunId: "run-1", sourceAlbumId: "album-1", trigger: "line" },
      step,
      {
        retryLimit: 5,
        downloadAndGroup: async () => ({
          pendingGroups: [group("g1", 0), group("g2", 1)],
          orphanRange: null,
          checkpointPosition: 10,
        }),
        processGroupAttempt: process,
        recordExhaustedFailure: record,
        finalize: vi.fn().mockResolvedValue(undefined),
        notify: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(
      step.calls.find((call) => call.name === "process-group-row-g1"),
    ).toMatchObject({ attempts: 6 });
    expect(events).toEqual([
      "process-g1",
      "process-g1",
      "process-g1",
      "process-g1",
      "process-g1",
      "process-g1",
      "record-g1",
      "process-g2",
    ]);
    expect(result).toEqual({
      importRunId: "run-1",
      succeededProductIds: ["A-502"],
      failedGroups: [
        {
          groupId: "row-g1",
          productId: "A-501",
          errorCode: "airtable_rate_limited",
        },
      ],
    });
  });

  it("converts a non-retryable operational error once while preserving its code for failure recording", async () => {
    // Catches a production mutation that retries a permanent error or drops
    // its operational code when turning it into a durable non-retryable error.
    const step = retryingStep();
    const process = vi.fn().mockRejectedValue(
      new OperationalError(
        "product_group_missing",
        "Product group row is missing",
        false,
      ),
    );
    const record = vi.fn().mockResolvedValue({
      productId: null,
      errorCode: "product_group_missing",
    });

    await runImportWorkflow(
      processDeps(),
      { importRunId: "run-1", sourceAlbumId: "album-1", trigger: "cron" },
      step,
      {
        retryLimit: 5,
        downloadAndGroup: async () => ({
          pendingGroups: [group("g1", 0)],
          orphanRange: null,
          checkpointPosition: 10,
        }),
        processGroupAttempt: process,
        recordExhaustedFailure: record,
        finalize: vi.fn().mockResolvedValue(undefined),
        notify: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(process).toHaveBeenCalledTimes(1);
    expect(
      step.calls.find((call) => call.name === "process-group-row-g1"),
    ).toMatchObject({ attempts: 1 });
    expect(record.mock.calls[0]?.[3]).toMatchObject({
      name: "product_group_missing",
      message: "Product group row is missing",
    });
  });
});
