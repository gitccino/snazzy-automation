import type { Env } from "./env";
import { routeRequest } from "./router";
import { handleScheduled } from "./scheduled";

export { LineCommandWorkflow } from "./line/command-workflow";
export { ImportWorkflow } from "./import/workflow";
export { PublicationWorkflow } from "./publication/workflow";

export default {
  fetch(request, env, ctx) {
    return routeRequest(request, env, ctx);
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(handleScheduled(
      env,
      controller.cron,
      { now: () => new Date(controller.scheduledTime) },
    ));
  },
} satisfies ExportedHandler<Env>;

export { LineMutationFollowupWorkflow } from "./line/mutation-followup-workflow";
