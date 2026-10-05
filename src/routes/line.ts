import { z } from "zod";
import { parseConfig } from "../config";
import { createAuditLog } from "../db/audit";
import { createLineRepository } from "../db/line-repository";
import type { Env } from "../env";
import { createInventoryClient } from "../line/airtable-inventory";
import { createLineClient } from "../line/client";
import type { DocsTriggerResult, UploadTriggerResult } from "../line/search";
import { verifyLineSignature } from "../line/signature";
import { parseSupportedLineEvents, type SupportedLineEvent } from "../line/types";
import { processLineEvents } from "../line/webhook";
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

export function parseUploadTriggerResponse(value: unknown): UploadTriggerResult {
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
  if (!await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }

  let events: SupportedLineEvent[];
  try {
    events = parseSupportedLineEvents(JSON.parse(new TextDecoder().decode(rawBody)) as unknown);
  } catch {
    return new Response("invalid payload", { status: 400 });
  }

  if (override !== undefined) {
    ctx.waitUntil(override.process(events));
    return new Response("ok");
  }

  const config = parseConfig(env.APP_CONFIG_JSON);
  const clock = { now: () => new Date() };
  const ids = { next: () => crypto.randomUUID() };
  const fetcher = fetch.bind(globalThis);
  const line = createLineClient({
    channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
    fetch: fetcher,
  });
  ctx.waitUntil(processLineEvents(events, {
    publicBaseUrl: config.publicBaseUrl,
    allowedGroupId: config.lineAllowedGroupId,
    confirmationEnabled: config.soldoutConfirmationEnabled,
    line,
    clock,
    ids,
    repo: createLineRepository(env.DB, ids, clock),
    audit: createAuditLog(env.DB, ids, clock),
    inventory: createInventoryClient({
      baseId: config.airtableBaseId,
      tableId: config.airtableProductsTableId,
      token: env.AIRTABLE_TOKEN,
      fetch: fetcher,
      now: clock.now,
    }),
    async triggerUpload() {
      const response = await handleUploadTrigger(env, "line");
      return parseUploadTriggerResponse(await response.json());
    },
    triggerDocs(publicationDate) {
      return handleDocsTrigger(env, "line", clock, publicationDate);
    },
  }));
  return new Response("ok");
}
