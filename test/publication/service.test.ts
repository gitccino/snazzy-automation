import { beforeEach, describe, expect, it, vi } from "vitest";
import { testEnv } from "../helpers/env";
import {
  ensureTemporaryDocument, failPublicationAfterExhaustion, fillAndVerifyDocument,
  finalizePublication, notifyPublicationSuccess, notifyPublicationValidationFailure,
  preparePublicationOutputs, validatePublication,
  type PublicationServiceDeps, type PreparedPublication, type ValidatedPublication,
} from "../../src/publication/service";
import type { Fetcher } from "../../src/shared/http";
import type { PublicationProduct } from "../../src/publication/types";
import { getProductCache } from "../../src/db/publication-repository";
import { collageInputFingerprint } from "../../src/publication/collage";
import { captionInputFingerprint } from "../../src/publication/captions";

const env = testEnv();
const clock = { now: () => new Date("2026-09-01T17:30:00.000Z") };
const drafts: [string, string, string] = ["หนึ่ง", "สอง", "สาม"];
const product: PublicationProduct = {
  airtableRecordId: "rec-product-1", productId: "A-1001",
  orderedImageKeys: ["assets/1.jpg", "assets/2.jpg", "assets/3.jpg", "assets/4.jpg"],
  brandName: "Nike", modelName: "Air Max", conditionType: "Used", size: "42",
  description: "Good condition", lineSquarePrice: 1290, igPrice: 1390,
};
const validated: ValidatedPublication = {
  run: { airtableRunId: "rec-run-1", publicationDate: "2026-09-02", status: "Ready", products: [product] },
  thaiDate: "2 กันยายน 2569",
};
const prepared: PreparedPublication = {
  ...validated, outputs: [{ product, collageR2Key: "products/A-1001/collage/1080x1080.jpg", captionDrafts: drafts }],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function baseDeps(overrides: Partial<PublicationServiceDeps> = {}): PublicationServiceDeps {
  return {
    db: env.DB,
    assets: { putIfAbsent: vi.fn(), signUrl: vi.fn(async (key: string) => `https://worker.example/assets/${encodeURIComponent(key)}?exp=1&sig=x`) },
    bucket: { get: vi.fn(), put: vi.fn() } as unknown as R2Bucket,
    images: { input: vi.fn() },
    fetcher: vi.fn<Fetcher>().mockImplementation(async () => json({ id: "rec-run-1" })),
    anthropic: { messages: { create: vi.fn(), countTokens: vi.fn().mockResolvedValue({ input_tokens: 100 }) } } as unknown as PublicationServiceDeps["anthropic"],
    clock,
    config: {
      airtableBaseId: "base123", airtableProductsTableId: "tblProducts", airtablePublicationRunsTableId: "tblRuns",
      googleDriveFolderId: "folder-1", googleTemplateDocId: "template-1", claudeModel: "claude-opus-5",
      claudeRequestInputTokenLimit: 150_000, publicBaseUrl: "https://worker.example", timeZone: "Asia/Bangkok",
    } as PublicationServiceDeps["config"],
    airtableToken: "airtable-token",
    googleOAuthCredentials: {
      clientId: "test-oauth-client-id",
      clientSecret: "test-oauth-client-secret",
      refreshToken: "test-refresh-token",
    },
    notify: vi.fn().mockResolvedValue(undefined), ...overrides,
  };
}
async function seedJob(state = "generating", tempId: string | null = null, correlationId = "corr-1") {
  await env.DB.prepare(`INSERT INTO publication_jobs
    (publication_run_id, state, correlation_id, temp_doc_id, created_at, updated_at)
    VALUES ('rec-run-1', ?, ?, ?, ?, ?)`)
    .bind(state, correlationId, tempId, clock.now().toISOString(), clock.now().toISOString()).run();
}
async function seedCache(id = "A-1001", captions = JSON.stringify(drafts), collage: string | null = `products/${id}/collage/1080x1080.jpg`) {
  await env.DB.prepare(`INSERT INTO publication_product_cache
    (publication_run_id, product_id, collage_r2_key, collage_input_fingerprint, captions_json, captions_input_fingerprint, updated_at)
    VALUES ('rec-run-1', ?, ?, ?, ?, ?, ?)`)
    .bind(id, collage, await collageInputFingerprint(product.orderedImageKeys), captions,
      await captionInputFingerprint({ ...product, productId: id }, "claude-opus-5"), clock.now().toISOString()).run();
}
async function job() {
  return env.DB.prepare("SELECT state, temp_doc_id, google_doc_id, google_doc_url, correlation_id FROM publication_jobs WHERE publication_run_id = 'rec-run-1'").first();
}
function runFetcher(products: PublicationProduct[] = [product]) {
  return vi.fn<Fetcher>().mockImplementation(async (url, init) => {
    if (init?.method === "PATCH") return json({ id: "rec-run-1" });
    if (String(url).includes("tblRuns/")) return json({ id: "rec-run-1", fields: {
      "Publication Date": "2026-09-02", Status: "Ready", Products: products.map(p => p.airtableRecordId),
    } });
    return json({ records: products.map(p => ({ id: p.airtableRecordId, fields: {
      "Product ID": p.productId, "Product Images": p.orderedImageKeys.map((key, i) => ({ id: String(i), url: `https://dl.airtable.com/${i}`, filename: key.slice(7) })),
      "Brand Name": p.brandName, "Model Name": p.modelName, "Condition Type": p.conditionType, Size: p.size,
      Description: p.description, "LINE Square Price": p.lineSquarePrice, "IG Price": p.igPrice,
    } })) });
  });
}
const token = () => json({ access_token: "google-token", expires_in: 3600 });
const document = (content: string) => json({
  documentStyle: {
    pageSize: { width: { magnitude: 612, unit: "PT" } },
    marginLeft: { magnitude: 72, unit: "PT" },
    marginRight: { magnitude: 72, unit: "PT" },
  },
  body: { content: [{ paragraph: { elements: [{ startIndex: 1, textRun: { content } }] } }] },
});
const captionResponse = (captions: unknown[]) => ({ content: [{ type: "tool_use", id: "tool-1", name: "submit_captions", input: { captions } }], usage: { input_tokens: 100, output_tokens: 50 } });

function generationDeps(): PublicationServiceDeps {
  const deps = baseDeps();
  const pipeline = { transform: vi.fn(), draw: vi.fn(), output: vi.fn(async () => ({
    response: () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }),
  })) };
  pipeline.transform.mockReturnValue(pipeline); pipeline.draw.mockReturnValue(pipeline);
  vi.mocked(deps.images.input).mockReturnValue(pipeline);
  vi.mocked(deps.bucket.get).mockImplementation(async () => ({ body: new ReadableStream() }) as R2ObjectBody);
  vi.mocked(deps.anthropic.messages.create).mockResolvedValue(captionResponse([{ productId: "A-1001", drafts }]) as never);
  return deps;
}

describe("publication stages", () => {
  it("copies a distinct versioned Doc for replacement generation 2", async () => {
    await seedJob("generating", null, "publication-rec-run-1-v2");
    await env.DB.prepare("UPDATE publication_jobs SET generation=2,successful_generation=1,google_doc_id='old-doc',google_doc_url='old-url'").run();
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({ files: [] })).mockResolvedValueOnce(json({ id: "new-v2" }));
    await expect(ensureTemporaryDocument(baseDeps({ fetcher }), { ...prepared, generation: 2 })).resolves.toBe("new-v2");
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get("q")).toContain("value='publication-rec-run-1-v2'");
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body))).toMatchObject({
      name: "Publication 2026-09-02 (v2) (in progress)", appProperties: { publicationRunId: "publication-rec-run-1-v2" },
    });
    expect(await job()).toMatchObject({ google_doc_id: "old-doc", temp_doc_id: "new-v2" });
  });

  it("rejects stale generation stages before external mutation or cleanup", async () => {
    await seedJob("generating", "new-v2", "publication-rec-run-1-v2");
    await env.DB.prepare("UPDATE publication_jobs SET generation=2,successful_generation=1,google_doc_id='old-doc',google_doc_url='old-url'").run();
    const deps = baseDeps();
    await expect(preparePublicationOutputs(deps, validated)).rejects.toMatchObject({ code: "publication_generation_stale" });
    await expect(ensureTemporaryDocument(deps, prepared)).rejects.toMatchObject({ code: "publication_generation_stale" });
    await expect(finalizePublication(deps, prepared, "old-temp")).rejects.toMatchObject({ code: "publication_generation_stale" });
    await expect(failPublicationAfterExhaustion(deps, "rec-run-1", "failed", null)).rejects.toMatchObject({ code: "publication_generation_stale" });
    expect(deps.fetcher).not.toHaveBeenCalled();
  });
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM publication_product_cache");
    await env.DB.exec("DELETE FROM publication_jobs");
  });

  it("loads the exact requested run and validates before any generation", async () => {
    const fetcher = runFetcher();
    const deps = baseDeps({ fetcher });
    expect(await validatePublication(deps, "rec-run-1", "corr-1")).toEqual({ kind: "valid", value: validated });
    expect(String(fetcher.mock.calls[0]![0])).toContain("tblRuns/rec-run-1");
    expect(await job()).toMatchObject({ state: "validating", correlation_id: "corr-1" });
    expect(deps.bucket.put).not.toHaveBeenCalled();
  });

  it("groups invalid products, restores Draft, and notifies in its separate stage", async () => {
    const fetcher = runFetcher([{ ...product, description: "" }, { ...product, productId: "A-1002", airtableRecordId: "rec-product-2", size: "" }]);
    const deps = baseDeps({ fetcher });
    const outcome = await validatePublication(deps, "rec-run-1", "corr-1");
    expect(outcome).toEqual({ kind: "validation_failed", thaiDate: "2 กันยายน 2569", validation: { valid: false, productsMissingFields: [
      { productId: "A-1001", missingFields: ["Description"] }, { productId: "A-1002", missingFields: ["Size"] },
    ] } });
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body)).fields.Status).toBe("Draft");
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("https://api.airtable.com/"))).toBe(true);
    expect(deps.anthropic.messages.create).not.toHaveBeenCalled();
    expect(deps.bucket.put).not.toHaveBeenCalled();
    expect(deps.images.input).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
    if (outcome.kind !== "validation_failed") throw new Error("expected validation failure");
    await notifyPublicationValidationFailure(deps, "rec-run-1", outcome.thaiDate, outcome.validation);
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("A-1001: Description\nA-1002: Size"));
    expect(await job()).toMatchObject({ state: "validation_failed" });
  });

  it("rejects a competing workflow before reading Airtable", async () => {
    await seedJob("locked");
    const deps = baseDeps();
    await expect(validatePublication(deps, "rec-run-1", "other-owner")).rejects.toThrow(/owned|lock/i);
    expect(deps.fetcher).not.toHaveBeenCalled();
    expect(await job()).toMatchObject({ state: "locked", correlation_id: "corr-1" });
  });

  it("resumes validation for the durable owner after a transient read failure", async () => {
    const fetcher = runFetcher().mockRejectedValueOnce(new Error("network unavailable"));
    const deps = baseDeps({ fetcher });
    await expect(validatePublication(deps, "rec-run-1", "corr-1")).rejects.toThrow();
    expect((await validatePublication(deps, "rec-run-1", "corr-1")).kind).toBe("valid");
  });

  it("clears stale D1 validation details after corrected data passes", async () => {
    const invalid = baseDeps({ fetcher: runFetcher([{ ...product, description: "" }]) });
    expect((await validatePublication(invalid, "rec-run-1", "corr-1")).kind).toBe("validation_failed");
    const before = await env.DB.prepare("SELECT validation_result_json FROM publication_jobs WHERE publication_run_id = 'rec-run-1'").first();
    expect(before?.validation_result_json).toBeTruthy();
    expect((await validatePublication(baseDeps({ fetcher: runFetcher() }), "rec-run-1", "corr-1")).kind).toBe("valid");
    expect(await env.DB.prepare("SELECT validation_result_json FROM publication_jobs WHERE publication_run_id = 'rec-run-1'").first())
      .toEqual({ validation_result_json: null });
  });

  it("rejects a second run's claim on the loaded publication date before generation", async () => {
    const first = baseDeps({ fetcher: runFetcher() });
    expect((await validatePublication(first, "rec-run-1", "corr-1")).kind).toBe("valid");
    const fetcher = runFetcher();
    fetcher.mockImplementation(async (url, init) => {
      const response = await runFetcher()(url, init);
      const body = await response.json() as Record<string, unknown>;
      if (body.id) body.id = "rec-run-2";
      return json(body);
    });
    const second = baseDeps({ fetcher });
    await expect(validatePublication(second, "rec-run-2", "corr-2")).rejects.toMatchObject({
      code: "publication_date_conflict", retryable: false,
    });
    expect(second.anthropic.messages.create).not.toHaveBeenCalled();
    expect(second.bucket.put).not.toHaveBeenCalled();
  });

  it("regenerates a reordered first-four collage while preserving matching captions", async () => {
    await seedJob();
    const deps = generationDeps();
    await preparePublicationOutputs(deps, validated);
    const edited = { ...validated, run: { ...validated.run, products: [{
      ...product, orderedImageKeys: [...product.orderedImageKeys].reverse(),
    }] } };
    await preparePublicationOutputs(deps, edited);
    expect(deps.bucket.put).toHaveBeenCalledTimes(2);
    expect(deps.anthropic.messages.create).toHaveBeenCalledTimes(1);
  });

  it.each(["brandName", "modelName", "conditionType", "size", "description"] as const)(
    "regenerates captions when %s changes, preserving the matching collage", async field => {
      await seedJob();
      const deps = generationDeps();
      await preparePublicationOutputs(deps, validated);
      const edited = { ...validated, run: { ...validated.run, products: [{ ...product, [field]: "ข้อมูลใหม่" }] } };
      await preparePublicationOutputs(deps, edited);
      expect(deps.anthropic.messages.create).toHaveBeenCalledTimes(2);
      expect(deps.bucket.put).toHaveBeenCalledTimes(1);
    },
  );

  it("regenerates captions for a changed model while preserving the matching collage", async () => {
    await seedJob();
    const deps = generationDeps();
    await preparePublicationOutputs(deps, validated);
    await preparePublicationOutputs({ ...deps, config: { ...deps.config, claudeModel: "future-model" as typeof deps.config.claudeModel } }, validated);
    expect(deps.anthropic.messages.create).toHaveBeenCalledTimes(2);
    expect(deps.bucket.put).toHaveBeenCalledTimes(1);
  });

  it("reuses outputs when only normalized whitespace, price, or unused image keys change", async () => {
    await seedJob();
    const deps = generationDeps();
    await preparePublicationOutputs(deps, validated);
    await preparePublicationOutputs(deps, { ...validated, run: { ...validated.run, products: [{
      ...product, brandName: " Nike ", description: " Good condition\n", lineSquarePrice: 1500,
      orderedImageKeys: [...product.orderedImageKeys, "assets/new-unused.jpg"],
    }] } });
    expect(deps.anthropic.messages.create).toHaveBeenCalledTimes(1);
    expect(deps.bucket.put).toHaveBeenCalledTimes(1);
  });

  it.each(["collage_input_fingerprint", "captions_input_fingerprint"])(
    "regenerates stale %s versions and then preserves their replacements", async column => {
      await seedJob();
      const deps = generationDeps();
      await preparePublicationOutputs(deps, validated);
      await env.DB.prepare(`UPDATE publication_product_cache SET ${column} = 'previous-version' WHERE publication_run_id = 'rec-run-1'`).run();
      await preparePublicationOutputs(deps, validated);
      await preparePublicationOutputs(deps, validated);
      expect(deps.bucket.put).toHaveBeenCalledTimes(column === "collage_input_fingerprint" ? 2 : 1);
      expect(deps.anthropic.messages.create).toHaveBeenCalledTimes(column === "captions_input_fingerprint" ? 2 : 1);
    },
  );

  it("does not reopen a terminal failed run", async () => {
    await seedJob("failed");
    const deps = baseDeps();
    await expect(validatePublication(deps, "rec-run-1", "corr-1")).rejects.toThrow(/failed|terminal/i);
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it("reuses valid caches without calling Claude or generating collages", async () => {
    await seedJob(); await seedCache();
    const deps = baseDeps();
    expect(await preparePublicationOutputs(deps, validated)).toEqual(prepared);
    expect(deps.anthropic.messages.create).not.toHaveBeenCalled();
    expect(deps.bucket.put).not.toHaveBeenCalled();
    expect(JSON.parse(String(vi.mocked(deps.fetcher).mock.calls[0]![1]?.body)).fields).toEqual({ Status: "Generating", "Error Summary": null });
  });

  it.each(["{malformed", '["english","only","captions"]', '[" หนึ่ง","สอง","สาม"]', '["หนึ่ง","สอง"]'])
    ("replaces invalid cached captions: %s", async (invalid) => {
      await seedJob(); await seedCache("A-1001", invalid);
      const deps = baseDeps();
      vi.mocked(deps.anthropic.messages.create).mockResolvedValue(captionResponse([{ productId: "A-1001", drafts }]) as never);
      expect((await preparePublicationOutputs(deps, validated)).outputs[0]?.captionDrafts).toEqual(drafts);
      expect((await getProductCache(env.DB, "rec-run-1", "A-1001")).captionsJson).toBe(JSON.stringify(drafts));
      expect(deps.bucket.put).not.toHaveBeenCalled();
    });

  it("persists partial valid captions and requests only unresolved IDs on retry", async () => {
    await seedJob();
    await seedCache("A-1001", "null"); await seedCache("A-1002", "null");
    const deps = baseDeps();
    const create = vi.mocked(deps.anthropic.messages.create);
    create.mockResolvedValueOnce(captionResponse([{ productId: "A-1001", drafts }, { productId: "A-1002", drafts: ["bad"] }]) as never)
      .mockResolvedValueOnce(captionResponse([{ productId: "A-1002", drafts }]) as never);
    const two = { ...validated, run: { ...validated.run, products: [product, { ...product, productId: "A-1002", airtableRecordId: "rec-product-2" }] } };
    await expect(preparePublicationOutputs(deps, two)).rejects.toThrow(/A-1002/);
    expect((await getProductCache(env.DB, "rec-run-1", "A-1001")).captionsJson).toBe(JSON.stringify(drafts));
    expect((await preparePublicationOutputs(deps, two)).outputs).toHaveLength(2);
    expect(JSON.stringify(create.mock.calls[1]![0])).toContain("A-1002");
    expect(JSON.stringify(create.mock.calls[1]![0])).not.toContain("A-1001");
  });

  it("stores newly rendered collage bytes privately and reuses them on retry", async () => {
    await seedJob(); await seedCache("A-1001", JSON.stringify(drafts), null);
    const deps = baseDeps();
    const pipeline = { transform: vi.fn(), draw: vi.fn(), output: vi.fn(async () => ({ response: () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }) })) };
    pipeline.transform.mockReturnValue(pipeline); pipeline.draw.mockReturnValue(pipeline);
    vi.mocked(deps.images.input).mockReturnValue(pipeline);
    vi.mocked(deps.bucket.get).mockResolvedValue({ body: new ReadableStream() } as never);
    await preparePublicationOutputs(deps, validated);
    expect(deps.bucket.put).toHaveBeenCalledWith("products/A-1001/collage/1080x1080.jpg", new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/jpeg" } });
    expect((await getProductCache(env.DB, "rec-run-1", "A-1001")).collageR2Key).toBe("products/A-1001/collage/1080x1080.jpg");
    await preparePublicationOutputs(deps, validated);
    expect(deps.bucket.put).toHaveBeenCalledTimes(1);
  });

  it.each([400, 429, 503])("does not write R2 or collage cache for Images status %s", async status => {
    await seedJob(); await seedCache("A-1001", JSON.stringify(drafts), null);
    const before = await getProductCache(env.DB, "rec-run-1", "A-1001");
    const deps = generationDeps();
    const pipeline = vi.mocked(deps.images.input)(new ReadableStream());
    vi.mocked(pipeline.output).mockResolvedValue({ response: () => new Response("SECRET", { status, headers: { "content-type": "image/jpeg" } }) });
    await expect(preparePublicationOutputs(deps, validated)).rejects.toMatchObject({ code: "images_output_failed", retryable: status !== 400 });
    expect(deps.bucket.put).not.toHaveBeenCalled();
    expect(await getProductCache(env.DB, "rec-run-1", "A-1001")).toEqual(before);
  });

  it("caches the first batch even when a later batch throws permanently", async () => {
    await seedJob(); await seedCache("A-1001", "null"); await seedCache("A-1002", "null");
    const deps = baseDeps();
    vi.mocked(deps.anthropic.messages.countTokens).mockResolvedValueOnce({ input_tokens: 100 })
      .mockResolvedValueOnce({ input_tokens: 200_000 }).mockResolvedValue({ input_tokens: 100 });
    const create = vi.mocked(deps.anthropic.messages.create);
    create.mockResolvedValueOnce(captionResponse([{ productId: "A-1001", drafts }]) as never)
      .mockRejectedValueOnce({ status: 403, message: "upstream secret" })
      .mockResolvedValueOnce(captionResponse([{ productId: "A-1002", drafts }]) as never);
    const two = { ...validated, run: { ...validated.run, products: [product, { ...product, productId: "A-1002", airtableRecordId: "rec-product-2" }] } };
    await expect(preparePublicationOutputs(deps, two)).rejects.toMatchObject({ code: "anthropic_create_message_failed", retryable: false });
    expect((await getProductCache(env.DB, "rec-run-1", "A-1001")).captionsJson).toBe(JSON.stringify(drafts));
    await preparePublicationOutputs(deps, two);
    expect(JSON.stringify(create.mock.calls[2]![0])).not.toContain("A-1001");
  });

  it.each(["missing", "failed", "succeeded"])("blocks mutating stages for a %s job", async (state) => {
    if (state !== "missing") await seedJob(state, "temp-doc");
    const deps = baseDeps();
    await expect(preparePublicationOutputs(deps, validated)).rejects.toThrow(/job/i);
    await expect(ensureTemporaryDocument(deps, prepared)).rejects.toThrow(/job/i);
    await expect(fillAndVerifyDocument(deps, prepared, "temp-doc")).rejects.toThrow(/job/i);
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it("returns the D1 document without authenticating or searching Drive", async () => {
    await seedJob("generating", "existing-doc");
    const deps = baseDeps();
    expect(await ensureTemporaryDocument(deps, prepared)).toBe("existing-doc");
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it.each([true, false])("discovers before copying and saves the recovered ID (existing=%s)", async (existing) => {
    await seedJob();
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({ files: existing ? [{ id: "temp-doc" }] : [] }))
      .mockResolvedValueOnce(json({ id: "temp-doc" }));
    expect(await ensureTemporaryDocument(baseDeps({ fetcher }), prepared)).toBe("temp-doc");
    expect(fetcher).toHaveBeenCalledTimes(existing ? 2 : 3);
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get("q")).toContain("value='rec-run-1'");
    if (!existing) expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body))).toMatchObject({ appProperties: { publicationRunId: "rec-run-1" }, parents: ["folder-1"] });
    expect(await job()).toMatchObject({ temp_doc_id: "temp-doc" });
  });

  it("signs the collage, fills and then verifies without finalizing", async () => {
    await seedJob("generating", "temp-doc");
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(json({ id: product.airtableRecordId }))
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(document("{{PUBLICATION_DATE}}\n{{PRODUCTS}}suffix{{END_PRODUCTS}}\n"))
      .mockResolvedValueOnce(json({ documentId: "temp-doc" }))
      .mockResolvedValueOnce(document("Product ID: A-1001\n"));
    const deps = baseDeps({ fetcher });
    await fillAndVerifyDocument(deps, prepared, "temp-doc");
    expect(deps.assets.signUrl).toHaveBeenCalledWith("products/A-1001/collage/1080x1080.jpg", 900);
    const attachment = JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).fields["4-in-1 Image"][0].url;
    expect(attachment).toContain("sig=x");
    expect(JSON.stringify(JSON.parse(String(fetcher.mock.calls[3]![1]?.body)).requests)).toContain(attachment);
    expect(String(fetcher.mock.calls[4]![0])).toBe("https://docs.googleapis.com/v1/documents/temp-doc");
    expect(await job()).toMatchObject({ state: "generating", temp_doc_id: "temp-doc" });
  });

  it("leaves the temp document intact after an exact verification failure", async () => {
    await seedJob("generating", "temp-doc");
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(json({})).mockResolvedValueOnce(token())
      .mockResolvedValueOnce(document("Product ID: A-1001\n"))
      .mockResolvedValueOnce(document("Product ID: A-10010\n"));
    await expect(fillAndVerifyDocument(baseDeps({ fetcher }), prepared, "temp-doc")).rejects.toThrow(/A-1001/);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    expect(await job()).toMatchObject({ state: "generating", temp_doc_id: "temp-doc" });
  });

  it("finalizes and records success once, with notification as a separate stage", async () => {
    await seedJob("generating", "temp-doc");
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({ id: "temp-doc" })).mockResolvedValueOnce(json({ id: "rec-run-1" }));
    const deps = baseDeps({ fetcher });
    const result = await finalizePublication(deps, prepared, "temp-doc");
    expect(result).toEqual({ publicationRunId: "rec-run-1", googleDocId: "temp-doc", googleDocUrl: "https://docs.google.com/document/d/temp-doc/edit", productIds: ["A-1001"] });
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body)).fields).toEqual({ Status: "Generated", "Google Doc URL": result.googleDocUrl, "Generated At": "2026-09-01T17:30:00.000Z", "Error Summary": null });
    expect(await job()).toMatchObject({ state: "succeeded", google_doc_id: "temp-doc", google_doc_url: result.googleDocUrl });
    expect(await finalizePublication(deps, prepared, "temp-doc")).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(deps.notify).not.toHaveBeenCalled();
    await notifyPublicationSuccess(deps, prepared, result);
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining(result.googleDocUrl));
    await failPublicationAfterExhaustion(deps, "rec-run-1", "Google unavailable", prepared.thaiDate);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("cleans up only at exhaustion, clears D1, marks Airtable Failed and sends a safe reason", async () => {
    await seedJob("generating", "temp-doc");
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(json({}));
    const deps = baseDeps({ fetcher });
    await failPublicationAfterExhaustion(deps, "rec-run-1", "Google unavailable", prepared.thaiDate);
    expect(fetcher.mock.calls[1]![1]?.method).toBe("DELETE");
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body)).fields).toEqual({ Status: "Failed", "Error Summary": "Google unavailable" });
    expect(await job()).toMatchObject({ state: "failed", temp_doc_id: null });
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("2 กันยายน 2569"));
  });

  it("discovers and deletes an orphan copy during exhaustion cleanup", async () => {
    await seedJob();
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({ files: [{ id: "orphan-doc" }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(json({}));
    const deps = baseDeps({ fetcher });
    await failPublicationAfterExhaustion(deps, "rec-run-1", "Document preparation failed", null);
    expect(String(fetcher.mock.calls[2]![0])).toBe("https://www.googleapis.com/drive/v3/files/orphan-doc");
    expect(fetcher.mock.calls[2]![1]?.method).toBe("DELETE");
    expect(await job()).toMatchObject({ state: "failed", temp_doc_id: null });
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("ไม่สามารถอ่านวันที่รายการได้"));
  });

  it("retains the temp ID when deletion fails so cleanup can safely retry", async () => {
    await seedJob("generating", "temp-doc");
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(json({}));
    const deps = baseDeps({ fetcher });
    await expect(failPublicationAfterExhaustion(deps, "rec-run-1", "Google unavailable", prepared.thaiDate)).rejects.toThrow();
    expect(await job()).toMatchObject({ state: "generating", temp_doc_id: "temp-doc" });
    expect(deps.notify).not.toHaveBeenCalled();
    await failPublicationAfterExhaustion(deps, "rec-run-1", "Google unavailable", prepared.thaiDate);
    expect(await job()).toMatchObject({ state: "failed", temp_doc_id: null });
  });

  it("retries failure reporting after Airtable fails without reopening terminal D1 state", async () => {
    await seedJob("generating", "temp-doc");
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({}));
    const deps = baseDeps({ fetcher });
    await expect(failPublicationAfterExhaustion(deps, "rec-run-1", "Google unavailable", prepared.thaiDate)).rejects.toThrow();
    expect(await job()).toMatchObject({ state: "failed", temp_doc_id: null });
    await failPublicationAfterExhaustion(deps, "rec-run-1", "Google unavailable", prepared.thaiDate);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });

  it("returns successful duplicate validation without changing terminal state", async () => {
    await seedJob("succeeded", "temp-doc");
    await env.DB.prepare("UPDATE publication_jobs SET google_doc_id = 'temp-doc', google_doc_url = 'https://docs.google.com/document/d/temp-doc/edit' WHERE publication_run_id = 'rec-run-1'").run();
    const fetcher = runFetcher();
    const outcome = await validatePublication(baseDeps({ fetcher }), "rec-run-1", "other-owner");
    expect(outcome).toEqual({ kind: "already_succeeded", result: { publicationRunId: "rec-run-1", googleDocId: "temp-doc", googleDocUrl: "https://docs.google.com/document/d/temp-doc/edit", productIds: ["A-1001"] } });
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== "PATCH")).toBe(true);
    expect(await job()).toMatchObject({ state: "succeeded", correlation_id: "corr-1" });
  });
});
