import { describe, expect, it } from "vitest";
import { isMarkerImage, MARKER_PAYLOAD } from "../../src/import/marker";
import {
  markerCleanJpegBytes,
  nonMarkerJpegBytes,
  wrongPayloadJpegBytes,
} from "../helpers/marker-fixtures";

describe("MARKER_PAYLOAD", () => {
  it("is the exact spec constant", () => {
    expect(MARKER_PAYLOAD).toBe("SNAZZY_PRODUCT_START_V1");
  });
});

describe("isMarkerImage", () => {
  it("detects a clean, well-lit marker card", () => {
    expect(isMarkerImage(markerCleanJpegBytes())).toBe(true);
  });

  it("returns false for a photo with no QR code", () => {
    expect(isMarkerImage(nonMarkerJpegBytes())).toBe(false);
  });

  it("returns false for a QR code with a different payload", () => {
    expect(isMarkerImage(wrongPayloadJpegBytes())).toBe(false);
  });
});
