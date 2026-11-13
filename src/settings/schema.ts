import { z } from "zod";

const id = z.string().trim().min(1);
export const claudeModelSchema = z.string().trim().min(1).max(200).regex(/^claude-[A-Za-z0-9._-]+$/);
const retry = z.union([z.literal(0), z.literal(5)]);
const fields = {
  AIRTABLE_BASE_ID: id,
  AIRTABLE_PRODUCTS_TABLE_ID: id,
  AIRTABLE_PUBLICATION_RUNS_TABLE_ID: id,
  GOOGLE_DRIVE_FOLDER_ID: id,
  GOOGLE_TEMPLATE_DOC_ID: id,
  LINE_ALLOWED_GROUP_IDS: z
    .array(id)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length),
  SOLDOUT_CONFIRMATION_ENABLED: z.boolean(),
  FIRST_IMPORT_CUTOFF_DATE: z.iso.datetime().nullable(),
  IMPORT_RETRY_LIMIT: retry,
  PUBLICATION_RETRY_LIMIT: retry,
  CLAUDE_MODEL: claudeModelSchema.default("claude-opus-5"),
  AI_CAPTIONS_ENABLED: z.boolean(),
  PRODUCT_ID_INITIAL_NUMBER: z.number().int().positive(),
  CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: z.number().int().positive().max(150_000),
  MONTHLY_BUDGET_THB: z.number().finite().positive(),
  USD_TO_THB_RATE: z.number().finite().positive(),
  CLAUDE_INPUT_PRICE_USD_PER_MTOK: z.number().finite().nonnegative(),
  CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: z.number().finite().nonnegative(),
  R2_PRICE_USD_PER_GB_MONTH: z.number().finite().nonnegative(),
};
export const storedSettingsSchema = z.strictObject(fields);
export type StoredSettings = z.infer<typeof storedSettingsSchema>;
export const sectionSchemas = {
  connections: z
    .strictObject({
      AIRTABLE_BASE_ID: fields.AIRTABLE_BASE_ID,
      AIRTABLE_PRODUCTS_TABLE_ID: fields.AIRTABLE_PRODUCTS_TABLE_ID,
      AIRTABLE_PUBLICATION_RUNS_TABLE_ID:
        fields.AIRTABLE_PUBLICATION_RUNS_TABLE_ID,
      GOOGLE_DRIVE_FOLDER_ID: fields.GOOGLE_DRIVE_FOLDER_ID,
      GOOGLE_TEMPLATE_DOC_ID: fields.GOOGLE_TEMPLATE_DOC_ID,
    })
    .partial(),
  line: z
    .strictObject({
      LINE_ALLOWED_GROUP_IDS: fields.LINE_ALLOWED_GROUP_IDS,
      SOLDOUT_CONFIRMATION_ENABLED: fields.SOLDOUT_CONFIRMATION_ENABLED,
    })
    .partial(),
  import: z
    .strictObject({
      FIRST_IMPORT_CUTOFF_DATE: fields.FIRST_IMPORT_CUTOFF_DATE,
      IMPORT_RETRY_LIMIT: fields.IMPORT_RETRY_LIMIT,
    })
    .partial(),
  documents: z
    .strictObject({
      CLAUDE_MODEL: claudeModelSchema,
      AI_CAPTIONS_ENABLED: fields.AI_CAPTIONS_ENABLED,
      PUBLICATION_RETRY_LIMIT: fields.PUBLICATION_RETRY_LIMIT,
    })
    .partial(),
  advanced: z
    .strictObject({
      CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: fields.CLAUDE_REQUEST_INPUT_TOKEN_LIMIT,
      MONTHLY_BUDGET_THB: fields.MONTHLY_BUDGET_THB,
      USD_TO_THB_RATE: fields.USD_TO_THB_RATE,
      CLAUDE_INPUT_PRICE_USD_PER_MTOK: fields.CLAUDE_INPUT_PRICE_USD_PER_MTOK,
      CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: fields.CLAUDE_OUTPUT_PRICE_USD_PER_MTOK,
      R2_PRICE_USD_PER_GB_MONTH: fields.R2_PRICE_USD_PER_GB_MONTH,
    })
    .partial(),
};
export type SettingsSection = keyof typeof sectionSchemas;
export type SaveSectionRequest = {
  expectedRevision: number;
  section: SettingsSection;
  changes: Record<string, unknown>;
  acknowledgeAirtableChange?: boolean;
};
export type ConnectionTestRequest = {
  expectedRevision: number;
  connection: "airtable" | "google" | "line";
  changes: Record<string, unknown>;
};
export type SettingsRecord = {
  schemaVersion: 1;
  revision: number;
  updatedAt: string;
  settings: StoredSettings;
};
export type RuntimeSettings = {
  timeZone: "Asia/Bangkok";
  productIdPrefix: "A";
  claudeModel: string;
  publicBaseUrl: string;
  lineAllowedGroupIds: string[];
  soldoutConfirmationEnabled: boolean;
  firstImportCutoffDate: string | null;
  importRetryLimit: 0 | 5;
  publicationRetryLimit: 0 | 5;
  aiCaptionsEnabled: boolean;
  productIdInitialNumber: number;
  airtableBaseId: string;
  airtableProductsTableId: string;
  airtablePublicationRunsTableId: string;
  googleDriveFolderId: string;
  googleTemplateDocId: string;
  claudeRequestInputTokenLimit: number;
  monthlyBudgetThb: number;
  usdToThbRate: number;
  claudeInputPriceUsdPerMtok: number;
  claudeOutputPriceUsdPerMtok: number;
  r2PriceUsdPerGbMonth: number;
};
export type SettingsSnapshot = {
  schemaVersion: 1;
  revision: number;
  config: RuntimeSettings;
};
export type OperationContext = {
  settings: SettingsSnapshot;
  replyGroupId: string | null;
};
export type SettingsView = {
  nextProductNumber: number | null;
  record: SettingsRecord;
  deployment: {
    environment: string;
    publicBaseUrl: string;
    googleOAuthClientId: string;
    schedulingEnabled: false;
  };
};
export type SettingsErrorCode =
  | "invalid_settings"
  | "sequence_conflict"
  | "revision_conflict"
  | "confirmation_required"
  | "connection_validation_failed"
  | "settings_unavailable"
  | "provider_unavailable"
  | "internal_error";
export type SettingsResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: SettingsErrorCode;
      fieldErrors?: Record<string, string>;
    };
export type ConfigurationExport = {
  schemaVersion: 1;
  environment: string;
  revision: number;
  exportedAt: string;
  settings: StoredSettings;
  deployment: SettingsView["deployment"];
};

export function normalizeGroupIds(input: string | string[]): string[] {
  const parts = (Array.isArray(input) ? input : [input])
    .flatMap((value) => value.split(/[,\n]/))
    .map((value) => value.trim());
  if (parts.some((value) => !value))
    throw new Error("Group IDs must not be empty");
  return [...new Set(z.array(id).min(1).parse(parts))];
}
export function parseStoredSettings(value: unknown): StoredSettings {
  return storedSettingsSchema.parse(value);
}
export function parseSaveSectionRequest(value: unknown): SaveSectionRequest {
  const request = z
    .strictObject({
      expectedRevision: z.number().int().positive(),
      section: z.enum([
        "connections",
        "line",
        "import",
        "documents",
        "advanced",
      ]),
      changes: z.record(z.string(), z.unknown()),
      acknowledgeAirtableChange: z.boolean().optional(),
    })
    .parse(value);
  return {
    ...request,
    changes: sectionSchemas[request.section].parse(request.changes),
  };
}

export const nextProductNumberRequest = z.strictObject({
  expectedRevision: z.number().int().positive(),
  expectedNextValue: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  nextValue: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
});
