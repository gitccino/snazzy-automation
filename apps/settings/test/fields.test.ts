import { expect, it } from "vitest";
import { fromBangkok, toBangkok } from "../src/fields";
import { normalizeGroupIds } from "../../../src/settings/schema";
it("converts Bangkok cutoff to UTC without accepting calendar rollovers", () => {
  expect(fromBangkok("2026-11-11T15:30")).toBe("2026-11-11T08:30:00.000Z");
  expect(toBangkok("2026-11-11T08:30:00.000Z")).toBe("2026-11-11T15:30");
  expect(fromBangkok("")).toBeNull();
  expect(() => fromBangkok("2026-02-30T12:00")).toThrow();
});
it("normalizes group paste and rejects empty entries", () => {
  expect(normalizeGroupIds(" C1, C2\nC1 ")).toEqual(["C1", "C2"]);
  expect(() => normalizeGroupIds("C1,,C2")).toThrow();
});
