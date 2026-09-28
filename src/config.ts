import { z } from "zod";

const RawAppConfigSchema = z.object({
  TIME_ZONE: z.literal("Asia/Bangkok"),
  UPLOAD_CUTOFF_MINUTES: z.number().int().positive(),
  PRODUCT_ID_PREFIX: z.string().min(1),
  IMPORT_CRON: z.string().min(1),
  IMPORT_RETRY_LIMIT: z.literal(5),
  PUBLICATION_CRON: z.string().min(1),
  PUBLICATION_RETRY_LIMIT: z.literal(5),
  PRODUCT_ID_INITIAL_NUMBER: z.number().int().positive(),
  FIRST_IMPORT_CUTOFF_DATE: z.string().datetime().nullable(),
  AIRTABLE_BASE_ID: z.string().min(1),
  AIRTABLE_PRODUCTS_TABLE_ID: z.string().min(1),
  AIRTABLE_PUBLICATION_RUNS_TABLE_ID: z.string().min(1),
  GOOGLE_DRIVE_FOLDER_ID: z.string().min(1),
  GOOGLE_TEMPLATE_DOC_ID: z.string().min(1),
  CLAUDE_MODEL: z.literal("claude-opus-5"),
  CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: z.number().int().positive().max(150_000),
  LINE_ALLOWED_GROUP_ID: z.string().min(1),
  SOLDOUT_CONFIRMATION_ENABLED: z.boolean().default(true),
  PUBLIC_BASE_URL: z.string().url(),
  MONTHLY_BUDGET_THB: z.coerce.number().positive().default(1000),
  USD_TO_THB_RATE: z.coerce.number().positive().default(36),
  CLAUDE_INPUT_PRICE_USD_PER_MTOK: z.coerce.number().nonnegative().default(5),
  CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: z.coerce.number().nonnegative().default(25),
  R2_PRICE_USD_PER_GB_MONTH: z.coerce.number().nonnegative().default(0.015),
});

export interface AppConfig {
  timeZone: "Asia/Bangkok";
  uploadCutoffMinutes: number;
  productIdPrefix: string;
  importCron: string;
  importRetryLimit: 5;
  publicationCron: string;
  publicationRetryLimit: 5;
  productIdInitialNumber: number;
  firstImportCutoffDate: string | null;
  airtableBaseId: string;
  airtableProductsTableId: string;
  airtablePublicationRunsTableId: string;
  googleDriveFolderId: string;
  googleTemplateDocId: string;
  claudeModel: "claude-opus-5";
  claudeRequestInputTokenLimit: number;
  lineAllowedGroupId: string;
  soldoutConfirmationEnabled: boolean;
  publicBaseUrl: string;
  monthlyBudgetThb: number;
  usdToThbRate: number;
  claudeInputPriceUsdPerMtok: number;
  claudeOutputPriceUsdPerMtok: number;
  r2PriceUsdPerGbMonth: number;
}

export function parseConfig(raw: unknown): AppConfig {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  const parsed = RawAppConfigSchema.parse(value);
  return {
    timeZone: parsed.TIME_ZONE,
    uploadCutoffMinutes: parsed.UPLOAD_CUTOFF_MINUTES,
    productIdPrefix: parsed.PRODUCT_ID_PREFIX,
    importCron: parsed.IMPORT_CRON,
    importRetryLimit: parsed.IMPORT_RETRY_LIMIT,
    publicationCron: parsed.PUBLICATION_CRON,
    publicationRetryLimit: parsed.PUBLICATION_RETRY_LIMIT,
    productIdInitialNumber: parsed.PRODUCT_ID_INITIAL_NUMBER,
    firstImportCutoffDate: parsed.FIRST_IMPORT_CUTOFF_DATE,
    airtableBaseId: parsed.AIRTABLE_BASE_ID,
    airtableProductsTableId: parsed.AIRTABLE_PRODUCTS_TABLE_ID,
    airtablePublicationRunsTableId: parsed.AIRTABLE_PUBLICATION_RUNS_TABLE_ID,
    googleDriveFolderId: parsed.GOOGLE_DRIVE_FOLDER_ID,
    googleTemplateDocId: parsed.GOOGLE_TEMPLATE_DOC_ID,
    claudeModel: parsed.CLAUDE_MODEL,
    claudeRequestInputTokenLimit: parsed.CLAUDE_REQUEST_INPUT_TOKEN_LIMIT,
    lineAllowedGroupId: parsed.LINE_ALLOWED_GROUP_ID,
    soldoutConfirmationEnabled: parsed.SOLDOUT_CONFIRMATION_ENABLED,
    publicBaseUrl: parsed.PUBLIC_BASE_URL,
    monthlyBudgetThb: parsed.MONTHLY_BUDGET_THB,
    usdToThbRate: parsed.USD_TO_THB_RATE,
    claudeInputPriceUsdPerMtok: parsed.CLAUDE_INPUT_PRICE_USD_PER_MTOK,
    claudeOutputPriceUsdPerMtok: parsed.CLAUDE_OUTPUT_PRICE_USD_PER_MTOK,
    r2PriceUsdPerGbMonth: parsed.R2_PRICE_USD_PER_GB_MONTH,
  };
}
