import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256Hex } from "../../apps/parol/src/canonical.js";
import { buildDataset, readPlaybookFacts, type PlaybookFacts } from "../../fixtures/parol/build.js";
import {
  CALIBRATION_DATASET_LABEL,
  CalibrationError,
  DEV_CASE_SOURCES,
  PAIRS_PER_KIND,
  PAIRS_PER_LABEL,
  SEPARABILITY_LIMITS,
  TOTAL_PAIRS,
  analyzeCalibration,
  buildCalibration,
  buildDefaultCalibration,
  calibrationCases,
  withCalibration,
} from "../../fixtures/parol/calibration.js";
import { CALIBRATION_PAIRS } from "../../fixtures/parol/calibration/pairs.js";
import { CASES, PLAYBOOK_FILE, PLAYBOOK_SLUG } from "../../fixtures/parol/cases.js";
import { D13 } from "../../fixtures/parol/cases/d13.js";
import { expandDocument } from "../../fixtures/parol/render.js";
import {
  CALIBRATION_KINDS,
  type CalibrationFile,
  type CalibrationPairSpec,
  type CaseDefinition,
  type SplitsFile,
} from "../../fixtures/parol/types.js";
import { loadDataset } from "../src/parol/dataset.js";
import { THRESHOLDS } from "../src/parol/gates.js";
import { scoreCalibration } from "../src/parol/suites.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(ROOT, "fixtures", "parol");
const YAML = readFileSync(join(ROOT, PLAYBOOK_FILE), "utf8");
const facts: PlaybookFacts = readPlaybookFacts(YAML, PLAYBOOK_SLUG);

const PAIRS = CALIBRATION_PAIRS;
const ofLabel = (label: CalibrationPairSpec["label"]) =>
  PAIRS.filter((pair) => pair.label === label);

/** The held-out cases as they are written, so that no pair can be built from one unnoticed. */
let heldout: CaseDefinition[] = [];
beforeAll(async () => {
  const dir = join(FIXTURES, "cases");
  const loaded: CaseDefinition[] = [];
  for (const name of readdirSync(dir).filter((file) => /^h\d\d\.ts$/.test(file))) {
    const module = (await import(pathToFileURL(join(dir, name)).href)) as Record<string, unknown>;
    const found = Object.values(module).find(
      (value): value is CaseDefinition =>
        typeof value === "object" && value !== null && "case" in value && "documents" in value,
    );
    if (found !== undefined) loaded.push(found);
  }
  heldout = loaded;
});

const allCases = (): CaseDefinition[] => [...calibrationCases(CASES), ...heldout];

function analyze(pairs: readonly CalibrationPairSpec[], extraCases: CaseDefinition[] = []) {
  return analyzeCalibration({
    pairs,
    cases: [...allCases(), ...extraCases],
    facts,
  });
}

/** The shipped pairs with one changed. The ids stay as they are. */
function changed(id: string, edit: (pair: CalibrationPairSpec) => void): CalibrationPairSpec[] {
  return PAIRS.map((pair) => {
    if (pair.id !== id) return pair;
    const copy = structuredClone(pair) as CalibrationPairSpec;
    edit(copy);
    return copy;
  });
}

const problemsOf = (pairs: readonly CalibrationPairSpec[], extra: CaseDefinition[] = []): string =>
  analyze(pairs, extra).problems.join("\n");

const words = (text: string): string[] => text.split(/\s+/).filter((word) => word !== "");
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1
    ? (sorted[(sorted.length - 1) / 2] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

describe("the shipped calibration set", () => {
  it("is exactly 40 pairs, 20 of each label, with ids CAL-01 to CAL-40 in file order", () => {
    expect(PAIRS).toHaveLength(TOTAL_PAIRS);
    expect(TOTAL_PAIRS).toBe(40);
    expect(ofLabel("supported")).toHaveLength(20);
    expect(ofLabel("unsupported")).toHaveLength(20);
    expect(PAIRS.map((pair) => pair.id)).toEqual(
      Array.from({ length: 40 }, (_, i) => `CAL-${String(i + 1).padStart(2, "0")}`),
    );
    expect(new Set(PAIRS.map((pair) => pair.id)).size).toBe(40);
  });

  it("is what gate G11 reads: exactly 20 pairs of each label, scored by kind", () => {
    expect(PAIRS_PER_LABEL).toBe(THRESHOLDS.calibrationPairsPerLabel);
    const result = scoreCalibration(
      PAIRS.map((pair) => ({
        label: pair.label,
        verdict: pair.label === "supported" ? ("supported" as const) : ("not_supported" as const),
        ...(pair.kind === undefined ? {} : { kind: pair.kind }),
      })),
    );
    expect(result.catchRate.denominator).toBe(THRESHOLDS.calibrationPairsPerLabel);
    expect(result.falseAlarmRate.denominator).toBe(THRESHOLDS.calibrationPairsPerLabel);
    expect(Object.keys(result.catchByKind).sort()).toEqual([...CALIBRATION_KINDS].sort());
    for (const rate of Object.values(result.catchByKind)) {
      expect(rate.denominator).toBe(PAIRS_PER_KIND);
    }
  });

  it("has five kinds of unsupported pair, four each, and no kind on a supported pair", () => {
    for (const kind of CALIBRATION_KINDS) {
      expect(PAIRS.filter((pair) => pair.kind === kind)).toHaveLength(4);
    }
    expect(ofLabel("unsupported").every((pair) => pair.kind !== undefined)).toBe(true);
    expect(ofLabel("supported").every((pair) => pair.kind === undefined)).toBe(true);
    expect(
      ofLabel("unsupported")
        .map((pair) => pair.kind)
        .sort(),
    ).toEqual(CALIBRATION_KINDS.flatMap((kind) => Array<string>(4).fill(kind)).sort());
  });

  it("passes the validator with no problem, against the registered and the unregistered development cases and every held-out case", () => {
    expect(heldout.length).toBeGreaterThan(0);
    const analysis = analyze(PAIRS);
    expect(analysis.problems).toEqual([]);
    expect(analysis.pairs).toHaveLength(40);
    expect(analysis.counts).toEqual({
      pairs: 40,
      supported: 20,
      unsupported: 20,
      byKind: {
        superseded: 4,
        overlooked_exception: 4,
        other_party_obligation: 4,
        definition_as_duty: 4,
        wrong_frame: 4,
      },
    });
  });

  it("is built from development cases only, and uses the eight cases of the second batch", () => {
    const dev = new Set(DEV_CASE_SOURCES.map((definition) => definition.case));
    expect(dev.size).toBe(14);
    expect(
      DEV_CASE_SOURCES.every(
        (definition) => definition.split === "dev" && /^PAROL-D\d\d$/.test(definition.case),
      ),
    ).toBe(true);
    for (const pair of PAIRS) expect(dev.has(pair.case), pair.id).toBe(true);
    const used = new Set(PAIRS.map((pair) => pair.case));
    for (const key of [
      "PAROL-D02",
      "PAROL-D04",
      "PAROL-D07",
      "PAROL-D09",
      "PAROL-D10",
      "PAROL-D11",
      "PAROL-D13",
      "PAROL-D14",
    ]) {
      expect(used.has(key), key).toBe(true);
    }
  });

  it("copies nothing from a held-out document: no cited paragraph is word for word in one, and no long quote occurs in one", () => {
    const heldoutText = heldout.flatMap((definition) =>
      definition.documents.flatMap((doc) => expandDocument(doc).map((paragraph) => paragraph.text)),
    );
    expect(heldoutText.length).toBeGreaterThan(100);
    const analysis = analyze(PAIRS);
    for (const pair of analysis.pairs) {
      const definition = calibrationCases(CASES).find((candidate) => candidate.case === pair.case)!;
      const doc = definition.documents.find(
        (candidate) => candidate.label === pair.evidence.doc && candidate.operative !== false,
      )!;
      const paragraph = expandDocument(doc)[pair.evidence.paragraph]!.text;
      expect(heldoutText.includes(paragraph), `${pair.id} paragraph`).toBe(false);
      expect(
        heldoutText.some((text) => text.includes(pair.evidence.quote)),
        `${pair.id} quote`,
      ).toBe(false);
    }
  });

  it("cites every quote exactly once, in the clause it names, in the paragraph the key records", () => {
    const analysis = analyze(PAIRS);
    for (const pair of analysis.pairs) {
      const definition = calibrationCases(CASES).find((candidate) => candidate.case === pair.case)!;
      const doc = definition.documents.find(
        (candidate) => candidate.label === pair.evidence.doc && candidate.operative !== false,
      )!;
      const inClause = expandDocument(doc).filter(
        (paragraph) => paragraph.clause === pair.evidence.clause,
      );
      // Counted another way than the validator counts: by splitting at every overlapping start.
      let count = 0;
      for (const paragraph of inClause) {
        for (let i = 0; i + pair.evidence.quote.length <= paragraph.text.length; i += 1) {
          if (paragraph.text.startsWith(pair.evidence.quote, i)) count += 1;
        }
      }
      expect(count, pair.id).toBe(1);
      const holder = inClause.find((paragraph) => paragraph.text.includes(pair.evidence.quote))!;
      expect(holder.index, pair.id).toBe(pair.evidence.paragraph);
      expect(holder.injected, pair.id).toBe(false);
    }
  });

  it("only uses the statuses the support check runs for, with the discrepancy the schema expects, and rules of the playbook", () => {
    for (const pair of PAIRS) {
      expect(["compliant", "deviation"], pair.id).toContain(pair.claim.status);
      expect(pair.claim.discrepancy === "", pair.id).toBe(pair.claim.status === "compliant");
      expect(facts.ruleKeys, pair.id).toContain(pair.rule);
      expect(pair.claim.explanation.length, pair.id).toBeGreaterThan(40);
      expect(pair.note.length, pair.id).toBeGreaterThan(40);
    }
    // pty-1 depends on the intake, which the checker is never shown.
    expect(PAIRS.some((pair) => pair.rule === "pty-1")).toBe(false);
  });

  it("has no dash of any kind in any text, and no line break", () => {
    for (const pair of PAIRS) {
      const text = [
        pair.id,
        pair.note,
        pair.claim.discrepancy,
        pair.claim.explanation,
        pair.evidence.quote,
      ].join("\n");
      expect(/[\u2010-\u2015\u2212]/.test(text), pair.id).toBe(false);
      for (const field of [pair.note, pair.claim.discrepancy, pair.claim.explanation]) {
        expect(field.includes("\n"), pair.id).toBe(false);
      }
    }
    const source = readFileSync(join(FIXTURES, "calibration", "pairs.ts"), "utf8");
    expect(/[\u2010-\u2015\u2212]/.test(source)).toBe(false);
  });

  it("does not give the label away by the length of the quote", () => {
    const quoteWords = (label: CalibrationPairSpec["label"]): number[] =>
      ofLabel(label).map((pair) => words(pair.evidence.quote).length);
    const supported = quoteWords("supported");
    const unsupported = quoteWords("unsupported");
    // The two labels cover the same range, each reaching into the other's middle half.
    expect(Math.min(...supported)).toBeLessThanOrEqual(median(unsupported));
    expect(Math.min(...unsupported)).toBeLessThanOrEqual(median(supported));
    expect(Math.max(...supported)).toBeGreaterThanOrEqual(median(unsupported));
    expect(Math.max(...unsupported)).toBeGreaterThanOrEqual(median(supported));
    const gap =
      Math.abs(median(supported) - median(unsupported)) /
      Math.max(median(supported), median(unsupported));
    expect(gap).toBeLessThanOrEqual(SEPARABILITY_LIMITS.quoteMedianGap);
    const { separability } = analyze(PAIRS);
    expect(separability.thresholdAccuracy.quoteWords).toBeLessThanOrEqual(0.7);
    expect(separability.thresholdAccuracy.quoteCharacters).toBeLessThanOrEqual(0.7);
    expect(separability.thresholdAccuracy.explanationWords).toBeLessThanOrEqual(0.75);
  });

  it("does not give the label away by the wording of the quote: no word of five or more quotes belongs to one label", () => {
    const { separability } = analyze(PAIRS);
    expect(separability.quoteWordCounts.length).toBeGreaterThan(15);
    expect(separability.cueWords).toEqual([]);
    for (const cue of separability.quoteWordCounts) {
      const share = cue.unsupported / cue.pairs;
      expect(share, cue.token).toBeGreaterThanOrEqual(SEPARABILITY_LIMITS.cueBand[0]);
      expect(share, cue.token).toBeLessThanOrEqual(SEPARABILITY_LIMITS.cueBand[1]);
    }
    // Words that signal an exception, a condition or an obligation, whether or not they are
    // frequent enough for the validator's band, are in quotes of both labels.
    for (const word of ["except", "shall", "may", "not", "any", "years", "days", "notice"]) {
      const pattern = new RegExp(`\\b${word}\\b`, "i");
      const inLabel = (label: CalibrationPairSpec["label"]): number =>
        ofLabel(label).filter((pair) => pattern.test(pair.evidence.quote)).length;
      expect(inLabel("supported"), `${word} in a supported quote`).toBeGreaterThan(0);
      expect(inLabel("unsupported"), `${word} in an unsupported quote`).toBeGreaterThan(0);
    }
  });

  it("does not give the label away by the rule, the status or the order", () => {
    const { separability } = analyze(PAIRS);
    expect(separability.majorityAccuracy.rule).toBeLessThanOrEqual(
      SEPARABILITY_LIMITS.ruleAccuracy,
    );
    expect(separability.majorityAccuracy.status).toBeLessThanOrEqual(
      SEPARABILITY_LIMITS.statusAccuracy,
    );
    expect(separability.longestLabelRun).toBeLessThanOrEqual(SEPARABILITY_LIMITS.longestLabelRun);
    for (const status of ["compliant", "deviation"]) {
      expect(separability.byStatus[status]!.supported, status).toBeGreaterThanOrEqual(8);
      expect(separability.byStatus[status]!.unsupported, status).toBeGreaterThanOrEqual(5);
    }
    // Neighbours differ in label often enough, in kind and in case.
    for (let i = 1; i < PAIRS.length; i += 1) {
      expect(PAIRS[i]!.case, PAIRS[i]!.id).not.toBe(PAIRS[i - 1]!.case);
    }
  });

  it("cites the same paragraph in a supported and an unsupported pair at least four times, so the paragraph cannot tell the label", () => {
    expect(analyze(PAIRS).separability.sharedParagraphs).toBeGreaterThanOrEqual(4);
  });

  it("says what the checker is shown, and names the one pair that its paragraph cannot catch", () => {
    const source = readFileSync(join(FIXTURES, "calibration", "pairs.ts"), "utf8");
    expect(source).toContain("not the explanation");
    // The pair whose paragraph cannot show the deletion is named in its note.
    const deleted = PAIRS.find(
      (pair) => pair.case === "PAROL-D05" && pair.rule === "dur-1" && pair.kind === "superseded",
    )!;
    expect(deleted.note).toContain("no reading of the cited paragraph can catch");
  });
});

describe("the validator refuses", () => {
  it("a set that is not 40 pairs", () => {
    const problems = problemsOf(PAIRS.slice(0, 39));
    expect(problems).toContain("it holds 39 pairs, and the calibration set is exactly 40");
    expect(problems).toContain(
      "it holds 20 supported and 19 unsupported pairs, and gate G11 reads exactly 20 of each",
    );
  });

  it("20 of the wrong labels: 19 supported and 21 unsupported", () => {
    const supportedId = ofLabel("supported")[0]!.id;
    const problems = problemsOf(
      changed(supportedId, (pair) => {
        pair.label = "unsupported";
        pair.kind = "superseded";
      }),
    );
    expect(problems).toContain("it holds 19 supported and 21 unsupported pairs");
    expect(problems).toContain("it holds 5 unsupported pairs of kind superseded, not 4");
  });

  it("an unsupported pair of one kind too many and another too few", () => {
    const unsupported = ofLabel("unsupported").find((pair) => pair.kind === "wrong_frame")!;
    const problems = problemsOf(changed(unsupported.id, (pair) => (pair.kind = "superseded")));
    expect(problems).toContain("5 unsupported pairs of kind superseded");
    expect(problems).toContain("3 unsupported pairs of kind wrong_frame");
  });

  it("a supported pair with a kind and an unsupported pair without one", () => {
    const supported = ofLabel("supported")[0]!;
    const unsupported = ofLabel("unsupported")[0]!;
    expect(problemsOf(changed(supported.id, (pair) => (pair.kind = "wrong_frame")))).toContain(
      `${supported.id}: a supported pair has a kind`,
    );
    expect(problemsOf(changed(unsupported.id, (pair) => delete pair.kind))).toContain(
      `${unsupported.id}: an unsupported pair has no kind`,
    );
  });

  it("ids that repeat, that are not CAL-nn, or that are out of order", () => {
    expect(problemsOf(changed("CAL-02", (pair) => (pair.id = "CAL-01")))).toContain(
      "CAL-01: the id is used twice",
    );
    expect(problemsOf(changed("CAL-02", (pair) => (pair.id = "PAIR-2")))).toContain(
      "pair 2: the id is not CAL-01 and up",
    );
    expect(problemsOf([PAIRS[1]!, PAIRS[0]!, ...PAIRS.slice(2)])).toContain(
      "CAL-02: the id is out of order: pair 1 of the file should be CAL-01",
    );
  });

  it("a case that is unknown, or a held-out case", () => {
    expect(problemsOf(changed("CAL-01", (pair) => (pair.case = "PAROL-D99")))).toContain(
      "CAL-01: the case is not known",
    );
    // A pair pointed at a held-out case: the case is known and refused, and its documents are not read.
    const first = heldout.find((definition) => definition.case === "PAROL-H01");
    expect(first).toBeDefined();
    expect(problemsOf(changed("CAL-01", (pair) => (pair.case = "PAROL-H01")))).toContain(
      "CAL-01: the case is not a development case, and no pair may be built from a held-out document",
    );
    // A development case that claims the held-out split is refused too.
    const mislabelled = structuredClone(D13);
    mislabelled.split = "heldout";
    const withMislabelled = calibrationCases(CASES).map((definition) =>
      definition.case === "PAROL-D13" ? mislabelled : definition,
    );
    expect(
      analyzeCalibration({
        pairs: changed("CAL-01", () => undefined),
        cases: withMislabelled,
        facts,
      }).problems.join("\n"),
    ).toContain("CAL-01: the case is not a development case");
  });

  it("a cited paragraph that is word for word a paragraph of a held-out case", () => {
    const twin = structuredClone(D13);
    twin.case = "PAROL-H99";
    twin.split = "heldout";
    expect(problemsOf(PAIRS, [twin])).toContain(
      "the cited paragraph is word for word a paragraph of the held-out case PAROL-H99",
    );
  });

  it("a rule that is not in the playbook, and a status the support check does not run for", () => {
    expect(problemsOf(changed("CAL-01", (pair) => (pair.rule = "lia-9")))).toContain(
      "CAL-01: the rule is not a rule of the playbook",
    );
    expect(
      problemsOf(
        changed("CAL-01", (pair) => {
          (pair.claim as { status: string }).status = "undetermined";
        }),
      ),
    ).toContain("CAL-01: the status is not compliant or deviation");
  });

  it("a compliant claim with a discrepancy and a deviation without one", () => {
    const compliant = PAIRS.find((pair) => pair.claim.status === "compliant")!;
    const deviation = PAIRS.find((pair) => pair.claim.status === "deviation")!;
    expect(
      problemsOf(changed(compliant.id, (pair) => (pair.claim.discrepancy = "Something differs."))),
    ).toContain(`${compliant.id}: a compliant claim has a discrepancy`);
    expect(problemsOf(changed(deviation.id, (pair) => (pair.claim.discrepancy = "")))).toContain(
      `${deviation.id}: a deviation claim has no discrepancy`,
    );
  });

  it("a quote that does not occur, or occurs twice", () => {
    expect(
      problemsOf(
        changed("CAL-01", (pair) => (pair.evidence.quote = "words that are not in the clause")),
      ),
    ).toContain("CAL-01: the quote occurs 0 times in D1 clause 1.2, not exactly once");
    // "the" is in the clause more than once.
    expect(problemsOf(changed("CAL-01", (pair) => (pair.evidence.quote = "the")))).toMatch(
      /CAL-01: the quote occurs \d+ times in D1 clause 1\.2, not exactly once/,
    );
  });

  it("a quote from the wrong clause, from a clause that does not exist and from a document the case lacks", () => {
    expect(problemsOf(changed("CAL-01", (pair) => (pair.evidence.clause = "1.1")))).toContain(
      "CAL-01: the quote occurs 0 times in D1 clause 1.1",
    );
    expect(problemsOf(changed("CAL-01", (pair) => (pair.evidence.clause = "9.9")))).toContain(
      "CAL-01: D1 clause 9.9 has no paragraph",
    );
    expect(problemsOf(changed("CAL-01", (pair) => (pair.evidence.doc = "D3")))).toContain(
      "CAL-01: the case has no operative document D3",
    );
  });

  it("a quote that is only in a superseded version of a document, because anchors resolve in the operative one", () => {
    const d09 = PAIRS.find((pair) => pair.case === "PAROL-D09" && pair.rule === "dur-1")!;
    // Version 1 of PAROL-D09 ends the duties three years after the item was given; version 2, which
    // governs, makes them perpetual.
    const problems = problemsOf(
      changed(d09.id, (pair) => {
        pair.evidence.clause = "5.1";
        pair.evidence.quote =
          "end three (3) years after the date on which the Provider gave that item";
      }),
    );
    expect(problems).toContain(
      `${d09.id}: the quote occurs 0 times in D1 clause 5.1, not exactly once`,
    );
  });

  it("a quote in an injected paragraph", () => {
    const problems = problemsOf(
      changed("CAL-12", (pair) => {
        pair.case = "PAROL-D10";
        pair.evidence.clause = "9.3";
        pair.evidence.quote = "the terms agreed in the";
      }),
    );
    expect(problems).toContain("CAL-12: the quote is in an injected paragraph of D1 clause 9.3");
  });

  it("a superseded pair in a case with no amendment", () => {
    const problems = problemsOf(
      changed("CAL-12", (pair) => {
        pair.label = "unsupported";
        pair.kind = "superseded";
      }),
    );
    expect(problems).toContain("CAL-12: a superseded pair needs a case with an amendment");
  });

  it("two pairs that cite the same quote for the same rule and status", () => {
    const first = PAIRS[0]!;
    const copy = structuredClone(first) as CalibrationPairSpec;
    copy.id = "CAL-41";
    const problems = problemsOf([...PAIRS, copy]);
    expect(problems).toContain(
      "CAL-41: it cites the same quote for the same rule and status as CAL-01",
    );
  });

  it("a dash, a control character and white space at an end", () => {
    const dash = String.fromCharCode(0x2014);
    expect(
      problemsOf(
        changed("CAL-01", (pair) => (pair.claim.explanation = `A reading ${dash} of the clause.`)),
      ),
    ).toContain("CAL-01: claim.explanation contains an en dash, an em dash or another dash");
    expect(problemsOf(changed("CAL-01", (pair) => (pair.note = `${pair.note}\n`)))).toContain(
      "CAL-01: note has white space at an end",
    );
    expect(
      problemsOf(
        changed("CAL-01", (pair) => (pair.claim.explanation = "Two\nlines of text in one.")),
      ),
    ).toContain("CAL-01: claim.explanation contains a control character or a line break");
    expect(problemsOf(changed("CAL-01", (pair) => (pair.note = "")))).toContain(
      "CAL-01: note is empty",
    );
  });

  it("a set whose unsupported quotes are all short", () => {
    const sorted = PAIRS.map((pair) => {
      const copy = structuredClone(pair) as CalibrationPairSpec;
      if (copy.label === "unsupported") copy.evidence.quote = copy.evidence.quote.split(" ")[0]!;
      return copy;
    });
    const problems = problemsOf(sorted);
    expect(problems).toContain(
      "separability: a length threshold on the quote in words tells the label",
    );
    expect(problems).toContain("the median quote has");
  });

  it("a set in which one word belongs to one label", () => {
    const cued = PAIRS.map((pair) => {
      const copy = structuredClone(pair) as CalibrationPairSpec;
      if (copy.label === "unsupported") copy.evidence.quote = `${copy.evidence.quote} zebra`;
      return copy;
    });
    expect(problemsOf(cued)).toContain(
      'the word "zebra" is in 20 quotes and 20 of them are unsupported',
    );
  });

  it("a set whose order tells the label", () => {
    const ordered = [...ofLabel("supported"), ...ofLabel("unsupported")].map((pair, i) => ({
      ...pair,
      id: `CAL-${String(i + 1).padStart(2, "0")}`,
    }));
    expect(problemsOf(ordered)).toContain("20 pairs in a row have the same label");
  });

  it("a set whose rule or status tells the label", () => {
    const skewed = PAIRS.map((pair) => {
      const copy = structuredClone(pair) as CalibrationPairSpec;
      copy.rule = copy.label === "supported" ? "dur-1" : "ret-1";
      copy.claim.status = copy.label === "supported" ? "compliant" : "deviation";
      copy.claim.discrepancy =
        copy.label === "supported" ? "" : "The clause differs from the standard.";
      return copy;
    });
    const problems = problemsOf(skewed);
    expect(problems).toContain("the rule alone tells the label 100% of the time");
    expect(problems).toContain("the status alone tells the label 100% of the time");
  });

  it("reports every problem together, and never quotes a document", () => {
    const broken = changed("CAL-01", (pair) => {
      pair.rule = "lia-9";
      pair.evidence.quote = "words that are not in the clause";
      pair.claim.status = "compliant";
      pair.claim.discrepancy = "A discrepancy.";
    });
    const analysis = analyze(broken);
    expect(analysis.problems.length).toBeGreaterThanOrEqual(3);
    for (const problem of analysis.problems) {
      expect(problem).not.toContain("words that are not in the clause");
      expect(problem).not.toContain("Confidential Information");
    }
  });
});

describe("the builder step", () => {
  const defaultBuild = () => buildDefaultCalibration(CASES, facts);

  it("builds calibration.json: 40 pairs with the paragraph found and its text pinned, the playbook and the counts", () => {
    const { file, entry } = defaultBuild();
    expect(file.format).toBe(1);
    expect(file.dataset).toBe(CALIBRATION_DATASET_LABEL);
    expect(file.playbook).toEqual({
      slug: facts.slug,
      version: facts.version,
      sha256: facts.sha256,
    });
    expect(file.playbook.version).toBe("1.0.1");
    const { sha256: _hash, ...counts } = entry;
    expect(file.counts).toEqual(counts);
    expect(file.pairs.map((pair) => pair.id)).toEqual(PAIRS.map((pair) => pair.id));
    for (const pair of file.pairs) {
      const definition = calibrationCases(CASES).find((candidate) => candidate.case === pair.case)!;
      const doc = definition.documents.find(
        (candidate) => candidate.label === pair.evidence.doc && candidate.operative !== false,
      )!;
      const paragraph = expandDocument(doc)[pair.evidence.paragraph]!;
      expect(paragraph.text, pair.id).toContain(pair.evidence.quote);
      expect(pair.paragraphSha256, pair.id).toBe(sha256Hex(paragraph.text));
      expect(paragraph.clause, pair.id).toBe(pair.evidence.clause);
    }
  });

  it("hashes the file as canonical JSON, and records the hash and the counts for splits.json", () => {
    const { file, entry } = defaultBuild();
    expect(entry.sha256).toBe(sha256Hex(canonicalJson(file)));
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry).toEqual({ sha256: entry.sha256, ...file.counts });
    expect(entry.pairs).toBe(40);
    expect(entry.supported).toBe(20);
    expect(entry.unsupported).toBe(20);
  });

  it("is deterministic, on another day too", () => {
    const first = defaultBuild();
    expect(defaultBuild()).toEqual(first);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2031-05-05T05:05:05Z"));
      expect(defaultBuild().entry).toEqual(first.entry);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves its hash with a pair, with the text of a cited paragraph and with the playbook, and with nothing else", () => {
    const base = defaultBuild().entry.sha256;
    // A pair edited.
    const edited = buildCalibration({
      pairs: changed("CAL-01", (pair) => (pair.note = `${pair.note} Reworded.`)),
      cases: calibrationCases(CASES),
      facts,
    });
    expect(edited.entry.sha256).not.toBe(base);
    // A word of a cited paragraph changed in a way that keeps every quote valid: CAL-01 and CAL-34
    // cite clause 1.2 of PAROL-D13 and neither quote contains "Project".
    const reworded = structuredClone(D13);
    const paragraph = reworded.documents[0]!.paragraphs.find(
      (candidate) => candidate.kind === "clause" && candidate.number === "1.2",
    )!;
    if (paragraph.kind !== "clause") throw new Error("not a clause");
    expect(paragraph.text).toContain("for the Project");
    paragraph.text = paragraph.text.replace("for the Project", "for the Pilot");
    const replaced = buildCalibration({
      pairs: PAIRS,
      cases: calibrationCases(CASES).map((definition) =>
        definition.case === "PAROL-D13" ? reworded : definition,
      ),
      facts,
    });
    expect(replaced.entry.sha256).not.toBe(base);
    // The playbook.
    const otherPlaybook = buildCalibration({
      pairs: PAIRS,
      cases: calibrationCases(CASES),
      facts: { ...facts, sha256: sha256Hex("another playbook") },
    });
    expect(otherPlaybook.entry.sha256).not.toBe(base);
    // A case edited far from every cited paragraph, and the registry order, change nothing.
    const farAway = structuredClone(D13);
    farAway.documents[0]!.title = "Reciprocal Confidentiality Agreement";
    const unchanged = buildCalibration({
      pairs: PAIRS,
      cases: [...calibrationCases(CASES)]
        .reverse()
        .map((definition) => (definition.case === "PAROL-D13" ? farAway : definition)),
      facts,
    });
    expect(unchanged.entry.sha256).toBe(base);
  });

  it("stops with every problem when the set is unsound", () => {
    expect(() =>
      buildCalibration({ pairs: PAIRS.slice(0, 30), cases: calibrationCases(CASES), facts }),
    ).toThrow(CalibrationError);
    try {
      buildCalibration({ pairs: PAIRS.slice(0, 30), cases: calibrationCases(CASES), facts });
    } catch (error) {
      expect(error).toBeInstanceOf(CalibrationError);
      expect((error as CalibrationError).problems.length).toBeGreaterThanOrEqual(3);
      expect((error as Error).message).toContain("problems in the calibration set");
    }
  });

  it("prefers a registered case over its source and adds the development cases that are not registered", () => {
    const registered = calibrationCases(CASES);
    expect(registered.map((definition) => definition.case).sort()).toEqual(
      DEV_CASE_SOURCES.map((definition) => definition.case).sort(),
    );
    const stand = structuredClone(D13);
    expect(calibrationCases([stand]).find((definition) => definition.case === "PAROL-D13")).toBe(
      stand,
    );
    // A held-out case is never added from a source, only kept if it is registered.
    expect(DEV_CASE_SOURCES.some((definition) => definition.split === "heldout")).toBe(false);
  });
});

describe("the committed files", () => {
  const json = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

  it("calibration.json is what the pairs build, and prettier leaves it alone", async () => {
    const { file } = buildDefaultCalibration(CASES, facts);
    expect(json("calibration.json"), "calibration.json: run pnpm fixtures:parol").toEqual(
      JSON.parse(JSON.stringify(file)),
    );
    const path = join(FIXTURES, "calibration.json");
    const source = readFileSync(path, "utf8");
    const options = (await resolveConfig(path)) ?? {};
    expect(await format(source, { ...options, filepath: path, parser: "json" })).toBe(source);
    // The committed hash is the hash of the committed file.
    const committed = json("calibration.json") as CalibrationFile;
    expect(sha256Hex(canonicalJson(committed))).toBe(
      (json("splits.json") as SplitsFile).calibration?.sha256,
    );
  });

  it("splits.json records the calibration entry beside the splits, and the dev split hash is untouched by it", async () => {
    const splits = json("splits.json") as SplitsFile;
    const { entry } = buildDefaultCalibration(CASES, facts);
    expect(splits.calibration, "splits.json: run pnpm fixtures:parol").toEqual(entry);
    const dataset = await buildDataset({
      cases: CASES,
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
    // Everything but the calibration entry is what the cases build, hash included.
    const { calibration: _calibration, ...rest } = splits;
    expect(rest).toEqual(JSON.parse(JSON.stringify(dataset.splits)));
    expect(withCalibration(dataset.splits, entry)).toEqual(splits);
    expect(withCalibration(dataset.splits, entry).splits).toBe(dataset.splits.splits);
    // The hash of a split is computed from the keys and the files and from nothing else.
    expect(splits.splits.dev?.sha256).toBe(dataset.splits.splits.dev?.sha256);
    expect(splits.splits.dev?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is read by the runner's dataset check without complaint", async () => {
    const loaded = await loadDataset(ROOT);
    expect(loaded.ok, JSON.stringify(loaded.ok ? [] : loaded.problems)).toBe(true);
    if (loaded.ok) {
      expect(loaded.dataset.integrity.every((split) => split.matches)).toBe(true);
    }
  });

  it("splits.json is still formatted the way prettier would write it", async () => {
    const path = join(FIXTURES, "splits.json");
    const source = readFileSync(path, "utf8");
    const options = (await resolveConfig(path)) ?? {};
    expect(await format(source, { ...options, filepath: path, parser: "json" })).toBe(source);
  });
});

describe("the case checker in calibration mode", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "parol-calibration-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(...flags: string[]): { status: number; out: string } {
    try {
      const out = execFileSync(
        process.execPath,
        ["--import", "tsx", "evals/src/parol/check-case.ts", ...flags],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return { status: 0, out };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? -1,
        out: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      };
    }
  }

  function candidate(name: string, pairs: unknown): string {
    const file = join(dir, `${name}.mts`);
    writeFileSync(file, `export const PAIRS = ${JSON.stringify(pairs)};\n`);
    return file;
  }

  it("validates the shipped set, reads its documents with the real ingest, and prints what it measured", () => {
    const result = run("--calibration", "--summary");
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("calibration set: 40 pairs, 20 supported, 20 unsupported");
    expect(result.out).toContain(
      "unsupported by kind: superseded 4, overlooked_exception 4, other_party_obligation 4, definition_as_duty 4, wrong_frame 4",
    );
    expect(result.out).toContain("what a reader of the surface could tell:");
    expect(result.out).toContain(
      "real ingest: all 40 quotes found once, at the paragraph the key records",
    );
    expect(result.out).toContain("CAL-40 PAROL-D05");
    expect(result.out).toContain("ok: calibration (40 pairs)");
  }, 120_000);

  it("prints the pairs blind: no label, no kind, no note, and every pair in order", () => {
    const result = run("--calibration", "--blind");
    expect(result.status, result.out).toBe(0);
    const ids = [...result.out.matchAll(/^=== (CAL-\d\d) ===$/gm)].map((match) => match[1]);
    expect(ids).toEqual(PAIRS.map((pair) => pair.id));
    expect(result.out).toContain("Blind view of the support calibration set: 40 pairs.");
    expect(result.out).not.toMatch(/\bunsupported\b/i);
    expect(result.out).not.toMatch(/\bsupported\b/i);
    for (const kind of CALIBRATION_KINDS) expect(result.out).not.toContain(kind);
    for (const pair of PAIRS) {
      expect(result.out, `${pair.id} note`).not.toContain(pair.note.slice(0, 60));
    }
    expect(result.out).not.toMatch(/key (def|exc|pds|dur|ret|gov)-\d/);
    // What a reader needs: the rule, the claim, the paragraph, the quote and the matter.
    const block = result.out.slice(
      result.out.indexOf("=== CAL-22 ==="),
      result.out.indexOf("=== CAL-23 ==="),
    );
    expect(block).toContain(
      "Matter: PAROL-D05 (all of it: pnpm fixtures:parol:case fixtures/parol/cases/d05.ts --docs)",
    );
    expect(block).toContain("Rule ret-1: Return or destruction of information");
    expect(block).toContain("Proposed status: deviation");
    expect(block).toContain(
      "Proposed discrepancy: The deadline for return or destruction is ten business days",
    );
    expect(block).toContain("Cited paragraph (D2, clause 3, paragraph 4):");
    expect(block).toContain("  3. Section 7.2 of the Agreement is amended by replacing");
    expect(block).toContain(
      'Quote: Section 7.2 of the Agreement is amended by replacing "ten (10) business days"',
    );
    // A compliant claim has no discrepancy.
    expect(result.out).toContain("Proposed discrepancy: (none)");
  }, 120_000);

  it("refuses a candidate set that has a bad quote, and one that exports no pairs", () => {
    const bad = candidate(
      "bad",
      PAIRS.map((pair) =>
        pair.id === "CAL-01"
          ? { ...pair, evidence: { ...pair.evidence, quote: "not in the clause" } }
          : pair,
      ),
    );
    const refused = run("--calibration", bad, "--no-ingest");
    expect(refused.status, refused.out).toBe(1);
    expect(refused.out).toContain(
      "CAL-01: the quote occurs 0 times in D1 clause 1.2, not exactly once",
    );

    const empty = join(dir, "empty.mts");
    writeFileSync(empty, "export const NOTHING = 1;\n");
    const none = run("--calibration", empty);
    expect(none.status, none.out).toBe(1);
    expect(none.out).toContain("exports no array of calibration pairs");

    const fine = candidate("same", PAIRS);
    const accepted = run("--calibration", fine, "--no-ingest");
    expect(accepted.status, accepted.out).toBe(0);
    expect(accepted.out).toContain("the real ingest was not run (--no-ingest)");
    expect(accepted.out).toContain("ok: calibration (40 pairs)");
  }, 120_000);

  it("refuses --blind without --calibration", () => {
    const result = run("--blind");
    expect(result.status, result.out).toBe(2);
    expect(result.out).toContain("--blind is a mode of --calibration");
  }, 60_000);
});
