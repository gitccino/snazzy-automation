import type { ParseResult } from "./types";

const A_ID = /\bA-([1-9]\d*)\b/gi;
const THAI_ID = /รหัส(?:สินค้า)?\s+([1-9]\d*)\b/g;
const PRICE_NUMBER = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)";
const PRICE_END = "(?=\\s*(?:THB\\b|ราคา(?=\\s)|$))";
const THB_PRICE = new RegExp(`\\bTHB\\s+(${PRICE_NUMBER})(?![\\d.,])(?:\\s+บาท)?${PRICE_END}`, "gi");
const THAI_PRICE = new RegExp(`ราคา\\s+(${PRICE_NUMBER})(?![\\d.,])(?:\\s+บาท)?${PRICE_END}`, "g");

function allMatches(text: string, patterns: RegExp[]): string[] {
  return patterns.flatMap((pattern) =>
    Array.from(text.matchAll(new RegExp(pattern.source, pattern.flags)), (match) => match[1]).filter(
      (value): value is string => value !== undefined,
    ),
  );
}

function extractProductIds(text: string): { values: string[]; malformed: boolean } {
  const values = allMatches(text, [A_ID, THAI_ID]).map((digits) => `A-${digits}`);
  const malformed = /\bA\d+\b|\bA\s+\d+\b|\bA-0+\b|รหัส(?:สินค้า)?\s+0+\b/i.test(text);
  return { values, malformed };
}

function extractPrices(text: string): { values: number[]; malformed: boolean } {
  const values = allMatches(text, [THB_PRICE, THAI_PRICE]).map((value) => Number(value.replaceAll(",", "")));
  const prefixCount = Array.from(text.matchAll(/\bTHB\b|ราคา/gi)).length;
  const malformed = prefixCount !== values.length || values.some((value) => !Number.isSafeInteger(value) || value <= 0);
  return { values, malformed };
}

export function parseLineCommand(input: string): ParseResult {
  const text = input.trim();
  if (text === "/help") return { ok: true, command: { type: "help" } };
  if (text === "/upload") return { ok: true, command: { type: "upload" } };
  if (text === "/docs") return { ok: true, command: { type: "docs" } };
  if (text === "/revert") return { ok: true, command: { type: "revert" } };

  if (/^\/search(?:\s|$)/.test(text)) {
    const ids = extractProductIds(text.slice(7));
    if (ids.malformed) return { ok: false, code: "invalid_product_id" };
    if (ids.values.length === 0) return { ok: false, code: "missing_product_id" };
    if (ids.values.length > 1) return { ok: false, code: "multiple_product_ids" };
    return { ok: true, command: { type: "search", productId: ids.values[0]! } };
  }

  if (/^\/soldout(?:\s|$)/.test(text)) {
    const body = text.slice(8);
    const ids = extractProductIds(body);
    if (ids.malformed) return { ok: false, code: "invalid_product_id" };
    if (ids.values.length === 0) return { ok: false, code: "missing_product_id" };
    if (ids.values.length > 1) return { ok: false, code: "multiple_product_ids" };
    const prices = extractPrices(body);
    if (prices.malformed) return { ok: false, code: "invalid_price" };
    if (prices.values.length === 0) return { ok: false, code: "missing_price" };
    if (prices.values.length > 1) return { ok: false, code: "multiple_prices" };
    return { ok: true, command: { type: "soldout", productId: ids.values[0]!, soldPrice: prices.values[0]! } };
  }

  return { ok: false, code: "unknown_command" };
}
