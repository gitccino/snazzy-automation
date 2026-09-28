import { validateStagingSetup } from "./staging-setup-check";

const workerBaseUrl = process.env.WORKER_BASE_URL;
const adminRouteToken = process.env.ADMIN_ROUTE_TOKEN;

if (!workerBaseUrl || !adminRouteToken) {
  console.error("Set WORKER_BASE_URL and ADMIN_ROUTE_TOKEN in this terminal before running this check.");
  process.exitCode = 1;
} else {
  try {
    const { errors, report } = await validateStagingSetup({ workerBaseUrl, adminRouteToken });
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      if (report !== undefined) console.error(JSON.stringify(report, null, 2));
      process.exitCode = 1;
    } else {
      console.log("All 11 staging setup checks passed.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
