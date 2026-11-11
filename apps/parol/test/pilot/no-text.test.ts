import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computePilotMeasures } from "../../src/pilot/compute.js";
import { toCsv } from "../../src/pilot/csv.js";
import { presentMeasures } from "../../src/pilot/views.js";
import type { PilotRecords } from "../../src/pilot/types.js";
import { AS_OF, f1Records } from "./f1.js";

/**
 * Nothing the module reads or writes can hold document text, a name, a note or a reason. Two ways
 * to prove it. The types: every field of the record and result types that can hold a string is on
 * a list of ids, codes, keys and timestamps, so a free-text field cannot be added without editing
 * this test. The behaviour: a marker planted in a field the types do not have never comes out.
 */

/** The string-typed fields of `types.ts` that are an id, a code, a key or a time. */
const ALLOWED_STRING_FIELDS = new Set([
  "matterId",
  "userId",
  "runId",
  "findingId",
  "versionId",
  "playbookVersionId",
  "startedBy",
  "startedAt",
  "stoppedAt",
  "retainUntil",
  "ruleKey",
  "ruleKeys",
  "reasonCode",
  "key",
  "code",
  "asOf",
  "startDate",
  "endDate",
]);

/**
 * `export interface Name { field: type; ... }` blocks: each field whose type is or holds `string`.
 * A field with an object type written inline contributes the string fields inside it.
 */
export function stringFields(source: string): { owner: string; field: string }[] {
  const out: { owner: string; field: string }[] = [];
  let owner: string | null = null;
  for (const line of source.split("\n")) {
    const open = /^export interface (\w+)/u.exec(line);
    if (open !== null) owner = open[1] ?? null;
    else if (line.startsWith("}")) owner = null;
    if (owner === null) continue;
    const field = /^\s{2,}(\w+)\??:\s*(.*)$/u.exec(line);
    if (field === null) continue;
    const type = field[2] ?? "";
    if (type.startsWith("{")) {
      for (const inline of type.matchAll(/\b(\w+):\s*string\b/gu))
        out.push({ owner, field: inline[1] ?? "" });
    } else if (/\bstring\b/u.test(type)) {
      out.push({ owner, field: field[1] ?? "" });
    }
  }
  return out;
}

describe("the record and result types", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../src/pilot/types.ts", import.meta.url)),
    "utf8",
  );

  it("have no string field that is not an id, a code, a key or a time", () => {
    const found = stringFields(source);
    expect(found.length).toBeGreaterThan(20);
    const unlisted = found.filter(({ field }) => !ALLOWED_STRING_FIELDS.has(field));
    expect(unlisted).toEqual([]);
  });

  it("have no field named like text", () => {
    expect(source).not.toMatch(
      /^\s+(name|title|text|note|comment|quote|location|body|content|summary|description|email)\??:/mu,
    );
  });

  it("would catch a text field when one is added", () => {
    const planted = [
      "export interface DecisionRecord {",
      "  findingId: string;",
      "  note: string;",
      "}",
    ].join("\n");
    expect(stringFields(planted).filter(({ field }) => !ALLOWED_STRING_FIELDS.has(field))).toEqual([
      { owner: "DecisionRecord", field: "note" },
    ]);
    const inline = [
      "export interface PilotMeasures {",
      "  calendar: { startDate: string; label: string } | null;",
      "}",
    ].join("\n");
    expect(stringFields(inline).filter(({ field }) => !ALLOWED_STRING_FIELDS.has(field))).toEqual([
      { owner: "PilotMeasures", field: "label" },
    ]);
  });
});

describe("what comes out", () => {
  /** Every record gets extra properties the types do not have, each holding a marker. */
  const plant = (records: PilotRecords): PilotRecords => {
    const marked = <T extends object>(list: T[]): T[] =>
      list.map((item) => ({
        ...item,
        text: "MARKER-TEXT",
        note: "MARKER-NOTE",
        reason: "MARKER-REASON",
        name: "MARKER-NAME",
        title: "MARKER-TITLE",
        quote: "MARKER-QUOTE",
        location: "MARKER-LOCATION",
        editedJson: "MARKER-EDIT",
      }));
    return {
      ...records,
      matters: marked(records.matters),
      members: marked(records.members),
      runs: marked(records.runs),
      findings: marked(records.findings),
      decisions: marked(records.decisions),
      staleDecisions: marked(records.staleDecisions),
      memos: marked(records.memos),
      missedIssues: marked(records.missedIssues),
      ratings: marked(records.ratings),
      timeEntries: marked(records.timeEntries),
      referenceIssues: marked(records.referenceIssues),
      participants: marked(records.participants),
      auditMatters: marked(records.auditMatters),
    };
  };

  it("holds none of the markers, in the measures, the CSV or the page view", () => {
    for (const scope of ["pilot", "synthetic"] as const) {
      const result = computePilotMeasures(plant(f1Records()), { scope, asOf: AS_OF });
      const view = presentMeasures(result);
      for (const output of [JSON.stringify(result), toCsv(result), JSON.stringify(view)]) {
        expect(output).not.toContain("MARKER");
      }
    }
  });

  it("holds no id of a matter, a run, a finding or a person, in the measures or the page view", () => {
    const records = f1Records();
    const ids = new Set<string>();
    for (const m of records.matters) ids.add(m.matterId);
    for (const r of records.runs) ids.add(r.runId);
    for (const f of records.findings) ids.add(f.findingId);
    for (const m of records.members) ids.add(m.userId);
    for (const scope of ["pilot", "synthetic"] as const) {
      const result = computePilotMeasures(records, { scope, asOf: AS_OF });
      const output = JSON.stringify(presentMeasures(result));
      for (const id of ids) {
        // ids such as "M1" or "a1" are short; look for them as whole quoted values
        expect(output.includes(`"${id}"`), id).toBe(false);
      }
    }
  });
});
