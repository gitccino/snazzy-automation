import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { parseConfig } from "../config";
import { createAuditLog } from "../db/audit";
import { createImportRepository } from "../db/import-repository";
import { createSequenceRepository } from "../db/sequence-repository";
import type { Env } from "../env";
import { createICloudClient } from "../icloud/client";
import { createLineClient, type LineClient } from "../line/client";
import { isRetryable, OperationalError } from "../shared/errors";
import { newCorrelationId } from "../shared/ids";
import { bangkokDateTimeThai } from "../shared/time";
import { createAirtableProductsClient } from "./airtable-products";
import { createAssetStore } from "./asset-store";
import { createMarkerDetector } from "./marker";
import { sendImportSummary } from "./notify";
import {
  downloadAndGroupSnapshot,
  finalizeImportRun,
  processProductGroupAttempt,
  recordExhaustedGroupFailure,
  type DownloadAndGroupOutcome,
  type PersistedGroup,
  type ProcessGroupDeps,
} from "./service";
import type { ImportRunResult, ImportWorkflowParams } from "./types";

interface WorkflowStepLike {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(
    name: string,
    options: {
      retries: { limit: number; delay: "10 seconds"; backoff: "exponential" };
    },
    callback: () => Promise<T>,
  ): Promise<T>;
}

interface ImportWorkflowOperations {
  retryLimit: number;
  downloadAndGroup(): Promise<DownloadAndGroupOutcome>;
  recordRunFailure(errorCode: string): Promise<void>;
  processGroupAttempt(
    deps: ProcessGroupDeps,
    group: PersistedGroup,
    importRunId: string,
  ): Promise<{ outcome: "succeeded"; productId: string }>;
  recordExhaustedFailure(
    deps: ProcessGroupDeps,
    group: PersistedGroup,
    importRunId: string,
    error: unknown,
  ): Promise<{ productId: string | null; errorCode: string }>;
  finalize(
    hadFailures: boolean,
    orphanPhotoCount: number,
    checkpointPosition: number,
  ): Promise<void>;
  notify(
    result: ImportRunResult,
    orphanRange: DownloadAndGroupOutcome["orphanRange"],
  ): Promise<void>;
}

function durableErrorCode(error: unknown, fallback: string): string {
  if (error instanceof OperationalError) return error.code;
  return error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.name)
    ? error.name
    : fallback;
}

export async function runImportWorkflow(
  deps: ProcessGroupDeps,
  payload: ImportWorkflowParams,
  step: WorkflowStepLike,
  operations: ImportWorkflowOperations,
): Promise<ImportRunResult> {
  let downloadOutcome: DownloadAndGroupOutcome;
  try {
    downloadOutcome = await step.do("download-and-group", async () => {
      try {
        return await operations.downloadAndGroup();
      } catch (error) {
        const code = durableErrorCode(
          error,
          "non_retryable_download_error",
        );
        if (!isRetryable(error)) {
          const message =
            error instanceof Error
              ? error.message
              : "Non-retryable download error";
          throw new NonRetryableError(message, code);
        }
        if (error instanceof Error) error.name = code;
        throw error;
      }
    });
  } catch (error) {
    const errorCode = durableErrorCode(error, "download_and_group_failed");
    await step.do("record-download-and-group-failure", () =>
      operations.recordRunFailure(errorCode),
    );
    throw error;
  }
  const { pendingGroups, orphanRange, checkpointPosition } = downloadOutcome;
  const succeededProductIds: string[] = [];
  const failedGroups: ImportRunResult["failedGroups"] = [];

  for (const group of pendingGroups) {
    try {
      const outcome = await step.do(
        `process-group-${group.groupRowId}`,
        {
          retries: {
            limit: operations.retryLimit,
            delay: "10 seconds",
            backoff: "exponential",
          },
        },
        async () => {
          try {
            return await operations.processGroupAttempt(
              deps,
              group,
              payload.importRunId,
            );
          } catch (error) {
            if (!isRetryable(error)) {
              const code =
                error instanceof OperationalError
                  ? error.code
                  : "non_retryable_group_error";
              const message =
                error instanceof Error
                  ? error.message
                  : "Non-retryable group error";
              throw new NonRetryableError(message, code);
            }
            throw error;
          }
        },
      );
      succeededProductIds.push(outcome.productId);
    } catch (error) {
      const failure = await step.do(
        `record-failed-group-${group.groupRowId}`,
        () =>
          operations.recordExhaustedFailure(
            deps,
            group,
            payload.importRunId,
            error,
          ),
      );
      failedGroups.push({
        groupId: group.groupRowId,
        productId: failure.productId,
        errorCode: failure.errorCode,
      });
    }
  }

  const result: ImportRunResult = {
    importRunId: payload.importRunId,
    succeededProductIds,
    failedGroups,
  };
  await step.do("finalize-checkpoint", () =>
    operations.finalize(
      failedGroups.length > 0,
      orphanRange?.count ?? 0,
      checkpointPosition,
    ),
  );
  await step.do("send-import-summary", () =>
    operations.notify(result, orphanRange),
  );
  return result;
}

export class ImportWorkflow extends WorkflowEntrypoint<
  Env,
  ImportWorkflowParams
> {
  async run(
    event: WorkflowEvent<ImportWorkflowParams>,
    step: WorkflowStep,
  ): Promise<ImportRunResult> {
    const config = parseConfig(this.env.APP_CONFIG_JSON);
    const clock = { now: () => new Date() };
    const ids = { next: () => newCorrelationId() };
    const repo = createImportRepository(this.env.DB, ids, clock);
    const deps: ProcessGroupDeps = {
      imageSource: createICloudClient(
        this.env.ICLOUD_SHARED_ALBUM_TOKEN,
        fetch,
      ),
      marker: createMarkerDetector(this.env.IMAGES),
      repo,
      assets: createAssetStore(
        this.env.IMAGES_BUCKET,
        {
          signingSecret: this.env.ASSET_URL_SIGNING_SECRET,
          publicBaseUrl: config.publicBaseUrl,
        },
        clock,
      ),
      clock,
      ids,
      sourceAlbumId: event.payload.sourceAlbumId,
      firstImportCutoffDate: config.firstImportCutoffDate,
      sequences: createSequenceRepository(this.env.DB),
      audit: createAuditLog(this.env.DB, ids, clock),
      airtable: createAirtableProductsClient({
        baseId: config.airtableBaseId,
        tableId: config.airtableProductsTableId,
        token: this.env.AIRTABLE_TOKEN,
        fetch,
      }),
      productIdPrefix: config.productIdPrefix,
      assetUrlTtlSeconds: 300,
    };
    const line: LineClient = createLineClient({
      channelAccessToken: this.env.LINE_CHANNEL_ACCESS_TOKEN,
      fetch,
    });

    return runImportWorkflow(deps, event.payload, step as unknown as WorkflowStepLike, {
      retryLimit: config.importRetryLimit,
      downloadAndGroup: () =>
        downloadAndGroupSnapshot(deps, event.payload.importRunId),
      recordRunFailure: (failureReason) =>
        repo.failImportRun({
          id: event.payload.importRunId,
          sourceAlbumId: event.payload.sourceAlbumId,
          failureReason,
        }),
      processGroupAttempt: processProductGroupAttempt,
      recordExhaustedFailure: recordExhaustedGroupFailure,
      finalize: (hadFailures, orphanPhotoCount, checkpointPosition) =>
        finalizeImportRun(
          repo,
          event.payload.importRunId,
          event.payload.sourceAlbumId,
          hadFailures,
          orphanPhotoCount,
          checkpointPosition,
        ),
      notify: (result, orphanRange) =>
        sendImportSummary(line, config.lineAllowedGroupId, {
          result,
          orphanRange,
          nowThaiText: bangkokDateTimeThai(clock),
        }),
    });
  }
}
