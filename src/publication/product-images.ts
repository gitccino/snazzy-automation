import jpeg from "jpeg-js";
import { z } from "zod";
import { publicationWorkflowId } from "./types";
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
    try {
      const decoded = jpeg.decode(new Uint8Array(downloaded.bytes), { maxResolutionInMP: 1, maxMemoryUsageInMB: 32, tolerantDecoding: false });
      if (decoded.width > 600 || decoded.height > 600) throw error("product_image_preview_invalid");
    } catch { throw error("product_image_preview_invalid"); }
    aliases.push({ sourceAttachmentId: descriptor.sourceAttachmentId, previewAttachmentId: image.id });
  }
  return aliases;
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
        if (outcome === "conflicted") {
          for (const image of images) {
            if (!await findOriginalImage(deps.db, product.airtableRecordId, image.id) && observed.intent.some(item => item.kind === "preview" && item.filename === image.filename)) {
              throw error("product_image_unresolved_preview");
            }
          }
        }
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
    const images = await currentAttachments(deps, context.owner.recordId);
    const operation = await readImagePreparation(deps.db, context.owner.recordId);
    if (!operation || !sameSnapshot(snapshot(images), operation.snapshot)) throw error("product_image_source_changed");
    const image = images.find(item => item.id === attachment.id);
    if (!image) throw error("product_image_source_changed");
    const downloaded = await downloadJpegAttachment(deps.fetcher, image);
    const contentHash = await sha256Hex(downloaded.bytes);
    const recovered = await proveLegacyPreview(deps, context, image, contentHash);
    if (recovered) {
      await saveOriginalImage(deps.db, deps.clock, context.owner, recovered);
      return recovered;
    }
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

async function proveLegacyPreview(deps: ImagePreparationDeps, context: ImagePreparationContext, image: DownloadableProductAttachment,
  contentHash: string): Promise<OriginalImage | null> {
  if (!/^[a-f0-9]{64}\.jpg$/.test(image.filename) || contentHash === image.filename.slice(0, 64)) return null;
  const key = `assets/${image.filename}`;
  const candidate = await deps.db.prepare(`SELECT r2_key FROM product_image_originals WHERE record_id = ? AND r2_key = ?
    UNION SELECT a.r2_key FROM product_groups g JOIN import_runs r ON r.id = g.import_run_id
    JOIN photo_assets a ON a.source_album_id = r.source_album_id
    WHERE g.airtable_record_id = ? AND g.state = 'succeeded' AND a.r2_key = ? LIMIT 1`)
    .bind(context.owner.recordId, key, context.owner.recordId, key).first();
  if (!candidate) return null;
  const original = await deps.bucket.get(key);
  if (!original) return null;
  // Filename is a candidate, not proof. Require exact preview bytes before using the original.
  const preview = await (await renderAirtablePreview(deps.images, original.body)).arrayBuffer();
  if (await sha256Hex(preview) !== contentHash) return null;
  return { recordId: context.owner.recordId, attachmentId: image.id, attachmentKind: "preview", originalFilename: image.filename,
    contentHash: image.filename.slice(0, 64), r2Key: key, byteLength: original.size, mediaType: "image/jpeg",
    previewFilename: image.filename, variant: AIRTABLE_PREVIEW_VARIANT };
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
  if (!operation || operation.workflowId !== owner.workflowId || operation.generation !== owner.generation) {
    // Ready ownership may be reused while this completed step's result is still being committed.
    // Read-only reuse is safe only when every current attachment has a verified preview mapping.
    try { return await preparedProduct(deps, product); } catch { throw error("product_image_owner_changed", true); }
  }
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

export class ProductImagePreparationFailure extends Error {
  constructor(reason: string) { super(reason); this.name = "ProductImagePreparationFailure"; }
}

export async function preparePublicationImages(deps: ImagePreparationDeps, validated: RawValidatedPublication, workflowId: string, step: WorkflowStep): Promise<ValidatedPublication> {
  const retry = { retries: { limit: deps.config.publicationRetryLimit, delay: "10 seconds" as const, backoff: "exponential" as const }, timeout: "5 minutes" as const };
  const products: PublicationProduct[] = [];
  let safeFailure = "เตรียมรูปสินค้าไม่สำเร็จ กรุณาตรวจสอบ Airtable แล้วลอง /docs อีกครั้ง";
  try {
    for (const validatedProduct of validated.run.products as Array<RawPublicationProduct | PublicationProduct>) {
    // Existing workflow instances may replay a pre-upgrade validated product with only R2 keys.
    const product = "attachments" in validatedProduct ? validatedProduct : await step.do(`images ${validatedProduct.airtableRecordId} hydrate`, retry, async () => {
      try {
        const record = await readProductAttachments(deps.fetcher, deps.config, deps.airtableToken, validatedProduct.airtableRecordId);
        const { orderedImageKeys: _keys, ...metadata } = validatedProduct as PublicationProduct;
        return { ...metadata, attachments: record.attachments.map(({ url: _url, ...image }) => image) };
      } catch { throw new Error("Unable to read product attachments."); }
    });
    if (product.attachments.length < 4) throw new ProductImagePreparationFailure(`${product.productId}: ต้องมีรูปอย่างน้อย 4 รูป`);
      let context: ImagePreparationContext | undefined;
      let position: number | undefined;
      const call = async <T>(fn: () => Promise<T>): Promise<T> => {
        try {
          const value = await fn();
          try {
            await deps.db.prepare("UPDATE publication_jobs SET image_error_json = NULL WHERE publication_run_id = ? AND generation = ? AND correlation_id = ? AND state NOT IN ('succeeded','failed')")
              .bind(validated.run.airtableRunId, validated.generation ?? 1, publicationWorkflowId(validated.run.airtableRunId, validated.generation ?? 1)).run();
          } catch { /* Diagnostics must not fail a completed image operation. */ }
          return value;
        }
        catch (failure) {
          const code = failure instanceof OperationalError ? failure.code : "product_image_preparation_failed";
          const retryable = failure instanceof OperationalError ? failure.retryable : true;
          const safe = `${product.productId}${position === undefined ? "" : `: รูปที่ ${position + 1}`} — ${reasons[code] ?? "เตรียมรูปไม่สำเร็จ กรุณาตรวจสอบ Airtable แล้วลอง /docs อีกครั้ง"}`;
          safeFailure = safe;
          try {
            await deps.db.prepare(`UPDATE publication_jobs SET image_error_json = ? WHERE publication_run_id = ? AND generation = ?
              AND correlation_id = ? AND state NOT IN ('succeeded','failed')`)
              .bind(JSON.stringify({ productId: product.productId, position: position ?? null, code }), validated.run.airtableRunId,
                validated.generation ?? 1, publicationWorkflowId(validated.run.airtableRunId, validated.generation ?? 1)).run();
          } catch { /* Keep a diagnostic storage failure from replacing the original stage error. */ }
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
  } catch {
    try {
      const stored = await deps.db.prepare("SELECT image_error_json FROM publication_jobs WHERE publication_run_id = ? AND generation = ? AND correlation_id = ?")
        .bind(validated.run.airtableRunId, validated.generation ?? 1, publicationWorkflowId(validated.run.airtableRunId, validated.generation ?? 1)).first<{ image_error_json: string | null }>();
      if (stored?.image_error_json) {
        const diagnostic = z.object({ productId: z.string().regex(/^A-\d+$/), position: z.number().int().nonnegative().nullable(), code: z.string() }).parse(JSON.parse(stored.image_error_json));
        safeFailure = `${diagnostic.productId}${diagnostic.position === null ? "" : `: รูปที่ ${diagnostic.position + 1}`} — ${reasons[diagnostic.code] ?? "เตรียมรูปไม่สำเร็จ กรุณาตรวจสอบ Airtable แล้วลอง /docs อีกครั้ง"}`;
      }
    } catch { /* The locally constructed fallback remains safe on diagnostic read failure. */ }
    throw new ProductImagePreparationFailure(safeFailure);
  }
}
