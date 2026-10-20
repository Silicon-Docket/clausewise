import type { Comparison, RuleChange } from "./compare.js";
import { EXPECTED_STATUSES } from "./fixtures.js";
import { PRICE_WARNING, costOf } from "./prices.js";
import type { EvalResult } from "./result.js";
import { GOT_STATUSES, type RuleScore } from "./score.js";

// Fixture names, model ids and rule ids come from files and the environment, so none of them is
// allowed to break out of a table cell.
const cell = (value: string): string =>
  value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\|`]/g, "\\$&")
    .trim();

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);
const int = (value: number): string => value.toLocaleString("en-US");
const pct = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const usd = (value: number | null): string => (value === null ? "n/a" : `$${value.toFixed(4)}`);

function points(value: number | null): string {
  if (value === null) return "n/a";
  const scaled = value * 100;
  return `${scaled >= 0 ? "+" : ""}${scaled.toFixed(1)} points`;
}

function table(header: string[], rows: string[][]): string[] {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

// Tables of words read better left aligned.
function wordTable(header: string[], rows: string[][]): string[] {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

function gotText(rule: RuleScore): string {
  if (rule.got.length === 1) return rule.got[0] ?? "";
  const counts = GOT_STATUSES.map(
    (status) => [status, rule.got.filter((got) => got === status).length] as const,
  )
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  return counts.map(([status, count]) => `${status} (${count})`).join(", ");
}

function matchText(rule: RuleScore): string {
  if (rule.got.length === 1) return rule.matches === 1 ? "yes" : "NO";
  return `${rule.matches}/${rule.got.length}`;
}

function changeRows(changes: RuleChange[]): string[][] {
  return changes.map((change) => [
    cell(change.fixture),
    cell(change.ruleId),
    cell(change.expected),
    `${cell(change.before.status)} (${pct(change.before.accuracy)})`,
    `${cell(change.after.status)} (${pct(change.after.accuracy)})`,
  ]);
}

function banner(result: EvalResult): string[] {
  const lines: string[] = [];
  const failures = result.score.integrityFailures;
  if (failures.length > 0) {
    const count = `${failures.length} OF ${result.runs.length} REDLINED ${result.runs.length === 1 ? "FILE" : "FILES"}`;
    lines.push(
      `**INTEGRITY FAILURE: ${count} CAN NOT BE TRUSTED. DO NOT USE THE TOOL ON REAL CONTRACTS UNTIL THIS IS FIXED.**`,
      "",
      "A redlined file must reject back to the original text, and its tracked changes must be the ones the report lists. These did not:",
      "",
    );
    for (const failure of failures) {
      lines.push(`- ${cell(failure.fixture)}, run ${failure.run}:`);
      for (const problem of failure.problems) lines.push(`  - ${problem}`);
    }
    lines.push("");
  }
  if (result.selftest) {
    lines.push(
      "**SELFTEST: no model was called.** The answers come from a scripted oracle built from expected.json, so this run only checks the harness. A score here says nothing about any model.",
      "",
    );
  }
  if (result.score.total > 0 && result.score.errored === result.score.total) {
    lines.push(
      "**EVERY RULE ERRORED.** Nothing was checked, so none of the figures below mean anything. See the reasons under Rules that errored: the usual causes are the network, the key and the model name.",
      "",
    );
  }
  if (!result.complete) {
    lines.push(
      `**INCOMPLETE: the run stopped early.** ${result.stoppedBecause ?? ""} The figures below cover only the reviews that finished.`,
      "",
    );
  }
  return lines;
}

function headline(result: EvalResult): string[] {
  const { score, cost } = result;
  const flag = score.flag;
  const flagged = flag.truePositives + flag.falseAlarms;
  const wanted = flag.truePositives + flag.misses;
  const redlined = result.runs.length;
  const edits = score.edits;
  const spent =
    cost.actualUsd === null
      ? result.selftest
        ? "none (no model was called)"
        : "unavailable"
      : `${usd(cost.actualUsd)}${cost.upperBoundUsd === null ? "" : ` (upper bound ${usd(cost.upperBoundUsd)})`}`;
  return [
    "## Headline",
    "",
    ...wordTable(
      ["Measure", "Result"],
      [
        ["Exact status accuracy", `${score.correct}/${score.total} (${pct(score.accuracy)})`],
        ["Flag precision", `${flag.truePositives}/${flagged} (${pct(flag.precision)})`],
        ["Flag recall", `${flag.truePositives}/${wanted} (${pct(flag.recall)})`],
        ["Flag F1", pct(flag.f1)],
        ["False alarms", String(flag.falseAlarms)],
        ["Misses", String(flag.misses)],
        ["Rules that errored", String(score.errored)],
        [
          "Deviations with a tracked change",
          `${edits.applied}/${edits.deviations} (${pct(edits.deviations === 0 ? null : edits.applied / edits.deviations)})`,
        ],
        [
          "Integrity",
          score.integrityFailures.length === 0
            ? `pass (${redlined} redlined ${plural(redlined, "file", "files")} checked)`
            : `**FAIL** (${score.integrityFailures.length} of ${redlined})`,
        ],
        ["Cost", spent],
      ],
    ),
    "",
    "Flagged means deviation or missing. A rule that errored counts as not flagged, so an error where a flag was expected is a miss, and every error counts against accuracy.",
    "",
  ];
}

function comparisonSection(comparison: Comparison, result: EvalResult): string[] {
  const { previous } = comparison;
  const lines = [
    `## Changes since the earlier run`,
    "",
    `Earlier run: ${cell(previous.startedAt)}, ${cell(previous.model)} (${cell(previous.provider)})${previous.selftest ? ", a selftest" : ""}.`,
    "",
    ...wordTable(
      ["Measure", "Earlier", "Now", "Change"],
      [
        [
          "Exact status accuracy",
          pct(comparison.before.accuracy),
          pct(result.score.accuracy),
          points(comparison.accuracyDelta),
        ],
        [
          "Flag F1",
          pct(comparison.before.f1),
          pct(result.score.flag.f1),
          points(comparison.f1Delta),
        ],
      ],
    ),
    "",
  ];
  if (previous.selftest !== result.selftest) {
    lines.push("One of the two runs is a selftest, so the comparison is not meaningful.", "");
  }
  const header = ["Fixture", "Rule", "Expected", "Before", "After"];
  const block = (title: string, changes: RuleChange[]): void => {
    if (changes.length === 0) return;
    lines.push(
      `### ${title} (${changes.length})`,
      "",
      ...wordTable(header, changeRows(changes)),
      "",
    );
  };
  if (comparison.relabelled.length > 0) {
    lines.push(
      `The expected status of ${comparison.relabelled.length} ${plural(comparison.relabelled.length, "rule", "rules")} differs from the earlier run, so their accuracy is not compared.`,
      "",
    );
  }
  if (comparison.onlyNow + comparison.onlyBefore + comparison.relabelled.length > 0) {
    lines.push(
      "The two runs did not score the same rules, so the change in accuracy and F1 above compares different things.",
      "",
    );
  }
  block("Regressions", comparison.regressions);
  block("Improvements", comparison.improvements);
  block("Different answer, same accuracy", comparison.changed);
  block("Expected status changed since the earlier run", comparison.relabelled);
  if (
    comparison.regressions.length +
      comparison.improvements.length +
      comparison.changed.length +
      comparison.relabelled.length ===
    0
  ) {
    lines.push("No rule changed.", "");
  }
  lines.push(
    `Unchanged: ${comparison.unchanged}. Only in this run: ${comparison.onlyNow}. Only in the earlier run: ${comparison.onlyBefore}.`,
    "",
  );
  return lines;
}

function fixtureSections(result: EvalResult): string[] {
  const lines = ["## Fixtures", ""];
  const names = [...new Set(result.score.rules.map((rule) => rule.fixture))];
  for (const name of names) {
    const rules = result.score.rules.filter((rule) => rule.fixture === name);
    const runs = rules[0]?.got.length ?? 0;
    const correct = rules.reduce((sum, rule) => sum + rule.matches, 0);
    const total = rules.reduce((sum, rule) => sum + rule.got.length, 0);
    lines.push(
      `### ${cell(name)}`,
      "",
      `${correct}/${total} correct over ${runs} ${plural(runs, "review", "reviews")}.`,
      "",
      ...wordTable(
        ["Rule", "Expected", "Got", "Match"],
        rules.map((rule) => [cell(rule.ruleId), rule.expected, gotText(rule), matchText(rule)]),
      ),
      "",
    );
  }
  return lines;
}

function confusionSection(result: EvalResult): string[] {
  const { confusion, flag } = result.score;
  return [
    "## Confusion matrix",
    "",
    "Rows are the expected status and columns are what the model gave, over every rule of every review.",
    "",
    ...table(
      ["Expected \\ got", ...GOT_STATUSES],
      EXPECTED_STATUSES.map((expected) => [
        expected,
        ...GOT_STATUSES.map((got) => String(confusion[expected][got])),
      ]),
    ),
    "",
    `Flagging: ${flag.truePositives} correct flags, ${flag.falseAlarms} false ${plural(flag.falseAlarms, "alarm", "alarms")} (flagged where compliant or not applicable was expected), ${flag.misses} ${plural(flag.misses, "miss", "misses")} (not flagged where a deviation or a missing clause was expected) and ${flag.trueNegatives} correct non-flags.${flag.unchecked === 0 ? "" : ` ${flag.unchecked} more ${plural(flag.unchecked, "rule was", "rules were")} not flagged because the rule errored and was not checked.`}`,
    "",
  ];
}

function editSection(result: EvalResult): string[] {
  const edits = result.score.edits;
  const lines = [
    "## Edits",
    "",
    `${edits.deviations} ${plural(edits.deviations, "deviation was", "deviations were")} reported. The model proposed an edit for ${edits.proposed} (${pct(edits.deviations === 0 ? null : edits.proposed / edits.deviations)}). ${edits.applied} became a tracked change and ${edits.commentOnly} fell back to a comment only.`,
    "",
  ];
  if (edits.fallbackReasons.length > 0) {
    lines.push(
      ...table(
        ["Why an edit became a comment", "Count"],
        edits.fallbackReasons.map((item) => [cell(item.reason), String(item.count)]),
      ),
      "",
    );
  }
  return lines;
}

function errorSection(result: EvalResult): string[] {
  const { errorReasons } = result.score;
  if (errorReasons.length === 0) return [];
  return [
    "## Rules that errored",
    "",
    ...table(
      ["Why the rule was not checked", "Count"],
      errorReasons.map((item) => [cell(item.reason), String(item.count)]),
    ),
    "",
  ];
}

function integritySection(result: EvalResult): string[] {
  const lines = ["## Integrity", ""];
  if (result.runs.length === 0)
    return [...lines, "No review finished, so nothing was checked.", ""];
  lines.push(
    "Each redlined file was read back with an independent check: rejecting every tracked change must give the original paragraph text, and the tracked changes must be the ones the report lists.",
    "",
    ...wordTable(
      ["Fixture", "Run", "Tracked changes", "Report says", "Result"],
      result.runs.map((record) => [
        cell(record.fixture),
        String(record.run),
        String(record.integrity.trackedChanges),
        String(record.integrity.reportedChanges),
        record.integrity.ok ? "pass" : "**FAIL**",
      ]),
    ),
    "",
  );
  return lines;
}

function stabilitySection(result: EvalResult): string[] {
  const { stability } = result.score;
  if (stability === null) return [];
  const lines = [
    "## Stability",
    "",
    `Agreement is the share of reviews that gave a rule its most common status. Mean agreement over ${stability.runs} reviews per fixture: ${pct(stability.meanAgreement)}.`,
    "",
  ];
  if (stability.unstable.length === 0) {
    lines.push("Every rule gave the same status in every review.", "");
    return lines;
  }
  lines.push(
    `${stability.unstable.length} unstable ${plural(stability.unstable.length, "rule", "rules")}:`,
    "",
    ...wordTable(
      ["Fixture", "Rule", "Expected", "Statuses given", "Agreement"],
      stability.unstable.map((rule) => [
        cell(rule.fixture),
        cell(rule.ruleId),
        rule.expected,
        gotText(rule),
        pct(rule.agreement),
      ]),
    ),
    "",
  );
  return lines;
}

function usageSection(result: EvalResult): string[] {
  const { usage, cost, plan } = result;
  const { price } = cost;
  const lines = ["## Usage and cost", ""];
  if (result.selftest) {
    return [
      ...lines,
      `No model was called. The plan counted ${plan.calls} calls and the selftest made ${usage.totalCalls}.`,
      "",
    ];
  }
  const bound =
    cost.upperBoundUsd === null
      ? ""
      : ` The plan's upper bound was ${usd(cost.upperBoundUsd)}, from ${int(plan.inputTokens)} input and ${int(plan.outputTokens)} output tokens.`;
  if (!usage.available || usage.total === null || price === null) {
    return [
      ...lines,
      `${usage.note ?? "Token usage is not available."} Model calls made: ${usage.totalCalls}.${bound}`,
      "",
      PRICE_WARNING,
      "",
    ];
  }

  const rows = usage.byFixture.map((item) => {
    const own = item.usage;
    return [
      cell(item.fixture),
      String(item.runs),
      String(item.calls),
      int(own?.inputTokens ?? 0),
      int(own?.outputTokens ?? 0),
      int(own?.cacheReadTokens ?? 0),
      int(own?.cacheWriteTokens ?? 0),
      usd(own === null ? null : costOf(own, price)),
    ];
  });
  rows.push([
    "**Total**",
    String(result.runs.length),
    String(usage.totalCalls),
    int(usage.total.inputTokens),
    int(usage.total.outputTokens),
    int(usage.total.cacheReadTokens),
    int(usage.total.cacheWriteTokens),
    usd(cost.actualUsd),
  ]);
  lines.push(
    ...table(
      ["Fixture", "Reviews", "Calls", "Input", "Output", "Cache read", "Cache write", "Cost"],
      rows,
    ),
    "",
    `Input is the uncached part of each prompt. Cost uses ${price.input} / ${price.output} USD per million input / output tokens, with cache reads at ${price.cacheRead} and cache writes at ${price.cacheWrite}.${bound}`,
    "",
  );
  if (usage.total.responses !== usage.totalCalls) {
    lines.push(
      `Usage was reported for ${usage.total.responses} API responses to ${usage.totalCalls} calls. A call that is retried reports once per response, and a call that fails before any response reports nothing.`,
      "",
    );
  }
  const cache = usage.cache;
  if (cache !== null) {
    lines.push(
      `Cache effectiveness: ${pct(cache.readShare)} of ${int(cache.promptTokens)} prompt tokens were read from the cache. Without caching the same tokens would have cost ${usd(cache.costWithoutCaching)}, so the cache ${cache.saving === null ? "made no difference" : cache.saving >= 0 ? `saved ${pct(cache.saving)}` : `cost ${pct(-cache.saving)} more`}.`,
      "",
    );
  }
  lines.push(PRICE_WARNING, "");
  return lines;
}

export function renderReport(result: EvalResult, comparison: Comparison | undefined): string {
  const models = `${cell(result.model.model)} (${cell(result.model.provider)})`;
  const lines = [
    ...banner(result),
    "# Clausewise evaluation",
    "",
    `Model: ${models}. Fixtures: ${result.options.fixtures.map(cell).join(", ")}. Reviews per fixture: ${result.options.runs}. Started: ${result.startedAt}.`,
    "",
    ...headline(result),
    ...(comparison === undefined ? [] : comparisonSection(comparison, result)),
    ...fixtureSections(result),
    ...confusionSection(result),
    ...editSection(result),
    ...errorSection(result),
    ...integritySection(result),
    ...stabilitySection(result),
    ...usageSection(result),
  ];
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
