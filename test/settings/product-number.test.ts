import { beforeEach, expect, it, vi } from "vitest";
import { testEnv, createTestEnv } from "../helpers/env";
import { initializeSettings, readSettings } from "../../src/db/settings-repository";
import { saveNextProductNumber } from "../../src/settings/product-number";
import { createSequenceRepository } from "../../src/db/sequence-repository";
import { sampleView } from "../../apps/settings/test/sample";

const env = () => ({ ...testEnv(), ...createTestEnv(), CONFIGURATION_MODE: "d1" as const, PUBLIC_BASE_URL: "https://example.test" });
const request = { expectedRevision: 1, expectedNextValue: 100, nextValue: 200 };
const empty = () => Promise.resolve(Response.json({ records: [] }));
const next = () => env().DB.prepare("SELECT next_value FROM sequences WHERE name='product_id'").first<{ next_value: number }>();
beforeEach(async () => {
  await env().DB.prepare("DELETE FROM app_settings").run();
  await initializeSettings(env().DB, sampleView().record.settings, "2026-11-12T00:00:00.000Z");
  await env().DB.prepare("INSERT OR REPLACE INTO sequences(name,next_value,bootstrapped_at) VALUES('product_id',100,'2026-11-12T00:00:00.000Z')").run();
});
it("checks the saved Airtable target and advances the allocator without changing historical initial settings", async () => {
  const fetcher = vi.fn<typeof fetch>(empty);
  expect(await saveNextProductNumber(env(), request, fetcher)).toEqual({ ok: true, value: { nextProductNumber: 200 } });
  const url = new URL(String(fetcher.mock.calls[0]![0]));
  expect(url.pathname).toBe("/v0/appSample/tblProducts");
  expect(url.searchParams.get("filterByFormula")).toContain(">= 200");
  expect(await createSequenceRepository(env().DB).allocateNext("product_id")).toBe(200);
  expect((await readSettings(env().DB))?.settings.PRODUCT_ID_INITIAL_NUMBER).toBe(1);
});
it("rejects backwards, unsafe and colliding numbers without changing D1", async () => {
  const collision = async () => Response.json({ records: [{ id: "rec1", fields: { "Product ID": "A-200" } }] });
  expect(await saveNextProductNumber(env(), { ...request, nextValue: 99 }, empty)).toMatchObject({ ok: false, code: "invalid_settings" });
  expect(await saveNextProductNumber(env(), { ...request, nextValue: 1.5 }, empty)).toMatchObject({ ok: false });
  expect(await saveNextProductNumber(env(), { ...request, nextValue: Number.MAX_SAFE_INTEGER + 1 }, empty)).toMatchObject({ ok: false });
  expect(await saveNextProductNumber(env(), request, collision)).toMatchObject({ ok: false, fieldErrors: { nextProductNumber: expect.any(String) } });
  expect((await next())?.next_value).toBe(100);
});
it("fails closed on Airtable errors and stale settings", async () => {
  expect(await saveNextProductNumber(env(), request, async () => new Response("", { status: 503 }))).toMatchObject({ ok: false, code: "connection_validation_failed" });
  expect(await saveNextProductNumber(env(), { ...request, expectedRevision: 2 }, empty)).toMatchObject({ ok: false, code: "revision_conflict" });
  expect((await next())?.next_value).toBe(100);
});
it("does not overwrite an import allocation or connection change occurring during Airtable validation", async () => {
  expect(await saveNextProductNumber(env(), request, async () => {
    await createSequenceRepository(env().DB).allocateNext("product_id");
    return empty();
  })).toMatchObject({ ok: false, code: "sequence_conflict" });
  expect((await next())?.next_value).toBe(101);
  expect(await saveNextProductNumber(env(), { ...request, expectedNextValue: 101 }, async () => {
    await env().DB.prepare("UPDATE app_settings SET revision=2 WHERE id=1").run();
    return empty();
  })).toMatchObject({ ok: false, code: "sequence_conflict" });
  expect((await next())?.next_value).toBe(101);
});
it("allows only one of two concurrent edits from the same counter", async () => {
  const results = await Promise.all([saveNextProductNumber(env(), request, empty), saveNextProductNumber(env(), { ...request, nextValue: 300 }, empty)]);
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(results.filter(r => !r.ok)).toHaveLength(1);
});
