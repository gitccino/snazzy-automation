type SetupReport = {
  ok?: unknown;
  checks?: unknown;
};

type SetupValidationResult = {
  errors: string[];
  report: unknown;
};

const EXPECTED_SETUP_CHECKS = [
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
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function validateStagingSetup({
  workerBaseUrl,
  adminRouteToken,
  fetcher = fetch,
}: {
  workerBaseUrl: string;
  adminRouteToken: string;
  fetcher?: typeof fetch;
}): Promise<SetupValidationResult> {
  const url = new URL(workerBaseUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("WORKER_BASE_URL must be an HTTPS URL without embedded credentials.");
  }
  const setupUrl = new URL("/setup", url);
  const missingToken = await fetcher(setupUrl, { redirect: "error" });
  const wrongToken = await fetcher(setupUrl, {
    headers: { Authorization: "Bearer wrong-token" },
    redirect: "error",
  });
  const authorized = await fetcher(setupUrl, {
    headers: { Authorization: `Bearer ${adminRouteToken}` },
    redirect: "error",
  });

  const report: unknown = await authorized.json().catch(() => undefined);
  const errors: string[] = [];
  if (missingToken.status !== 401) {
    errors.push(`Unauthenticated /setup request returned HTTP ${missingToken.status}; expected 401.`);
  }
  if (wrongToken.status !== 401) {
    errors.push(`Wrong-token /setup request returned HTTP ${wrongToken.status}; expected 401.`);
  }
  if (authorized.status !== 200) {
    errors.push(`Authorized /setup request returned HTTP ${authorized.status}; expected 200.`);
  }
  if (!isRecord(report)) {
    errors.push("Authorized /setup response was not valid JSON.");
  } else {
    const setupReport = report as SetupReport;
    if (setupReport.ok !== true) errors.push("Setup report ok was not true.");
    if (!Array.isArray(setupReport.checks)) {
      errors.push("Setup report checks was not an array.");
    } else {
      if (setupReport.checks.length !== EXPECTED_SETUP_CHECKS.length) {
        errors.push(`Setup report contained ${setupReport.checks.length} checks; expected ${EXPECTED_SETUP_CHECKS.length}.`);
      }
      const expectedNames = new Set<string>(EXPECTED_SETUP_CHECKS);
      const nameCounts = new Map<string, number>();
      for (const check of setupReport.checks) {
        if (!isRecord(check) || typeof check.name !== "string") continue;
        nameCounts.set(check.name, (nameCounts.get(check.name) ?? 0) + 1);
      }
      for (const expectedName of EXPECTED_SETUP_CHECKS) {
        if (!nameCounts.has(expectedName)) errors.push(`Missing setup check: ${expectedName}.`);
        if ((nameCounts.get(expectedName) ?? 0) > 1) errors.push(`Duplicate setup check: ${expectedName}.`);
      }
      for (const [actualName] of nameCounts) {
        if (!expectedNames.has(actualName)) errors.push(`Unexpected setup check: ${actualName}.`);
      }
      const failedChecks = setupReport.checks
        .map((check, index) => ({ check, index }))
        .filter(({ check }) => !isRecord(check) || check.ok !== true)
        .map(({ check, index }) => (isRecord(check) && typeof check.name === "string" ? check.name : `#${index + 1}`));
      if (failedChecks.length > 0) errors.push(`Failed setup checks: ${failedChecks.join(", ")}.`);
    }
  }

  return { errors, report };
}
