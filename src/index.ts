import type { Env } from "./env";
import { routeRequest } from "./router";
import { handleScheduled } from "./scheduled";

export { LineCommandWorkflow } from "./line/command-workflow";
export { ImportWorkflow } from "./import/workflow";
export { PublicationWorkflow } from "./publication/workflow";
export { SettingsService } from "./settings/entrypoint";

export default {
  async fetch(request, env, ctx) {
    try {
      return await routeRequest(request, env, ctx);
    } catch (error) {
      const unavailable =
        error instanceof Error && error.message === "settings_unavailable";
      return Response.json(
        { error: unavailable ? "settings_unavailable" : "internal_error" },
        { status: unavailable ? 503 : 500 },
      );
    }
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(
      handleScheduled(env, controller.cron, {
        now: () => new Date(controller.scheduledTime),
      }),
    );
  },
} satisfies ExportedHandler<Env>;

export { LineMutationFollowupWorkflow } from "./line/mutation-followup-workflow";
