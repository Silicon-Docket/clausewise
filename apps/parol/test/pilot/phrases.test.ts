import { describe, expect, it } from "vitest";
import {
  METHOD_LINES,
  PHRASE_KEYS,
  PILOT_PHRASES,
  SYNTHETIC_BANNER,
  calendarSentence,
  expiringNote,
  noDataText,
  percentText,
  pilotEmptyNote,
  resultText,
} from "../../src/pilot/phrases.js";
import type { MeasureRow } from "../../src/pilot/types.js";

const row = (over: Partial<MeasureRow>): MeasureRow => ({
  measure: "completion",
  breakdown: "overall",
  key: "",
  unit: "ratio",
  numerator: 1,
  denominator: 3,
  value: 0.3333,
  min: null,
  max: null,
  status: "value",
  reason: null,
  ...over,
});

/** Every string in a phrase table or the sentences the module builds. */
function allWords(): string[] {
  const out: string[] = [SYNTHETIC_BANNER, ...METHOD_LINES];
  const walk = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(PILOT_PHRASES);
  out.push(
    noDataText(null),
    pilotEmptyNote(0),
    pilotEmptyNote(1),
    pilotEmptyNote(7),
    calendarSentence(null),
    calendarSentence({ startDate: "2026-01-05", endDate: "2026-02-08" }),
    expiringNote(1) ?? "",
    expiringNote(3) ?? "",
  );
  return out;
}

describe("the words cover every id", () => {
  it("has a title, a definition and a denominator sentence for every measure", () => {
    expect(Object.keys(PILOT_PHRASES.measures).sort()).toEqual([...PHRASE_KEYS.measures].sort());
    for (const id of PHRASE_KEYS.measures) {
      const w = PILOT_PHRASES.measures[id];
      expect(w.title.length, id).toBeGreaterThan(3);
      expect(w.definition.length, id).toBeGreaterThan(10);
      expect(w.denominator.length, id).toBeGreaterThan(20);
    }
  });

  it("has a sentence for every reason, population line, phase, series and severity, and no more", () => {
    expect(Object.keys(PILOT_PHRASES.noData).sort()).toEqual([...PHRASE_KEYS.noData].sort());
    expect(Object.keys(PILOT_PHRASES.population).sort()).toEqual(
      [...PHRASE_KEYS.population].sort(),
    );
    expect(Object.keys(PILOT_PHRASES.phases).sort()).toEqual([...PHRASE_KEYS.phases].sort());
    expect(Object.keys(PILOT_PHRASES.series).sort()).toEqual([...PHRASE_KEYS.series].sort());
    expect(Object.keys(PILOT_PHRASES.severities).sort()).toEqual(
      [...PHRASE_KEYS.severities].sort(),
    );
    for (const code of PHRASE_KEYS.population) {
      const sentence = PILOT_PHRASES.population[code];
      expect(sentence.endsWith("."), code).toBe(true);
      expect(sentence.length, code).toBeGreaterThan(30);
    }
  });

  it("gives each measure a distinct title", () => {
    const titles = PHRASE_KEYS.measures.map((id) => PILOT_PHRASES.measures[id].title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("the fixed words, pinned", () => {
  it("is the synthetic banner, word for word", () => {
    expect(SYNTHETIC_BANNER).toBe(
      "SYNTHETIC SCOPE: these figures count what demonstration identities did to synthetic matters. They are not pilot data, not adoption, not accuracy and not time saved.",
    );
    expect(PILOT_PHRASES.syntheticBanner).toBe(SYNTHETIC_BANNER);
  });

  it("is the ten method lines, word for word", () => {
    expect([...METHOD_LINES]).toEqual([
      "These figures count rows the application stored: reviews started, findings, decisions, exports, reports, ratings, timers and reference lists. Nothing is estimated.",
      "Pilot scope: matters not marked synthetic whose creator is not a demonstration identity, and people who are not demonstration identities. Synthetic scope: everything else. This build has demonstration identities only, so the pilot scope is empty here.",
      "Weeks are counted in UTC from the start date. A matter's week is the week its first review started; a timer's week is the week it started. Week 1 is the baseline, week 2 training and shadow mode, weeks 3 to 5 assisted use (document 8).",
      "A matter counts as started when a review was started on it, whatever became of the review, and as exported when a memo was ever exported for it. Repeat usage reads 'started a matter' as 'started a review on it'.",
      "A decision counts while it counts for the memo. A decision that a change to the documents made out of date is not counted, and the population table says how many there are.",
      "Matters deleted by their creator, an administrator or retention have no rows and are in no denominator. The population table counts them from the audit log.",
      "A time is the seconds between pressing Start and pressing Stop. It is not measured attention. A timer left running is not counted. A stopped timer cannot be edited.",
      "Times are medians with the number of NDAs behind them. This page computes no mean, no difference between phases and no saving: documents differ between phases and the group is small.",
      "No figure is given for a person. With a few participants a total can still be recognised: share the file only with the sponsor and the legal engineer.",
      "This page does not judge the acceptance criteria A1 to A7 or recommend go or no-go. The sponsor does, from the numbers and their denominators.",
    ]);
  });

  it("is the three reasons a row has no data, word for word", () => {
    expect(noDataText("no_calendar")).toBe(
      "No pilot calendar is set, so no record can be placed in a pilot week. An administrator sets the start date on this page.",
    );
    expect(noDataText("all_excluded")).toBe(
      "Every matter in this database belongs to the other scope, so there is nothing to count in this one.",
    );
    expect(noDataText("no_denominator")).toBe(
      "Nothing to count yet: no record meets the definition, so there is no denominator.",
    );
    expect(noDataText(null)).toBe(noDataText("no_denominator"));
  });

  it("names the two scopes, the phases and the series", () => {
    expect(PILOT_PHRASES.scopeLinks).toEqual({
      pilot: "Pilot scope",
      synthetic: "Synthetic scope, a demonstration",
    });
    expect(PILOT_PHRASES.scopeNames).toEqual({
      pilot: "pilot scope",
      synthetic: "synthetic scope",
    });
    expect(PILOT_PHRASES.phases).toEqual({
      baseline: "Baseline (week 1)",
      shadow: "Shadow mode (week 2)",
      assisted: "Assisted use (weeks 3 to 5)",
    });
    expect(PILOT_PHRASES.series.reviewer).toBe("Reviewing attorney");
  });
});

describe("sentences built from numbers", () => {
  it("says the first thing about an empty pilot scope, with the number of matters", () => {
    expect(pilotEmptyNote(0)).toBe(
      "No pilot data. This database holds no matters, so the pilot scope is empty and every measure below reads no data.",
    );
    expect(pilotEmptyNote(1)).toBe(
      "No pilot data. This database holds 1 matter and it is synthetic or was made by a demonstration identity, so the pilot scope is empty and every measure below reads no data.",
    );
    expect(pilotEmptyNote(7)).toBe(
      "No pilot data. This database holds 7 matters and every one is synthetic or was made by a demonstration identity, so the pilot scope is empty and every measure below reads no data.",
    );
  });

  it("says when the pilot starts and ends, or that there is no calendar and what to do", () => {
    expect(calendarSentence({ startDate: "2026-01-05", endDate: "2026-02-08" })).toBe(
      "The pilot starts on 2026-01-05 and week 5 ends on 2026-02-08, counted in UTC.",
    );
    expect(calendarSentence(null)).toBe(
      "No pilot calendar is set. Every measure that depends on a pilot week reads no data until one is. An administrator sets the start date on this page.",
    );
  });

  it("warns about matters that will expire, and says nothing when none will", () => {
    expect(expiringNote(0)).toBeNull();
    expect(expiringNote(-1)).toBeNull();
    expect(expiringNote(1)).toBe(
      "1 matter will reach its retention date before the end of the pilot and then disappear from these measures. Download the CSV before then.",
    );
    expect(expiringNote(3)).toBe(
      "3 matters will reach their retention date before the end of the pilot and then disappear from these measures. Download the CSV before then.",
    );
  });

  it("writes a percentage with one decimal, rounded half up, from whole numbers", () => {
    const cases: [number, number, string][] = [
      [1, 3, "33.3"],
      [2, 3, "66.7"],
      [1, 8, "12.5"],
      [1, 16, "6.3"], // 6.25 rounds up
      [1, 24, "4.2"],
      [1, 1, "100.0"],
      [0, 5, "0.0"],
      [13, 16, "81.3"], // 81.25 rounds up
    ];
    for (const [n, d, text] of cases) expect(percentText(n, d), `${n}/${d}`).toBe(text);
  });
});

describe("the result of a row, with its denominator", () => {
  it("writes a ratio as numerator of denominator and a percentage", () => {
    expect(resultText(row({}))).toBe("1 of 3 (33.3%)");
    expect(resultText(row({ numerator: 0, denominator: 1, value: 0 }))).toBe("0 of 1 (0.0%)");
    expect(resultText(row({ numerator: 13, denominator: 16, value: 0.8125 }))).toBe(
      "13 of 16 (81.3%)",
    );
  });

  it("writes reports with the matters they are counted over, and never as a percentage", () => {
    const base = { unit: "reports_per_matter" as const, measure: "missed_issue_rate" as const };
    expect(resultText(row({ ...base, numerator: 2, denominator: 1, value: 2 }))).toBe(
      "2 reports for 1 exported matter",
    );
    expect(resultText(row({ ...base, numerator: 1, denominator: 1, value: 1 }))).toBe(
      "1 report for 1 exported matter",
    );
    expect(resultText(row({ ...base, numerator: 0, denominator: 3, value: 0 }))).toBe(
      "0 reports for 3 exported matters",
    );
  });

  it("writes a median with its n, minimum and maximum", () => {
    const rating = row({
      measure: "satisfaction_rating",
      unit: "rating",
      numerator: null,
      denominator: 2,
      value: 4.5,
      min: 4,
      max: 5,
    });
    expect(resultText(rating)).toBe("4.5 (n = 2, minimum 4, maximum 5)");
    const minutes = row({
      measure: "active_time",
      unit: "minutes",
      numerator: null,
      denominator: 2,
      value: 35,
      min: 25,
      max: 45,
    });
    expect(resultText(minutes)).toBe("35.0 minutes (n = 2, minimum 25.0, maximum 45.0)");
  });

  it("writes No data, with no number, for a row without a value", () => {
    const empty = row({
      numerator: 0,
      denominator: 0,
      value: null,
      status: "no_data",
      reason: "no_denominator",
    });
    expect(resultText(empty)).toBe("No data");
  });
});

describe("what the words may and may not claim", () => {
  it("contains no em dash and no en dash", () => {
    for (const word of allWords()) {
      expect(word.includes(String.fromCharCode(0x2013)), word).toBe(false);
      expect(word.includes(String.fromCharCode(0x2014)), word).toBe(false);
    }
  });

  it("says adoption, accuracy, time saved or saving only to say that the page claims none of them", () => {
    const allowed = new Set([SYNTHETIC_BANNER, METHOD_LINES[7]]);
    for (const word of allWords()) {
      if (/adoption|accuracy|time saved|saving|time-saving/iu.test(word)) {
        expect(allowed.has(word), word).toBe(true);
      }
    }
  });

  it("states no number outside a denominator: the fixed sentences hold only the pilot's own week numbers", () => {
    for (const word of [
      ...Object.values(PILOT_PHRASES.population),
      ...Object.values(PILOT_PHRASES.noData),
      ...Object.values(PILOT_PHRASES.measures).flatMap((w) => [w.definition, w.denominator]),
    ]) {
      const stripped = word.replaceAll("weeks 1 to 5", "").replaceAll("week 5", "");
      expect(/\d/u.test(stripped), word).toBe(false);
    }
  });

  it("uses no word of judgement: the page counts, it does not recommend", () => {
    for (const word of allWords()) {
      expect(word).not.toMatch(/\b(passed|successful|improvement|go-ahead|recommend(?!\s+go))\b/iu);
    }
  });
});
