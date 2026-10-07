import { z } from "zod";
import type { Fetcher } from "../shared/http";
import { OperationalError } from "../shared/errors";
import type { DailySaleProduct, InventoryProduct, SaleValues } from "./types";

export interface InventoryClient {
  listSalesForDay(reportDate: string): Promise<DailySaleProduct[]>;
  findByProductId(productId: string): Promise<InventoryProduct | null>;
  updateSaleValues(recordId: string, values: SaleValues): Promise<void>;
}

const AirtableListSchema = z.object({
  records: z.array(z.object({
    id: z.string().min(1),
    fields: z.record(z.string(), z.unknown()),
  })),
  offset: z.string().optional(),
});

const InventoryFieldsSchema = z.object({
  "Product ID": z.string().regex(/^A-[1-9]\d*$/),
  "Inventory Status": z.enum(["In", "Out"]),
  "Upload Date": z.string().optional(),
  "Sold Price": z.number().int().positive().optional(),
  "Sold At": z.string().optional(),
  "Sold By": z.string().optional(),
});

const DailySaleFieldsSchema = z.object({
  "Product Cost": z.number().nonnegative().refine(value => Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001).nullish(),
  "Product ID": z.string().regex(/^A-[1-9]\d*$/),
  "Inventory Status": z.literal("Out"),
  "Sold Price": z.number().int().positive().refine(Number.isSafeInteger),
  "Sold At": z.iso.datetime({ offset: true }),
});

const SaleValuesSchema = z.object({
  inventoryStatus: z.enum(["In", "Out"]),
  soldPrice: z.number().int().positive().refine(Number.isSafeInteger).nullable(),
  soldAt: z.string().nullable(),
  soldBy: z.string().nullable(),
}).superRefine((values, context) => {
  // In records may contain historical sale fields; revert must restore them exactly.
  const hasSaleDetails = values.soldPrice !== null && Boolean(values.soldAt) && Boolean(values.soldBy);
  if (values.inventoryStatus === "Out" && !hasSaleDetails) {
    context.addIssue({ code: "custom", message: "sale values must match inventory status" });
  }
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

  async function parseList(response: Response): Promise<z.infer<typeof AirtableListSchema>> {
    try {
      const parsed = AirtableListSchema.safeParse(await response.json());
      if (parsed.success) return parsed.data;
    } catch {
      // Normalize malformed JSON from Airtable to the adapter's operational error contract.
    }
    throw new OperationalError("airtable_inventory_invalid_response", "Airtable inventory response validation failed", false);
  }

  return {
    async listSalesForDay(reportDate) {
      const midnight = new Date(`${reportDate}T00:00:00Z`);
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(reportDate) || reportDate.startsWith("0000-")
        || !Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== reportDate) {
        throw new OperationalError("airtable_inventory_report_invalid_date", "Invalid report date", false);
      }
      const start = new Date(`${reportDate}T00:00:00+07:00`);
      const end = new Date(start.getTime() + 86400000);
      const formula = `AND({Inventory Status}="Out",{Sold At}>=DATETIME_PARSE("${start.toISOString()}"),{Sold At}<DATETIME_PARSE("${end.toISOString()}"))`;
      const products: DailySaleProduct[] = [];
      const offsets = new Set<string>();
      const productIds = new Set<string>();
      const recordIds = new Set<string>();
      let offset: string | undefined;
      do {
        const url = new URL(baseUrl);
        url.searchParams.set("filterByFormula", formula);
        url.searchParams.set("pageSize", "100");
        for (const field of ["Product ID", "Inventory Status", "Brand Name", "Model Name", "Sold Price", "Sold At", "Product Cost"]) url.searchParams.append("fields[]", field);
        if (offset) url.searchParams.set("offset", offset);
        let response: Response;
        try { response = await config.fetch(url.toString(), { headers }); }
        catch { throw new OperationalError("airtable_inventory_report_failed", "Airtable daily sales request failed", true); }
        await requireOk(response, "report");
        const body = await parseList(response);
        for (const record of body.records) {
          const parsed = DailySaleFieldsSchema.safeParse(record.fields);
          if (!parsed.success) throw new OperationalError("airtable_inventory_report_invalid_record", "Invalid daily sale record", false);
          const fields = parsed.data;
          const soldAt = new Date(fields["Sold At"]).getTime();
          if (soldAt < start.getTime() || soldAt >= end.getTime() || productIds.has(fields["Product ID"]) || recordIds.has(record.id)) {
            throw new OperationalError("airtable_inventory_report_invalid_record", "Duplicate or out-of-range daily sale", false);
          }
          productIds.add(fields["Product ID"]); recordIds.add(record.id);
          const name = (field: string) => typeof record.fields[field] === "string" ? record.fields[field].trim() || null : null;
          products.push({ productCost: fields["Product Cost"] ?? null, recordId: record.id, productId: fields["Product ID"], soldPrice: fields["Sold Price"], soldAt: fields["Sold At"], brandName: name("Brand Name"), modelName: name("Model Name") });
        }
        offset = body.offset;
        if (offset !== undefined) {
          if (!offset || offsets.has(offset)) throw new OperationalError("airtable_inventory_report_invalid_response", "Repeated or empty daily sales offset", false);
          offsets.add(offset);
        }
      } while (offset !== undefined);
      return products;
    },
    async findByProductId(productId) {
      const url = new URL(baseUrl);
      url.searchParams.set("filterByFormula", `{Product ID} = ${JSON.stringify(productId)}`);
      url.searchParams.set("maxRecords", "2");
      url.searchParams.set("pageSize", "2");

      const response = await config.fetch(url.toString(), { headers });
      await requireOk(response, "find");

      const body = await parseList(response);
      if (body.records.length > 1 || body.offset) {
        throw new OperationalError("airtable_inventory_ambiguous_record", "Airtable inventory lookup returned multiple records", false);
      }
      const record = body.records[0];
      if (!record) return null;
      const parsedFields = InventoryFieldsSchema.safeParse(record.fields);
      if (!parsedFields.success) {
        throw new OperationalError("airtable_inventory_invalid_record", "Airtable inventory record validation failed", false);
      }

      const fields = parsedFields.data;
      if (fields["Product ID"] !== productId) {
        throw new OperationalError("airtable_inventory_invalid_record", "Airtable inventory record product ID did not match lookup", false);
      }
      const image = z.object({ url: z.url().startsWith("https://").max(2000) }).safeParse(
        Array.isArray(record.fields["Product Images"]) ? record.fields["Product Images"][0] : undefined,
      );
      return {
        imageUrl: image.success ? image.data.url : null,
        brandName: typeof record.fields["Brand Name"] === "string" ? record.fields["Brand Name"].trim() || null : null,
        modelName: typeof record.fields["Model Name"] === "string" ? record.fields["Model Name"].trim() || null : null,
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
      if (!SaleValuesSchema.safeParse(values).success) {
        throw new OperationalError("airtable_inventory_invalid_sale_values", "Airtable inventory sale values validation failed", false);
      }
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
