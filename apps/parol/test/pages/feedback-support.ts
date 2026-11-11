import type { ReasonCode } from "../../src/contracts.js";
import { FindingPage, FindingPane, render } from "../../src/server/pages/index.js";
import type { DecisionDraft } from "../../src/server/pages/finding.js";
import { refusalOf } from "../../src/server/routes/notices.js";
import type { FindingView, ReviewHistoryItem } from "../../src/services/views.js";
import { ValidationError } from "../../src/store/index.js";
import { IDS, buildChrome, buildDecidedFinding, buildFindingView } from "./support.js";

/**
 * Fixtures of the reason code and the minor-edit mark on a decision (package W2.6a, slice A), in
 * each state that changes what the finding pane shows: the decision form with and without what was
 * typed, the history of a decision that carries a code and a mark, and the finding page that
 * answers a refused decision. `test/pages/support.ts` is not edited by this package, so the finding
 * is built from its builders with the optional fields set. Everything here is synthetic.
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
