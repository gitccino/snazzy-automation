import { describe, expect, it } from "vitest";
import { runPhaseZeroProbe } from "../../src/icloud/phase-zero-probe";
import type { AlbumSnapshot, ImageSource, SourcePhoto } from "../../src/icloud/types";
import { MARKER_PAYLOAD } from "../../src/import/marker";

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

function makeStableClient(photoCount: number, markerAt: number[]): ImageSource {
  const photos = Array.from({ length: photoCount }, (_, i) => photo(`P${i}`, i));
  const snapshot: AlbumSnapshot = { sourceAlbumId: "ALBUM-1", fetchedAt: "2026-09-01T03:00:00Z", photos };
  return {
    async getSnapshot() {
      return snapshot;
    },
    async download(p) {
      const isMarker = markerAt.includes(p.position);
      const body = new Uint8Array(isMarker ? [0xff, 0xd8, 0xff, 0x00] : [0xff, 0xd8, 0xff, 0x01]);
      return new Response(body, { status: 200 });
    },
  };
}

describe("runPhaseZeroProbe", () => {
  it("passes metadata-consistency and stable-ordering when repeated snapshots match", async () => {
    const client = makeStableClient(12, [0]);
    const report = await runPhaseZeroProbe(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 12,
    });

    const consistency = report.gates.find((g) => g.gate === "metadata-consistency")!;
    const ordering = report.gates.find((g) => g.gate === "stable-ordering")!;
    expect(consistency.pass).toBe(true);
    expect(ordering.pass).toBe(true);
  });

  it("fails stable-ordering when the two polled snapshots disagree on order", async () => {
    let call = 0;
    const stableClient = makeStableClient(6, [0]);
    const flakyClient: ImageSource = {
      async getSnapshot() {
        const snap = await stableClient.getSnapshot();
        call += 1;
        if (call === 2) {
          return { ...snap, photos: [...snap.photos].reverse() };
        }
        return snap;
      },
      download: stableClient.download,
    };

    const report = await runPhaseZeroProbe(flakyClient, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 6,
    });
    const ordering = report.gates.find((g) => g.gate === "stable-ordering")!;
    expect(ordering.pass).toBe(false);
  });

  it("reports checkpoint-discovery pass when photos beyond a saved checkpoint are found", async () => {
    const client = makeStableClient(20, [0]);
    const report = await runPhaseZeroProbe(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 20,
    });
    const checkpoint = report.gates.find((g) => g.gate === "checkpoint-discovery")!;
    expect(checkpoint.pass).toBe(true);
    expect(checkpoint.evidence).toContain("new photo");
  });

  it("reports stream-download-no-buffer pass when every sampled photo downloads without accumulating all bytes in one array", async () => {
    const client = makeStableClient(120, [0, 40, 80]);
    const report = await runPhaseZeroProbe(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 120,
    });
    const streamGate = report.gates.find((g) => g.gate === "stream-download-no-buffer")!;
    expect(streamGate.pass).toBe(true);
    expect(streamGate.evidence).toContain("120");
  });

  it("reports zero-duplicates pass when re-polling the same snapshot yields the same applePhotoId set", async () => {
    const client = makeStableClient(15, [0]);
    const report = await runPhaseZeroProbe(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 15,
    });
    const dupGate = report.gates.find((g) => g.gate === "zero-duplicates")!;
    expect(dupGate.pass).toBe(true);
  });

  it("computes overall FAIL when any computed gate fails", async () => {
    let call = 0;
    const stableClient = makeStableClient(6, [0]);
    const flakyClient: ImageSource = {
      async getSnapshot() {
        const snap = await stableClient.getSnapshot();
        call += 1;
        return call === 2 ? { ...snap, photos: [...snap.photos].reverse() } : snap;
      },
      download: stableClient.download,
    };
    const report = await runPhaseZeroProbe(flakyClient, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 6,
    });
    expect(report.overall).toBe("FAIL");
  });

  it("never includes the source album identifier in any gate's evidence string", async () => {
    const client = makeStableClient(9, [0]);
    const report = await runPhaseZeroProbe(client, (async () => new Response("{}", { status: 200 })) as typeof fetch, clock, {
      sampleSize: 9,
    });
    for (const gate of report.gates) {
      expect(gate.evidence).not.toContain("ALBUM-1");
    }
  });
});
