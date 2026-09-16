import { describe, expect, it } from "vitest";
import { validateRunCompleteness, formatValidationErrorSummary } from "../../src/publication/validator";
import type { PublicationProduct } from "../../src/publication/types";

function product(overrides: Partial<PublicationProduct> = {}): PublicationProduct {
  return {
    airtableRecordId: "rec1",
    productId: "A-1001",
    orderedImageKeys: ["img1", "img2", "img3", "img4"],
    brandName: "Nike",
    modelName: "Air Max",
    conditionType: "Used",
    size: "42",
    description: "Good condition",
    lineSquarePrice: 1290,
    igPrice: 1390,
    ...overrides,
  };
}

describe("validateRunCompleteness", () => {
  it("passes when every product has every required field and at least four images", () => {
    const result = validateRunCompleteness([product()]);
    expect(result).toEqual({ valid: true, productsMissingFields: [] });
  });

  it("flags a product missing text fields by name", () => {
    const result = validateRunCompleteness([product({ brandName: "", description: "" })]);
    expect(result.valid).toBe(false);
    expect(result.productsMissingFields).toEqual([
      { productId: "A-1001", missingFields: ["Brand Name", "Description"] },
    ]);
  });

  it("flags a product with fewer than four ordered images", () => {
    const result = validateRunCompleteness([product({ orderedImageKeys: ["img1", "img2"] })]);
    expect(result.valid).toBe(false);
    expect(result.productsMissingFields).toEqual([
      { productId: "A-1001", missingFields: ["Product Images (needs at least 4)"] },
    ]);
  });

  it("flags zero or negative prices", () => {
    const result = validateRunCompleteness([product({ lineSquarePrice: 0, igPrice: -5 })]);
    expect(result.productsMissingFields).toEqual([
      { productId: "A-1001", missingFields: ["LINE Square Price", "IG Price"] },
    ]);
  });

  it("reports every failing product, not just the first", () => {
    const result = validateRunCompleteness([
      product({ productId: "A-1001", brandName: "" }),
      product({ productId: "A-1002", size: "" }),
    ]);
    expect(result.productsMissingFields.map((p) => p.productId)).toEqual(["A-1001", "A-1002"]);
  });

  it("rejects a run with zero linked products", () => {
    const result = validateRunCompleteness([]);
    expect(result.valid).toBe(false);
    expect(result.productsMissingFields).toEqual([{ productId: "(run)", missingFields: ["No Products linked to this Publication Run"] }]);
  });
});

describe("formatValidationErrorSummary", () => {
  it("groups missing fields by Product ID into one readable summary", () => {
    const summary = formatValidationErrorSummary({
      valid: false,
      productsMissingFields: [
        { productId: "A-1001", missingFields: ["Brand Name", "Description"] },
        { productId: "A-1002", missingFields: ["Size"] },
      ],
    });
    expect(summary).toBe("A-1001: Brand Name, Description\nA-1002: Size");
  });
});
