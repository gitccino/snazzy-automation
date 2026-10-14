import jpeg from "jpeg-js";
import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  assertImageOwner, claimImagePreparation, completeImagePreparation, failImagePreparation,
  findImportedOriginal, findOriginalImage, persistImageIntent, readImagePreparation,
  resumeImagePreparation, saveOriginalImage,
  type AttachmentSnapshot, type ImageOwner, type ImageReplacement, type OriginalImage,
} from "../db/product-image-repository";
import { AIRTABLE_PREVIEW_VARIANT } from "../import/asset-store";
import { renderAirtablePreview } from "../import/preview";
import { OperationalError } from "../shared/errors";
import { sha256Hex } from "../shared/ids";
import { downloadJpegAttachment } from "./attachment-download";
import { readProductAttachments, replaceProductImages } from "./airtable-runs";
import type { PublicationServiceDeps, RawValidatedPublication, ValidatedPublication } from "./service";
import type { DownloadableProductAttachment, ProductAttachment, PublicationProduct, RawPublicationProduct } from "./types";

export type ImageExecutionStatus = "active" | "terminal" | "unknown";
export type ImagePreparationDeps = Pick<PublicationServiceDeps,
  "db" | "clock" | "fetcher" | "config" | "airtableToken" | "bucket" | "assets" | "images"> & {
  executionStatus(workflowId: string): Promise<ImageExecutionStatus>;
};
export interface ImagePreparationContext { owner: ImageOwner; product: RawPublicationProduct }
const snapshot = (images: ProductAttachment[]): AttachmentSnapshot => images.map(({ id, filename }) => ({ id, filename }));
const sameSnapshot = (a: AttachmentSnapshot, b: AttachmentSnapshot) => JSON.stringify(a) === JSON.stringify(b);
const error = (code: string, retryable = false) => new OperationalError(code, "Unable to prepare product images", retryable);

async function currentAttachments(deps: ImagePreparationDeps, recordId: string): Promise<DownloadableProductAttachment[]> {
  return (await readProductAttachments(deps.fetcher, deps.config, deps.airtableToken, recordId)).attachments;
}

function completePreview(image: DownloadableProductAttachment): boolean {
  return !!image.url && (image.size ?? 0) > 0 && image.type === "image/jpeg";
}

async function verifiedAliases(deps: ImagePreparationDeps, owner: ImageOwner, intent: ImageReplacement[], images: DownloadableProductAttachment[]) {
  const aliases: Array<{ sourceAttachmentId: string; previewAttachmentId: string }> = [];
  for (const [position, descriptor] of intent.entries()) {
    const image = images[position]!;
    if (descriptor.kind === "retain") continue;
    if (!completePreview(image)) throw error("product_image_ingestion_pending", true);
    const known = await findOriginalImage(deps.db, owner.recordId, image.id);
    if (known?.attachmentKind === "preview" && known.r2Key === descriptor.r2Key) {
      aliases.push({ sourceAttachmentId: descriptor.sourceAttachmentId, previewAttachmentId: image.id });
      continue;
    }
    // Airtable does not consistently supply original dimensions; inspect delivered preview bytes.
    const downloaded = await downloadJpegAttachment(deps.fetcher, image);
    const { width, height } = jpegDimensions(downloaded.bytes);
    if (width > 600 || height > 600) throw error("product_image_preview_invalid");
    try {
      const decoded = jpeg.decode(new Uint8Array(downloaded.bytes), { maxResolutionInMP: 1, maxMemoryUsageInMB: 32, tolerantDecoding: false });
      if (decoded.width !== width || decoded.height !== height) throw error("product_image_preview_invalid");
    } catch { throw error("product_image_preview_invalid"); }
    aliases.push({ sourceAttachmentId: descriptor.sourceAttachmentId, previewAttachmentId: image.id });
  }
  return aliases;
}

// Inspect JPEG frame dimensions without decoding a full image buffer in the Worker.
function jpegDimensions(buffer: ArrayBuffer): { width: number; height: number } {
  const bytes = new Uint8Array(buffer);
  let position = 2;
  while (position + 4 <= bytes.length) {
    if (bytes[position++] !== 0xff) throw error("product_image_preview_invalid");
    while (bytes[position] === 0xff) position++;
    const marker = bytes[position++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
    if (position + 2 > bytes.length) break;
    const length = bytes[position]! * 256 + bytes[position + 1]!;
    if (length < 2 || position + length > bytes.length) break;
    if (marker !== undefined && [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
      const height = bytes[position + 3]! * 256 + bytes[position + 4]!;
      const width = bytes[position + 5]! * 256 + bytes[position + 6]!;
      if (width > 0 && height > 0) return { width, height };
    }
    position += length;
  }
  throw error("product_image_preview_invalid");
}

export async function reconcileProductImageIntent(deps: ImagePreparationDeps, owner: ImageOwner): Promise<"ready" | "original" | "pending" | "conflicted"> {
  const operation = await readImagePreparation(deps.db, owner.recordId);
  if (!operation || operation.workflowId !== owner.workflowId || operation.generation !== owner.generation) throw error("product_image_owner_changed", true);
  const images = await currentAttachments(deps, owner.recordId);
  if (!operation.intent) return sameSnapshot(snapshot(images), operation.snapshot) ? "original" : "conflicted";
  const matches = images.length === operation.intent.length && operation.intent.every((item, index) => {
    const image = images[index]!;
    return item.kind === "retain" ? image.id === item.attachmentId && image.filename === item.filename
      : image.id !== item.sourceAttachmentId && image.filename === item.filename;
  });
  if (matches) {
    if (operation.state === "ready") return "ready";
    const aliases = await verifiedAliases(deps, owner, operation.intent, images);
    await completeImagePreparation(deps.db, deps.clock, owner, aliases);
    return "ready";
  }
  if (sameSnapshot(snapshot(images), operation.snapshot)) return "original";
  const partial = images.length === operation.intent.length && operation.intent.every((item, index) => {
    const image = images[index]!;
    const original = operation.snapshot[index]!;
    return image.id === original.id && image.filename === original.filename ||
      (item.kind === "retain" ? image.id === item.attachmentId && image.filename === item.filename : image.filename === item.filename);
  });
  if (partial) return "pending";
  if (operation.state !== "ready") await failImagePreparation(deps.db, deps.clock, owner, "conflicted", "product_image_source_changed");
  return "conflicted";
}

export async function beginProductImagePreparation(deps: ImagePreparationDeps, workflowId: string, product: RawPublicationProduct): Promise<ImagePreparationContext> {
  const images = await currentAttachments(deps, product.airtableRecordId);
  const wanted = snapshot(product.attachments);
  if (!sameSnapshot(snapshot(images), wanted)) throw error("product_image_source_changed");
  let observed = await readImagePreparation(deps.db, product.airtableRecordId);
  if (observed && observed.state !== "ready") {
    if (observed.workflowId !== workflowId) {
      const status = await deps.executionStatus(observed.workflowId);
      if (status !== "terminal") throw error(status === "unknown" ? "product_image_owner_unknown" : "product_image_busy", true);
    }
    // A fresh attempt may accept a corrected list, but cannot guess an unmapped preview's original.
    if (observed.state === "conflicted") {
      for (const image of images) {
        if (!await findOriginalImage(deps.db, product.airtableRecordId, image.id) && observed.intent?.some(item => item.kind === "preview" && item.filename === image.filename)) {
          throw error("product_image_unresolved_preview");
        }
      }
    } else if (observed.workflowId === workflowId && observed.state === "preparing" && sameSnapshot(observed.snapshot, wanted)) {
      return { owner: observed, product };
    } else if (observed.intent || sameSnapshot(observed.snapshot, wanted)) {
      const resumed = await resumeImagePreparation(deps.db, deps.clock, workflowId, observed);
      if (!resumed) throw error("product_image_owner_changed", true);
      if (observed.intent) {
        const outcome = await reconcileProductImageIntent(deps, resumed);
        if (outcome === "original") return { owner: resumed, product };
        if (outcome === "pending") throw error("product_image_ingestion_pending", true);
        if (outcome === "conflicted") throw error("product_image_source_changed");
        observed = await readImagePreparation(deps.db, product.airtableRecordId);
      } else return { owner: resumed, product };
    }
  }
  const fingerprint = await sha256Hex(new TextEncoder().encode(JSON.stringify(wanted)));
  const owner = await claimImagePreparation(deps.db, deps.clock, product.airtableRecordId, workflowId, wanted, fingerprint, observed);
  if (!owner) throw error("product_image_owner_changed", true);
  return { owner, product };
}

export async function ensureProductOriginal(deps: ImagePreparationDeps, context: ImagePreparationContext, attachment: ProductAttachment, _position: number): Promise<OriginalImage> {
  await assertImageOwner(deps.db, context.owner);
  const known = await findOriginalImage(deps.db, context.owner.recordId, attachment.id);
  if (known) {
    const head = await deps.bucket.head(known.r2Key);
    if (!head || head.size !== known.byteLength) throw error("product_image_original_missing");
    return known;
  }
  const imported = await findImportedOriginal(deps.db, context.owner.recordId, attachment.filename);
  let original: OriginalImage;
  if (imported) {
    const object = await deps.bucket.head(imported.r2Key);
    if (!object) throw error("product_image_original_missing");
    original = { recordId: context.owner.recordId, attachmentId: attachment.id, attachmentKind: "preview", originalFilename: attachment.filename,
      ...imported, byteLength: object.size, mediaType: "image/jpeg", previewFilename: attachment.filename, variant: AIRTABLE_PREVIEW_VARIANT };
  } else {
    if (/^[a-f0-9]{64}\.jpg$/.test(attachment.filename) && await deps.db.prepare("SELECT 1 FROM product_groups WHERE airtable_record_id = ? AND state = 'succeeded' LIMIT 1").bind(context.owner.recordId).first()) {
      throw error("product_image_original_missing");
    }
    const images = await currentAttachments(deps, context.owner.recordId);
    const operation = await readImagePreparation(deps.db, context.owner.recordId);
    if (!operation || !sameSnapshot(snapshot(images), operation.snapshot)) throw error("product_image_source_changed");
    const image = images.find(item => item.id === attachment.id);
    if (!image) throw error("product_image_source_changed");
    const downloaded = await downloadJpegAttachment(deps.fetcher, image);
    const contentHash = await sha256Hex(downloaded.bytes);
    const stored = await deps.assets.putIfAbsent(contentHash, downloaded.extension, downloaded.bytes, downloaded.mediaType);
    const object = await deps.bucket.get(stored.r2Key);
    if (!object || object.size !== downloaded.bytes.byteLength) throw error("product_image_original_missing", true);
    try { await (await renderAirtablePreview(deps.images, object.body)).arrayBuffer(); }
    catch (failure) { if (failure instanceof OperationalError) throw failure; throw error("product_image_preview_failed", true); }
    original = { recordId: context.owner.recordId, attachmentId: image.id, attachmentKind: "source", originalFilename: image.filename,
      contentHash, r2Key: stored.r2Key, byteLength: downloaded.bytes.byteLength, mediaType: downloaded.mediaType,
      previewFilename: stored.r2Key.slice("assets/".length), variant: AIRTABLE_PREVIEW_VARIANT };
  }
  await saveOriginalImage(deps.db, deps.clock, context.owner, original);
  return original;
}

async function preparedProduct(deps: ImagePreparationDeps, product: RawPublicationProduct): Promise<PublicationProduct> {
  const images = await currentAttachments(deps, product.airtableRecordId);
  const keys: string[] = [];
  for (const image of images) {
    const mapping = await findOriginalImage(deps.db, product.airtableRecordId, image.id);
    if (!mapping || mapping.attachmentKind !== "preview" || !await deps.bucket.head(mapping.r2Key)) throw error("product_image_original_missing");
    keys.push(mapping.r2Key);
  }
  if (keys.length < 4) throw error("product_image_source_changed");
  const { attachments: _attachments, ...metadata } = product;
  return { ...metadata, orderedImageKeys: keys };
}

export async function replaceProductImagePreviews(deps: ImagePreparationDeps, context: ImagePreparationContext): Promise<PublicationProduct> {
  const { owner, product } = context;
  let operation = await readImagePreparation(deps.db, owner.recordId);
  if (!operation || operation.workflowId !== owner.workflowId || operation.generation !== owner.generation) throw error("product_image_owner_changed", true);
  if (operation.state === "ready") return preparedProduct(deps, product);
  await assertImageOwner(deps.db, owner);
  if (!operation.intent) {
    const intent: ImageReplacement[] = [];
    for (const image of operation.snapshot) {
      const mapping = await findOriginalImage(deps.db, owner.recordId, image.id);
      if (!mapping || !await deps.bucket.head(mapping.r2Key)) throw error("product_image_original_missing");
      intent.push(mapping.attachmentKind === "preview" ? { kind: "retain", attachmentId: image.id, filename: image.filename }
        : { kind: "preview", sourceAttachmentId: image.id, r2Key: mapping.r2Key, filename: mapping.previewFilename });
    }
    await persistImageIntent(deps.db, deps.clock, owner, intent);
    operation = (await readImagePreparation(deps.db, owner.recordId))!;
  }
  const outcome = await reconcileProductImageIntent(deps, owner);
  if (outcome === "ready") return preparedProduct(deps, product);
  if (outcome === "pending") throw error("product_image_ingestion_pending", true);
  if (outcome === "conflicted") throw error("product_image_source_changed");
  const patches = await Promise.all(operation.intent!.map(async item => item.kind === "retain" ? { id: item.attachmentId } : {
    url: await deps.assets.signUrl(item.r2Key, 900, AIRTABLE_PREVIEW_VARIANT), filename: item.filename,
  }));
  // Recheck immediately before the external write; Airtable still has no atomic conditional PATCH.
  if (!sameSnapshot(snapshot(await currentAttachments(deps, owner.recordId)), operation.snapshot)) throw error("product_image_source_changed");
  await assertImageOwner(deps.db, owner);
  await replaceProductImages(deps.fetcher, deps.config, deps.airtableToken, owner.recordId, patches);
  const applied = await reconcileProductImageIntent(deps, owner);
  if (applied === "conflicted") throw error("product_image_source_changed");
  if (applied !== "ready") throw error("product_image_ingestion_pending", true);
  return preparedProduct(deps, product);
}

const reasons: Record<string, string> = {
  product_image_source_changed: "รูปใน Airtable เปลี่ยนระหว่างเตรียม กรุณาตรวจสอบรูปแล้วลอง /docs อีกครั้ง",
  product_image_unresolved_preview: "รูปตัวอย่างยังจับคู่ต้นฉบับไม่ได้ กรุณาคืนรูปต้นฉบับใน Airtable แล้วลอง /docs อีกครั้ง",
  product_image_original_missing: "ไม่พบรูปต้นฉบับใน R2 กรุณาตรวจสอบรูปสินค้า",
  product_image_too_large: "ไฟล์รูปใหญ่เกิน 20 MB กรุณาใช้ JPEG ขนาดไม่เกิน 20 MB",
  product_image_format_invalid: "ไฟล์รูปต้องเป็น JPEG",
  product_image_preview_invalid: "สร้างรูปตัวอย่างไม่ได้ กรุณาตรวจสอบไฟล์ JPEG",
  product_image_busy: "มีงานอื่นกำลังเตรียมรูปสินค้า กรุณาลอง /docs อีกครั้ง",
  product_image_owner_unknown: "ตรวจสอบสถานะงานเตรียมรูปไม่ได้ กรุณาลอง /docs อีกครั้ง",
};

export async function preparePublicationImages(deps: ImagePreparationDeps, validated: RawValidatedPublication, workflowId: string, step: WorkflowStep): Promise<ValidatedPublication> {
  const retry = { retries: { limit: deps.config.publicationRetryLimit, delay: "10 seconds" as const, backoff: "exponential" as const }, timeout: "5 minutes" as const };
  const products: PublicationProduct[] = [];
  for (const product of validated.run.products) {
    let context: ImagePreparationContext | undefined;
    let position: number | undefined;
    const call = async <T>(fn: () => Promise<T>): Promise<T> => {
      try { return await fn(); }
      catch (failure) {
        const code = failure instanceof OperationalError ? failure.code : "product_image_preparation_failed";
        const retryable = failure instanceof OperationalError ? failure.retryable : true;
        const safe = `${product.productId}${position === undefined ? "" : `: รูปที่ ${position + 1}`} — ${reasons[code] ?? "เตรียมรูปไม่สำเร็จ กรุณาตรวจสอบ Airtable แล้วลอง /docs อีกครั้ง"}`;
        if (context && !retryable) {
          try { await failImagePreparation(deps.db, deps.clock, context.owner, code === "product_image_source_changed" ? "conflicted" : "failed", safe); } catch { /* Preserve the original failure if ownership changed. */ }
        }
        if (!retryable) throw new NonRetryableError(safe, code);
        throw new Error(safe);
      }
    };
    context = await step.do(`images ${product.airtableRecordId} begin`, retry, () => call(() => beginProductImagePreparation(deps, workflowId, product)));
    for (const [index, attachment] of product.attachments.entries()) {
      position = index;
      await step.do(`images ${product.airtableRecordId} ${attachment.id} archive`, retry, () => call(() => ensureProductOriginal(deps, context!, attachment, index)));
    }
    position = undefined;
    products.push(await step.do(`images ${product.airtableRecordId} replace`, retry, () => call(() => replaceProductImagePreviews(deps, context!))));
  }
  return { ...validated, run: { ...validated.run, products } };
}
