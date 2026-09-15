import { env } from "cloudflare:test";
import type { Env } from "../../src/env";

export interface TestEnvConfig {
  ICLOUD_SHARED_ALBUM_TOKEN: string;
  AIRTABLE_TOKEN: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  ANTHROPIC_API_KEY: string;
  ASSET_URL_SIGNING_SECRET: string;
  ADMIN_ROUTE_TOKEN: string;
  APP_CONFIG_JSON: string;
}

export function createTestEnv(overrides: Partial<TestEnvConfig> = {}): TestEnvConfig {
  return {
    ICLOUD_SHARED_ALBUM_TOKEN: "TEST-TOKEN-ABC123",
    AIRTABLE_TOKEN: "test-airtable-token",
    LINE_CHANNEL_ACCESS_TOKEN: "test-line-token",
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: "publication-test@example.iam.gserviceaccount.com",
      private_key: "test-private-key",
    }),
    ANTHROPIC_API_KEY: "test-anthropic-key",
    ASSET_URL_SIGNING_SECRET: "test-signing-secret",
    ADMIN_ROUTE_TOKEN: "test-admin-route-token",
    APP_CONFIG_JSON: JSON.stringify({
      TIME_ZONE: "Asia/Bangkok",
      UPLOAD_CUTOFF_MINUTES: 30,
      PRODUCT_ID_PREFIX: "A",
      IMPORT_CRON: "0 23 * * *",
      IMPORT_RETRY_LIMIT: 5,
      PUBLICATION_CRON: "30 23 * * *",
      PUBLICATION_RETRY_LIMIT: 5,
      PRODUCT_ID_INITIAL_NUMBER: 1,
      FIRST_IMPORT_CUTOFF_DATE: null,
      AIRTABLE_BASE_ID: "appTest",
      AIRTABLE_PRODUCTS_TABLE_ID: "tblProducts",
      AIRTABLE_PUBLICATION_RUNS_TABLE_ID: "tblRuns",
      GOOGLE_DRIVE_FOLDER_ID: "folder-1",
      GOOGLE_TEMPLATE_DOC_ID: "template-1",
      CLAUDE_MODEL: "claude-opus-5",
      CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 150_000,
      LINE_ALLOWED_GROUP_ID: "CtestGroup",
      PUBLIC_BASE_URL: "https://example.workers.dev",
    }),
    ...overrides,
  };
}

export function testEnv(): Env {
  return env as unknown as Env;
}
