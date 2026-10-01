import { describe, expect, it, vi } from "vitest";
import { buildBatchUpdateRequests, copyTemplate, deleteDocument, fillTemplate, finalizeDocument, findTemporaryDocument, verifyDocumentContainsProducts } from "../../src/publication/google-docs";
import type { DocProductContent, GoogleDocsRequest } from "../../src/publication/google-docs";
import type { Fetcher } from "../../src/shared/http";

function tokenProvider() {
  return { getAccessToken: vi.fn().mockResolvedValue("access-token-1") };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const product: DocProductContent = {
  productId: "A-1001",
  conditionType: "Used",
  description: "Good condition",
  lineSquarePrice: 1290,
  igPrice: 1390,
  captionDrafts: ["draft1", "draft2", "draft3"],
  collageImageUrl: "https://r2.example.com/signed/A-1001.jpg",
};

function documentWithRuns(runs: { content: string; startIndex?: number }[]) {
  return {
    documentStyle: {
      pageSize: { width: { magnitude: 612, unit: "PT" } },
      marginLeft: { magnitude: 36, unit: "PT" },
      marginRight: { magnitude: 24, unit: "PT" },
    },
    body: { content: [{ paragraph: { elements: runs.map(({ content, startIndex }) => ({ startIndex, textRun: { content } })) } }] },
  };
}

describe("template population", () => {
  it("fills, verifies, and safely retries when template text precedes the marker on its line", async () => {
    let documentText = "{{PUBLICATION_DATE}}\nListings: {{PRODUCTS}}suffix{{END_PRODUCTS}}\nFooter\n";
    let batchCount = 0;
    const fetcher = vi.fn<Fetcher>().mockImplementation(async (url, init) => {
      if (!String(url).endsWith(":batchUpdate")) {
        // Inline images occupy an index but contribute no Google Docs text-run content.
        return jsonResponse(documentWithRuns([{ content: documentText.replaceAll("\ufffc", ""), startIndex: 1 }]));
      }
      batchCount++;
      const { requests } = JSON.parse(String(init?.body)) as { requests: GoogleDocsRequest[] };
      for (const request of requests) {
        if ("deleteContentRange" in request) {
          const { startIndex, endIndex } = request.deleteContentRange.range;
          documentText = documentText.slice(0, startIndex - 1) + documentText.slice(endIndex - 1);
        } else if ("insertText" in request || "insertInlineImage" in request) {
          const insertion = "insertText" in request ? request.insertText : request.insertInlineImage;
          const text = "text" in insertion ? insertion.text : "\ufffc";
          const offset = insertion.location.index - 1;
          documentText = documentText.slice(0, offset) + text + documentText.slice(offset);
        } else if ("insertPageBreak" in request) {
          const offset = request.insertPageBreak.location.index - 1;
          documentText = documentText.slice(0, offset) + "\f\n" + documentText.slice(offset);
        } else {
          documentText = documentText.replaceAll(request.replaceAllText.containsText.text, request.replaceAllText.replaceText);
        }
      }
      return jsonResponse({ documentId: "doc-1" });
    });

    await fillTemplate(fetcher, tokenProvider(), "doc-1", "Today", [product]);
    expect(await verifyDocumentContainsProducts(fetcher, tokenProvider(), "doc-1", [product.productId])).toEqual({ ok: true });
    expect(documentText).toContain("Listings: \f\n\ufffc\nรหัสสินค้า A-1001\nUsed\n\nGood condition\n\n");
    expect(documentText).not.toContain("{{PRODUCTS}}");
    const batch = JSON.parse(String(fetcher.mock.calls[1]![1]?.body)) as { requests: GoogleDocsRequest[] };
    expect(batch.requests.find(request => "insertInlineImage" in request)).toMatchObject({
      insertInlineImage: { objectSize: { width: { magnitude: 552, unit: "PT" }, height: { magnitude: 552, unit: "PT" } } },
    });

    const filledDocument = documentText;
    await expect(fillTemplate(fetcher, tokenProvider(), "doc-1", "Today", [product])).resolves.toBeUndefined();
    expect(documentText).toBe(filledDocument);
    expect(batchCount).toBe(1);
  });

  it("builds one deletion and reverse inserts that render products and suffixes in input order", () => {
    const requests = buildBatchUpdateRequests("1 กันยายน 2569", [product, { ...product, productId: "A-1002" }], "suffix", 32, 63, 552);
    expect(requests[0]).toEqual({ deleteContentRange: { range: { startIndex: 32, endIndex: 63 } } });
    let rendered = "";
    for (const request of requests) {
      if ("insertText" in request) {
        expect(request.insertText.location.index).toBe(32);
        rendered = request.insertText.text + rendered;
      } else if ("insertInlineImage" in request) {
        expect(request.insertInlineImage.location.index).toBe(32);
        expect(request.insertInlineImage.uri).toBe(product.collageImageUrl);
        expect(request.insertInlineImage.objectSize).toEqual({ width: { magnitude: 552, unit: "PT" }, height: { magnitude: 552, unit: "PT" } });
        rendered = "[image]" + rendered;
      } else if ("insertPageBreak" in request) {
        expect(request.insertPageBreak.location.index).toBe(32);
        rendered = "[page break]\n" + rendered;
      }
    }
    expect(rendered).toBe("[page break]\n[image]\nรหัสสินค้า A-1001\nUsed\n\nGood condition\n\nCaption 1: draft1\nCaption 2: draft2\nCaption 3: draft3\nsuffix\n\n[page break]\n[image]\nรหัสสินค้า A-1002\nUsed\n\nGood condition\n\nCaption 1: draft1\nCaption 2: draft2\nCaption 3: draft3\nsuffix\n\n");
    expect(requests.at(-1)).toEqual({ replaceAllText: { containsText: { text: "{{PUBLICATION_DATE}}", matchCase: true }, replaceText: "1 กันยายน 2569" } });
  });

  it("uses the marker's own run index when the preceding run ends before a structural gap", async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(jsonResponse(documentWithRuns([
        { content: "{{PUBLICATION_DATE}}\n", startIndex: 1 },
        { content: "{{PRODUCTS}}\n suffix \n", startIndex: 40 },
        { content: "{{END_PRODUCTS}}\nFooter", startIndex: 70 },
      ])))
      .mockResolvedValueOnce(jsonResponse({ documentId: "doc-1" }));
    await fillTemplate(fetcher, tokenProvider(), "doc-1", "Today", [product]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe("https://docs.googleapis.com/v1/documents/doc-1:batchUpdate");
    expect(init?.method).toBe("POST");
    const { requests } = JSON.parse(String(init?.body)) as { requests: GoogleDocsRequest[] };
    expect(requests[0]).toEqual({ deleteContentRange: { range: { startIndex: 40, endIndex: 86 } } });
    expect(requests).toContainEqual({ insertText: { location: { index: 40 }, text: "\n suffix \n\n\n" } });
  });

  it("rejects split markers before changing the document", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse(documentWithRuns([
      { content: "{{PUBLICATION_DATE}}", startIndex: 1 },
      { content: "{{PRO", startIndex: 21 },
      { content: "DUCTS}}suffix{{END_PRODUCTS}}", startIndex: 26 },
    ])));
    await expect(fillTemplate(fetcher, tokenProvider(), "doc-1", "Today", [product])).rejects.toThrow(/must remain inside one text run/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not refill a completed document after a lost batch response", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse(documentWithRuns([{ content: "Product ID: A-1001\n" }])));
    await fillTemplate(fetcher, tokenProvider(), "doc-1", "Today", [product]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not mistake a longer ID for an already completed product", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse(documentWithRuns([{ content: "Product ID: A-10010\n" }])));
    await expect(fillTemplate(fetcher, tokenProvider(), "doc-1", "Today", [product])).rejects.toThrow(/template marker/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("product verification", () => {
  it("matches exact Product ID lines even when a line spans text runs", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse(documentWithRuns([{ content: "Product ID: A-" }, { content: "1001\nProduct ID: A-1002" }])));
    expect(await verifyDocumentContainsProducts(fetcher, tokenProvider(), "doc-1", ["A-1001", "A-1002"])).toEqual({ ok: true });
  });

  it("reports IDs absent as complete lines, rejecting prefix and prose matches", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse(documentWithRuns([{ content: "Product ID: A-10010\nDescription: Product ID: A-1002\nProduct ID: A-1003 extra\nProduct ID: A-1004\n" }])));
    expect(await verifyDocumentContainsProducts(fetcher, tokenProvider(), "doc-1", ["A-1001", "A-1002", "A-1003", "A-1004"])).toEqual({ ok: false, missingProductIds: ["A-1001", "A-1002", "A-1003"] });
  });
});

describe("temporary document discovery and copy", () => {
  it("returns null when no temporary copy exists", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ files: [] }));
    expect(await findTemporaryDocument(fetcher, tokenProvider(), "folder-1", "run-1")).toBeNull();
  });

  it("checks subsequent result pages before selecting a recovery document", async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(jsonResponse({ files: [{ id: "copy-1" }], nextPageToken: "page-2" }))
      .mockResolvedValueOnce(jsonResponse({ files: [{ id: "copy-2" }] }));
    await expect(findTemporaryDocument(fetcher, tokenProvider(), "folder-1", "run-1")).rejects.toThrow(/multiple temporary documents/);
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get("pageToken")).toBe("page-2");
    for (const [url] of fetcher.mock.calls) {
      expect(new URL(String(url)).searchParams.has("supportsAllDrives")).toBe(false);
      expect(new URL(String(url)).searchParams.has("includeItemsFromAllDrives")).toBe(false);
    }
  });

  it("escapes literal query values", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ files: [] }));
    await findTemporaryDocument(fetcher, tokenProvider(), "folder'1", "run\\1'");
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get("q")).toBe("'folder\\'1' in parents and trashed = false and appProperties has { key='publicationRunId' and value='run\\\\1\\'' }");
  });

  it("rejects a malformed successful copy response", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ id: 42, secret: "upstream-secret" }));
    await expect(copyTemplate(fetcher, tokenProvider(), "template-1", "folder-1", "run-1", "In progress")).rejects.toThrow("google drive copy returned a malformed response");
  });
  it("finds a single copy by folder and private run property", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ files: [{ id: "copy-1" }] }));
    expect(await findTemporaryDocument(fetcher, tokenProvider(), "folder-1", "run-1")).toBe("copy-1");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(url)).searchParams.get("q")).toBe("'folder-1' in parents and trashed = false and appProperties has { key='publicationRunId' and value='run-1' }");
    expect(new URL(String(url)).searchParams.has("supportsAllDrives")).toBe(false);
    expect(new URL(String(url)).searchParams.has("includeItemsFromAllDrives")).toBe(false);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access-token-1");
  });

  it("copies the template into the folder with a recovery tag", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ id: "copy-1" }));
    expect(await copyTemplate(fetcher, tokenProvider(), "template-1", "folder-1", "run-1", "In progress")).toBe("copy-1");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://www.googleapis.com/drive/v3/files/template-1/copy");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "In progress", parents: ["folder-1"], appProperties: { publicationRunId: "run-1" } });
  });
});

describe("finalize and cleanup", () => {
  it("renames the verified document and returns its canonical edit URL", async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ id: "doc-1" }));
    expect(await finalizeDocument(fetcher, tokenProvider(), "doc-1", "Publication today")).toBe("https://docs.google.com/document/d/doc-1/edit");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://www.googleapis.com/drive/v3/files/doc-1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Publication today" });
  });

  it.each([204, 404])("treats deletion status %i as successful cleanup", async (status) => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(new Response(null, { status }));
    await deleteDocument(fetcher, tokenProvider(), "doc-1");
    expect(fetcher.mock.calls[0]![1]?.method).toBe("DELETE");
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://www.googleapis.com/drive/v3/files/doc-1");
  });
});

describe("safe Google failures", () => {
  it.each([[429, true], [503, true], [403, false]])("classifies rename status %i as retryable=%s", async (status, retryable) => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(jsonResponse({ secret: "upstream-secret" }, status as number));
    await expect(finalizeDocument(fetcher, tokenProvider(), "doc-1", "Today")).rejects.toMatchObject({ code: "google_drive_rename_failed", retryable });
  });

  const operations = [
    ["drive_lookup", (fetcher: Fetcher) => findTemporaryDocument(fetcher, tokenProvider(), "folder-1", "run-1")],
    ["drive_copy", (fetcher: Fetcher) => copyTemplate(fetcher, tokenProvider(), "template-1", "folder-1", "run-1", "Today")],
    ["docs_get", (fetcher: Fetcher) => fillTemplate(fetcher, tokenProvider(), "doc-1", "Today", [product])],
    ["docs_get", (fetcher: Fetcher) => verifyDocumentContainsProducts(fetcher, tokenProvider(), "doc-1", ["A-1001"])],
    ["drive_rename", (fetcher: Fetcher) => finalizeDocument(fetcher, tokenProvider(), "doc-1", "Today")],
    ["drive_delete", (fetcher: Fetcher) => deleteDocument(fetcher, tokenProvider(), "doc-1")],
  ] as const;

  it.each(operations)("sanitizes %s fetch rejections without retaining their cause", async (action, operation) => {
    const fetcher = vi.fn<Fetcher>().mockRejectedValue(new Error("access-token-1 upstream-secret signed-url"));
    const error = await operation(fetcher).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: `google_${action}_transport_failed`, retryable: true });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toMatch(/access-token-1|upstream-secret|signed-url/);
  });

  it("sanitizes a batch transport failure after reading the template", async () => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(jsonResponse(documentWithRuns([{ content: "{{PUBLICATION_DATE}}\n{{PRODUCTS}}suffix{{END_PRODUCTS}}\n", startIndex: 1 }])))
      .mockRejectedValueOnce(new Error("secret body and signed-url"));
    const error = await fillTemplate(fetcher, tokenProvider(), "doc-1", "Today", [product]).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "google_docs_batch_update_transport_failed", retryable: true });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("secret");
  });
});
