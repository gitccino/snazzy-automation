import { z } from "zod";

const RawAppConfigSchema = z.object({
  TIME_ZONE: z.literal("Asia/Bangkok"),
  UPLOAD_CUTOFF_MINUTES: z.number().int().positive(),
  PRODUCT_ID_PREFIX: z.string().min(1),
  IMPORT_CRON: z.string().min(1),
  IMPORT_RETRY_LIMIT: z.literal(5),
  PRODUCT_ID_INITIAL_NUMBER: z.number().int().positive(),
  FIRST_IMPORT_CUTOFF_DATE: z.string().datetime().nullable(),
  AIRTABLE_BASE_ID: z.string().min(1),
  AIRTABLE_PRODUCTS_TABLE_ID: z.string().min(1),
  LINE_ALLOWED_GROUP_ID: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url(),
});

export interface AppConfig {
  timeZone: "Asia/Bangkok";
  uploadCutoffMinutes: number;
  productIdPrefix: string;
  importCron: string;
  importRetryLimit: 5;
  productIdInitialNumber: number;
  firstImportCutoffDate: string | null;
  airtableBaseId: string;
  airtableProductsTableId: string;
  lineAllowedGroupId: string;
  publicBaseUrl: string;
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
    productIdInitialNumber: parsed.PRODUCT_ID_INITIAL_NUMBER,
    firstImportCutoffDate: parsed.FIRST_IMPORT_CUTOFF_DATE,
    airtableBaseId: parsed.AIRTABLE_BASE_ID,
    airtableProductsTableId: parsed.AIRTABLE_PRODUCTS_TABLE_ID,
    lineAllowedGroupId: parsed.LINE_ALLOWED_GROUP_ID,
    publicBaseUrl: parsed.PUBLIC_BASE_URL,
  };
}
