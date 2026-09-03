import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import QRCode from "qrcode";

export interface GenerateMarkerOptions {
  outPath: string;
}

const MARKER_PAYLOAD = "SNAZZY_PRODUCT_START_V1";

export async function generateMarkerSvg({ outPath }: GenerateMarkerOptions): Promise<void> {
  const qrSvg = await QRCode.toString(MARKER_PAYLOAD, {
    type: "svg",
    margin: 2,
    width: 600,
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="760" viewBox="0 0 700 760">
  <rect width="700" height="760" fill="#ffffff" />
  <g transform="translate(50,40)">${qrSvg}</g>
  <text x="350" y="720" font-family="sans-serif" font-size="24" text-anchor="middle">${MARKER_PAYLOAD}</text>
</svg>`;

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, svg, "utf-8");
}

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1]! : "docs/runbooks/marker-card.svg";
  await generateMarkerSvg({ outPath });
  console.log(`wrote ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
