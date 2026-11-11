import type { Principal } from "../auth/types.js";
import type {
  ChangeKind,
  ChangeView,
  ComparisonPage,
  DecisionOutcome,
  FailureKind,
  GateOutcome,
  GateView,
  PageProblem,
  PassageView,
  RunMode,
  SectionView,
  SplitName,
} from "../evaluations/document.js";
import { draftPromotionRecord } from "../evaluations/draft.js";
import type { ComparisonSource } from "../evaluations/source.js";
import {
  ANSWERS_BY_MODE,
  CHANGE_KIND_LABEL,
  DECISION_LABEL,
  FAILURE_LABEL,
  GATE_OUTCOME_LABEL,
  HELDOUT_OPENED,
  MODE_LABEL,
  MODE_WORDS,
  NOT_A_RECOMMENDATION,
  NOT_CLEAN,
  PROBLEM_ACTION,
  PROBLEM_LABEL,
  TRAIL_NOT_SHOWN,
  WHY_NOT_LABEL,
  scriptedModesIn,
} from "../evaluations/words.js";
import { NotFoundError } from "../store/errors.js";
import { requireGlobalRole } from "./deps.js";

/**
 * The evaluation comparison page, as data (package W2.5). The service reads published comparison
 * files through a `ComparisonSource` and never receives a repository: the page cannot reach a
 * matter. Every function calls `requireGlobalRole(principal, "evaluation.read")` first, as the
 * matter services call `requireRole`, so the service is never more permissive than the route.
 *
 * The fixed words of the page (the banners of a scripted run, the labels of the decision rule, the
 * names of the ways a slot can fail) live in `evaluations/words.ts`, which a page may not import.
 * They travel inside the views as `labels`, filled here, so the page reads only the view. The
 * pages reach these types only through `services/views.ts`.
 */

export interface EvaluationQuery {
  /** The id of the comparison; anything that is not shaped like one is not found. */
  id: string;
  /** `dev` or `heldout`. Anything else selects the first section of the document. */
  split?: string | undefined;
  /** With `ruleKey`, the changed slot whose trail is shown. */
  caseKey?: string | undefined;
  ruleKey?: string | undefined;
}

/** The words of the page that the application owns and the file does not. */
export interface EvaluationLabels {
  /** A run's mode as a short word: capitals for a scripted or replayed run. */
  mode: Record<RunMode, string>;
  decision: Record<DecisionOutcome, string>;
  gateOutcome: Record<GateOutcome, string>;
  changeKind: Record<ChangeKind, string>;
  failure: Record<FailureKind, string>;
  whyNot: Record<"not_recorded" | "case_changed", string>;
  /** A file that cannot be used, in a few words. */
  problem: Record<PageProblem, string>;
  /** Where the answers of a run are, by its mode. */
  answers: Record<RunMode, string>;
  notARecommendation: string;
  notClean: string;
  heldoutOpened: string;
  trailNotShown: string;
}

function labels(): EvaluationLabels {
  return {
    mode: { ...MODE_LABEL },
    decision: { ...DECISION_LABEL },
    gateOutcome: { ...GATE_OUTCOME_LABEL },
    changeKind: { ...CHANGE_KIND_LABEL },
    failure: { ...FAILURE_LABEL },
    whyNot: { ...WHY_NOT_LABEL },
    problem: { ...PROBLEM_LABEL },
    answers: { ...ANSWERS_BY_MODE },
    notARecommendation: NOT_A_RECOMMENDATION,
    notClean: NOT_CLEAN,
    heldoutOpened: HELDOUT_OPENED,
    trailNotShown: TRAIL_NOT_SHOWN,
  };
}

/** The capital sentence of a scripted or replayed mode, with the mode it is for. */
export interface ModeWarning {
  mode: "selftest" | "simulated" | "replay";
  text: string;
}

function warningsOf(...modes: RunMode[]): ModeWarning[] {
  return scriptedModesIn(modes).map((mode) => ({ mode, text: MODE_WORDS[mode] }));
}

export interface SideLine {
  workflowLabel: string;
  mode: RunMode;
}

/** Counted from the candidate's 14 gates: pass + fail + notEvaluated = 14. */
export interface GateCounts {
  pass: number;
  fail: number;
  notEvaluated: number;
}

export type EvaluationListEntry =
  | {
      ok: true;
      id: string;
      publishedAt: string;
      baseline: SideLine;
      candidate: SideLine;
      /** One capital sentence for each distinct scripted or replayed mode of the two runs. */
      warnings: ModeWarning[];
      sections: { split: SplitName; candidateGates: GateCounts | null }[];
    }
  | { ok: false; name: string; problem: PageProblem; action: string };

export interface EvaluationListView {
  entries: EvaluationListEntry[];
  truncated: boolean;
  labels: EvaluationLabels;
}

/** A passage of a case document, keyed in `passages` by `${doc}:${paragraph}`. */
export type PassageKey = `${string}:${number}`;
export const passageKey = (doc: string, paragraph: number): PassageKey => `${doc}:${paragraph}`;

export interface SelectedSlot {
  change: ChangeView;
  /** The case's passages, by `${doc}:${paragraph}`. Empty when the change is sealed. */
  passages: ReadonlyMap<string, PassageView>;
  documents: ComparisonPage["cases"][string]["documents"];
}

export interface ComparisonView {
  page: ComparisonPage;
  publishedAt: string;
  /** One capital sentence for each distinct scripted or replayed mode of the two runs. */
  warnings: ModeWarning[];
  /** The section shown: the one asked for, else the first. */
  split: SplitName;
  section: SectionView;
  /** The chosen slot; `missing` when the query named one that is not a change of this section. */
  selected: SelectedSlot | { missing: true } | null;
  /** The draft promotion record for the shown split. Text only. */
  draft: string;
  labels: EvaluationLabels;
}

export interface EvaluationService {
  list(principal: Principal): EvaluationListView;
  /** Throws `NotFoundError("evaluation comparison")` for an id that is malformed, unknown or unreadable. */
  comparison(principal: Principal, query: EvaluationQuery): ComparisonView;
}

function countGates(gates: readonly GateView[] | null): GateCounts | null {
  if (gates === null) return null;
  const counts: GateCounts = { pass: 0, fail: 0, notEvaluated: 0 };
  for (const gate of gates) {
    if (gate.outcome === "pass") counts.pass += 1;
    else if (gate.outcome === "fail") counts.fail += 1;
    else counts.notEvaluated += 1;
  }
  return counts;
}

/** Builds the service over a source. It reads nothing until a function is called. */
export function createEvaluationService(source: ComparisonSource): EvaluationService {
  return {
    list(principal) {
      requireGlobalRole(principal, "evaluation.read");
      const { entries, truncated } = source.list();
      return {
        entries: entries.map((entry): EvaluationListEntry => {
          if (!entry.ok)
            return {
              ok: false,
              name: entry.name,
              problem: entry.problem,
              action: PROBLEM_ACTION[entry.problem],
            };
          const { baseline, candidate } = entry.page.sides;
          return {
            ok: true,
            id: entry.id,
            publishedAt: entry.publishedAt,
            baseline: { workflowLabel: baseline.workflow.label, mode: baseline.mode },
            candidate: { workflowLabel: candidate.workflow.label, mode: candidate.mode },
            warnings: warningsOf(baseline.mode, candidate.mode),
            sections: entry.page.sections.map((section) => ({
              split: section.split,
              candidateGates: countGates(section.gates.candidate),
            })),
          };
        }),
        truncated,
        labels: labels(),
      };
    },

    comparison(principal, query) {
      requireGlobalRole(principal, "evaluation.read");
      const found = source.get(query.id);
      if (found === null) throw new NotFoundError("evaluation comparison");
      const { page, publishedAt } = found;
      // A split the document does not hold is not an error: the first section is shown.
      const section = page.sections.find((s) => s.split === query.split) ?? page.sections[0];
      if (section === undefined) throw new NotFoundError("evaluation comparison");
      return {
        page,
        publishedAt,
        warnings: warningsOf(page.sides.baseline.mode, page.sides.candidate.mode),
        split: section.split,
        section,
        selected: select(page, section, query),
        draft: draftPromotionRecord(page, section.split),
        labels: labels(),
      };
    },
  };
}

/** The slot a query names, if it is one of the changes of the section. Nothing from the query is kept. */
function select(
  page: ComparisonPage,
  section: SectionView,
  query: EvaluationQuery,
): ComparisonView["selected"] {
  if (query.caseKey === undefined && query.ruleKey === undefined) return null;
  const change = section.changes.find(
    (c) => c.caseKey === query.caseKey && c.ruleKey === query.ruleKey,
  );
  if (change === undefined) return { missing: true };
  const sealed = "sealed" in change.trail;
  const view = sealed ? undefined : page.cases[change.caseKey];
  return {
    change,
    passages: new Map(
      (view?.passages ?? []).map((p) => [passageKey(p.doc, p.paragraph), p] as const),
    ),
    documents: view?.documents ?? [],
  };
}
