import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Env, Fetcher } from "../env";
import { createGoogleAuthClient } from "../publication/google-auth";
import {
  GoogleDocumentSchema,
  requireTemplateMarkers,
  requiredFields,
} from "../routes/setup";
import type { SettingsResult, StoredSettings } from "./schema";

const opaqueId = z.string().regex(/^[A-Za-z0-9_-]+$/);
const metaSchema = z.object({
  tables: z.array(
    z.object({
      id: z.string(),
      fields: z.array(z.object({ name: z.string() })),
    }),
  ),
});
const fileSchema = z.object({
  id: z.string(),
  mimeType: z.string(),
  parents: z.array(z.string()).optional(),
  driveId: z.string().optional(),
  capabilities: z.object({ canAddChildren: z.boolean().optional() }).optional(),
});

export async function validateSettingsConnections(
  env: Env,
  current: StoredSettings,
  candidate: StoredSettings,
  changedKeys: string[],
  fetcher: Fetcher = fetch.bind(globalThis),
): Promise<SettingsResult<void>> {
  const changed = (prefix: string) =>
    changedKeys.some((key) => key.startsWith(prefix));
  try {
    if (changed("AIRTABLE_")) {
      const base = opaqueId.parse(candidate.AIRTABLE_BASE_ID);
      const response = await fetcher(
        `https://api.airtable.com/v0/meta/bases/${base}/tables`,
        { headers: { authorization: `Bearer ${env.AIRTABLE_TOKEN}` } },
      );
      if (!response.ok) throw new Error();
      const body = metaSchema.parse(await response.json());
      for (const [id, label] of [
        [candidate.AIRTABLE_PRODUCTS_TABLE_ID, "Products"],
        [candidate.AIRTABLE_PUBLICATION_RUNS_TABLE_ID, "Publication Runs"],
      ] as const) {
        opaqueId.parse(id);
        const table = body.tables.find((item) => item.id === id);
        if (
          !table ||
          requiredFields[label].some(
            (field) => !table.fields.some((item) => item.name === field),
          )
        )
          throw new Error();
      }
    }
    if (changed("GOOGLE_")) {
      const auth = createGoogleAuthClient(
        {
          clientId: env.GOOGLE_OAUTH_CLIENT_ID,
          clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
          refreshToken: env.GOOGLE_REFRESH_TOKEN,
        },
        { now: () => new Date() },
        fetcher,
      );
      const token = await auth.getAccessToken();
      const get = async (url: string) => {
        const response = await fetcher(url, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error();
        return response.json();
      };
      const file = async (id: string) =>
        fileSchema.parse(
          await get(
            `https://www.googleapis.com/drive/v3/files/${opaqueId.parse(id)}?fields=id,mimeType,parents,driveId,capabilities(canAddChildren)`,
          ),
        );
      const folder = await file(candidate.GOOGLE_DRIVE_FOLDER_ID);
      const template = await file(candidate.GOOGLE_TEMPLATE_DOC_ID);
      if (
        folder.mimeType !== "application/vnd.google-apps.folder" ||
        folder.driveId ||
        !folder.capabilities?.canAddChildren ||
        template.mimeType !== "application/vnd.google-apps.document" ||
        !template.parents?.includes(folder.id)
      )
        throw new Error();
      requireTemplateMarkers(
        GoogleDocumentSchema.parse(
          await get(
            `https://docs.googleapis.com/v1/documents/${opaqueId.parse(template.id)}`,
          ),
        ),
      );
    }
    if (changedKeys.includes("LINE_ALLOWED_GROUP_IDS")) {
      for (const id of candidate.LINE_ALLOWED_GROUP_IDS) {
        const response = await fetcher(
          `https://api.line.me/v2/bot/group/${opaqueId.parse(id)}/summary`,
          {
            headers: {
              authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
            },
          },
        );
        if (!response.ok) throw new Error();
        z.object({ groupName: z.string().min(1) }).parse(await response.json());
      }
    }
    if (
      changedKeys.includes("AI_CAPTIONS_ENABLED") &&
      candidate.AI_CAPTIONS_ENABLED &&
      !current.AI_CAPTIONS_ENABLED
    ) {
      const model = await new Anthropic({
        apiKey: env.ANTHROPIC_API_KEY,
        fetch: fetcher,
      }).models.retrieve("claude-opus-5");
      if (model.id !== "claude-opus-5") throw new Error();
    }
    return { ok: true, value: undefined };
  } catch {
    return { ok: false, code: "connection_validation_failed" };
  }
}
