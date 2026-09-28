import { describe, expect, it } from "vitest";
import { validateStagingSetup } from "../../scripts/staging-setup-check";

const healthyReport = {
  ok: true,
  checks: [
    "d1_migrations",
    "r2_access",
    "asset_delivery",
    "images_binding",
    "airtable_schema",
    "sequence_consistency",
    "line_webhook_config",
    "google_template_access",
    "claude_credential",
    "icloud_phase_zero",
    "cron_timezone",
  ].map((name) => ({
    name,
    ok: true,
  })),
};

describe("validateStagingSetup", () => {
  it("checks both rejected auth requests and all eleven authorized checks", async () => {
    const statuses = [401, 401, 200];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const result = await validateStagingSetup({
      workerBaseUrl: "https://staging.example.workers.dev",
      adminRouteToken: "test-admin-token",
      fetcher: async (input, init) => {
        requests.push({ url: String(input), init });
        const status = statuses.shift() ?? 500;
        return new Response(status === 200 ? JSON.stringify(healthyReport) : "", { status });
      },
    });

    expect(result.errors).toEqual([]);
    expect(requests.map(({ url }) => url)).toEqual(Array(3).fill("https://staging.example.workers.dev/setup"));
    expect(requests[0]?.init?.headers).toBeUndefined();
    expect(requests[1]?.init?.headers).toEqual({ Authorization: "Bearer wrong-token" });
    expect(requests[2]?.init?.headers).toEqual({ Authorization: "Bearer test-admin-token" });
  });

  it("reports unexpected auth statuses and failed setup checks", async () => {
    const report = {
      ok: false,
      checks: healthyReport.checks.map((check, index) =>
        index === 7 ? { ...check, name: "google_template_access", ok: false } : check,
      ),
    };
    const statuses = [200, 403, 503];
    const result = await validateStagingSetup({
      workerBaseUrl: "https://staging.example.workers.dev",
      adminRouteToken: "test-admin-token",
      fetcher: async () => {
        const status = statuses.shift() ?? 500;
        return new Response(status === 503 ? JSON.stringify(report) : "", { status });
      },
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "Unauthenticated /setup request returned HTTP 200; expected 401.",
        "Wrong-token /setup request returned HTTP 403; expected 401.",
        "Authorized /setup request returned HTTP 503; expected 200.",
        "Setup report ok was not true.",
        "Failed setup checks: google_template_access.",
      ]),
    );
  });

  it("rejects a duplicate successful check when an expected check is missing", async () => {
    const report = {
      ok: true,
      checks: healthyReport.checks.map((check, index) =>
        index === healthyReport.checks.length - 1
          ? { ...check, name: "d1_migrations" }
          : check,
      ),
    };
    const statuses = [401, 401, 200];
    const result = await validateStagingSetup({
      workerBaseUrl: "https://staging.example.workers.dev",
      adminRouteToken: "test-admin-token",
      fetcher: async () => {
        const status = statuses.shift() ?? 500;
        return new Response(status === 200 ? JSON.stringify(report) : "", { status });
      },
    });

    expect(result.errors).toContain("Duplicate setup check: d1_migrations.");
    expect(result.errors).toContain("Missing setup check: cron_timezone.");
  });
});
