import type { ReasonCode } from "../../src/contracts.js";
import {
  FindingPage,
  FindingPane,
  MemosPage,
  RunPage,
  render,
} from "../../src/server/pages/index.js";
import type { MissedIssueDraft, NoteDraft, RatingDraft } from "../../src/server/pages/feedback.js";
import type { MemosPageProps } from "../../src/server/pages/memos.js";
import type { DecisionDraft } from "../../src/server/pages/finding.js";
import type { Chrome } from "../../src/server/pages/layout.js";
import { RatingSection } from "../../src/server/pages/feedback.js";
import { auditPage, expectAccessible, formatViolations } from "../a11y/rules.js";
import { byId, parseHtml, type El } from "./html.js";
import type { RunPageProps } from "../../src/server/pages/run.js";
import { refusalOf } from "../../src/server/routes/notices.js";
import type {
  FindingView,
  IssueRow,
  MemoSummary,
  MissedIssueView,
  NoteView,
  RatingView,
  ReviewHistoryItem,
  RuleChoice,
  RunSummary,
} from "../../src/services/views.js";
import { ConflictError, ValidationError } from "../../src/store/index.js";
import {
  IDS,
  buildChrome,
  buildDecidedFinding,
  buildDocuments,
  buildFindingView,
  buildIssueRows,
  buildMatterSummary,
  buildMemo,
  buildRunSummary,
} from "./support.js";

/**
 * Fixtures of the reason code and the minor-edit mark on a decision (package W2.6a, slice A), in
 * each state that changes what the finding pane shows: the decision form with and without what was
 * typed, the history of a decision that carries a code and a mark, and the finding page that
 * answers a refused decision. `test/pages/support.ts` is not edited by this package, so the finding
 * is built from its builders with the optional fields set. Everything here is synthetic.
 *
 * Slice B adds the review page with the section of reports of missed issues, slice C the memos
 * page with the section that rates the matter, and slice D the notes on a finding, below.
 */

/** A decision history item as the review service now makes it. */
export function decision(
  over: Partial<ReviewHistoryItem> & Pick<ReviewHistoryItem, "decision">,
): ReviewHistoryItem {
  return {
    reviewerName: "D. Whitfield",
    at: "2026-11-03T15:30:00Z",
    reason: "The explanation does not match the clause.",
    validity: "current",
    reasonCode: null,
    minorEdit: null,
    edits: null,
    ...over,
  };
}

/** The decided finding of the worked example, its history replaced by `items`. */
export function decidedWith(items: ReviewHistoryItem[]): FindingView {
  const base = buildDecidedFinding();
  const current = items.find((item) => item.validity === "current") ?? null;
  return {
    ...base,
    issue: {
      ...base.issue,
      review:
        current === null
          ? null
          : {
              decision: current.decision,
              reviewerName: current.reviewerName,
              at: current.at,
              validity: "current",
            },
    },
    reviews: items,
  };
}

/** An edit of the fallback wording, marked minor or not, with a code. */
export const editWith = (
  reasonCode: ReasonCode | null,
  minorEdit: boolean | null,
  validity: "current" | "stale" = "current",
): ReviewHistoryItem =>
  decision({
    decision: "edit",
    reasonCode,
    minorEdit,
    validity,
    edits: { fallbackLanguage: "6.1 The obligations continue for two (2) years." },
  });

/** The pane of an undecided finding, the decision form holding `draft`. */
export const decisionPane = (draft?: DecisionDraft): string =>
  render(
    FindingPane({
      chrome: buildChrome(),
      matterId: IDS.matter,
      finding: buildFindingView(),
      draft,
    }),
  );

/** The pane of `finding`, as a fragment. */
export const paneOf = (finding: FindingView): string =>
  render(FindingPane({ chrome: buildChrome(), matterId: IDS.matter, finding }));

/**
 * The finding page that answers a refused decision: the store's own refusal turned into the notice
 * by the route's own function, so the words, the todo and the jump are the ones a person is shown.
 */
export function refusedFindingPage(code: string, draft?: DecisionDraft): string {
  const refusal = refusalOf(new ValidationError(code, "refused"));
  if (refusal === null) throw new Error(`${code} is not a refusal the form can answer`);
  return render(
    FindingPage({
      chrome: buildChrome({ notice: refusal.notice }),
      matterId: IDS.matter,
      matterName: "Lanternfish / Corvane NDA",
      finding: buildFindingView(),
      draft,
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// The report of a missed issue on the review page (slice B)
// ---------------------------------------------------------------------------------------------

/** The rules of the playbook of the worked example, in the order its issue table has them (not alphabetical). */
export const RULE_CHOICES: RuleChoice[] = [
  { ruleKey: "pty-1", title: "Parties correctly identified" },
  { ruleKey: "def-1", title: "Scope of Confidential Information" },
  { ruleKey: "exc-1", title: "Four standard exclusions" },
  { ruleKey: "pds-1", title: "Disclosure to representatives" },
  { ruleKey: "pds-2", title: "Disclosure required by law" },
  { ruleKey: "dur-1", title: "Duration of confidentiality obligations" },
  { ruleKey: "ret-1", title: "Return or destruction of information" },
  { ruleKey: "gov-1", title: "Governing law and forum" },
];

/** A report as the feedback service makes it. */
export function report(over: Partial<MissedIssueView> = {}): MissedIssueView {
  return {
    feedbackId: "fbk_0001",
    runId: IDS.run,
    ruleKey: "dur-1",
    ruleTitle: "Duration of confidentiality obligations",
    location: "Amendment No. 1, paragraph 2",
    note: "The amendment deletes Section 6.1, and the review did not say so.",
    reporterName: "D. Whitfield",
    at: "2026-11-03T15:30:00Z",
    ...over,
  };
}

/** What the review page is given for the section of reports. */
export type RunFeedback = NonNullable<RunPageProps["feedback"]>;

export const feedbackProps = (over: Partial<RunFeedback> = {}): RunFeedback => ({
  rules: RULE_CHOICES,
  items: [],
  ...over,
});

/** The review page of the worked example, with the section of reports as given (none when `feedback` is null). */
export function runPageWith(
  feedback: RunFeedback | null,
  options: {
    run?: RunSummary;
    issues?: IssueRow[];
    selected?: FindingView | null;
    chrome?: Chrome;
  } = {},
): string {
  return render(
    RunPage({
      chrome: options.chrome ?? buildChrome(),
      matter: buildMatterSummary(),
      run: options.run ?? buildRunSummary(),
      issues: options.issues ?? buildIssueRows(),
      selected: options.selected === undefined ? null : options.selected,
      warnings: undefined,
      documents: buildDocuments(),
      ...(feedback === null ? {} : { feedback }),
    }),
  );
}

/** The review page that answers a refused report: the notice made by the route's own function. */
export function refusedRunPage(
  code: string,
  draft?: MissedIssueDraft,
  options: { status?: "conflict" | "validation"; issues?: IssueRow[]; run?: RunSummary } = {},
): string {
  const error =
    options.status === "conflict"
      ? new ConflictError(code, "refused")
      : new ValidationError(code, "refused");
  const refusal = refusalOf(error);
  if (refusal === null) throw new Error(`${code} is not a refusal the form can answer`);
  return render(
    RunPage({
      chrome: buildChrome({ notice: refusal.notice }),
      matter: buildMatterSummary(),
      run: options.run ?? buildRunSummary(),
      issues: options.issues ?? buildIssueRows(),
      selected: null,
      documents: buildDocuments(),
      feedback: feedbackProps({ draft }),
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// The rating of a matter on the memos page (slice C)
// ---------------------------------------------------------------------------------------------

/** A rating as the feedback service makes it. */
export function ratingGiven(over: Partial<RatingView> = {}): RatingView {
  return {
    feedbackId: "fbk_0100",
    rating: 4,
    comment: "It found the deletion that I had missed.",
    at: "2026-11-05T10:20:00Z",
    ...over,
  };
}

/** What the memos page is given for the section that rates the matter. */
export type MemosRating = NonNullable<MemosPageProps["rating"]>;

/** The rating section's state: a memo, no rating, and the run of the memo, unless the test says otherwise. */
export const ratingProps = (over: Partial<MemosRating> = {}): MemosRating => ({
  hasMemo: true,
  given: null,
  runId: IDS.run,
  ...over,
});

/** The memos page of the worked example, with the rating section as given (none when `rating` is null). */
export function memosPageWith(
  rating: MemosRating | null,
  options: {
    memos?: MemoSummary[];
    canExport?: boolean;
    chrome?: Chrome;
  } = {},
): string {
  const hasMemo = rating?.hasMemo ?? true;
  return render(
    MemosPage({
      chrome: options.chrome ?? buildChrome(),
      matter: buildMatterSummary(),
      memos: options.memos ?? (hasMemo ? [buildMemo()] : []),
      canExport: options.canExport ?? true,
      exportBlockedReason: null,
      ...(rating === null ? {} : { rating }),
    }),
  );
}

/** The memos page that answers a refused rating: the notice made by the route's own function. */
export function refusedMemosPage(
  code: string,
  draft?: RatingDraft,
  options: { status?: "conflict" | "validation"; rating?: Partial<MemosRating> } = {},
): string {
  const error =
    options.status === "conflict"
      ? new ConflictError(code, "refused")
      : new ValidationError(code, "refused");
  const refusal = refusalOf(error);
  if (refusal === null) throw new Error(`${code} is not a refusal the form can answer`);
  return memosPageWith(ratingProps({ draft, ...options.rating }), {
    chrome: buildChrome({ notice: refusal.notice }),
  });
}

/** The section alone, as a fragment, for the states that need no page around them. */
export const ratingSectionOf = (rating: MemosRating): string =>
  render(
    RatingSection({
      chrome: buildChrome(),
      matterId: IDS.matter,
      hasMemo: rating.hasMemo,
      given: rating.given,
      runId: rating.runId,
      draft: rating.draft,
    }),
  );

/**
 * One problem of the memos page is not this package's: the list of memos names two landmarks
 * "Exported memos", the heading of its section and the box that scrolls its table, which
 * `memos.tsx` has had since before the rating and which the sweep of the pages (W2.9-fix) mends.
 * It is let through here by rule and by name, and nothing else is.
 */
export const isKnownProblemOfTheMemoList = (violation: { rule: string; detail: string }): boolean =>
  violation.rule === "landmark-names-unique" && /"exported memos"/.test(violation.detail);

/**
 * Audits a page or a pane with the rules of `test/a11y/rules.ts` and fails on any problem but the
 * one above. The section this package adds to the memos page is audited alone as well, strictly.
 */
export function expectAccessibleExceptTheMemoList(
  html: string,
  options: { fragment?: boolean } = {},
): El {
  const root = parseHtml(html);
  const violations = auditPage(root, options).filter((v) => !isKnownProblemOfTheMemoList(v));
  if (violations.length > 0)
    throw new Error(`accessibility problems:\n${formatViolations(violations)}`);
  const rating = byId(root, "rating");
  if (rating !== undefined) expectAccessible(rating, { fragment: true });
  return root;
}

// ---------------------------------------------------------------------------------------------
// The notes on a finding (slice D)
// ---------------------------------------------------------------------------------------------

/** A note as the feedback service makes it. */
export function noteOf(over: Partial<NoteView> = {}): NoteView {
  return {
    feedbackId: "fbk_0200",
    findingId: IDS.finding,
    note: "I do not think Section 9.3 keeps Section 4 alive. Please check the amendment.",
    authorName: "A. Ruiz",
    at: "2026-11-03T14:05:00Z",
    ...over,
  };
}

/** What the service says when a note can be added now. */
export const CAN_ADD: NonNullable<FindingView["canAddNote"]> = { allowed: true, reason: null };

/** `finding` as the service now makes it: with its notes and the answer to whether one can be added. */
export function withNotes(
  finding: FindingView,
  notes: NoteView[],
  canAddNote: NonNullable<FindingView["canAddNote"]> = CAN_ADD,
): FindingView {
  return { ...finding, notes, canAddNote };
}

/** The finding pane of the worked example with its notes, as a fragment. */
export const notesPane = (
  notes: NoteView[],
  options: {
    canAddNote?: NonNullable<FindingView["canAddNote"]>;
    noteDraft?: NoteDraft;
    finding?: FindingView;
  } = {},
): string =>
  render(
    FindingPane({
      chrome: buildChrome(),
      matterId: IDS.matter,
      finding: withNotes(options.finding ?? buildFindingView(), notes, options.canAddNote),
      noteDraft: options.noteDraft,
    }),
  );

/**
 * The finding page that answers a refused note: the store's or the parser's own refusal turned into
 * the notice by the route's own function, so the words, the todo and the jump are the ones a person
 * is shown.
 */
export function refusedNotePage(
  code: string,
  draft?: NoteDraft,
  options: {
    status?: "conflict" | "validation";
    canAddNote?: NonNullable<FindingView["canAddNote"]>;
    notes?: NoteView[];
  } = {},
): string {
  const error =
    options.status === "conflict"
      ? new ConflictError(code, "refused")
      : new ValidationError(code, "refused");
  const refusal = refusalOf(error);
  if (refusal === null) throw new Error(`${code} is not a refusal the form can answer`);
  return render(
    FindingPage({
      chrome: buildChrome({ notice: refusal.notice }),
      matterId: IDS.matter,
      matterName: "Lanternfish / Corvane NDA",
      finding: withNotes(buildFindingView(), options.notes ?? [], options.canAddNote),
      noteDraft: draft,
    }),
  );
}

/**
 * The review page of the worked example with the inspector on a finding that has notes, and the
 * issue table's rows carrying the counts the service gives them (`counts` by rule key).
 */
export function runPageWithNotes(
  notes: NoteView[],
  options: {
    counts?: Record<string, number>;
    canAddNote?: NonNullable<FindingView["canAddNote"]>;
  } = {},
): string {
  const issues = buildIssueRows().map((row) => {
    const count = options.counts?.[row.ruleKey];
    return count === undefined ? row : { ...row, noteCount: count };
  });
  return render(
    RunPage({
      chrome: buildChrome(),
      matter: buildMatterSummary(),
      run: buildRunSummary(),
      issues,
      selected: withNotes(buildFindingView(), notes, options.canAddNote),
      warnings: undefined,
      documents: buildDocuments(),
    }),
  );
}
