import { describe, expect, it, vi } from "vitest";
import { createInventoryClient, matchesSaleValues } from "../../src/line/airtable-inventory";
import type { Fetcher } from "../../src/shared/http";
import type { SaleValues } from "../../src/line/types";

const config = { baseId: "app1", tableId: "tbl1", token: "token" };
const sold: SaleValues = { inventoryStatus: "Out", soldPrice: 1290, soldAt: "2026-09-01T10:00:00.000Z", soldBy: "Mint (U1)" };
const unsold: SaleValues = { inventoryStatus: "In", soldPrice: null, soldAt: null, soldBy: null };
const record = (productId = "A-1") => ({ id: "rec1", fields: { "Product ID": productId, "Inventory Status": "Out", "Upload Date": "2026-09-01" } });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("inventory Airtable client", () => {
  it("maps missing legacy sale fields to null", async () => {
    const client = createInventoryClient({ ...config, fetch: async () => response({ records: [record()] }) });
    expect(await client.findByProductId("A-1")).toMatchObject({ recordId: "rec1", soldPrice: null, soldAt: null, soldBy: null });
  });

  it("uses an escaped formula, duplicate-safe query, and configured authorization", async () => {
    const fetch = vi.fn<Fetcher>().mockResolvedValue(response({ records: [] }));
    const client = createInventoryClient({ ...config, fetch });

    await client.findByProductId('A-1" OR 1=1');

    const [input, init] = fetch.mock.calls[0]!;
    const url = new URL(String(input));
    expect(`${url.origin}${url.pathname}`).toBe("https://api.airtable.com/v0/app1/tbl1");
    expect(url.searchParams.get("filterByFormula")).toBe('{Product ID} = "A-1\\\" OR 1=1"');
    expect(url.searchParams.get("maxRecords")).toBe("2");
    expect(url.searchParams.get("pageSize")).toBe("2");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
  });

  it.each([
    [{ records: [record(), { ...record(), id: "rec2" }] }],
    [{ records: [record()], offset: "another-page" }],
  ])("rejects an ambiguous inventory lookup: %o", async body => {
    const client = createInventoryClient({ ...config, fetch: async () => response(body) });
    await expect(client.findByProductId("A-1")).rejects.toMatchObject({ code: "airtable_inventory_ambiguous_record", retryable: false });
  });

  it("rejects a returned record for a different product ID", async () => {
    const client = createInventoryClient({ ...config, fetch: async () => response({ records: [record("A-2")] }) });
    await expect(client.findByProductId("A-1")).rejects.toMatchObject({ code: "airtable_inventory_invalid_record", retryable: false });
  });

  it("rejects malformed JSON as a non-retryable invalid response", async () => {
    const client = createInventoryClient({ ...config, fetch: async () => new Response("{", { status: 200 }) });
    await expect(client.findByProductId("A-1")).rejects.toMatchObject({ code: "airtable_inventory_invalid_response", retryable: false });
  });

  it.each([[429, true], [500, true], [400, false]])("marks HTTP %i inventory failures retryable=%s", async (status, retryable) => {
    const client = createInventoryClient({ ...config, fetch: async () => new Response("", { status }) });
    await expect(client.findByProductId("A-1")).rejects.toMatchObject({ code: "airtable_inventory_find_failed", retryable });
  });

  it("rejects an unknown inventory state instead of treating it as In", async () => {
    const client = createInventoryClient({ ...config, fetch: async () => response({ records: [{ ...record(), fields: { ...record().fields, "Inventory Status": "Unknown" } }] }) });
    await expect(client.findByProductId("A-1")).rejects.toMatchObject({ code: "airtable_inventory_invalid_record" });
  });

  it("writes only four system-owned sale fields", async () => {
    let body: unknown;
    const client = createInventoryClient({ ...config, now: () => new Date("2026-09-01T10:00:00.000Z"), fetch: async (_input, init) => { body = JSON.parse(String(init?.body)); return new Response("{}", { status: 200 }); } });
    await client.updateSaleValues("rec1", sold);
    expect(body).toEqual({ fields: { "Inventory Status": "Out", "Sold Price": 1290, "Sold At": "2026-09-01T10:00:00.000Z", "Sold By": "Mint (U1)", "Last System Update": "2026-09-01T10:00:00.000Z" } });
  });

  it("preserves explicit nulls to clear a reverted sale", async () => {
    let body: unknown;
    const client = createInventoryClient({ ...config, fetch: async (_input, init) => { body = JSON.parse(String(init?.body)); return response({}); } });
    await client.updateSaleValues("rec1", unsold);
    expect(body).toMatchObject({ fields: { "Inventory Status": "In", "Sold Price": null, "Sold At": null, "Sold By": null } });
  });

  it.each([
    [{ ...sold, inventoryStatus: "Unknown" }],
    [{ ...sold, soldPrice: 1.5 }],
    [{ ...sold, soldPrice: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...sold, soldAt: null }],
    [{ ...unsold, soldBy: "Mint (U1)" }],
  ])("rejects invalid outbound sale values: %o", async values => {
    const fetch = vi.fn<Fetcher>();
    const client = createInventoryClient({ ...config, fetch });
    await expect(client.updateSaleValues("rec1", values as SaleValues)).rejects.toMatchObject({ code: "airtable_inventory_invalid_sale_values", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["inventoryStatus", { ...sold, inventoryStatus: "In" }],
    ["soldPrice", { ...sold, soldPrice: 1300 }],
    ["soldAt", { ...sold, soldAt: "y" }],
    ["soldBy", { ...sold, soldBy: "Other (U2)" }],
  ] as const)("returns false when %s differs", (_field, changed) => {
    expect(matchesSaleValues(sold, sold)).toBe(true);
    expect(matchesSaleValues(sold, changed)).toBe(false);
  });
});
