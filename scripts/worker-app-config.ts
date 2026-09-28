import { z } from "zod";

const requiredValues = [
  "AIRTABLE_BASE_ID",
  "AIRTABLE_PRODUCTS_TABLE_ID",
  "AIRTABLE_PUBLICATION_RUNS_TABLE_ID",
  "LINE_ALLOWED_GROUP_ID",
  "GOOGLE_DRIVE_FOLDER_ID",
  "GOOGLE_TEMPLATE_DOC_ID",
  "WORKER_BASE_URL",
  "FIRST_IMPORT_CUTOFF_DATE",
] as const;

export function buildWorkerAppConfig(env: Readonly<Record<string, string | undefined>>) {
  const missing = requiredValues.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required Worker config values: ${missing.join(", ")}`);
  }

  const value = (name: (typeof requiredValues)[number]) => env[name]!.trim();
  z.string()
    .url()
    .refine((url) => {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password;
    })
    .parse(value("WORKER_BASE_URL"));
  z.string().datetime().parse(value("FIRST_IMPORT_CUTOFF_DATE"));

  return {
    AIRTABLE_BASE_ID: value("AIRTABLE_BASE_ID"),
    AIRTABLE_PRODUCTS_TABLE_ID: value("AIRTABLE_PRODUCTS_TABLE_ID"),
    AIRTABLE_PUBLICATION_RUNS_TABLE_ID: value("AIRTABLE_PUBLICATION_RUNS_TABLE_ID"),
    LINE_ALLOWED_GROUP_ID: value("LINE_ALLOWED_GROUP_ID"),
    GOOGLE_DRIVE_FOLDER_ID: value("GOOGLE_DRIVE_FOLDER_ID"),
    GOOGLE_TEMPLATE_DOC_ID: value("GOOGLE_TEMPLATE_DOC_ID"),
    PUBLIC_BASE_URL: value("WORKER_BASE_URL"),
    TIME_ZONE: "Asia/Bangkok",
    IMPORT_CRON: "0 23 * * *",
    PUBLICATION_CRON: "30 23 * * *",
    UPLOAD_CUTOFF_MINUTES: 30,
    IMPORT_RETRY_LIMIT: 5,
    PUBLICATION_RETRY_LIMIT: 5,
    PRODUCT_ID_PREFIX: "A",
    PRODUCT_ID_INITIAL_NUMBER: 1,
    CLAUDE_MODEL: "claude-opus-5",
    CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 150000,
    SOLDOUT_CONFIRMATION_ENABLED: true,
    FIRST_IMPORT_CUTOFF_DATE: value("FIRST_IMPORT_CUTOFF_DATE"),
    MONTHLY_BUDGET_THB: 1000,
    USD_TO_THB_RATE: 36,
    CLAUDE_INPUT_PRICE_USD_PER_MTOK: 5,
    CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: 25,
    R2_PRICE_USD_PER_GB_MONTH: 0.015,
  };
}
