import { describe, expect, it, vi } from "vitest";
import {
  findRunnableRunForDate,
  markRunGenerating,
  markRunGenerated,
  markRunNeedsCorrection,
  updateProductCollage,
  type AirtablePublicationConfig,
} from "../../src/publication/airtable-runs";
import type { Fetcher } from "../../src/shared/http";

const config = {
  airtableBaseId: "base123",
  airtableProductsTableId: "tblProducts",
  airtablePublicationRunsTableId: "tblRuns",
} satisfies AirtablePublicationConfig;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function productRecord(id: string, productId: string) {
  return {
    id,
    fields: {
      "Product ID": productId,
      "Product Images": [],
      "Brand Name": "Nike",
      "Model Name": "Air Max",
      "Condition Type": "Used",
      Size: "42",
      Description: "Good condition",
      "LINE Square Price": 1290,
      "IG Price": 1390,
    },
  };
}

describe("findRunnableRunForDate", () => {
  it("returns null when no Ready or Failed run matches the date", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ records: [] }));
    const result = await findRunnableRunForDate(fetcher, config, "token", "2026-09-01");
    expect(result).toBeNull();
  });

  it("fetches a Ready run, while the same query also permits retrying a Failed run", async () => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(
        jsonResponse({
          records: [
            {
              id: "recRun1",
              fields: {
                "Publication Date": "2026-09-01",
                Status: "Ready",
                Products: ["recProd1"],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          records: [
            {
              id: "recProd1",
              fields: {
                "Product ID": "A-1001",
                "Product Images": [{ id: "attImg1", url: "https://dl.airtable.com/img1.jpg", filename: "a.jpg" }],
                "Brand Name": "Nike",
                "Model Name": "Air Max",
                "Condition Type": "Used",
                Size: "42",
                Description: "Good condition",
                "LINE Square Price": 1290,
                "IG Price": 1390,
              },
            },
          ],
        }),
      );

    const result = await findRunnableRunForDate(fetcher, config, "token", "2026-09-01");
    expect(result).not.toBeNull();
    expect(result?.products).toHaveLength(1);
    expect(result?.products[0]).toMatchObject({
      airtableRecordId: "recProd1",
      productId: "A-1001",
      orderedImageKeys: ["assets/a.jpg"],
      brandName: "Nike",
      lineSquarePrice: 1290,
      igPrice: 1390,
    });
    const firstCallUrl = String(fetcher.mock.calls[0]![0]);
    expect(firstCallUrl).toContain("tblRuns");
    expect(firstCallUrl).toContain(encodeURIComponent("2026-09-01"));
  });

  it("rejects a malformed Airtable attachment before it becomes an R2 key", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        records: [{
          id: "recRun1",
          fields: {
            "Publication Date": "2026-09-01",
            Status: "Ready",
            Products: ["recProd1"],
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        records: [{
          id: "recProd1",
          fields: {
            "Product ID": "A-1001",
            "Product Images": [{
              id: "att1",
              url: "https://dl.airtable.com/image.jpg",
              filename: "../outside.jpg",
            }],
          },
        }],
      }));

    await expect(
      findRunnableRunForDate(fetcher, config, "token", "2026-09-01"),
    ).rejects.toThrow(/invalid attachment filename/i);
  });

  it("rejects a products response that omits a linked product", async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(jsonResponse({
        records: [{
          id: "recRun1",
          fields: {
            "Publication Date": "2026-09-01",
            Status: "Ready",
            Products: ["recProd1", "recProd2"],
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        records: [productRecord("recProd1", "A-1001")],
      }));

    await expect(
      findRunnableRunForDate(fetcher, config, "token", "2026-09-01"),
    ).rejects.toMatchObject({
      code: "airtable_linked_products_mismatch",
      retryable: false,
    });
  });

  it.each([
    ["returns an unexpected product", [productRecord("recProd1", "A-1001"), productRecord("recOther", "A-9999")]],
    ["returns the same product twice", [productRecord("recProd1", "A-1001"), productRecord("recProd1", "A-1001")]],
  ])("rejects a products response that %s", async (_description, records) => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(jsonResponse({
        records: [{
          id: "recRun1",
          fields: {
            "Publication Date": "2026-09-01",
            Status: "Ready",
            Products: ["recProd1", "recProd2"],
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({ records }));

    await expect(
      findRunnableRunForDate(fetcher, config, "token", "2026-09-01"),
    ).rejects.toMatchObject({
      code: "airtable_linked_products_mismatch",
      retryable: false,
    });
  });

  it("preserves linked-field order when Airtable returns products in another order", async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(jsonResponse({
        records: [{
          id: "recRun1",
          fields: {
            "Publication Date": "2026-09-01",
            Status: "Ready",
            Products: ["recProd2", "recProd1"],
          },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        records: [productRecord("recProd1", "A-1001"), productRecord("recProd2", "A-1002")],
      }));

    const result = await findRunnableRunForDate(fetcher, config, "token", "2026-09-01");

    expect(result?.products.map((product) => product.airtableRecordId)).toEqual([
      "recProd2",
      "recProd1",
    ]);
  });

  it.each([
    [429, true],
    [422, false],
  ])(
    "classifies Airtable status %i with retryable=%s",
    async (status, retryable) => {
      const fetcher = vi.fn<Fetcher>().mockResolvedValue(
        jsonResponse({}, status),
      );

      await expect(
        findRunnableRunForDate(
          fetcher,
          config,
          "token",
          "2026-09-01",
        ),
      ).rejects.toMatchObject({
        code: "airtable_runs_fetch_failed",
        retryable,
      });
    },
  );
});

describe("status writes", () => {
  it("markRunGenerating PATCHes Status to Generating", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ id: "recRun1" }));
    await markRunGenerating(fetcher, config, "token", "recRun1");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain("recRun1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body)).fields.Status).toBe("Generating");
  });

  it("markRunGenerated writes doc URL, timestamp, and Generated status", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ id: "recRun1" }));
    await markRunGenerated(fetcher, config, "token", "recRun1", "https://docs.google.com/x", "2026-09-01T06:00:00.000Z");
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(body.fields.Status).toBe("Generated");
    expect(body.fields["Google Doc URL"]).toBe("https://docs.google.com/x");
    expect(body.fields["Generated At"]).toBe("2026-09-01T06:00:00.000Z");
  });

  it("markRunNeedsCorrection returns Status to Draft with Error Summary", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ id: "recRun1" }));
    await markRunNeedsCorrection(fetcher, config, "token", "recRun1", "A-1001: missing Description");
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(body.fields.Status).toBe("Draft");
    expect(body.fields["Error Summary"]).toBe("A-1001: missing Description");
  });
});

describe("updateProductCollage", () => {
  it("PATCHes the 4-in-1 Image attachment field with the signed URL", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ id: "recProd1" }));
    await updateProductCollage(fetcher, config, "token", "recProd1", "https://r2.example.com/signed");
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(body.fields["4-in-1 Image"]).toEqual([{ url: "https://r2.example.com/signed" }]);
  });
});
