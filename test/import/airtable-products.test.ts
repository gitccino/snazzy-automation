import { describe, expect, it } from "vitest";
import { createAirtableProductsClient } from "../../src/import/airtable-products";
import { fakeFetch } from "../helpers/fakes";

const config = {
  baseId: "base123",
  tableId: "tblProducts",
  token: "test-token",
};

describe("airtable-products client", () => {
  it("createProduct posts the required system fields and Inventory Status = In", async () => {
    let capturedBody: unknown;
    const fetchFake = fakeFetch([
      {
        match: (req) =>
          req.method === "POST" &&
          req.url ===
            `https://api.airtable.com/v0/${config.baseId}/${config.tableId}`,
        respond: async (req) => {
          capturedBody = await req.json();
          return new Response(JSON.stringify({ id: "recNEW" }), {
            status: 200,
          });
        },
      },
    ]);
    const client = createAirtableProductsClient({ ...config, fetch: fetchFake });

    const result = await client.createProduct({
      productId: "A-501",
      systemGroupId: "grouphash-1",
      uploadDate: "2026-09-01",
      productImages: [
        { url: "https://example.workers.dev/assets/a.jpg", filename: "a.jpg" },
        { url: "https://example.workers.dev/assets/b.jpg", filename: "b.jpg" },
      ],
    });

    expect(result).toEqual({ recordId: "recNEW" });
    expect(capturedBody).toMatchObject({
      fields: {
        "Product ID": "A-501",
        "System Group ID": "grouphash-1",
        "Upload Date": "2026-09-01",
        "Inventory Status": "In",
        "Product Images": [
          { url: "https://example.workers.dev/assets/a.jpg", filename: "a.jpg" },
          { url: "https://example.workers.dev/assets/b.jpg", filename: "b.jpg" },
        ],
      },
    });
  });

  it("findBySystemGroupId requests one record from the configured collection", async () => {
    const fetchFake = fakeFetch([
      {
        match: (req) => {
          const url = new URL(req.url);
          return (
            req.method === "GET" &&
            `${url.origin}${url.pathname}` ===
              `https://api.airtable.com/v0/${config.baseId}/${config.tableId}` &&
            url.searchParams.get("maxRecords") === "1" &&
            url.searchParams.get("filterByFormula") ===
              '{System Group ID} = "grouphash-1"'
          );
        },
        respond: () => new Response(JSON.stringify({ records: [] }), { status: 200 }),
      },
    ]);
    const client = createAirtableProductsClient({ ...config, fetch: fetchFake });

    expect(await client.findBySystemGroupId("grouphash-1")).toBeNull();
  });

  it("findBySystemGroupId escapes system group IDs as Airtable string literals", async () => {
    const fetchFake = fakeFetch([
      {
        match: (req) =>
          new URL(req.url).searchParams.get("filterByFormula") ===
          '{System Group ID} = "hash\\\"with-quote"',
        respond: () => new Response(JSON.stringify({ records: [] }), { status: 200 }),
      },
    ]);
    const client = createAirtableProductsClient({ ...config, fetch: fetchFake });

    expect(await client.findBySystemGroupId('hash"with-quote')).toBeNull();
  });

  it("findBySystemGroupId returns null when no record matches", async () => {
    const fetchFake = fakeFetch([
      {
        match: (req) => req.method === "GET",
        respond: () => new Response(JSON.stringify({ records: [] }), { status: 200 }),
      },
    ]);
    const client = createAirtableProductsClient({ ...config, fetch: fetchFake });
    expect(await client.findBySystemGroupId("missing-hash")).toBeNull();
  });

  it("findBySystemGroupId returns the matching record and Product ID", async () => {
    const fetchFake = fakeFetch([
      {
        match: (req) => req.method === "GET",
        respond: () =>
          new Response(
            JSON.stringify({
              records: [{ id: "recEXISTING", fields: { "Product ID": "A-500" } }],
            }),
            { status: 200 },
          ),
      },
    ]);
    const client = createAirtableProductsClient({ ...config, fetch: fetchFake });
    expect(await client.findBySystemGroupId("grouphash-1")).toEqual({
      recordId: "recEXISTING",
      productId: "A-500",
    });
  });

  it("verifyProduct checks the record has exactly the expected attachment count", async () => {
    const fetchFake = fakeFetch([
      {
        match: (req) => req.method === "GET" && req.url.includes("recNEW"),
        respond: () =>
          new Response(
            JSON.stringify({
              id: "recNEW",
              fields: { "Product Images": [{ url: "a" }, { url: "b" }] },
            }),
            { status: 200 },
          ),
      },
    ]);
    const client = createAirtableProductsClient({ ...config, fetch: fetchFake });
    expect(await client.verifyProduct("recNEW", 2)).toBe(true);
    expect(await client.verifyProduct("recNEW", 3)).toBe(false);
  });

  it("deleteProduct issues a DELETE against the record", async () => {
    let deletedUrl: string | null = null;
    const fetchFake = fakeFetch([
      {
        match: (req) => req.method === "DELETE",
        respond: (req) => {
          deletedUrl = req.url;
          return new Response(JSON.stringify({ id: "recNEW", deleted: true }), {
            status: 200,
          });
        },
      },
    ]);
    const client = createAirtableProductsClient({ ...config, fetch: fetchFake });
    await client.deleteProduct("recNEW");
    expect(deletedUrl).toBe(
      `https://api.airtable.com/v0/${config.baseId}/${config.tableId}/recNEW`,
    );
  });

  it("createProduct throws OperationalError with retryable=true on a 429", async () => {
    const fetchFake = fakeFetch([
      {
        match: (req) => req.method === "POST",
        respond: () =>
          new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }),
      },
    ]);
    const client = createAirtableProductsClient({ ...config, fetch: fetchFake });
    await expect(
      client.createProduct({
        productId: "A-501",
        systemGroupId: "g1",
        uploadDate: "2026-09-01",
        productImages: [],
      }),
    ).rejects.toMatchObject({ code: "airtable_rate_limited", retryable: true });
  });

  it("rejects a malformed successful Airtable response", async () => {
    const fetchFake = fakeFetch([
      {
        match: (req) => req.method === "POST",
        respond: () => new Response(JSON.stringify({ id: 42 }), { status: 200 }),
      },
    ]);
    const client = createAirtableProductsClient({ ...config, fetch: fetchFake });

    await expect(
      client.createProduct({
        productId: "A-501",
        systemGroupId: "g1",
        uploadDate: "2026-09-01",
        productImages: [],
      }),
    ).rejects.toMatchObject({
      code: "airtable_create_invalid_response",
      retryable: false,
    });
  });
});
