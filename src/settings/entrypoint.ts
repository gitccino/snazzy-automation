import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { readSettings } from "../db/settings-repository";
import type { Env } from "../env";
import {
  parseStoredSettings,
  type ConfigurationExport,
  type SettingsResult,
  type SettingsView,
} from "./schema";
import { saveSettingsSection } from "./service";
import { validateSettingsConnections } from "./validation";

export async function getSettingsView(
  env: Env,
): Promise<SettingsResult<SettingsView>> {
  if (env.CONFIGURATION_MODE !== "d1")
    return { ok: false, code: "settings_unavailable" };
  try {
    const record = await readSettings(env.DB);
    const publicBaseUrl = z.url().parse(env.PUBLIC_BASE_URL);
    const environment = z.string().min(1).parse(env.ENVIRONMENT);
    if (!record) return { ok: false, code: "settings_unavailable" };
    return {
      ok: true,
      value: {
        record,
        deployment: {
          environment,
          publicBaseUrl,
          googleOAuthClientId: env.GOOGLE_OAUTH_CLIENT_ID,
          schedulingEnabled: false,
        },
      },
    };
  } catch {
    return { ok: false, code: "settings_unavailable" };
  }
}
export async function exportSettings(
  env: Env,
  now: string,
): Promise<SettingsResult<ConfigurationExport>> {
  const view = await getSettingsView(env);
  if (!view.ok) return view;
  const { record, deployment } = view.value;
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      environment: deployment.environment,
      revision: record.revision,
      exportedAt: now,
      settings: record.settings,
      deployment,
    },
  };
}
const requestSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  connection: z.enum(["airtable", "google", "line"]),
  changes: z.record(z.string(), z.unknown()),
});
const allowed = {
  airtable: [
    "AIRTABLE_BASE_ID",
    "AIRTABLE_PRODUCTS_TABLE_ID",
    "AIRTABLE_PUBLICATION_RUNS_TABLE_ID",
  ],
  google: ["GOOGLE_DRIVE_FOLDER_ID", "GOOGLE_TEMPLATE_DOC_ID"],
  line: ["LINE_ALLOWED_GROUP_IDS"],
};
export async function testSettingsConnection(
  env: Env,
  input: unknown,
): Promise<
  SettingsResult<{
    connection: "airtable" | "google" | "line";
    status: "passed";
  }>
> {
  const parsed = requestSchema.safeParse(input);
  if (
    !parsed.success ||
    Object.keys(parsed.data.changes).some(
      (key) => !allowed[parsed.data.connection].includes(key),
    )
  )
    return { ok: false, code: "invalid_settings" };
  const view = await getSettingsView(env);
  if (!view.ok) return view;
  if (view.value.record.revision !== parsed.data.expectedRevision)
    return { ok: false, code: "revision_conflict" };
  try {
    const candidate = parseStoredSettings({
      ...view.value.record.settings,
      ...parsed.data.changes,
    });
    const result = await validateSettingsConnections(
      env,
      view.value.record.settings,
      candidate,
      allowed[parsed.data.connection],
    );
    return result.ok
      ? {
          ok: true,
          value: { connection: parsed.data.connection, status: "passed" },
        }
      : result;
  } catch {
    return { ok: false, code: "invalid_settings" };
  }
}
export class SettingsService extends WorkerEntrypoint<Env> {
  get() {
    return getSettingsView(this.env);
  }
  async saveSection(input: unknown): Promise<SettingsResult<SettingsView>> {
    const view = await getSettingsView(this.env);
    if (!view.ok) return view;
    const result = await saveSettingsSection(
      this.env.DB,
      input,
      new Date().toISOString(),
      (current, candidate, keys) =>
        validateSettingsConnections(this.env, current, candidate, keys),
    );
    return result.ok
      ? { ok: true, value: { ...view.value, record: result.value } }
      : result;
  }
  testConnection(input: unknown) {
    return testSettingsConnection(this.env, input);
  }
  exportConfiguration() {
    return exportSettings(this.env, new Date().toISOString());
  }
}
