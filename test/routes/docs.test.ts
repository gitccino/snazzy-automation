import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";

const trigger = vi.hoisted(() => {
  // Workflow binding registration preloads the Worker modules before this test.
  vi.resetModules();
  return { handleDocsTrigger: vi.fn() };
});
vi.mock("../../src/publication/trigger", () => trigger);

import { handleDocsRoute } from "../../src/routes/docs";

const env = { ADMIN_ROUTE_TOKEN: "correct-token" } as Env;
const clock = { now: () => new Date("2026-09-01T17:30:00.000Z") };

function request(authorization?: string) {
  return new Request("https://worker.example/docs", {
    method: "POST", headers: authorization === undefined ? {} : { authorization },
  });
}

describe("POST /docs", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    trigger.handleDocsTrigger.mockResolvedValue({ status: "started", publicationRunId: "rec-run-1" });
  });

  it.each([undefined, "Bearer wrong-token", "Basic correct-token", "bearer correct-token", "Bearer", "Bearer  correct-token", "Bearer correct-token extra"])(
    "rejects invalid admin authorization %s before any trigger access",
    async (authorization) => {
      const response = await handleDocsRoute(request(authorization), env);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(trigger.handleDocsTrigger).not.toHaveBeenCalled();
    },
  );

  it("passes the authenticated admin trigger and injected clock to the shared service", async () => {
    const response = await handleDocsRoute(request("Bearer correct-token"), env, clock);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "started", publicationRunId: "rec-run-1" });
    expect(trigger.handleDocsTrigger).toHaveBeenCalledExactlyOnceWith(env, "admin", clock);
  });

  it.each([
    ["started", 202], ["restarted", 202], ["resumed", 202],
    ["already_generated", 200], ["already_running", 200], ["no_runnable_run", 200],
  ] as const)("returns HTTP %s result with status %s", async (status, expectedHttpStatus) => {
    const result = status === "no_runnable_run" ? { status } : { status, publicationRunId: "rec-run-1" };
    trigger.handleDocsTrigger.mockResolvedValue(result);

    const response = await handleDocsRoute(request("Bearer correct-token"), env, clock);

    expect(response.status).toBe(expectedHttpStatus);
    expect(await response.json()).toEqual(result);
  });

  it("returns a fixed failure response without exposing rejected upstream credentials or bodies", async () => {
    trigger.handleDocsTrigger.mockRejectedValue(new Error(
      "private upstream response Bearer AIRTABLE-SECRET sk-ant-SECRET -----BEGIN PRIVATE KEY----- correct-token",
    ));

    const response = await handleDocsRoute(request("Bearer correct-token"), env, clock);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"status":"publication_trigger_failed"}');
  });
});
