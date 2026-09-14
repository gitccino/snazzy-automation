import { describe, expect, it } from "vitest";
import {
  createMarkerDetector,
  isMarkerImage,
  MARKER_PAYLOAD,
  type MarkerImagesBinding,
  type MarkerImageTransformer,
} from "../../src/import/marker";
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

describe("createMarkerDetector", () => {
  it("normalizes source bytes through Cloudflare Images before QR detection", async () => {
    const calls: Array<{ op: string; value: unknown }> = [];
    const normalized = markerCleanJpegBytes();
    let transformer: MarkerImageTransformer;
    transformer = {
      transform(options) {
        calls.push({ op: "transform", value: options });
        return transformer;
      },
      async output(options) {
        calls.push({ op: "output", value: options });
        return {
          response: () => new Response(normalized),
        };
      },
    };
    const images: MarkerImagesBinding = {
      input(value) {
        calls.push({ op: "input", value });
        return transformer;
      },
    };
    const sourceBytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);

    await expect(
      createMarkerDetector(images).detect(sourceBytes.slice().buffer),
    ).resolves.toBe(true);

    expect(calls.map(({ op }) => op)).toEqual(["input", "transform", "output"]);
    const input = calls[0]!.value as ReadableStream<Uint8Array>;
    expect(new Uint8Array(await new Response(input).arrayBuffer())).toEqual(
      sourceBytes,
    );
    expect(calls.slice(1)).toEqual([
      {
        op: "transform",
        value: {
          width: 1024,
          height: 1024,
          fit: "contain",
        },
      },
      { op: "output", value: { format: "image/jpeg" } },
    ]);
  });
});
