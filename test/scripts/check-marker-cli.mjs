import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "marker-cli-"));
try {
  for (const kind of ["wrong", ""]) {
    const outPath = path.join(dir, "invalid.svg");
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/generate-marker.ts", "--out", outPath, "--kind", kind], { encoding: "utf-8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Use --kind product or --kind ignore/);
    assert.equal(existsSync(outPath), false);
  }
  console.log("marker CLI validation passed");
} finally { rmSync(dir, { recursive: true, force: true }); }
