import type { Env } from "./env";
import { parseConfig } from "./config";
import { handleUploadTrigger } from "./routes/upload";

export async function handleScheduled(env: Env, cron: string): Promise<void> {
  try {
    const config = parseConfig(env.APP_CONFIG_JSON);
    if (cron !== config.importCron) return;
    const response = await handleUploadTrigger(env, "cron");
    if (response.status !== 202 && response.status !== 409) {
      throw new Error("scheduled_import_failed");
    }
  } catch {
    // A rejected waitUntil exposes the failure without logging config or upstream bodies.
    throw new Error("scheduled_import_failed");
  }
}
