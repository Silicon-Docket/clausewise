/**
 * The Markdown report of one Parol evaluation run. It is written from a results file alone, so a
 * report can be reprinted from a file later and says the same.
 *
 * It contains only values that were measured or counted. A cell with no data is "n/a". No rate is
 * printed for a denominator of zero. A selftest or a simulated run says so in capitals at the top
 * and again over every table of scores, and never presents what a scripted stand-in did as the
 * score of a model.
 */
import { GATES, GATE_IDS } from "./gates.js";
import {
  NA,
  countsText,
  dollars,
  intervalText,
  md,
  rateCell,
  ratio,
  seconds,
  shortSha,
  table,
  whole,
} from "./format.js";
import type { Rate } from "./stats.js";
import {
  CALL_OUTCOME_MEANINGS,
  HELDOUT_SEAL_WARNING,
  NOT_CLEAN,
  SUITE_SENTENCE_MAX,
  bannerOf,
  exposureMismatch,
  isScripted,
  runHealth,
  type ResultsFile,
  type RunHealth,
  type SplitSection,
} from "./results.js";
import {
  RATE_METRICS,
  summarizeRun,
  type RateMetricName,
  type RepeatMetrics,
  type RunMetrics,
} from "./score.js";

const MAX_LISTED = 40;

const RATE_ROWS: [label: string, metric: RateMetricName][] = [
  ["Status accuracy", "statusAccuracy"],
  ["Issue recall (strict)", "issueRecallStrict"],
  ["Issue precision (strict)", "issuePrecisionStrict"],
  ["Issue recall (lenient)", "issueRecallLenient"],
  ["Issue precision (lenient)", "issuePrecisionLenient"],
  ["Required escalation recall", "requiredEscalationRecall"],
  ["Unnecessary escalation rate", "unnecessaryEscalationRate"],
  ["Extraction span recall", "extractionRecall"],
  ["Extraction span precision", "extractionPrecision"],
  ["Not-found accuracy", "notFoundAccuracy"],
  ["Model citation validity", "modelCitationValidity"],
  ["Displayed citation validity", "displayedCitationValidity"],
  ["Substantive support (key)", "substantiveSupport"],
  ["Injection effect (slots that differ from the twin)", "injectionEffect"],
];

/** What the numbers of this run are the numbers of. */
function subjectOf(file: ResultsFile): string {
  if (file.mode === "selftest") return "the scripted oracle (a selftest, not a model)";
  if (file.mode === "simulated") return "the scripted simulated reader (not a model)";
  // Where the requests went is part of what the scores are of: the same model name answers
  // differently from a gateway or a stub than from the provider's own API.
  const endpoint = file.pins.model.endpoint ?? null;
  if (file.mode === "replay") {
    return `${md(file.pins.model.requested)} (${md(file.pins.model.provider)}${endpoint === null ? "" : `, at ${md(endpoint)}`}), as recorded in an earlier live run and re-scored`;
  }
  return `${md(file.pins.model.requested)} (${md(file.pins.model.provider)}${endpoint === null ? "" : `, at ${md(endpoint)}`})`;
}

function banner(file: ResultsFile): string[] {
  const text = bannerOf(file.mode);
  return text === null ? [] : [`**${text}**`, ""];
}

function cleanWarning(health: RunHealth): string[] {
  if (health.clean) return [];
  return [
    `**${NOT_CLEAN}.** ${health.problems.map((p) => md(p, 500)).join(" ")} The scores below are those of the run as it happened and are not a measure of the model alone. Fix the cause and run again before reading them as the model's.`,
    "",
  ];
}

/** The calls the stages made, by outcome, and the stages that fell back or skipped a rule. */
function healthLines(health: RunHealth, file: ResultsFile): string[] {
  const outcomes = Object.entries(health.calls);
  const lines: string[] = [
    "## Calls and degraded stages",
    "",
    `Calls recorded by the stages over ${health.runs} ${health.runs === 1 ? "run" : "runs"}${health.failedRuns > 0 ? ` (${health.failedRuns} did not finish, and their calls are not recorded)` : ""}, by outcome. A call that failed is counted here and is scored in the slot it was for: nothing is retried or left out.`,
    "",
  ];
  if (outcomes.length === 0) {
    lines.push("No call was recorded.", "");
  } else {
    lines.push(
      table(
        ["Outcome", "Calls", "Meaning"],
        outcomes.map(([outcome, n]) => [
          md(outcome),
          String(n),
          md(
            CALL_OUTCOME_MEANINGS[outcome] ??
              "an outcome this version of the report does not describe",
          ),
        ]),
      ),
      "",
    );
  }
  lines.push(
    `Extraction degraded in ${health.extractDegradedRuns} of ${health.runs} runs. Rules not sent because the context was over the workflow's budget: ${health.rulesOverBudget} (summed over runs).`,
    "",
  );
  // The calibration calls belong to no run and to no split, but a failed one makes every split
  // unclean, and the pointer of each split ends here.
  const calibrationCalls = file.suites.calibration?.callOutcomes;
  if (calibrationCalls !== undefined) {
    const listed = Object.entries(calibrationCalls);
    lines.push(
      `Calibration calls, which are in no run and in no split, by outcome: ${listed.length === 0 ? "none recorded" : listed.map(([outcome, n]) => `${md(outcome)} ${whole(n)}`).join(", ")}.`,
      "",
    );
  }
  if (health.clean) {
    lines.push(
      "No call failed on the wire, no extraction fell back to the whole document and no rule was left unsent.",
      "",
    );
  }
  return lines;
}

function metricsTable(repeats: RunMetrics): string {
  const summary = summarizeRun(repeats);
  const rows = RATE_ROWS.map(([label, metric]) => {
    const cell = rateCell(summary.rates[metric]);
    return [md(label), md(cell.result), md(cell.counts), md(cell.interval)];
  });
  return table(["Metric", "Result", "Counts per repeat", "95% Wilson interval per repeat"], rows);
}

function countRows(run: RunMetrics): string {
  const per = (pick: (m: RepeatMetrics) => string): string => run.repeats.map(pick).join("; ");
  const swf = summarizeRun(run).swf;
  const swfText =
    swf.mean === null
      ? NA
      : run.repeats.length === 1
        ? ratio(swf.mean)
        : `mean ${ratio(swf.mean)} (range ${ratio(swf.min)} to ${ratio(swf.max)})`;
  const rows: string[][] = [
    [
      "Silent misses",
      per((m) => String(m.silentMisses.total)),
      per(
        (m) =>
          `high ${m.silentMisses.bySeverity.high}, medium ${m.silentMisses.bySeverity.medium}, low ${m.silentMisses.bySeverity.low}`,
      ),
    ],
    [
      "Verified but unsupported findings",
      per((m) => String(m.support.verifiedButUnsupported.count)),
      "",
    ],
    [
      "Severity-weighted failure (SWF)",
      swfText,
      per((m) =>
        m.swf.value === null
          ? `${NA} (nothing to weigh)`
          : `${m.swf.weightedFailure} of ${m.swf.maximum}`,
      ),
    ],
    [
      "Stability (mean modal agreement)",
      run.stability === null
        ? NA
        : run.stability.repeats < 2
          ? `${NA} (needs 2 or more repeats)`
          : ratio(run.stability.meanAgreement),
      run.stability === null ? "" : `${run.stability.slots} slots, ${run.repeats.length} repeats`,
    ],
  ];
  return table(
    ["Count", "Result per repeat", "Detail"],
    rows.map((r) => r.map((c) => md(c))),
  );
}

/** One count over its denominator with the 95 percent interval, from a single pass. */
const singleRate = (rate: Rate): string =>
  `${countsText(rate)} (${rate.value === null ? NA : ratio(rate.value)}; 95% interval ${intervalText(rate.ci)})`;

/**
 * The exposure suites and the calibration set, whose counts are the evidence of gates G1 and G11.
 * Said plainly: the exposure suites test the application and not the model, and the calibration
 * set is a small set of labelled pairs, so its rates carry wide intervals.
 */
export function suiteLines(file: ResultsFile): string[] {
  const { exposure, calibration } = file.suites;
  const lines: string[] = ["## Supplementary suites", ""];
  if (exposure === null && calibration === null) {
    lines.push(
      "Neither the exposure suites nor the support checker's calibration set has a result in this file (they were not run, or the run stopped before the calibration set finished: see the notes), so gates G1 and G11 are not evaluated and not assumed to pass.",
      "",
    );
    return lines;
  }
  if (exposure === null) {
    lines.push("The exposure suites were not run, so gate G1 is not evaluated.", "");
  } else {
    const found =
      exposure.probesAnsweredWithData + exposure.canaryHits + exposure.foreignSpanIdHits;
    const mismatch = exposureMismatch(exposure, file.pins.workflow);
    lines.push(
      "**Exposure (gate G1).** These suites test the application's handling of matters: the authorization probes and the scans for canary strings and for ids of another matter. They do not test any model.",
      "",
      `The reviews they ran and scanned were of workflow ${md(exposure.workflow.label)}.` +
        (mismatch === null ? "" : ` Gate G1 is not evaluated for this run: ${md(mismatch, 600)}.`),
      "",
      table(
        ["Count", "Value"],
        [
          ["Authorization probes run", whole(exposure.probesRun)],
          [
            "Artefacts scanned (prompts, answers, response bodies, memos, tables of stored rows, log)",
            whole(exposure.artefactsScanned),
          ],
          [
            "Probes answered with data they should not return",
            whole(exposure.probesAnsweredWithData),
          ],
          ["Canary strings found", whole(exposure.canaryHits)],
          [
            "Ids of another matter found (matter, document, version, span)",
            whole(exposure.foreignSpanIdHits),
          ],
          ["Total found (G1 requires 0)", whole(found)],
          [
            "Probes whose caller should have been let in and was not (G1 is not evaluated while any)",
            whole(exposure.letInNotReached),
          ],
          [
            "Probes answered otherwise than expected, without exposing data (not a G1 count)",
            whole(exposure.mismatches),
          ],
          [
            "Sightings of the other matter's distinctive fact (not a G1 count)",
            whole(exposure.factSightings),
          ],
        ].map((row) => row.map((cell) => md(String(cell)))),
      ),
      "",
    );
    if (exposure.probesRun + exposure.artefactsScanned === 0) {
      lines.push(
        "**This record checked nothing** (no probe was run and no artefact was scanned), so gate G1 is not evaluated and the zeros above are not a clean result.",
        "",
      );
    }
    // The sentences carry what the counts do not: the mismatches, the drift of the action table and
    // the first probe that was exposed. They are cut at the limit of the results file and no earlier.
    for (const suite of exposure.suites) lines.push(`- ${md(suite, SUITE_SENTENCE_MAX)}`);
    if (exposure.suites.length > 0) lines.push("");
  }
  if (calibration === null) {
    lines.push(
      "The support checker's calibration set has no result in this file: it was not run, or the run stopped before it finished (see the notes). Gate G11 is not evaluated.",
      "",
    );
  } else {
    const { result } = calibration;
    const answered =
      file.mode === "replay"
        ? "answered from the recording of an earlier run (no model was called now)"
        : isScripted(file.mode)
          ? "answered by the scripted stand-in of this run"
          : "sent to the model of this run";
    const failedBy = Object.entries(calibration.callOutcomes)
      .filter(([outcome]) => outcome !== "ok")
      .map(([outcome, n]) => `${md(outcome)} ${whole(n)}`)
      .join(", ");
    lines.push(
      `**Support checker calibration (gate G11).** ${whole(calibration.unsupportedPairs)} unsupported and ${whole(calibration.supportedPairs)} supported pairs, ${answered}, with prompt ${md(calibration.prompt.id)} (${shortSha(calibration.prompt.sha256)}), set ${shortSha(calibration.setSha256)}. The set is small: read each rate with its interval. A pair whose call returned no verdict counts against the checker on both sides, as not caught if it is unsupported and as flagged if it is supported (${whole(calibration.failedPairs)} here${failedBy === "" ? "" : `: ${failedBy}`}).`,
      "",
      table(
        ["Measure", "Rate"],
        [
          ["Unsupported pairs caught", singleRate(result.catchRate)],
          ["Supported pairs flagged (false alarms)", singleRate(result.falseAlarmRate)],
          ...Object.entries(result.catchByKind).map(([kind, r]) => [
            `Caught, ${kind}`,
            singleRate(r),
          ]),
        ].map((row) => row.map((cell) => md(String(cell)))),
      ),
      "",
    );
    if (calibration.note !== null) lines.push(`Note: ${md(calibration.note, 600)}`, "");
  }
  return lines;
}

function gatesTable(section: SplitSection, file: ResultsFile): string[] {
  const lines: string[] = [];
  if (section.gates === null) {
    lines.push(
      section.metrics === null
        ? "Gates were not evaluated: no repeat finished."
        : "Gates were not evaluated: the run is incomplete, and a gate asks about every repeat.",
    );
    return lines;
  }
  const outcome = { pass: "pass", fail: "FAIL", not_evaluated: "not evaluated" } as const;
  const rows = GATE_IDS.map((id) => {
    const result = section.gates!.results.find((r) => r.id === id)!;
    const definition = GATES.find((g) => g.id === id)!;
    return [
      id,
      md(definition.title),
      md(definition.threshold),
      outcome[result.outcome],
      md(result.detail, 400),
    ];
  });
  if (isScripted(file.mode)) {
    lines.push(
      `Gate results of ${subjectOf(file)}. They test the plumbing and say nothing about any model.`,
      "",
    );
  }
  lines.push(table(["Gate", "Title", "Threshold", "Outcome", "Measured"], rows));
  const failed = section.gates.failed;
  const open = section.gates.notEvaluated;
  lines.push(
    "",
    `Gates failed: ${failed.length === 0 ? "none" : failed.join(", ")}. Gates not evaluated: ${open.length === 0 ? "none" : open.join(", ")}.`,
  );
  if (open.includes("G1")) {
    lines.push(
      file.suites.exposure === null
        ? "G1 needs the authorization probes and the canary scan, which were not run (give --exposure), so it is not evaluated and not assumed to be 0."
        : "G1 is not evaluated for the reason in its row above, and is not assumed to be 0.",
    );
  }
  if (open.some((id) => id === "G3" || id === "G4" || id === "G5")) {
    lines.push(
      "G3, G4 and G5 are counts that must be zero, out of the slots they could happen to (injection pairs, expected high-severity flags, determined findings). With none of those in the run they are not evaluated, and not assumed to pass.",
    );
  }
  if (open.includes("G11")) {
    lines.push(
      file.suites.calibration !== null
        ? "G11 is not evaluated for the reason in its row above, and is not assumed to pass."
        : isScripted(file.mode)
          ? "G11 cannot be evaluated in a scripted run: --calibration needs a live run or a replay, because a scripted stand-in is not the support checker."
          : file.mode === "replay"
            ? "G11 needs the support checker's calibration set, which has no result in this file (give --calibration, and a recording that was made with it: a replay re-scores only the answers the recording holds)."
            : "G11 needs the support checker's calibration set, which has no result in this file (give --calibration, with a workflow that has the support check; or the run stopped before the set finished: see the notes).",
    );
  }
  if (open.includes("G12") || open.includes("G13")) {
    lines.push(
      "G12 and G13 compare with a baseline or a budget. Run with --compare to evaluate them against an earlier run.",
    );
  }
  return lines;
}

function failureList(section: SplitSection): string[] {
  const repeats = section.metrics?.repeats ?? [];
  const bySlot = new Map<
    string,
    {
      caseKey: string;
      ruleKey: string;
      severity: string;
      expected: string;
      observed: string[];
      failures: string[];
      weighted: number;
    }
  >();
  for (const m of repeats) {
    for (const s of m.slotScores) {
      if (s.failure === null && s.statusCorrect) continue;
      const id = `${s.caseKey}\u0000${s.ruleKey}`;
      const entry = bySlot.get(id) ?? {
        caseKey: s.caseKey,
        ruleKey: s.ruleKey,
        severity: s.severity,
        expected: s.expected,
        observed: [],
        failures: [],
        weighted: 0,
      };
      entry.observed.push(s.observed);
      entry.failures.push(s.failure ?? "none");
      entry.weighted += s.weight * s.factor;
      bySlot.set(id, entry);
    }
  }
  const all = [...bySlot.values()].sort(
    (a, b) =>
      b.weighted - a.weighted ||
      a.caseKey.localeCompare(b.caseKey) ||
      a.ruleKey.localeCompare(b.ruleKey),
  );
  if (all.length === 0) {
    return [
      repeats.length === 0
        ? "No repeat finished, so no slot was scored."
        : "Every slot was correct, with no failure of any kind, in every repeat.",
    ];
  }
  const rows = all
    .slice(0, MAX_LISTED)
    .map((e) => [
      md(e.caseKey),
      md(e.ruleKey),
      md(e.severity),
      md(e.expected),
      md(e.observed.join(", ")),
      md(e.failures.join(", ")),
      String(e.weighted),
    ]);
  return [
    `Slots with a failure or a wrong status, largest weighted failure first (weight times factor, summed over repeats). ${all.length} in all${all.length > MAX_LISTED ? `, the first ${MAX_LISTED} shown` : ""}.`,
    "",
    table(
      [
        "Case",
        "Rule",
        "Severity",
        "Expected",
        "Observed per repeat",
        "Failure per repeat",
        "Weighted",
      ],
      rows,
    ),
  ];
}

function unstableList(section: SplitSection): string[] {
  const stability = section.metrics?.stability;
  if (stability === null || stability === undefined || stability.repeats < 2) return [];
  if (stability.belowUnanimous.length === 0) {
    return [`Every slot gave the same status in every one of the ${stability.repeats} repeats.`];
  }
  return [
    `Slots whose repeats did not all agree, least stable first (${stability.belowUnanimous.length} of ${stability.slots}).`,
    "",
    table(
      ["Case", "Rule", "Agreement", "Statuses"],
      stability.belowUnanimous
        .slice(0, MAX_LISTED)
        .map((s) => [md(s.caseKey), md(s.ruleKey), ratio(s.agreement), md(s.statuses.join(", "))]),
    ),
  ];
}

function renderSection(file: ResultsFile, section: SplitSection): string[] {
  const lines: string[] = [];
  const scripted = isScripted(file.mode);
  lines.push(
    `## Split ${section.split}${scripted ? ` (${file.mode.toUpperCase()})` : ""}`,
    "",
    ...banner(file),
    `Cases run: ${section.caseKeys.length} of ${section.casesInSplit}${section.fullSplit ? "" : " (a subset: the gates are defined for the whole split, so they are indicative only)"}, with ${section.twinKeys.length} injection ${section.twinKeys.length === 1 ? "twin" : "twins"}. Repeats scored: ${section.completedRepeats} of ${file.pins.repeats}. Split hash ${shortSha(section.splitSha256)}.`,
    "",
  );
  if (section.metrics === null) {
    lines.push("No repeat finished, so there is nothing to score.", "");
    return lines;
  }
  const run: RunMetrics = {
    repeats: section.metrics.repeats,
    stability: section.metrics.stability,
  };
  if (section.split !== "heldout" || file.pins.repeats < 3 || !section.fullSplit) {
    lines.push(
      "The gates of document 5 are written for the whole held-out split with 3 repeats. " +
        "This section is not that, so its gate results are indicative and are not a promotion result.",
      "",
    );
  }
  lines.push(
    ...(runHealth(file, section.split).clean
      ? []
      : [`**${NOT_CLEAN}** for this split: see "Calls and degraded stages" below.`, ""]),
    `### Result of ${subjectOf(file)}`,
    "",
    metricsTable(run),
    "",
    countRows(run),
    "",
    "### Gates",
    "",
    ...gatesTable(section, file),
    "",
    "### Slots",
    "",
    ...failureList(section),
    "",
    ...unstableList(section),
    ...(unstableList(section).length > 0 ? [""] : []),
    "### Latency and cost",
    "",
    ...timingLines(file, section),
    "",
  );
  return lines;
}

function timingLines(file: ResultsFile, section: SplitSection): string[] {
  if (isScripted(file.mode)) {
    return [
      "Not reported for a scripted run. Latency and cost of a scripted stand-in are not figures for any model.",
    ];
  }
  const lines: string[] = [];
  const latency = section.latency;
  if (latency === null) {
    lines.push(
      file.complete
        ? "Latency was not summarised: no run was timed."
        : "Latency was not summarised: the run is incomplete.",
    );
  } else {
    const stageRows = Object.entries(latency.stages).map(([stage, s]) => [
      md(stage),
      seconds(s.p50),
      seconds(s.p95),
      seconds(s.max),
    ]);
    lines.push(
      `Run latency over ${latency.completed} completed runs: p50 ${seconds(latency.total.p50)} s, p95 ${seconds(latency.total.p95)} s, max ${seconds(latency.total.max)} s. ${latency.failed.length} failed.`,
      "",
      table(["Stage", "p50 (s)", "p95 (s)", "max (s)"], stageRows),
    );
  }
  lines.push("");
  const cost = section.cost;
  if (!file.usage.available) {
    lines.push(
      `Cost: not available. ${md(file.usage.note ?? "The provider does not report token usage.", 400)}`,
    );
  } else if (cost === null) {
    lines.push(
      file.complete
        ? "Cost was not summarised: no run has a cost, or no price was applied."
        : "Cost was not summarised: the run is incomplete.",
    );
  } else {
    lines.push(
      `Cost over ${cost.runs} runs started: total ${dollars(cost.totalUsd)}, mean ${dollars(cost.meanUsd)}, max ${dollars(cost.maxUsd)}. Prompt tokens read from the cache: ${cost.cacheReadShare === null ? NA : `${(cost.cacheReadShare * 100).toFixed(1)} percent`} of ${whole(cost.promptTokens)}. The prices are those of the table recorded under Pins, which has not been checked against a live price list.`,
    );
  }
  return lines;
}

function pinsTable(file: ResultsFile): string {
  const p = file.pins;
  const rows: [string, string][] = [
    ["Mode", file.mode],
    [
      "Dataset",
      `${p.dataset.label}; keys ${shortSha(p.dataset.answerKeysSha256)}; splits file ${shortSha(p.dataset.splitsFileSha256)}`,
    ],
    [
      "Split hashes",
      Object.entries(p.dataset.splits)
        .map(([split, sha]) => `${split} ${shortSha(sha)}`)
        .join("; "),
    ],
    ["Split run", p.split],
    ["Cases", `${p.cases.length}: ${p.cases.join(", ")}`],
    ["Playbook", `${p.playbook.slug} ${p.playbook.version}, sha256 ${shortSha(p.playbook.sha256)}`],
    [
      "Workflow",
      `${p.workflow.label}, sha256 ${shortSha(p.workflow.sha256)}; retrieval ${p.workflow.retrieval}; checks ${p.workflow.checks.join(", ") || "none"}; context budget ${p.workflow.budgetTokens}; repair attempts ${p.workflow.repairAttempts}`,
    ],
    [
      "Prompts",
      `extract ${p.workflow.prompts.extract.id} ${shortSha(p.workflow.prompts.extract.sha256)}; analyze ${p.workflow.prompts.analyze.id} ${shortSha(p.workflow.prompts.analyze.sha256)}; support ${p.workflow.prompts.support === null ? "none" : `${p.workflow.prompts.support.id} ${shortSha(p.workflow.prompts.support.sha256)}`}`,
    ],
    [
      "Model",
      `${p.model.provider}, requested ${p.model.requested}; endpoint ${p.model.endpoint ?? "none (a scripted run reaches no endpoint)"}; reported by the provider: ${p.model.reported === null ? "not reported" : p.model.reported.join(", ")}. ${p.model.reportedNote}`,
    ],
    [
      "Generation settings",
      p.generation === null
        ? "none (a scripted run sends no request)"
        : `max output tokens ${p.generation.maxOutputTokens}; effort ${p.generation.effort ?? "model default"}; client retries ${p.generation.maxRetries}; rules at once ${p.generation.ruleConcurrency}; temperature ${p.generation.temperature === null ? "none sent" : p.generation.temperature}; fallback ${p.generation.fallback ?? "off"}`,
    ],
    [
      "Price table",
      p.prices === null
        ? "none used"
        : `sha256 ${shortSha(p.prices.sha256)}; ${p.prices.model.input} input, ${p.prices.model.output} output, ${p.prices.model.cacheRead} cache read, ${p.prices.model.cacheWrite} cache write, USD per million tokens`,
    ],
    ["Evaluation version", `${p.evaluation.label}, sha256 ${shortSha(p.evaluation.sha256)}`],
    [
      "Code",
      p.code.commit === null
        ? "not a git repository"
        : `commit ${p.code.commit.slice(0, 12)}${p.code.dirty === true ? ", with uncommitted changes, so the commit does not pin the code" : ""}`,
    ],
    ["Repeats (k)", String(p.repeats)],
    ["Started", file.startedAt],
    ["Finished", file.finishedAt],
  ];
  return table(
    ["Pin", "Value"],
    rows.map(([name, value]) => [md(name), md(value, 600)]),
  );
}

/** Where the answers came from: the recording a live run wrote, or the one a replay read. */
function recordingLines(file: ResultsFile): string[] {
  const r = file.recording;
  if (r === null) return [];
  if (r.role === "recorded") {
    return [
      r.failed === true
        ? `**Recording.** The model's answers could not be recorded completely (${whole(r.calls)} calls written to ${md(r.file)}), so this run cannot be replayed.`
        : `**Recording.** The model's answers were written to ${md(r.file)} (${whole(r.calls)} calls), beside the results file. Replay them with --replay.`,
    ];
  }
  return [
    `**Recording.** The answers were read from ${md(r.file)} (${whole(r.calls)} answered)${r.recordedAt === undefined ? "" : `, recorded at ${md(r.recordedAt)}`}${r.recordedResults === undefined ? "" : ` by the run that wrote ${md(r.recordedResults)}`}${r.recordedCommit === undefined || r.recordedCommit === null ? "" : ` at commit ${md(r.recordedCommit.slice(0, 12))}`}.${r.datasetChanged === true ? " **THE ANSWER KEYS OR CASE FILES DIFFER FROM THOSE THE RECORDING WAS MADE AGAINST**, so these are recorded answers scored against a changed key." : ""}`,
  ];
}

export function renderReport(file: ResultsFile): string {
  const scripted = isScripted(file.mode);
  const lines: string[] = [
    scripted
      ? `# Parol evaluation, ${file.mode === "selftest" ? "SELFTEST" : "SIMULATED"}`
      : file.mode === "replay"
        ? "# Parol evaluation, REPLAY"
        : "# Parol evaluation",
    "",
    ...banner(file),
  ];
  if (!file.complete) {
    lines.push(
      `**INCOMPLETE: the run stopped early.** ${md(file.stoppedBecause ?? "No reason was recorded.", 500)} Only repeats in which every case finished are scored, and gates are not evaluated.`,
      "",
    );
  }
  lines.push(...cleanWarning(runHealth(file)));
  lines.push(
    `Scores of: ${subjectOf(file)}. Dataset ${md(file.pins.dataset.label)}; workflow ${md(file.pins.workflow.label)}; ${file.pins.repeats} ${file.pins.repeats === 1 ? "repeat" : "repeats"}. The synthetic answer keys show consistency with the fictional demo playbook and not professional legal quality (document 5).`,
    "",
  );
  if (file.sections.some((s) => s.split === "heldout")) {
    lines.push(`**Held-out set.** ${HELDOUT_SEAL_WARNING}`, "");
  }
  if (file.contamination !== null) {
    lines.push(`**Contamination note.** ${md(file.contamination.note, 800)}`, "");
  }
  for (const note of file.notes) lines.push(`Note: ${md(note, 600)}`, "");
  if (file.recording !== null) lines.push(...recordingLines(file), "");
  for (const section of file.sections) lines.push(...renderSection(file, section));

  lines.push(...suiteLines(file));
  lines.push(...healthLines(runHealth(file), file));
  lines.push("## Usage", "");
  if (scripted) {
    lines.push(
      `Model calls made to the scripted ${file.mode === "selftest" ? "oracle" : "reader"}: ${whole(file.usage.calls)}. No tokens, no cost: nothing was sent anywhere.`,
    );
  } else if (file.mode === "replay") {
    lines.push(
      `Answers re-scored from the recording: ${whole(file.usage.calls)}. No model was called and nothing was sent anywhere: there are no tokens, no cost and no latency.`,
    );
  } else if (!file.usage.available) {
    lines.push(
      `Model calls made: ${whole(file.usage.calls)}. ${md(file.usage.note ?? "Token usage is unavailable.", 400)}`,
    );
  } else if (file.usage.total !== null) {
    const u = file.usage.total;
    lines.push(
      `Model calls made: ${whole(file.usage.calls)}. Tokens reported by the provider: ${whole(u.inputTokens)} input, ${whole(u.outputTokens)} output, ${whole(u.cacheReadTokens)} cache read, ${whole(u.cacheWriteTokens)} cache write. Cost from the price table: ${dollars(file.usage.costUsd)}.`,
    );
  }
  lines.push(
    "",
    "## Integrity and pins",
    "",
    `Dataset integrity: the answer keys and files of ${file.integrity.splits.length === 1 ? "the split" : "each split"} matched the hashes recorded in fixtures/parol/splits.json before the run.`,
    "",
    pinsTable(file),
    "",
  );
  return `${lines.join("\n")}\n`;
}
