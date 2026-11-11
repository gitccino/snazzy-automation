import { expect, it, vi } from "vitest";
import { handleScheduled, runBudgetAlarmCheck } from "../src/scheduled";
import { testEnv, createTestEnv } from "./helpers/env";
it("ignores every old schedule and unknown events without touching any binding", async () => {
  const env = new Proxy({} as ReturnType<typeof testEnv>, {
    get() {
      throw new Error("Scheduled event touched a binding");
    },
  });
  for (const cron of ["0 23 * * *", "30 23 * * *", "45 22 * * *", "unknown"])
    await expect(handleScheduled(env, cron)).resolves.toBeUndefined();
});
it("retains budget reporting without sending scheduled messages", async () => {
  const pushMessage = vi.fn();
  const result = await runBudgetAlarmCheck({
    ...testEnv(),
    ...createTestEnv(),
    __lineClientOverride: { pushMessage } as never,
  });
  expect(result.sent).toBe(false);
  expect(pushMessage).not.toHaveBeenCalled();
});
