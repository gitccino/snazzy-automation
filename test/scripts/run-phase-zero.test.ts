import { describe, expect, it } from "vitest";
import { runFullPhaseZero } from "../../scripts/run-phase-zero";
import type { AlbumSnapshot, ImageSource, SourcePhoto } from "../../src/icloud/types";
import { markerCleanJpegBytes, nonMarkerJpegBytes } from "../helpers/marker-fixtures";

const clock = { now: () => new Date("2026-09-01T03:00:00.000Z") };

function photo(id: string, position: number): SourcePhoto {
  return {
    sourceAlbumId: "ALBUM-1",
    applePhotoId: id,
    position,
    captureAt: `2026-08-31T09:0${position}:00Z`,
    derivativeUrl: `https://cvws.icloud-content.com/${id}`,
    mediaType: "image/jpeg",
  };
}

function makeClient(markerAt: number[]): ImageSource {
  const photos = Array.from({ length: 10 }, (_, i) => photo(`P${i}`, i));
  const snapshot: AlbumSnapshot = { sourceAlbumId: "ALBUM-1", fetchedAt: "2026-09-01T03:00:00Z", photos };
  return {
    async getSnapshot() {
      return snapshot;
    },
    async download(p) {
      const bytes = markerAt.includes(p.position) ? markerCleanJpegBytes() : nonMarkerJpegBytes();
      return new Response(bytes, { status: 200 });
    },
  };
}

describe("runFullPhaseZero", () => {
  it("passes marker-detection when every planted marker photo is detected and non-markers are not", async () => {
    const client = makeClient([0, 5]);
    const report = await runFullPhaseZero(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 10,
      plantedMarkerPositions: [0, 5],
    });
    const markerGate = report.gates.find((g) => g.gate === "marker-detection")!;
    expect(markerGate.pass).toBe(true);
    expect(markerGate.evidence).toContain("2/2");
  });

  it("fails marker-detection when a planted marker is missed", async () => {
    const client: ImageSource = {
      async getSnapshot() {
        return { sourceAlbumId: "ALBUM-1", fetchedAt: "x", photos: [photo("P0", 0)] };
      },
      async download() {
        return new Response(nonMarkerJpegBytes(), { status: 200 });
      },
    };
    const report = await runFullPhaseZero(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 1,
      plantedMarkerPositions: [0],
    });
    const markerGate = report.gates.find((g) => g.gate === "marker-detection")!;
    expect(markerGate.pass).toBe(false);
  });

  it("passes transient-error-recovery when a 503-then-200 sequence eventually succeeds", async () => {
    const client = makeClient([0]);
    let attempt = 0;
    const flakyFetcher = (async () => {
      attempt += 1;
      return attempt < 3 ? new Response("busy", { status: 503 }) : new Response("{}", { status: 200 });
    }) as typeof fetch;

    const report = await runFullPhaseZero(client, flakyFetcher, clock, { sampleSize: 10, injectTransientFailures: true });
    const retryGate = report.gates.find((g) => g.gate === "transient-error-recovery")!;
    expect(retryGate.pass).toBe(true);
    expect(attempt).toBeGreaterThanOrEqual(3);
  });
});
