import { describe, expect, it } from "vitest";
import {
  UNKNOWN_DATE,
  dateInputValue,
  formatBytes,
  formatDate,
  formatDateTime,
  plural,
  shortHash,
} from "../../src/server/views/format.js";

describe("formatDate", () => {
  it("writes a stated date the way the memo does", () => {
    expect(formatDate("2026-09-15")).toBe("15 September 2026");
    expect(formatDate("2026-02-02")).toBe("2 February 2026");
  });

  it("reads a full ISO time", () => {
    expect(formatDate("2026-11-03T14:05:09.123Z")).toBe("3 November 2026");
  });

  it("applies an offset so the result is the UTC date", () => {
    expect(formatDate("2026-11-03T23:30:00-02:00")).toBe("4 November 2026");
    expect(formatDateTime("2026-11-03T23:30:00-02:00")).toBe("4 November 2026, 01:30 UTC");
  });

  it("gives a fixed phrase for anything it cannot read, and never echoes it", () => {
    for (const bad of [
      "",
      "tomorrow",
      "2026-13-01",
      "2026-02-30",
      "2026-9-15",
      "<b>x</b>",
      "2026-09-15T25:00:00Z",
    ]) {
      expect(formatDate(bad)).toBe(UNKNOWN_DATE);
      expect(formatDateTime(bad)).toBe(UNKNOWN_DATE);
    }
    expect(formatDate(null)).toBe(UNKNOWN_DATE);
    expect(formatDate(undefined)).toBe(UNKNOWN_DATE);
  });

  it("accepts a leap day only in a leap year", () => {
    expect(formatDate("2028-02-29")).toBe("29 February 2028");
    expect(formatDate("2026-02-29")).toBe(UNKNOWN_DATE);
  });
});

describe("formatDateTime", () => {
  it("shows the time in UTC", () => {
    expect(formatDateTime("2026-11-03T14:05:00Z")).toBe("3 November 2026, 14:05 UTC");
    expect(formatDateTime("2026-11-03T04:05:00.000Z")).toBe("3 November 2026, 04:05 UTC");
  });
});

describe("dateInputValue", () => {
  it("passes a plain date and empties everything else", () => {
    expect(dateInputValue("2026-09-15")).toBe("2026-09-15");
    expect(dateInputValue(null)).toBe("");
    expect(dateInputValue("2026-09-15T00:00:00Z")).toBe("");
    expect(dateInputValue('"><script>')).toBe("");
    expect(dateInputValue("2026-02-30")).toBe("");
  });
});

describe("formatBytes", () => {
  it("uses decimal units with at most one decimal place", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(999)).toBe("999 bytes");
    expect(formatBytes(1000)).toBe("1 KB");
    expect(formatBytes(14_200)).toBe("14 KB");
    expect(formatBytes(1_234)).toBe("1.2 KB");
    expect(formatBytes(2_500_000)).toBe("2.5 MB");
    expect(formatBytes(3_000_000_000)).toBe("3 GB");
  });

  it("does not print nonsense for bad input", () => {
    expect(formatBytes(-1)).toBe("unknown size");
    expect(formatBytes(Number.NaN)).toBe("unknown size");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("unknown size");
  });
});

describe("shortHash and plural", () => {
  it("shortens a hex digest and refuses anything else", () => {
    expect(shortHash("51be0c4f9a21d8e3b7")).toBe("51be0c4f");
    expect(shortHash("51be0c4f9a21d8e3b7", 12)).toBe("51be0c4f9a21");
    expect(shortHash('"><script>')).toBe("");
  });

  it("counts", () => {
    expect(plural(1, "finding")).toBe("1 finding");
    expect(plural(0, "finding")).toBe("0 findings");
    expect(plural(2, "match", "matches")).toBe("2 matches");
  });
});
