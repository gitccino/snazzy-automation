import type { Env } from "./env";
import { parseConfig } from "./config";
import { handleUploadTrigger } from "./routes/upload";
import { handleDocsTrigger } from "./publication/trigger";
import type { Clock } from "./shared/time";

export async function handleScheduled(
  env: Env,
  cron: string,
  clock: Clock = { now: () => new Date() },
): Promise<void> {
  let failureCode = "scheduled_import_failed";
  try {
    const config = parseConfig(env.APP_CONFIG_JSON);
    if (cron === config.importCron) {
      const response = await handleUploadTrigger(env, "cron");
      if (response.status !== 202 && response.status !== 409) {
        throw new Error("scheduled_import_failed");
      }
      return;
    }
    if (cron === config.publicationCron) {
      failureCode = "scheduled_publication_failed";
      await handleDocsTrigger(env, "cron", clock);
    }
  } catch {
    // A rejected waitUntil exposes the failure without logging config or upstream bodies.
    throw new Error(failureCode);
  }
}
