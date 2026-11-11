import type { Child } from "hono/jsx";
import type { ComparisonView, EvaluationListView } from "../../services/views.js";
import { urls } from "../urls.js";
import { plural, shortHash } from "../views/format.js";
import type { Offsets } from "../views/highlight.js";
import { checkLabel } from "../views/labels.js";
import {
  Chip,
  Crumbs,
  EscalationChip,
  HighlightedText,
  QuoteCheckChip,
  RevealedText,
  RoleChip,
  ScrollBox,
  Section,
  SeverityChip,
  StatusChip,
  Time,
  textareaValue,
  type ShapeName,
  type Tone,
} from "./components.js";
import { Layout, type Chrome } from "./layout.js";

/**
 * The evaluation comparison page (package W2.5): the list of comparisons published to this
 * application, and one comparison with its gates, its changed slots and the evidence trail of a
 * slot. For the legal engineer and the administrator. It reads a view and nothing else: the fixed
 * words (the banners of a scripted run, the labels of the decision rule) arrive in `view.labels`,
 * because a page may not import the module that holds them.
 *
 * Nothing on these pages changes state: there is no form and no button, and no link leads to
 * promotion. The only output is a draft of a promotion record, as text in a read-only box. A
 * result that is scripted, simulated or replayed is labelled in capitals wherever it appears.
 * Every table has a caption and scoped headers, every outcome is a word with a shape, and every
 * word from a file passes through `RevealedText`, so an invisible character in it is shown.
 */

type Labels = ComparisonView["labels"];
type SectionView = ComparisonView["section"];
type GateView = NonNullable<SectionView["gates"]["candidate"]>[number];
type ChangeView = SectionView["changes"][number];
type SideCount = ChangeView["baseline"];
type SideFacts = ComparisonView["page"]["sides"]["baseline"];
type RunMode = SideFacts["mode"];
type Selected = Exclude<ComparisonView["selected"], null | { missing: true }>;
type SideTrail = Exclude<ChangeView["trail"], { sealed: true }>["baseline"];
type TrailRepeat = SideTrail["repeats"][number];
type Passage = Selected["passages"] extends ReadonlyMap<string, infer P> ? P : never;

const splitLabel = (split: string): string => (split === "heldout" ? "Held-out" : "Dev");

/** A run's mode as a chip: scripted and replayed runs are in capitals and in the colour of a note. */
function ModeChip({ mode, labels }: { mode: RunMode; labels: Labels }) {
  const scripted = mode !== "live";
  return (
    <Chip tone={scripted ? "info" : "neutral"} shape={scripted ? "square" : "circle"}>
      {labels.mode[mode]}
    </Chip>
  );
}

const GATE_LOOK: Record<GateView["outcome"], { tone: Tone; shape: ShapeName }> = {
  pass: { tone: "ok", shape: "circle" },
  fail: { tone: "bad", shape: "triangle" },
  not_evaluated: { tone: "neutral", shape: "ring" },
};

function OutcomeChip({ outcome, labels }: { outcome: GateView["outcome"]; labels: Labels }) {
  const look = GATE_LOOK[outcome];
  return (
    <Chip tone={look.tone} shape={look.shape}>
      {labels.gateOutcome[outcome]}
    </Chip>
  );
}

const CHANGE_LOOK: Record<ChangeView["kind"], { tone: Tone; shape: ShapeName }> = {
  regression: { tone: "bad", shape: "triangle" },
  improvement: { tone: "ok", shape: "circle" },
  changed: { tone: "warn", shape: "diamond" },
};

function ChangeChip({ kind, labels }: { kind: ChangeView["kind"]; labels: Labels }) {
  const look = CHANGE_LOOK[kind];
  return (
    <Chip tone={look.tone} shape={look.shape}>
      {labels.changeKind[kind]}
    </Chip>
  );
}

/** Capital banners of a scripted or replayed run, one for each distinct mode. */
function ModeBanners({
  warnings,
  labels,
}: {
  warnings: ComparisonView["warnings"];
  labels: Labels;
}) {
  return (
    <>
      {warnings.map((warning) => (
        <section
          class="banner banner-standin"
          aria-labelledby={`eval-banner-${warning.mode}-heading`}
        >
          <h2 id={`eval-banner-${warning.mode}-heading`}>{labels.mode[warning.mode]}</h2>
          <p>{warning.text}</p>
        </section>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------

const LIST_WARNING =
  "Some comparisons below involve a SELFTEST, a SIMULATED run or a REPLAY. See each comparison.";

const GATE_COUNTS_NONE = "No gate report";

function gateCountsText(
  counts: { pass: number; fail: number; notEvaluated: number } | null,
): string {
  if (counts === null) return GATE_COUNTS_NONE;
  const total = counts.pass + counts.fail + counts.notEvaluated;
  return `${counts.pass} pass, ${counts.fail} fail, ${counts.notEvaluated} not evaluated of ${total}`;
}

function EmptyList() {
  return (
    <div class="stack">
      <p class="empty">No comparison has been published to this application.</p>
      <p>
        A comparison is published by the evaluation command, which writes one file for it into the
        data folder of this application. That folder is the one <code>PAROL_DATA_DIR</code> names.
        For example, compare the two scripted versions and publish the result:
      </p>
      <pre class="eval-commands">
        <code>
          {`pnpm eval:parol --simulate --workflow v1 --out evals/results/sim-v1.json
pnpm eval:parol --simulate --workflow v2 --compare evals/results/sim-v1.json --out evals/results/sim-v2.json --publish ./data/parol`}
        </code>
      </pre>
      <p class="hint">
        A comparison made this way is of a scripted reader and says so. It is not a measurement of
        any model.
      </p>
    </div>
  );
}

export function EvaluationsPage({ chrome, list }: { chrome: Chrome; list: EvaluationListView }) {
  const { labels } = list;
  const scripted = list.entries.some((entry) => entry.ok && entry.warnings.length > 0);
  return (
    <Layout title="Evaluations" chrome={chrome} wide>
      <h1>Evaluations</h1>
      {scripted ? (
        <section class="banner banner-standin" aria-labelledby="eval-list-banner-heading">
          <h2 id="eval-list-banner-heading">Scripted or replayed runs</h2>
          <p>{LIST_WARNING}</p>
        </section>
      ) : null}
      <Section
        id="comparisons"
        title="Published comparisons"
        note="Each comparison sets two workflow versions side by side: every release gate, the slots whose answer changed, and where each version looked. This page changes nothing."
      >
        {list.entries.length === 0 ? (
          <EmptyList />
        ) : (
          <>
            <ScrollBox label="Table of published comparisons">
              <table class="data-table">
                <caption class="sr-only">Published comparisons, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Comparison</th>
                    <th scope="col">Baseline</th>
                    <th scope="col">Candidate</th>
                    <th scope="col">Splits</th>
                    <th scope="col">Candidate gates</th>
                    <th scope="col">Published</th>
                  </tr>
                </thead>
                <tbody>
                  {list.entries.map((entry) =>
                    entry.ok ? (
                      <tr>
                        <th scope="row">
                          <a href={urls.evaluations({ comparison: entry.id })}>
                            <code>{entry.id.slice(0, 12)}</code>
                          </a>
                        </th>
                        <td>
                          <RevealedText value={entry.baseline.workflowLabel} />{" "}
                          <ModeChip mode={entry.baseline.mode} labels={labels} />
                        </td>
                        <td>
                          <RevealedText value={entry.candidate.workflowLabel} />{" "}
                          <ModeChip mode={entry.candidate.mode} labels={labels} />
                        </td>
                        <td>{entry.sections.map((s) => splitLabel(s.split)).join(", ")}</td>
                        <td>
                          {entry.sections.map((s) => (
                            <p class="eval-cell-sub">
                              {splitLabel(s.split)}: {gateCountsText(s.candidateGates)}
                            </p>
                          ))}
                        </td>
                        <td>
                          <Time value={entry.publishedAt} />
                        </td>
                      </tr>
                    ) : (
                      <tr>
                        <th scope="row">
                          <code>{entry.name}</code>
                        </th>
                        <td colspan={5}>
                          <Chip tone="bad" shape="triangle">
                            {labels.problem[entry.problem]}
                          </Chip>{" "}
                          {entry.action}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </ScrollBox>
            {list.truncated ? (
              <p class="hint">
                More files are in the folder than are listed here. Only the newest are shown.
              </p>
            ) : null}
          </>
        )}
      </Section>
      <p class="section-note">{FOOTER_NOTE}</p>
    </Layout>
  );
}

const FOOTER_NOTE =
  "This page shows a file written by the evaluation command. It does not prove who made the file or that a model was called. The results files and recordings are the record.";

// ---------------------------------------------------------------------------------------------
// One comparison: banners and the two versions
// ---------------------------------------------------------------------------------------------

function Banners({ view }: { view: ComparisonView }) {
  const { page, labels } = view;
  const sides = [
    ["baseline", page.sides.baseline],
    ["candidate", page.sides.candidate],
  ] as const;
  return (
    <>
      <ModeBanners warnings={view.warnings} labels={labels} />
      {sides.map(([name, side]) =>
        side.health.clean ? null : (
          <section class="banner banner-failed" aria-labelledby={`eval-clean-${name}-heading`}>
            <h2 id={`eval-clean-${name}-heading`}>
              {labels.notClean}: the {name} run
            </h2>
            {side.health.problems.length === 0 ? null : (
              <ul>
                {side.health.problems.map((problem) => (
                  <li>
                    <RevealedText value={problem} />
                  </li>
                ))}
              </ul>
            )}
            <p>
              A change between the two runs may be one of these failures and not a difference
              between the workflows.
            </p>
          </section>
        ),
      )}
      {view.split === "heldout"
        ? sides.map(([name, side]) =>
            side.contamination === null ? null : (
              <section class="banner" aria-labelledby={`eval-contamination-${name}-heading`}>
                <h2 id={`eval-contamination-${name}-heading`}>Held-out set: {name} run</h2>
                <p>
                  <RevealedText value={side.contamination} />
                </p>
              </section>
            ),
          )
        : null}
      {page.heldoutTrailsOpened ? (
        <section class="banner" aria-labelledby="eval-heldout-opened-heading">
          <h2 id="eval-heldout-opened-heading">Held-out set opened</h2>
          <p>{labels.heldoutOpened}</p>
        </section>
      ) : null}
    </>
  );
}

function Fact(props: { label: string; children?: Child }) {
  return (
    <>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </>
  );
}

function SideFactsList({ side, file, labels }: { side: SideFacts; file: string; labels: Labels }) {
  const { workflow, model, code } = side;
  return (
    <dl class="facts">
      <Fact label="Workflow">
        <RevealedText value={workflow.label} />{" "}
        <span class="hash">{shortHash(workflow.sha256, 12)}</span>
      </Fact>
      <Fact label="Mode">
        <ModeChip mode={side.mode} labels={labels} />
      </Fact>
      <Fact label="Retrieval">
        <RevealedText value={workflow.retrieval} />
      </Fact>
      <Fact label="Checks">
        {workflow.checks.length === 0 ? (
          "none"
        ) : (
          <RevealedText value={workflow.checks.join(", ")} />
        )}
      </Fact>
      <Fact label="Prompts">
        extract <RevealedText value={workflow.prompts.extract} />, analyze{" "}
        <RevealedText value={workflow.prompts.analyze} />, support{" "}
        {workflow.prompts.support === null ? (
          "none"
        ) : (
          <RevealedText value={workflow.prompts.support} />
        )}
      </Fact>
      <Fact label="Model provider">
        <RevealedText value={model.provider} />
      </Fact>
      <Fact label="Model requested">
        <RevealedText value={model.requested} />
      </Fact>
      <Fact label="Model reported">
        {model.reported === null ? (
          "not reported"
        ) : (
          <RevealedText value={model.reported.join(", ")} />
        )}
        {model.reportedNote === "" ? null : (
          <>
            {" "}
            (<RevealedText value={model.reportedNote} />)
          </>
        )}
      </Fact>
      <Fact label="Endpoint">
        {model.endpoint === null ? "none" : <RevealedText value={model.endpoint} />}
      </Fact>
      <Fact label="Started">
        <Time value={side.startedAt} />
      </Fact>
      <Fact label="Finished">
        <Time value={side.finishedAt} />
      </Fact>
      <Fact label="Repeats">{side.repeats}</Fact>
      <Fact label="Code">
        {code.commit === null ? (
          "no commit recorded"
        ) : (
          <>
            <span class="hash">{shortHash(code.commit, 12) || "unknown"}</span>
            {code.dirty === true ? ", uncommitted changes" : null}
          </>
        )}
      </Fact>
      <Fact label="Evidence trails">
        {side.trailsRecorded ? "recorded in the results file" : "not recorded in the results file"}
      </Fact>
      <Fact label="Results file">
        <code>
          <RevealedText value={file} />
        </code>
      </Fact>
    </dl>
  );
}

function Versions({ view }: { view: ComparisonView }) {
  const { page, labels } = view;
  return (
    <Section id="versions" title="The two versions">
      <div class="stack">
        <div>
          <h3>Baseline</h3>
          <SideFactsList side={page.sides.baseline} file={page.files.baseline} labels={labels} />
        </div>
        <div>
          <h3>Candidate</h3>
          <SideFactsList side={page.sides.candidate} file={page.files.candidate} labels={labels} />
        </div>
        <div>
          <h3>What they were run on</h3>
          <dl class="facts">
            <Fact label="Dataset">
              <RevealedText value={page.dataset.label} />, answer keys{" "}
              <span class="hash">{shortHash(page.dataset.answerKeysSha256, 12)}</span>, splits file{" "}
              <span class="hash">{shortHash(page.dataset.splitsFileSha256, 12)}</span>
            </Fact>
            <Fact label="Playbook">
              <RevealedText value={`${page.playbook.slug} ${page.playbook.version}`} />{" "}
              <span class="hash">{shortHash(page.playbook.sha256, 12)}</span>
            </Fact>
            <Fact label="Evaluation version">
              <RevealedText value={page.evaluation.label} />{" "}
              <span class="hash">{shortHash(page.evaluation.sha256, 12)}</span>
            </Fact>
          </dl>
        </div>
        <div>
          <h3>Differences between the runs</h3>
          {page.differences.length === 0 ? (
            <p class="empty">No difference between the pins of the two runs was recorded.</p>
          ) : (
            <ScrollBox label="Differences between the runs">
              <table class="data-table">
                <caption class="sr-only">Differences between the pins of the two runs</caption>
                <thead>
                  <tr>
                    <th scope="col">Pin</th>
                    <th scope="col">Field</th>
                    <th scope="col">Baseline</th>
                    <th scope="col">Candidate</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {page.differences.map((d) => (
                    <tr>
                      <th scope="row">
                        <RevealedText value={d.name} />
                      </th>
                      <td>
                        <RevealedText value={d.field} />
                      </td>
                      <td>
                        <RevealedText value={d.baseline} />
                      </td>
                      <td>
                        <RevealedText value={d.candidate} />
                      </td>
                      <td>
                        {d.status === "declared" ? "Declared variable" : "Allowed difference"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollBox>
          )}
        </div>
        {page.notes.length === 0 ? null : (
          <div>
            <h3>Notes</h3>
            <ul>
              {page.notes.map((note) => (
                <li>
                  <RevealedText value={note} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}

function SplitSwitch({ view }: { view: ComparisonView }) {
  const { page, section } = view;
  const heldoutPresent = page.sections.some((s) => s.split === "heldout");
  const { baseline, candidate } = section.sides;
  return (
    <div class="stack">
      <nav aria-label="Split" class="eval-splits">
        <ul class="nav-list">
          {page.sections.map((s) => (
            <li>
              <a
                href={urls.evaluations({ comparison: page.id, split: s.split })}
                aria-current={s.split === view.split ? "page" : undefined}
              >
                {splitLabel(s.split)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <p>
        Baseline: {baseline.cases} of {baseline.casesInSplit} cases of the split,{" "}
        {plural(baseline.completedRepeats, "repeat")} scored. Candidate: {candidate.cases} of{" "}
        {candidate.casesInSplit} cases of the split, {plural(candidate.completedRepeats, "repeat")}{" "}
        scored.
        {section.repeats === "" ? null : (
          <>
            {" "}
            Repeats compared: <RevealedText value={section.repeats} />.
          </>
        )}
      </p>
      {baseline.fullSplit && candidate.fullSplit ? null : (
        <p class="hint">At least one of the two runs did not cover the whole split.</p>
      )}
      {heldoutPresent ? null : (
        <p class="hint">
          {/* The document does not say which results file ran which split, so this says no more. */}
          The held-out split is not in this comparison.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Gates, decision rule, metrics
// ---------------------------------------------------------------------------------------------

/** A line of what a gate measured: the count over its denominator, and what it came to. */
function evidenceLine(e: GateView["evidence"][number]): string {
  const parts: string[] = [e.measure];
  if (e.numerator !== null && e.denominator !== null)
    parts.push(`${e.numerator} of ${e.denominator}`);
  if (e.value !== null) parts.push(`value ${e.value}`);
  if (e.repeat !== null) parts.push(`repeat ${e.repeat}`);
  if (e.context === true) parts.push("shown for context, not tested");
  else if (e.passed === true) parts.push("passed");
  else if (e.passed === false) parts.push("failed");
  return parts.join(", ");
}

function GateCell(props: {
  gate: GateView | undefined;
  side: string;
  labels: Labels;
  view: ComparisonView;
}) {
  const { gate, side, labels, view } = props;
  if (gate === undefined)
    return (
      <td>
        <p class="eval-cell-sub">No gate report was recorded for this version.</p>
      </td>
    );
  const regressed = gate.slots ?? [];
  return (
    <td>
      <p>
        <OutcomeChip outcome={gate.outcome} labels={labels} />
      </p>
      <p class="eval-gate-reason">
        <RevealedText value={gate.detail} />
      </p>
      {regressed.length === 0 ? null : (
        <>
          <p class="eval-cell-sub">Slots that regressed:</p>
          <ul>
            {regressed.map((slot) => (
              <li>
                <SlotLink view={view} caseKey={slot.caseKey} ruleKey={slot.ruleKey} />
              </li>
            ))}
          </ul>
        </>
      )}
      {gate.evidence.length === 0 ? null : (
        <details class="disclosure">
          <summary>
            Counts
            <span class="sr-only">
              {" "}
              for {gate.id}, {side}
            </span>
          </summary>
          <ul>
            {gate.evidence.map((e) => (
              <li>
                <RevealedText value={evidenceLine(e)} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </td>
  );
}

/** A link to the trail of a changed slot, or its name where the slot has no trail to open. */
function SlotLink(props: { view: ComparisonView; caseKey: string; ruleKey: string }) {
  const { view, caseKey, ruleKey } = props;
  const change = view.section.changes.find((c) => c.caseKey === caseKey && c.ruleKey === ruleKey);
  const name = `${caseKey} ${ruleKey}`;
  if (change === undefined || "sealed" in change.trail)
    return (
      <>
        <RevealedText value={name} />
        {change === undefined ? null : " (sealed)"}
      </>
    );
  return (
    <a href={urls.evaluations({ comparison: view.page.id, split: view.split, caseKey, ruleKey })}>
      <RevealedText value={name} />
    </a>
  );
}

function Gates({ view }: { view: ComparisonView }) {
  const { section, labels } = view;
  const { baseline, candidate } = section.gates;
  const rows = candidate ?? baseline ?? [];
  return (
    <Section
      id="gates"
      title="Gates"
      note="A gate is a test of one version against a threshold. A gate that was not evaluated is not a pass, and the reason is given beside it."
    >
      {rows.length === 0 ? (
        <p class="empty">No gate report was recorded for this split.</p>
      ) : (
        <ScrollBox label="Release gates">
          <table class="data-table">
            <caption class="sr-only">Release gates G1 to G14, baseline and candidate</caption>
            <thead>
              <tr>
                <th scope="col">Gate</th>
                <th scope="col">Threshold</th>
                <th scope="col">Baseline</th>
                <th scope="col">Candidate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((gate, index) => (
                <tr>
                  <th scope="row">
                    <span class="hash">{gate.id}</span> <RevealedText value={gate.title} />
                  </th>
                  <td>
                    <RevealedText value={gate.threshold} />
                    <p class="eval-cell-sub">
                      Applies to: <RevealedText value={gate.scope} />
                    </p>
                  </td>
                  <GateCell gate={baseline?.[index]} side="baseline" labels={labels} view={view} />
                  <GateCell
                    gate={candidate?.[index]}
                    side="candidate"
                    labels={labels}
                    view={view}
                  />
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollBox>
      )}
    </Section>
  );
}

function DecisionRule({ view }: { view: ComparisonView }) {
  const { section, labels } = view;
  const d = section.decision;
  return (
    <Section id="decision-rule" title="Decision rule">
      {d === null ? (
        <p>
          <RevealedText
            value={section.decisionNote ?? "The decision rule was not applied to this comparison."}
          />
        </p>
      ) : (
        <div class="stack">
          <p>
            Gate result under the decision rule: <strong>{labels.decision[d.outcome]}</strong>
          </p>
          <p>{labels.notARecommendation}</p>
          {d.reasons.length === 0 && d.conditions.length === 0 ? null : (
            <ul>
              {d.reasons.map((reason) => (
                <li>
                  <RevealedText value={reason} />
                </li>
              ))}
              {d.conditions.map((condition) => (
                <li>
                  Condition: <RevealedText value={condition} />
                </li>
              ))}
            </ul>
          )}
          <h3>Conditions of the rule that this comparison cannot check</h3>
          {d.unchecked.length === 0 ? (
            <p class="empty">None are listed.</p>
          ) : (
            <ul>
              {d.unchecked.map((item) => (
                <li>
                  <RevealedText value={item} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

function Metrics({ view }: { view: ComparisonView }) {
  const { section } = view;
  return (
    <Section id="metrics" title="Metrics">
      {section.rows.length === 0 ? (
        <p class="empty">No metric rows were recorded for this split.</p>
      ) : (
        <ScrollBox label="Metrics of the two versions">
          <table class="data-table">
            <caption class="sr-only">
              Metrics of the two versions, with the counts behind each rate
            </caption>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Baseline</th>
                <th scope="col">Candidate</th>
                <th scope="col">Change</th>
                <th scope="col">Gate</th>
                <th scope="col">Pass</th>
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row) => (
                <tr>
                  <th scope="row">
                    <RevealedText value={row.metric} />
                  </th>
                  <td>
                    <RevealedText value={row.baseline} />
                  </td>
                  <td>
                    <RevealedText value={row.candidate} />
                  </td>
                  <td>
                    <RevealedText value={row.change} />
                  </td>
                  <td>
                    <RevealedText value={row.gate} />
                  </td>
                  <td>
                    <RevealedText value={row.pass} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollBox>
      )}
      <p class="hint">
        Change is the candidate minus the baseline, in the unit of the metric. A cell without data
        is n/a. Latency and cost are never shown for a scripted run.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// The slots that changed
// ---------------------------------------------------------------------------------------------

function SideCell({ side, labels }: { side: SideCount; labels: Labels }) {
  return (
    <td>
      <p>
        <StatusChip status={side.modal} />
      </p>
      <p class="eval-cell-sub">
        <RevealedText value={side.histogram} />, {side.correct} of {side.repeats} right
      </p>
      {side.failures.length === 0 ? null : (
        <p class="eval-cell-sub">{side.failures.map((f) => labels.failure[f]).join("; ")}</p>
      )}
    </td>
  );
}

function Changes({ view }: { view: ComparisonView }) {
  const { section, labels, page } = view;
  return (
    <Section id="changes" title="Slots that changed">
      <p>
        {section.changes.length} of {section.paired} paired slots changed ({section.unpaired} not
        paired). Regressions are listed first.
      </p>
      {section.changes.length === 0 ? (
        <p class="empty">No paired slot changed its answer.</p>
      ) : (
        <ScrollBox label="Table of changed slots">
          <table class="data-table">
            <caption class="sr-only">Slots whose answer changed between the two versions</caption>
            <thead>
              <tr>
                <th scope="col">Case</th>
                <th scope="col">Rule</th>
                <th scope="col">Severity</th>
                <th scope="col">Expected</th>
                <th scope="col">Baseline</th>
                <th scope="col">Candidate</th>
                <th scope="col">Change</th>
                <th scope="col">Evidence trail</th>
              </tr>
            </thead>
            <tbody>
              {section.changes.map((change) => (
                <tr>
                  <th scope="row">
                    <RevealedText value={change.caseKey} />
                  </th>
                  <td>
                    <code>
                      <RevealedText value={change.ruleKey} />
                    </code>
                    <p class="eval-cell-sub">
                      <RevealedText value={change.ruleTitle} />
                    </p>
                  </td>
                  <td>
                    <SeverityChip severity={change.severity} />
                  </td>
                  <td>
                    <StatusChip status={change.expected} />
                  </td>
                  <SideCell side={change.baseline} labels={labels} />
                  <SideCell side={change.candidate} labels={labels} />
                  <td>
                    <ChangeChip kind={change.kind} labels={labels} />
                  </td>
                  <td>
                    {"sealed" in change.trail ? (
                      "Sealed"
                    ) : (
                      <a
                        href={urls.evaluations({
                          comparison: page.id,
                          split: view.split,
                          caseKey: change.caseKey,
                          ruleKey: change.ruleKey,
                        })}
                      >
                        Open the trail
                        <span class="sr-only">
                          {" "}
                          for {change.caseKey}, {change.ruleKey}
                        </span>
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollBox>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// The evidence trail of one slot
// ---------------------------------------------------------------------------------------------

/** A paragraph longer than this scrolls inside its own box, which then takes a tab stop. */
const LONG_TEXT = 1500;

const ANCHOR_ROLE_LABEL: Record<"governing" | "superseded" | "relevant", string> = {
  governing: "Governing",
  superseded: "Superseded",
  relevant: "Relevant",
};

const SHOWN_WHY: Record<string, string> = {
  located: "located by the reader",
  definition: "a definition",
  cross_reference: "a cross reference",
  hint: "a playbook hint",
  full_document: "the whole document",
};

/** Where `anchor` first occurs in `text`, as a range to mark, or null. The anchor is a phrase of the key. */
function anchorRange(text: string, anchor: string): Offsets | null {
  if (anchor === "") return null;
  const at = text.indexOf(anchor);
  return at === -1 ? null : { start: at, end: at + anchor.length };
}

function Figure(props: {
  caption: Child;
  passage: Passage | undefined;
  doc: string;
  paragraph: number;
  range: Offsets | null;
  note?: Child;
  context: string;
}) {
  const { passage } = props;
  const long = passage !== undefined && passage.text.length > LONG_TEXT;
  return (
    <figure class="eval-passage">
      <figcaption class="eval-passage-meta">{props.caption}</figcaption>
      {passage === undefined ? (
        <p class="muted">
          The text of {props.doc} paragraph {props.paragraph} is not in this file.
        </p>
      ) : (
        <blockquote
          class={long ? "doc-text long" : "doc-text"}
          tabindex={long ? 0 : undefined}
          aria-label={
            long ? `Text of ${props.doc} paragraph ${props.paragraph}, ${props.context}` : undefined
          }
        >
          <HighlightedText text={passage.text} offsets={props.range} />
        </blockquote>
      )}
      {props.note === undefined ? null : <p class="eval-cell-sub">{props.note}</p>}
    </figure>
  );
}

function documentName(selected: Selected, doc: string): string {
  const found = selected.documents.find((d) => d.label === doc);
  return found === undefined ? doc : `${doc}, ${found.title} (version ${found.versionNo})`;
}

function locationText(
  selected: Selected,
  doc: string,
  paragraph: number,
  passage: Passage | undefined,
): string {
  const clause =
    passage?.clauseNumber === null || passage?.clauseNumber === undefined
      ? ""
      : `, clause ${passage.clauseNumber}`;
  return `${documentName(selected, doc)}${clause}, paragraph ${paragraph}`;
}

function KeyBlock({ selected }: { selected: Selected }) {
  const trail = selected.change.trail;
  if ("sealed" in trail) return null;
  const { key } = trail;
  return (
    <div class="eval-trail">
      <h3>The answer key</h3>
      <dl class="facts">
        <Fact label="Expected status">
          <StatusChip status={selected.change.expected} />
        </Fact>
        <Fact label="Also accepted">
          {selected.change.acceptable.length === 0 ? (
            "no other status"
          ) : (
            <span class="chips">
              {selected.change.acceptable.map((status) => (
                <StatusChip status={status} />
              ))}
            </span>
          )}
        </Fact>
        <Fact label="Basis">
          <RevealedText value={key.basis} />
        </Fact>
        {key.note === "" ? null : (
          <Fact label="Note">
            <RevealedText value={key.note} />
          </Fact>
        )}
        <Fact label="Escalation expected">
          <RevealedText value={key.escalation.mode} />
          {key.escalation.codes.length === 0 ? null : (
            <>
              {" "}
              <span class="chips">
                {key.escalation.codes.map((code) => (
                  <EscalationChip code={code} />
                ))}
              </span>
            </>
          )}
        </Fact>
      </dl>
      {key.anchors.length === 0 ? (
        <p class="empty">The key points at no passage.</p>
      ) : (
        key.anchors.map((anchor) => {
          const passage = selected.passages.get(`${anchor.doc}:${anchor.paragraph}`);
          return (
            <Figure
              doc={anchor.doc}
              paragraph={anchor.paragraph}
              passage={passage}
              range={passage === undefined ? null : anchorRange(passage.text, anchor.anchor)}
              context={`answer key, ${ANCHOR_ROLE_LABEL[anchor.role]}`}
              caption={
                <>
                  <RevealedText
                    value={locationText(selected, anchor.doc, anchor.paragraph, passage)}
                  />
                  , {ANCHOR_ROLE_LABEL[anchor.role].toLowerCase()} in the key
                </>
              }
            />
          );
        })
      )}
    </div>
  );
}

function shownText(shown: NonNullable<TrailRepeat["shown"]>): string {
  if (!shown.sent) return "Nothing was sent: the text was over the context budget.";
  if (shown.full) return "The whole operative document.";
  if (shown.spans.length === 0) return "No paragraph.";
  return shown.spans
    .map((span) => `${span.doc}-p${span.paragraph} (${SHOWN_WHY[span.why] ?? "shown"})`)
    .join(", ");
}

function CheckList(props: { title: string; ids: readonly string[] }) {
  if (props.ids.length === 0) return null;
  return (
    <li>
      {props.title}: {props.ids.map((id) => checkLabel(id)).join("; ")}
    </li>
  );
}

function RepeatBlock(props: {
  repeat: TrailRepeat;
  selected: Selected;
  side: string;
  recorded: boolean;
  labels: Labels;
}) {
  const { repeat, selected, labels } = props;
  return (
    <div class="eval-trail-repeat">
      <h4>Repeat {repeat.repeat}</h4>
      <p class="chips">
        <StatusChip status={repeat.observed} />
        {repeat.correct ? (
          <Chip tone="ok" shape="circle">
            Right
          </Chip>
        ) : (
          <Chip tone="bad" shape="triangle">
            Wrong
          </Chip>
        )}
        {repeat.silentMiss ? (
          <Chip tone="bad" shape="square">
            Silent miss
          </Chip>
        ) : null}
        {repeat.escalations.map((code) => (
          <EscalationChip code={code} />
        ))}
      </p>
      <p>
        {repeat.failure === null ? "No failure." : labels.failure[repeat.failure]}{" "}
        {repeat.verifiedQuotes} verified {repeat.verifiedQuotes === 1 ? "quote" : "quotes"}.
        {repeat.verificationState === null
          ? null
          : repeat.verificationState === "verified"
            ? " The finding passed verification."
            : " The system escalated the finding."}
      </p>
      {!props.recorded ? null : (
        <>
          <p>
            <strong>Shown to the reader:</strong>{" "}
            {repeat.shown === null ? "not recorded." : shownText(repeat.shown)}
          </p>
          {repeat.cited.length === 0 ? (
            <p>
              <strong>Cited:</strong> no passage.
            </p>
          ) : (
            repeat.cited.map((cited) => {
              const passage = selected.passages.get(`${cited.doc}:${cited.paragraph}`);
              const verified = cited.quoteCheck === "verified";
              const range =
                verified && cited.start !== null && cited.end !== null
                  ? { start: cited.start, end: cited.end }
                  : null;
              return (
                <Figure
                  doc={cited.doc}
                  paragraph={cited.paragraph}
                  passage={passage}
                  range={range}
                  context={`${props.side} repeat ${repeat.repeat}`}
                  caption={
                    <>
                      Cited:{" "}
                      <RevealedText
                        value={locationText(selected, cited.doc, cited.paragraph, passage)}
                      />
                      . <RoleChip role={cited.role} /> <QuoteCheckChip check={cited.quoteCheck} />
                    </>
                  }
                  note={
                    cited.quoteCheck === "not_found"
                      ? "Quote not found in this passage."
                      : cited.quoteCheck === "ambiguous"
                        ? "The quote appears more than once in this passage, so it is not marked."
                        : undefined
                  }
                />
              );
            })
          )}
          {repeat.checks === null ? (
            <p>
              <strong>Checks:</strong> not recorded.
            </p>
          ) : (
            <>
              <p>
                <strong>Checks:</strong>
              </p>
              <ul>
                <CheckList title="Passed" ids={repeat.checks.pass} />
                <CheckList title="Failed" ids={repeat.checks.fail} />
                <CheckList title="Did not apply" ids={repeat.checks.notApplicable} />
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

function SideTrailBlock(props: {
  title: string;
  side: SideTrail;
  count: SideCount;
  mode: RunMode;
  selected: Selected;
  labels: Labels;
}) {
  const { side, count, labels } = props;
  return (
    <div class="eval-trail">
      <h3>{props.title}</h3>
      <p>
        {count.correct} of {plural(count.repeats, "repeat")} right.{" "}
        <ModeChip mode={props.mode} labels={labels} />
      </p>
      {side.recorded ? null : (
        <p class="hint">
          {labels.whyNot[side.whyNot ?? "not_recorded"]} The scores below are still shown.
        </p>
      )}
      {side.repeats.length === 0 ? (
        <p class="empty">No repeat is recorded for this slot.</p>
      ) : (
        side.repeats.map((repeat) => (
          <RepeatBlock
            repeat={repeat}
            selected={props.selected}
            side={props.title}
            recorded={side.recorded}
            labels={labels}
          />
        ))
      )}
    </div>
  );
}

function Trail({ view }: { view: ComparisonView }) {
  const { selected, labels, page } = view;
  if (selected === null) return null;
  const heading = (title: string, body: Child) => (
    <section class="section" aria-labelledby="trail">
      <h2 id="trail" tabindex={-1}>
        {title}
      </h2>
      {body}
    </section>
  );
  if ("missing" in selected)
    return heading(
      "Evidence trail",
      <>
        <p>That slot is not among the slots that changed in this comparison.</p>
        <p>
          <a href="#changes">Back to the changed slots</a>
        </p>
      </>,
    );
  const { change } = selected;
  const name = `${change.caseKey} ${change.ruleKey}`;
  const title = `Evidence trail for ${name}`;
  if ("sealed" in change.trail)
    return heading(
      title,
      <>
        <p>
          This is a slot of the held-out split. Its evidence trail is sealed and is not in the file.
          Publishing the comparison with the option to open the held-out trails would include it,
          and the set could then no longer be treated as unseen.
        </p>
        <p>
          <a href="#changes">Back to the changed slots</a>
        </p>
      </>,
    );
  return heading(
    title,
    <div class="stack">
      <p>
        <a href="#changes">Back to the changed slots</a>
      </p>
      <p class="chips">
        <RevealedText value={change.ruleTitle} /> <SeverityChip severity={change.severity} />{" "}
        <ChangeChip kind={change.kind} labels={labels} />
      </p>
      <p>
        {labels.trailNotShown}{" "}
        {page.sides.baseline.mode === page.sides.candidate.mode ? (
          labels.answers[page.sides.baseline.mode]
        ) : (
          <>
            Baseline: {labels.answers[page.sides.baseline.mode]} Candidate:{" "}
            {labels.answers[page.sides.candidate.mode]}
          </>
        )}
      </p>
      <KeyBlock selected={selected} />
      <SideTrailBlock
        title="Baseline"
        side={change.trail.baseline}
        count={change.baseline}
        mode={page.sides.baseline.mode}
        selected={selected}
        labels={labels}
      />
      <SideTrailBlock
        title="Candidate"
        side={change.trail.candidate}
        count={change.candidate}
        mode={page.sides.candidate.mode}
        selected={selected}
        labels={labels}
      />
    </div>,
  );
}

// ---------------------------------------------------------------------------------------------
// The draft record and the page
// ---------------------------------------------------------------------------------------------

function Draft({ view }: { view: ComparisonView }) {
  return (
    <Section
      id="draft"
      title="Draft promotion record"
      note="A draft of the text only. It records nothing and promotes nothing."
    >
      <div class="stack">
        <label for="eval-draft-text">{`Draft text for the ${splitLabel(view.split)} split`}</label>
        <textarea
          id="eval-draft-text"
          class="eval-draft-text"
          readonly
          rows={28}
          aria-describedby="eval-draft-hint"
        >
          {textareaValue(view.draft)}
        </textarea>
        <p class="hint" id="eval-draft-hint">
          Read only. Select the text and copy it into a document. A person fills in the decision and
          signs it there.
        </p>
      </div>
    </Section>
  );
}

export function ComparisonPageView({ chrome, view }: { chrome: Chrome; view: ComparisonView }) {
  const { page } = view;
  return (
    <Layout title="Compare workflow versions" chrome={chrome} wide>
      <Crumbs
        items={[
          { label: "Evaluations", href: urls.evaluations() },
          {
            label: `${page.sides.baseline.workflow.label} against ${page.sides.candidate.workflow.label}`,
          },
        ]}
      />
      <h1>Compare workflow versions</h1>
      <p class="muted">
        Published <Time value={view.publishedAt} />. Comparison <code>{page.id}</code>.
      </p>
      <Banners view={view} />
      <Versions view={view} />
      <SplitSwitch view={view} />
      <Gates view={view} />
      <DecisionRule view={view} />
      <Metrics view={view} />
      <Changes view={view} />
      <Trail view={view} />
      <Draft view={view} />
      <p class="section-note">{FOOTER_NOTE}</p>
    </Layout>
  );
}
