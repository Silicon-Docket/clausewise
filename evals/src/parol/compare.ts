/**
 * Comparison of two Parol results files: a baseline and a candidate (docs/parol/05, "Pinning and
 * repeatability" and "Comparison report template").
 *
 * Two runs are comparable only if every pin matches except the variable under test, which is the
 * workflow. A difference anywhere else makes the two numbers answer different questions, so the
 * comparison is refused and every difference is listed, unless the caller names the differences it
 * expects (`--allow-differences`). The evaluation version can never be allowed: a changed weight
 * or threshold changes what a score means, and old runs are re-scored and not compared across
 * versions.
 *
 * The decision rule of the improvement cycle is computed here from the gates and the paired slots.
 * It is worded as a gate result and never as a recommendation: promotion is a decision in a
 * promotion record signed off by the legal engineer. It is applied only to a comparison of two
 * live runs of the whole held-out split, and it lists the conditions of the rule that a comparison
 * of two files cannot check.
 *
 * Gates are worked out again from the metrics in the files, with the baseline for G12 and G13, and
 * are not read back from what a file says about itself.
 */
import { STATUSES, type Status } from "../../../apps/parol/src/contracts.js";
import { UsageError } from "../errors.js";
import { NA, change, dollars, md, rateCell, ratio, seconds, shortSha, table } from "./format.js";
import { GATES, evaluateGates, type GateId, type GateReport } from "./gates.js";
import {
  NOT_CLEAN,
  SELFTEST_BANNER,
  REPLAY_BANNER,
  SIMULATED_BANNER,
  gateSubjectOf,
  isScripted,
  runHealth,
  type Pins,
  type ResultsFile,
  type RunHealth,
  type SplitSection,
} from "./results.js";
import {
  SEVERITY_WEIGHTS,
  summarizeRun,
  type RateMetricName,
  type RunMetrics,
  type SlotScore,
} from "./score.js";

// ---------------------------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------------------------

/** The groups of pins a difference can be in, and so the names `--allow-differences` takes. */
export const PIN_NAMES = [
  "dataset",
  "split",
  "playbook",
  "workflow",
  "model",
  "model-reported",
  "settings",
  "prices",
  "evaluation",
  "code",
  "repeats",
  "mode",
] as const;
export type PinName = (typeof PIN_NAMES)[number];

/** The variable under test. A difference in it is the point of the comparison. */
export const DECLARED_VARIABLE: PinName = "workflow";

export interface PinDifference {
  name: PinName;
  /** The pin, as a dotted path. */
  field: string;
  baseline: string;
  candidate: string;
  status: "declared" | "allowed" | "refused";
}

type Flat = Map<string, string>;

function flatten(value: unknown, prefix: string, into: Flat): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      flatten(inner, prefix === "" ? key : `${prefix}.${key}`, into);
    }
    return;
  }
  into.set(prefix, Array.isArray(value) ? JSON.stringify(value) : String(value));
}

const flat = (value: unknown, prefix: string): Flat => {
  const into: Flat = new Map();
  flatten(value, prefix, into);
  return into;
};

/** Each group of pins as a flat map of dotted path to text. */
function groups(pins: Pins): Record<PinName, Flat> {
  return {
    dataset: flat(pins.dataset, "dataset"),
    split: flat({ split: pins.split, cases: pins.cases }, "run"),
    playbook: flat(pins.playbook, "playbook"),
    workflow: flat(pins.workflow, "workflow"),
    model: flat(
      {
        provider: pins.model.provider,
        requested: pins.model.requested,
        // A file written before the endpoint was pinned says nothing about it, which reads as null.
        endpoint: pins.model.endpoint ?? null,
      },
      "model",
    ),
    "model-reported": flat({ reported: pins.model.reported }, "model"),
    settings: flat({ generation: pins.generation }, "settings"),
    prices: flat({ prices: pins.prices }, "prices"),
    evaluation: flat(pins.evaluation, "evaluation"),
    code: flat(pins.code, "code"),
    repeats: flat({ repeats: pins.repeats }, "run"),
    mode: flat({ mode: pins.mode }, "run"),
  };
}

export function parseAllowDifferences(values: readonly string[]): PinName[] {
  const names = values.flatMap((value) => value.split(",")).map((name) => name.trim());
  const allowed: PinName[] = [];
  for (const name of names) {
    if (name === "") throw new UsageError("Option --allow-differences needs a name.");
    if (!(PIN_NAMES as readonly string[]).includes(name)) {
      throw new UsageError(
        `--allow-differences does not know a pin with that name. The names are: ${PIN_NAMES.join(", ")}.`,
      );
    }
    if (name === "evaluation") {
      throw new UsageError(
        "A difference in the evaluation version cannot be allowed: scores made with different metrics, weights or gates do not mean the same thing, and old runs are re-scored and not compared across versions.",
      );
    }
    if (!allowed.includes(name as PinName)) allowed.push(name as PinName);
  }
  return allowed;
}

/** Every difference between the pins of two runs, marked as declared, allowed or refused. */
export function diffPins(
  baseline: Pins,
  candidate: Pins,
  options: { allow?: readonly PinName[]; skip?: readonly PinName[] } = {},
): PinDifference[] {
  const allow = new Set<PinName>(options.allow ?? []);
  const skip = new Set<PinName>(options.skip ?? []);
  const a = groups(baseline);
  const b = groups(candidate);
  const differences: PinDifference[] = [];
  for (const name of PIN_NAMES) {
    if (skip.has(name)) continue;
    const fields = [...new Set([...a[name].keys(), ...b[name].keys()])].sort();
    for (const field of fields) {
      const before = a[name].get(field) ?? "(absent)";
      const after = b[name].get(field) ?? "(absent)";
      if (before === after) continue;
      differences.push({
        name,
        field,
        baseline: before,
        candidate: after,
        status:
          name === DECLARED_VARIABLE
            ? "declared"
            : name !== "evaluation" && allow.has(name)
              ? "allowed"
              : "refused",
      });
    }
  }
  return differences;
}

// ---------------------------------------------------------------------------------------------
// Paired slots
// ---------------------------------------------------------------------------------------------

export interface SlotSide {
  /** The most common status over the repeats; a tie goes to the earlier status in the list. */
  modal: Status;
  /** Statuses and how often, such as "compliant x3". */
  histogram: string;
  /** Repeats in which the status was right. */
  correct: number;
  repeats: number;
  /** Failure kinds seen, if any. */
  failures: string[];
}

export interface SlotChange {
  caseKey: string;
  ruleKey: string;
  severity: "high" | "medium" | "low";
  expected: Status;
  baseline: SlotSide;
  candidate: SlotSide;
  kind: "regression" | "improvement" | "changed";
}

function sideOf(scores: readonly SlotScore[]): SlotSide {
  const counts = new Map<Status, number>();
  for (const s of scores) counts.set(s.observed, (counts.get(s.observed) ?? 0) + 1);
  let modal: Status = scores[0]?.observed ?? "undetermined";
  let best = 0;
  for (const status of STATUSES) {
    const n = counts.get(status) ?? 0;
    if (n > best) {
      best = n;
      modal = status;
    }
  }
  return {
    modal,
    histogram: STATUSES.filter((status) => (counts.get(status) ?? 0) > 0)
      .map((status) => `${status} x${counts.get(status)}`)
      .join(", "),
    correct: scores.filter((s) => s.statusCorrect).length,
    repeats: scores.length,
    failures: [...new Set(scores.flatMap((s) => (s.failure === null ? [] : [s.failure])))],
  };
}

const bySlot = (run: RunMetrics): Map<string, SlotScore[]> => {
  const slots = new Map<string, SlotScore[]>();
  for (const m of run.repeats) {
    for (const s of m.slotScores) {
      const id = `${s.caseKey}\u0000${s.ruleKey}`;
      slots.set(id, [...(slots.get(id) ?? []), s]);
    }
  }
  return slots;
};

/**
 * The slots whose answer changed between two runs, paired by (case, rule). A slot changed if its
 * most common status differs or the share of repeats that were right differs. Regressions come
 * first, the high-severity ones first among them, then improvements, then slots that changed
 * without getting better or worse. `unpaired` counts slots present in only one of the runs.
 */
export function pairSlots(
  baseline: RunMetrics,
  candidate: RunMetrics,
): { changes: SlotChange[]; paired: number; unpaired: number } {
  const a = bySlot(baseline);
  const b = bySlot(candidate);
  const changes: SlotChange[] = [];
  let paired = 0;
  for (const [id, before] of a) {
    const after = b.get(id);
    if (after === undefined) continue;
    paired += 1;
    const x = sideOf(before);
    const y = sideOf(after);
    const shareX = x.correct / x.repeats;
    const shareY = y.correct / y.repeats;
    if (x.modal === y.modal && Math.abs(shareX - shareY) < 1e-9) continue;
    const first = before[0]!;
    changes.push({
      caseKey: first.caseKey,
      ruleKey: first.ruleKey,
      severity: first.severity,
      expected: first.expected,
      baseline: x,
      candidate: y,
      kind:
        shareY < shareX - 1e-9 ? "regression" : shareY > shareX + 1e-9 ? "improvement" : "changed",
    });
  }
  const order = { regression: 0, improvement: 1, changed: 2 } as const;
  changes.sort(
    (p, q) =>
      order[p.kind] - order[q.kind] ||
      SEVERITY_WEIGHTS[q.severity] - SEVERITY_WEIGHTS[p.severity] ||
      p.caseKey.localeCompare(q.caseKey) ||
      p.ruleKey.localeCompare(q.ruleKey),
  );
  let unpaired = 0;
  for (const id of b.keys()) if (!a.has(id)) unpaired += 1;
  for (const id of a.keys()) if (!b.has(id)) unpaired += 1;
  return { changes, paired, unpaired };
}

// ---------------------------------------------------------------------------------------------
// The decision rule
// ---------------------------------------------------------------------------------------------

export type DecisionOutcome = "promote" | "promote_with_conditions" | "do_not_promote";

export interface Decision {
  outcome: DecisionOutcome;
  /** The outcome in words, always as a gate result. */
  label: string;
  reasons: string[];
  conditions: string[];
  /** Conditions of the rule that a comparison of two files cannot check. */
  unchecked: string[];
}

const LABELS: Record<DecisionOutcome, string> = {
  promote: "PROMOTE TO PILOT, as a gate result",
  promote_with_conditions: "PROMOTE WITH CONDITIONS, as a gate result",
  do_not_promote: "DO NOT PROMOTE, as a gate result",
};

/**
 * The decision rule of document 5 from the candidate's gates (with the baseline for G12 and G13)
 * and the paired slots.
 *
 *  - Any failed gate other than G13 is "do not promote", and so is a new high-severity failure.
 *  - With no gate failed, a gate that was not evaluated is not a pass, and promotion needs every
 *    gate to pass, so the outcome is "do not promote" with that reason.
 *  - G13 alone failing (cost or latency over the budget), or a low or medium severity regression,
 *    is "promote with conditions".
 *  - Otherwise "promote".
 */
export function decideFromGates(args: {
  gates: GateReport;
  changes: readonly SlotChange[];
  repeats: number;
}): Decision {
  const { gates, changes } = args;
  const hard = gates.failed.filter((id) => id !== "G13");
  const newHigh = changes.filter(
    (c) =>
      c.severity === "high" &&
      c.baseline.correct === c.baseline.repeats &&
      c.candidate.correct < c.candidate.repeats,
  );
  const softRegressions = changes.filter((c) => c.kind === "regression" && c.severity !== "high");
  const title = (id: GateId): string => GATES.find((g) => g.id === id)!.title;

  const unchecked = [
    "The targeted failure is fixed in 3 of 3 repeats of the dev re-run (step 7 of the improvement cycle): checked by comparing the dev runs, not this one.",
    "The improvement is not on dev alone (overfitting): needs the dev comparison beside this one.",
    ...(args.repeats === 3
      ? []
      : [`The protocol asks for k = 3 and this comparison has k = ${args.repeats}.`]),
  ];

  let outcome: DecisionOutcome;
  const reasons: string[] = [];
  const conditions: string[] = [];
  if (hard.length > 0 || newHigh.length > 0) {
    outcome = "do_not_promote";
    for (const id of hard) {
      reasons.push(
        `${id} failed (${title(id)})${/^G[1-5]$/.test(id) ? ", and any failure of G1 to G5 rules out promotion" : ""}.`,
      );
    }
    if (newHigh.length > 0) {
      reasons.push(
        `${newHigh.length} high-severity ${newHigh.length === 1 ? "slot" : "slots"} that every baseline repeat got right ${newHigh.length === 1 ? "is" : "are"} wrong in the candidate.`,
      );
    }
  } else if (gates.notEvaluated.length > 0) {
    outcome = "do_not_promote";
    reasons.push(
      `No gate failed, but ${gates.notEvaluated.join(", ")} ${gates.notEvaluated.length === 1 ? "was" : "were"} not evaluated, and promotion needs every gate to pass.`,
    );
  } else if (gates.failed.includes("G13") || softRegressions.length > 0) {
    outcome = "promote_with_conditions";
    if (gates.failed.includes("G13")) {
      conditions.push(
        "Cost or latency is over the budget (G13). Write the conditions and a review date.",
      );
    }
    if (softRegressions.length > 0) {
      conditions.push(
        `${softRegressions.length} lower-severity ${softRegressions.length === 1 ? "slot" : "slots"} got worse (listed under the paired slots). Write the conditions and a review date.`,
      );
    }
  } else {
    outcome = "promote";
    reasons.push("Every gate passed and no slot got worse.");
  }
  return { outcome, label: LABELS[outcome], reasons, conditions, unchecked };
}

// ---------------------------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------------------------

export interface TableRow {
  metric: string;
  baseline: string;
  candidate: string;
  change: string;
  gate: string;
  pass: string;
}

export interface SectionComparison {
  split: string;
  /** Repeats scored: one number when the runs agree, otherwise both. */
  repeats: string;
  baselineGates: GateReport | null;
  candidateGates: GateReport | null;
  rows: TableRow[];
  changes: SlotChange[];
  paired: number;
  unpaired: number;
  decision: Decision | null;
  /** Why the decision rule was not applied, or null when it was. */
  decisionNote: string | null;
  notes: string[];
}

export type Comparison =
  | {
      ok: false;
      differences: PinDifference[];
      /** Reasons other than a pin that a comparison cannot be made. */
      problems: string[];
    }
  | {
      ok: true;
      differences: PinDifference[];
      baselineName: string;
      candidateName: string;
      baselineMode: ResultsFile["mode"];
      candidateMode: ResultsFile["mode"];
      /** Whether each run measured the model alone: see `runHealth`. */
      baselineHealth: RunHealth;
      candidateHealth: RunHealth;
      sections: SectionComparison[];
      notes: string[];
    };

const GATE_TEXT: Record<string, string> = {
  G1: "0",
  G4: "0",
  G5: "0",
  G6: ">= 0.90 (17 of 18)",
  G7: ">= 0.80",
  G8: "1.0",
  G9: "<= 0.15",
  G10: ">= 0.90",
  G12: "not higher than baseline",
  G13: "1.5 x baseline, or a budget",
  G14: ">= 0.90",
};

function runOf(section: SplitSection): RunMetrics | null {
  return section.metrics === null
    ? null
    : { repeats: section.metrics.repeats, stability: section.metrics.stability };
}

const outcomeText = (gates: GateReport | null, id: GateId): string => {
  const result = gates?.results.find((r) => r.id === id);
  if (result === undefined) return "not evaluated";
  return result.outcome === "pass" ? "pass" : result.outcome === "fail" ? "FAIL" : "not evaluated";
};

function compareSections(
  baseline: ResultsFile,
  candidate: ResultsFile,
  a: SplitSection,
  b: SplitSection,
): SectionComparison {
  const runA = runOf(a)!;
  const runB = runOf(b)!;
  // Latency and cost are known only for a live run; a scripted run has none.
  const subject = (file: ResultsFile, section: SplitSection, run: RunMetrics) =>
    gateSubjectOf(
      run,
      isScripted(file.mode) ? null : section.latency,
      isScripted(file.mode) ? null : section.cost,
    );
  const baselineSubject = subject(baseline, a, runA);
  const candidateSubject = subject(candidate, b, runB);
  const baselineGates = evaluateGates(baselineSubject);
  const candidateGates = evaluateGates(candidateSubject, baselineSubject);

  const sa = summarizeRun(runA);
  const sb = summarizeRun(runB);
  const rate = (label: string, metric: RateMetricName, gate: GateId | null): TableRow => {
    const x = rateCell(sa.rates[metric]);
    const y = rateCell(sb.rates[metric]);
    return {
      metric: label,
      baseline: `${x.result} (${x.counts})`,
      candidate: `${y.result} (${y.counts})`,
      change: change(sa.rates[metric].mean, sb.rates[metric].mean),
      gate: gate === null ? NA : (GATE_TEXT[gate] ?? NA),
      pass: gate === null ? NA : outcomeText(candidateGates, gate),
    };
  };
  const perRepeat = (run: RunMetrics, pick: (m: RunMetrics["repeats"][number]) => number): string =>
    run.repeats.map((m) => String(pick(m))).join("; ");
  const meanOf = (
    run: RunMetrics,
    pick: (m: RunMetrics["repeats"][number]) => number,
  ): number | null =>
    run.repeats.length === 0
      ? null
      : run.repeats.reduce((t, m) => t + pick(m), 0) / run.repeats.length;
  const count = (
    label: string,
    gate: GateId,
    pick: (m: RunMetrics["repeats"][number]) => number,
  ): TableRow => ({
    metric: label,
    baseline: perRepeat(runA, pick),
    candidate: perRepeat(runB, pick),
    change: change(meanOf(runA, pick), meanOf(runB, pick), 2),
    gate: GATE_TEXT[gate] ?? NA,
    pass: outcomeText(candidateGates, gate),
  });

  const ra = summarizeRun(runA);
  const rb = summarizeRun(runB);
  const swf = (s: ReturnType<typeof summarizeRun>): string => ratio(s.swf.mean);
  const stable = (run: RunMetrics): number | null =>
    run.stability !== null && run.stability.repeats >= 2 ? run.stability.meanAgreement : null;

  const la = a.latency;
  const lb = b.latency;
  const ca = a.cost;
  const cb = b.cost;
  const rows: TableRow[] = [
    rate("Issue recall, strict (count)", "issueRecallStrict", "G6"),
    rate("Issue precision, strict (count)", "issuePrecisionStrict", "G7"),
    count("High-severity silent misses", "G4", (m) => m.silentMisses.bySeverity.high),
    count("Verified but unsupported", "G5", (m) => m.support.verifiedButUnsupported.count),
    rate("Required escalation recall", "requiredEscalationRecall", "G8"),
    rate("Unnecessary escalation rate", "unnecessaryEscalationRate", "G9"),
    rate("Extraction span recall", "extractionRecall", "G10"),
    {
      metric: "SWF",
      baseline: swf(ra),
      candidate: swf(rb),
      change: change(ra.swf.mean, rb.swf.mean),
      gate: GATE_TEXT.G12 ?? NA,
      pass: outcomeText(candidateGates, "G12"),
    },
    {
      metric: "Stability (mean modal agreement)",
      baseline: ratio(stable(runA)),
      candidate: ratio(stable(runB)),
      change: change(stable(runA), stable(runB)),
      gate: GATE_TEXT.G14 ?? NA,
      pass: outcomeText(candidateGates, "G14"),
    },
    {
      metric: "p50 / p95 run latency (s)",
      baseline: la === null ? NA : `${seconds(la.total.p50)} / ${seconds(la.total.p95)}`,
      candidate: lb === null ? NA : `${seconds(lb.total.p50)} / ${seconds(lb.total.p95)}`,
      change:
        la === null || lb === null || la.total.p95 === null || lb.total.p95 === null
          ? NA
          : change(la.total.p95 / 1000, lb.total.p95 / 1000, 2),
      gate: GATE_TEXT.G13 ?? NA,
      pass: outcomeText(candidateGates, "G13"),
    },
    {
      metric: "Mean / max cost per run (USD)",
      baseline: ca === null ? NA : `${dollars(ca.meanUsd)} / ${dollars(ca.maxUsd)}`,
      candidate: cb === null ? NA : `${dollars(cb.meanUsd)} / ${dollars(cb.maxUsd)}`,
      change: ca === null || cb === null ? NA : change(ca.meanUsd, cb.meanUsd, 4),
      gate: GATE_TEXT.G13 ?? NA,
      pass: outcomeText(candidateGates, "G13"),
    },
    {
      metric: "Prompt tokens read from cache",
      baseline: ca === null ? NA : ratio(ca.cacheReadShare),
      candidate: cb === null ? NA : ratio(cb.cacheReadShare),
      change: ca === null || cb === null ? NA : change(ca.cacheReadShare, cb.cacheReadShare),
      gate: NA,
      pass: NA,
    },
    {
      metric: "Unauthorized-data exposure",
      baseline: NA,
      candidate: NA,
      change: NA,
      gate: GATE_TEXT.G1 ?? NA,
      pass: outcomeText(candidateGates, "G1"),
    },
  ];

  const { changes, paired, unpaired } = pairSlots(runA, runB);
  const notes: string[] = [];
  let decision: Decision | null = null;
  let decisionNote: string | null = null;
  if (isScripted(baseline.mode) || isScripted(candidate.mode)) {
    decisionNote =
      "The decision rule is not applied: a comparison that involves a selftest or a simulated run says nothing about any model.";
  } else if (b.split !== "heldout") {
    decisionNote =
      "The decision rule is not applied: it is a rule for held-out runs, and this is the dev split. The gate results above are indicative.";
  } else if (!a.fullSplit || !b.fullSplit) {
    decisionNote =
      "The decision rule is not applied: it needs the whole held-out split, and one of the runs covers a subset of its cases.";
  } else if (!runHealth(baseline, a.split).clean || !runHealth(candidate, b.split).clean) {
    decisionNote =
      "The decision rule is not applied: a run in this comparison is not a clean measurement (calls failed on the wire, an extraction fell back to the whole document, or a rule was not sent), so its slots do not show what the model answered. Run again once the cause is fixed.";
  } else {
    decision = decideFromGates({
      gates: candidateGates,
      changes,
      repeats: runB.repeats.length,
    });
  }
  if (a.completedRepeats !== b.completedRepeats) {
    notes.push(
      `The runs scored different numbers of repeats (${a.completedRepeats} and ${b.completedRepeats}); slots are paired by their share of correct repeats.`,
    );
  }
  if (unpaired > 0) {
    notes.push(`${unpaired} slots exist in only one of the runs and are not paired.`);
  }
  return {
    split: a.split,
    repeats:
      a.completedRepeats === b.completedRepeats
        ? String(b.completedRepeats)
        : `${a.completedRepeats} and ${b.completedRepeats}`,
    baselineGates,
    candidateGates,
    rows,
    changes,
    paired,
    unpaired,
    decision,
    decisionNote,
    notes,
  };
}

/**
 * Compares a baseline with a candidate. Returns `ok: false` with every difference and every
 * problem when the runs cannot be compared, and never throws for the content of a file.
 */
export function compareResults(
  baseline: ResultsFile,
  candidate: ResultsFile,
  options: {
    allow?: readonly PinName[];
    baselineName?: string;
    candidateName?: string;
    /** Pins that cannot be known yet, such as the model the provider will report. */
    skip?: readonly PinName[];
  } = {},
): Comparison {
  const differences = diffPins(baseline.pins, candidate.pins, {
    ...(options.allow === undefined ? {} : { allow: options.allow }),
    ...(options.skip === undefined ? {} : { skip: options.skip }),
  });
  const problems: string[] = [];
  if (!baseline.complete)
    problems.push("The baseline run is incomplete; a comparison needs finished runs.");
  if (!candidate.complete)
    problems.push("The candidate run is incomplete; a comparison needs finished runs.");
  if (differences.some((d) => d.status === "refused") || problems.length > 0) {
    return { ok: false, differences, problems };
  }

  const sections: SectionComparison[] = [];
  const notes: string[] = [];
  for (const b of candidate.sections) {
    const a = baseline.sections.find((s) => s.split === b.split);
    if (a === undefined) {
      notes.push(`The baseline has no ${b.split} section, so it is not compared.`);
      continue;
    }
    if (a.metrics === null || b.metrics === null) {
      notes.push(`The ${b.split} section has no scored repeat on one side, so it is not compared.`);
      continue;
    }
    sections.push(compareSections(baseline, candidate, a, b));
  }
  for (const a of baseline.sections) {
    if (!candidate.sections.some((s) => s.split === a.split)) {
      notes.push(`The candidate has no ${a.split} section, so it is not compared.`);
    }
  }
  if (baseline.pins.workflow.sha256 === candidate.pins.workflow.sha256) {
    notes.push(
      "The two runs use the same workflow, so this compares two runs of one version and not two versions.",
    );
  }
  if (
    baseline.pins.code.dirty === true &&
    candidate.pins.code.dirty === true &&
    baseline.pins.code.commit === candidate.pins.code.commit
  ) {
    notes.push(
      "Both runs were made from a working tree with uncommitted changes on the same commit. The commit does not pin the code, so the code may differ.",
    );
  }
  return {
    ok: true,
    differences,
    baselineName: options.baselineName ?? "baseline",
    candidateName: options.candidateName ?? "candidate",
    baselineMode: baseline.mode,
    candidateMode: candidate.mode,
    baselineHealth: runHealth(baseline),
    candidateHealth: runHealth(candidate),
    sections,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------------------------

export function renderDifferences(differences: readonly PinDifference[]): string[] {
  if (differences.length === 0) return ["The pins of the two runs are identical."];
  return [
    table(
      ["Pin", "Field", "Baseline", "Candidate", "Status"],
      differences.map((d) => [
        md(d.name),
        md(d.field),
        md(shortValue(d.baseline), 120),
        md(shortValue(d.candidate), 120),
        d.status === "declared"
          ? "declared variable"
          : d.status === "allowed"
            ? "allowed"
            : "REFUSED",
      ]),
    ),
  ];
}

/** A 64-digit hash is shortened for reading. The files hold the whole of it. */
const shortValue = (value: string): string =>
  /^[0-9a-f]{64}$/.test(value) ? shortSha(value) : value;

/** The refusal, for stderr, naming every difference and how to proceed. */
export function describeRefusal(comparison: Extract<Comparison, { ok: false }>): string {
  const refused = comparison.differences.filter((d) => d.status === "refused");
  const names = [...new Set(refused.map((d) => d.name))];
  const lines = [
    names.length > 0
      ? "Refusing to compare: the two runs differ in more than the workflow under test."
      : "Cannot compare the two runs.",
    "",
  ];
  lines.push(...renderDifferences(comparison.differences), "");
  for (const problem of comparison.problems) lines.push(problem);
  if (names.length > 0) {
    const evaluation = names.includes("evaluation");
    lines.push(
      evaluation
        ? "A difference in the evaluation version cannot be allowed: re-score the older run under the new version."
        : `If these differences are expected, name them: --allow-differences ${names.join(",")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const BANNERS = { selftest: SELFTEST_BANNER, simulated: SIMULATED_BANNER } as const;

export function renderComparison(
  comparison: Extract<Comparison, { ok: true }>,
  labels: {
    baseline: string;
    candidate: string;
  },
): string {
  const lines: string[] = [];
  const scripted = [comparison.baselineMode, comparison.candidateMode].filter(
    (mode): mode is "selftest" | "simulated" => mode === "selftest" || mode === "simulated",
  );
  const replayed = comparison.baselineMode === "replay" || comparison.candidateMode === "replay";
  lines.push(
    `# Comparison: baseline ${md(labels.baseline)} against candidate ${md(labels.candidate)}`,
    "",
  );
  if (scripted.length > 0) {
    lines.push(
      `**THIS COMPARISON INVOLVES A ${[...new Set(scripted)].map((m) => m.toUpperCase()).join(" AND A ")} RUN. THE NUMBERS BELOW ARE NOT SCORES OF ANY MODEL.**`,
      "",
      ...[...new Set(scripted)].flatMap((m) => [`**${BANNERS[m]}**`, ""]),
    );
  }
  if (replayed) {
    lines.push(
      `**${REPLAY_BANNER}** A comparison with a replay is a comparison of re-scored answers: it adds no repeat to the live run it came from.`,
      "",
    );
  }
  for (const [side, health] of [
    ["baseline", comparison.baselineHealth],
    ["candidate", comparison.candidateHealth],
  ] as const) {
    if (health.clean) continue;
    lines.push(
      `**${NOT_CLEAN}: the ${side} run.** ${health.problems.map((p) => md(p, 500)).join(" ")} A change between the two runs may be one of these failures and not a difference between the workflows.`,
      "",
    );
  }
  lines.push(
    `Baseline file: ${md(comparison.baselineName)} (${comparison.baselineMode}). Candidate file: ${md(comparison.candidateName)} (${comparison.candidateMode}).`,
    "",
    "## Differences between the runs",
    "",
    ...renderDifferences(comparison.differences),
    "",
  );
  for (const note of comparison.notes) lines.push(`Note: ${md(note, 600)}`, "");
  if (comparison.sections.length === 0) {
    lines.push("No split could be compared.", "");
  }
  for (const section of comparison.sections) {
    lines.push(
      `## Split ${md(section.split)}`,
      "",
      ...(scripted.length > 0
        ? [
            `**${scripted.includes("selftest") ? "SELFTEST" : "SIMULATED"} INVOLVED: NOT SCORES OF ANY MODEL.**`,
            "",
          ]
        : []),
      table(
        [
          `Metric (${md(section.split)}, k = ${section.repeats})`,
          `Baseline ${md(labels.baseline)}`,
          `Candidate ${md(labels.candidate)}`,
          "Change",
          "Gate",
          "Pass",
        ],
        section.rows.map((row) => [
          md(row.metric),
          md(row.baseline, 300),
          md(row.candidate, 300),
          md(row.change),
          md(row.gate),
          md(row.pass),
        ]),
      ),
      "",
      "Change is the candidate minus the baseline, in the unit of the metric. A cell without data is n/a. Latency and cost are never shown for a scripted run.",
      "",
      "### Slots that changed (paired)",
      "",
    );
    if (section.changes.length === 0) {
      lines.push(
        `No paired slot changed (${section.paired} paired${section.unpaired > 0 ? `, ${section.unpaired} not paired` : ""}).`,
        "",
      );
    } else {
      lines.push(
        `${section.changes.length} of ${section.paired} paired slots changed. Regressions first.`,
        "",
        table(
          ["Case", "Rule", "Severity", "Expected", "Baseline", "Candidate", "Change"],
          section.changes.map((c) => [
            md(c.caseKey),
            md(c.ruleKey),
            md(c.severity),
            md(c.expected),
            md(`${c.baseline.histogram} (${c.baseline.correct} of ${c.baseline.repeats} right)`),
            md(`${c.candidate.histogram} (${c.candidate.correct} of ${c.candidate.repeats} right)`),
            c.kind,
          ]),
        ),
        "",
      );
    }
    for (const note of section.notes) lines.push(`Note: ${md(note, 600)}`, "");
    lines.push("### Decision rule", "");
    if (section.decision === null) {
      lines.push(md(section.decisionNote ?? "The decision rule was not applied.", 600), "");
    } else {
      const d = section.decision;
      lines.push(
        `**${d.label}.** This is the result of the gates and not a recommendation. Promotion is decided in a promotion record signed off by the legal engineer (and, for a real pilot, the supervising attorney); nothing here ships a version.`,
        "",
        ...d.reasons.map((r) => `- ${md(r, 500)}`),
        ...d.conditions.map((r) => `- Condition: ${md(r, 500)}`),
        "",
        "Conditions of the rule that this comparison cannot check:",
        "",
        ...d.unchecked.map((r) => `- ${md(r, 500)}`),
        "",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
