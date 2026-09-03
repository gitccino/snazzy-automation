import { describe, expect, it } from "vitest";
import { runFullPhaseZero } from "../../scripts/run-phase-zero";
import type { AlbumSnapshot, ImageSource, SourcePhoto } from "../../src/icloud/types";

const clock = { now: () => new Date("2026-09-01T03:00:00.000Z") };

function makeClientOfSize(count: number, simulatedBytesPerPhoto: number): ImageSource {
  const photos: SourcePhoto[] = Array.from({ length: count }, (_, i) => ({
    sourceAlbumId: "ALBUM-1",
    applePhotoId: `P${i}`,
    position: i,
    captureAt: null,
    derivativeUrl: `https://cvws.icloud-content.com/P${i}`,
    mediaType: "image/jpeg",
  }));
  const snapshot: AlbumSnapshot = { sourceAlbumId: "ALBUM-1", fetchedAt: "x", photos };
  return {
    async getSnapshot() {
      return snapshot;
    },
    async download() {
      return new Response(new Uint8Array(simulatedBytesPerPhoto), { status: 200 });
    },
  };
}

describe("100-500 image streaming feasibility", () => {
  it.each([100, 250, 500])(
    "streams %d photos one-at-a-time without the probe itself accumulating all bytes",
    async (count) => {
      const perPhotoBytes = 2 * 1024 * 1024; // ~2MB, matching spec's expected average image size
      const client = makeClientOfSize(count, perPhotoBytes);

      const report = await runFullPhaseZero(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
        sampleSize: count,
      });

      const streamGate = report.gates.find((g) => g.gate === "stream-download-no-buffer")!;
      expect(streamGate.pass).toBe(true);
      expect(streamGate.evidence).toContain(String(count));
    },
    20_000
  );

  it("keeps sample size within the documented 100-500 daily volume boundary", async () => {
    const client = makeClientOfSize(500, 1024);
    const report = await runFullPhaseZero(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 500,
    });
    const checkpointGate = report.gates.find((g) => g.gate === "checkpoint-discovery")!;
    expect(checkpointGate.pass).toBe(true);
  });
});
