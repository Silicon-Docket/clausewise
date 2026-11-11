import { describe, expect, it } from "vitest";
import {
  calendarEnd,
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
