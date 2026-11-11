import { describe, expect, it } from "vitest";
import {
  START_DATE_MAX,
  START_DATE_MIN,
  calendarEnd,
  isUsableStartDate,
  parseInstant,
  parseStartDate,
  phaseOfWeek,
  pilotWeekOf,
  windowEnd,
  windowPosition,
} from "../../src/pilot/calendar.js";

const CAL = { startDate: "2026-01-05" };

describe("the week of a moment", () => {
  it("is week 1 at the start instant and before the start it is outside", () => {
    expect(pilotWeekOf(CAL, "2026-01-05T00:00:00.000Z")).toBe(1);
    expect(windowPosition(CAL, "2026-01-05T00:00:00.000Z")).toBe("within");
    expect(pilotWeekOf(CAL, "2026-01-04T23:59:59.999Z")).toBeNull();
    expect(windowPosition(CAL, "2026-01-04T23:59:59.999Z")).toBe("before");
  });

  it("changes week at the first instant of day 7, 14, 21 and 28", () => {
    const edges: [string, string, number][] = [
      ["2026-01-11T23:59:59.999Z", "2026-01-12T00:00:00.000Z", 1], // day 6 | day 7
      ["2026-01-18T23:59:59.999Z", "2026-01-19T00:00:00.000Z", 2], // day 13 | day 14
      ["2026-01-25T23:59:59.999Z", "2026-01-26T00:00:00.000Z", 3], // day 20 | day 21
      ["2026-02-01T23:59:59.999Z", "2026-02-02T00:00:00.000Z", 4], // day 27 | day 28
    ];
    for (const [last, first, week] of edges) {
      expect(pilotWeekOf(CAL, last)).toBe(week);
      expect(pilotWeekOf(CAL, first)).toBe(week + 1);
    }
  });

  it("ends at the last millisecond of day 34, and day 35 is after the window", () => {
    expect(pilotWeekOf(CAL, "2026-02-08T23:59:59.999Z")).toBe(5);
    expect(windowPosition(CAL, "2026-02-08T23:59:59.999Z")).toBe("within");
    expect(pilotWeekOf(CAL, "2026-02-09T00:00:00.000Z")).toBeNull();
    expect(windowPosition(CAL, "2026-02-09T00:00:00.000Z")).toBe("after");
  });

  it("has no week without a calendar, and says why", () => {
    expect(pilotWeekOf(null, "2026-01-05T00:00:00.000Z")).toBeNull();
    expect(windowPosition(null, "2026-01-05T00:00:00.000Z")).toBe("no_calendar");
  });

  it("counts in UTC: a time zone offset in the text does not exist, and a month end rolls over", () => {
    expect(() => pilotWeekOf(CAL, "2026-01-05T00:00:00+05:00")).toThrow(RangeError);
    // a start date at a month end: week 2 begins on the 7th day after the 29th of December
    expect(pilotWeekOf({ startDate: "2025-12-29" }, "2026-01-04T23:59:59.999Z")).toBe(1);
    expect(pilotWeekOf({ startDate: "2025-12-29" }, "2026-01-05T00:00:00.000Z")).toBe(2);
    // a leap day
    expect(calendarEnd("2028-02-20")).toBe("2028-03-25");
  });
});

describe("the phase of a week", () => {
  it("is baseline, shadow, then assisted for weeks 3 to 5", () => {
    expect([1, 2, 3, 4, 5].map(phaseOfWeek)).toEqual([
      "baseline",
      "shadow",
      "assisted",
      "assisted",
      "assisted",
    ]);
  });

  it("refuses a week that is not 1 to 5", () => {
    for (const week of [0, 6, -1, 1.5, Number.NaN]) {
      expect(() => phaseOfWeek(week)).toThrow(RangeError);
    }
  });
});

describe("the end of the pilot", () => {
  it("is the last day of week 5, inclusive, and the instant after it", () => {
    expect(calendarEnd("2026-01-05")).toBe("2026-02-08");
    expect(windowEnd("2026-01-05")).toBe("2026-02-09T00:00:00.000Z");
    // across a year end
    expect(calendarEnd("2025-12-15")).toBe("2026-01-18");
  });
});

describe("a string that is not a date is a bug and is loud", () => {
  it("refuses an unreal start date, whatever Date.parse would make of it", () => {
    for (const bad of [
      "2026-02-30",
      "2026-13-01",
      "2026-1-5",
      "05-01-2026",
      "",
      "2026-01-05T00:00:00Z",
      " 2026-01-05",
    ]) {
      expect(() => parseStartDate(bad), bad).toThrow(RangeError);
      expect(() => calendarEnd(bad), bad).toThrow(RangeError);
      expect(() => windowPosition({ startDate: bad }, "2026-01-05T00:00:00.000Z"), bad).toThrow(
        RangeError,
      );
    }
  });

  it("refuses a timestamp that is not an ISO time in UTC with a real time of day", () => {
    for (const bad of [
      "yesterday",
      "",
      "2026-01-05",
      "2026-01-05 09:00:00",
      "2026-01-05T09:00:00",
      "2026-01-05T24:00:00.000Z",
      "2026-01-05T09:60:00.000Z",
      "2026-01-05T09:00:60.000Z",
      "2026-02-30T09:00:00.000Z",
      "Jan 5 2026 09:00:00 GMT",
    ]) {
      expect(() => parseInstant(bad), bad).toThrow(RangeError);
      expect(() => windowPosition(CAL, bad), bad).toThrow(RangeError);
    }
  });

  it("reads what the application's own clock writes", () => {
    expect(parseInstant(new Date(Date.UTC(2026, 0, 5, 9, 30, 15, 250)).toISOString())).toBe(
      Date.UTC(2026, 0, 5, 9, 30, 15, 250),
    );
    expect(parseInstant("2026-01-05T09:30:15Z")).toBe(Date.UTC(2026, 0, 5, 9, 30, 15));
  });
});

describe("the start dates the pilot can count from", () => {
  const USABLE = [
    "1000-01-01",
    "1000-12-31",
    "2026-01-05",
    "2026-12-31",
    "2028-02-29",
    "9998-12-31",
    "9999-01-01",
    "9999-11-25",
    "9999-11-26",
  ];
  const UNUSABLE = [
    // Years below 1000, the two-digit ones that a date field posts for a typed "26" included.
    "0000-01-01",
    "0001-01-01",
    "0026-01-05",
    "0099-12-31",
    "0100-01-01",
    "0999-12-30",
    "0999-12-31",
    // A window that leaves year 9999: the last day of week 5 or the first moment after it.
    "9999-11-27",
    "9999-12-01",
    "9999-12-27",
    "9999-12-30",
    "9999-12-31",
    // Not a real day, or not written year-month-day.
    "2026-02-30",
    "2027-02-29",
    "2026-13-01",
    "2026-00-10",
    "2026-1-5",
    "",
    " 2026-01-05",
    "2026-01-05T00:00:00Z",
  ];

  it("are real days from year 1000 whose whole five weeks, and the moment after, end by 9999-12-31", () => {
    for (const date of USABLE) expect(isUsableStartDate(date), date).toBe(true);
    for (const date of UNUSABLE) expect(isUsableStartDate(date), date).toBe(false);
    for (const value of [null, undefined, 20260105, {}, []])
      expect(isUsableStartDate(value), String(value)).toBe(false);
  });

  it("name their own limits, which are the first and the last that are usable", () => {
    expect(START_DATE_MIN).toBe("1000-01-01");
    expect(START_DATE_MAX).toBe("9999-11-26");
    expect(isUsableStartDate(START_DATE_MIN)).toBe(true);
    expect(isUsableStartDate("0999-12-31")).toBe(false);
    expect(isUsableStartDate(START_DATE_MAX)).toBe(true);
    expect(isUsableStartDate("9999-11-27")).toBe(false);
  });

  it("give an end that the module itself can read back, for every date that is usable", () => {
    for (const date of USABLE) {
      expect(() => parseStartDate(date), date).not.toThrow();
      const end = windowEnd(date);
      expect(() => parseInstant(end), date).not.toThrow();
      expect(parseInstant(end) - parseStartDate(date), date).toBe(35 * 86_400_000);
      expect(calendarEnd(date), date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(calendarEnd(START_DATE_MAX)).toBe("9999-12-30");
    expect(windowEnd(START_DATE_MAX)).toBe("9999-12-31T00:00:00.000Z");
    expect(calendarEnd("1000-01-01")).toBe("1000-02-04");
  });

  it("are refused loudly by every function that reads one, and never turned into another year", () => {
    for (const date of UNUSABLE) {
      expect(() => parseStartDate(date), date).toThrow(RangeError);
      expect(() => calendarEnd(date), date).toThrow(RangeError);
      expect(() => windowEnd(date), date).toThrow(RangeError);
      expect(() => windowPosition({ startDate: date }, "2026-01-05T00:00:00.000Z"), date).toThrow(
        RangeError,
      );
    }
  });

  it("are built without the two-digit year mapping: year 26 is year 26 and not 1926", () => {
    // A moment in year 26 is a real moment and reads as itself; Date.UTC would have read 1926.
    const expected = new Date("0026-01-05T09:30:00.000Z").getTime();
    expect(parseInstant("0026-01-05T09:30:00.000Z")).toBe(expected);
    expect(new Date(parseInstant("0026-01-05T09:30:00.000Z")).getUTCFullYear()).toBe(26);
    expect(parseInstant("0099-12-31T00:00:00.000Z")).toBe(
      new Date("0099-12-31T00:00:00.000Z").getTime(),
    );
    // And the leap rules of those years are the proleptic ones: year 4 has a 29th of February.
    expect(parseInstant("0004-02-29T00:00:00.000Z")).toBe(
      new Date("0004-02-29T00:00:00.000Z").getTime(),
    );
    expect(() => parseInstant("0100-02-29T00:00:00.000Z")).toThrow(RangeError);
  });
});
