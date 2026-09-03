import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";

describe("parseConfig", () => {
  it("parses the approved uppercase JSON contract into camel-case runtime fields", () => {
    const config = parseConfig(JSON.stringify({
      TIME_ZONE: "Asia/Bangkok",
      UPLOAD_CUTOFF_MINUTES: 30,
      PRODUCT_ID_PREFIX: "A",
    }));
    expect(config).toEqual({
      timeZone: "Asia/Bangkok",
      uploadCutoffMinutes: 30,
      productIdPrefix: "A",
    });
  });

  it("rejects invalid JSON", () => {
    expect(() => parseConfig("not-json")).toThrow();
  });

  it("rejects a non-positive upload cutoff", () => {
    expect(() => parseConfig({
      TIME_ZONE: "Asia/Bangkok",
      UPLOAD_CUTOFF_MINUTES: 0,
      PRODUCT_ID_PREFIX: "A",
    })).toThrow();
  });

  it("rejects an empty Product ID prefix", () => {
    expect(() => parseConfig({
      TIME_ZONE: "Asia/Bangkok",
      UPLOAD_CUTOFF_MINUTES: 30,
      PRODUCT_ID_PREFIX: "",
    })).toThrow();
  });
});
