import { expect, it, vi } from "vitest";
import { handleSetup } from "../../src/routes/setup";
import { testEnv, createTestEnv } from "../helpers/env";
const env = () => ({ ...testEnv(), ...createTestEnv() });
const request = (token: string) => new Request("https://example.test/setup?check=caption-access", { headers: { authorization: `Bearer ${token}` } });
it("requires the admin credential before probing caption access", async () => {
  const fetcher = vi.fn();
  expect((await handleSetup(request("wrong"), env(), fetcher)).status).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
});
it("reports safe provider status without exposing provider response or credentials", async () => {
  const response = await handleSetup(request(env().ADMIN_ROUTE_TOKEN), env(), async () => Response.json({ error: { type: "authentication_error", message: "sentinel-secret" } }, { status: 401 }));
  expect(await response.json()).toEqual({ ok: false, requestedModel: "claude-opus-5", providerStatus: 401, category: "authentication" });
});
it("reports alias resolution without sending a caption request", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "resolved-model", type: "model" }));
  const response = await handleSetup(request(env().ADMIN_ROUTE_TOKEN), env(), fetcher);
  expect(await response.json()).toMatchObject({ ok: true, resolvedModel: "resolved-model", matchesConfiguredModel: false });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
