import { OperationalError } from "../shared/errors";
import type { Fetcher } from "../shared/http";
import type { DownloadableProductAttachment } from "./types";

export const MAX_ATTACHMENT_BYTES = 20_000_000;
const invalid = (code: string) => new OperationalError(code, "Product image source is invalid", false);

function trustedUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw invalid("product_image_source_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
    !(url.hostname === "airtableusercontent.com" || url.hostname.endsWith(".airtableusercontent.com"))) {
    throw invalid("product_image_source_invalid");
  }
  return url;
}

export async function downloadJpegAttachment(fetcher: Fetcher, attachment: DownloadableProductAttachment):
  Promise<{ bytes: ArrayBuffer; mediaType: "image/jpeg"; extension: "jpg" }> {
  if (attachment.size !== undefined && attachment.size > MAX_ATTACHMENT_BYTES) throw invalid("product_image_too_large");
  let url = trustedUrl(attachment.url);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new OperationalError("product_image_download_timeout", "Product image download timed out", true)); }, 30_000);
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await Promise.race([fetcher(url.toString(), { redirect: "manual", signal: controller.signal }), deadline]);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await Promise.race([response.body?.cancel(), deadline]);
      if (!location || redirects === 3) throw invalid("product_image_source_invalid");
      url = trustedUrl(new URL(location, url).toString());
    }
    if (!response?.ok || !response.body) {
      const status = response?.status ?? 0;
      throw new OperationalError("product_image_download_failed", "Product image download failed", status === 403 || status === 429 || status >= 500);
    }
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > MAX_ATTACHMENT_BYTES) throw invalid("product_image_too_large");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_ATTACHMENT_BYTES) throw invalid("product_image_too_large");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw invalid("product_image_format_invalid");
    return { bytes: bytes.buffer, mediaType: "image/jpeg", extension: "jpg" };
  } catch (error) {
    if (error instanceof OperationalError) throw error;
    throw new OperationalError("product_image_download_failed", "Product image download failed", true);
  } finally {
    clearTimeout(timer!);
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  }
}
