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
