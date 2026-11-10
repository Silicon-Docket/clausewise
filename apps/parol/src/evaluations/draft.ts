import { revealToString } from "../server/views/reveal.js";
import type { ComparisonPage, GateView, SectionView, SideFacts, SplitName } from "./document.js";
import {
  DECISION_LABEL,
  GATE_OUTCOME_LABEL,
  HELDOUT_OPENED,
  NOT_A_RECOMMENDATION,
  NOT_CLEAN,
  warningsFor,
} from "./words.js";

/**
 * The draft of a promotion record, as plain Markdown text, for one split of one comparison. It is
 * text only: it records nothing, promotes nothing and is signed by nobody. Every blank a person
 * must fill (the decision, the conditions, the sign-off) is left blank.
 *
 * The same page and split always give the same text. Anything that came from the file is cut to a
 * single line, has its invisible characters printed as markers, and has no dash character in it, so
 * the text can be pasted into a document without surprises.
 */

const LONG_DASHES = /[\u2013\u2014]/g;

/** One line of file text: markers for the invisible, one space for any white space, no long dash. */
const line = (value: string): string =>
  revealToString(value).replace(LONG_DASHES, "-").replace(/\s+/g, " ").trim();

/** A table cell: one line, with the cell separator written so that it cannot end the cell. */
const cell = (value: string): string => line(value).replace(/\|/g, "\\|");

const shortHash = (sha256: string): string => sha256.slice(0, 12);

const repeatsText = (n: number): string => `${n} ${n === 1 ? "repeat" : "repeats"}`;

function sideLine(label: string, side: SideFacts): string {
  const reported = side.model.reported === null ? "not reported" : side.model.reported.join(", ");
  const commit =
    side.code.commit === null
      ? "no commit recorded"
      : `${side.code.commit}${side.code.dirty === true ? ", uncommitted changes" : ""}`;
  return `${label}: workflow ${line(side.workflow.label)} (${shortHash(side.workflow.sha256)}); mode ${side.mode}; model requested ${line(side.model.requested)}, reported ${line(reported)}; code ${line(commit)}`;
}

function gateRow(
  id: string,
  title: string,
  threshold: string,
  baseline: GateView | undefined,
  candidate: GateView | undefined,
): string {
  const say = (gate: GateView | undefined): string =>
    gate === undefined
      ? "no gate report"
      : gate.outcome === "not_evaluated"
        ? `${GATE_OUTCOME_LABEL.not_evaluated}: ${cell(gate.detail)}`
        : GATE_OUTCOME_LABEL[gate.outcome];
  return `| ${id} | ${cell(title)} | ${cell(threshold)} | ${say(baseline)} | ${say(candidate)} |`;
}

function gateTable(section: SectionView): string[] {
  const baseline = section.gates.baseline;
  const candidate = section.gates.candidate;
  const rows = (baseline ?? candidate ?? []).map((gate, index) =>
    gateRow(gate.id, gate.title, gate.threshold, baseline?.[index], candidate?.[index]),
  );
  if (rows.length === 0) return ["No gate report was recorded for this split."];
  return [
    "| Gate | Title | Threshold | Baseline | Candidate |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ];
}

function changeLines(section: SectionView): string[] {
  const head = `${section.changes.length} of ${section.paired} paired slots changed (${section.unpaired} not paired).`;
  return [
    head,
    "",
    ...section.changes.map(
      (c) =>
        `- ${c.kind}: ${c.caseKey} ${c.ruleKey} (${line(c.ruleTitle)}), ${c.severity} severity, expected ${c.expected}; baseline ${line(c.baseline.histogram)}, ${c.baseline.correct} of ${c.baseline.repeats} right; candidate ${line(c.candidate.histogram)}, ${c.candidate.correct} of ${c.candidate.repeats} right`,
    ),
  ];
}

function decisionLines(section: SectionView): string[] {
  const d = section.decision;
  if (d === null)
    return [
      `Not applied: ${line(section.decisionNote ?? "The decision rule was not applied to this comparison.")}`,
    ];
  return [
    `${DECISION_LABEL[d.outcome]}. ${NOT_A_RECOMMENDATION}`,
    "",
    ...d.reasons.map((reason) => `- ${line(reason)}`),
    ...d.conditions.map((condition) => `- Condition: ${line(condition)}`),
    "",
    "Conditions of the rule that this comparison cannot check:",
    "",
    ...d.unchecked.map((item) => `- ${line(item)}`),
  ];
}

export function draftPromotionRecord(page: ComparisonPage, split: SplitName): string {
  const section = page.sections.find((s) => s.split === split) ?? page.sections[0];
  if (section === undefined) return "";
  const { baseline, candidate } = page.sides;
  const out: string[] = [];
  const add = (...lines: string[]): void => {
    out.push(...lines);
  };

  add(
    "# Promotion record (DRAFT, not signed)",
    "",
    "DRAFT TEXT FROM A COMPARISON FILE. IT IS NOT A DECISION AND IT PROMOTES NOTHING.",
    "",
  );
  const warnings = warningsFor([baseline.mode, candidate.mode]);
  for (const warning of warnings) add(warning, "");
  for (const [name, side] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ] as const) {
    if (!side.health.clean)
      add(`${NOT_CLEAN}: the ${name} run. ${side.health.problems.map(line).join(" ")}`.trim(), "");
  }
  if (page.heldoutTrailsOpened) add(HELDOUT_OPENED, "");

  add(
    "## Facts",
    "",
    `- Comparison: ${page.id}`,
    `- Baseline file: ${line(page.files.baseline)}`,
    `- Candidate file: ${line(page.files.candidate)}`,
    `- Split: ${section.split}, repeats scored: ${line(section.repeats)}`,
    `- Baseline: ${section.sides.baseline.cases} of ${section.sides.baseline.casesInSplit} cases of the split, ${repeatsText(section.sides.baseline.completedRepeats)} completed`,
    `- Candidate: ${section.sides.candidate.cases} of ${section.sides.candidate.casesInSplit} cases of the split, ${repeatsText(section.sides.candidate.completedRepeats)} completed`,
    `- ${sideLine("Baseline version", baseline)}`,
    `- ${sideLine("Candidate version", candidate)}`,
    `- Playbook: ${line(page.playbook.slug)} ${line(page.playbook.version)} (${shortHash(page.playbook.sha256)})`,
    `- Dataset: ${line(page.dataset.label)}; answer keys ${shortHash(page.dataset.answerKeysSha256)}; splits file ${shortHash(page.dataset.splitsFileSha256)}`,
    `- Evaluation version: ${line(page.evaluation.label)} (${shortHash(page.evaluation.sha256)})`,
  );
  if (split === "heldout")
    for (const [name, side] of [
      ["Baseline", baseline],
      ["Candidate", candidate],
    ] as const)
      if (side.contamination !== null)
        add(`- ${name} contamination note: ${line(side.contamination)}`);
  add("");

  add("## Gates", "", ...gateTable(section), "");
  add("## Result of the decision rule", "", ...decisionLines(section), "");
  const notes = [...page.notes, ...section.notes];
  if (notes.length > 0) add("## Notes", "", ...notes.map((note) => `- ${line(note)}`), "");
  add("## Changed slots", "", ...changeLines(section), "");
  add(
    "## What this record does not show",
    "",
    "- Results files hold no model answers, so this record cannot show what either version wrote.",
    "- A comparison file proves nothing about who made it.",
    "- A scripted or replayed run is not a measurement of a model.",
    "",
    "## To be filled in by a person",
    "",
    "Decision: ____",
    "",
    "Conditions and review date: ____",
    "",
    "Signed off by (legal engineer): ____ Date: ____",
    "",
    "Supervising attorney (a real pilot only): ____ Date: ____",
    "",
  );
  return out.join("\n");
}
