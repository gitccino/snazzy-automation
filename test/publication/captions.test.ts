import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { getMonthlyUsage } from "../../src/db/usage-repository";
import { testEnv } from "../helpers/env";
import {
  generateCaptionsForRun,
  planCaptionBatches,
  requestCaptionBatch,
  toCaptionRequestProducts,
} from "../../src/publication/captions";
import type { CaptionRequestProduct } from "../../src/publication/captions";
import type { PublicationProduct } from "../../src/publication/types";

function product(productId: string): PublicationProduct {
  return {
    airtableRecordId: `rec-${productId}`,
    productId,
    orderedImageKeys: ["a", "b", "c", "d"],
    brandName: "Nike",
    modelName: "Air Max",
    conditionType: "Used",
    size: "42",
    description: "Good condition",
    lineSquarePrice: 1290,
    igPrice: 1390,
  };
}

function toolResponse(
  captions: Array<{ productId: string; drafts: string[] }>,
  usage = { input_tokens: 0, output_tokens: 0 },
) {
  return {
    content: [
      {
        type: "tool_use",
        name: "submit_captions",
        input: { captions },
      },
    ],
    usage,
  };
}

type CountTokensParams = Parameters<Anthropic["messages"]["countTokens"]>[0];

function sdkClient(
  messages: Record<string, ReturnType<typeof vi.fn>>,
): Pick<Anthropic, "messages"> {
  // Test-only structural stub. Production always constructs official Anthropic SDK client.
  return { messages } as unknown as Pick<Anthropic, "messages">;
}

describe("toCaptionRequestProducts", () => {
  it("normalizes the exact caption source fields before sending them to Claude", () => {
    expect(toCaptionRequestProducts([{ ...product("A-1001"), brandName: " Cafe\u0301 ",
      modelName: " Air Max ", conditionType: " Used ", size: " 42 ", description: " ดี\r\nพร้อมใช้\r\n ",
    }])).toEqual([{ productId: "A-1001", brandName: "Café", modelName: "Air Max", conditionType: "Used", size: "42", description: "ดี\nพร้อมใช้" }]);
  });

  it("maps only the text fields Claude needs, no images", () => {
    const result = toCaptionRequestProducts([product("A-1001")]);
    expect(result).toEqual([
      {
        productId: "A-1001",
        brandName: "Nike",
        modelName: "Air Max",
        conditionType: "Used",
        size: "42",
        description: "Good condition",
      },
    ]);
  });
});

describe("planCaptionBatches", () => {
  it("returns a single batch when the estimated token count fits the limit", async () => {
    const client = sdkClient({
      countTokens: vi.fn().mockResolvedValue({ input_tokens: 500 }),
    });
    const products = [toCaptionRequestProducts([product("A-1001")])[0]!, toCaptionRequestProducts([product("A-1002")])[0]!];
    const batches = await planCaptionBatches(client, "claude-opus-5", products, 1000);
    expect(batches).toEqual([products.sort((a, b) => a.productId.localeCompare(b.productId))]);
  });

  it("sends strict tool arrays without unsupported length constraints", async () => {
    const countTokens = vi.fn().mockResolvedValue({ input_tokens: 500 });
    await planCaptionBatches(
      sdkClient({ countTokens }),
      "claude-opus-5",
      [toCaptionRequestProducts([product("A-1001")])[0]!],
      1_000,
    );

    const params = countTokens.mock.calls[0]?.[0] as CountTokensParams | undefined;
    const tool = params?.tools?.[0] as unknown as { input_schema?: {
      properties?: {
        captions?: {
          items?: {
            properties?: {
              drafts?: { type?: string; items?: { type?: string }; minItems?: number; maxItems?: number };
            };
          };
        };
      };
    } } | undefined;

    expect(tool?.input_schema?.properties?.captions?.items?.properties?.drafts).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("splits deterministically by sorted Product ID when over the limit", async () => {
    const client = sdkClient({
      countTokens: vi.fn().mockImplementation(
        async ({ messages }: CountTokensParams) => {
          const text = messages[0]!.content as string;
          const productCount = (text.match(/"productId"/g) ?? []).length;
          return {
            input_tokens: productCount > 1 ? 2000 : 400,
          };
        },
      ),
    });
    const products = ["A-1003", "A-1001", "A-1002", "A-1004"].map((id) => toCaptionRequestProducts([product(id)])[0]!);
    const batches = await planCaptionBatches(client, "claude-opus-5", products, 1000);
    expect(batches.every((batch) => batch.length === 1)).toBe(true);
    expect(batches.map((batch) => batch[0]!.productId)).toEqual(["A-1001", "A-1002", "A-1003", "A-1004"]);
  });

  it("uses the smallest number of deterministic Product-ID-ordered batches", async () => {
    const tokenWeights = new Map([
      ["A-1001", 700],
      ["A-1002", 100],
      ["A-1003", 100],
      ["A-1004", 100],
      ["A-1005", 100],
    ]);
    const client = sdkClient({
      countTokens: vi.fn().mockImplementation(
        async ({ messages }: CountTokensParams) => {
          const text = messages[0]!.content as string;
          const productIds = [...text.matchAll(/Product ID: (A-\d+)/g)].map((match) => match[1]!);
          return {
            input_tokens: productIds.reduce(
              (total, productId) => total + (tokenWeights.get(productId) ?? 0),
              0,
            ),
          };
        },
      ),
    });
    const products = ["A-1005", "A-1001", "A-1004", "A-1002", "A-1003"].map(
      (id) => toCaptionRequestProducts([product(id)])[0]!,
    );

    const batches = await planCaptionBatches(client, "claude-opus-5", products, 800);

    expect(batches.map((batch) => batch.map(({ productId }) => productId))).toEqual([
      ["A-1001", "A-1002"],
      ["A-1003", "A-1004", "A-1005"],
    ]);
  });

  it("rejects one Product that exceeds the configured input-token limit", async () => {
    const client = sdkClient({
      countTokens: vi.fn().mockResolvedValue({ input_tokens: 1_001 }),
    });

    await expect(planCaptionBatches(
      client,
      "claude-opus-5",
      [toCaptionRequestProducts([product("A-1001")])[0]!],
      1_000,
    )).rejects.toMatchObject({
      code: "anthropic_input_too_large",
      retryable: false,
    });
  });

  it("classifies a permanent count-tokens rejection as non-retryable", async () => {
    const client = sdkClient({
      countTokens: vi.fn().mockRejectedValue({ status: 401 }),
    });

    await expect(planCaptionBatches(
      client,
      "claude-opus-5",
      [toCaptionRequestProducts([product("A-1001")])[0]!],
      1_000,
    )).rejects.toMatchObject({
      code: "anthropic_count_tokens_failed",
      retryable: false,
    });
  });

  it("logs safe Anthropic diagnostics for a retryable count-tokens failure", async () => {
    const error = Object.assign(new Error("secret response text"), {
      status: 429,
      type: "rate_limit_error",
      requestID: "req_test123",
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = sdkClient({
      countTokens: vi.fn().mockRejectedValue(error),
    });

    try {
      await expect(planCaptionBatches(
        client,
        "claude-opus-5",
        [toCaptionRequestProducts([product("A-1001")])[0]!],
        1_000,
      )).rejects.toBe(error);

      expect(log).toHaveBeenCalledWith("Anthropic request failed", {
        operation: "count_tokens",
        status: 429,
        errorType: "rate_limit_error",
        errorName: "Error",
        requestId: "req_test123",
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret response text");
    } finally {
      log.mockRestore();
    }
  });
});

describe("requestCaptionBatch", () => {
  it("returns three Thai drafts per requested Product ID on a clean response", async () => {
    const create = vi.fn().mockResolvedValue(
      toolResponse([
        {
          productId: "A-1001",
          drafts: ["หนึ่ง", "สอง", "สาม"],
        },
      ]),
    );
    const client = sdkClient({ create });
    const outcome = await requestCaptionBatch(client, "claude-opus-5", [toCaptionRequestProducts([product("A-1001")])[0]!]);
    expect(outcome).toEqual({ captions: [{ productId: "A-1001", drafts: ["หนึ่ง", "สอง", "สาม"] }], missingProductIds: [] });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-opus-5",
        thinking: { type: "adaptive" },
        tool_choice: { type: "tool", name: "submit_captions" },
      }),
    );
    const request = create.mock.calls[0]![0];
    expect(JSON.stringify(request.messages)).not.toContain("orderedImageKeys");
    expect(JSON.stringify(request.messages)).not.toContain("assets/");
  });

  it("marks only the Product IDs with missing or invalid captions for retry", async () => {
    const client = sdkClient({
      create: vi.fn().mockResolvedValue(
        toolResponse([
          {
            productId: "A-1001",
            drafts: ["หนึ่ง", "สอง", "สาม"],
          },
          {
            productId: "A-1002",
            drafts: ["one", "two", "three"],
          },
        ]),
      ),
    });
    const requested = [toCaptionRequestProducts([product("A-1001")])[0]!, toCaptionRequestProducts([product("A-1002")])[0]!];
    const outcome = await requestCaptionBatch(client, "claude-opus-5", requested);
    expect(outcome.captions).toEqual([{ productId: "A-1001", drafts: ["หนึ่ง", "สอง", "สาม"] }]);
    expect(outcome.missingProductIds).toEqual(["A-1002"]);
  });

  it("marks every requested Product ID for retry when the response cannot be parsed", async () => {
    const client = sdkClient({
      create: vi.fn().mockResolvedValue({ content: [], usage: { input_tokens: 0, output_tokens: 0 } }),
    });
    const requested = [toCaptionRequestProducts([product("A-1001")])[0]!, toCaptionRequestProducts([product("A-1002")])[0]!];
    const outcome = await requestCaptionBatch(client, "claude-opus-5", requested);
    expect(outcome.captions).toEqual([]);
    expect(outcome.missingProductIds).toEqual(["A-1001", "A-1002"]);
  });

  it("marks every requested Product ID for retry when response blocks are malformed", async () => {
    const client = sdkClient({
      create: vi.fn().mockResolvedValue({ content: [null] }),
    });
    const requested = [toCaptionRequestProducts([product("A-1001")])[0]!];
    const outcome = await requestCaptionBatch(client, "claude-opus-5", requested);
    expect(outcome).toEqual({ captions: [], missingProductIds: ["A-1001"] });
  });

  it("marks every requested Product ID for retry when the tool call throws", async () => {
    const client = sdkClient({
      create: vi.fn().mockRejectedValue(new Error("rate limited")),
    });
    const requested = [toCaptionRequestProducts([product("A-1001")])[0]!];
    const outcome = await requestCaptionBatch(client, "claude-opus-5", requested);
    expect(outcome.missingProductIds).toEqual(["A-1001"]);
  });

  it("classifies a permanent Messages API rejection as non-retryable", async () => {
    const client = sdkClient({
      create: vi.fn().mockRejectedValue({ status: 401 }),
    });
    const requested = [toCaptionRequestProducts([product("A-1001")])[0]!];

    await expect(requestCaptionBatch(
      client,
      "claude-opus-5",
      requested,
    )).rejects.toMatchObject({
      code: "anthropic_create_message_failed",
      retryable: false,
    });
  });

  it("marks every requested Product ID for retry when returned IDs don't match the requested set", async () => {
    const client = sdkClient({
      create: vi.fn().mockResolvedValue(
        toolResponse([
          {
            productId: "A-9999",
            drafts: ["หนึ่ง", "สอง", "สาม"],
          },
        ]),
      ),
    });
    const requested = [toCaptionRequestProducts([product("A-1001")])[0]!];
    const outcome = await requestCaptionBatch(client, "claude-opus-5", requested);
    expect(outcome.captions).toEqual([]);
    expect(outcome.missingProductIds).toEqual(["A-1001"]);
  });
});

describe("generateCaptionsForRun", () => {
  it("returns captions when output-token persistence fails after input tokens", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = sdkClient({
      countTokens: vi.fn().mockResolvedValue({ input_tokens: 500 }),
      create: vi.fn().mockResolvedValue(toolResponse(
        [{ productId: "A-1001", drafts: ["หนึ่ง", "สอง", "สาม"] }],
        { input_tokens: 500, output_tokens: 300 },
      )),
    });
    const failingDb = {
      prepare: vi.fn()
        .mockReturnValueOnce({ bind: () => ({ run: async () => undefined }) })
        .mockImplementationOnce(() => { throw new Error("D1 unavailable"); }),
    } as unknown as D1Database;

    try {
      await expect(generateCaptionsForRun(
        client,
        "claude-opus-5",
        1_000,
        toCaptionRequestProducts([product("A-1001")]),
        { db: failingDb, clock: { now: () => new Date("2026-09-01T10:00:00+07:00") } },
      )).resolves.toEqual({
        captions: [{ productId: "A-1001", drafts: ["หนึ่ง", "สอง", "สาม"] }],
        missingProductIds: [],
      });
      expect(warning).toHaveBeenCalledWith("Usage metric recording failed");
    } finally {
      warning.mockRestore();
    }
  });

  it("records Claude input output token usage in D1", async () => {
    const client = sdkClient({
      countTokens: vi.fn().mockResolvedValue({ input_tokens: 500 }),
      create: vi.fn().mockResolvedValue(toolResponse(
        [{ productId: "A-1001", drafts: ["หนึ่ง", "สอง", "สาม"] }],
        { input_tokens: 500, output_tokens: 300 },
      )),
    });
    const products = toCaptionRequestProducts([product("A-1001")]);

    await generateCaptionsForRun(
      client,
      "claude-opus-5",
      1_000,
      products,
      { db: testEnv().DB, clock: { now: () => new Date("2026-09-01T10:00:00+07:00") } },
    );

    const usage = await getMonthlyUsage(testEnv().DB, "2026-09");
    expect(usage.claude_input_tokens).toBe(500);
    expect(usage.claude_output_tokens).toBe(300);
  });

  it("preserves earlier captions when a later split batch has a malformed envelope", async () => {
    const client = sdkClient({
      countTokens: vi.fn().mockImplementation(
        async ({ messages }: CountTokensParams) => ({
          input_tokens: (messages[0]!.content as string)
            .match(/"productId"/g)?.length === 1
            ? 100
            : 2_000,
        }),
      ),
      create: vi.fn()
        .mockResolvedValueOnce(
          toolResponse([
            {
              productId: "A-1001",
              drafts: ["หนึ่ง", "สอง", "สาม"],
            },
          ]),
        )
        .mockResolvedValueOnce({ content: null }),
    });
    const products = ["A-1001", "A-1002"].map((id) => toCaptionRequestProducts([product(id)])[0]!);
    const outcome = await generateCaptionsForRun(client, "claude-opus-5", 1000, products);
    expect(outcome.captions).toEqual([
      { productId: "A-1001", drafts: ["หนึ่ง", "สอง", "สาม"] },
    ]);
    expect(outcome.missingProductIds).toEqual(["A-1002"]);
  });
});
