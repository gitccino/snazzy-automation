import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateMarkerSvg } from "../../scripts/generate-marker";

describe("generateMarkerSvg", () => {
  it("writes an SVG file containing an embedded QR image and the payload label", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "marker-"));
    const outPath = path.join(dir, "marker-card.svg");

    await generateMarkerSvg({ outPath });

    expect(existsSync(outPath)).toBe(true);
    const svg = readFileSync(outPath, "utf-8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("SNAZZY_PRODUCT_START_V1");
    rmSync(dir, { recursive: true, force: true });
  });
});


it("generates the ignore payload without a product marker", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ignore-marker-"));
  try {
    const outPath = path.join(dir, "ignore.svg");
    await generateMarkerSvg({ outPath, kind: "ignore_start" });
    const svg = readFileSync(outPath, "utf-8");
    expect(svg).toContain("SNAZZY_IGNORE_START_V1");
    expect(svg).not.toContain("SNAZZY_PRODUCT_START_V1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
