import jpeg from "jpeg-js";
import { describe, expect, it, vi } from "vitest";
import {
  createSetupExternalProbes,
  handleBootstrapSequence,
  handleSetup,
  runSetupChecks,
} from "../../src/routes/setup";
import type { Env } from "../../src/env";
import { createTestEnv, testEnv } from "../helpers/env";

const productsFields = [
  "Product ID", "System Group ID", "Upload Date", "Product Images",
  "Inventory Status", "4-in-1 Image", "Publication Run", "Sold Price",
  "Sold At", "Sold By", "Last System Update", "Brand Name", "Model Name",
  "Condition Type", "Size", "Description", "LINE Square Price", "IG Price",
  "Data Complete", "Missing Fields",
];
const runFields = [
  "Publication Date", "Status", "Products", "Google Doc URL", "Generated At", "Error Summary",
];

function airtableFetch(productIds = ["A-500"], offset?: string) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/meta/bases/")) {
      return Response.json({ tables: [
        { id: "tblProducts", fields: productsFields.map((name) => ({ name })) },
        { id: "tblRuns", fields: runFields.map((name) => ({ name })) },
      ] });
    }
    return Response.json({
      records: productIds.map((productId, index) => ({
        id: `rec-${index}`, fields: { "Product ID": productId },
      })),
      ...(offset ? { offset } : {}),
    });
  });
}

const happyProbes = {
  verifyLineGroupAccess: vi.fn().mockResolvedValue(undefined),
  verifyGoogleTemplateAccess: vi.fn().mockResolvedValue(undefined),
  verifyClaudeCredential: vi.fn().mockResolvedValue(undefined),
  verifyICloudSnapshotAccess: vi.fn().mockResolvedValue(1),
};
const validBaseJpeg = jpeg.encode({
  data: new Uint8Array(1080 * 1080 * 4).fill(255), width: 1080, height: 1080,
}, 80).data;

function jpegBytes(width: number, height: number): Uint8Array {
  return jpeg.encode({ data: new Uint8Array(width * height * 4).fill(255), width, height }, 80).data;
}

function imageBinding(response: Response): Env["IMAGES"] {
  const transformer = {
    transform: vi.fn(),
    output: vi.fn(async () => ({ response: () => response })),
  };
  transformer.transform.mockReturnValue(transformer);
  return { input: vi.fn(() => transformer) } as unknown as Env["IMAGES"];
}

async function readyEnv(): Promise<Env> {
  const env = configuredEnv();
  await env.DB.prepare("DELETE FROM sequences WHERE name = 'product_id'").run();
  await env.IMAGES_BUCKET.put("assets/collage-base-1080.jpg", validBaseJpeg);
  await env.DB.prepare(
    "INSERT INTO sequences (name, next_value, bootstrapped_at) VALUES ('product_id', 501, '2026-09-01T00:00:00.000Z')",
  ).run();
  env.IMAGES = imageBinding(new Response(validBaseJpeg, { headers: { "content-type": "image/jpeg" } }));
  return env;
}

function configuredEnv(): Env {
  return { ...testEnv(), ...createTestEnv(), LINE_CHANNEL_SECRET: "test-line-secret" } as Env;
}

describe("setup routes", () => {
  it("reports the eleven required setup checks", async () => {
    const report = await runSetupChecks(
      await readyEnv(), airtableFetch(), { now: () => new Date("2026-09-02T01:00:00.000Z") }, happyProbes,
    );

    expect(report.checks.map((check) => check.name)).toEqual([
      "d1_migrations", "r2_access", "asset_delivery", "images_binding", "airtable_schema",
      "sequence_consistency", "line_webhook_config", "google_template_access",
      "claude_credential", "icloud_phase_zero", "cron_timezone",
    ]);
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "r2_access")).toMatchObject({ ok: true });
    expect(report.checks.find((check) => check.name === "google_template_access")).toEqual({
      name: "google_template_access", ok: true, detail: "Google My Drive template rehearsal verified",
    });
  });

  it("fails r2_access when the required collage base object is missing", async () => {
    const env = await readyEnv();
    await env.IMAGES_BUCKET.delete("assets/collage-base-1080.jpg");
    const report = await runSetupChecks(env, airtableFetch(), { now: () => new Date("2026-09-02T01:00:00.000Z") }, happyProbes);

    expect(report.checks.find((check) => check.name === "r2_access")).toMatchObject({ ok: false });
  });

  it.each([
    ["not a JPEG", new TextEncoder().encode("not-a-jpeg")],
    ["wrong dimensions", jpegBytes(100, 100)],
  ])("fails r2_access when the collage base is %s", async (_description, bytes) => {
    const env = await readyEnv();
    await env.IMAGES_BUCKET.put("assets/collage-base-1080.jpg", bytes);
    const report = await runSetupChecks(env, airtableFetch(), { now: () => new Date("2026-09-02T01:00:00.000Z") }, happyProbes);

    expect(report.checks.find((check) => check.name === "r2_access")).toMatchObject({ ok: false });
  });

  it("fails r2_access when a temporary read returns different bytes", async () => {
    const env = await readyEnv();
    const original = env.IMAGES_BUCKET;
    const corrupt = Object.create(original) as R2Bucket;
    corrupt.get = vi.fn(async (key: string) => {
      const object = await original.get(key);
      return key.startsWith("setup-check/") && object
        ? { ...object, arrayBuffer: async () => new TextEncoder().encode("corrupt").buffer } as unknown as R2ObjectBody
        : object;
    });
    env.IMAGES_BUCKET = corrupt;
    const report = await runSetupChecks(env, airtableFetch(), { now: () => new Date("2026-09-02T01:00:00.000Z") }, happyProbes);

    expect(report.checks.find((check) => check.name === "r2_access")).toMatchObject({ ok: false });
  });

  it("verifies images_binding transforms the collage base to JPEG", async () => {
    const report = await runSetupChecks(
      await readyEnv(), airtableFetch(), { now: () => new Date("2026-09-02T01:00:00.000Z") }, happyProbes,
    );

    expect(report.checks.find((check) => check.name === "images_binding")).toMatchObject({ ok: true });
  });

  it.each([
    ["fails", new Response(null, { status: 502 })],
    ["returns non-JPEG bytes", new Response("not a JPEG", { headers: { "content-type": "image/jpeg" } })],
  ])("fails images_binding when the Images transform %s", async (_description, response) => {
    const env = await readyEnv();
    env.IMAGES = imageBinding(response);

    const report = await runSetupChecks(env, airtableFetch(), { now: () => new Date("2026-09-02T01:00:00.000Z") }, happyProbes);

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "images_binding")).toMatchObject({ ok: false });
  });

  it("rejects missing and wrong setup bearers before running dependencies", async () => {
    const fetcher = vi.fn(() => { throw new Error("must not fetch"); });
    const env = { ADMIN_ROUTE_TOKEN: "secret" } as Env;

    expect((await handleSetup(new Request("https://worker.example/setup"), env, fetcher)).status).toBe(401);
    expect((await handleSetup(new Request("https://worker.example/setup", {
      headers: { authorization: "Bearer wrong-token" },
    }), env, fetcher)).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns 503 to an authorized caller when an Images setup check fails", async () => {
    const env = await readyEnv();
    env.IMAGES = imageBinding(new Response(null, { status: 502 }));

    const response = await handleSetup(
      new Request("https://worker.example/setup", { headers: { authorization: `Bearer ${env.ADMIN_ROUTE_TOKEN}` } }),
      env,
      airtableFetch(),
      { now: () => new Date("2026-09-02T01:00:00.000Z") },
      happyProbes,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      checks: expect.arrayContaining([expect.objectContaining({ name: "images_binding", ok: false })]),
    });
  });

  it("scans every Airtable page and accepts only exact Product IDs during one-time bootstrap", async () => {
    const env = configuredEnv();
    await env.DB.prepare("DELETE FROM sequences WHERE name = 'product_id'").run();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return Response.json(url.searchParams.get("offset")
        ? { records: [{ id: "2", fields: { "Product ID": "A-501" } }] }
        : { records: [
          { id: "1", fields: { "Product ID": "A-9" } },
          { id: "bad", fields: { "Product ID": "xA-999" } },
        ], offset: "next" });
    });
    const request = () => new Request("https://worker.example/setup/bootstrap-sequence", {
      method: "POST", headers: { authorization: `Bearer ${env.ADMIN_ROUTE_TOKEN}` },
    });

    expect((await handleBootstrapSequence(request(), env, fetcher)).status).toBe(200);
    expect(await (await handleBootstrapSequence(request(), env, fetcher)).json()).toEqual({ error: "already_bootstrapped" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("allows only one concurrent bootstrap request to win", async () => {
    const env = configuredEnv();
    await env.DB.prepare("DELETE FROM sequences WHERE name = 'product_id'").run();
    const request = () => new Request("https://worker.example/setup/bootstrap-sequence", {
      method: "POST", headers: { authorization: `Bearer ${env.ADMIN_ROUTE_TOKEN}` },
    });

    const responses = await Promise.all([
      handleBootstrapSequence(request(), env, airtableFetch(["A-500"])),
      handleBootstrapSequence(request(), env, airtableFetch(["A-500"])),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  it("rehearses copy, edit, readback, rename, and permanent delete in My Drive using OAuth", async () => {
    const fetcher = googleFetch();
    const probes = createSetupExternalProbes(
      googleEnv(), fetcher, { now: () => new Date("2026-09-02T01:00:00.000Z") },
    );

    await probes.verifyGoogleTemplateAccess();

    const tokenCall = fetcher.mock.calls.find(([input]) => new URL(String(input)).hostname === "oauth2.googleapis.com");
    expect(new URLSearchParams(String(tokenCall?.[1]?.body)).get("grant_type")).toBe("refresh_token");
    expect(new URLSearchParams(String(tokenCall?.[1]?.body)).get("refresh_token")).toBe("test-refresh-token");
    const driveCalls = fetcher.mock.calls.filter(([input]) => String(input).includes("googleapis.com"));
    expect(driveCalls.some(([input]) => String(input).includes("/copy") && !new URL(String(input)).searchParams.has("supportsAllDrives"))).toBe(true);
    expect(driveCalls.some(([input, init]) => String(input).includes("docs.googleapis.com") && init?.method === "POST")).toBe(true);
    const edit = driveCalls.findIndex(([input, init]) => String(input).endsWith("/copied-doc:batchUpdate") && init?.method === "POST");
    const readback = driveCalls.findIndex(([input, init]) => String(input).endsWith("/copied-doc") && String(input).includes("docs.googleapis.com") && !init?.method);
    const rename = driveCalls.findIndex(([input, init]) => new URL(String(input)).pathname.endsWith("/copied-doc") && init?.method === "PATCH");
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(readback).toBeGreaterThan(edit);
    expect(rename).toBeGreaterThan(readback);
    expect(driveCalls.some(([input, init]) => new URL(String(input)).pathname.endsWith("/copied-doc") && init?.method === "PATCH")).toBe(true);
    expect(driveCalls.some(([input, init]) => new URL(String(input)).pathname.endsWith("/copied-doc") && init?.method === "DELETE")).toBe(true);
    expect(driveCalls.every(([input]) => !new URL(String(input)).searchParams.has("supportsAllDrives"))).toBe(true);
    const copy = driveCalls.find(([input, init]) => String(input).includes("/copy") && init?.method === "POST");
    expect(JSON.parse(String(copy?.[1]?.body))).toMatchObject({ appProperties: { setupProbeId: expect.any(String) } });
  });

  it.each([
    ["a Shared Drive folder", { driveId: "drive-1" }, "My Drive"],
    ["a non-folder", { folderMimeType: "application/vnd.google-apps.document" }, "Drive folder"],
    ["missing capabilities", { capabilities: null }, "capabilities"],
    ["missing add capability", { capabilities: { canAddChildren: false } }, "capabilities"],
    ["a non-document template", { templateMimeType: "application/pdf" }, "configured My Drive folder"],
    ["an out-of-folder template", { templateParents: ["other-folder"] }, "configured My Drive folder"],
  ])("rejects %s", async (_description, options, message) => {
    const probes = createSetupExternalProbes(
      googleEnv(), googleFetch(options), { now: () => new Date("2026-09-02T01:00:00.000Z") },
    );
    await expect(probes.verifyGoogleTemplateAccess()).rejects.toThrow(message);
  });

  it("rejects a template whose required marker is split across text runs", async () => {
    const probes = createSetupExternalProbes(
      googleEnv(), googleFetch({ splitMarker: true }), { now: () => new Date("2026-09-02T01:00:00.000Z") },
    );

    await expect(probes.verifyGoogleTemplateAccess()).rejects.toThrow("one text run");
  });

  it("rejects a template missing a required marker", async () => {
    const probes = createSetupExternalProbes(
      googleEnv(), googleFetch({ missingMarker: true }), { now: () => new Date("2026-09-02T01:00:00.000Z") },
    );

    await expect(probes.verifyGoogleTemplateAccess()).rejects.toThrow("{{END_PRODUCTS}}");
  });

  it("fails when the disposable edit is not visible on readback", async () => {
    const fetcher = googleFetch({ copyReadbackMissingText: true });
    const probes = createSetupExternalProbes(googleEnv(), fetcher, { now: () => new Date("2026-09-02T01:00:00.000Z") });

    await expect(probes.verifyGoogleTemplateAccess()).rejects.toThrow("setup check");
    expect(fetcher.mock.calls.some(([input, init]) => new URL(String(input)).pathname.endsWith("/copied-doc") && init?.method === "DELETE")).toBe(true);
  });

  it("keeps malformed Google response bodies out of the setup report", async () => {
    const env = await readyEnv();
    const clock = { now: () => new Date("2026-09-02T01:00:00.000Z") };
    const google = googleFetch({ malformedFolderBody: true });
    const probes = createSetupExternalProbes(env, google, clock);
    const report = await runSetupChecks(env, airtableFetch(), clock, { ...happyProbes, verifyGoogleTemplateAccess: probes.verifyGoogleTemplateAccess });
    const detail = report.checks.find((check) => check.name === "google_template_access")?.detail;

    expect(report.ok).toBe(false);
    expect(detail).toBe("Invalid provider response");
    expect(JSON.stringify(report)).not.toContain("PRIVATE-SENTINEL");
  });

  it("reports the safe copy ID if disposable deletion fails", async () => {
    const env = await readyEnv();
    const clock = { now: () => new Date("2026-09-02T01:00:00.000Z") };
    const google = googleFetch({ copyDeleteFails: true });
    const probes = createSetupExternalProbes(env, google, clock);
    const report = await runSetupChecks(env, airtableFetch(), clock, { ...happyProbes, verifyGoogleTemplateAccess: probes.verifyGoogleTemplateAccess });
    const detail = report.checks.find((check) => check.name === "google_template_access")?.detail;

    expect(report.ok).toBe(false);
    expect(detail).toContain("copied-doc");
    expect(detail).not.toContain("PRIVATE-SENTINEL");
    expect(detail).not.toContain("test-refresh-token");
  });

  it("recovers a response-lost disposable copy through its appProperty", async () => {
    const fetcher = googleFetch({ copyResponseLost: true });
    const probes = createSetupExternalProbes(
      googleEnv(), fetcher, { now: () => new Date("2026-09-02T01:00:00.000Z") },
    );

    await expect(probes.verifyGoogleTemplateAccess()).rejects.toThrow("response lost");
    const copy = fetcher.mock.calls.find(([input, init]) => String(input).includes("/copy") && init?.method === "POST");
    const probeId = JSON.parse(String(copy?.[1]?.body)).appProperties.setupProbeId;
    const lookup = fetcher.mock.calls.find(([input]) => new URL(String(input)).searchParams.has("q"));
    expect(new URL(String(lookup?.[0])).searchParams.get("q")).toBe(
      `'folder-1' in parents and trashed = false and appProperties has { key='setupProbeId' and value='${probeId}' }`,
    );
    expect(fetcher.mock.calls.some(([input, init]) => new URL(String(input)).pathname.endsWith("/copied-doc") && init?.method === "DELETE")).toBe(true);
    expect(new URL(String(lookup?.[0])).searchParams.has("includeItemsFromAllDrives")).toBe(false);
  });
});

function googleEnv(): Env {
  return configuredEnv();
}

function googleFetch(options: { driveId?: string; folderMimeType?: string; capabilities?: { canAddChildren: boolean } | null; templateMimeType?: string; templateParents?: string[]; splitMarker?: boolean; missingMarker?: boolean; copyResponseLost?: boolean; copyReadbackMissingText?: boolean; malformedFolderBody?: boolean; copyDeleteFails?: boolean } = {}) {
  const { driveId, splitMarker, missingMarker, copyResponseLost } = options;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "token", expires_in: 3600 });
    if (url.hostname === "docs.googleapis.com") {
      if (init?.method === "POST") return Response.json({});
      if (url.pathname === "/v1/documents/copied-doc") return Response.json({ body: { content: [{ paragraph: { elements: [{ startIndex: 1, textRun: { content: options.copyReadbackMissingText ? "unchanged" : "setup check\n" } }] } }] } });
      return Response.json({ body: { content: [{ paragraph: { elements: splitMarker
        ? [{ startIndex: 1, textRun: { content: "{{PUBLICATION_DATE}} {{PRO" } }, { startIndex: 30, textRun: { content: "DUCTS}} {{END_PRODUCTS}}" } }]
        : [{ startIndex: 1, textRun: { content: missingMarker ? "{{PUBLICATION_DATE}} {{PRODUCTS}}" : "{{PUBLICATION_DATE}} {{PRODUCTS}} {{END_PRODUCTS}}" } }],
      } }] } });
    }
    if (url.pathname === "/drive/v3/files/folder-1" && options.malformedFolderBody) return new Response("PRIVATE-SENTINEL {", { headers: { "content-type": "application/json" } });
    if (url.pathname === "/drive/v3/files/folder-1") return Response.json({
      id: "folder-1", mimeType: options.folderMimeType ?? "application/vnd.google-apps.folder", ...(driveId ? { driveId } : {}),
      ...(options.capabilities === null ? {} : { capabilities: options.capabilities ?? { canAddChildren: true } }),
    });
    if (url.pathname === "/drive/v3/files/template-1") return Response.json({
      id: "template-1", mimeType: options.templateMimeType ?? "application/vnd.google-apps.document", parents: options.templateParents ?? ["folder-1"],
    });
    if (url.pathname === "/drive/v3/files/template-1/copy" && init?.method === "POST") {
      if (copyResponseLost) throw new Error("response lost");
      return Response.json({ id: "copied-doc" });
    }
    if (url.pathname === "/drive/v3/files" && (!init?.method || init.method === "GET")) return Response.json({ files: [{ id: "copied-doc" }] });
    if (url.pathname === "/drive/v3/files/copied-doc" && init?.method === "DELETE" && options.copyDeleteFails) return new Response("PRIVATE-SENTINEL", { status: 500 });
    if (url.pathname === "/drive/v3/files/copied-doc" && (init?.method === "PATCH" || init?.method === "DELETE")) return new Response(null, { status: 200 });
    throw new Error(`Unexpected Google request ${url}`);
  });
}
