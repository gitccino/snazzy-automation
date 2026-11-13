import type { SettingsView } from "../../../src/settings/schema";
export function sampleView(): SettingsView {
  return {
    nextProductNumber: 100,
    record: {
      schemaVersion: 1,
      revision: 1,
      updatedAt: new Date().toISOString(),
      settings: {
        AIRTABLE_BASE_ID: "appSample",
        AIRTABLE_PRODUCTS_TABLE_ID: "tblProducts",
        AIRTABLE_PUBLICATION_RUNS_TABLE_ID: "tblPublications",
        GOOGLE_DRIVE_FOLDER_ID: "sample-folder",
        GOOGLE_TEMPLATE_DOC_ID: "sample-template",
        LINE_ALLOWED_GROUP_IDS: ["Csample"],
        SOLDOUT_CONFIRMATION_ENABLED: true,
        FIRST_IMPORT_CUTOFF_DATE: null,
        IMPORT_RETRY_LIMIT: 0,
        PUBLICATION_RETRY_LIMIT: 0,
        AI_CAPTIONS_ENABLED: false, CLAUDE_MODEL: "claude-opus-5",
        PRODUCT_ID_INITIAL_NUMBER: 1,
        CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 150000,
        MONTHLY_BUDGET_THB: 1000,
        USD_TO_THB_RATE: 36,
        CLAUDE_INPUT_PRICE_USD_PER_MTOK: 5,
        CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: 25,
        R2_PRICE_USD_PER_GB_MONTH: 0.015,
      },
    },
    deployment: {
      environment: "local sample",
      publicBaseUrl: "https://example.invalid",
      googleOAuthClientId: "sample-client",
      schedulingEnabled: false,
    },
  };
}
