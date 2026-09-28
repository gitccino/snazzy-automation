import { describe, expect, it } from "vitest";
import { buildWorkerAppConfig } from "../../scripts/worker-app-config";

const env = {
  AIRTABLE_BASE_ID: "app-staging",
  AIRTABLE_PRODUCTS_TABLE_ID: "tbl-products",
  AIRTABLE_PUBLICATION_RUNS_TABLE_ID: "tbl-runs",
  LINE_ALLOWED_GROUP_ID: "group-staging",
  GOOGLE_DRIVE_FOLDER_ID: "folder-staging",
  GOOGLE_TEMPLATE_DOC_ID: "doc-staging",
  WORKER_BASE_URL: "https://snazzy-automation-staging.example.workers.dev",
  FIRST_IMPORT_CUTOFF_DATE: "2026-09-01T12:00:00.000Z",
};

describe("Worker APP_CONFIG_JSON", () => {
  it("lists missing required values before producing a config", () => {
      expect(() => buildWorkerAppConfig({ ...env, GOOGLE_TEMPLATE_DOC_ID: "" })).toThrow(
      "GOOGLE_TEMPLATE_DOC_ID",
    );
  });

  it("rejects an invalid Worker URL before config upload", () => {
    expect(() => buildWorkerAppConfig({ ...env, WORKER_BASE_URL: "not-a-url" })).toThrow();
  });

  it("rejects an insecure Worker URL before config upload", () => {
    expect(() => buildWorkerAppConfig({ ...env, WORKER_BASE_URL: "http://worker.example.com" })).toThrow();
  });

  it("rejects Worker URLs with embedded credentials before config upload", () => {
    expect(() => buildWorkerAppConfig({ ...env, WORKER_BASE_URL: "https://user:pass@worker.example.com" })).toThrow();
  });

  it("rejects a cutoff date that the runtime cannot parse", () => {
    expect(() => buildWorkerAppConfig({ ...env, FIRST_IMPORT_CUTOFF_DATE: "September 1, 2026" })).toThrow();
  });

  it("builds the staging runtime config from exported values", () => {
    expect(buildWorkerAppConfig(env)).toEqual({
      AIRTABLE_BASE_ID: "app-staging",
      AIRTABLE_PRODUCTS_TABLE_ID: "tbl-products",
      AIRTABLE_PUBLICATION_RUNS_TABLE_ID: "tbl-runs",
      LINE_ALLOWED_GROUP_ID: "group-staging",
      GOOGLE_DRIVE_FOLDER_ID: "folder-staging",
      GOOGLE_TEMPLATE_DOC_ID: "doc-staging",
      PUBLIC_BASE_URL: "https://snazzy-automation-staging.example.workers.dev",
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
      FIRST_IMPORT_CUTOFF_DATE: "2026-09-01T12:00:00.000Z",
      MONTHLY_BUDGET_THB: 1000,
      USD_TO_THB_RATE: 36,
      CLAUDE_INPUT_PRICE_USD_PER_MTOK: 5,
      CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: 25,
      R2_PRICE_USD_PER_GB_MONTH: 0.015,
    });
  });
});
