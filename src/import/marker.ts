import jpeg from "jpeg-js";
import jsQR from "jsqr";

export const MARKER_PAYLOAD = "SNAZZY_PRODUCT_START_V1";

export function isMarkerImage(jpegBytes: Uint8Array): boolean {
  let decoded: jpeg.RawImageData<Uint8Array>;
  try {
    decoded = jpeg.decode(jpegBytes, { useTArray: true });
  } catch {
    return false;
  }

  const code = jsQR(new Uint8ClampedArray(decoded.data), decoded.width, decoded.height);
  return code !== null && code.data === MARKER_PAYLOAD;
}

export interface MarkerImageTransformer {
  transform(options: {
    width: number;
    height: number;
    fit: "contain";
  }): MarkerImageTransformer;
  output(options: { format: "image/jpeg" }): Promise<{ response(): Response }>;
}

export interface MarkerImagesBinding {
  input(value: ReadableStream<Uint8Array>): MarkerImageTransformer;
}

export interface MarkerDetector {
  detect(bytes: ArrayBuffer): Promise<boolean>;
}

export function createMarkerDetector(
  images: MarkerImagesBinding,
): MarkerDetector {
  return {
    async detect(bytes) {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      });
      const result = await images
        .input(source)
        .transform({
          width: 1024,
          height: 1024,
          fit: "contain",
        })
        .output({ format: "image/jpeg" });
      const normalized = new Uint8Array(await result.response().arrayBuffer());
      return isMarkerImage(normalized);
    },
  };
}
