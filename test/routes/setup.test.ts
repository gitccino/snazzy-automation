import { generateKeyPairSync } from "node:crypto";
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

async function readyEnv(): Promise<Env> {
  const env = configuredEnv();
  await env.DB.prepare("DELETE FROM sequences WHERE name = 'product_id'").run();
  await env.IMAGES_BUCKET.put("assets/collage-base-1080.jpg", validBaseJpeg);
  await env.DB.prepare(
    "INSERT INTO sequences (name, next_value, bootstrapped_at) VALUES ('product_id', 501, '2026-09-01T00:00:00.000Z')",
  ).run();
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

  it("authenticates setup before running dependencies", async () => {
    const response = await handleSetup(
      new Request("https://worker.example/setup"),
      { ADMIN_ROUTE_TOKEN: "secret" } as Env,
      vi.fn(() => { throw new Error("must not fetch"); }),
    );
    expect(response.status).toBe(401);
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

  it("rejects a My Drive folder before template access", async () => {
    const probes = createSetupExternalProbes(
      googleEnv(), googleFetch({ driveId: null }), { now: () => new Date("2026-09-02T01:00:00.000Z") },
    );
    await expect(probes.verifyGoogleTemplateAccess()).rejects.toThrow("Shared Drive");
  });

  it("requires the Shared Drive permission rehearsal to copy, edit, rename, and delete", async () => {
    const fetcher = googleFetch();
    const probes = createSetupExternalProbes(
      googleEnv(), fetcher, { now: () => new Date("2026-09-02T01:00:00.000Z") },
    );

    await probes.verifyGoogleTemplateAccess();

    const driveCalls = fetcher.mock.calls.filter(([input]) => String(input).includes("googleapis.com"));
    expect(driveCalls.some(([input]) => String(input).includes("/copy?supportsAllDrives=true"))).toBe(true);
    expect(driveCalls.some(([input, init]) => String(input).includes("docs.googleapis.com") && init?.method === "POST")).toBe(true);
    expect(driveCalls.some(([input, init]) => String(input).includes("copied-doc?supportsAllDrives=true") && init?.method === "PATCH")).toBe(true);
    expect(driveCalls.some(([input, init]) => String(input).includes("copied-doc?supportsAllDrives=true") && init?.method === "DELETE")).toBe(true);
    const copy = driveCalls.find(([input, init]) => String(input).includes("/copy?") && init?.method === "POST");
    expect(JSON.parse(String(copy?.[1]?.body))).toMatchObject({ appProperties: { setupProbeId: expect.any(String) } });
  });

  it("paginates Shared Drive membership until it finds the exact service account", async () => {
    const probes = createSetupExternalProbes(
      googleEnv(), googleFetch({ permissionOnSecondPage: true }), { now: () => new Date("2026-09-02T01:00:00.000Z") },
    );

    await expect(probes.verifyGoogleTemplateAccess()).resolves.toBeUndefined();
  });

  it("rejects a template whose required marker is split across text runs", async () => {
    const probes = createSetupExternalProbes(
      googleEnv(), googleFetch({ splitMarker: true }), { now: () => new Date("2026-09-02T01:00:00.000Z") },
    );

    await expect(probes.verifyGoogleTemplateAccess()).rejects.toThrow("one text run");
  });

  it("recovers a response-lost disposable copy through its appProperty", async () => {
    const fetcher = googleFetch({ copyResponseLost: true });
    const probes = createSetupExternalProbes(
      googleEnv(), fetcher, { now: () => new Date("2026-09-02T01:00:00.000Z") },
    );

    await expect(probes.verifyGoogleTemplateAccess()).rejects.toThrow("response lost");
    const copy = fetcher.mock.calls.find(([input, init]) => String(input).includes("/copy?") && init?.method === "POST");
    const probeId = JSON.parse(String(copy?.[1]?.body)).appProperties.setupProbeId;
    const lookup = fetcher.mock.calls.find(([input]) => new URL(String(input)).searchParams.has("q"));
    expect(new URL(String(lookup?.[0])).searchParams.get("q")).toBe(
      `'folder-1' in parents and trashed = false and appProperties has { key='setupProbeId' and value='${probeId}' }`,
    );
    expect(fetcher.mock.calls.some(([input, init]) => String(input).includes("copied-doc?supportsAllDrives=true") && init?.method === "DELETE")).toBe(true);
  });
});

function googleEnv(): Env {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  return {
    ...configuredEnv(),
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: "setup@example.iam.gserviceaccount.com", private_key: privateKey,
    }),
  };
}

function googleFetch(options: { driveId?: string | null; permissionOnSecondPage?: boolean; splitMarker?: boolean; copyResponseLost?: boolean } = {}) {
  const driveId = options.driveId === null ? undefined : options.driveId ?? "drive-1";
  const { permissionOnSecondPage, splitMarker, copyResponseLost } = options;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "token", expires_in: 3600 });
    if (url.hostname === "docs.googleapis.com") {
      if (init?.method === "POST") return Response.json({});
      return Response.json({ body: { content: [{ paragraph: { elements: splitMarker
        ? [{ startIndex: 1, textRun: { content: "{{PUBLICATION_DATE}} {{PRO" } }, { startIndex: 30, textRun: { content: "DUCTS}} {{END_PRODUCTS}}" } }]
        : [{ startIndex: 1, textRun: { content: "{{PUBLICATION_DATE}} {{PRODUCTS}} {{END_PRODUCTS}}" } }],
      } }] } });
    }
    if (url.pathname === "/drive/v3/files/folder-1") return Response.json({
      id: "folder-1", mimeType: "application/vnd.google-apps.folder", ...(driveId ? { driveId } : {}),
      capabilities: { canAddChildren: true, canDeleteChildren: true },
    });
    if (url.pathname === "/drive/v3/files/drive-1/permissions") {
      if (permissionOnSecondPage && !url.searchParams.get("pageToken")) return Response.json({
        permissions: [{ emailAddress: "other@example.iam.gserviceaccount.com", role: "organizer", type: "user", deleted: false }], nextPageToken: "page-2",
      });
      return Response.json({ permissions: [{
        emailAddress: "setup@example.iam.gserviceaccount.com", role: "organizer", type: "user", deleted: false,
      }] });
    }
    if (url.pathname === "/drive/v3/files/template-1") return Response.json({
      id: "template-1", mimeType: "application/vnd.google-apps.document", parents: ["folder-1"],
    });
    if (url.pathname === "/drive/v3/files/template-1/copy" && init?.method === "POST") {
      if (copyResponseLost) throw new Error("response lost");
      return Response.json({ id: "copied-doc" });
    }
    if (url.pathname === "/drive/v3/files" && (!init?.method || init.method === "GET")) return Response.json({ files: [{ id: "copied-doc" }] });
    if (url.pathname === "/drive/v3/files/copied-doc" && (init?.method === "PATCH" || init?.method === "DELETE")) return new Response(null, { status: 200 });
    throw new Error(`Unexpected Google request ${url}`);
  });
}
