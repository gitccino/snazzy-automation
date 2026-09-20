import { generateKeyPairSync } from "node:crypto";
import type { WorkflowStep } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../src/config";
import type { Env } from "../../src/env";
import {
  acquireOrResumeJob, getProductCache, putProductCollage,
} from "../../src/db/publication-repository";
import { createAssetStore, verifyAssetToken } from "../../src/import/asset-store";
import { collageInputFingerprint, type ImageTransformer } from "../../src/publication/collage";
import type { GoogleDocsRequest } from "../../src/publication/google-docs";
import {
  preparePublicationOutputs, type PublicationServiceDeps, type ValidatedPublication,
} from "../../src/publication/service";
import type { PublicationProduct, PublicationRunStatus } from "../../src/publication/types";
import { runPublicationWorkflow } from "../../src/publication/workflow";
import { handleDocsRoute } from "../../src/routes/docs";
import { createTestEnv, testEnv } from "../helpers/env";
import { fakeFetch, fixedClock } from "../helpers/fakes";
import { retryingStep } from "../helpers/workflow-step";

const env = testEnv();
const clock = fixedClock("2026-09-01T17:30:00.000Z");
const runId = "rec-run-1";
const configEnv = createTestEnv();
const config = parseConfig(configEnv.APP_CONFIG_JSON);
const suffix = "\nสนใจทักแชต\n#Snazzy\n";
const template = `หัวกระดาษ {{PUBLICATION_DATE}}\n{{PRODUCTS}}${suffix}{{END_PRODUCTS}}\nท้ายกระดาษ\n`;
let privateKey = "";

beforeAll(() => {
  privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
});

function product(productId: string): PublicationProduct {
  return {
    airtableRecordId: `rec-${productId}`, productId,
    orderedImageKeys: ["third", "first", "fourth", "second", "unused"]
      .map(name => `assets/${productId}-${name}.jpg`),
    brandName: "Nike", modelName: "Air Max", conditionType: "Used", size: "42",
    description: "สภาพดี", lineSquarePrice: 1290, igPrice: 1390,
  };
}

function drafts(id: string): [string, string, string] {
  return [`แคปชันหนึ่ง ${id}`, `แคปชันสอง ${id}`, `แคปชันสาม ${id}`];
}

function toolResponse(entries: Array<{ productId: string; drafts: string[] }>) {
  return {
    content: [{ type: "tool_use", id: "tool-1", name: "submit_captions", input: { captions: entries } }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function validated(products: PublicationProduct[]): ValidatedPublication {
  return {
    run: { airtableRunId: runId, publicationDate: "2026-09-02", status: "Ready", products },
    thaiDate: "2 กันยายน 2569",
  };
}

async function job() {
  return env.DB.prepare(`SELECT state, temp_doc_id, google_doc_id, google_doc_url, correlation_id
    FROM publication_jobs WHERE publication_run_id = ?`).bind(runId).first();
}

async function seedCollages(products: PublicationProduct[]) {
  await acquireOrResumeJob(env.DB, clock, runId, `publication-${runId}`);
  for (const item of products) {
    await putProductCollage(env.DB, clock, runId, item.productId,
      `products/${item.productId}/collage/1080x1080.jpg`, await collageInputFingerprint(item.orderedImageKeys));
  }
}

function imageBoundary() {
  const sources = new Map<ReadableStream<Uint8Array>, string>();
  const transformers = new Map<ImageTransformer, string>();
  const transforms: Array<{ key: string; options: Parameters<ImageTransformer["transform"]>[0] }> = [];
  const draws: Array<{ base: string; key: string; options: Parameters<ImageTransformer["draw"]>[1] }> = [];
  const get = vi.fn(async (key: string) => {
    const body = new ReadableStream<Uint8Array>();
    sources.set(body, key);
    return { body };
  });
  const put = vi.fn().mockResolvedValue(null);
  const output = vi.fn(async () => ({ response: () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }) }));
  const input = vi.fn((stream: ReadableStream<Uint8Array>): ImageTransformer => {
    const key = sources.get(stream);
    if (!key) throw new Error("Images input was not an R2 body");
    const transformer: ImageTransformer = {
      transform(options) { transforms.push({ key, options }); return transformer; },
      draw(overlay, options) {
        const sourceKey = transformers.get(overlay as ImageTransformer);
        if (!sourceKey) throw new Error("Images draw was not a transformed source");
        draws.push({ base: key, key: sourceKey, options });
        return transformer;
      },
      output,
    };
    transformers.set(transformer, key);
    return transformer;
  });
  return { bucket: { get, put } as unknown as R2Bucket, get, put, images: { input }, transforms, draws, output };
}

// In-memory HTTP boundary: documents change only through the actual requests
// emitted by production. Unexpected URLs fail instead of reaching the network.
function publicationFixture(products = [product("A-1001")], fixtureRunId = runId) {
  const state = {
    status: "Ready" as PublicationRunStatus,
    docs: new Map<string, { text: string; name: string }>(),
    nextDoc: 1,
    loseCopyResponse: false,
    loseFillResponse: false,
    batchFailureStatus: 0,
    errorSummary: null as string | null,
  };
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  const batches: GoogleDocsRequest[][] = [];
  const failureSnapshots: unknown[] = [];
  const runRecord = () => ({ id: fixtureRunId, fields: {
    "Publication Date": "2026-09-02", Status: state.status,
    Products: products.map(item => item.airtableRecordId),
  } });
  const fetcher = fakeFetch([{
    match: () => true,
    respond: async request => {
      const url = new URL(request.url);
      const body = request.body && request.headers.get("content-type")?.includes("application/json")
        ? await request.json() as Record<string, unknown> : {};
      calls.push({ method: request.method, url: request.url, body });
      if (url.hostname === "api.airtable.com") {
        if (url.pathname.endsWith(`/tblRuns/${fixtureRunId}`)) {
          if (request.method === "PATCH") {
            const fields = body.fields as { Status: PublicationRunStatus; "Error Summary"?: string | null };
            state.status = fields.Status;
            if ("Error Summary" in fields) state.errorSummary = fields["Error Summary"] ?? null;
          }
          return Response.json(runRecord());
        }
        if (url.pathname.endsWith("/tblRuns")) return Response.json({ records: [runRecord()] });
        if (url.pathname.endsWith("/tblProducts")) return Response.json({
          records: [...products].reverse().map(item => ({ id: item.airtableRecordId, fields: {
            "Product ID": item.productId,
            "Product Images": item.orderedImageKeys.map((key, i) => ({
              id: `attachment-${i}`, url: `https://dl.airtable.com/${i}`, filename: key.slice(7),
            })),
            "Brand Name": item.brandName, "Model Name": item.modelName,
            "Condition Type": item.conditionType, Size: item.size, Description: item.description,
            "LINE Square Price": item.lineSquarePrice, "IG Price": item.igPrice,
          } })),
        });
        if (request.method === "PATCH" && products.some(p => url.pathname.endsWith(`/tblProducts/${p.airtableRecordId}`))) {
          return Response.json({ id: url.pathname.split("/").at(-1) });
        }
      }
      if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "google-token", expires_in: 3600 });
      if (url.pathname === "/drive/v3/files" && request.method === "GET") {
        return Response.json({ files: [...state.docs.keys()].map(id => ({ id })) });
      }
      if (url.pathname === "/drive/v3/files/template-1/copy" && request.method === "POST") {
        const id = `temp-doc-${state.nextDoc++}`;
        state.docs.set(id, { text: template, name: String(body.name) });
        if (state.loseCopyResponse) { state.loseCopyResponse = false; throw new Error("copy response lost"); }
        return Response.json({ id });
      }
      const id = url.pathname.split("/").at(-1)!.replace(":batchUpdate", "");
      const doc = state.docs.get(id);
      if (doc && url.hostname === "docs.googleapis.com") {
        if (request.method === "GET") return Response.json({ body: { content: [{ paragraph: {
          elements: [{ startIndex: 1, textRun: { content: doc.text } }],
        } }] } });
        if (url.pathname.endsWith(":batchUpdate")) {
          const requests = body.requests as GoogleDocsRequest[];
          batches.push(requests);
          if (state.batchFailureStatus) {
            failureSnapshots.push({ job: await job(), docs: state.docs.size, status: state.status });
            return new Response("Google unavailable", { status: state.batchFailureStatus });
          }
          // Google Docs indices are one-based UTF-16 offsets; images occupy one unit.
          let text = doc.text;
          for (const operation of requests) {
            if ("deleteContentRange" in operation) {
              const range = operation.deleteContentRange.range;
              text = text.slice(0, range.startIndex - 1) + text.slice(range.endIndex - 1);
            } else if ("insertText" in operation) {
              const { location, text: inserted } = operation.insertText;
              text = text.slice(0, location.index - 1) + inserted + text.slice(location.index - 1);
            } else if ("insertInlineImage" in operation) {
              const index = operation.insertInlineImage.location.index - 1;
              text = text.slice(0, index) + "\uFFFC" + text.slice(index);
            } else {
              text = text.replaceAll(operation.replaceAllText.containsText.text, operation.replaceAllText.replaceText);
            }
          }
          doc.text = text;
          if (state.loseFillResponse) { state.loseFillResponse = false; throw new Error("fill response lost"); }
          return Response.json({ documentId: id });
        }
      }
      if (doc && url.pathname.startsWith("/drive/v3/files/")) {
        if (request.method === "PATCH") { doc.name = String(body.name); return Response.json({ id }); }
        if (request.method === "DELETE") { state.docs.delete(id); return new Response(null, { status: 204 }); }
      }
      throw new Error(`Unexpected HTTP request: ${request.method} ${request.url}`);
    },
  }]);
  const image = imageBoundary();
  const countTokens = vi.fn().mockResolvedValue({ input_tokens: 12_000 });
  const create = vi.fn().mockResolvedValue(toolResponse(products.map(p => ({ productId: p.productId, drafts: drafts(p.productId) }))));
  const notify = vi.fn().mockResolvedValue(undefined);
  const deps: PublicationServiceDeps = {
    db: env.DB, bucket: image.bucket, images: image.images,
    assets: createAssetStore(image.bucket, { signingSecret: "test-secret", publicBaseUrl: config.publicBaseUrl }, clock),
    fetcher, clock, config, airtableToken: "airtable-token",
    googleServiceAccountJson: JSON.stringify({ client_email: "svc@example.com", private_key: privateKey }),
    anthropic: { messages: { countTokens, create } } as unknown as PublicationServiceDeps["anthropic"],
    notify,
  };
  const scheduler = retryingStep();
  return {
    products, state, calls, batches, failureSnapshots, image, countTokens, create, notify, deps, scheduler,
    run: () => runPublicationWorkflow(
      { publicationRunId: fixtureRunId, trigger: "admin" },
      scheduler as unknown as WorkflowStep,
      deps,
    ),
  };
}

function workflowBinding() {
  let status = "unknown";
  const restart = vi.fn(async () => { status = "running"; });
  const create = vi.fn(async () => { status = "running"; return { id: `publication-${runId}` }; });
  const get = vi.fn(async () => ({ status: async () => ({ status }), restart, resume: vi.fn() }));
  return { create, get, restart, setStatus: (value: string) => { status = value; } };
}

function docsRequest() {
  return new Request("https://worker.example/docs", {
    method: "POST", headers: { authorization: `Bearer ${configEnv.ADMIN_ROUTE_TOKEN}` },
  });
}

describe("publication acceptance", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM publication_product_cache");
    await env.DB.exec("DELETE FROM publication_jobs");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden in acceptance tests"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("blocks the whole run for missing fields, restores Draft, and sends the complete Thai report", async () => {
    const fixture = publicationFixture([
      product("A-1001"), { ...product("A-1002"), description: "", size: "" },
      { ...product("A-1003"), brandName: "" },
    ]);
    expect(await fixture.run()).toBeNull();
    expect(fixture.state.status).toBe("Draft");
    expect(fixture.calls.filter(c => c.method === "PATCH").map(c => c.body)).toEqual([{
      fields: { Status: "Draft", "Error Summary": "A-1002: Size, Description\nA-1003: Brand Name" },
    }]);
    expect(await job()).toMatchObject({ state: "validation_failed", temp_doc_id: null, google_doc_id: null });
    expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("A-1002: Size, Description\nA-1003: Brand Name"));
    expect(fixture.notify.mock.calls[0]![0]).toMatch(/[ก-๙]/);
    expect(fixture.notify.mock.calls[0]![0]).toContain("2 กันยายน 2569");
    expect(fixture.calls.every(c => new URL(c.url).hostname === "api.airtable.com")).toBe(true);
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.countTokens).not.toHaveBeenCalled();
    expect(fixture.image.get).not.toHaveBeenCalled();
    expect(fixture.image.put).not.toHaveBeenCalled();
    expect(fixture.image.images.input).not.toHaveBeenCalled();
  });

  it("clears previous validation errors when staff corrects data and publication succeeds", async () => {
    const item = { ...product("A-1001"), description: "" };
    const fixture = publicationFixture([item]);
    expect(await fixture.run()).toBeNull();
    expect(fixture.state.errorSummary).toBe("A-1001: Description");
    item.description = "สภาพดี";
    fixture.state.status = "Ready";
    await fixture.run();
    expect(fixture.state.status).toBe("Generated");
    expect(fixture.state.errorSummary).toBeNull();
    expect(await env.DB.prepare("SELECT validation_result_json FROM publication_jobs WHERE publication_run_id = ?").bind(runId).first())
      .toEqual({ validation_result_json: null });
  });

  it("allows only one of two different runs to publish the same date, including concurrent Workflows", async () => {
    const first = publicationFixture();
    const second = publicationFixture([product("A-1002")], "rec-run-2");
    const results = await Promise.allSettled([first.run(), second.run()]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(first.state.docs.size + second.state.docs.size).toBe(1);
    expect(first.create.mock.calls.length + second.create.mock.calls.length).toBe(1);
    expect(first.image.put.mock.calls.length + second.image.put.mock.calls.length).toBe(1);
    const rows = await env.DB.prepare("SELECT publication_run_id, publication_date, state FROM publication_jobs ORDER BY publication_run_id")
      .all<{ publication_run_id: string; publication_date: string | null; state: string }>();
    expect(rows.results.filter(row => row.state === "succeeded")).toHaveLength(1);
    expect(rows.results.filter(row => row.publication_date === "2026-09-02")).toHaveLength(1);
    const winner = first.state.docs.size ? first : second;
    const loser = first.state.docs.size ? second : first;
    expect(loser.calls.every(call => new URL(call.url).hostname === "api.airtable.com")).toBe(true);
    expect(await winner.run()).toMatchObject({ googleDocId: "temp-doc-1" });
    expect(winner.state.docs.size).toBe(1);
  });

  it("regenerates edited Airtable inputs after Failed restart while preserving matching product outputs", async () => {
    const products = [product("A-1001"), product("A-1002")];
    const fixture = publicationFixture(products);
    fixture.state.batchFailureStatus = 503;
    await expect(fixture.run()).rejects.toThrow("Unable to fill or verify the Google document.");
    const changedBefore = await getProductCache(env.DB, runId, "A-1001");
    const unchangedBefore = await getProductCache(env.DB, runId, "A-1002");
    products[0]!.description = "คำอธิบายใหม่";
    products[0]!.orderedImageKeys.reverse();
    fixture.create.mockResolvedValueOnce(toolResponse([{ productId: "A-1001", drafts: ["ฉบับใหม่หนึ่ง", "ฉบับใหม่สอง", "ฉบับใหม่สาม"] }]));
    vi.mocked(globalThis.fetch).mockImplementation(fixture.deps.fetcher as typeof fetch);
    const binding = workflowBinding();
    binding.setStatus("errored");
    const response = await handleDocsRoute(docsRequest(), { ...env, ...configEnv, PUBLICATION_WORKFLOW: binding } as unknown as Env, clock);
    expect(await response.json()).toEqual({ status: "restarted", publicationRunId: runId });
    fixture.state.batchFailureStatus = 0;
    await fixture.run();
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.create.mock.calls[1]![0].messages[0].content).toContain("คำอธิบายใหม่");
    expect(fixture.create.mock.calls[1]![0].messages[0].content).not.toContain("A-1002");
    expect(fixture.image.put.mock.calls.map(call => call[0])).toEqual([
      "products/A-1001/collage/1080x1080.jpg", "products/A-1002/collage/1080x1080.jpg", "products/A-1001/collage/1080x1080.jpg",
    ]);
    expect(fixture.image.transforms.slice(-4).map(item => item.key)).toEqual(products[0]!.orderedImageKeys.slice(0, 4));
    const changedAfter = await getProductCache(env.DB, runId, "A-1001");
    expect(changedAfter.collageInputFingerprint).not.toBe(changedBefore.collageInputFingerprint);
    expect(changedAfter.captionsInputFingerprint).not.toBe(changedBefore.captionsInputFingerprint);
    expect(await getProductCache(env.DB, runId, "A-1002")).toEqual(unchangedBefore);
    expect(fixture.state.docs.get("temp-doc-2")!.text).toContain("Caption 1: ฉบับใหม่หนึ่ง");
    expect(fixture.state.errorSummary).toBeNull();
  });

  it("places the first four Airtable-ordered images in the white 1080-square collage and reuses its private cache", async () => {
    const fixture = publicationFixture();
    await fixture.run();
    const expectedKeys = ["third", "first", "fourth", "second"].map(name => `assets/A-1001-${name}.jpg`);
    expect(fixture.image.get.mock.calls.map(([key]) => key)).toEqual(["assets/collage-base-1080.jpg", ...expectedKeys]);
    expect(fixture.image.transforms).toEqual(expectedKeys.map(key => ({ key, options: {
      width: 504, height: 504, fit: "contain", background: "#FFFFFF",
    } })));
    expect(fixture.image.draws).toEqual([
      { base: "assets/collage-base-1080.jpg", key: expectedKeys[0], options: { top: 24, left: 24 } },
      { base: "assets/collage-base-1080.jpg", key: expectedKeys[1], options: { top: 24, left: 552 } },
      { base: "assets/collage-base-1080.jpg", key: expectedKeys[2], options: { top: 552, left: 24 } },
      { base: "assets/collage-base-1080.jpg", key: expectedKeys[3], options: { top: 552, left: 552 } },
    ]);
    expect(fixture.image.output).toHaveBeenCalledExactlyOnceWith({ format: "image/jpeg", quality: 90 });
    expect(fixture.image.put).toHaveBeenCalledExactlyOnceWith("products/A-1001/collage/1080x1080.jpg", new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/jpeg" } });
    const patch = fixture.calls.find(c => c.url.endsWith("/tblProducts/rec-A-1001"))!;
    const signedUrl = new URL((patch.body.fields as { "4-in-1 Image": Array<{ url: string }> })["4-in-1 Image"][0]!.url);
    expect(decodeURIComponent(signedUrl.pathname)).toBe("/assets/products/A-1001/collage/1080x1080.jpg");
    const expires = Number(signedUrl.searchParams.get("exp"));
    expect(expires - clock.now().getTime() / 1000).toBe(900);
    expect(await verifyAssetToken("products/A-1001/collage/1080x1080.jpg", expires, signedUrl.searchParams.get("sig")!, "test-secret", clock.now().getTime() / 1000)).toBe(true);
    expect(fixture.batches[0]!.filter(r => "insertInlineImage" in r).map(r => r.insertInlineImage.uri)).toEqual([signedUrl.toString()]);
    await fixture.run();
    expect(fixture.image.put).toHaveBeenCalledTimes(1);
  });

  it("caches exactly three Thai captions per ID for 22 products in one generation request", async () => {
    const products = Array.from({ length: 22 }, (_, i) => product(`A-${1001 + i}`)).reverse();
    const fixture = publicationFixture(products);
    await seedCollages(products);
    const prepared = await preparePublicationOutputs(fixture.deps, validated(products));
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(prepared.outputs).toHaveLength(22);
    const request = fixture.create.mock.calls[0]![0];
    expect(request).toMatchObject({ model: "claude-opus-5", thinking: { type: "adaptive" }, tool_choice: { type: "tool", name: "submit_captions" } });
    const prompt = request.messages[0].content as string;
    expect(prompt.match(/^Product ID: A-\d+$/gm)).toEqual(Array.from({ length: 22 }, (_, i) => `Product ID: A-${1001 + i}`));
    expect(prompt).not.toMatch(/assets\/|https:\/\//);
    for (const item of products) {
      const cache = await getProductCache(env.DB, runId, item.productId);
      expect(JSON.parse(cache.captionsJson!)).toEqual(drafts(item.productId));
      expect(prepared.outputs.find(o => o.product.productId === item.productId)!.captionDrafts).toEqual(drafts(item.productId));
    }
    await preparePublicationOutputs(fixture.deps, validated(products));
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.image.get).not.toHaveBeenCalled();
  });

  it("retries only IDs with invalid drafts, and caches nothing from malformed or missing-ID responses", async () => {
    const products = [product("A-1001"), product("A-1002"), product("A-1003")];
    const fixture = publicationFixture(products);
    await seedCollages(products);
    fixture.create.mockResolvedValueOnce(toolResponse([
      { productId: "A-1001", drafts: drafts("A-1001") },
      { productId: "A-1002", drafts: ["หนึ่ง", "สอง"] },
      { productId: "A-1003", drafts: ["English", "only", "drafts"] },
    ])).mockResolvedValueOnce(toolResponse(products.slice(1).map(p => ({ productId: p.productId, drafts: drafts(p.productId) }))));
    await expect(preparePublicationOutputs(fixture.deps, validated(products))).rejects.toThrow("caption generation incomplete for A-1002, A-1003");
    expect((await getProductCache(env.DB, runId, "A-1001")).captionsJson).toBe(JSON.stringify(drafts("A-1001")));
    for (const id of ["A-1002", "A-1003"]) expect((await getProductCache(env.DB, runId, id)).captionsJson).toBeNull();
    await preparePublicationOutputs(fixture.deps, validated(products));
    const retryPrompt = fixture.create.mock.calls[1]![0].messages[0].content as string;
    expect(retryPrompt.match(/^Product ID: A-\d+$/gm)).toEqual(["Product ID: A-1002", "Product ID: A-1003"]);
    for (const item of products) expect((await getProductCache(env.DB, runId, item.productId)).captionsJson).toBe(JSON.stringify(drafts(item.productId)));

    for (const badResponse of [{ content: [] }, toolResponse([{ productId: "A-1001", drafts: drafts("A-1001") }])]) {
      await env.DB.exec("UPDATE publication_product_cache SET captions_json = NULL");
      fixture.create.mockResolvedValueOnce(badResponse as ReturnType<typeof toolResponse>);
      await expect(preparePublicationOutputs(fixture.deps, validated(products))).rejects.toThrow("caption generation incomplete for A-1001, A-1002, A-1003");
      for (const item of products) expect((await getProductCache(env.DB, runId, item.productId)).captionsJson).toBeNull();
    }
  });

  it("recovers uncertain copy and fill responses into one final dated document with the template suffix per product", async () => {
    const fixture = publicationFixture([product("A-1002"), product("A-1001")]);
    fixture.state.loseCopyResponse = true;
    fixture.state.loseFillResponse = true;
    const result = await fixture.run();
    expect(result).toEqual({ publicationRunId: runId, googleDocId: "temp-doc-1", googleDocUrl: "https://docs.google.com/document/d/temp-doc-1/edit", productIds: ["A-1002", "A-1001"] });
    expect(fixture.calls.filter(c => new URL(c.url).pathname.endsWith("/copy"))).toEqual([expect.objectContaining({ body: {
      name: "Publication 2026-09-02 (in progress)", parents: ["folder-1"], appProperties: { publicationRunId: runId },
    } })]);
    const lookups = fixture.calls.filter(c => new URL(c.url).pathname === "/drive/v3/files");
    expect(lookups).toHaveLength(2);
    expect(new URL(lookups[1]!.url).searchParams.get("q")).toBe("'folder-1' in parents and trashed = false and appProperties has { key='publicationRunId' and value='rec-run-1' }");
    expect(fixture.batches).toHaveLength(1);
    expect(fixture.state.docs.size).toBe(1);
    const finalDoc = fixture.state.docs.get("temp-doc-1")!;
    expect(finalDoc.name).toBe("Publication 2026-09-02");
    const expectedProductText = (id: string) => `\uFFFC\nProduct ID: ${id}\nCondition: Used\nDescription: สภาพดี\nLINE Square Price: 1290\nIG Price: 1390\nCaption 1: แคปชันหนึ่ง ${id}\nCaption 2: แคปชันสอง ${id}\nCaption 3: แคปชันสาม ${id}\n${suffix}\n\n`;
    expect(finalDoc.text).toBe(`หัวกระดาษ 2 กันยายน 2569\n${expectedProductText("A-1002")}${expectedProductText("A-1001")}\nท้ายกระดาษ\n`);
    expect(await job()).toMatchObject({ state: "succeeded", google_doc_id: "temp-doc-1", google_doc_url: result!.googleDocUrl });
    expect(fixture.state.status).toBe("Generated");
    expect(fixture.calls.filter(c => c.url.endsWith(`/tblRuns/${runId}`) && c.method === "PATCH").at(-1)!.body).toEqual({
      fields: { Status: "Generated", "Google Doc URL": result!.googleDocUrl, "Generated At": "2026-09-01T17:30:00.000Z", "Error Summary": null },
    });
    expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(result!.googleDocUrl));
    expect(await fixture.run()).toEqual(result);
    expect(fixture.calls.filter(c => new URL(c.url).pathname.endsWith("/copy"))).toHaveLength(1);
    expect(fixture.calls.filter(c => c.method === "PATCH" && c.url.includes("/drive/"))).toHaveLength(1);
    expect(fixture.batches).toHaveLength(1);
    expect(fixture.notify).toHaveBeenCalledTimes(1);
  });

  it("deduplicates authorized /docs calls under one Workflow ID and one Bangkok date", async () => {
    const fixture = publicationFixture();
    vi.mocked(globalThis.fetch).mockImplementation(fixture.deps.fetcher as typeof fetch);
    const binding = workflowBinding();
    const triggerEnv = { ...env, ...configEnv, PUBLICATION_WORKFLOW: binding } as unknown as Env;
    for (const authorization of [null, "Bearer wrong-token"]) {
      const unauthorized = await handleDocsRoute(new Request("https://worker.example/docs", {
        method: "POST", headers: authorization ? { authorization } : {},
      }), triggerEnv, clock);
      expect(unauthorized.status).toBe(401);
    }
    expect(fixture.calls).toHaveLength(0);
    expect(await job()).toBeNull();
    const first = await handleDocsRoute(docsRequest(), triggerEnv, clock);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: "started", publicationRunId: runId });
    const duplicate = await handleDocsRoute(docsRequest(), triggerEnv, clock);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ status: "already_running", publicationRunId: runId });
    expect(binding.create).toHaveBeenCalledExactlyOnceWith({ id: "publication-rec-run-1", params: { publicationRunId: runId, trigger: "admin" } });
    await fixture.run();
    // Even if Airtable is stale or staff marks it Ready again, D1 owns the result.
    fixture.state.status = "Ready";
    binding.setStatus("complete");
    const completed = await handleDocsRoute(docsRequest(), triggerEnv, clock);
    expect(await completed.json()).toEqual({ status: "already_generated", publicationRunId: runId });
    expect(binding.create).toHaveBeenCalledTimes(1);
    expect(binding.restart).not.toHaveBeenCalled();
    expect(fixture.state.docs.size).toBe(1);
    const queries = fixture.calls.filter(c => new URL(c.url).pathname.endsWith("/tblRuns"));
    expect(queries).toHaveLength(3);
    for (const call of queries) expect(new URL(call.url).searchParams.get("filterByFormula")).toBe("{Publication Date}='2026-09-02'");
  });

  it.each([[503, "errored", "restarted"], [429, "unknown", "started"]] as const)
    ("exhausts six Google %s attempts before cleanup, then restarts a %s Workflow using cached products", async (httpStatus, workflowStatus, triggerStatus) => {
      const fixture = publicationFixture();
      fixture.state.batchFailureStatus = httpStatus;
      await expect(fixture.run()).rejects.toThrow("Unable to fill or verify the Google document.");
      expect(fixture.batches).toHaveLength(6);
      expect(fixture.scheduler.calls).toContainEqual({
        name: "fill and verify document",
        retryLimit: 5,
        attempts: 6,
      });
      expect(fixture.failureSnapshots).toEqual(Array.from({ length: 6 }, () => ({
        job: { state: "generating", temp_doc_id: "temp-doc-1", google_doc_id: null, google_doc_url: null, correlation_id: "publication-rec-run-1" },
        docs: 1, status: "Generating",
      })));
      expect(fixture.calls.filter(c => c.method === "DELETE").map(c => c.url)).toEqual(["https://www.googleapis.com/drive/v3/files/temp-doc-1?supportsAllDrives=true"]);
      const batchIndices = fixture.calls.flatMap((call, index) => call.url.endsWith(":batchUpdate") ? [index] : []);
      expect(fixture.calls.findIndex(c => c.method === "DELETE")).toBeGreaterThan(batchIndices.at(-1)!);
      expect(await job()).toMatchObject({ state: "failed", temp_doc_id: null, google_doc_id: null, google_doc_url: null });
      expect(fixture.state.docs.size).toBe(0);
      expect(fixture.state.status).toBe("Failed");
      expect(fixture.calls.filter(c => c.url.endsWith(`/tblRuns/${runId}`) && c.method === "PATCH").at(-1)!.body).toEqual({
        fields: { Status: "Failed", "Error Summary": "Unable to fill or verify the Google document." },
      });
      expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Unable to fill or verify the Google document."));
      expect(fixture.notify.mock.calls[0]![0]).toMatch(/[ก-๙]/);
      const cached = await getProductCache(env.DB, runId, "A-1001");
      expect(cached).toEqual({
        collageR2Key: "products/A-1001/collage/1080x1080.jpg", captionsJson: JSON.stringify(drafts("A-1001")),
        collageInputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), captionsInputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

      vi.mocked(globalThis.fetch).mockImplementation(fixture.deps.fetcher as typeof fetch);
      const binding = workflowBinding();
      binding.setStatus(workflowStatus);
      const triggerEnv = { ...env, ...configEnv, PUBLICATION_WORKFLOW: binding } as unknown as Env;
      const response = await handleDocsRoute(docsRequest(), triggerEnv, clock);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: triggerStatus, publicationRunId: runId });
      expect(await job()).toMatchObject({ state: "locked", correlation_id: "publication-rec-run-1" });
      expect(await getProductCache(env.DB, runId, "A-1001")).toEqual(cached);
      expect(workflowStatus === "errored" ? binding.restart : binding.create).toHaveBeenCalledTimes(1);
      fixture.state.batchFailureStatus = 0;
      const result = await fixture.run();
      expect(result!.googleDocId).toBe("temp-doc-2");
      expect(fixture.state.docs.size).toBe(1);
      expect(fixture.state.docs.get("temp-doc-2")!.name).toBe("Publication 2026-09-02");
      expect(fixture.create).toHaveBeenCalledTimes(1);
      expect(fixture.image.put).toHaveBeenCalledTimes(1);
      expect(await job()).toMatchObject({ state: "succeeded", google_doc_id: "temp-doc-2", google_doc_url: result!.googleDocUrl });
      expect(fixture.state.status).toBe("Generated");
      expect(fixture.notify).toHaveBeenCalledTimes(2);
    });
});
