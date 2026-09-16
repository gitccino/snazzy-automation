import { describe, expect, it } from "vitest";
import {
  generateCollage,
  collageR2Key,
  COLLAGE_BASE_R2_KEY,
  COLLAGE_CELL_SIZE,
  COLLAGE_CELL_POSITIONS,
} from "../../src/publication/collage";
import type { ImagesBinding, ImageTransformer } from "../../src/publication/collage";

type OfficialImagesBindingSatisfiesCollagePort = globalThis.ImagesBinding extends ImagesBinding ? true : false;

// This assignment is compile-time coverage: generateCollage must accept the
// official Worker binding directly, without an adapter or a cast.
const officialImagesBindingSatisfiesCollagePort: OfficialImagesBindingSatisfiesCollagePort = true;

type ImageCall =
  | {
      op: "transform";
      options: Parameters<ImageTransformer["transform"]>[0];
    }
  | {
      op: "draw";
      options: Parameters<ImageTransformer["draw"]>[1];
    }
  | {
      op: "output";
      options: Parameters<ImageTransformer["output"]>[0];
    };

function fakeTransformer(calls: ImageCall[], response = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } })): ImageTransformer {
  const transformer: ImageTransformer = {
    transform(options) {
      calls.push({ op: "transform", options });
      return transformer;
    },
    draw(_overlay, options) {
      calls.push({ op: "draw", options });
      return transformer;
    },
    async output(options) {
      calls.push({ op: "output", options });
      return {
        response,
      };
    },
  };
  return transformer;
}

function fakeBucket(keys: string[]): R2Bucket {
  return {
    async get(key: string) {
      if (!keys.includes(key)) return null;
      return {
        body: new ReadableStream(),
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

describe("collageR2Key", () => {
  it("builds the deterministic per-product collage key", () => {
    expect(collageR2Key("A-1001")).toBe("products/A-1001/collage/1080x1080.jpg");
  });
});

describe("generateCollage", () => {
  it.each([[400, false], [403, false], [429, true], [500, true], [503, true]] as const)(
    "rejects Images status %s without exposing its response and with retryable=%s",
    async (status, retryable) => {
      const keys: [string, string, string, string] = ["assets/a.jpg", "assets/b.jpg", "assets/c.jpg", "assets/d.jpg"];
      const images: ImagesBinding = { input: () => fakeTransformer([], () => new Response("SECRET signed-url", {
        status, headers: { "content-type": "image/jpeg" },
      })) };
      const error = await generateCollage(fakeBucket([COLLAGE_BASE_R2_KEY, ...keys]), images, keys).catch(error => error);
      expect(error).toMatchObject({ code: "images_output_failed", message: "Cloudflare Images output failed", retryable });
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toMatch(/SECRET|signed-url/);
    },
  );

  it.each([null, "application/json", "image/png", "text/html"])("rejects a successful response with content type %s", async contentType => {
    const keys: [string, string, string, string] = ["assets/a.jpg", "assets/b.jpg", "assets/c.jpg", "assets/d.jpg"];
    const images: ImagesBinding = { input: () => fakeTransformer([], () => new Response(new Uint8Array([1]), {
      headers: contentType ? { "content-type": contentType } : {},
    })) };
    await expect(generateCollage(fakeBucket([COLLAGE_BASE_R2_KEY, ...keys]), images, keys)).rejects.toMatchObject({
      code: "images_output_invalid", message: "Cloudflare Images returned an invalid image response", retryable: true,
    });
  });

  it("throws when the base canvas asset is missing from R2", async () => {
    const calls: ImageCall[] = [];
    const images: ImagesBinding = { input: () => fakeTransformer(calls) };
    const bucket = fakeBucket([]);

    await expect(
      generateCollage(bucket, images, ["assets/a.jpg", "assets/b.jpg", "assets/c.jpg", "assets/d.jpg"]),
    ).rejects.toThrow(/collage base/i);
  });

  it("throws when a source image key is missing from R2", async () => {
    const calls: ImageCall[] = [];
    const images: ImagesBinding = { input: () => fakeTransformer(calls) };
    const bucket = fakeBucket([COLLAGE_BASE_R2_KEY, "assets/a.jpg"]);

    await expect(
      generateCollage(bucket, images, ["assets/a.jpg", "assets/missing.jpg", "assets/c.jpg", "assets/d.jpg"]),
    ).rejects.toThrow(/source image/i);
  });

  it("applies deterministic contain-fit transform and draw offsets in ordered-image order", async () => {
    const calls: ImageCall[] = [];
    const images: ImagesBinding = { input: () => fakeTransformer(calls) };
    const keys: [string, string, string, string] = ["assets/a.jpg", "assets/b.jpg", "assets/c.jpg", "assets/d.jpg"];
    const bucket = fakeBucket([COLLAGE_BASE_R2_KEY, ...keys]);

    await generateCollage(bucket, images, keys);

    const transformCalls = calls.filter(
      (call): call is Extract<ImageCall, { op: "transform" }> => call.op === "transform",
    );
    expect(transformCalls).toHaveLength(4);
    for (const call of transformCalls) {
      expect(call.options).toEqual({
        width: COLLAGE_CELL_SIZE,
        height: COLLAGE_CELL_SIZE,
        fit: "contain",
        background: "#FFFFFF",
      });
    }

    const drawCalls = calls.filter(
      (call): call is Extract<ImageCall, { op: "draw" }> => call.op === "draw",
    );
    expect(drawCalls).toHaveLength(4);
    expect(drawCalls.map(({ options }) => ({ top: options!.top, left: options!.left }))).toEqual(COLLAGE_CELL_POSITIONS);

    const outputCall = calls.find(
      (call): call is Extract<ImageCall, { op: "output" }> => call.op === "output",
    );
    expect(outputCall?.options).toEqual({
      format: "image/jpeg",
      quality: 90,
    });
  });

  it("produces identical transform/draw call sequence across repeated runs (idempotent parameters)", async () => {
    const keys: [string, string, string, string] = ["assets/a.jpg", "assets/b.jpg", "assets/c.jpg", "assets/d.jpg"];
    const bucket = fakeBucket([COLLAGE_BASE_R2_KEY, ...keys]);

    const callsA: ImageCall[] = [];
    const imagesA: ImagesBinding = { input: () => fakeTransformer(callsA) };
    await generateCollage(bucket, imagesA, keys);

    const callsB: ImageCall[] = [];
    const imagesB: ImagesBinding = { input: () => fakeTransformer(callsB) };
    await generateCollage(bucket, imagesB, keys);

    expect(callsA.filter(({ op }) => op !== "output")).toEqual(callsB.filter(({ op }) => op !== "output"));
  });
});
