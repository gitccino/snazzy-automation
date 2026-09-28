import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { recordUsage } from "../db/usage-repository";
import { OperationalError } from "../shared/errors";
import { sha256Hex } from "../shared/ids";
import { todayBangkokDate, type Clock } from "../shared/time";
import type { CaptionSet, PublicationProduct } from "./types";

export interface CaptionRequestProduct {
  productId: string;
  brandName: string;
  modelName: string;
  conditionType: string;
  size: string;
  description: string;
}

export interface CaptionGenerationOutcome {
  captions: CaptionSet[];
  missingProductIds: string[];
}

interface CaptionUsageContext {
  db: D1Database;
  clock: Clock;
}

// Bump whenever the prompt, tool schema, or draft validation contract changes.
const CAPTION_PROMPT_SCHEMA_VERSION = "thai-marketplace-v1";

const CAPTIONS_TOOL_SCHEMA = {
  name: "submit_captions",
  description: "Submit exactly three Thai caption drafts for each requested Product ID.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      captions: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            productId: { type: "string" as const },
            drafts: {
              type: "array" as const,
              items: { type: "string" as const },
            },
          },
          required: ["productId", "drafts"],
          additionalProperties: false,
        },
      },
    },
    required: ["captions"],
    additionalProperties: false,
  },
};

const ThaiDraftSchema = z.string()
  .trim()
  .min(1)
  .max(400)
  .regex(/[ก-๙]/);

const CaptionSchema = z.object({
  productId: z.string(),
  drafts: z.tuple([
    ThaiDraftSchema,
    ThaiDraftSchema,
    ThaiDraftSchema,
  ]),
});

const ResponseSchema = z.object({
  captions: z.array(z.unknown()),
});

export function toCaptionRequestProducts(
  products: PublicationProduct[],
): CaptionRequestProduct[] {
  const normalize = (text: string) => text.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  return products.map((product) => ({
    productId: product.productId,
    brandName: normalize(product.brandName),
    modelName: normalize(product.modelName),
    conditionType: normalize(product.conditionType),
    size: normalize(product.size),
    description: normalize(product.description),
  }));
}

export async function captionInputFingerprint(product: PublicationProduct, model: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify([
    CAPTION_PROMPT_SCHEMA_VERSION, model, toCaptionRequestProducts([product])[0],
  ])));
}

function buildPrompt(products: CaptionRequestProduct[]): string {
  const lines = products.map(
    (product) =>
      `Product ID: ${product.productId}\nProduct details: ${JSON.stringify(product)}`,
  );
  return [
    "Write exactly three short Thai marketplace caption drafts for each product below.",
    "Use only the facts given. Do not invent details. Keep each draft under 400 Thai characters.",
    "Call submit_captions with one entry per Product ID, in the same order as given.",
    "",
    ...lines,
  ].join("\n\n");
}

function buildRequestParams(model: string, products: CaptionRequestProduct[]) {
  return {
    model,
    max_tokens: 16_000,
    thinking: { type: "adaptive" as const },
    tools: [CAPTIONS_TOOL_SCHEMA],
    tool_choice: { type: "tool" as const, name: "submit_captions" },
    messages: [{ role: "user" as const, content: buildPrompt(products) }],
  };
}

function apiStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function rethrowPermanentAnthropicError(
  error: unknown,
  action: "count_tokens" | "create_message",
): void {
  const status = apiStatus(error);
  const details = typeof error === "object" && error !== null
    ? error as { type?: unknown; requestID?: unknown }
    : {};
  const errorType = typeof details.type === "string"
    && /^[a-z][a-z0-9_]{0,63}$/.test(details.type)
    ? details.type
    : null;
  const requestId = typeof details.requestID === "string"
    && /^[A-Za-z0-9_-]{1,128}$/.test(details.requestID)
    ? details.requestID
    : null;
  const errorName = error instanceof Error
    && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : null;
  console.error("Anthropic request failed", {
    operation: action,
    status,
    errorType,
    errorName,
    requestId,
  });
  if (status !== null && status >= 400 && status < 500 && status !== 429) {
    throw new OperationalError(
      `anthropic_${action}_failed`,
      `Anthropic ${action} failed with status ${status}`,
      false,
    );
  }
}

function isSubmitCaptionsToolUse(
  block: unknown,
): block is Anthropic.Messages.ToolUseBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    block.type === "tool_use" &&
    "name" in block &&
    block.name === "submit_captions"
  );
}

async function countInputTokens(
  client: Pick<Anthropic, "messages">,
  model: string,
  products: CaptionRequestProduct[],
): Promise<number> {
  const params = buildRequestParams(model, products);
  try {
    const result = await client.messages.countTokens({
      model: params.model,
      messages: params.messages,
      tools: params.tools,
    });
    return result.input_tokens;
  } catch (error) {
    rethrowPermanentAnthropicError(error, "count_tokens");
    throw error;
  }
}

export async function planCaptionBatches(
  client: Pick<Anthropic, "messages">,
  model: string,
  products: CaptionRequestProduct[],
  inputTokenLimit: number,
): Promise<CaptionRequestProduct[][]> {
  const sorted = [...products].sort((a, b) =>
    a.productId.localeCompare(b.productId),
  );
  const batches: CaptionRequestProduct[][] = [];
  let current: CaptionRequestProduct[] = [];

  for (const product of sorted) {
    const candidate = [...current, product];
    const candidateTokens = await countInputTokens(client, model, candidate);
    if (candidateTokens <= inputTokenLimit) {
      current = candidate;
      continue;
    }

    if (current.length === 0) {
      throw new OperationalError(
        "anthropic_input_too_large",
        `Product ${product.productId} exceeds the configured Claude input-token limit`,
        false,
      );
    }

    batches.push(current);
    const singleTokens = await countInputTokens(client, model, [product]);
    if (singleTokens > inputTokenLimit) {
      throw new OperationalError(
        "anthropic_input_too_large",
        `Product ${product.productId} exceeds the configured Claude input-token limit`,
        false,
      );
    }
    current = [product];
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

export async function requestCaptionBatch(
  client: Pick<Anthropic, "messages">,
  model: string,
  products: CaptionRequestProduct[],
  usageContext?: CaptionUsageContext,
): Promise<CaptionGenerationOutcome> {
  const requestedIds = products.map((product) => product.productId);
  const requestedIdSet = new Set(requestedIds);
  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create(buildRequestParams(model, products));
  } catch (error) {
    rethrowPermanentAnthropicError(error, "create_message");
    return { captions: [], missingProductIds: requestedIds };
  }
  if (usageContext && response.usage) {
    // ponytail: best-effort metrics; add a durable outbox when billing-grade accuracy is required.
    try {
      const metricDate = todayBangkokDate(usageContext.clock);
      await recordUsage(usageContext.db, "claude_input_tokens", response.usage.input_tokens, metricDate);
      await recordUsage(usageContext.db, "claude_output_tokens", response.usage.output_tokens, metricDate);
    } catch {
      console.warn("Usage metric recording failed");
    }
  }

  if (
    typeof response !== "object" ||
    response === null ||
    !("content" in response) ||
    !Array.isArray(response.content)
  ) {
    return { captions: [], missingProductIds: requestedIds };
  }

  const toolUse = response.content.find(isSubmitCaptionsToolUse);
  if (!toolUse) return { captions: [], missingProductIds: requestedIds };

  const parsed = ResponseSchema.safeParse(toolUse.input);
  if (!parsed.success) return { captions: [], missingProductIds: requestedIds };

  const returnedIds = parsed.data.captions.map((caption) =>
    typeof caption === "object" && caption !== null && "productId" in caption &&
    typeof caption.productId === "string"
      ? caption.productId
      : null,
  );
  const invalidIdSet =
    parsed.data.captions.length !== requestedIdSet.size ||
    returnedIds.some((id) => id === null || !requestedIdSet.has(id)) ||
    new Set(returnedIds).size !== requestedIdSet.size;
  if (invalidIdSet) return { captions: [], missingProductIds: requestedIds };

  const captionsByProductId = new Map<string, CaptionSet>();
  for (const rawCaption of parsed.data.captions) {
    const caption = CaptionSchema.safeParse(rawCaption);
    if (caption.success) {
      captionsByProductId.set(caption.data.productId, {
        productId: caption.data.productId,
        drafts: caption.data.drafts,
      });
    }
  }

  const captions: CaptionSet[] = [];
  const missingProductIds: string[] = [];
  for (const productId of requestedIds) {
    const caption = captionsByProductId.get(productId);
    if (caption) captions.push(caption);
    else missingProductIds.push(productId);
  }
  return { captions, missingProductIds };
}

export async function generateCaptionsForRun(
  client: Pick<Anthropic, "messages">,
  model: string,
  inputTokenLimit: number,
  products: CaptionRequestProduct[],
  usageContext?: CaptionUsageContext,
): Promise<CaptionGenerationOutcome> {
  if (products.length === 0) return { captions: [], missingProductIds: [] };

  const batches = await planCaptionBatches(
    client,
    model,
    products,
    inputTokenLimit,
  );
  const captions: CaptionSet[] = [];
  const missingProductIds: string[] = [];
  for (const batch of batches) {
    const outcome = await requestCaptionBatch(client, model, batch, usageContext);
    captions.push(...outcome.captions);
    missingProductIds.push(...outcome.missingProductIds);
  }
  return { captions, missingProductIds };
}
