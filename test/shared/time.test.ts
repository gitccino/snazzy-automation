import { describe, expect, it } from "vitest";
import {
  bangkokDateTimeThai,
  expiryFromNow,
  isPast,
  nowBangkokIso,
} from "../../src/shared/time";

const fixedClock = { now: () => new Date("2026-09-01T10:00:00.000Z") };

describe("nowBangkokIso", () => {
  it("renders the clock's instant in Asia/Bangkok offset", () => {
    // UTC 10:00 -> Bangkok is UTC+7 -> 17:00 local
    expect(nowBangkokIso(fixedClock)).toBe("2026-09-01T17:00:00+07:00");
  });
});

describe("bangkokDateTimeThai", () => {
  it("renders Thai Buddhist-calendar display text with Latin digits", () => {
    expect(bangkokDateTimeThai(fixedClock))
      .toBe("1 กันยายน 2569 17:00");
  });
});

describe("expiryFromNow / isPast", () => {
  it("computes an expiry N minutes ahead and reports it as not yet past", () => {
    const expiry = expiryFromNow(10, fixedClock);
    expect(isPast(expiry, fixedClock)).toBe(false);
  });

  it("reports an expiry as past once the clock advances beyond it", () => {
    const expiry = expiryFromNow(10, fixedClock);
    const laterClock = { now: () => new Date("2026-09-01T10:11:00.000Z") };
    expect(isPast(expiry, laterClock)).toBe(true);
  });
});
