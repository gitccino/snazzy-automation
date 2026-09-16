import { describe, expect, it } from "vitest";
import {
  buildPublicationSuccessMessage,
  buildPublicationValidationFailureMessage,
  buildPublicationWorkflowFailureMessage,
} from "../../src/line/messages";

describe("buildPublicationSuccessMessage", () => {
  it("includes date, action, count, Product IDs, and the Google Doc link", () => {
    const message = buildPublicationSuccessMessage({
      thaiDate: "1 กันยายน 2569",
      productIds: ["A-1001", "A-1002"],
      googleDocUrl: "https://docs.google.com/document/d/doc-1/edit",
    });
    expect(message).toContain("1 กันยายน 2569");
    expect(message).toContain("2");
    expect(message).toContain("A-1001");
    expect(message).toContain("A-1002");
    expect(message).toContain("https://docs.google.com/document/d/doc-1/edit");
  });
});

describe("buildPublicationValidationFailureMessage", () => {
  it("groups missing fields by Product ID and includes the Airtable link and retry hint", () => {
    const message = buildPublicationValidationFailureMessage({
      thaiDate: "1 กันยายน 2569",
      validation: {
        valid: false,
        productsMissingFields: [{ productId: "A-1001", missingFields: ["Brand Name", "Description"] }],
      },
      airtableRunUrl: "https://airtable.com/base/tbl/rec1",
    });
    expect(message).toContain("A-1001");
    expect(message).toContain("Brand Name, Description");
    expect(message).toContain("https://airtable.com/base/tbl/rec1");
    expect(message).toContain("/docs");
  });

  it("never includes signed URLs, tokens, or raw stack traces", () => {
    const message = buildPublicationValidationFailureMessage({
      thaiDate: "1 กันยายน 2569",
      validation: { valid: false, productsMissingFields: [{ productId: "A-1001", missingFields: ["Description"] }] },
      airtableRunUrl: "https://airtable.com/base/tbl/rec1",
    });
    expect(message).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
    expect(message).not.toContain("signature=");
  });
});

describe("buildPublicationWorkflowFailureMessage", () => {
  it("includes action, human-readable reason, Airtable link, and a safe retry command", () => {
    const message = buildPublicationWorkflowFailureMessage({
      thaiDate: "1 กันยายน 2569",
      reason: "Google Docs API returned a persistent error",
      airtableRunUrl: "https://airtable.com/base/tbl/rec1",
    });
    expect(message).toContain("Google Docs API returned a persistent error");
    expect(message).toContain("https://airtable.com/base/tbl/rec1");
    expect(message).toContain("/docs");
  });
});
