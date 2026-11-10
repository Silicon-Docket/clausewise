/**
 * The support calibration set (docs/parol/05-evaluation.md, "Support calibration set"): forty
 * (finding, evidence) pairs built from development documents, twenty supported and twenty
 * unsupported, to evaluate the support checker itself. Every quote is valid, that is, it occurs in
 * the passage it names; the unsupported pairs fail on substance, in five kinds of four.
 *
 * This file holds the pair format's checks (the validator) and the builder step that turns the
 * pairs of fixtures/parol/calibration/pairs.ts into fixtures/parol/calibration.json and the entry
 * of splits.json. It reads no file and touches no model: tools/make-parol-fixtures.ts writes the
 * result, evals/src/parol/check-case.ts (`--calibration`) prints it, and the tests call it.
 *
 * What the checker is shown matters for how the pairs are written. The support checker sees the
 * rule, the status and the discrepancy of the claim (not the explanation) and the paragraph that
 * holds the quote (apps/parol/src/services/support-checker.ts). So a supported pair is one whose
 * claim follows from that paragraph alone, and an unsupported pair is one whose claim does not
 * follow from it, or follows only if a document the finding did not cite is ignored.
 *
 * The validator refuses, and reports every problem together, naming the pair and the field and
 * never quoting the document. See `analyzeCalibration` for the list.
 */
import { canonicalJson, sha256Hex } from "../../apps/parol/src/canonical.js";
import { countOccurrences } from "./anchors.js";
import type { PlaybookFacts } from "./build.js";
import { CALIBRATION_PAIRS } from "./calibration/pairs.js";
import { D01 } from "./cases/d01.js";
import { D02 } from "./cases/d02.js";
import { D03 } from "./cases/d03.js";
import { D04 } from "./cases/d04.js";
import { D05 } from "./cases/d05.js";
import { D06 } from "./cases/d06.js";
import { D07 } from "./cases/d07.js";
import { D08 } from "./cases/d08.js";
import { D09 } from "./cases/d09.js";
import { D10 } from "./cases/d10.js";
import { D11 } from "./cases/d11.js";
import { D12 } from "./cases/d12.js";
import { D13 } from "./cases/d13.js";
import { D14 } from "./cases/d14.js";
import { expandDocument, type ExpandedParagraph } from "./render.js";
import {
  CALIBRATION_KINDS,
  CALIBRATION_LABELS,
  type CalibrationCounts,
  type CalibrationEntry,
  type CalibrationFile,
  type CalibrationKeyPair,
  type CalibrationKind,
  type CalibrationLabel,
  type CalibrationPairSpec,
  type CaseDefinition,
  type SplitsFile,
} from "./types.js";

export const CALIBRATION_DATASET_LABEL = "parol-calibration v1";
/** Gate G11 reads exactly this many pairs of each label (evals/src/parol/gates.ts). */
export const PAIRS_PER_LABEL = 20;
/** Four pairs of each of the five kinds of unsupported pair. */
export const PAIRS_PER_KIND = 4;
export const TOTAL_PAIRS = PAIRS_PER_LABEL * CALIBRATION_LABELS.length;
export const CALIBRATION_FILE_NAME = "calibration.json";

/**
 * The development cases a pair may be built from, in case order. The registry in cases.ts holds
 * only the cases that have been registered so far, and the calibration set must not wait for it,
 * so the development cases are named here as well. Held-out cases are deliberately not: no pair
 * may be built from one, and nothing in this file imports one.
 */
export const DEV_CASE_SOURCES: readonly CaseDefinition[] = [
  D01,
  D02,
  D03,
  D04,
  D05,
  D06,
  D07,
  D08,
  D09,
  D10,
  D11,
  D12,
  D13,
  D14,
];

/**
 * The cases to check the pairs against: everything registered (development and held-out, the
 * latter only so that a pair built from one is found and refused), and the development cases that
 * are not registered yet. A registered case wins over a source of the same key.
 */
export function calibrationCases(registered: readonly CaseDefinition[]): CaseDefinition[] {
  const keys = new Set(registered.map((definition) => definition.case));
  return [...registered, ...DEV_CASE_SOURCES.filter((definition) => !keys.has(definition.case))];
}

// ---------------------------------------------------------------------------------------------
// Limits on how much the surface of a pair may say about its label
// ---------------------------------------------------------------------------------------------

/**
 * A reader of only the quote must not be able to tell the label, and the claim around it should
 * not give it away either. These are the limits the validator enforces, in the order of
 * `SeparabilityReport`. They are chosen so that a random assignment of labels to forty pairs
 * passes them, and a set in which the unsupported quotes are visibly shorter, longer or worded
 * alike does not.
 */
export const SEPARABILITY_LIMITS = {
  /** The best accuracy of a rule "longer than N words (or characters) means unsupported". */
  quoteThresholdAccuracy: 0.7,
  /** The medians of the quote lengths of the two labels differ by at most this share of the larger. */
  quoteMedianGap: 0.2,
  /** A word in at least this many quotes must not belong to one label alone, within `cueBand`. */
  cueMinPairs: 5,
  cueBand: [0.2, 0.8] as const,
  /** Guessing the label from the rule alone, or from the status alone, may not beat this. */
  ruleAccuracy: 0.7,
  statusAccuracy: 0.65,
  /** The same for the explanation, which a blind reader sees. */
  explanationThresholdAccuracy: 0.75,
  /** No more than this many pairs in a row with the same label, in the order of the ids. */
  longestLabelRun: 5,
} as const;

export interface LengthStats {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  mean: number;
}

export interface CueToken {
  token: string;
  pairs: number;
  unsupported: number;
}

/** What was measured, for the report and for the tests. Accuracies are between 0.5 and 1. */
export interface SeparabilityReport {
  quoteWords: Record<CalibrationLabel, LengthStats>;
  quoteCharacters: Record<CalibrationLabel, LengthStats>;
  explanationWords: Record<CalibrationLabel, LengthStats>;
  /** Best accuracy of a single length threshold, in either direction. */
  thresholdAccuracy: { quoteWords: number; quoteCharacters: number; explanationWords: number };
  /** Accuracy of guessing the label as the majority label of the rule, or of the status. */
  majorityAccuracy: { rule: number; status: number };
  /** Words that are in at least `cueMinPairs` quotes, with the pairs and the unsupported ones. */
  quoteWordCounts: CueToken[];
  /** The ones among them that fall outside the band. */
  cueWords: CueToken[];
  /** The same measure over status, discrepancy and explanation together. Reported only. */
  claimWordCounts: CueToken[];
  /** The longest run of one label in the order of the ids. */
  longestLabelRun: number;
  /** Paragraphs cited by a supported pair and an unsupported pair alike. */
  sharedParagraphs: number;
  byRule: Record<string, { supported: number; unsupported: number }>;
  byStatus: Record<string, { supported: number; unsupported: number }>;
}

// ---------------------------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------------------------

// The project style forbids every dash in every string (the builder's own rule).
const DASHES = /[\u2010-\u2015\u2212]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const PAIR_ID = /^CAL-\d{2}$/;
const DEV_CASE_KEY = /^PAROL-D\d{2}$/;

export class CalibrationError extends Error {
  override name = "CalibrationError";
  constructor(readonly problems: readonly string[]) {
    super(
      `${problems.length} problem${problems.length === 1 ? "" : "s"} in the calibration set:\n  ${problems.join("\n  ")}`,
    );
  }
}

export interface CalibrationInput {
  pairs: readonly CalibrationPairSpec[];
  /** Every case a pair may name; see `calibrationCases`. */
  cases: readonly CaseDefinition[];
  facts: PlaybookFacts;
}

export interface CalibrationAnalysis {
  /** Empty when the set is sound. */
  problems: string[];
  /** The pairs that could be resolved, with the paragraph found and its hash. */
  pairs: CalibrationKeyPair[];
  counts: CalibrationCounts;
  separability: SeparabilityReport;
}

const words = (value: string): string[] => value.split(/\s+/).filter((word) => word !== "");
const tokensOf = (value: string): string[] => value.toLowerCase().match(/[a-z0-9]+/g) ?? [];

function stats(values: readonly number[]): LengthStats {
  if (values.length === 0) return { min: 0, q1: 0, median: 0, q3: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number): number => {
    const position = (sorted.length - 1) * share;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return (sorted[low] ?? 0) + ((sorted[high] ?? 0) - (sorted[low] ?? 0)) * (position - low);
  };
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: sorted[0] ?? 0,
    q1: at(0.25),
    median: at(0.5),
    q3: at(0.75),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sum / sorted.length,
  };
}

/** Best accuracy of "value above a cut means unsupported", or the reverse, over every cut. */
function thresholdAccuracy(rows: readonly { value: number; unsupported: boolean }[]): number {
  if (rows.length === 0) return 0;
  const cuts = [Number.NEGATIVE_INFINITY, ...new Set(rows.map((row) => row.value))];
  let best = 0;
  for (const cut of cuts) {
    const correct = rows.filter((row) => row.value > cut === row.unsupported).length;
    best = Math.max(best, correct, rows.length - correct);
  }
  return best / rows.length;
}

function majorityAccuracy(rows: readonly { group: string; unsupported: boolean }[]): number {
  if (rows.length === 0) return 0;
  const groups = new Map<string, { supported: number; unsupported: number }>();
  for (const row of rows) {
    const entry = groups.get(row.group) ?? { supported: 0, unsupported: 0 };
    if (row.unsupported) entry.unsupported += 1;
    else entry.supported += 1;
    groups.set(row.group, entry);
  }
  let correct = 0;
  for (const entry of groups.values()) correct += Math.max(entry.supported, entry.unsupported);
  return correct / rows.length;
}

function wordCounts(
  rows: readonly { text: string; unsupported: boolean }[],
  minPairs: number,
): CueToken[] {
  const seen = new Map<string, CueToken>();
  for (const row of rows) {
    for (const token of new Set(tokensOf(row.text))) {
      const entry = seen.get(token) ?? { token, pairs: 0, unsupported: 0 };
      entry.pairs += 1;
      if (row.unsupported) entry.unsupported += 1;
      seen.set(token, entry);
    }
  }
  return [...seen.values()]
    .filter((entry) => entry.pairs >= minPairs)
    .sort((a, b) => b.pairs - a.pairs || (a.token < b.token ? -1 : 1));
}

function longestRun(labels: readonly CalibrationLabel[]): number {
  let longest = 0;
  let run = 0;
  labels.forEach((label, i) => {
    run = i > 0 && labels[i - 1] === label ? run + 1 : 1;
    longest = Math.max(longest, run);
  });
  return longest;
}

const share = (value: number): string => `${Math.round(value * 100)}%`;

function separability(pairs: readonly CalibrationPairSpec[]): SeparabilityReport {
  const unsupported = (pair: CalibrationPairSpec): boolean => pair.label === "unsupported";
  const ofLabel = (label: CalibrationLabel) => pairs.filter((pair) => pair.label === label);
  const perLabel = (measure: (pair: CalibrationPairSpec) => number) =>
    ({
      supported: stats(ofLabel("supported").map(measure)),
      unsupported: stats(ofLabel("unsupported").map(measure)),
    }) satisfies Record<CalibrationLabel, LengthStats>;
  const quoteWords = (pair: CalibrationPairSpec): number => words(pair.evidence.quote).length;
  const quoteCharacters = (pair: CalibrationPairSpec): number => pair.evidence.quote.length;
  const explanationWords = (pair: CalibrationPairSpec): number =>
    words(pair.claim.explanation).length;
  const rows = (measure: (pair: CalibrationPairSpec) => number) =>
    pairs.map((pair) => ({ value: measure(pair), unsupported: unsupported(pair) }));

  const count = (key: (pair: CalibrationPairSpec) => string) => {
    const out: Record<string, { supported: number; unsupported: number }> = {};
    for (const pair of pairs) {
      const entry = (out[key(pair)] ??= { supported: 0, unsupported: 0 });
      if (unsupported(pair)) entry.unsupported += 1;
      else entry.supported += 1;
    }
    return out;
  };

  const quoteWordCounts = wordCounts(
    pairs.map((pair) => ({ text: pair.evidence.quote, unsupported: unsupported(pair) })),
    SEPARABILITY_LIMITS.cueMinPairs,
  );
  const [low, high] = SEPARABILITY_LIMITS.cueBand;
  const paragraphLabels = new Map<string, Set<CalibrationLabel>>();
  for (const pair of pairs) {
    const key = `${pair.case}|${pair.evidence.doc}|${pair.evidence.clause ?? ""}`;
    const set = paragraphLabels.get(key) ?? new Set<CalibrationLabel>();
    set.add(pair.label);
    paragraphLabels.set(key, set);
  }

  return {
    quoteWords: perLabel(quoteWords),
    quoteCharacters: perLabel(quoteCharacters),
    explanationWords: perLabel(explanationWords),
    thresholdAccuracy: {
      quoteWords: thresholdAccuracy(rows(quoteWords)),
      quoteCharacters: thresholdAccuracy(rows(quoteCharacters)),
      explanationWords: thresholdAccuracy(rows(explanationWords)),
    },
    majorityAccuracy: {
      rule: majorityAccuracy(
        pairs.map((pair) => ({ group: pair.rule, unsupported: unsupported(pair) })),
      ),
      status: majorityAccuracy(
        pairs.map((pair) => ({ group: pair.claim.status, unsupported: unsupported(pair) })),
      ),
    },
    quoteWordCounts,
    cueWords: quoteWordCounts.filter((entry) => {
      const portion = entry.unsupported / entry.pairs;
      return portion < low || portion > high;
    }),
    claimWordCounts: wordCounts(
      pairs.map((pair) => ({
        text: `${pair.claim.status} ${pair.claim.discrepancy} ${pair.claim.explanation}`,
        unsupported: unsupported(pair),
      })),
      SEPARABILITY_LIMITS.cueMinPairs,
    ),
    longestLabelRun: longestRun(pairs.map((pair) => pair.label)),
    sharedParagraphs: [...paragraphLabels.values()].filter((set) => set.size === 2).length,
    byRule: count((pair) => pair.rule),
    byStatus: count((pair) => pair.claim.status),
  };
}

/** The first line of a statistic for a message: both labels, so a failure can be read. */
const lengthLine = (stat: Record<CalibrationLabel, LengthStats>): string =>
  `median ${stat.supported.median} supported, ${stat.unsupported.median} unsupported`;

/**
 * Checks the whole set and resolves every quote against the text the builder generates. Every
 * problem is reported, none quotes the document. It refuses:
 *
 * - a set that is not exactly 40 pairs, 20 of each label, with 4 unsupported pairs of each of the
 *   five kinds; a supported pair with a kind; an unsupported pair without one; ids that are not
 *   `CAL-01` and up in order, or that repeat; two pairs that cite the same quote for the same rule
 *   and status;
 * - a pair whose case is not a known development case (a held-out case, an unknown key), whose
 *   rule is not in the pinned playbook, or whose status is not `compliant` or `deviation` (the
 *   support check runs for no other), or whose compliant claim has a discrepancy or whose
 *   deviation has none;
 * - a quote that does not occur exactly once, overlapping matches counted, in the named clause of
 *   the operative document of the label; a quote in an injected paragraph; a cited paragraph that
 *   is word for word a paragraph of a held-out case; a `superseded` pair in a case with no
 *   amendment;
 * - text with a dash, a control character or white space at an end;
 * - a set whose surface gives the label away: see `SEPARABILITY_LIMITS`.
 */
export function analyzeCalibration(input: CalibrationInput): CalibrationAnalysis {
  const problems: string[] = [];
  const add = (scope: string, message: string): void => {
    problems.push(`${scope}: ${message}`);
  };
  const { pairs, facts } = input;
  const byKey = new Map(input.cases.map((definition) => [definition.case, definition]));

  const counts: CalibrationCounts = {
    pairs: pairs.length,
    supported: pairs.filter((pair) => pair.label === "supported").length,
    unsupported: pairs.filter((pair) => pair.label === "unsupported").length,
    byKind: Object.fromEntries(
      CALIBRATION_KINDS.map((kind) => [
        kind,
        pairs.filter((pair) => pair.label === "unsupported" && pair.kind === kind).length,
      ]),
    ) as Record<CalibrationKind, number>,
  };

  // The shape of the whole set.
  if (counts.pairs !== TOTAL_PAIRS) {
    add("set", `it holds ${counts.pairs} pairs, and the calibration set is exactly ${TOTAL_PAIRS}`);
  }
  if (counts.supported !== PAIRS_PER_LABEL || counts.unsupported !== PAIRS_PER_LABEL) {
    add(
      "set",
      `it holds ${counts.supported} supported and ${counts.unsupported} unsupported pairs, and gate G11 reads exactly ${PAIRS_PER_LABEL} of each`,
    );
  }
  for (const kind of CALIBRATION_KINDS) {
    if (counts.byKind[kind] !== PAIRS_PER_KIND) {
      add(
        "set",
        `it holds ${counts.byKind[kind]} unsupported pairs of kind ${kind}, not ${PAIRS_PER_KIND}`,
      );
    }
  }

  // Held-out text, for the check that no pair copies a paragraph of a held-out document.
  const heldoutParagraphs = new Map<string, string>();
  for (const definition of input.cases) {
    if (definition.split !== "heldout") continue;
    for (const doc of definition.documents) {
      for (const paragraph of expandDocument(doc)) {
        heldoutParagraphs.set(paragraph.text, definition.case);
      }
    }
  }

  const resolved: CalibrationKeyPair[] = [];
  const ids = new Set<string>();
  const cited = new Map<string, string>();
  const expanded = new Map<string, ExpandedParagraph[]>();

  pairs.forEach((pair, index) => {
    const scope = pair.id;
    if (!PAIR_ID.test(pair.id)) {
      add(`pair ${index + 1}`, "the id is not CAL-01 and up");
    } else if (ids.has(pair.id)) {
      add(scope, "the id is used twice");
    }
    ids.add(pair.id);
    const expectedId = `CAL-${String(index + 1).padStart(2, "0")}`;
    if (PAIR_ID.test(pair.id) && pair.id !== expectedId) {
      add(scope, `the id is out of order: pair ${index + 1} of the file should be ${expectedId}`);
    }

    // Label and kind.
    if (!(CALIBRATION_LABELS as readonly string[]).includes(pair.label)) {
      add(scope, "the label is not supported or unsupported");
    }
    if (pair.label === "unsupported") {
      if (pair.kind === undefined) add(scope, "an unsupported pair has no kind");
      else if (!(CALIBRATION_KINDS as readonly string[]).includes(pair.kind)) {
        add(scope, "the kind is not one of the five");
      }
    } else if (pair.kind !== undefined) {
      add(scope, "a supported pair has a kind");
    }

    // Texts.
    const texts: [string, string, boolean][] = [
      ["note", pair.note, false],
      ["claim.explanation", pair.claim.explanation, false],
      ["claim.discrepancy", pair.claim.discrepancy, true],
      ["evidence.quote", pair.evidence.quote, false],
    ];
    for (const [field, value, mayBeEmpty] of texts) {
      if (value === "" && mayBeEmpty) continue;
      if (value.trim() === "") add(scope, `${field} is empty`);
      else if (value !== value.trim()) add(scope, `${field} has white space at an end`);
      if (CONTROL.test(value)) add(scope, `${field} contains a control character or a line break`);
      if (DASHES.test(value))
        add(scope, `${field} contains an en dash, an em dash or another dash`);
    }

    // Claim.
    if (pair.claim.status !== "compliant" && pair.claim.status !== "deviation") {
      add(
        scope,
        "the status is not compliant or deviation, and the support check runs for no other",
      );
    } else if (pair.claim.status === "compliant" && pair.claim.discrepancy !== "") {
      add(scope, "a compliant claim has a discrepancy, and the analysis schema says it is empty");
    } else if (pair.claim.status === "deviation" && pair.claim.discrepancy.trim() === "") {
      add(scope, "a deviation claim has no discrepancy");
    }

    // Rule.
    if (facts.rules[pair.rule] === undefined) add(scope, "the rule is not a rule of the playbook");

    // Case.
    const definition = byKey.get(pair.case);
    if (definition === undefined) {
      add(scope, "the case is not known");
      return;
    }
    if (!DEV_CASE_KEY.test(pair.case) || definition.split !== "dev") {
      add(
        scope,
        "the case is not a development case, and no pair may be built from a held-out document",
      );
      return;
    }

    // Evidence: the quote occurs exactly once in the clause, in the operative document.
    const doc = definition.documents.find(
      (candidate) => candidate.label === pair.evidence.doc && candidate.operative !== false,
    );
    if (doc === undefined) {
      add(scope, `the case has no operative document ${pair.evidence.doc}`);
      return;
    }
    let paragraphs = expanded.get(`${pair.case}|${doc.file}`);
    if (paragraphs === undefined) {
      paragraphs = expandDocument(doc);
      expanded.set(`${pair.case}|${doc.file}`, paragraphs);
    }
    const where =
      pair.evidence.clause === null
        ? `${pair.evidence.doc} outside any numbered clause`
        : `${pair.evidence.doc} clause ${pair.evidence.clause}`;
    const inClause = paragraphs.filter((paragraph) => paragraph.clause === pair.evidence.clause);
    if (inClause.length === 0) {
      add(scope, `${where} has no paragraph`);
      return;
    }
    if (pair.evidence.quote.trim() === "") return;
    let occurrences = 0;
    let found: ExpandedParagraph | undefined;
    for (const paragraph of inClause) {
      const n = countOccurrences(paragraph.text, pair.evidence.quote);
      if (n > 0) found = paragraph;
      occurrences += n;
    }
    if (occurrences !== 1 || found === undefined) {
      add(scope, `the quote occurs ${occurrences} times in ${where}, not exactly once`);
      return;
    }
    if (found.injected) {
      add(scope, `the quote is in an injected paragraph of ${where}`);
    }
    const heldout = heldoutParagraphs.get(found.text);
    if (heldout !== undefined) {
      add(
        scope,
        `the cited paragraph is word for word a paragraph of the held-out case ${heldout}`,
      );
    }
    if (pair.kind === "superseded" && definition.documents.every((d) => d.label === "D1")) {
      add(scope, "a superseded pair needs a case with an amendment");
    }

    const duplicate = `${pair.case}|${pair.rule}|${pair.claim.status}|${pair.evidence.doc}|${pair.evidence.clause ?? ""}|${pair.evidence.quote}`;
    const other = cited.get(duplicate);
    if (other !== undefined)
      add(scope, `it cites the same quote for the same rule and status as ${other}`);
    cited.set(duplicate, pair.id);

    resolved.push({
      ...pair,
      evidence: { ...pair.evidence, paragraph: found.index },
      paragraphSha256: sha256Hex(found.text),
    });
  });

  // What the surface of a pair says about its label.
  const report = separability(pairs);
  const limits = SEPARABILITY_LIMITS;
  if (pairs.length >= 2 && counts.supported > 0 && counts.unsupported > 0) {
    const accuracy = report.thresholdAccuracy;
    if (accuracy.quoteWords > limits.quoteThresholdAccuracy) {
      add(
        "separability",
        `a length threshold on the quote in words tells the label ${share(accuracy.quoteWords)} of the time (${lengthLine(report.quoteWords)}), and the limit is ${share(limits.quoteThresholdAccuracy)}`,
      );
    }
    if (accuracy.quoteCharacters > limits.quoteThresholdAccuracy) {
      add(
        "separability",
        `a length threshold on the quote in characters tells the label ${share(accuracy.quoteCharacters)} of the time (${lengthLine(report.quoteCharacters)}), and the limit is ${share(limits.quoteThresholdAccuracy)}`,
      );
    }
    const medianSupported = report.quoteWords.supported.median;
    const medianUnsupported = report.quoteWords.unsupported.median;
    const gap =
      Math.abs(medianSupported - medianUnsupported) /
      Math.max(medianSupported, medianUnsupported, 1);
    if (gap > limits.quoteMedianGap) {
      add(
        "separability",
        `the median quote has ${medianSupported} words in a supported pair and ${medianUnsupported} in an unsupported one, a gap of ${share(gap)}, and the limit is ${share(limits.quoteMedianGap)}`,
      );
    }
    for (const cue of report.cueWords) {
      add(
        "separability",
        `the word "${cue.token}" is in ${cue.pairs} quotes and ${cue.unsupported} of them are unsupported, which tells the label; the band is ${share(limits.cueBand[0])} to ${share(limits.cueBand[1])}`,
      );
    }
    if (accuracy.explanationWords > limits.explanationThresholdAccuracy) {
      add(
        "separability",
        `a length threshold on the explanation tells the label ${share(accuracy.explanationWords)} of the time (${lengthLine(report.explanationWords)}), and the limit is ${share(limits.explanationThresholdAccuracy)}`,
      );
    }
    if (report.majorityAccuracy.rule > limits.ruleAccuracy) {
      add(
        "separability",
        `the rule alone tells the label ${share(report.majorityAccuracy.rule)} of the time, and the limit is ${share(limits.ruleAccuracy)}`,
      );
    }
    if (report.majorityAccuracy.status > limits.statusAccuracy) {
      add(
        "separability",
        `the status alone tells the label ${share(report.majorityAccuracy.status)} of the time, and the limit is ${share(limits.statusAccuracy)}`,
      );
    }
    if (report.longestLabelRun > limits.longestLabelRun) {
      add(
        "separability",
        `${report.longestLabelRun} pairs in a row have the same label, so the order of the ids tells the label, and the limit is ${limits.longestLabelRun}`,
      );
    }
  }

  return { problems, pairs: resolved, counts, separability: report };
}

// ---------------------------------------------------------------------------------------------
// The builder step
// ---------------------------------------------------------------------------------------------

export interface BuiltCalibration {
  /** What `calibration.json` holds. */
  file: CalibrationFile;
  /** What `splits.json` records under `calibration`. */
  entry: CalibrationEntry;
  analysis: CalibrationAnalysis;
}

/**
 * Checks the pairs and builds `calibration.json` and the entry of `splits.json`. The hash is the
 * SHA-256 of the file as canonical JSON, so it moves with a pair, with the text of a cited
 * paragraph (each pair pins one) and with the playbook, and with nothing else: in particular it is
 * not part of the hash of any split. Throws `CalibrationError` listing every problem.
 */
export function buildCalibration(input: CalibrationInput): BuiltCalibration {
  const analysis = analyzeCalibration(input);
  if (analysis.problems.length > 0) throw new CalibrationError(analysis.problems);
  const file: CalibrationFile = {
    format: 1,
    dataset: CALIBRATION_DATASET_LABEL,
    playbook: { slug: input.facts.slug, version: input.facts.version, sha256: input.facts.sha256 },
    counts: analysis.counts,
    pairs: analysis.pairs,
  };
  return { file, entry: { sha256: sha256Hex(canonicalJson(file)), ...analysis.counts }, analysis };
}

/** The pairs that ship, built from the registered cases and the development sources. */
export function buildDefaultCalibration(
  registered: readonly CaseDefinition[],
  facts: PlaybookFacts,
): BuiltCalibration {
  return buildCalibration({
    pairs: CALIBRATION_PAIRS,
    cases: calibrationCases(registered),
    facts,
  });
}

/** splits.json with the calibration entry added after the splits. Nothing else in it changes. */
export function withCalibration(splits: SplitsFile, entry: CalibrationEntry): SplitsFile {
  return { ...splits, calibration: entry };
}
