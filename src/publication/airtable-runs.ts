import { z } from "zod";
import type { AppConfig } from "../config";
import { OperationalError } from "../shared/errors";
import type { Fetcher } from "../shared/http";
import type { PublicationProduct, PublicationRun } from "./types";

export type AirtablePublicationConfig = Pick<
  AppConfig,
  | "airtableBaseId"
  | "airtableProductsTableId"
  | "airtablePublicationRunsTableId"
>;

function airtableUrl(
  config: AirtablePublicationConfig,
  tableId: string,
  path = "",
): string {
  return `https://api.airtable.com/v0/${config.airtableBaseId}/${tableId}${path}`;
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function airtableHttpError(
  code: string,
  action: string,
  status: number,
): OperationalError {
  return new OperationalError(
    code,
    `Airtable ${action} failed with status ${status}`,
    status === 429 || status >= 500,
  );
}

const AirtableRunRecordSchema = z.object({
  id: z.string().min(1),
  fields: z.object({
    "Publication Date": z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    Status: z.enum(["Draft", "Ready", "Generating", "Generated", "Failed"]),
    Products: z.array(z.string().min(1)).optional(),
  }),
});

const AirtableProductRecordSchema = z.object({
  id: z.string().min(1),
  fields: z.object({
    "Product ID": z.string().regex(/^A-\d+$/),
    "Product Images": z.array(z.object({
      id: z.string().min(1),
      url: z.string().url(),
      filename: z.string().min(1),
    })).optional(),
    "Brand Name": z.string().optional(),
    "Model Name": z.string().optional(),
    "Condition Type": z.string().optional(),
    Size: z.string().optional(),
    Description: z.string().optional(),
    "LINE Square Price": z.number().optional(),
    "IG Price": z.number().optional(),
  }),
});

function attachmentR2Key(filename: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
    throw new Error("Airtable Product Images contains an invalid attachment filename");
  }
  return `assets/${filename}`;
}

async function fetchLinkedProducts(
  fetcher: Fetcher,
  config: AirtablePublicationConfig,
  token: string,
  recordIds: string[],
): Promise<PublicationProduct[]> {
  if (recordIds.length === 0) return [];
  const formula = `OR(${recordIds.map((id) => `RECORD_ID()='${id}'`).join(",")})`;
  const url = `${airtableUrl(config, config.airtableProductsTableId)}?filterByFormula=${encodeURIComponent(formula)}`;
  const response = await fetcher(url, { headers: authHeaders(token) });
  if (!response.ok) {
    throw airtableHttpError(
      "airtable_products_fetch_failed",
      "products fetch",
      response.status,
    );
  }
  const body = z.object({
    records: z.array(AirtableProductRecordSchema),
  }).parse(await response.json());
  const productsByRecordId = new Map(body.records.map((record) => [record.id, record]));
  if (
    productsByRecordId.size !== recordIds.length
    || body.records.length !== recordIds.length
    || recordIds.some((recordId) => !productsByRecordId.has(recordId))
  ) {
    throw new OperationalError(
      "airtable_linked_products_mismatch",
      "Airtable linked products response did not match requested records",
      false,
    );
  }
  return recordIds.map((recordId) => {
    const record = productsByRecordId.get(recordId)!;
    return {
      airtableRecordId: record.id,
      productId: record.fields["Product ID"],
      orderedImageKeys: (record.fields["Product Images"] ?? []).map((image) =>
        attachmentR2Key(image.filename),
      ),
      brandName: record.fields["Brand Name"] ?? "",
      modelName: record.fields["Model Name"] ?? "",
      conditionType: record.fields["Condition Type"] ?? "",
      size: record.fields.Size ?? "",
      description: record.fields.Description ?? "",
      lineSquarePrice: record.fields["LINE Square Price"] ?? 0,
      igPrice: record.fields["IG Price"] ?? 0,
    };
  });
}

export async function findRunnableRunForDate(
  fetcher: Fetcher,
  config: AirtablePublicationConfig,
  token: string,
  isoDate: string,
): Promise<PublicationRun | null> {
  const formula = `AND({Publication Date}='${isoDate}',OR({Status}='Ready',{Status}='Failed'))`;
  const url = `${airtableUrl(config, config.airtablePublicationRunsTableId)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const response = await fetcher(url, { headers: authHeaders(token) });
  if (!response.ok) {
    throw airtableHttpError(
      "airtable_runs_fetch_failed",
      "runs fetch",
      response.status,
    );
  }
  const body = z.object({
    records: z.array(AirtableRunRecordSchema),
  }).parse(await response.json());
  const record = body.records[0];
  if (!record) return null;

  const products = await fetchLinkedProducts(fetcher, config, token, record.fields.Products ?? []);
  return {
    airtableRunId: record.id,
    publicationDate: record.fields["Publication Date"],
    status: record.fields.Status,
    products,
  };
}

export async function loadRunById(
  fetcher: Fetcher,
  config: AirtablePublicationConfig,
  token: string,
  airtableRunId: string,
): Promise<PublicationRun> {
  const url = airtableUrl(config, config.airtablePublicationRunsTableId, `/${airtableRunId}`);
  const response = await fetcher(url, { headers: authHeaders(token) });
  if (!response.ok) {
    throw airtableHttpError(
      "airtable_run_fetch_failed",
      "run fetch",
      response.status,
    );
  }
  const body = AirtableRunRecordSchema.parse(await response.json());
  const products = await fetchLinkedProducts(fetcher, config, token, body.fields.Products ?? []);
  return {
    airtableRunId: body.id,
    publicationDate: body.fields["Publication Date"],
    status: body.fields.Status,
    products,
  };
}

async function patchRun(
  fetcher: Fetcher,
  config: AirtablePublicationConfig,
  token: string,
  airtableRunId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const url = airtableUrl(config, config.airtablePublicationRunsTableId, `/${airtableRunId}`);
  const response = await fetcher(url, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) {
    throw airtableHttpError(
      "airtable_run_update_failed",
      "run update",
      response.status,
    );
  }
}

export async function markRunGenerating(fetcher: Fetcher, config: AirtablePublicationConfig, token: string, airtableRunId: string): Promise<void> {
  await patchRun(fetcher, config, token, airtableRunId, { Status: "Generating" });
}

export async function markRunGenerated(
  fetcher: Fetcher,
  config: AirtablePublicationConfig,
  token: string,
  airtableRunId: string,
  googleDocUrl: string,
  generatedAtIso: string,
): Promise<void> {
  await patchRun(fetcher, config, token, airtableRunId, {
    Status: "Generated",
    "Google Doc URL": googleDocUrl,
    "Generated At": generatedAtIso,
  });
}

export async function markRunNeedsCorrection(
  fetcher: Fetcher,
  config: AirtablePublicationConfig,
  token: string,
  airtableRunId: string,
  errorSummary: string,
): Promise<void> {
  await patchRun(fetcher, config, token, airtableRunId, { Status: "Draft", "Error Summary": errorSummary });
}

export async function markRunFailed(
  fetcher: Fetcher,
  config: AirtablePublicationConfig,
  token: string,
  airtableRunId: string,
  errorSummary: string,
): Promise<void> {
  await patchRun(fetcher, config, token, airtableRunId, { Status: "Failed", "Error Summary": errorSummary });
}

export async function updateProductCollage(
  fetcher: Fetcher,
  config: AirtablePublicationConfig,
  token: string,
  airtableRecordId: string,
  signedCollageUrl: string,
): Promise<void> {
  const url = airtableUrl(config, config.airtableProductsTableId, `/${airtableRecordId}`);
  const response = await fetcher(url, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify({ fields: { "4-in-1 Image": [{ url: signedCollageUrl }] } }),
  });
  if (!response.ok) {
    throw airtableHttpError(
      "airtable_product_collage_update_failed",
      "product collage update",
      response.status,
    );
  }
}
