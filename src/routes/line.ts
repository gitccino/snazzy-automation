import { z } from "zod";
import { createLineMutationRepository } from "../db/line-mutation-repository";
import {
  createMutationCoordinator,
  registerMutationFollowup,
  executionStatus,
  lineCommandWorkflowId,
} from "../line/mutation-recovery";
import { captureOperationContext } from "../settings/runtime";
import { readPendingContext } from "../db/execution-context-repository";
import type { OperationContext } from "../settings/schema";
import { createAuditLog } from "../db/audit";
import { createLineRepository } from "../db/line-repository";
import type { Env } from "../env";
import { createInventoryClient } from "../line/airtable-inventory";
import { createLineClient } from "../line/client";
import type { DocsTriggerResult, UploadTriggerResult } from "../line/search";
import { verifyLineSignature } from "../line/signature";
import {
  parseSupportedLineEvents,
  type SupportedLineEvent,
} from "../line/types";
import type { WebhookDeps } from "../line/webhook";
import { OperationalError } from "../shared/errors";
import {
  handleDocsTrigger,
  type DocsTriggerResult as PublicationDocsTriggerResult,
} from "../publication/trigger";
import { handleUploadTrigger } from "./upload";

const ImportTriggerResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("started"), importRunId: z.string().min(1) }),
  z.object({ status: z.literal("already_running") }),
  z.object({ status: z.literal("sequence_not_bootstrapped") }),
  z.object({ status: z.literal("workflow_start_failed") }),
  z.object({ status: z.literal("import_trigger_failed") }),
]);

export function parseUploadTriggerResponse(
  value: unknown,
): UploadTriggerResult {
  return ImportTriggerResponseSchema.parse(value);
}

export function toLineDocsTriggerResult(
  result: PublicationDocsTriggerResult,
): DocsTriggerResult {
  return result;
}

export interface LineRouteOverride {
  process(events: SupportedLineEvent[]): Promise<void>;
}

export async function handleLineRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  override?: LineRouteOverride,
): Promise<Response> {
  const rawBody = await request.arrayBuffer();
  const signature = request.headers.get("x-line-signature") ?? "";
  if (
    !(await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET))
  ) {
    return new Response("unauthorized", { status: 401 });
  }
  if (env.CONFIGURATION_MODE === "maintenance")
    return new Response("maintenance", {
      status: 503,
      headers: { "Retry-After": "60" },
    });

  let events: SupportedLineEvent[];
  try {
    events = parseSupportedLineEvents(
      JSON.parse(new TextDecoder().decode(rawBody)) as unknown,
    );
  } catch {
    return new Response("invalid payload", { status: 400 });
  }

  if (override !== undefined) {
    ctx.waitUntil(override.process(events));
    return new Response("ok");
  }

  const context = await captureOperationContext(env, null);
  const config = context.settings.config;
  const accepted = events.filter((event) =>
    config.lineAllowedGroupIds.includes(event.source.groupId),
  );
  try {
    // createBatch is idempotent while an instance is retained. Persist before acknowledging LINE.
    for (let offset = 0; offset < accepted.length; offset += 100) {
      const batch = await Promise.all(
        accepted.slice(offset, offset + 100).map(async (event) => {
          const id = await lineCommandWorkflowId(event.webhookEventId);
          return {
            id,
            params: {
              event,
              context: { ...context, replyGroupId: event.source.groupId },
            },
          };
        }),
      );
      await env.LINE_COMMAND_WORKFLOW.createBatch(batch);
    }
  } catch {
    return new Response("command persistence failed", { status: 503 });
  }
  return new Response("ok");
}

export const fetchForLineCommand: typeof fetch = async (input, init) => {
  try {
    const timeout = AbortSignal.timeout(15_000);
    return await fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  } catch {
    throw new OperationalError(
      "line_command_network_failed",
      "Provider network request failed",
      true,
    );
  }
};

export async function createWebhookDeps(
  env: Env,
  requestId?: string,
  context?: OperationContext,
): Promise<WebhookDeps> {
  context ??= await captureOperationContext(env, null);
  const operationContext = context;
  const config = context.settings.config;
  const clock = { now: () => new Date() };
  const ids = { next: () => crypto.randomUUID() };
  const fetcher = fetchForLineCommand;
  const line = createLineClient({
    channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
    fetch: fetcher,
  });
  const repo = createLineRepository(env.DB, ids, clock);
  const inventory = createInventoryClient({
    baseId: config.airtableBaseId,
    tableId: config.airtableProductsTableId,
    token: env.AIRTABLE_TOKEN,
    fetch: fetcher,
    now: clock.now,
  });
  const mutationRepo = createLineMutationRepository(env.DB, clock);
  const mutation = createMutationCoordinator(
    requestId ?? "legacy-no-workflow",
    {
      repo,
      inventory,
      ids,
      mutationRepo,
      async inventoryForToken(token) {
        const saved = await readPendingContext(env.DB, token);
        if (!saved && env.CONFIGURATION_MODE === "d1")
          throw new Error("legacy_context_requires_operator_resolution");
        const selected = saved?.settings.config ?? config;
        return createInventoryClient({
          baseId: selected.airtableBaseId,
          tableId: selected.airtableProductsTableId,
          token: env.AIRTABLE_TOKEN,
          fetch: fetcher,
          now: clock.now,
        });
      },
      async sameConnection(first, second) {
        const a = await readPendingContext(env.DB, first),
          b = await readPendingContext(env.DB, second);
        if (!a || !b) return env.CONFIGURATION_MODE !== "d1";
        return (
          a.settings.config.airtableBaseId ===
            b.settings.config.airtableBaseId &&
          a.settings.config.airtableProductsTableId ===
            b.settings.config.airtableProductsTableId
        );
      },
      async status(id) {
        if (id === "legacy-no-workflow") return "unknown";
        try {
          return executionStatus(
            (await (await env.LINE_COMMAND_WORKFLOW.get(id)).status()).status,
          );
        } catch {
          try {
            return executionStatus(
              (
                await (
                  await env.LINE_MUTATION_FOLLOWUP_WORKFLOW.get(id)
                ).status()
              ).status,
            );
          } catch {
            return "unknown";
          }
        }
      },
      async registerFollowup(params) {
        const savedContext = await readPendingContext(
          env.DB,
          params.pendingToken,
        );
        if (!savedContext && env.CONFIGURATION_MODE === "d1")
          throw new Error("legacy_context_requires_operator_resolution");
        await registerMutationFollowup(
          { ...params, context: savedContext ?? operationContext },
          {
            mutationRepo,
            ids,
            now: () => clock.now().getTime(),
            async status(id) {
              try {
                return executionStatus(
                  (
                    await (
                      await env.LINE_MUTATION_FOLLOWUP_WORKFLOW.get(id)
                    ).status()
                  ).status,
                );
              } catch {
                return "unknown";
              }
            },
            create: (id, params) =>
              env.LINE_MUTATION_FOLLOWUP_WORKFLOW.createBatch([{ id, params }]),
          },
        );
      },
    },
  );
  return {
    mutation,
    context: operationContext,
    publicBaseUrl: config.publicBaseUrl,
    allowedGroupIds: config.lineAllowedGroupIds,
    confirmationEnabled: config.soldoutConfirmationEnabled,
    line,
    clock,
    ids,
    repo,
    audit: createAuditLog(env.DB, ids, clock),
    inventory,
    async triggerUpload() {
      const response = await handleUploadTrigger(
        env,
        "line",
        requestId,
        operationContext,
      );
      return parseUploadTriggerResponse(await response.json());
    },
    triggerDocs(publicationDate) {
      return handleDocsTrigger(
        env,
        "line",
        clock,
        publicationDate,
        fetcher,
        operationContext,
      );
    },
  };
}
