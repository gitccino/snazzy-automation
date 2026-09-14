import { z } from "zod";
import type { Fetcher } from "../env";
import { OperationalError } from "../shared/errors";

const FindResponseSchema = z.object({
  records: z.array(
    z.object({
      id: z.string().min(1),
      fields: z.object({ "Product ID": z.string().min(1) }),
    }),
  ),
});

const CreateResponseSchema = z.object({
  id: z.string().min(1),
});

const VerifyResponseSchema = z.object({
  fields: z.object({
    "Product Images": z.array(z.object({ url: z.string().min(1) })).optional(),
  }),
});

export interface AirtableProductPayload {
  productId: string;
  systemGroupId: string;
  uploadDate: string;
  productImages: Array<{ url: string; filename: string }>;
}

export interface AirtableProductsClient {
  findBySystemGroupId(
    systemGroupId: string,
  ): Promise<{ recordId: string; productId: string } | null>;
  createProduct(payload: AirtableProductPayload): Promise<{ recordId: string }>;
  verifyProduct(recordId: string, expectedImageCount: number): Promise<boolean>;
  deleteProduct(recordId: string): Promise<void>;
}

function baseUrl(baseId: string, tableId: string): string {
  return `https://api.airtable.com/v0/${baseId}/${tableId}`;
}

async function throwOnError(response: Response, action: string): Promise<never> {
  const retryable = response.status === 429 || response.status >= 500;
  const code =
    response.status === 429 ? "airtable_rate_limited" : `airtable_${action}_failed`;
  throw new OperationalError(
    code,
    `Airtable ${action} failed with status ${response.status}`,
    retryable,
  );
}

async function parseAirtableJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  action: string,
): Promise<T> {
  try {
    return schema.parse(await response.json());
  } catch {
    throw new OperationalError(
      `airtable_${action}_invalid_response`,
      `Airtable returned a malformed ${action} response`,
      false,
    );
  }
}

export function createAirtableProductsClient(config: {
  baseId: string;
  tableId: string;
  token: string;
  fetch: Fetcher;
}): AirtableProductsClient {
  const headers = {
    Authorization: `Bearer ${config.token}`,
    "content-type": "application/json",
  };

  return {
    async findBySystemGroupId(systemGroupId) {
      const url = new URL(baseUrl(config.baseId, config.tableId));
      url.searchParams.set(
        "filterByFormula",
        `{System Group ID} = ${JSON.stringify(systemGroupId)}`,
      );
      url.searchParams.set("maxRecords", "1");
      const response = await config.fetch(url.toString(), { headers });
      if (!response.ok) await throwOnError(response, "find");
      const body = await parseAirtableJson(response, FindResponseSchema, "find");
      if (body.records.length === 0) return null;
      const record = body.records[0]!;
      return {
        recordId: record.id,
        productId: record.fields["Product ID"],
      };
    },

    async createProduct(payload) {
      const response = await config.fetch(baseUrl(config.baseId, config.tableId), {
        method: "POST",
        headers,
        body: JSON.stringify({
          fields: {
            "Product ID": payload.productId,
            "System Group ID": payload.systemGroupId,
            "Upload Date": payload.uploadDate,
            "Inventory Status": "In",
            "Product Images": payload.productImages,
          },
        }),
      });
      if (!response.ok) await throwOnError(response, "create");
      const body = await parseAirtableJson(response, CreateResponseSchema, "create");
      return { recordId: body.id };
    },

    async verifyProduct(recordId, expectedImageCount) {
      const response = await config.fetch(
        `${baseUrl(config.baseId, config.tableId)}/${recordId}`,
        { headers },
      );
      if (!response.ok) await throwOnError(response, "verify");
      const body = await parseAirtableJson(response, VerifyResponseSchema, "verify");
      return (body.fields["Product Images"]?.length ?? 0) === expectedImageCount;
    },

    async deleteProduct(recordId) {
      const response = await config.fetch(
        `${baseUrl(config.baseId, config.tableId)}/${recordId}`,
        { method: "DELETE", headers },
      );
      if (!response.ok) await throwOnError(response, "delete");
    },
  };
}
