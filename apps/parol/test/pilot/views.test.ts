import { describe, expect, it } from "vitest";
import { computePilotMeasures } from "../../src/pilot/compute.js";
import { PILOT_PHRASES } from "../../src/pilot/phrases.js";
import {
  presentMeasures,
  type PilotMeasuresView,
  type PilotTableView,
} from "../../src/pilot/views.js";
import type { PilotRecords, PilotScope } from "../../src/pilot/types.js";
import { AS_OF, f1Records } from "./f1.js";

const SIX = [
  "wrong_status",
  "wrong_evidence",
  "missed_context",
  "bad_fallback",
  "unclear",
  "other",
];

const view = (records: PilotRecords, scope: PilotScope = "pilot"): PilotMeasuresView =>
  presentMeasures(computePilotMeasures(records, { scope, asOf: AS_OF, reasonCodes: SIX }));

const table = (v: PilotMeasuresView, id: string): PilotTableView => {
  const found = v.tables.find((t) => t.id === id);
  if (found === undefined) throw new Error(`no table ${id}`);
  return found;
};

/** A row as the page shows it: its header, then the text of each cell. */
const texts = (t: PilotTableView): string[][] =>
  t.rows.map((r) => [r.header, ...r.cells.map((c) => c.text)]);

describe("the pilot scope of fixture F1", () => {
  const v = view(f1Records());

  it("heads the page: the title, the scope links, no banner and no empty note", () => {
    expect(v.scope).toBe("pilot");
    expect(v.title).toBe("Pilot measures");
    expect(v.scopeLinks).toEqual([
      { scope: "pilot", label: "Pilot scope", current: true },
      { scope: "synthetic", label: "Synthetic scope, a demonstration", current: false },
    ]);
    expect(v.banner).toBeNull();
    expect(v.emptyNote).toBeNull();
    expect(v.calendar).toEqual({ startDate: "2026-01-05", endDate: "2026-02-08" });
    expect(v.calendarSentence).toBe(
      "The pilot starts on 2026-01-05 and week 5 ends on 2026-02-08, counted in UTC.",
    );
    expect(v.download).toEqual({ label: "Download the CSV of this scope", scope: "pilot" });
    expect(v.method).toEqual(PILOT_PHRASES.method);
    expect(v.phrases).toBe(PILOT_PHRASES);
    expect(v.expiringNote).toBe(
      "2 matters will reach their retention date before the end of the pilot and then disappear from these measures. Download the CSV before then.",
    );
  });

  it("lists the tables in reading order and ends every caption with the name of the scope", () => {
    expect(v.tables.map((t) => t.id)).toEqual([
      "measures",
      "phases",
      "reasons",
      "rules",
      "ratings",
      "shadow",
      "time",
    ]);
    expect(v.tables.map((t) => t.caption)).toEqual([
      "Pilot measures, pilot scope",
      "Run-based measures by pilot phase, pilot scope",
      "Correction rate by reason code, pilot scope",
      "Missed-issue reports by rule, pilot scope",
      "Distribution of the post-matter rating, pilot scope",
      "Shadow-mode agreement by severity of the reference-list issue, pilot scope",
      "Active time, median minutes per NDA, pilot scope",
    ]);
  });

  it("writes the measures table: each result with its numerator, denominator and what the denominator counts", () => {
    const t = table(v, "measures");
    expect(t.columns).toEqual([
      "Measure",
      "Result",
      "Numerator",
      "Denominator",
      "What the denominator counts",
      "Note",
    ]);
    const w = PILOT_PHRASES.measures;
    expect(texts(t)).toEqual([
      ["Completion", "1 of 3 (33.3%)", "1", "3", w.completion.denominator, ""],
      ["Repeat usage", "1 of 2 (50.0%)", "1", "2", w.repeat_usage.denominator, ""],
      ["Correction rate", "2 of 16 (12.5%)", "2", "16", w.correction_rate.denominator, ""],
      [
        "Accepted or minor edit",
        "13 of 16 (81.3%)",
        "13",
        "16",
        w.accepted_or_minor.denominator,
        "",
      ],
      [
        "Missed-issue rate",
        "2 reports for 1 exported matter",
        "2",
        "1",
        w.missed_issue_rate.denominator,
        "",
      ],
      [
        "Escalation by the system",
        "4 of 24 (16.7%)",
        "4",
        "24",
        w.escalation_system.denominator,
        "",
      ],
      [
        "Escalation by reviewers",
        "1 of 24 (4.2%)",
        "1",
        "24",
        w.escalation_reviewer.denominator,
        "",
      ],
      [
        "Escalation by reviewers, decided findings only",
        "1 of 16 (6.3%)",
        "1",
        "16",
        "Decided findings: a finding nobody has decided cannot have been escalated by a reviewer.",
        "",
      ],
      [
        "Satisfaction",
        "4.5 (n = 2, minimum 4, maximum 5)",
        "none (a median)",
        "2",
        w.satisfaction_rating.denominator,
        "",
      ],
      [
        "Response to the rating question",
        "2 of 2 (100.0%)",
        "2",
        "2",
        w.satisfaction_response.denominator,
        "",
      ],
      [
        "Active time",
        "By phase, in the active time table below",
        "none (a median)",
        "per phase",
        w.active_time.denominator,
        "",
      ],
      ["Shadow-mode agreement", "1 of 3 (33.3%)", "1", "3", w.shadow_agreement.denominator, ""],
    ]);
    // the definition of docs/parol/08 sits under each name
    expect(t.rows.map((r) => r.detail)).toEqual([
      w.completion.definition,
      w.repeat_usage.definition,
      w.correction_rate.definition,
      w.accepted_or_minor.definition,
      w.missed_issue_rate.definition,
      w.escalation_system.definition,
      w.escalation_reviewer.definition,
      "Findings escalated by reviewers over findings with a current decision",
      w.satisfaction_rating.definition,
      w.satisfaction_response.definition,
      w.active_time.definition,
      w.shadow_agreement.definition,
    ]);
  });

  it("writes the run-based measures by phase, with No data where a phase had nothing", () => {
    const t = table(v, "phases");
    expect(t.columns).toEqual([
      "Measure",
      "Baseline (week 1)",
      "Shadow mode (week 2)",
      "Assisted use (weeks 3 to 5)",
    ]);
    const none = "No data";
    expect(texts(t)).toEqual([
      ["Completion", none, "0 of 1 (0.0%)", "1 of 2 (50.0%)"],
      ["Correction rate", none, none, "2 of 16 (12.5%)"],
      ["Accepted or minor edit", none, none, "13 of 16 (81.3%)"],
      ["Missed-issue rate", none, none, "2 reports for 1 exported matter"],
      ["Escalation by the system", none, "0 of 8 (0.0%)", "4 of 16 (25.0%)"],
      ["Escalation by reviewers", none, "0 of 8 (0.0%)", "1 of 16 (6.3%)"],
      ["Satisfaction", none, none, "4.5 (n = 2, minimum 4, maximum 5)"],
      ["Response to the rating question", none, none, "2 of 2 (100.0%)"],
    ]);
    const completion = t.rows[0];
    expect(completion?.cells.map((c) => c.noData)).toEqual([true, false, false]);
    expect(completion?.cells[0]?.reason).toBe(PILOT_PHRASES.noData.no_denominator);
    expect(completion?.cells[1]?.reason).toBeNull();
  });

  it("writes the reason codes, the rules, the rating distribution and the severities", () => {
    expect(texts(table(v, "reasons"))).toEqual([
      ["wrong_status", "1 of 16 (6.3%)", "1", "16"],
      ["wrong_evidence", "1 of 16 (6.3%)", "1", "16"],
      ["missed_context", "0 of 16 (0.0%)", "0", "16"],
      ["bad_fallback", "0 of 16 (0.0%)", "0", "16"],
      ["unclear", "0 of 16 (0.0%)", "0", "16"],
      ["other", "0 of 16 (0.0%)", "0", "16"],
    ]);
    const rules = texts(table(v, "rules"));
    expect(rules.map((r) => r[0])).toEqual([
      "pty-1",
      "def-1",
      "exc-1",
      "pds-1",
      "pds-2",
      "dur-1",
      "ret-1",
      "gov-1",
      "No rule covers it",
    ]);
    expect(rules.find((r) => r[0] === "dur-1")).toEqual([
      "dur-1",
      "1 report for 1 exported matter",
      "1",
      "1",
    ]);
    expect(rules.find((r) => r[0] === "pds-1")).toEqual([
      "pds-1",
      "0 reports for 1 exported matter",
      "0",
      "1",
    ]);
    expect(rules[8]).toEqual(["No rule covers it", "1 report for 1 exported matter", "1", "1"]);
    expect(texts(table(v, "ratings"))).toEqual([
      ["Rating 1", "0 of 2 (0.0%)", "0", "2"],
      ["Rating 2", "0 of 2 (0.0%)", "0", "2"],
      ["Rating 3", "0 of 2 (0.0%)", "0", "2"],
      ["Rating 4", "1 of 2 (50.0%)", "1", "2"],
      ["Rating 5", "1 of 2 (50.0%)", "1", "2"],
    ]);
    const shadow = table(v, "shadow");
    expect(texts(shadow)).toEqual([
      ["High", "1 of 2 (50.0%)", "1", "2"],
      ["Medium", "0 of 1 (0.0%)", "0", "1"],
      ["Low", "No data", "0", "0"],
    ]);
    // the high row is the one acceptance criterion A2 reads, and the page does not judge it
    expect(shadow.rows[0]?.detail).toBe(
      "This is the row that acceptance criterion A2 of document 8 reads. This page does not judge it.",
    );
    expect(shadow.rows[1]?.detail).toBeNull();
  });

  it("writes active time as minutes with n, minimum and maximum", () => {
    const t = table(v, "time");
    expect(t.columns).toEqual([
      "Phase and series",
      "Timed NDAs (n)",
      "Median (minutes)",
      "Minimum (minutes)",
      "Maximum (minutes)",
    ]);
    const none = "No data";
    expect(texts(t)).toEqual([
      ["Baseline (week 1), Associate", "1", "45.0", "45.0", "45.0"],
      ["Baseline (week 1), Reviewing attorney", "1", "20.0", "20.0", "20.0"],
      ["Baseline (week 1), Associate and attorney combined", "1", "65.0", "65.0", "65.0"],
      ["Shadow mode (week 2), Associate", "1", "40.0", "40.0", "40.0"],
      ["Shadow mode (week 2), Reviewing attorney", none, none, none, none],
      ["Shadow mode (week 2), Associate and attorney combined", none, none, none, none],
      ["Assisted use (weeks 3 to 5), Associate", "2", "35.0", "25.0", "45.0"],
      ["Assisted use (weeks 3 to 5), Reviewing attorney", "2", "25.0", "15.0", "35.0"],
      ["Assisted use (weeks 3 to 5), Associate and attorney combined", "2", "60.0", "60.0", "60.0"],
    ]);
  });

  it("lists the population with a sentence for each line", () => {
    expect(v.population.length).toBe(29);
    expect(v.population[0]).toEqual({
      code: "matters_total",
      count: 8,
      sentence: "Matters in the database, of every kind, before any scope is applied.",
    });
    expect(v.population.map((p) => p.sentence)).toEqual(
      v.population.map(
        (p) => PILOT_PHRASES.population[p.code as keyof typeof PILOT_PHRASES.population],
      ),
    );
    expect(v.population.find((p) => p.code === "time_entries_counted")?.count).toBe(8);
  });
});

describe("every table is well formed", () => {
  const variants: [string, PilotMeasuresView][] = [
    ["pilot", view(f1Records())],
    ["synthetic", view(f1Records(), "synthetic")],
    ["no calendar", view({ ...f1Records(), calendar: null })],
  ];
  for (const [name, v] of variants) {
    it(`has a cell for every column, distinct ids and no stray word: ${name}`, () => {
      expect(new Set(v.tables.map((t) => t.id)).size).toBe(v.tables.length);
      for (const t of v.tables) {
        expect(t.columns.length, t.id).toBeGreaterThan(1);
        expect(t.rows.length, t.id).toBeGreaterThan(0);
        expect(t.caption.endsWith(`, ${PILOT_PHRASES.scopeNames[v.scope]}`), t.id).toBe(true);
        for (const r of t.rows) {
          expect(r.cells.length, `${t.id} ${r.header}`).toBe(t.columns.length - 1);
          for (const c of r.cells) {
            expect(c.noData, `${t.id} ${r.header}`).toBe(c.reason !== null);
          }
        }
      }
      const words = v.tables.flatMap((t) => [
        t.caption,
        ...t.columns,
        ...t.rows.flatMap((r) => [r.header, r.detail ?? "", ...r.cells.map((c) => c.text)]),
      ]);
      for (const word of words) expect(word).not.toMatch(/NaN|Infinity|undefined|null|-0\b/u);
    });

    it(`states every number with its denominator beside it: ${name}`, () => {
      for (const r of table(v, "measures").rows) {
        const result = r.cells[0];
        if (result === undefined || result.noData || r.header === "Active time") continue;
        expect(result.text, r.header).toMatch(
          / of \d+ \(\d+\.\d%\)$|^\d+ reports? for \d+ exported matters?$|\(n = \d+, minimum \d+, maximum \d+\)$/u,
        );
      }
      for (const t of v.tables) {
        for (const r of t.rows) {
          for (const c of r.cells) {
            if (c.noData) continue;
            // a percentage never stands alone
            expect(
              /%/u.test(c.text) ? / of \d+ \(/u.test(c.text) : true,
              `${t.id} ${r.header} ${c.text}`,
            ).toBe(true);
          }
        }
      }
    });
  }

  it("gives a chip's worth of words to every cell with no data: the text and the reason", () => {
    for (const [, v] of variants) {
      for (const t of v.tables) {
        for (const r of t.rows) {
          for (const c of r.cells) {
            if (c.noData) {
              expect(c.text).toBe("No data");
              expect(Object.values(PILOT_PHRASES.noData)).toContain(c.reason);
            }
          }
        }
      }
    }
  });
});

describe("the synthetic scope", () => {
  const v = view(f1Records(), "synthetic");

  it("carries the banner, the scope in the title and the other link current", () => {
    expect(v.scope).toBe("synthetic");
    expect(v.title).toBe("Pilot measures (synthetic scope)");
    expect(v.banner).toBe(
      "SYNTHETIC SCOPE: these figures count what demonstration identities did to synthetic matters. They are not pilot data, not adoption, not accuracy and not time saved.",
    );
    expect(v.scopeLinks.map((l) => [l.scope, l.current])).toEqual([
      ["pilot", false],
      ["synthetic", true],
    ]);
    expect(v.emptyNote).toBeNull();
    expect(v.download.scope).toBe("synthetic");
    expect(table(v, "measures").caption).toBe("Pilot measures, synthetic scope");
  });

  it("shows what the same code makes of the synthetic records", () => {
    expect(texts(table(v, "measures")).slice(0, 2)).toEqual([
      ["Completion", "1 of 2 (50.0%)", "1", "2", PILOT_PHRASES.measures.completion.denominator, ""],
      [
        "Repeat usage",
        "0 of 1 (0.0%)",
        "0",
        "1",
        PILOT_PHRASES.measures.repeat_usage.denominator,
        "",
      ],
    ]);
    expect(
      texts(table(v, "time")).find((r) => r[0] === "Assisted use (weeks 3 to 5), Associate"),
    ).toEqual(["Assisted use (weeks 3 to 5), Associate", "1", "10.0", "10.0", "10.0"]);
  });
});

describe("a pilot scope with nothing in it", () => {
  const records = f1Records();
  const keep = (id: string): boolean => id === "M6";
  const only: PilotRecords = {
    ...records,
    matters: records.matters.filter((m) => keep(m.matterId)),
    members: records.members.filter((m) => keep(m.matterId)),
    runs: records.runs.filter((r) => keep(r.matterId)),
    findings: records.findings.filter((f) => keep(f.matterId)),
    decisions: records.decisions.filter((d) => keep(d.matterId)),
    staleDecisions: [],
    memos: records.memos.filter((m) => keep(m.matterId)),
    missedIssues: [],
    ratings: [],
    timeEntries: [],
    referenceIssues: [],
    participants: [],
    auditMatters: [],
  };
  const v = view(only);

  it("says first that there is no pilot data, with the number of matters the database holds", () => {
    expect(v.banner).toBeNull();
    expect(v.emptyNote).toBe(
      "No pilot data. This database holds 1 matter and it is synthetic or was made by a demonstration identity, so the pilot scope is empty and every measure below reads no data.",
    );
  });

  it("reads No data on every result, each with the reason it has no data", () => {
    const measures = table(v, "measures");
    for (const r of measures.rows) {
      if (r.header === "Active time") continue;
      expect(r.cells[0]?.text, r.header).toBe("No data");
      expect(r.cells[0]?.reason, r.header).toBe(PILOT_PHRASES.noData.all_excluded);
      // the Note cell says it again in words, beside the numbers
      expect(r.cells[4]?.text, r.header).toBe(PILOT_PHRASES.noData.all_excluded);
    }
    // every other table holds no value either: the results, and the time cells of the last table
    for (const id of ["phases", "reasons", "rules", "ratings", "shadow", "time"]) {
      for (const r of table(v, id).rows) {
        expect(r.cells[0]?.noData, `${id} ${r.header}`).toBe(true);
      }
    }
    for (const t of v.tables) {
      for (const r of t.rows) {
        for (const c of r.cells)
          if (c.noData) expect(c.reason).toBe(PILOT_PHRASES.noData.all_excluded);
      }
    }
  });

  it("says there is no pilot data in words when the database holds no matter at all", () => {
    const empty = view({
      ...only,
      matters: [],
      members: [],
      runs: [],
      findings: [],
      decisions: [],
      memos: [],
    });
    expect(empty.emptyNote).toBe(
      "No pilot data. This database holds no matters, so the pilot scope is empty and every measure below reads no data.",
    );
    expect(table(empty, "measures").rows[0]?.cells[0]?.reason).toBe(
      PILOT_PHRASES.noData.no_denominator,
    );
  });
});

describe("no calendar", () => {
  it("says so, and gives every row the reason that no calendar is set", () => {
    const records = f1Records();
    records.calendar = null;
    const v = view(records);
    expect(v.calendar).toBeNull();
    expect(v.calendarSentence).toBe(
      "No pilot calendar is set. Every measure that depends on a pilot week reads no data until one is. An administrator sets the start date on this page.",
    );
    expect(v.expiringNote).toBeNull();
    for (const r of table(v, "measures").rows) {
      if (r.header === "Active time") continue;
      expect(r.cells[0]?.noData, r.header).toBe(true);
      expect(r.cells[0]?.reason, r.header).toBe(PILOT_PHRASES.noData.no_calendar);
    }
  });
});
