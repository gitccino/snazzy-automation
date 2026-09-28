import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { commandCalls } = vi.hoisted(() => ({ commandCalls: [] as unknown[][] }));

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => {
    commandCalls.push(args);
    return Buffer.from("");
  },
}));

const environmentKeys = [
  "AIRTABLE_BASE_ID",
  "AIRTABLE_PRODUCTS_TABLE_ID",
  "AIRTABLE_PUBLICATION_RUNS_TABLE_ID",
  "LINE_ALLOWED_GROUP_ID",
  "GOOGLE_DRIVE_FOLDER_ID",
  "GOOGLE_TEMPLATE_DOC_ID",
  "WORKER_BASE_URL",
  "FIRST_IMPORT_CUTOFF_DATE",
] as const;

const productionEnvironment = {
  AIRTABLE_BASE_ID: "app-production",
  AIRTABLE_PRODUCTS_TABLE_ID: "tbl-products-production",
  AIRTABLE_PUBLICATION_RUNS_TABLE_ID: "tbl-runs-production",
  LINE_ALLOWED_GROUP_ID: "group-production",
  GOOGLE_DRIVE_FOLDER_ID: "folder-production",
  GOOGLE_TEMPLATE_DOC_ID: "doc-production",
  WORKER_BASE_URL: "https://snazzy-automation-production.example.workers.dev",
  FIRST_IMPORT_CUTOFF_DATE: "2026-09-01T12:00:00.000Z",
};

const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
const originalArgument = process.argv[2];

describe("worker configuration command", () => {
  beforeEach(() => {
    commandCalls.length = 0;
    vi.resetModules();
    process.argv[2] = "production";
    Object.assign(process.env, productionEnvironment);
  });

  afterEach(() => {
    for (const key of environmentKeys) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (originalArgument === undefined) delete process.argv[2];
    else process.argv[2] = originalArgument;
  });

  it("uploads the config and deploys to the selected environment", async () => {
    await import("../../scripts/configure-worker");

    expect(commandCalls.map(([command, args]) => [command, args])).toEqual([
      ["npx", ["wrangler", "secret", "put", "APP_CONFIG_JSON", "--env", "production"]],
      ["npm", ["run", "deploy:production"]],
    ]);
    const options = commandCalls[0]?.[2] as { input?: string } | undefined;
    const uploadedConfig = JSON.parse(options?.input ?? "{}") as Record<string, unknown>;
    expect(uploadedConfig.AIRTABLE_BASE_ID).toBe("app-production");
    expect(uploadedConfig.PUBLIC_BASE_URL).toBe(productionEnvironment.WORKER_BASE_URL);
  });

  it("rejects unsupported environments before uploading a secret", async () => {
    process.argv[2] = "prod";

    await expect(import("../../scripts/configure-worker")).rejects.toThrow(
      "Environment must be staging or production.",
    );
    expect(commandCalls).toEqual([]);
  });
});
