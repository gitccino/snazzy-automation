export const COLLAGE_BASE_R2_KEY = "assets/collage-base-1080.jpg";
export const COLLAGE_CANVAS_SIZE = 1080;
export const COLLAGE_CELL_SIZE = 504;
export const COLLAGE_GUTTER = 24;

export const COLLAGE_CELL_POSITIONS: Array<{ top: number; left: number }> = [
  { top: COLLAGE_GUTTER, left: COLLAGE_GUTTER },
  { top: COLLAGE_GUTTER, left: COLLAGE_GUTTER + COLLAGE_CELL_SIZE + COLLAGE_GUTTER },
  { top: COLLAGE_GUTTER + COLLAGE_CELL_SIZE + COLLAGE_GUTTER, left: COLLAGE_GUTTER },
  {
    top: COLLAGE_GUTTER + COLLAGE_CELL_SIZE + COLLAGE_GUTTER,
    left: COLLAGE_GUTTER + COLLAGE_CELL_SIZE + COLLAGE_GUTTER,
  },
];

export interface ImageTransformer {
  transform(options: { width: number; height: number; fit: "contain"; background: string }): ImageTransformer;
  draw(
    overlay: ReadableStream<Uint8Array> | ImageTransformer,
    options?: { top?: number; left?: number },
  ): ImageTransformer;
  output(options: { format: "image/jpeg"; quality: number }): Promise<{ response(): Response }>;
}

export interface ImagesBinding {
  input(stream: ReadableStream<Uint8Array>): ImageTransformer;
}

export function collageR2Key(productId: string): string {
  return `products/${productId}/collage/1080x1080.jpg`;
}

export async function generateCollage(
  bucket: R2Bucket,
  images: ImagesBinding,
  orderedR2Keys: [string, string, string, string],
): Promise<Uint8Array> {
  const base = await bucket.get(COLLAGE_BASE_R2_KEY);
  if (!base) {
    throw new Error(`collage base canvas missing from R2 at ${COLLAGE_BASE_R2_KEY}`);
  }

  let pipeline = images.input(base.body);

  for (const [index, key] of orderedR2Keys.entries()) {
    const position = COLLAGE_CELL_POSITIONS[index];
    if (!position) {
      throw new Error(`collage position missing at index ${index}`);
    }

    const object = await bucket.get(key);
    if (!object) {
      throw new Error(`collage source image missing from R2 at position ${index}: ${key}`);
    }

    const cell = images.input(object.body).transform({
      width: COLLAGE_CELL_SIZE,
      height: COLLAGE_CELL_SIZE,
      fit: "contain",
      background: "#FFFFFF",
    });
    pipeline = pipeline.draw(cell, {
      ...position,
    });
  }

  const result = await pipeline.output({ format: "image/jpeg", quality: 90 });
  return new Uint8Array(await result.response().arrayBuffer());
}
