import { describe, expect, it } from "vitest";
import { computePilotMeasures } from "../../src/pilot/compute.js";
import { CSV_COLUMNS, csvCell, csvFileName, csvNumber, toCsv } from "../../src/pilot/csv.js";
import { presentMeasures } from "../../src/pilot/views.js";
import type { PilotMeasures, PilotRecords, PilotScope } from "../../src/pilot/types.js";
import { AS_OF, f1Records } from "./f1.js";

const SIX = [
  "wrong_status",
  "wrong_evidence",
  "missed_context",
  "bad_fallback",
  "unclear",
  "other",
];

const measuresOf = (records: PilotRecords, scope: PilotScope = "pilot"): PilotMeasures =>
  computePilotMeasures(records, { scope, asOf: AS_OF, reasonCodes: SIX });

/** A reader of the file as a spreadsheet would read it: RFC 4180, CRLF between records. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"' && text.charAt(i + 1) === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text.charAt(i + 1) === "\n") {
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
      i += 1;
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) throw new Error("the file does not end with a line ending");
  return out;
}

const COL = Object.fromEntries(CSV_COLUMNS.map((name, i) => [name, i])) as Record<
  (typeof CSV_COLUMNS)[number],
  number
>;

describe("the file", () => {
  const pilot = measuresOf(f1Records());
  const text = toCsv(pilot);
  const lines = text.split("\r\n");

  it("has the header of CSV_COLUMNS, CRLF line endings, one final CRLF and no byte order mark", () => {
    expect(text.startsWith(CSV_COLUMNS.join(",") + "\r\n")).toBe(true);
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.endsWith("\r\n\r\n")).toBe(false);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text.replaceAll("\r\n", "").includes("\n")).toBe(false);
    expect(text.replaceAll("\r\n", "").includes("\r")).toBe(false);
    expect(lines[lines.length - 1]).toBe("");
    // every cell is plain ASCII in practice
    expect(/^[\x20-\x7e\r\n]*$/u.test(text)).toBe(true);
    expect([...CSV_COLUMNS]).toEqual([
      "scope",
      "calendar_start",
      "as_of",
      "measure",
      "breakdown",
      "key",
      "numerator",
      "denominator",
      "value",
      "unit",
      "min",
      "max",
      "status",
      "reason",
    ]);
  });

  it("has one row per measure row and one per population line, each with the same number of cells", () => {
    const rows = parseCsv(text);
    expect(rows.length).toBe(1 + pilot.rows.length + pilot.population.length);
    for (const row of rows) expect(row.length).toBe(CSV_COLUMNS.length);
  });

  it("carries the scope, the calendar start and the clock on every row", () => {
    for (const scope of ["pilot", "synthetic"] as const) {
      const rows = parseCsv(toCsv(measuresOf(f1Records(), scope))).slice(1);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row[COL.scope]).toBe(scope);
        expect(row[COL.calendar_start]).toBe("2026-01-05");
        expect(row[COL.as_of]).toBe(AS_OF);
      }
    }
    const records = f1Records();
    records.calendar = null;
    for (const row of parseCsv(toCsv(measuresOf(records))).slice(1)) {
      expect(row[COL.calendar_start]).toBe("");
    }
  });

  it("writes lines of the hand-worked rows exactly", () => {
    const want = (line: string): void => expect(lines, line).toContain(line);
    const prefix = `pilot,2026-01-05,${AS_OF}`;
    want(`${prefix},completion,overall,,1,3,0.3333,ratio,,,value,`);
    want(`${prefix},completion,phase,shadow,0,1,0,ratio,,,value,`);
    want(`${prefix},correction_rate,reason_code,wrong_status,1,16,0.0625,ratio,,,value,`);
    want(`${prefix},missed_issue_rate,overall,,2,1,2,reports_per_matter,,,value,`);
    want(`${prefix},satisfaction_rating,overall,,,2,4.5,rating,4,5,value,`);
    want(`${prefix},active_time,series,assisted:associate,,2,35.0,minutes,25.0,45.0,value,`);
    want(`${prefix},active_time,series,baseline:combined,,1,65.0,minutes,65.0,65.0,value,`);
    want(`${prefix},population,count,matters_total,8,,,count,,,value,`);
    want(`${prefix},population,count,audit_matters_deleted,1,,,count,,,value,`);
  });

  it("gives a row with no data an empty value, a reason code and no dash, n/a or zero", () => {
    const prefix = `pilot,2026-01-05,${AS_OF}`;
    expect(lines).toContain(
      `${prefix},completion,phase,baseline,0,0,,ratio,,,no_data,no_denominator`,
    );
    expect(lines).toContain(
      `${prefix},active_time,series,shadow:reviewer,,0,,minutes,,,no_data,no_denominator`,
    );
    const rows = parseCsv(text).slice(1);
    for (const row of rows.filter((r) => r[COL.status] === "no_data")) {
      expect(row[COL.value]).toBe("");
      expect(["no_calendar", "all_excluded", "no_denominator"]).toContain(row[COL.reason]);
    }
    expect(text).not.toMatch(/n\/a|NaN|Infinity|undefined|null/u);
  });

  it("writes no number with a sign, an exponent or a trailing zero beyond a minute's one decimal", () => {
    for (const scope of ["pilot", "synthetic"] as const) {
      const rows = parseCsv(toCsv(measuresOf(f1Records(), scope))).slice(1);
      for (const row of rows) {
        for (const name of ["numerator", "denominator", "value", "min", "max"] as const) {
          const cell = row[COL[name]] ?? "";
          if (cell === "") continue;
          expect(cell, `${row[COL.measure]} ${name}`).toMatch(/^\d+(\.\d+)?$/u);
          if (row[COL.unit] !== "minutes") expect(cell).not.toMatch(/\.\d*0$/u);
          else if (name !== "numerator" && name !== "denominator")
            expect(cell).toMatch(/^\d+\.\d$/u);
        }
      }
    }
  });

  it("gives the same bytes for the same input", () => {
    expect(toCsv(measuresOf(f1Records()))).toBe(text);
  });

  it("holds exactly the rows the page shows", () => {
    const rows = parseCsv(text).slice(1);
    const fromFile = new Set(
      rows
        .filter((r) => r[COL.measure] !== "population")
        .map((r) => `${r[COL.measure]}|${r[COL.breakdown]}|${r[COL.key]}`),
    );
    const fromMeasures = new Set(pilot.rows.map((r) => `${r.measure}|${r.breakdown}|${r.key}`));
    expect(fromFile).toEqual(fromMeasures);
    const populationInFile = rows
      .filter((r) => r[COL.measure] === "population")
      .map((r) => [r[COL.key], Number(r[COL.numerator])]);
    expect(populationInFile).toEqual(pilot.population.map((p) => [p.code, p.count]));
    // the page is built from the same object, so its figures are the file's figures
    const view = presentMeasures(pilot);
    expect(view.population.map((p) => [p.code, p.count])).toEqual(populationInFile);
    expect(view.measures).toBe(pilot);
  });
});

describe("what the file never holds", () => {
  it("has no matter, run, finding or user id, and none of the markers planted in the records", () => {
    const records = f1Records();
    const text = toCsv(measuresOf(records));
    const ids = new Set<string>();
    for (const m of records.matters) ids.add(m.matterId);
    for (const r of records.runs) ids.add(r.runId);
    for (const f of records.findings) ids.add(f.findingId);
    for (const m of records.members) ids.add(m.userId);
    for (const id of ids) {
      expect(text.includes(id), id).toBe(false);
    }
  });
});

describe("csvCell", () => {
  it("writes null as an empty cell and plain text as it is", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell("")).toBe("");
    for (const plain of [
      "abc",
      "1",
      "35.0",
      "a=b",
      "x-y",
      "a+b",
      "ret-1",
      "pds-2",
      "  ",
      "'quoted",
    ]) {
      expect(csvCell(plain), plain).toBe(plain);
    }
  });

  it("quotes a cell with a comma or a quote, and doubles the quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=a,b")).toBe(`"'=a,b"`);
  });

  it("turns a control character into a space, so a cell is one line", () => {
    expect(csvCell("a\u0000b")).toBe("a b");
    expect(csvCell("a\u007fb")).toBe("a b");
    expect(csvCell("a\nb")).toBe("a b");
    expect(csvCell("a\rb")).toBe("a b");
    expect(csvCell("a\u001fb")).toBe("a b");
  });

  // One test for each hostile start. A spreadsheet reads a cell beginning like this as a formula.
  const HOSTILE: [string, string, string][] = [
    ["an equals sign", "=1+1", "'=1+1"],
    ["a plus sign", "+1", "'+1"],
    ["a minus sign", "-1", "'-1"],
    ["an at sign", "@SUM(1)", "'@SUM(1)"],
    ["a tab", "\t=1", "' =1"],
    ["a carriage return", "\r=1", "' =1"],
    ["a space and an equals sign", " =1", "' =1"],
    ["a no-break space and an equals sign", "\u00a0=1", "'\u00a0=1"],
    ["a line feed and an equals sign", "\n=1", "' =1"],
    ["spaces and a minus sign", "   -1", "'   -1"],
    ["a tab and nothing else", "\t", "' "],
    ["a tab and text that is not a formula", "\tabc", "' abc"],
    ["a carriage return and text that is not a formula", "\rabc", "' abc"],
    ["a zero-width no-break space and an at sign", "\ufeff@x", "'\ufeff@x"],
  ];
  for (const [name, hostile, written] of HOSTILE) {
    it(`neutralises a cell that begins with ${name}`, () => {
      expect(csvCell(hostile)).toBe(written);
    });
  }

  it("neutralises a formula with a comma and a quote inside, and still quotes it", () => {
    const cell = csvCell('=HYPERLINK("http://example.invalid","x")');
    expect(cell).toBe(`"'=HYPERLINK(""http://example.invalid"",""x"")"`);
  });
});

describe("hostile rule keys and reason codes do not reach the file as formulas", () => {
  const HOSTILE_KEYS = ["=1+1", "+1", "-1", "@SUM(1)", "\t=1", "\r=1", " =1", "\u00a0=1", "\n=1"];
  const FORMULA = /^[\u0000- \u00a0]*[=+\-@\t\r]/u;

  for (const key of HOSTILE_KEYS) {
    it(`as a rule key: ${JSON.stringify(key)}`, () => {
      const records = f1Records();
      // the key is in the playbook and in a report, so it is in the rule rows
      records.playbooks = [{ versionId: "pb-1", ruleKeys: ["pty-1", key] }];
      records.missedIssues.push({ matterId: "M1", userDemo: false, ruleKey: key });
      const text = toCsv(measuresOf(records));
      const rows = parseCsv(text).slice(1);
      // (the existing dur-1 report is a key "seen" outside the shortened playbook, so it has a row too)
      const known = ["pty-1", "dur-1", "not_covered"];
      const ruleRows = rows.filter(
        (r) => r[COL.breakdown] === "rule" && !known.includes(r[COL.key] ?? ""),
      );
      expect(ruleRows.length).toBe(1);
      expect(ruleRows[0]?.[COL.key]?.startsWith("'")).toBe(true);
      for (const row of rows) {
        for (const cell of row) expect(FORMULA.test(cell), JSON.stringify(cell)).toBe(false);
      }
    });

    it(`as a reason code: ${JSON.stringify(key)}`, () => {
      const records = f1Records();
      const reject = records.decisions.find((d) => d.findingId === "M1-dur-1");
      if (reject === undefined) throw new Error("fixture changed");
      reject.reasonCode = key;
      const text = toCsv(measuresOf(records));
      const rows = parseCsv(text).slice(1);
      const codeRows = rows.filter(
        (r) => r[COL.breakdown] === "reason_code" && !SIX.includes(r[COL.key] ?? ""),
      );
      expect(codeRows.length).toBe(1);
      expect(codeRows[0]?.[COL.key]?.startsWith("'")).toBe(true);
      for (const row of rows) {
        for (const cell of row) expect(FORMULA.test(cell), JSON.stringify(cell)).toBe(false);
      }
    });
  }

  it("is how a guard fails: without the quote the same rows would read as formulas", () => {
    // the check this test file applies to every cell is not vacuous: an unguarded cell fails it
    expect(FORMULA.test("=1+1")).toBe(true);
    expect(FORMULA.test(" -1")).toBe(true);
    expect(FORMULA.test("'=1+1")).toBe(false);
  });
});

describe("csvNumber", () => {
  it("writes whole numbers as they are and decimals with no trailing zero", () => {
    expect(csvNumber(0)).toBe("0");
    expect(csvNumber(2)).toBe("2");
    expect(csvNumber(0.3333)).toBe("0.3333");
    expect(csvNumber(0.125)).toBe("0.125");
    expect(csvNumber(0.0625)).toBe("0.0625");
    expect(csvNumber(4.5)).toBe("4.5");
    expect(csvNumber(1e-9)).toBe("0");
    expect(csvNumber(123456789)).toBe("123456789");
  });

  it("writes minutes with exactly one decimal", () => {
    expect(csvNumber(35, 1)).toBe("35.0");
    expect(csvNumber(17.5, 1)).toBe("17.5");
    expect(csvNumber(0, 1)).toBe("0.0");
  });

  it("refuses a negative number, minus zero, NaN and Infinity", () => {
    for (const bad of [
      -1,
      -0.0001,
      -0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => csvNumber(bad), String(bad)).toThrow(RangeError);
      expect(() => csvCell(bad), String(bad)).toThrow(RangeError);
    }
  });

  it("is never prefixed, because it cannot begin with a minus", () => {
    expect(csvCell(35)).toBe("35");
    expect(csvCell(0.5)).toBe("0.5");
  });
});

describe("the file name", () => {
  const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/; // the pattern of server/routes/shared.ts

  it("names the scope, and spells SYNTHETIC in capitals for the synthetic scope", () => {
    expect(csvFileName("pilot", "2026-02-10T12:00:00.000Z")).toBe(
      "parol-pilot-measures-pilot-2026-02-10.csv",
    );
    expect(csvFileName("synthetic", "2026-02-10T12:00:00.000Z")).toBe(
      "parol-pilot-measures-SYNTHETIC-2026-02-10.csv",
    );
    for (const scope of ["pilot", "synthetic"] as const) {
      expect(SAFE_FILE_NAME.test(csvFileName(scope, AS_OF))).toBe(true);
    }
  });

  it("takes the UTC date of the clock and refuses a clock that is not an ISO time", () => {
    expect(csvFileName("pilot", "2026-02-10T23:59:59.999Z")).toBe(
      "parol-pilot-measures-pilot-2026-02-10.csv",
    );
    expect(() => csvFileName("pilot", "tomorrow")).toThrow(RangeError);
    expect(() => csvFileName("pilot", "../../etc/passwd")).toThrow(RangeError);
  });
});
