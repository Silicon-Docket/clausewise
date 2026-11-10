import type { Severity } from "@clausewise/playbook";
import type { Status } from "../../contracts.js";
import { STAND_IN_HEADING, STAND_IN_TEXT, isStandInProvider } from "../../stand-in.js";
import type {
  FindingView,
  IssueRow,
  MatterSummary,
  RunSummary,
  UploadWarningView,
} from "../../services/views.js";
import { urls } from "../urls.js";
import { plural } from "../views/format.js";
import {
  SEVERITY_ORDER,
  STATUS_ORDER,
  categoryLabel,
  progressStageLabel,
  runErrorMeaning,
  runStatusLabel,
  isActiveRun,
  statusLabel,
} from "../views/labels.js";
import {
  Chip,
  Crumbs,
  EscalationChip,
  ReviewChip,
  RunStatusChip,
  RevealedText,
  ScrollBox,
  Section,
  SeverityChip,
  StatusChip,
  Time,
  decisionValidity,
} from "./components.js";
import { FindingPane } from "./finding.js";
import { Layout, type Chrome } from "./layout.js";
import { WarningList, runStatusUrl } from "./matter.js";

export const ISSUE_FILTERS = ["all", "open", "escalated", "stale"] as const;
export type IssueFilter = (typeof ISSUE_FILTERS)[number];

export interface RunPageProps {
  chrome: Chrome;
  matter: MatterSummary;
  run: RunSummary;
  /** Every finding of the run. The page orders and filters them. */
  issues: IssueRow[];
  /** The finding chosen with `?finding=`, with everything the inspector shows. */
  selected: FindingView | null;
  /** True when `?finding=` named a finding that is not part of this run. */
  selectionMissing?: boolean | undefined;
  /** From `?filter=`; anything not in `ISSUE_FILTERS` has already been turned into "all". */
  filter?: IssueFilter | undefined;
  /** The matter's upload warnings, shown under the table as the sketch has them. */
  warnings?: UploadWarningView[] | undefined;
  /** For naming the document a warning is about. */
  documents?: readonly { label: string; title: string }[] | undefined;
}

/** A current finding with no decision that still counts: none made, or the one made is out of date. */
const isOpen = (row: IssueRow): boolean =>
  row.validity === "current" && (row.review === null || row.review.validity === "stale");
const isEscalated = (row: IssueRow): boolean => row.escalations.length > 0;
const isStale = (row: IssueRow): boolean => row.validity === "stale";

const FILTER_TEST: Record<IssueFilter, (row: IssueRow) => boolean> = {
  all: () => true,
  open: isOpen,
  escalated: isEscalated,
  stale: isStale,
};

const FILTER_LABEL: Record<IssueFilter, string> = {
  all: "All",
  open: "Open",
  escalated: "Escalated",
  stale: "Out of date",
};

/**
 * Severity first, then the statuses that need action, then the rule key so the order is the
 * same on every load. Rows with a severity or status the page does not know sort last.
 */
export function orderIssues(rows: readonly IssueRow[]): IssueRow[] {
  const rank = <T extends string>(list: readonly T[], value: string): number => {
    const index = list.findIndex((item) => item === value);
    return index === -1 ? list.length : index;
  };
  return [...rows].sort(
    (a, b) =>
      rank<Severity>(SEVERITY_ORDER, a.severity) - rank<Severity>(SEVERITY_ORDER, b.severity) ||
      rank<Status>(STATUS_ORDER, a.status) - rank<Status>(STATUS_ORDER, b.status) ||
      (a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : 0),
  );
}

/** The link to a run with a filter and a selected finding. Works without JavaScript. */
export function runHref(
  matterId: string,
  runId: string,
  options: { filter?: IssueFilter | undefined; findingId?: string | undefined } = {},
): string {
  const filter =
    options.filter === undefined || options.filter === "all" ? undefined : options.filter;
  if (filter === undefined) return urls.run(matterId, runId, options.findingId);
  const base = urls.run(matterId, runId);
  const finding =
    options.findingId === undefined ? "" : `&finding=${encodeURIComponent(options.findingId)}`;
  return `${base}?filter=${filter}${finding}`;
}

function Filters(props: {
  matterId: string;
  runId: string;
  issues: readonly IssueRow[];
  filter: IssueFilter;
  findingId: string | undefined;
}) {
  return (
    <nav aria-label="Filter findings" class="filters">
      <ul>
        {ISSUE_FILTERS.map((name) => {
          const count = props.issues.filter(FILTER_TEST[name]).length;
          const current = name === props.filter;
          return (
            <li>
              <a
                href={runHref(props.matterId, props.runId, {
                  filter: name,
                  findingId: props.findingId,
                })}
                aria-current={current ? "true" : undefined}
                class={current ? "filter is-current" : "filter"}
              >
                {FILTER_LABEL[name]} <span class="count">{count}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function IssueTable(props: {
  matterId: string;
  runId: string;
  rows: readonly IssueRow[];
  filter: IssueFilter;
  selectedId: string | undefined;
}) {
  return (
    <ScrollBox label="Issue table" id="issue-table" zone="issues">
      <table class="data-table issue-table" data-issue-table="">
        <caption class="sr-only">
          Findings, most severe first. Choose a rule to see its evidence beside the table.
        </caption>
        <thead>
          <tr>
            <th scope="col">Severity</th>
            <th scope="col">Category and rule</th>
            <th scope="col">Status</th>
            <th scope="col">Review</th>
            <th scope="col">Flags</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => {
            const selected = row.findingId === props.selectedId;
            return (
              <tr class={selected ? "is-selected" : undefined} data-issue-row="">
                <td>
                  <SeverityChip severity={row.severity} />
                </td>
                <th scope="row">
                  <a
                    class="row-link"
                    data-row-link=""
                    href={runHref(props.matterId, props.runId, {
                      filter: props.filter,
                      findingId: row.findingId,
                    })}
                    aria-current={selected ? "true" : undefined}
                  >
                    <RevealedText value={row.ruleTitle} />
                  </a>
                  <span class="row-sub">
                    {categoryLabel(row.category)},{" "}
                    <code class="rule-key">
                      <RevealedText value={row.ruleKey} />
                    </code>
                  </span>
                </th>
                <td>
                  <StatusChip status={row.status} />
                  {row.modelStatus === undefined || row.modelStatus === null ? null : (
                    <span class="row-sub" data-settled-row="">
                      Settled by the playbook; the workflow stated {statusLabel(row.modelStatus)}
                    </span>
                  )}
                </td>
                <td>
                  <ReviewChip
                    decision={row.review?.decision ?? null}
                    validity={decisionValidity(row)}
                  />
                </td>
                <td>
                  {row.escalations.length === 0 ? (
                    <span class="muted">None</span>
                  ) : (
                    <ul class="chip-list">
                      {row.escalations.map((escalation) => (
                        <li>
                          <EscalationChip code={escalation.code} />
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollBox>
  );
}

function KeysHelp() {
  return (
    <details class="keys-help disclosure" id="keys-help" data-keys-help="">
      <summary>Keyboard shortcuts</summary>
      <p class="hint">These keys work while focus is in the issue table.</p>
      <dl class="keys">
        <dt>
          <kbd>j</kbd>
        </dt>
        <dd>Next row</dd>
        <dt>
          <kbd>k</kbd>
        </dt>
        <dd>Previous row</dd>
        <dt>
          <kbd>Enter</kbd>
        </dt>
        <dd>Open the row you are on</dd>
        <dt>
          <kbd>?</kbd>
        </dt>
        <dd>Show this list. Escape hides it.</dd>
      </dl>
    </details>
  );
}

export function RunPage(props: RunPageProps) {
  const { chrome, matter, run, issues } = props;
  // A route passes `?filter=` through `ISSUE_FILTERS`, but a slip must not break the page.
  const filter: IssueFilter = ISSUE_FILTERS.find((name) => name === props.filter) ?? "all";
  const ordered = orderIssues(issues);
  const rows = ordered.filter(
    (row) => FILTER_TEST[filter](row) || row.findingId === props.selected?.issue.findingId,
  );
  const active = isActiveRun(run.status);
  const outOfDate =
    !run.current && !active && run.status !== "failed" && run.status !== "cancelled";
  const progress = run.progress;
  return (
    <Layout title={`Review of ${matter.name}`} chrome={chrome} wide>
      <Crumbs
        items={[
          { label: "Matters", href: urls.matters() },
          { label: matter.name, href: urls.matter(matter.id) },
          { label: "Review" },
        ]}
      />
      <header class="run-head">
        <h1>Issues</h1>
        <p class="run-meta">
          <RunStatusChip status={run.status} />
          <span>
            Run{" "}
            <code>
              <RevealedText value={run.id} />
            </code>
          </span>
          <span>
            Workflow <RevealedText value={run.workflowLabel} />
          </span>
          <span>
            Read by{" "}
            <RevealedText
              value={`${run.model.provider}, ${run.model.reported ?? run.model.requested}`}
            />
          </span>
          <span>
            Playbook <RevealedText value={`${run.playbook.slug} ${run.playbook.version}`} />
          </span>
          <span>
            Started <Time value={run.startedAt} /> by <RevealedText value={run.startedByName} />
          </span>
        </p>
      </header>

      {isStandInProvider(run.model.provider) ? (
        <section class="banner banner-standin" aria-labelledby="run-standin-heading">
          <h2 id="run-standin-heading">{STAND_IN_HEADING}</h2>
          <p>{STAND_IN_TEXT}</p>
        </section>
      ) : null}

      {outOfDate ? (
        <section class="banner banner-stale" aria-labelledby="run-stale-heading">
          <h2 id="run-stale-heading">This review is out of date</h2>
          <p>
            The documents or the playbook changed after it ran. Its decisions no longer count and
            its memo cannot be exported.
          </p>
          <p>
            <a class="button button-primary" href={urls.matter(matter.id)}>
              Go to the matter to run it again
            </a>
          </p>
        </section>
      ) : null}

      {active ? (
        <Section id="run-progress" title="Review in progress">
          <div
            class="progress-box"
            role="status"
            aria-live="polite"
            data-run-live=""
            data-status-url={runStatusUrl(matter.id, run.id)}
            data-run-status={run.status}
            data-run-stage={progress === null ? "" : progress.stage}
          >
            <p>
              {progress === null ? (
                <span data-role="stage">{runStatusLabel(run.status)}</span>
              ) : (
                <>
                  <span data-role="stage">{progressStageLabel(progress.stage)}</span>:{" "}
                  <span data-role="done">{progress.done}</span> of{" "}
                  <span data-role="total">{progress.total}</span>
                </>
              )}
            </p>
            <progress
              aria-label="Review progress"
              data-role="bar"
              value={progress === null ? undefined : progress.done}
              max={progress === null ? undefined : Math.max(progress.total, 1)}
            ></progress>
          </div>
          <p class="muted">The findings appear when the review finishes.</p>
        </Section>
      ) : null}

      {run.status === "failed" ? (
        <section class="banner banner-failed" aria-labelledby="run-failed-heading">
          <h2 id="run-failed-heading">This review did not finish</h2>
          <p>{runErrorMeaning(run.errorKind)}</p>
          {run.current && (run.resumable ?? true) ? (
            <p>
              <a href={urls.matter(matter.id)}>Go to the matter to resume it</a>
            </p>
          ) : run.current ? (
            <p>
              It was started on a different provider or model than the one now in use, so it cannot
              be resumed.{" "}
              <a href={urls.matter(matter.id)}>Go to the matter to start a new review</a>
            </p>
          ) : (
            <p>
              The documents or the playbook changed after it started, so it cannot be resumed.{" "}
              <a href={urls.matter(matter.id)}>Go to the matter to start a new review</a>
            </p>
          )}
        </section>
      ) : null}

      {active ? null : (
        <>
          <Filters
            matterId={matter.id}
            runId={run.id}
            issues={issues}
            filter={filter}
            findingId={props.selected?.issue.findingId}
          />
          <p class="muted">
            {plural(issues.length, "finding")}: {issues.filter(isOpen).length} open,{" "}
            {issues.filter(isEscalated).length} escalated, {issues.filter(isStale).length} out of
            date.
          </p>
          {rows.length === 0 ? null : (
            <p class="jump">
              <a href="#inspector">Go to the evidence inspector</a>
            </p>
          )}
          <div class="run-layout">
            <div class="run-table">
              {rows.length === 0 ? (
                <p class="empty">
                  {issues.length === 0
                    ? "This review has no findings."
                    : "No finding matches this filter."}
                </p>
              ) : (
                <>
                  <p class="scroll-hint muted">
                    The table scrolls sideways on a narrow screen. The review state and the flags
                    are on the right.
                  </p>
                  <IssueTable
                    matterId={matter.id}
                    runId={run.id}
                    rows={rows}
                    filter={filter}
                    selectedId={props.selected?.issue.findingId}
                  />
                </>
              )}
              {props.warnings === undefined || props.warnings.length === 0 ? null : (
                <div class="run-warnings">
                  <h2>Warnings</h2>
                  <WarningList warnings={props.warnings} documents={props.documents ?? []} />
                </div>
              )}
              <p class="legend muted">
                Flags say what the review could not confirm. Each one is explained in the inspector.
              </p>
              <KeysHelp />
            </div>
            <aside
              class="inspector"
              id="inspector"
              data-inspector=""
              aria-label="Evidence inspector"
              tabindex={0}
            >
              {props.selected !== null ? (
                <>
                  <p class="jump">
                    <a href="#issue-table">Back to the issue table</a>
                  </p>
                  <FindingPane chrome={chrome} matterId={matter.id} finding={props.selected} />
                </>
              ) : props.selectionMissing === true ? (
                <div class="inspector-empty">
                  <Chip tone="warn" shape="triangle">
                    Not found
                  </Chip>
                  <p>That finding is not part of this review. Choose a row from the table.</p>
                </div>
              ) : (
                <div class="inspector-empty">
                  <p>
                    Choose a rule in the table to see the passages it cites, the checks it passed
                    and failed, and the decision form.
                  </p>
                </div>
              )}
            </aside>
          </div>
        </>
      )}
    </Layout>
  );
}
