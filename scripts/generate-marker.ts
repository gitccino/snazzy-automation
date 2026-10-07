import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { MARKER_PAYLOAD, IGNORE_MARKER_PAYLOAD } from "../src/import/marker";

export interface GenerateMarkerOptions {
  outPath: string;
  kind?: "product_start" | "ignore_start";
}

export async function generateMarkerSvg({ outPath, kind = "product_start" }: GenerateMarkerOptions): Promise<void> {
  const payload = kind === "ignore_start" ? IGNORE_MARKER_PAYLOAD : MARKER_PAYLOAD;
  const qrSvg = await QRCode.toString(payload, {
    type: "svg",
    margin: 2,
    width: 600,
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="760" viewBox="0 0 700 760">
  <rect width="700" height="760" fill="#ffffff" />
  <g transform="translate(50,40)">${qrSvg}</g>
  <text x="350" y="720" font-family="sans-serif" font-size="24" text-anchor="middle">${payload}</text>
</svg>`;

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, svg, "utf-8");
}

async function main() {
  const args = process.argv.slice(2);
  const kindIndex = args.indexOf("--kind");
  const selected = kindIndex < 0 ? "product" : args[kindIndex + 1];
  if (selected !== "product" && selected !== "ignore") {
    throw new Error("Use --kind product or --kind ignore");
  }
  const kind = selected === "ignore" ? "ignore_start" : "product_start";
  const defaultOut = selected === "ignore" ? "docs/runbooks/ignore-marker-card.svg" : "docs/runbooks/marker-card.svg";
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1] : defaultOut;
  if (!outPath || outPath.startsWith("--")) throw new Error("Use --out followed by an output path");
  await generateMarkerSvg({ outPath, kind });
  console.log(`wrote ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
