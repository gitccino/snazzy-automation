import type { ParseResult } from "./types";

const PRICE_NUMBER = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)";
const PRICE_CURRENCY = "(?:THB|baht|บาท)";
const PRICE = new RegExp(
  `(?<!\\S)(?:(?:THB|ราคา)\\s*(${PRICE_NUMBER})(?:\\s*${PRICE_CURRENCY})?|(${PRICE_NUMBER})\\s*${PRICE_CURRENCY})(?=\\s|$)`,
  "gi",
);
const PRICE_LABEL = /(?<![A-Za-z])(?:THB|baht)(?![A-Za-z])|บาท|ราคา/i;
const SALE_PRICE = new RegExp(`^ราคาขาย\\s*(${PRICE_NUMBER})(?:\\s*${PRICE_CURRENCY})?(?=\\s|$)`, "i");

function extractProductIds(text: string): { values: string[]; malformed: boolean } {
  // Ignore emoji decoration at token edges; emoji inside an ID remains invalid.
  const undecorated = text.replace(/(?<!\S)[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u200D]+|[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u200D]+(?!\S)/gu, "");
  // Validate entire ID candidates, including additional malformed IDs, not numeric prefixes.
  const candidates = Array.from(undecorated.matchAll(/(?<!\S)A(?:-\S*|\d\S*|\s+\d\S*)|รหัส(?:สินค้า)?\s+\S+/gi), match => match[0]);
  const values: string[] = [];
  let malformed = false;
  for (const candidate of candidates) {
    const match = /^(?:A-?([1-9]\d*)|รหัส(?:สินค้า)?\s+(?:A-?)?([1-9]\d*))$/i.exec(candidate);
    if (match === null) malformed = true;
    else values.push(`A-${match[1] ?? match[2]}`);
  }
  return { values, malformed };
}

function extractPrices(text: string): { values: number[]; malformed: boolean; ambiguous: boolean } {
  const saleLabels = Array.from(text.matchAll(/(?<!\S)ราคาขาย/g));
  if (saleLabels.length > 1) return { values: [], malformed: false, ambiguous: true };
  if (saleLabels.length === 1) {
    const match = SALE_PRICE.exec(text.slice(saleLabels[0]!.index));
    const value = match ? Number(match[1]!.replaceAll(",", "")) : NaN;
    return { values: [value], malformed: !Number.isSafeInteger(value) || value <= 0, ambiguous: false };
  }
  const matches = Array.from(text.matchAll(PRICE));
  const values = matches.map((match) =>
    Number((match[1] ?? match[2]!).replaceAll(",", "")),
  );
  const hasUnparsedLabels = PRICE_LABEL.test(text.replace(PRICE, ""));
  // A valid amount plus other currency text needs clarification, not a decimal warning.
  const ambiguous = values.length > 1 || (values.length > 0 && hasUnparsedLabels);
  const malformed = (hasUnparsedLabels && values.length === 0)
    || matches.some((match) => match[2] !== undefined
      && /[-–—+.,]\s*$/.test(text.slice(0, match.index)))
    || values.some((value) => !Number.isSafeInteger(value) || value <= 0);
  return { values, malformed, ambiguous };
}

export function parseLineCommand(input: string): ParseResult {
  const text = input.trim();
  if (/^\/report(?:\s|$)/.test(text)) {
    if (text === "/report") return { ok: true, command: { type: "report", page: 1 } };
    const match = /^\/report\s+(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+([1-9]\d*))?$/.exec(text);
    if (!match || Number(match[3]) === 0) return { ok: false, code: "invalid_report_command" };
    const reportDate = `${match[3]}-${match[2]!.padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
    const date = new Date(`${reportDate}T00:00:00Z`);
    const page = match[4] === undefined ? 1 : Number(match[4]);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== reportDate || !Number.isSafeInteger(page)) {
      return { ok: false, code: "invalid_report_command" };
    }
    return { ok: true, command: { type: "report", reportDate, page } };
  }
  if (text === "/help") return { ok: true, command: { type: "help" } };
  if (text === "/testupload" || /^\/testupload\s/.test(text)) {
    const match = /^\/testupload(?:\s+([1-9]|10))?$/.exec(text);
    return { ok: true, command: { type: "testupload", caseNumber: match?.[1] ? Number(match[1]) : null } };
  }
  if (text === "/testsearch" || /^\/testsearch\s/.test(text)) {
    const match = /^\/testsearch(?:\s+([1-9]))?$/.exec(text);
    return { ok: true, command: { type: "testsearch", caseNumber: match?.[1] ? Number(match[1]) : null } };
  }
  if (text === "/testsoldout" || /^\/testsoldout\s/.test(text)) {
    const match = /^\/testsoldout(?:\s+([1-9]|1[0-6]))?$/.exec(text);
    return { ok: true, command: { type: "testsoldout", caseNumber: match?.[1] ? Number(match[1]) : null } };
  }
  if (text === "/testreport" || /^\/testreport\s/.test(text)) {
    const match = /^\/testreport(?:\s+([1-9]|1[0-2])(?:\s+([1-3]))?)?$/.exec(text);
    const valid = match && (!match[2] || match[1] === "9");
    return { ok: true, command: { type: "testreport", caseNumber: valid && match[1] ? Number(match[1]) : null, page: valid && match[2] ? Number(match[2]) : 2 } };
  }
  if (text === "/testdocs" || /^\/testdocs\s/.test(text)) {
    const match = /^\/testdocs(?:\s+([1-9]|1[0-3]))?$/.exec(text);
    return { ok: true, command: { type: "testdocs", caseNumber: match?.[1] ? Number(match[1]) : null } };
  }
  if (text === "/upload") return { ok: true, command: { type: "upload" } };
  if (text === "/docs") return { ok: true, command: { type: "docs" } };
  if (/^\/docs\s/.test(text)) {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.slice(5).trim());
    if (!match || Number(match[3]) === 0) return { ok: false, code: "invalid_publication_date" };
    const publicationDate = `${match[3]}-${match[2]!.padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
    const date = new Date(`${publicationDate}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== publicationDate) {
      return { ok: false, code: "invalid_publication_date" };
    }
    return { ok: true, command: { type: "docs", publicationDate } };
  }
  if (text === "/revert") return { ok: true, command: { type: "revert" } };

  if (/^\/search(?:\s|$)/.test(text)) {
    const body = text.slice(7).trim();
    const shortcut = /^(?:a)?([1-9]\d*)$/i.exec(body);
    const ids = extractProductIds(shortcut ? `A-${shortcut[1]}` : body);
    if (ids.malformed) return { ok: false, code: "invalid_product_id" };
    if (ids.values.length === 0) return { ok: false, code: "missing_product_id" };
    if (ids.values.length > 1) return { ok: false, code: "multiple_product_ids" };
    return { ok: true, command: { type: "search", productId: ids.values[0]! } };
  }

  if (/^\/soldout(?:\s|$)/.test(text)) {
    // Pasted messages can contain literal escaped line breaks instead of newlines.
    const body = text.slice(8).replace(/\\r\\n|\\[rn]/g, "\n");
    const ids = extractProductIds(body);
    if (ids.malformed) return { ok: false, code: "invalid_product_id" };
    if (ids.values.length === 0) return { ok: false, code: "missing_product_id" };
    if (ids.values.length > 1) return { ok: false, code: "multiple_product_ids" };
    const prices = extractPrices(body);
    if (prices.malformed) return { ok: false, code: "invalid_price" };
    if (prices.ambiguous) return { ok: false, code: "multiple_prices" };
    if (prices.values.length === 0) return { ok: false, code: "missing_price" };
    return { ok: true, command: { type: "soldout", productId: ids.values[0]!, soldPrice: prices.values[0]! } };
  }

  return { ok: false, code: "unknown_command" };
}
