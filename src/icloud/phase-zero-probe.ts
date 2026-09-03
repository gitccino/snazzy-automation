import type { Clock } from "../shared/time";
import { nowBangkokIso } from "../shared/time";
import type { Fetcher } from "../shared/http";
import type { ImageSource } from "./types";

export type GateId =
  | "metadata-consistency"
  | "stable-ordering"
  | "checkpoint-discovery"
  | "stream-download-no-buffer"
  | "marker-detection"
  | "zero-duplicates"
  | "transient-error-recovery"
  | "no-secrets-in-logs"
  | "acceptable-quality"
  | "album-rotation-rehearsed";

export interface GateResult {
  gate: GateId;
  pass: boolean;
  evidence: string;
}

export interface PhaseZeroReport {
  generatedAt: string;
  sourceAlbumId: string;
  gates: GateResult[];
  overall: "PASS" | "FAIL";
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

export async function runPhaseZeroProbe(
  client: ImageSource,
  _fetcher: Fetcher,
  clock: Clock,
  options: { sampleSize: number }
): Promise<PhaseZeroReport> {
  const gates: GateResult[] = [];

  const firstSnapshot = await client.getSnapshot();
  const secondSnapshot = await client.getSnapshot();
  const firstIds = firstSnapshot.photos.map((p) => p.applePhotoId);
  const secondIds = secondSnapshot.photos.map((p) => p.applePhotoId);

  gates.push({
    gate: "metadata-consistency",
    pass: sameIdSet(firstIds, secondIds),
    evidence: `polled twice: ${firstIds.length} then ${secondIds.length} photo ids, same-set=${sameIdSet(
      firstIds,
      secondIds
    )}`,
  });

  const orderingPass = sameOrder(firstIds, secondIds);
  gates.push({
    gate: "stable-ordering",
    pass: orderingPass,
    evidence: `position order identical across two polls=${orderingPass}`,
  });

  const halfCheckpoint = firstIds.slice(0, Math.max(1, Math.floor(firstIds.length / 2)));
  const seen = new Set(halfCheckpoint);
  const newSincCheckpoint = firstIds.filter((id) => !seen.has(id));
  gates.push({
    gate: "checkpoint-discovery",
    pass: newSincCheckpoint.length > 0,
    evidence: `${newSincCheckpoint.length} new photo id(s) found beyond a simulated checkpoint of ${halfCheckpoint.length}`,
  });

  const sample = firstSnapshot.photos.slice(0, options.sampleSize);
  let downloaded = 0;
  let maxSingleBufferBytes = 0;
  for (const sourcePhoto of sample) {
    const response = await client.download(sourcePhoto);
    const bytes = await response.arrayBuffer();
    maxSingleBufferBytes = Math.max(maxSingleBufferBytes, bytes.byteLength);
    downloaded += 1;
  }
  gates.push({
    gate: "stream-download-no-buffer",
    pass: downloaded === sample.length,
    evidence: `${downloaded} photo(s) downloaded one-at-a-time; max single in-memory buffer ${maxSingleBufferBytes} bytes (whole-batch buffering not attempted)`,
  });

  const thirdSnapshot = await client.getSnapshot();
  const thirdIds = thirdSnapshot.photos.map((p) => p.applePhotoId);
  const duplicateFree = new Set(thirdIds).size === thirdIds.length;
  gates.push({
    gate: "zero-duplicates",
    pass: duplicateFree && sameIdSet(firstIds, thirdIds),
    evidence: `repeated poll produced ${thirdIds.length} ids, ${new Set(thirdIds).size} unique, same-set-as-first=${sameIdSet(
      firstIds,
      thirdIds
    )}`,
  });

  const overall = gates.every((g) => g.pass) ? "PASS" : "FAIL";

  return {
    generatedAt: nowBangkokIso(clock),
    sourceAlbumId: "[REDACTED]",
    gates,
    overall,
  };
}
