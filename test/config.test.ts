import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";

const validRawConfig = {
  TIME_ZONE: "Asia/Bangkok",
  UPLOAD_CUTOFF_MINUTES: 30,
  PRODUCT_ID_PREFIX: "A",
  IMPORT_CRON: "0 23 * * *",
  IMPORT_RETRY_LIMIT: 5,
  PUBLICATION_CRON: "30 23 * * *",
  PUBLICATION_RETRY_LIMIT: 5,
  PRODUCT_ID_INITIAL_NUMBER: 1,
  FIRST_IMPORT_CUTOFF_DATE: "2026-09-01T00:00:00.000Z",
  AIRTABLE_BASE_ID: "appBase",
  AIRTABLE_PRODUCTS_TABLE_ID: "tblProducts",
  AIRTABLE_PUBLICATION_RUNS_TABLE_ID: "tblRuns",
  GOOGLE_DRIVE_FOLDER_ID: "folder-1",
  GOOGLE_TEMPLATE_DOC_ID: "template-1",
  CLAUDE_MODEL: "claude-opus-5",
  CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 150_000,
  LINE_ALLOWED_GROUP_ID: "Cgroup",
  PUBLIC_BASE_URL: "https://snazzy-staging.example.workers.dev",
} as const;

describe("parseConfig", () => {
  it("parses the import uppercase JSON contract into camel-case runtime fields", () => {
    const config = parseConfig(JSON.stringify(validRawConfig));

    expect(config).toEqual({
      timeZone: "Asia/Bangkok",
      uploadCutoffMinutes: 30,
      productIdPrefix: "A",
      importCron: "0 23 * * *",
      importRetryLimit: 5,
      publicationCron: "30 23 * * *",
      publicationRetryLimit: 5,
      productIdInitialNumber: 1,
      firstImportCutoffDate: "2026-09-01T00:00:00.000Z",
      airtableBaseId: "appBase",
      airtableProductsTableId: "tblProducts",
      airtablePublicationRunsTableId: "tblRuns",
      googleDriveFolderId: "folder-1",
      googleTemplateDocId: "template-1",
      claudeModel: "claude-opus-5",
      claudeRequestInputTokenLimit: 150_000,
      lineAllowedGroupId: "Cgroup",
      soldoutConfirmationEnabled: true,
      publicBaseUrl: "https://snazzy-staging.example.workers.dev",
      monthlyBudgetThb: 1000,
      usdToThbRate: 36,
      claudeInputPriceUsdPerMtok: 5,
      claudeOutputPriceUsdPerMtok: 25,
      r2PriceUsdPerGbMonth: 0.015,
    });
  });

  it("rejects invalid JSON", () => {
    expect(() => parseConfig("not-json")).toThrow();
  });

  it("rejects a non-positive upload cutoff", () => {
    expect(() => parseConfig({
      ...validRawConfig,
      UPLOAD_CUTOFF_MINUTES: 0,
    })).toThrow();
  });

  it("rejects an empty Product ID prefix", () => {
    expect(() => parseConfig({
      ...validRawConfig,
      PRODUCT_ID_PREFIX: "",
    })).toThrow();
  });

  it("rejects any import retry count other than five", () => {
    expect(() => parseConfig({
      ...validRawConfig,
      IMPORT_RETRY_LIMIT: 4,
    })).toThrow();
  });

  it("maps every publication config key", () => {
    const config = parseConfig(validRawConfig);
    expect(config).toMatchObject({
      publicationCron: "30 23 * * *",
      publicationRetryLimit: 5,
      airtablePublicationRunsTableId: "tblRuns",
      googleDriveFolderId: "folder-1",
      googleTemplateDocId: "template-1",
      claudeModel: "claude-opus-5",
      claudeRequestInputTokenLimit: 150_000,
    });
  });

  it("maps LINE confirmation configuration without replacing the existing group ID", () => {
    const config = parseConfig({
      ...validRawConfig,
      SOLDOUT_CONFIRMATION_ENABLED: false,
    });
    expect(config.lineAllowedGroupId).toBe("Cgroup");
    expect(config.soldoutConfirmationEnabled).toBe(false);
  });

  it("maps approved cost settings from environment names", () => {
    const config = parseConfig(JSON.stringify({
      ...validRawConfig,
      MONTHLY_BUDGET_THB: "2000",
      USD_TO_THB_RATE: "35.5",
      CLAUDE_INPUT_PRICE_USD_PER_MTOK: "4",
      CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: "20",
      R2_PRICE_USD_PER_GB_MONTH: "0.01",
    }));

    expect(config).toMatchObject({
      monthlyBudgetThb: 2000,
      usdToThbRate: 35.5,
      claudeInputPriceUsdPerMtok: 4,
      claudeOutputPriceUsdPerMtok: 20,
      r2PriceUsdPerGbMonth: 0.01,
    });
  });

  it.each([
    ["retry limit", { PUBLICATION_RETRY_LIMIT: 4 }],
    ["model", { CLAUDE_MODEL: "claude-sonnet-5" }],
    ["token limit", { CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 150_001 }],
  ])("rejects invalid publication %s", (_name, patch) => {
    expect(() => parseConfig({
      ...validRawConfig,
      ...patch,
    })).toThrow();
  });
});
