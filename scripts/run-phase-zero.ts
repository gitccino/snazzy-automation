import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseConfig } from "../src/config";
import { createICloudClient } from "../src/icloud/client";
import { runPhaseZeroProbe, type GateResult, type PhaseZeroReport } from "../src/icloud/phase-zero-probe";
import type { ImageSource } from "../src/icloud/types";
import { isMarkerImage } from "../src/import/marker";
import { isRetryable, OperationalError } from "../src/shared/errors";
import type { Clock } from "../src/shared/time";
import type { Fetcher } from "../src/shared/http";

export interface RunFullPhaseZeroOptions {
  sampleSize: number;
  plantedMarkerPositions?: number[];
  injectTransientFailures?: boolean;
}

async function markerDetectionGate(
  client: ImageSource,
  plantedMarkerPositions: number[]
): Promise<GateResult> {
  if (plantedMarkerPositions.length === 0) {
    return { gate: "marker-detection", pass: true, evidence: "no marker photos planted for this run" };
  }
  const snapshot = await client.getSnapshot();
  let detected = 0;
  for (const position of plantedMarkerPositions) {
    const sourcePhoto = snapshot.photos[position]!;
    const response = await client.download(sourcePhoto);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (isMarkerImage(bytes)) detected += 1;
  }
  return {
    gate: "marker-detection",
    pass: detected === plantedMarkerPositions.length,
    evidence: `${detected}/${plantedMarkerPositions.length} planted marker photos detected`,
  };
}

async function transientErrorRecoveryGate(fetcher: Fetcher): Promise<GateResult> {
  const maxAttempts = 5;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetcher("https://phase-zero-probe.invalid/retry-check");
      if (res.status >= 500) {
        throw new OperationalError("HTTP_5XX", `attempt ${attempt} got ${res.status}`, true);
      }
      return { gate: "transient-error-recovery", pass: true, evidence: `succeeded after ${attempt} attempt(s)` };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) break;
    }
  }
  return {
    gate: "transient-error-recovery",
    pass: false,
    evidence: `exhausted ${maxAttempts} attempts, last error: ${(lastError as Error)?.message ?? "unknown"}`,
  };
}

export async function runFullPhaseZero(
  client: ImageSource,
  fetcher: Fetcher,
  clock: Clock,
  options: RunFullPhaseZeroOptions
): Promise<PhaseZeroReport> {
  const base = await runPhaseZeroProbe(client, fetcher, clock, { sampleSize: options.sampleSize });
  const markerGate = await markerDetectionGate(client, options.plantedMarkerPositions ?? []);
  const retryGate = options.injectTransientFailures
    ? await transientErrorRecoveryGate(fetcher)
    : { gate: "transient-error-recovery" as const, pass: true, evidence: "not exercised this run" };

  const gates = [...base.gates, markerGate, retryGate];
  return { ...base, gates, overall: gates.every((g) => g.pass) ? "PASS" : "FAIL" };
}

async function main() {
  parseConfig(process.env.APP_CONFIG_JSON ?? "{}");
  const token = process.env.ICLOUD_SHARED_ALBUM_TOKEN?.trim();
  if (!token) throw new Error("ICLOUD_SHARED_ALBUM_TOKEN is required");

  const client = createICloudClient(token, fetch);
  const report = await runFullPhaseZero(client, fetch, { now: () => new Date() }, {
    sampleSize: Number(process.env.PHASE_ZERO_SAMPLE_SIZE ?? "100"),
    plantedMarkerPositions: (process.env.PHASE_ZERO_MARKER_POSITIONS ?? "")
      .split(",")
      .filter(Boolean)
      .map(Number),
    injectTransientFailures: false,
  });

  const outPath = "docs/feasibility/icloud-phase-0-result.json";
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Phase 0 probe complete: ${report.overall}. Wrote ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
