import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSequenceRepository } from "../src/db/sequence-repository";
import { routeRequest } from "../src/router";
import worker from "../src/index";
import { createTestEnv, testEnv } from "./helpers/env";

function routerEnv() {
  const create = vi.fn().mockResolvedValue({ id: "admin-instance" });
  const env = { ...testEnv(), ...createTestEnv() };
  env.IMPORT_WORKFLOW = { create } as unknown as typeof env.IMPORT_WORKFLOW;
  return { env, create };
}

describe("routeRequest", () => {
  beforeEach(async () => {
    await testEnv().DB.prepare("DELETE FROM import_runs WHERE source_album_id = ?")
      .bind("eaf00f6811d7e301eff601ca3dc1e8c72202e63e7ebc28df6270d639cb491058").run();
    await testEnv().DB.prepare("DELETE FROM sequences WHERE name = ?").bind("product_id").run();
  });

  // Mutation: starting work or checking bootstrap before authenticating the public route.
  it("rejects invalid authorization before any run or Workflow is created", async () => {
    const { env, create } = routerEnv();
    for (const authorization of [undefined, "Basic test-admin-route-token", "Bearer", "Bearer ", "bearer test-admin-route-token", "Bearer  test-admin-route-token", "Bearer\ttest-admin-route-token", "Bearer wrong", "Bearer test-admin-route-token extra"]) {
      const response = await routeRequest(new Request("https://worker.example/upload", {
        method: "POST", headers: authorization === undefined ? {} : { authorization },
      }), env);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect(create).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM import_runs").first("count")).toBe(0);
  });
  // Mutation: refusing valid authorization, or passing the wrong trigger into the import Workflow.
  it("starts an admin import with the exact bearer token", async () => {
    const { env, create } = routerEnv();
    await createSequenceRepository(env.DB).bootstrap("product_id", 1);
    const response = await routeRequest(new Request("https://worker.example/upload", {
      method: "POST", headers: { authorization: "Bearer test-admin-route-token" },
    }), env);
    expect(response.status).toBe(202);
    expect(create.mock.calls[0]?.[0].params.trigger).toBe("admin");
  });
  // Mutation: dropping signed-asset dispatch or routing another method/path into a handler.
  it("dispatches GET assets to signature validation and rejects other methods and paths", async () => {
    const { env, create } = routerEnv();
    const get = vi.fn();
    env.IMAGES_BUCKET = { get } as unknown as typeof env.IMAGES_BUCKET;
    const forbidden = await routeRequest(new Request("https://worker.example/assets/photo.jpg"), env);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toBe("forbidden");
    for (const [method, path] of [["POST", "/assets/photo.jpg"], ["GET", "/assets"], ["GET", "/upload"], ["PUT", "/upload"], ["POST", "/upload/"], ["POST", "/uploads"]]) {
      const response = await routeRequest(new Request(`https://worker.example${path}`, {
        method, headers: { authorization: "Bearer test-admin-route-token" },
      }), env);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  // Mutation: leaving the foundation Worker placeholder instead of dispatching fetch into the router.
  it("exposes the authenticated route through the Worker fetch handler", async () => {
    const { env, create } = routerEnv();
    const fetchHandler: ExportedHandlerFetchHandler<typeof env> = worker.fetch;
    const response = await fetchHandler(new Request("https://worker.example/upload", { method: "POST" }), env, {} as ExecutionContext);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(create).not.toHaveBeenCalled();
  });
});
