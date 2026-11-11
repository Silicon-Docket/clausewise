/**
 * Renders one comparison of two results files into a page document: the JSON file that the
 * application's evaluation page (`GET /evaluations`) reads. This is the pure half of publishing;
 * `publish.ts` is the half that writes. The contract of the document is owned by the application
 * (`apps/parol/src/evaluations/document.ts`) and imported here, in the direction evals to app that
 * the rest of this folder already follows. The application imports nothing from `evals/`.
 *
 * What goes in, and what does not:
 *
 *  - The numbers, the gates and the paired slots are those of `compareResults`. Nothing is worked
 *    out again except counts of gates by outcome, which the application does.
 *  - The answer key's side of each changed slot (what was expected, why, and the passages the key
 *    points at, as paragraphs of the synthetic case files) is read from the dataset on disk, after
 *    checking that the dataset is the one the runs were made with.
 *  - What each version did with a slot is what the results file recorded: the status it gave,
 *    whether that was right, the kind of failure, how many quotes verified and, when the file has
 *    trails (trails.ts), where the version looked, what it cited, which checks passed and failed and
 *    which escalations it raised. A results file holds no model answer and no quotation, so neither
 *    does the page document. A side whose file has no trails (an older file), no trail for the slot,
 *    or a case whose text on disk is not the text the run read says so (`recorded: false`, with
 *    `not_recorded` or `case_changed`) and still shows the scores.
 *  - The words of a banner are not here. A document carries the mode of each run and the
 *    application looks the words up, so editing a document cannot change what a page announces.
 *  - The held-out split is sealed: a changed held-out slot is listed (its case, rule and counts),
 *    but its answer key and passages are left out unless the caller opens them. The document
 *    records that they were opened.
 *
 * The builder takes no clock and no path, so the same inputs give the same bytes. It checks its own
 * output with the application's reader before returning it, so a document that the page could not
 * show is never written. Errors are fixed sentences that name ids, counts and closed codes and
 * never repeat a document, a key or a quotation.
 */
import type { SourceSpan } from "../../../apps/parol/src/contracts.js";
import {
  FAILURE_KINDS,
  GATE_IDS,
  MAX_PAGE_BYTES,
  pageFileName,
  parseComparisonPage,
  sealComparisonPage,
  type ChangeView,
  type ComparisonBody,
  type ComparisonPage,
  type FailureKind,
  type GateView,
  type PassageView,
  type SectionView,
  type SideFacts,
  type SideTrailView,
  type SlotTrailView,
  type SplitName,
} from "../../../apps/parol/src/evaluations/document.js";
import { buildIngest } from "../../../apps/parol/src/ingest/ingest.js";
import { documentTextSha256 } from "../../../apps/parol/src/ingest/text-hash.js";
import type { LoadedPlaybook } from "../../../apps/parol/src/module-contracts.js";
import type { AnswerKeyCase, RuleExpectation } from "../../../fixtures/parol/types.js";
import { EvalError, shown } from "../errors.js";
import { findAnchor } from "./anchors.js";
import type { Comparison, SectionComparison, SlotChange } from "./compare.js";
import type { Dataset } from "./dataset.js";
import type { GateReport } from "./gates.js";
import { runHealth, type ResultsFile, type SplitSection } from "./results.js";
import { readCaseDocuments, runnableCases, type ParsedFiles } from "./runner.js";
import type { SlotScore } from "./score.js";
import { textDigestOf, type SlotTrail, type TrailRecord } from "./trails.js";

/** A page document could not be built or written. The message is a fixed sentence and names no text. */
export class PageError extends EvalError {
  override name = "PageError";
}

/** The most characters of a paragraph that a page document holds (the contract's bound). */
export const PASSAGE_TEXT_LIMIT = 8000;

const TEXT_LIMIT = 2000;
/** The most passages one case holds in a page document (the contract's bound). */
const MAX_PASSAGES = 60;
const MAX_GATE_EVIDENCE = 40;

export interface PageInput {
  /** The base name of the file, and what it holds. */
  baseline: { file: string; results: ResultsFile };
  candidate: { file: string; results: ResultsFile };
  /** From `compareResults`, which has refused every comparison that cannot be made. */
  comparison: Extract<Comparison, { ok: true }>;
  /** Loaded with `loadDataset`, so its integrity against splits.json is already checked. */
  dataset: Dataset;
  /** The playbook the answer keys were built for (rule titles). */
  playbook: LoadedPlaybook;
  /** Include the answer key and the passages of changed slots of the held-out split. Default: sealed. */
  openHeldoutTrails: boolean;
  /** The largest document built, in bytes. Default: the largest the application reads. For tests. */
  maxBytes?: number;
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** At most `max` characters, ending in three full stops when text was cut. */
function clip(text: string, max: number = TEXT_LIMIT): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 3);
  // Never end on half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}...`;
}

/** A list the document holds, refused (not cut) when it is longer than the contract allows. */
function bounded<T>(items: readonly T[], max: number, what: string): T[] {
  if (items.length > max) {
    throw new PageError(
      `There are more ${what} (${items.length}) than a page document holds (${max}).`,
    );
  }
  return [...items];
}

/**
 * A case or rule key for a message. It comes from a results file, which is input, so it is repeated
 * only when it reads as a plain name.
 */
const named = (value: string): string => shown(value, "name");

const finite = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) ? value : null;

/** The last part of a path, so that a document never names a folder. */
const baseNameOf = (file: string): string => file.split(/[\\/]/).pop() ?? file;

const isFailureKind = (value: string): value is FailureKind =>
  (FAILURE_KINDS as readonly string[]).includes(value);

/** The document as it is written to a file, and the size the application's reader measures. */
export const serialiseComparisonPage = (page: ComparisonPage): string =>
  `${JSON.stringify(page, null, 2)}\n`;

// ---------------------------------------------------------------------------------------------
// The sides
// ---------------------------------------------------------------------------------------------

function sideFacts(file: ResultsFile): SideFacts {
  const { pins } = file;
  if (file.mode !== pins.mode) {
    // The mode decides which banner the page raises, so a file that disagrees with itself about it
    // is not published.
    throw new PageError(
      "A results file gives two different modes for its run, so it is not published.",
    );
  }
  const health = runHealth(file);
  const note: unknown = file.contamination?.note;
  const prompt = (pin: { id: string; sha256: string }): string =>
    clip(`${pin.id} ${pin.sha256.slice(0, 12)}`, 200);
  return {
    mode: file.mode,
    workflow: {
      label: clip(pins.workflow.label, 100),
      sha256: pins.workflow.sha256,
      retrieval: clip(pins.workflow.retrieval, 100),
      checks: bounded(
        pins.workflow.checks.map((check) => clip(check, 100)),
        40,
        "checks in a workflow",
      ),
      prompts: {
        extract: prompt(pins.workflow.prompts.extract),
        analyze: prompt(pins.workflow.prompts.analyze),
        support:
          pins.workflow.prompts.support === null ? null : prompt(pins.workflow.prompts.support),
      },
    },
    model: {
      provider: clip(pins.model.provider, 200),
      requested: clip(pins.model.requested, 200),
      endpoint:
        pins.model.endpoint === null || pins.model.endpoint === undefined
          ? null
          : clip(pins.model.endpoint, 300),
      reported:
        pins.model.reported === null
          ? null
          : bounded(
              pins.model.reported.map((model) => clip(model, 200)),
              20,
              "reported models",
            ),
      reportedNote: clip(pins.model.reportedNote),
    },
    code: {
      commit: pins.code.commit === null ? null : clip(pins.code.commit, 100),
      dirty: pins.code.dirty,
    },
    startedAt: clip(file.startedAt, 100),
    finishedAt: clip(file.finishedAt, 100),
    repeats: pins.repeats,
    health: {
      clean: health.clean,
      problems: bounded(
        health.problems.map((problem) => clip(problem)),
        40,
        "problems in a run",
      ),
    },
    contamination: typeof note === "string" ? clip(note) : null,
    trailsRecorded: file.trails !== undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------------------------

function gateViews(report: GateReport | null): GateView[] | null {
  if (report === null) return null;
  return GATE_IDS.map((id): GateView => {
    const found = report.results.filter((result) => result.id === id);
    if (found.length !== 1) {
      // A report with a gate missing or doubled is a bug in the evaluation, not a poor score.
      throw new PageError(`The gate report of a run does not hold exactly one result for ${id}.`);
    }
    const result = found[0]!;
    if (result.evidence.length > MAX_GATE_EVIDENCE) {
      throw new PageError(
        `Gate ${id} has more lines of evidence (${result.evidence.length}) than a page document holds (${MAX_GATE_EVIDENCE}). Compare fewer repeats.`,
      );
    }
    return {
      id,
      title: clip(result.title, 300),
      threshold: clip(result.threshold),
      scope: clip(result.scope, 100),
      outcome: result.outcome,
      detail: clip(result.detail),
      evidence: result.evidence.map((line) => ({
        repeat: line.repeat,
        measure: clip(line.measure),
        numerator: finite(line.numerator),
        denominator: finite(line.denominator),
        value: finite(line.value),
        passed: line.passed,
        ...(line.context === true ? { context: true as const } : {}),
      })),
      ...(result.slots === undefined
        ? {}
        : {
            slots: bounded(
              result.slots.map((slot) => ({ caseKey: slot.caseKey, ruleKey: slot.ruleKey })),
              500,
              "regressed slots",
            ),
          }),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The passages of the key
// ---------------------------------------------------------------------------------------------

/** A paragraph as a passage, or null when it is longer than a document holds. It is never cut. */
export function passageOf(
  span: SourceSpan,
  limit: number = PASSAGE_TEXT_LIMIT,
): PassageView | null {
  if (span.text.length > limit) return null;
  return {
    doc: span.docLabel,
    paragraph: span.paragraphIndex,
    clauseNumber: span.clauseNumber === null ? null : clip(span.clauseNumber, 100),
    heading: span.heading === null ? null : clip(span.heading, 300),
    text: span.text,
  };
}

const byPlace = (a: PassageView, b: PassageView): number =>
  a.doc.localeCompare(b.doc) || a.paragraph - b.paragraph;

/**
 * The paragraphs of one case, sorted: all of the key's, then those that trails cite, in document
 * order, while there is room. A cited paragraph that is left out is shown as "not in this file",
 * which is true, and the key is never short of one. `max` is for tests.
 */
export function mergePassages(
  key: ReadonlyMap<string, PassageView>,
  cited: ReadonlyMap<string, PassageView>,
  max: number = MAX_PASSAGES,
): PassageView[] {
  const merged = new Map(key);
  for (const passage of [...cited.values()].sort(byPlace)) {
    if (merged.size >= max) break;
    const at = `${passage.doc}:${passage.paragraph}`;
    if (!merged.has(at)) merged.set(at, passage);
  }
  return [...merged.values()].sort(byPlace);
}

interface ReadCase {
  key: AnswerKeyCase;
  spans: readonly SourceSpan[];
  documents: {
    label: SourceSpan["docLabel"];
    title: string;
    versionNo: number;
    statedDate: string | null;
  }[];
  /** Digest of the text as read now, which a trail's digest has to equal (trails.ts). */
  textDigest: string;
  /** The paragraphs the key points at. They always go into the document. */
  passages: Map<string, PassageView>;
  /** The paragraphs that trails cite. They go in after the key's, while there is room. */
  cited: Map<string, PassageView>;
}

/** Reads the cases the key names once each, and collects the passages that changed slots point at. */
function caseReader(dataset: Dataset): (caseKey: string) => Promise<ReadCase> {
  const parsed: ParsedFiles = new Map();
  const cache = new Map<string, Promise<ReadCase>>();
  return (caseKey) => {
    let read = cache.get(caseKey);
    if (read === undefined) {
      read = (async (): Promise<ReadCase> => {
        const key = dataset.keys.cases.find((entry) => entry.case === caseKey);
        if (key === undefined) {
          throw new PageError(
            `A changed slot is of ${named(caseKey)}, which is not a case of the answer key on disk.`,
          );
        }
        const [runnable] = runnableCases({ cases: [key], twins: [] });
        // Read as a run reads the documents, so the paragraph numbers are those a trail would name.
        const documents = await readCaseDocuments({
          dataset,
          runnable: runnable!,
          repeat: 1,
          parsed,
        });
        return {
          key,
          spans: buildIngest({ documents }).spans,
          documents: documents.map((doc) => ({
            label: doc.label,
            title: clip(doc.title, 300),
            versionNo: doc.versionNo,
            statedDate: doc.statedDate === null ? null : clip(doc.statedDate, 100),
          })),
          textDigest: textDigestOf(
            documents.map((doc) => ({
              label: doc.label,
              textSha256: documentTextSha256(doc.paragraphs),
            })),
          ),
          passages: new Map(),
          cited: new Map(),
        };
      })();
      cache.set(caseKey, read);
    }
    return read;
  };
}

const ROLES = ["governing", "superseded", "relevant"] as const;

/** The key's side of a slot: what was expected and why, and the paragraphs it points at. */
function keyOf(read: ReadCase, expectation: RuleExpectation, where: string): SlotTrailView["key"] {
  const anchors: SlotTrailView["key"]["anchors"] = [];
  for (const role of ROLES) {
    for (const anchor of expectation[role]) {
      const found = findAnchor(read.spans, anchor);
      if (!found.ok) {
        // The run checks this before it starts; a file from another checkout can reach here.
        throw new PageError(
          `An anchor of the answer key for ${where} does not resolve in the case files (${found.reason}).`,
        );
      }
      const passage = passageOf(found.span);
      if (passage !== null) read.passages.set(`${passage.doc}:${passage.paragraph}`, passage);
      anchors.push({
        role,
        doc: anchor.doc,
        clause: anchor.clause === null ? null : clip(anchor.clause, 100),
        paragraph: found.span.paragraphIndex,
        anchor: clip(anchor.anchor),
      });
    }
  }
  return {
    basis: clip(expectation.basis),
    note: clip(expectation.note),
    escalation: {
      mode: clip(expectation.escalation.mode, 100),
      codes: bounded(
        expectation.escalation.codes.map((code) => clip(code, 100)),
        20,
        "escalation codes in a key",
      ),
    },
    anchors: bounded(anchors, 40, `anchors in the key for ${where}`),
  };
}

// ---------------------------------------------------------------------------------------------
// The slots that changed
// ---------------------------------------------------------------------------------------------

/** The trails of a file by slot and repeat, looked up without searching the list each time. */
const trailIndexes = new WeakMap<TrailRecord, Map<string, SlotTrail>>();

function trailAt(
  record: TrailRecord,
  at: { split: string; caseKey: string; ruleKey: string; repeat: number },
): SlotTrail | undefined {
  let index = trailIndexes.get(record);
  if (index === undefined) {
    index = new Map(
      record.items.map((item) => [
        `${item.split}\n${item.caseKey}\n${item.ruleKey}\n${item.repeat}`,
        item,
      ]),
    );
    trailIndexes.set(record, index);
  }
  return index.get(`${at.split}\n${at.caseKey}\n${at.ruleKey}\n${at.repeat}`);
}

/**
 * What one version did with a slot, repeat by repeat. The scores come from the section of its
 * results file. Where it looked and what it cited come from the file's trails, and only when the
 * file has trails for the slot and the case files on disk are the ones the run read (their digest
 * is the recorded one). Otherwise the side says which, and keeps the scores.
 */
function sideTrail(args: {
  file: ResultsFile;
  section: SplitSection;
  change: SlotChange;
  read: ReadCase;
}): SideTrailView {
  const { file, section, change, read } = args;
  const scores: SlotScore[] = (section.metrics?.repeats ?? [])
    .flatMap((repeat) => repeat.slotScores)
    .filter((score) => score.caseKey === change.caseKey && score.ruleKey === change.ruleKey)
    .sort((a, b) => a.repeat - b.repeat);
  const slot = { split: section.split, caseKey: change.caseKey, ruleKey: change.ruleKey };
  const record = file.trails;
  const found =
    record === undefined
      ? []
      : scores.flatMap((score) => {
          const item = trailAt(record, { ...slot, repeat: score.repeat });
          return item === undefined ? [] : [item];
        });

  // Why the trail is not shown, if it is not: none was recorded for this slot, or the case files
  // on disk read differently from the way the run read them.
  const whyNot: "not_recorded" | "case_changed" | null =
    record === undefined || found.length === 0
      ? "not_recorded"
      : record.cases[change.caseKey] !== read.textDigest
        ? "case_changed"
        : null;
  const byRepeat = new Map(found.map((item) => [item.repeat, item]));
  const spanAt = new Map(
    read.spans.map((span) => [`${span.docLabel}:${span.paragraphIndex}`, span]),
  );

  return {
    recorded: whyNot === null,
    whyNot,
    repeats: bounded(
      scores.map((score) => {
        const item = whyNot === null ? byRepeat.get(score.repeat) : undefined;
        if (item !== undefined) {
          // The paragraphs a version cited are shown beside its trail, so they go into the case.
          for (const cited of item.cited) {
            const span = spanAt.get(`${cited.doc}:${cited.paragraph}`);
            const passage = span === undefined ? null : passageOf(span);
            if (passage !== null) read.cited.set(`${passage.doc}:${passage.paragraph}`, passage);
          }
        }
        return {
          repeat: score.repeat,
          observed: score.observed,
          correct: score.statusCorrect,
          failure: score.failure,
          silentMiss: score.silentMiss,
          verifiedQuotes: score.verifiedQuotes,
          verificationState: item === undefined ? null : item.verificationState,
          escalations: item === undefined ? [] : [...item.escalations],
          shown:
            item === undefined
              ? null
              : {
                  sent: item.shown.sent,
                  full: item.shown.full,
                  spans: bounded(
                    item.shown.spans.map((span) => ({ ...span })),
                    400,
                    "paragraphs shown for a slot",
                  ),
                },
          cited: item === undefined ? [] : item.cited.map((cited) => ({ ...cited })),
          checks:
            item === undefined
              ? null
              : {
                  pass: [...item.checks.pass],
                  fail: [...item.checks.fail],
                  notApplicable: [...item.checks.notApplicable],
                },
        };
      }),
      100,
      "repeats of a slot",
    ),
  };
}

/** The two names a document gives a split. A results file with another is not one this page shows. */
function splitOf(value: string): SplitName {
  if (value === "dev" || value === "heldout") return value;
  throw new PageError("A results file names a split that a page document does not know.");
}

function failuresOf(failures: readonly string[]): FailureKind[] {
  return failures.map((failure) => {
    if (!isFailureKind(failure)) {
      throw new PageError("A slot has a kind of failure that the page does not know.");
    }
    return failure;
  });
}

async function changeView(args: {
  change: SlotChange;
  baseline: SplitSection;
  candidate: SplitSection;
  baselineFile: ResultsFile;
  candidateFile: ResultsFile;
  playbook: LoadedPlaybook;
  dataset: Dataset;
  sealed: boolean;
  read: (caseKey: string) => Promise<ReadCase>;
}): Promise<ChangeView> {
  const { change, dataset } = args;
  const where = `${named(change.caseKey)} ${named(change.ruleKey)}`;
  const rule = args.playbook.rules.find((entry) => entry.key === change.ruleKey);
  const keyCase = dataset.keys.cases.find((entry) => entry.case === change.caseKey);
  const expectation = keyCase?.expect[change.ruleKey];
  if (rule === undefined || keyCase === undefined || expectation === undefined) {
    throw new PageError(
      `The changed slot ${where} is not in the answer key and the playbook on disk.`,
    );
  }
  const view = {
    caseKey: change.caseKey,
    ruleKey: change.ruleKey,
    ruleTitle: clip(rule.title, 300),
    severity: change.severity,
    expected: change.expected,
    acceptable: [...expectation.acceptable],
    kind: change.kind,
    baseline: { ...change.baseline, failures: failuresOf(change.baseline.failures) },
    candidate: { ...change.candidate, failures: failuresOf(change.candidate.failures) },
  };
  if (args.sealed) return { ...view, trail: { sealed: true } };
  const read = await args.read(change.caseKey);
  return {
    ...view,
    trail: {
      key: keyOf(read, expectation, where),
      baseline: sideTrail({ file: args.baselineFile, section: args.baseline, change, read }),
      candidate: sideTrail({ file: args.candidateFile, section: args.candidate, change, read }),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------

function checkDataset(input: PageInput, sections: readonly SectionComparison[]): void {
  const { dataset } = input;
  for (const [side, file] of [
    ["baseline", input.baseline.results],
    ["candidate", input.candidate.results],
  ] as const) {
    if (file.pins.dataset.answerKeysSha256 !== dataset.answerKeysSha256) {
      throw new PageError(
        `The answer keys on disk are not the ones the ${side} run was made with (their hash differs from the one in its results file). Check out the commit named in the results file and publish again.`,
      );
    }
    for (const section of sections) {
      const split = splitOf(section.split);
      const here = dataset.integrity.find((entry) => entry.split === split);
      if (here === undefined || file.pins.dataset.splits[split] !== here.sha256) {
        throw new PageError(
          `The case files of the ${split} split on disk are not the ones the ${side} run read (the hash of the split differs from the one in its results file). Check out the commit named in the results file and publish again.`,
        );
      }
    }
  }
  if (input.playbook.sha256 !== dataset.keys.playbook.sha256) {
    throw new PageError(
      "The playbook is not the version the answer keys were built for (its hash differs from the one in the answer keys).",
    );
  }
}

async function sectionView(args: {
  input: PageInput;
  section: SectionComparison;
  read: (caseKey: string) => Promise<ReadCase>;
}): Promise<SectionView> {
  const { input, section } = args;
  const find = (file: ResultsFile): SplitSection => {
    const found = file.sections.find((entry) => entry.split === section.split);
    if (found === undefined || found.metrics === null) {
      throw new PageError(
        `A results file has no scored ${section.split} section, so it cannot be compared.`,
      );
    }
    return found;
  };
  const baseline = find(input.baseline.results);
  const candidate = find(input.candidate.results);
  const side = (entry: SplitSection): SectionView["sides"]["baseline"] => ({
    cases: entry.caseKeys.length,
    casesInSplit: entry.casesInSplit,
    fullSplit: entry.fullSplit,
    completedRepeats: entry.completedRepeats,
  });
  const sealed = section.split === "heldout" && !input.openHeldoutTrails;
  const changes: ChangeView[] = [];
  for (const change of bounded(section.changes, 500, "changed slots")) {
    changes.push(
      await changeView({
        change,
        baseline,
        candidate,
        baselineFile: input.baseline.results,
        candidateFile: input.candidate.results,
        playbook: input.playbook,
        dataset: input.dataset,
        sealed,
        read: args.read,
      }),
    );
  }
  const decision = section.decision;
  return {
    split: splitOf(section.split),
    repeats: clip(section.repeats, 100),
    sides: { baseline: side(baseline), candidate: side(candidate) },
    rows: bounded(
      section.rows.map((row) => ({
        metric: clip(row.metric, 300),
        baseline: clip(row.baseline),
        candidate: clip(row.candidate),
        change: clip(row.change),
        gate: clip(row.gate),
        pass: clip(row.pass),
      })),
      40,
      "metric rows",
    ),
    gates: {
      baseline: gateViews(section.baselineGates),
      candidate: gateViews(section.candidateGates),
    },
    paired: section.paired,
    unpaired: section.unpaired,
    changes,
    // The label of the outcome is the application's. Only the outcome and the reasons travel.
    decision:
      decision === null
        ? null
        : {
            outcome: decision.outcome,
            reasons: bounded(
              decision.reasons.map((text) => clip(text)),
              40,
              "decision reasons",
            ),
            conditions: bounded(
              decision.conditions.map((text) => clip(text)),
              40,
              "decision conditions",
            ),
            unchecked: bounded(
              decision.unchecked.map((text) => clip(text)),
              40,
              "unchecked conditions",
            ),
          },
    decisionNote: section.decisionNote === null ? null : clip(section.decisionNote),
    notes: bounded(
      section.notes.map((text) => clip(text)),
      40,
      "notes",
    ),
  };
}

/**
 * The page document for one comparison. Throws `PageError` when the comparison cannot be shown
 * faithfully (the dataset on disk is not the one the runs were made with, a gate report is not
 * whole, the document would be too large) and never returns a document that the application's
 * reader would refuse.
 */
export async function buildComparisonPage(input: PageInput): Promise<ComparisonPage> {
  const { comparison } = input;
  // The type says the comparison was made; a caller that got round it is told.
  if (!comparison.ok) throw new PageError("A comparison that was refused cannot be published.");
  if (comparison.sections.length === 0) {
    throw new PageError("No split could be compared, so there is nothing to publish.");
  }
  checkDataset(input, comparison.sections);

  const read = caseReader(input.dataset);
  const sections: SectionView[] = [];
  for (const section of comparison.sections)
    sections.push(await sectionView({ input, section, read }));

  // Only the cases that have a changed slot whose key is shown. A sealed section reads no case.
  const cases: ComparisonBody["cases"] = {};
  const caseKeys = [
    ...new Set(
      sections.flatMap((section) =>
        section.changes.filter((c) => !("sealed" in c.trail)).map((c) => c.caseKey),
      ),
    ),
  ].sort();
  bounded(caseKeys, 40, "cases with a changed slot");
  for (const caseKey of caseKeys) {
    const entry = await read(caseKey);
    cases[caseKey] = {
      documents: entry.documents,
      passages: bounded(
        mergePassages(entry.passages, entry.cited),
        MAX_PASSAGES,
        `passages of ${named(caseKey)}`,
      ),
    };
  }

  const baseline = input.baseline.results;
  const candidate = input.candidate.results;
  const body: ComparisonBody = {
    format: 1,
    kind: "parol-comparison-page",
    files: {
      baseline: baseNameOf(input.baseline.file),
      candidate: baseNameOf(input.candidate.file),
    },
    sides: { baseline: sideFacts(baseline), candidate: sideFacts(candidate) },
    dataset: {
      label: clip(candidate.pins.dataset.label, 200),
      answerKeysSha256: candidate.pins.dataset.answerKeysSha256,
      splitsFileSha256: candidate.pins.dataset.splitsFileSha256,
    },
    playbook: {
      slug: clip(candidate.pins.playbook.slug, 200),
      version: clip(candidate.pins.playbook.version, 100),
      sha256: candidate.pins.playbook.sha256,
    },
    evaluation: {
      label: clip(candidate.pins.evaluation.label, 100),
      sha256: candidate.pins.evaluation.sha256,
    },
    differences: bounded(
      comparison.differences.map((difference) => {
        if (difference.status === "refused") {
          throw new PageError("A comparison with a refused difference cannot be published.");
        }
        return {
          name: clip(difference.name, 100),
          field: clip(difference.field, 100),
          baseline: clip(difference.baseline, 300),
          candidate: clip(difference.candidate, 300),
          status: difference.status,
        };
      }),
      200,
      "differences between the runs",
    ),
    notes: bounded(
      comparison.notes.map((text) => clip(text)),
      40,
      "notes",
    ),
    // Opened means that material of the held-out split is in the document.
    heldoutTrailsOpened:
      input.openHeldoutTrails && sections.some((section) => section.split === "heldout"),
    sections,
    cases,
  };
  const page = sealComparisonPage(body);

  const text = serialiseComparisonPage(page);
  if (Buffer.byteLength(text, "utf8") > (input.maxBytes ?? MAX_PAGE_BYTES)) {
    throw new PageError(
      "The page document would be larger than the application reads. Narrow the comparison to fewer cases (--case) and publish again.",
    );
  }
  // The same reader the application uses: a document it would refuse is not handed on.
  const checked = parseComparisonPage(text, pageFileName(page.id));
  if (!checked.ok) {
    throw new PageError(
      `The page document built here is not accepted by the application's reader (${checked.problem}). This is a bug in the evaluation.`,
    );
  }
  return page;
}
