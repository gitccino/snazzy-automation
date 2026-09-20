import Anthropic from "@anthropic-ai/sdk";
import jpeg from "jpeg-js";
import { z } from "zod";
import { parseConfig } from "../config";
import { createSequenceRepository } from "../db/sequence-repository";
import type { Env, Fetcher } from "../env";
import { createICloudClient } from "../icloud/client";
import { createAssetStore } from "../import/asset-store";
import { createGoogleAuthClient, parseServiceAccountJson } from "../publication/google-auth";
import { verifyAdminBearer } from "../shared/admin-auth";
import type { Clock } from "../shared/time";
import { todayBangkokDate } from "../shared/time";
import { handleGetAsset } from "./assets";

const AirtableMetaSchema = z.object({
  tables: z.array(z.object({ id: z.string().min(1), fields: z.array(z.object({ name: z.string().min(1) })) })),
});
const AirtableRecordsSchema = z.object({
  records: z.array(z.object({ id: z.string().min(1), fields: z.object({ "Product ID": z.string().optional() }) })),
  offset: z.string().optional(),
});
const DriveFileSchema = z.object({
  id: z.string().min(1),
  mimeType: z.string().min(1),
  parents: z.array(z.string()).optional(),
  driveId: z.string().min(1).optional(),
  capabilities: z.object({ canAddChildren: z.boolean().optional(), canDeleteChildren: z.boolean().optional() }).optional(),
});
const DrivePermissionsSchema = z.object({
  permissions: z.array(z.object({
    emailAddress: z.string().email().optional(), role: z.string().optional(), type: z.string().optional(), deleted: z.boolean().optional(),
  })).default([]),
  nextPageToken: z.string().min(1).optional(),
});
const DriveCopySchema = z.object({ id: z.string().min(1) });
const DriveFilesSchema = z.object({ files: z.array(DriveCopySchema).default([]), nextPageToken: z.string().min(1).optional() });
const GoogleDocumentSchema = z.object({
  body: z.object({ content: z.array(z.object({ paragraph: z.object({ elements: z.array(z.object({
    startIndex: z.number().int().nonnegative().optional(), textRun: z.object({ content: z.string() }).optional(),
  })) }).optional() })) }),
});

export interface SetupCheckResult { name: string; ok: boolean; detail: string }
export interface SetupReport { ok: boolean; checks: SetupCheckResult[] }
export interface SetupExternalProbes {
  verifyLineGroupAccess(): Promise<void>;
  verifyGoogleTemplateAccess(): Promise<void>;
  verifyClaudeCredential(): Promise<void>;
  verifyICloudSnapshotAccess(): Promise<number>;
}

function requireTemplateMarkers(document: z.infer<typeof GoogleDocumentSchema>): void {
  const runs = document.body.content.flatMap((block) => block.paragraph?.elements ?? [])
    .flatMap((element) => element.textRun && element.startIndex !== undefined ? [{ content: element.textRun.content, startIndex: element.startIndex }] : []);
  const marker = (value: string) => {
    const run = runs.find((candidate) => candidate.content.includes(value));
    if (!run) throw new Error(`template marker ${value} must remain inside one text run`);
    return run.startIndex + run.content.indexOf(value);
  };
  marker("{{PUBLICATION_DATE}}");
  const products = marker("{{PRODUCTS}}");
  const endProducts = marker("{{END_PRODUCTS}}");
  if (endProducts <= products + "{{PRODUCTS}}".length) throw new Error("template missing ordered {{PRODUCTS}} / {{END_PRODUCTS}} markers");
}

function requireCollageBaseJpeg(bytes: Uint8Array): void {
  let decoded: jpeg.RawImageData<Uint8Array>;
  try {
    decoded = jpeg.decode(bytes, { useTArray: true });
  } catch {
    throw new Error("R2 collage base asset is not a valid JPEG");
  }
  if (decoded.width !== 1080 || decoded.height !== 1080) {
    throw new Error(`R2 collage base asset must be 1080x1080 JPEG, got ${decoded.width}x${decoded.height}`);
  }
}

const requiredFields = {
  Products: [
    "Product ID", "System Group ID", "Upload Date", "Product Images", "Inventory Status", "4-in-1 Image", "Publication Run", "Sold Price", "Sold At", "Sold By", "Last System Update", "Brand Name", "Model Name", "Condition Type", "Size", "Description", "LINE Square Price", "IG Price", "Data Complete", "Missing Fields",
  ],
  "Publication Runs": ["Publication Date", "Status", "Products", "Google Doc URL", "Generated At", "Error Summary"],
} as const;

async function check(name: string, fn: () => Promise<string>): Promise<SetupCheckResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function airtableJson(fetcher: Fetcher, url: string, token: string): Promise<unknown> {
  const response = await fetcher(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Airtable setup request failed: ${response.status}`);
  return response.json();
}

async function validateAirtableSchema(env: Env, fetcher: Fetcher): Promise<void> {
  const config = parseConfig(env.APP_CONFIG_JSON);
  const body = AirtableMetaSchema.parse(await airtableJson(
    fetcher, `https://api.airtable.com/v0/meta/bases/${config.airtableBaseId}/tables`, env.AIRTABLE_TOKEN,
  ));
  for (const entry of [
    { tableId: config.airtableProductsTableId, label: "Products" as const },
    { tableId: config.airtablePublicationRunsTableId, label: "Publication Runs" as const },
  ]) {
    const table = body.tables.find((candidate) => candidate.id === entry.tableId);
    if (!table) throw new Error(`${entry.label} table ID not found`);
    const present = new Set(table.fields.map((field) => field.name));
    const missing = requiredFields[entry.label].filter((name) => !present.has(name));
    if (missing.length) throw new Error(`${entry.label} missing fields: ${missing.join(", ")}`);
  }
}

export async function maximumAirtableProductNumber(env: Env, fetcher: Fetcher): Promise<number> {
  const config = parseConfig(env.APP_CONFIG_JSON);
  let maximum = 0;
  let offset: string | undefined;
  do {
    const url = new URL(`https://api.airtable.com/v0/${config.airtableBaseId}/${config.airtableProductsTableId}`);
    url.searchParams.append("fields[]", "Product ID");
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    const body = AirtableRecordsSchema.parse(await airtableJson(fetcher, url.toString(), env.AIRTABLE_TOKEN));
    for (const record of body.records) {
      const match = /^A-(\d+)$/.exec(record.fields["Product ID"] ?? "");
      if (match) maximum = Math.max(maximum, Number(match[1]));
    }
    offset = body.offset;
  } while (offset);
  return maximum;
}

export async function sequenceState(env: Env): Promise<{ nextValue: number; bootstrapped: boolean } | null> {
  const row = await env.DB.prepare(
    "SELECT next_value, bootstrapped_at FROM sequences WHERE name = 'product_id'",
  ).first<{ next_value: number; bootstrapped_at: string | null }>();
  return row ? { nextValue: row.next_value, bootstrapped: row.bootstrapped_at !== null } : null;
}

export function createSetupExternalProbes(env: Env, fetcher: Fetcher, clock: Clock): SetupExternalProbes {
  const config = parseConfig(env.APP_CONFIG_JSON);
  const account = parseServiceAccountJson(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const googleAuth = createGoogleAuthClient(env.GOOGLE_SERVICE_ACCOUNT_JSON, clock, fetcher);
  const imageSource = createICloudClient(env.ICLOUD_SHARED_ALBUM_TOKEN, fetcher);

  async function googleFetch(url: string, init?: RequestInit): Promise<Response> {
    const token = await googleAuth.getAccessToken();
    const response = await fetcher(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init?.headers },
    });
    if (!response.ok) throw new Error(`Google setup request failed: ${response.status}`);
    return response;
  }
  async function driveFile(id: string) {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`);
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", "id,mimeType,parents,driveId,capabilities(canAddChildren,canDeleteChildren)");
    return DriveFileSchema.parse(await (await googleFetch(url.toString())).json());
  }
  async function isSharedDriveOrganizer(driveId: string): Promise<boolean> {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveId)}/permissions`);
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", "permissions(emailAddress,role,type,deleted),nextPageToken");
    url.searchParams.set("pageSize", "100");
    let pageToken: string | undefined;
    do {
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = DrivePermissionsSchema.parse(await (await googleFetch(url.toString())).json());
      if (page.permissions.some((permission) => permission.type === "user" && permission.emailAddress === account.client_email && permission.role === "organizer" && !permission.deleted)) return true;
      pageToken = page.nextPageToken;
    } while (pageToken);
    return false;
  }
  async function deleteSetupCopies(folderId: string, probeId: string): Promise<void> {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    const escapeLiteral = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
    url.searchParams.set("q", `'${escapeLiteral(folderId)}' in parents and trashed = false and appProperties has { key='setupProbeId' and value='${probeId}' }`);
    url.searchParams.set("fields", "files(id),nextPageToken");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    let pageToken: string | undefined;
    do {
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = DriveFilesSchema.parse(await (await googleFetch(url.toString())).json());
      for (const file of page.files) {
        await googleFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?supportsAllDrives=true`, { method: "DELETE" });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  return {
    async verifyLineGroupAccess() {
      const response = await fetcher(
        `https://api.line.me/v2/bot/group/${encodeURIComponent(config.lineAllowedGroupId)}/summary`,
        { headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` } },
      );
      if (!response.ok) throw new Error(`LINE group access failed: ${response.status}`);
      const body = z.object({ groupName: z.string().min(1) }).parse(await response.json());
      if (!body.groupName) throw new Error("LINE group summary invalid");
    },
    async verifyGoogleTemplateAccess() {
      const folder = await driveFile(config.googleDriveFolderId);
      if (folder.mimeType !== "application/vnd.google-apps.folder") throw new Error("Configured Google folder is not a Drive folder");
      if (!folder.driveId) throw new Error("Configured Google folder must be in a Shared Drive");
      if (!folder.capabilities?.canAddChildren || !folder.capabilities.canDeleteChildren) {
        throw new Error("Service account lacks Shared Drive create/delete permissions");
      }
      if (!(await isSharedDriveOrganizer(folder.driveId))) {
        throw new Error("Service account is not an organizer member of the Shared Drive");
      }
      const template = await driveFile(config.googleTemplateDocId);
      if (template.mimeType !== "application/vnd.google-apps.document" || !template.parents?.includes(folder.id)) {
        throw new Error("Google template is not a document in the configured Shared Drive folder");
      }

      const templateDocument = GoogleDocumentSchema.parse(await (await googleFetch(
        `https://docs.googleapis.com/v1/documents/${encodeURIComponent(template.id)}`,
      )).json());
      requireTemplateMarkers(templateDocument);
      const probeId = crypto.randomUUID();
      let copyId: string | undefined;
      try {
        const copyUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(template.id)}/copy`);
        copyUrl.searchParams.set("supportsAllDrives", "true");
        copyId = DriveCopySchema.parse(await (await googleFetch(copyUrl.toString(), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: `setup-check-${probeId}`, parents: [folder.id], appProperties: { setupProbeId: probeId } }),
        })).json()).id;
        await googleFetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(copyId)}:batchUpdate`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: "setup check" } }] }),
        });
        const renameUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(copyId)}`);
        renameUrl.searchParams.set("supportsAllDrives", "true");
        await googleFetch(renameUrl.toString(), {
          method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `setup-checked-${crypto.randomUUID()}` }),
        });
      } finally {
        if (copyId) {
          await googleFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(copyId)}?supportsAllDrives=true`, { method: "DELETE" });
        } else {
          await deleteSetupCopies(folder.id, probeId);
        }
      }
    },
    async verifyClaudeCredential() {
      const model = await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, fetch: fetcher }).models.retrieve(config.claudeModel);
      if (model.id !== config.claudeModel) throw new Error(`Anthropic returned unexpected model ${model.id}`);
    },
    async verifyICloudSnapshotAccess() {
      return (await imageSource.getSnapshot()).photos.length;
    },
  };
}

export async function runSetupChecks(
  env: Env,
  fetcher: Fetcher = fetch.bind(globalThis),
  clock: Clock = { now: () => new Date() },
  probes: SetupExternalProbes = createSetupExternalProbes(env, fetcher, clock),
): Promise<SetupReport> {
  const config = parseConfig(env.APP_CONFIG_JSON);
  const checks: SetupCheckResult[] = [];
  checks.push(await check("d1_migrations", async () => {
    const expected = ["sequences", "import_runs", "import_checkpoints", "photo_assets", "product_groups", "audit_events", "publication_jobs", "publication_product_cache", "line_events", "pending_line_commands", "line_actions", "line_event_replies", "usage_metrics"];
    const rows = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${expected.map(() => "?").join(",")})`).bind(...expected).all<{ name: string }>();
    const present = new Set(rows.results.map((row) => row.name));
    const missing = expected.filter((name) => !present.has(name));
    if (missing.length) throw new Error(`Missing D1 tables: ${missing.join(", ")}`);
    return `${expected.length} required D1 tables present`;
  }));
  checks.push(await check("r2_access", async () => {
    const key = `setup-check/${crypto.randomUUID()}.txt`;
    const expected = new TextEncoder().encode("setup-r2-readback");
    await env.IMAGES_BUCKET.put(key, expected);
    try {
      const object = await env.IMAGES_BUCKET.get(key);
      if (object === null) throw new Error("R2 read failed");
      const actual = new Uint8Array(await object.arrayBuffer());
      if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index])) throw new Error("R2 readback bytes differ");
      const base = await env.IMAGES_BUCKET.get("assets/collage-base-1080.jpg");
      if (base === null) throw new Error("R2 collage base asset missing");
      requireCollageBaseJpeg(new Uint8Array(await base.arrayBuffer()));
    } finally {
      await env.IMAGES_BUCKET.delete(key);
    }
    return "R2 write/read/delete verified";
  }));
  checks.push(await check("asset_delivery", async () => {
    const key = `setup-check/${crypto.randomUUID()}.txt`;
    await env.IMAGES_BUCKET.put(key, "signed-ok");
    try {
      const assets = createAssetStore(env.IMAGES_BUCKET, { signingSecret: env.ASSET_URL_SIGNING_SECRET, publicBaseUrl: config.publicBaseUrl }, clock);
      const response = await handleGetAsset(new Request(await assets.signUrl(key, 60)), env, clock);
      if (!response.ok || await response.text() !== "signed-ok") throw new Error("signed asset route probe failed");
    } finally {
      await env.IMAGES_BUCKET.delete(key);
    }
    return "signed private asset route verified";
  }));
  checks.push(await check("images_binding", async () => {
    if (!env.IMAGES || !env.IMPORT_WORKFLOW || !env.PUBLICATION_WORKFLOW || !env.ADMIN_ROUTE_TOKEN) throw new Error("required Images, Workflow, or admin binding missing");
    return "Images, Workflow, and admin bindings present";
  }));
  checks.push(await check("airtable_schema", async () => { await validateAirtableSchema(env, fetcher); return "Airtable schema verified"; }));
  checks.push(await check("sequence_consistency", async () => {
    const state = await sequenceState(env);
    if (!state?.bootstrapped) throw new Error("Product sequence not bootstrapped; POST /setup/bootstrap-sequence");
    const maximum = await maximumAirtableProductNumber(env, fetcher);
    if (maximum >= state.nextValue) throw new Error(`Airtable max Product ID (${maximum}) >= D1 next (${state.nextValue})`);
    return `D1 next=${state.nextValue}, Airtable max=${maximum}`;
  }));
  checks.push(await check("line_webhook_config", async () => {
    if (!env.LINE_CHANNEL_SECRET) throw new Error("LINE_CHANNEL_SECRET missing");
    await probes.verifyLineGroupAccess();
    return "LINE token can access configured allowed group";
  }));
  checks.push(await check("google_template_access", async () => { await probes.verifyGoogleTemplateAccess(); return "Google Shared Drive template rehearsal verified"; }));
  checks.push(await check("claude_credential", async () => { await probes.verifyClaudeCredential(); return `Anthropic model ${config.claudeModel} verified`; }));
  checks.push(await check("icloud_phase_zero", async () => {
    const count = await probes.verifyICloudSnapshotAccess();
    if (count <= 0) throw new Error("iCloud album has no photos");
    return `${count} iCloud photos visible`;
  }));
  checks.push(await check("cron_timezone", async () => {
    if (config.timeZone !== "Asia/Bangkok") throw new Error(`TIME_ZONE ${config.timeZone} is not Asia/Bangkok`);
    if (config.uploadCutoffMinutes !== 30) throw new Error(`UPLOAD_CUTOFF_MINUTES ${config.uploadCutoffMinutes} is not 30`);
    return `Bangkok date ${todayBangkokDate(clock)} and cutoff verified`;
  }));
  return { ok: checks.every((entry) => entry.ok), checks };
}

export async function handleSetup(request: Request, env: Env, fetcher: Fetcher = fetch.bind(globalThis), clock: Clock = { now: () => new Date() }, probes?: SetupExternalProbes): Promise<Response> {
  if (!(await verifyAdminBearer(request, env.ADMIN_ROUTE_TOKEN))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const report = await runSetupChecks(env, fetcher, clock, probes ?? createSetupExternalProbes(env, fetcher, clock));
  return Response.json(report, { status: report.ok ? 200 : 503 });
}

export async function handleBootstrapSequence(request: Request, env: Env, fetcher: Fetcher = fetch.bind(globalThis)): Promise<Response> {
  if (!(await verifyAdminBearer(request, env.ADMIN_ROUTE_TOKEN))) return Response.json({ error: "unauthorized" }, { status: 401 });
  if ((await sequenceState(env))?.bootstrapped) return Response.json({ error: "already_bootstrapped" }, { status: 409 });
  const config = parseConfig(env.APP_CONFIG_JSON);
  const nextValue = Math.max(config.productIdInitialNumber, (await maximumAirtableProductNumber(env, fetcher)) + 1);
  if (!(await createSequenceRepository(env.DB).bootstrap("product_id", nextValue))) {
    return Response.json({ error: "already_bootstrapped" }, { status: 409 });
  }
  return Response.json({ ok: true, bootstrappedFrom: nextValue });
}
