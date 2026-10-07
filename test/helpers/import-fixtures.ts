import type {
  AlbumSnapshot,
  ImageSource,
  SourcePhoto,
} from "../../src/icloud/types";
import type { MarkerDetector, MarkerKind } from "../../src/import/marker";

export interface BatchPhotoSpec {
  id: string;
  isMarker?: boolean;
  markerKind?: MarkerKind;
  captureAt?: string | null;
}

export class MutableBatchSource implements ImageSource {
  downloads: string[] = [];

  constructor(
    readonly sourceAlbumId: string,
    private specs: BatchPhotoSpec[],
  ) {}

  setSpecs(specs: BatchPhotoSpec[]): void {
    this.specs = specs;
  }

  async getSnapshot(): Promise<AlbumSnapshot> {
    const photos: SourcePhoto[] = this.specs.map((spec, index) => ({
      sourceAlbumId: this.sourceAlbumId,
      applePhotoId: spec.id,
      position: index + 1,
      captureAt: spec.captureAt ?? null,
      derivativeUrl: `https://icloud.example/${spec.id}.jpg`,
      mediaType: "image/jpeg",
    }));
    return {
      sourceAlbumId: this.sourceAlbumId,
      fetchedAt: "2026-09-01T09:00:00.000Z",
      photos,
    };
  }

  async download(photo: SourcePhoto): Promise<Response> {
    this.downloads.push(photo.applePhotoId);
    const spec = this.specs.find(
      (candidate) => candidate.id === photo.applePhotoId,
    );
    const label = spec?.markerKind === "ignore_start" ? "ignore" : spec?.isMarker || spec?.markerKind === "product_start" ? "marker" : "product";
    return new Response(
      new TextEncoder().encode(`${label}-${photo.applePhotoId}`),
      { headers: { "content-type": "image/jpeg" } },
    );
  }
}

export const fakeMarkerDetector: MarkerDetector = {
  async detect(bytes) {
    const label = new TextDecoder().decode(bytes);
    return label.startsWith("marker-") ? "product_start" : label.startsWith("ignore-") ? "ignore_start" : "none";
  },
};

export function productGroupOf(
  photoCount: number,
  groupIndex: number,
  captureAt: string | null = null,
): BatchPhotoSpec[] {
  const specs: BatchPhotoSpec[] = [
    {
      id: `g${groupIndex}-marker`,
      isMarker: true,
      captureAt,
    },
  ];
  for (let index = 0; index < photoCount; index += 1) {
    specs.push({
      id: `g${groupIndex}-photo-${index}`,
      captureAt,
    });
  }
  return specs;
}
