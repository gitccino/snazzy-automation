import { describe, expect, it } from "vitest";
import {
  parsePhaseZeroResult,
  renderPhaseZeroReport,
} from "../../scripts/write-phase-zero-report";
import type { PhaseZeroReport } from "../../src/icloud/phase-zero-probe";

const computedGates: PhaseZeroReport["gates"] = [
  { gate: "metadata-consistency", pass: true, evidence: "three polls returned the same 250 IDs" },
  { gate: "stable-ordering", pass: true, evidence: "order matched across all polls" },
  { gate: "checkpoint-discovery", pass: true, evidence: "one new photo appeared after checkpoint" },
  { gate: "stream-download-no-buffer", pass: true, evidence: "250 photos processed one at a time" },
  { gate: "marker-detection", pass: true, evidence: "3/3 photographed markers detected" },
  { gate: "zero-duplicates", pass: true, evidence: "250 unique IDs across repeated polls" },
  { gate: "transient-error-recovery", pass: true, evidence: "recovered after two injected 503 responses" },
];

const report: PhaseZeroReport = {
  generatedAt: "2026-09-01T10:00:00+07:00",
  sourceAlbumId: "[REDACTED]",
  gates: computedGates,
  overall: "PASS",
};

describe("renderPhaseZeroReport", () => {
  it("rejects malformed probe output before rendering", () => {
    expect(() => parsePhaseZeroResult({ overall: "PASS" })).toThrow();
  });

  it("renders all ten gates, computes the final decision, and never includes the album token", () => {
    const markdown = renderPhaseZeroReport(report, {
      operator: "customer operator",
      rehearsalDate: "2026-09-01",
      repeatedRunEvidence: "three live runs completed at 09:00, 13:00, and 18:00 Asia/Bangkok",
      liveCheckpointEvidence: "photo LIVE-CHECKPOINT-1 was discovered after the saved checkpoint",
      logAudit: { pass: true, evidence: "redaction test passed and console output contained no token or signed URL" },
      imageQuality: { pass: true, evidence: "2048px samples retained readable fabric texture and labels" },
      albumRotation: { pass: true, evidence: "rotation test passed and operator reviewed the runbook" },
    });

    expect(markdown.match(/^\| \d+ \|/gm)).toHaveLength(10);
    expect(markdown).toContain("**PASS**");
    expect(markdown).toContain("customer operator");
    expect(markdown).not.toContain("SECRET_ALBUM_TOKEN");
  });
});
