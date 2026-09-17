import { z } from "zod";
import type { Fetcher } from "../shared/http";
import { OperationalError } from "../shared/errors";
import type { InventoryProduct, SaleValues } from "./types";

export interface InventoryClient {
  findByProductId(productId: string): Promise<InventoryProduct | null>;
  updateSaleValues(recordId: string, values: SaleValues): Promise<void>;
}

const AirtableListSchema = z.object({
  records: z.array(z.object({
    id: z.string().min(1),
    fields: z.record(z.string(), z.unknown()),
  })),
});

const InventoryFieldsSchema = z.object({
  "Product ID": z.string().regex(/^A-[1-9]\d*$/),
  "Inventory Status": z.enum(["In", "Out"]),
  "Upload Date": z.string().optional(),
  "Sold Price": z.number().int().positive().optional(),
  "Sold At": z.string().optional(),
  "Sold By": z.string().optional(),
});

export function matchesSaleValues(actual: SaleValues, expected: SaleValues): boolean {
  return actual.inventoryStatus === expected.inventoryStatus
    && actual.soldPrice === expected.soldPrice
    && actual.soldAt === expected.soldAt
    && actual.soldBy === expected.soldBy;
}

export function createInventoryClient(config: {
  baseId: string;
  tableId: string;
  token: string;
  fetch: Fetcher;
  now?: () => Date;
}): InventoryClient {
  const baseUrl = `https://api.airtable.com/v0/${config.baseId}/${config.tableId}`;
  const headers = { Authorization: `Bearer ${config.token}`, "content-type": "application/json" };
  const now = config.now ?? (() => new Date());

  async function requireOk(response: Response, action: string): Promise<void> {
    if (!response.ok) {
      throw new OperationalError(
        `airtable_inventory_${action}_failed`,
        `Airtable inventory ${action} failed with status ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
  }

  return {
    async findByProductId(productId) {
      const url = new URL(baseUrl);
      url.searchParams.set("filterByFormula", `{Product ID} = '${productId}'`);
      url.searchParams.set("maxRecords", "1");

      const response = await config.fetch(url.toString(), { headers });
      await requireOk(response, "find");

      const parsedBody = AirtableListSchema.safeParse(await response.json());
      if (!parsedBody.success) {
        throw new OperationalError("airtable_inventory_invalid_response", "Airtable inventory response validation failed", false);
      }
      const record = parsedBody.data.records[0];
      if (!record) return null;
      const parsedFields = InventoryFieldsSchema.safeParse(record.fields);
      if (!parsedFields.success) {
        throw new OperationalError("airtable_inventory_invalid_record", "Airtable inventory record validation failed", false);
      }

      const fields = parsedFields.data;
      return {
        recordId: record.id,
        productId: fields["Product ID"],
        uploadDate: fields["Upload Date"] ?? null,
        inventoryStatus: fields["Inventory Status"],
        soldPrice: fields["Sold Price"] ?? null,
        soldAt: fields["Sold At"] ?? null,
        soldBy: fields["Sold By"] ?? null,
        airtableUrl: `https://airtable.com/${config.baseId}/${config.tableId}/${record.id}`,
      };
    },
    async updateSaleValues(recordId, values) {
      const response = await config.fetch(`${baseUrl}/${recordId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          fields: {
            "Inventory Status": values.inventoryStatus,
            "Sold Price": values.soldPrice,
            "Sold At": values.soldAt,
            "Sold By": values.soldBy,
            "Last System Update": now().toISOString(),
          },
        }),
      });
      await requireOk(response, "update");
    },
  };
}
