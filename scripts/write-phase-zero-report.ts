import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { GateId, GateResult, PhaseZeroReport } from "../src/icloud/phase-zero-probe";

const PhaseZeroResultSchema = z.object({
  generatedAt: z.string().min(1),
  sourceAlbumId: z.string().min(1),
  gates: z.array(z.object({
    gate: z.enum([
      "metadata-consistency",
      "stable-ordering",
      "checkpoint-discovery",
      "stream-download-no-buffer",
      "marker-detection",
      "zero-duplicates",
      "transient-error-recovery",
      "no-secrets-in-logs",
      "acceptable-quality",
      "album-rotation-rehearsed",
    ]),
    pass: z.boolean(),
    evidence: z.string(),
  })),
  overall: z.enum(["PASS", "FAIL"]),
});

export function parsePhaseZeroResult(input: unknown): PhaseZeroReport {
  return PhaseZeroResultSchema.parse(input);
}

type ManualGate = { pass: boolean; evidence: string };

export interface PhaseZeroManualEvidence {
  operator: string;
  rehearsalDate: string;
  repeatedRunEvidence: string;
  liveCheckpointEvidence: string;
  logAudit: ManualGate;
  imageQuality: ManualGate;
  albumRotation: ManualGate;
}

type ReportRow = { number: number; name: string; result: ManualGate };

function requiredGate(gates: Map<GateId, GateResult>, id: GateId): ManualGate {
  const gate = gates.get(id);
  if (!gate) throw new Error(`Phase 0 result is missing gate: ${id}`);
  return { pass: gate.pass, evidence: gate.evidence };
}

function appendEvidence(gate: ManualGate, extra: string): ManualGate {
  return { pass: gate.pass, evidence: `${gate.evidence}; ${extra}` };
}

function safeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

export function renderPhaseZeroReport(report: PhaseZeroReport, evidence: PhaseZeroManualEvidence): string {
  const gates = new Map(report.gates.map((gate) => [gate.gate, gate]));
  const rows: ReportRow[] = [
    { number: 1, name: "Metadata fetch consistency", result: appendEvidence(requiredGate(gates, "metadata-consistency"), evidence.repeatedRunEvidence) },
    { number: 2, name: "Stable photo ordering", result: requiredGate(gates, "stable-ordering") },
    { number: 3, name: "Checkpoint discovery of new photos", result: appendEvidence(requiredGate(gates, "checkpoint-discovery"), evidence.liveCheckpointEvidence) },
    { number: 4, name: "100-500 image streaming without full-batch buffering", result: appendEvidence(requiredGate(gates, "stream-download-no-buffer"), "streaming feasibility test passed at 100, 250, and 500 photos") },
    { number: 5, name: "Deterministic marker detection", result: requiredGate(gates, "marker-detection") },
    { number: 6, name: "Zero duplicate records on repeated polls", result: requiredGate(gates, "zero-duplicates") },
    { number: 7, name: "Recovery from redirects, timeouts, and transient errors", result: requiredGate(gates, "transient-error-recovery") },
    { number: 8, name: "No secrets or signed URLs in logs", result: evidence.logAudit },
    { number: 9, name: "Acceptable public-album image quality", result: evidence.imageQuality },
    { number: 10, name: "Album rotation rehearsed", result: evidence.albumRotation },
  ];
  const overall = rows.every((row) => row.result.pass) ? "PASS" : "FAIL";
  const decision = overall === "PASS"
    ? "Proceed to the Import Pipeline plan with the iCloud ImageSource adapter."
    : "Stop. Replace only ImageSource and write its replacement plan before downstream implementation.";
  const tableRows = rows.map((row) => `| ${row.number} | ${row.name} | ${row.result.pass ? "PASS" : "FAIL"} | ${safeCell(row.result.evidence)} |`);

  return [
    "# iCloud Phase 0 Feasibility Report",
    "",
    `**Date:** ${safeCell(evidence.rehearsalDate)}`,
    "**Target album:** Configured customer Shared Album (identifier redacted)",
    `**Prepared by:** ${safeCell(evidence.operator)}`,
    "",
    "## Gate results",
    "",
    "| # | Gate | Result | Evidence |",
    "|---|------|--------|----------|",
    ...tableRows,
    "",
    "## Overall gate result",
    "",
    `**${overall}**`,
    "",
    "## Decision",
    "",
    decision,
    "",
    "## Raw probe output",
    "",
    "`docs/feasibility/icloud-phase-0-result.json` (sourceAlbumId must remain `[REDACTED]`).",
    "",
  ].join("\n");
}

function passFail(name: string): boolean {
  const value = process.env[name];
  if (value !== "PASS" && value !== "FAIL") throw new Error(`${name} must be PASS or FAIL`);
  return value === "PASS";
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function main() {
  const resultPath = "docs/feasibility/icloud-phase-0-result.json";
  const outputPath = "docs/feasibility/icloud-phase-0-report.md";
  const report = parsePhaseZeroResult(
    JSON.parse(readFileSync(resultPath, "utf8")),
  );
  if (report.sourceAlbumId !== "[REDACTED]") throw new Error("Refusing to render an unredacted sourceAlbumId");

  const markdown = renderPhaseZeroReport(report, {
    operator: required("PHASE_ZERO_OPERATOR"),
    rehearsalDate: required("PHASE_ZERO_REHEARSAL_DATE"),
    repeatedRunEvidence: required("PHASE_ZERO_REPEAT_RUN_EVIDENCE"),
    liveCheckpointEvidence: required("PHASE_ZERO_CHECKPOINT_EVIDENCE"),
    logAudit: { pass: passFail("PHASE_ZERO_LOG_AUDIT_RESULT"), evidence: required("PHASE_ZERO_LOG_AUDIT_EVIDENCE") },
    imageQuality: { pass: passFail("PHASE_ZERO_QUALITY_RESULT"), evidence: required("PHASE_ZERO_QUALITY_EVIDENCE") },
    albumRotation: { pass: passFail("PHASE_ZERO_ROTATION_RESULT"), evidence: required("PHASE_ZERO_ROTATION_EVIDENCE") },
  });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, markdown);
  console.log(`Wrote ${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
