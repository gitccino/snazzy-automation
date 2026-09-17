import { describe, expect, it } from "vitest";
import { createInventoryClient, matchesSaleValues } from "../../src/line/airtable-inventory";

const config = { baseId: "app1", tableId: "tbl1", token: "token" };

describe("inventory Airtable client", () => {
  it("maps missing legacy sale fields to null", async () => {
    const client = createInventoryClient({ ...config, fetch: async () => new Response(JSON.stringify({ records: [{ id: "rec1", fields: { "Product ID": "A-1", "Inventory Status": "Out", "Upload Date": "2026-09-01" } }] }), { status: 200 }) });
    expect(await client.findByProductId("A-1")).toMatchObject({ recordId: "rec1", soldPrice: null, soldAt: null, soldBy: null });
  });

  it("rejects an unknown inventory state instead of treating it as In", async () => {
    const client = createInventoryClient({ ...config, fetch: async () => new Response(JSON.stringify({ records: [{ id: "rec1", fields: { "Product ID": "A-1", "Inventory Status": "Unknown" } }] }), { status: 200 }) });
    await expect(client.findByProductId("A-1")).rejects.toMatchObject({ code: "airtable_inventory_invalid_record" });
  });

  it("writes only four system-owned sale fields", async () => {
    let body: unknown;
    const client = createInventoryClient({ ...config, now: () => new Date("2026-09-01T10:00:00.000Z"), fetch: async (_input, init) => { body = JSON.parse(String(init?.body)); return new Response("{}", { status: 200 }); } });
    await client.updateSaleValues("rec1", { inventoryStatus: "Out", soldPrice: 1290, soldAt: "2026-09-01T10:00:00.000Z", soldBy: "Mint (U1)" });
    expect(body).toEqual({ fields: { "Inventory Status": "Out", "Sold Price": 1290, "Sold At": "2026-09-01T10:00:00.000Z", "Sold By": "Mint (U1)", "Last System Update": "2026-09-01T10:00:00.000Z" } });
  });

  it("compares all sale fields", () => {
    const values = { inventoryStatus: "Out" as const, soldPrice: 1290, soldAt: "x", soldBy: "Mint (U1)" };
    expect(matchesSaleValues(values, values)).toBe(true);
    expect(matchesSaleValues(values, { ...values, soldPrice: 1300 })).toBe(false);
  });
});
