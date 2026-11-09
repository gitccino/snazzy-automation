import type { ImagesBinding } from "../publication/collage";
import { OperationalError } from "../shared/errors";

export async function renderAirtablePreview(images: ImagesBinding, body: ReadableStream<Uint8Array>): Promise<Response> {
  const output = await images.input(body)
    .transform({ width: 600, height: 600, fit: "scale-down" })
    .output({ format: "image/jpeg", quality: 80 });
  const preview = output.response();
  if (!preview.ok || preview.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "image/jpeg") {
    throw new OperationalError("product_image_preview_invalid", "Image preview is unavailable", false);
  }
  return preview;
}
