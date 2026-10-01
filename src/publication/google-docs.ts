import { z } from "zod";
import { OperationalError } from "../shared/errors";
import type { Fetcher } from "../shared/http";
import type { AccessTokenProvider } from "./google-auth";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DOCS_BASE = "https://docs.googleapis.com/v1";
const DriveFileSchema = z.object({ id: z.string().min(1) });
const DriveFilesSchema = z.object({
  files: z.array(DriveFileSchema).optional(),
  nextPageToken: z.string().min(1).optional(),
});
const PointDimensionSchema = z.object({
  magnitude: z.number().nonnegative().default(0),
  unit: z.literal("PT"),
});
const GoogleDocSchema = z.object({
  documentStyle: z.object({
    pageSize: z.object({ width: PointDimensionSchema }),
    marginLeft: PointDimensionSchema,
    marginRight: PointDimensionSchema,
  }).optional(),
  body: z.object({
    content: z.array(z.object({
      paragraph: z.object({
        elements: z.array(z.object({
          startIndex: z.number().int().nonnegative().optional(),
          textRun: z.object({ content: z.string() }).optional(),
        })),
      }).optional(),
    })),
  }),
});
type GoogleDoc = z.infer<typeof GoogleDocSchema>;

export interface DocProductContent {
  productId: string;
  conditionType: string;
  description: string;
  lineSquarePrice: number;
  igPrice: number;
  captionDrafts: [string, string, string];
  collageImageUrl: string;
}

export type GoogleDocsRequest =
  | { deleteContentRange: { range: { startIndex: number; endIndex: number } } }
  | { insertText: { location: { index: number }; text: string } }
  | { insertPageBreak: { location: { index: number } } }
  | { insertInlineImage: {
    location: { index: number };
    uri: string;
    objectSize: {
      width: { magnitude: number; unit: "PT" };
      height: { magnitude: number; unit: "PT" };
    };
  } }
  | { replaceAllText: { containsText: { text: string; matchCase: boolean }; replaceText: string } };

const DATE_MARKER = "{{PUBLICATION_DATE}}";
const START_MARKER = "{{PRODUCTS}}";
const END_MARKER = "{{END_PRODUCTS}}";

async function request(
  fetcher: Fetcher,
  tokenProvider: AccessTokenProvider,
  url: string | URL,
  action: string,
  init: RequestInit = {},
  allowMissing = false,
): Promise<Response> {
  const token = await tokenProvider.getAccessToken();
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
  } catch {
    throw new OperationalError(
      `google_${action.replaceAll(" ", "_")}_transport_failed`,
      `Google ${action} transport failed`,
      true,
    );
  }
  if (!response.ok && !(allowMissing && response.status === 404)) {
    throw new OperationalError(
      `google_${action.replaceAll(" ", "_")}_failed`,
      `Google ${action} failed with status ${response.status}`,
      response.status === 429 || response.status >= 500,
    );
  }
  return response;
}

async function parseGoogleJson<T>(response: Response, schema: z.ZodType<T>, action: string): Promise<T> {
  try {
    return schema.parse(await response.json());
  } catch {
    throw new Error(`google ${action} returned a malformed response`);
  }
}

export async function findTemporaryDocument(
  fetcher: Fetcher,
  tokenProvider: AccessTokenProvider,
  driveFolderId: string,
  publicationRunId: string,
): Promise<string | null> {
  const url = new URL(`${DRIVE_BASE}/files`);
  const escapeLiteral = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  url.searchParams.set("q", `'${escapeLiteral(driveFolderId)}' in parents and trashed = false and appProperties has { key='publicationRunId' and value='${escapeLiteral(publicationRunId)}' }`);
  url.searchParams.set("fields", "files(id),nextPageToken");
  url.searchParams.set("pageSize", "2");
  let foundId: string | null = null;
  while (true) {
    const response = await request(fetcher, tokenProvider, url.toString(), "drive lookup");
    const body = await parseGoogleJson(response, DriveFilesSchema, "drive lookup");
    for (const file of body.files ?? []) {
      if (foundId !== null) {
        throw new Error("multiple temporary documents found for publication run");
      }
      foundId = file.id;
    }
    if (!body.nextPageToken) return foundId;
    url.searchParams.set("pageToken", body.nextPageToken);
  }
}

export async function copyTemplate(
  fetcher: Fetcher,
  tokenProvider: AccessTokenProvider,
  templateDocId: string,
  driveFolderId: string,
  publicationRunId: string,
  newTitle: string,
): Promise<string> {
  const response = await request(fetcher, tokenProvider, `${DRIVE_BASE}/files/${encodeURIComponent(templateDocId)}/copy`, "drive copy", {
    method: "POST",
    body: JSON.stringify({ name: newTitle, parents: [driveFolderId], appProperties: { publicationRunId } }),
  });
  return (await parseGoogleJson(response, DriveFileSchema, "drive copy")).id;
}

export function buildBatchUpdateRequests(
  publicationDateText: string,
  products: DocProductContent[],
  suffixText: string,
  insertionIndex: number,
  deletionEndIndex: number,
  imageWidth: number,
): GoogleDocsRequest[] {
  if (!Number.isFinite(imageWidth) || imageWidth <= 0) {
    throw new Error("template must have a positive usable page width");
  }
  const location = { index: insertionIndex };
  const requests: GoogleDocsRequest[] = [{
    deleteContentRange: { range: { startIndex: insertionIndex, endIndex: deletionEndIndex } },
  }];
  // Inserting at one location prepends each item, so both products and their parts reverse.
  for (const product of [...products].reverse()) {
    requests.push(
      { insertText: { location, text: `${suffixText}\n\n` } },
      { insertText: { location, text: [
        "", // Keep Product ID on its own line even when template text precedes the image.
        `รหัสสินค้า ${product.productId}`,
        product.conditionType,
        "",
        product.description.split(/\r?\n/)
          .filter(line => !/^\s*(?:ขนาด|ไซส์|อุปกรณ์|สภาพ)\s*[:：]/u.test(line))
          .join("\n").trim(),
        "",
        `Caption 1: ${product.captionDrafts[0]}`,
        `Caption 2: ${product.captionDrafts[1]}`,
        `Caption 3: ${product.captionDrafts[2]}`,
        "",
      ].join("\n") } },
      { insertInlineImage: { location, uri: product.collageImageUrl, objectSize: {
        width: { magnitude: imageWidth, unit: "PT" },
        height: { magnitude: imageWidth, unit: "PT" },
      } } },
      { insertPageBreak: { location } },
    );
  }
  requests.push({ replaceAllText: {
    containsText: { text: DATE_MARKER, matchCase: true },
    replaceText: publicationDateText,
  } });
  return requests;
}

function textRuns(doc: GoogleDoc) {
  return doc.body.content.flatMap((block) => block.paragraph?.elements ?? [])
    .flatMap((element) => element.textRun ? [{ startIndex: element.startIndex, content: element.textRun.content }] : []);
}

function missingProducts(fullText: string, expectedProductIds: string[]): string[] {
  const lines = new Set(fullText.split(/\r?\n/));
  // Keep completed documents from the previous format verifiable during recovery.
  return expectedProductIds.filter((id) => !lines.has(`รหัสสินค้า ${id}`) && !lines.has(`Product ID: ${id}`));
}

async function getDocument(fetcher: Fetcher, tokenProvider: AccessTokenProvider, docId: string): Promise<GoogleDoc> {
  const response = await request(fetcher, tokenProvider, `${DOCS_BASE}/documents/${encodeURIComponent(docId)}`, "docs get");
  return parseGoogleJson(response, GoogleDocSchema, "docs get");
}

function findTemplateRegion(doc: GoogleDoc) {
  const runs = textRuns(doc);
  const fullText = runs.map((run) => run.content).join("");
  const markerLocation = (marker: string) => {
    let textOffset = 0;
    for (const run of runs) {
      const localOffset = run.content.indexOf(marker);
      if (localOffset !== -1 && run.startIndex !== undefined) {
        // A preceding run may end at a different document index across structural gaps.
        return { index: run.startIndex + localOffset, offset: textOffset + localOffset };
      }
      textOffset += run.content.length;
    }
    throw new Error(`template marker ${marker} must remain inside one text run`);
  };
  markerLocation(DATE_MARKER);
  const start = markerLocation(START_MARKER);
  const end = markerLocation(END_MARKER);
  if (end.offset < start.offset + START_MARKER.length || end.index < start.index + START_MARKER.length) {
    throw new Error("template missing ordered {{PRODUCTS}} / {{END_PRODUCTS}} markers");
  }
  return {
    insertionIndex: start.index,
    deletionEndIndex: end.index + END_MARKER.length,
    suffixText: fullText.slice(start.offset + START_MARKER.length, end.offset),
  };
}

export async function fillTemplate(
  fetcher: Fetcher,
  tokenProvider: AccessTokenProvider,
  docId: string,
  publicationDateText: string,
  products: DocProductContent[],
): Promise<void> {
  const doc = await getDocument(fetcher, tokenProvider, docId);
  const fullText = textRuns(doc).map((run) => run.content).join("");
  if (![DATE_MARKER, START_MARKER, END_MARKER].some((marker) => fullText.includes(marker)) &&
    missingProducts(fullText, products.map((product) => product.productId)).length === 0) {
    return;
  }
  const region = findTemplateRegion(doc);
  const style = doc.documentStyle;
  if (!style) throw new Error("template page size and margins are missing");
  const imageWidth = style.pageSize.width.magnitude - style.marginLeft.magnitude - style.marginRight.magnitude;
  const requests = buildBatchUpdateRequests(publicationDateText, products, region.suffixText, region.insertionIndex, region.deletionEndIndex, imageWidth);
  await request(fetcher, tokenProvider, `${DOCS_BASE}/documents/${encodeURIComponent(docId)}:batchUpdate`, "docs batch update", {
    method: "POST",
    body: JSON.stringify({ requests }),
  });
}

export async function verifyDocumentContainsProducts(
  fetcher: Fetcher,
  tokenProvider: AccessTokenProvider,
  docId: string,
  expectedProductIds: string[],
): Promise<{ ok: true } | { ok: false; missingProductIds: string[] }> {
  const doc = await getDocument(fetcher, tokenProvider, docId);
  const missingProductIds = missingProducts(textRuns(doc).map((run) => run.content).join(""), expectedProductIds);
  return missingProductIds.length ? { ok: false, missingProductIds } : { ok: true };
}

// The publication service verifies expected IDs before calling this final rename.
export async function finalizeDocument(
  fetcher: Fetcher,
  tokenProvider: AccessTokenProvider,
  docId: string,
  finalTitle: string,
): Promise<string> {
  const encodedId = encodeURIComponent(docId);
  await request(fetcher, tokenProvider, `${DRIVE_BASE}/files/${encodedId}`, "drive rename", {
    method: "PATCH",
    body: JSON.stringify({ name: finalTitle }),
  });
  return `https://docs.google.com/document/d/${encodedId}/edit`;
}

export async function deleteDocument(fetcher: Fetcher, tokenProvider: AccessTokenProvider, docId: string): Promise<void> {
  await request(fetcher, tokenProvider, `${DRIVE_BASE}/files/${encodeURIComponent(docId)}`, "drive delete", {
    method: "DELETE",
  }, true);
}
