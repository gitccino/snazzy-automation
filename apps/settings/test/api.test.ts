// @vitest-environment node
import { expect, it, vi } from "vitest";
import { api } from "../worker/api";
import { sampleView } from "./sample";
it("rejects cross-origin, non-JSON, oversized and mismatched writes before RPC", async () => {
  const saveSection = vi.fn(async () => ({
    ok: true as const,
    value: sampleView(),
  }));
  const env = {
    SETTINGS_ORIGIN: "https://settings.example",
    SETTINGS_SERVICE: {
      get: vi.fn(),
      saveSection,
      testConnection: vi.fn(),
      saveNextProductNumber: vi.fn(),
      exportConfiguration: vi.fn(),
    },
  };
  const body = JSON.stringify({
    expectedRevision: 1,
    section: "documents",
    changes: { AI_CAPTIONS_ENABLED: true },
  });
  for (const [origin, type, payload, status] of [
    ["https://evil.example", "application/json", body, 403],
    ["", "application/json", body, 403],
    ["https://settings.example", "text/plain", body, 400],
    ["https://settings.example", "application/json", "x".repeat(32769), 413],
    [
      "https://settings.example",
      "application/json",
      body.replace("documents", "import"),
      400,
    ],
    [
      "https://settings.example",
      "application/json",
      body.replace("AI_CAPTIONS_ENABLED", "GOOGLE_REFRESH_TOKEN"),
      400,
    ],
  ] as const) {
    const res = await api(
      new Request("https://settings.example/api/settings/sections/documents", {
        method: "PATCH",
        headers: { Origin: origin, "content-type": type },
        body: payload,
      }),
      env,
    );
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store");
  }
  expect(saveSection).not.toHaveBeenCalled();
  const missing = await api(
    new Request("https://settings.example/api/unknown"),
    env,
  );
  expect(missing.status).toBe(404);
});

it("validates counter writes before RPC and returns allocation conflicts as 409", async () => {
  const saveNextProductNumber = vi.fn(async () => ({ ok: false as const, code: "sequence_conflict" as const }));
  const env = { SETTINGS_ORIGIN: "https://settings.example", SETTINGS_SERVICE: {
    get: vi.fn(), saveSection: vi.fn(), testConnection: vi.fn(), exportConfiguration: vi.fn(), saveNextProductNumber,
  } };
  const payload = { expectedRevision: 1, expectedNextValue: 100, nextValue: 200 };
  const request = (origin: string, body: unknown) => new Request("https://settings.example/api/settings/next-product-number", {
    method: "POST", headers: { Origin: origin, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  expect((await api(request("https://evil.example", payload), env)).status).toBe(403);
  expect((await api(request(env.SETTINGS_ORIGIN, { ...payload, nextValue: 1.5 }), env)).status).toBe(400);
  expect((await api(request(env.SETTINGS_ORIGIN, { ...payload, GOOGLE_REFRESH_TOKEN: "forbidden" }), env)).status).toBe(400);
  expect(saveNextProductNumber).not.toHaveBeenCalled();
  expect((await api(request(env.SETTINGS_ORIGIN, payload), env)).status).toBe(409);
  expect(saveNextProductNumber).toHaveBeenCalledWith(payload);
});
