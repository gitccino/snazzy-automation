import QRCode from "qrcode";
import jpeg from "jpeg-js";

export const MARKER_PAYLOAD = "SNAZZY_PRODUCT_START_V1";
export const WRONG_PAYLOAD = "NOT_THE_MARKER";

function qrJpeg(payload: string): Uint8Array {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const quietZone = 4;
  const pixelsPerModule = 12;
  const size = (qr.modules.size + quietZone * 2) * pixelsPerModule;
  const data = new Uint8Array(size * size * 4).fill(255);

  for (let row = 0; row < qr.modules.size; row += 1) {
    for (let column = 0; column < qr.modules.size; column += 1) {
      if (qr.modules.get(row, column) !== 1) continue;
      const startX = (column + quietZone) * pixelsPerModule;
      const startY = (row + quietZone) * pixelsPerModule;
      for (let y = startY; y < startY + pixelsPerModule; y += 1) {
        for (let x = startX; x < startX + pixelsPerModule; x += 1) {
          const offset = (y * size + x) * 4;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
        }
      }
    }
  }

  return jpeg.encode({ data, width: size, height: size }, 95).data;
}

export function markerCleanJpegBytes(): Uint8Array {
  return qrJpeg(MARKER_PAYLOAD);
}

export function ignoreMarkerJpegBytes(): Uint8Array {
  return qrJpeg("SNAZZY_IGNORE_START_V1");
}

export function wrongPayloadJpegBytes(): Uint8Array {
  return qrJpeg(WRONG_PAYLOAD);
}

export function nonMarkerJpegBytes(): Uint8Array {
  const size = 512;
  const data = new Uint8Array(size * size * 4).fill(255);
  return jpeg.encode({ data, width: size, height: size }, 95).data;
}
