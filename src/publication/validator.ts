import type { PublicationProduct } from "./types";

export interface ProductMissingFields {
  productId: string;
  missingFields: string[];
}

export interface ValidationResult {
  valid: boolean;
  productsMissingFields: ProductMissingFields[];
}

const REQUIRED_TEXT_FIELDS: Array<{ key: keyof PublicationProduct; label: string }> = [
  { key: "brandName", label: "Brand Name" },
  { key: "modelName", label: "Model Name" },
  { key: "conditionType", label: "Condition Type" },
  { key: "size", label: "Size" },
  { key: "description", label: "Description" },
];

const MIN_COLLAGE_IMAGES = 4;

export function validateRunCompleteness(products: PublicationProduct[]): ValidationResult {
  if (products.length === 0) {
    return {
      valid: false,
      productsMissingFields: [{ productId: "(run)", missingFields: ["No Products linked to this Publication Run"] }],
    };
  }

  const productsMissingFields: ProductMissingFields[] = [];

  for (const product of products) {
    const missingFields: string[] = [];

    for (const field of REQUIRED_TEXT_FIELDS) {
      const value = product[field.key];
      if (typeof value !== "string" || value.trim().length === 0) {
        missingFields.push(field.label);
      }
    }

    if (product.orderedImageKeys.length < MIN_COLLAGE_IMAGES) {
      missingFields.push(`Product Images (needs at least ${MIN_COLLAGE_IMAGES})`);
    }

    if (!(product.lineSquarePrice > 0)) {
      missingFields.push("LINE Square Price");
    }

    if (!(product.igPrice > 0)) {
      missingFields.push("IG Price");
    }

    if (missingFields.length > 0) {
      productsMissingFields.push({ productId: product.productId, missingFields });
    }
  }

  return { valid: productsMissingFields.length === 0, productsMissingFields };
}

export function formatValidationErrorSummary(result: ValidationResult): string {
  return result.productsMissingFields.map((p) => `${p.productId}: ${p.missingFields.join(", ")}`).join("\n");
}
