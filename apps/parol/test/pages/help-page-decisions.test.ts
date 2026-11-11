import { describe, expect, it } from "vitest";
import { REVIEW_DECISIONS, type ReviewDecision } from "../../src/contracts.js";
import { DECISION_HINT, DECISION_LABEL, DECISION_VERB } from "../../src/server/views/labels.js";
import {
  contextHelp,
  helpGroups,
  wordsInRun,
  type HelpGroup,
} from "../../src/server/views/help.js";
import { QUICKSTART_STEPS } from "../../src/training/quickstart.js";
import { TRAINING_STEPS } from "../../src/training/steps.js";
import { ValidationError } from "../../src/store/index.js";
import { ACTORS, makeWorld, reviewable } from "../store/fixtures.js";
import { all, byId, parseHtml, readable, type El } from "./html.js";
import { checkInvariants } from "./invariants.js";
import { paneOnly } from "./render.js";
import { buildFindingView, buildIssueRows } from "./support.js";
import { helpHtml } from "./training-support.js";

/**
 * What the words about a decision say, against what a decision needs. The help page, the quickstart,
 * the steps of the exercise and the decision form each say whether a decision needs a reason and a
 * reason code. The truth is what the store refuses (`reason_required`, `reason_code_required`), so
 * this file asks the store, decision by decision, and compares every sentence with the answer. A
 * sentence cannot drift from the rule, and a rule that changes fails here until the words follow.
 */

interface Needs {
  reason: boolean;
  reasonCode: boolean;
}

/** What the store requires of each decision, found by deciding and reading the refusal. */
function whatTheStoreRequires(): Record<ReviewDecision, Needs> {
  const w = makeWorld();
  const { m, findings } = reviewable(w);
  const finding = findings[1]!;
  /** The code of the refusal, or undefined when the decision was recorded. */
  const attempt = (over: Record<string, unknown>): string | undefined => {
    try {
      w.repo.recordReview(m.id, finding.id, {
        reviewerId: ACTORS.reviewer,
        findingContentSha256: finding.contentSha256,
        ...over,
      } as never);
    } catch (error) {
      return (error as ValidationError).code;
    }
    return undefined;
  };
  const table = {} as Record<ReviewDecision, Needs>;
  for (const decision of REVIEW_DECISIONS) {
    const edits = decision === "edit" ? { edits: { discrepancy: "x" } } : {};
    table[decision] = {
      // The reason is checked first, so a decision with no reason shows whether it needs one.
      reason: attempt({ decision, ...edits }) === "reason_required",
      // With a reason, the next thing the store asks of an edit and a reject is the code.
      reasonCode: attempt({ decision, reason: "r", ...edits }) === "reason_code_required",
    };
  }
  return table;
}

const NEEDS = whatTheStoreRequires();
const needing = (key: keyof Needs): ReviewDecision[] =>
  REVIEW_DECISIONS.filter((decision) => NEEDS[decision][key]);

/** "a", "a and b", "a, b and c". */
const listed = (words: readonly string[]): string =>
  words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

const saysReason = (text: string): boolean => /\breason\b/i.test(text);
const saysReasonCode = (text: string): boolean => /\breason code\b/i.test(text);

/** The sentence says a reason is needed exactly when the store needs one, and a code likewise. */
function expectAgrees(text: string, decision: ReviewDecision, where: string): void {
  expect(saysReason(text), `${where}: ${decision} and the reason, in "${text}"`).toBe(
    NEEDS[decision].reason,
  );
  expect(saysReasonCode(text), `${where}: ${decision} and the reason code, in "${text}"`).toBe(
    NEEDS[decision].reasonCode,
  );
}

describe("what the store requires of a decision", () => {
  it("is read from the store: an accept needs nothing, an escalate a reason, an edit and a reject a reason and a code", () => {
    // A fixed answer, so that a probe which saw nothing could not make every comparison below pass.
    expect(NEEDS).toEqual({
      accept: { reason: false, reasonCode: false },
      edit: { reason: true, reasonCode: true },
      reject: { reason: true, reasonCode: true },
      escalate: { reason: true, reasonCode: false },
    });
  });
});

describe("the help page and the decision form say what the store requires", () => {
  const root = checkInvariants(helpHtml());
  const meaningAt = (id: string): string => {
    const dt = byId(root, id);
    if (dt === undefined) throw new Error(`the help page has no anchor ${id}`);
    const parent = all(root, (el) => el.children.includes(dt))[0] as El;
    const dd = parent.children[parent.children.indexOf(dt) + 1] as El;
    return readable(dd);
  };

  for (const decision of REVIEW_DECISIONS)
    it(`${decision}: the decision form's hint and the help page's sentence`, () => {
      expectAgrees(DECISION_HINT[decision], decision, "the decision form");
      expectAgrees(meaningAt(`decision-${decision}`), decision, "the help page");
    });

  it("gives the edit the form's own sentence, less the pointer to the fields below it", () => {
    expect(meaningAt("decision-edit")).toBe(
      DECISION_HINT.edit.replace(" Use the fields below.", ""),
    );
  });

  it("says nothing about a reason anywhere else in the words of help, which the checks above do not cover", () => {
    const finding = buildFindingView();
    const surfaces: HelpGroup[] = [
      ...helpGroups(),
      ...wordsInRun(buildIssueRows()),
      ...contextHelp(finding),
    ];
    const terms = surfaces.flatMap((group) => group.terms);
    expect(terms.length).toBeGreaterThan(40);
    for (const term of terms)
      if (!term.id.startsWith("decision-"))
        expect(saysReason(term.meaning), `${term.id}: ${term.meaning}`).toBe(false);
    for (const group of surfaces) expect(saysReason(group.intro ?? ""), group.id).toBe(false);
    // The words of the decisions that help does have are the four, all checked above.
    expect(
      helpGroups()
        .find((g) => g.id === "decisions")!
        .terms.map((t) => t.term),
    ).toEqual([
      ...REVIEW_DECISIONS.map((decision) => DECISION_LABEL[decision]),
      "Not decided",
      "Out of date",
    ]);
  });

  it("says in the fields of the decision form which decisions need a reason and which a code", () => {
    const pane = parseHtml(paneOnly());
    const verbs = (decisions: readonly ReviewDecision[]): string[] =>
      decisions.map((d) => DECISION_VERB[d].toLowerCase());
    expect(readable(byId(pane, "decision-reason-hint") as El)).toContain(
      `Required for ${listed(verbs(needing("reason")))}.`,
    );
    expect(readable(byId(pane, "decision-reason-code-hint") as El)).toContain(
      `Required for ${listed(verbs(needing("reasonCode")))}.`,
    );
  });
});

describe("the quickstart and the exercise say what the store requires", () => {
  const noun: Record<ReviewDecision, string> = {
    accept: "accepts",
    edit: "edits",
    reject: "rejections",
    escalate: "escalations",
  };
  const nouns = (decisions: readonly ReviewDecision[]): string =>
    listed(decisions.map((decision) => noun[decision]));

  it("step 8 of the quickstart names the decisions that need a reason and those that need a code", () => {
    const text = QUICKSTART_STEPS.find((step) => step.n === 8)!.text;
    const reasons = nouns(needing("reason"));
    const expected = `${reasons[0]!.toUpperCase()}${reasons.slice(1)} need a reason, and ${nouns(needing("reasonCode"))} need a reason code.`;
    expect(text).toContain(expected);
  });

  it("the steps of the exercise ask for a reject and an escalate as the store takes them", () => {
    const task = (n: number): string => TRAINING_STEPS.find((step) => step.n === n)!.task;
    const asked = (decision: ReviewDecision): string =>
      `with a reason${NEEDS[decision].reasonCode ? " and a reason code" : ""}`;
    // Step 4 and step 7 reject, step 5 escalates.
    expect(task(4)).toContain(`reject it ${asked("reject")}`);
    expect(task(5)).toContain(asked("escalate"));
    expect(saysReasonCode(task(5))).toBe(NEEDS.escalate.reasonCode);
    expect(task(7)).toContain(`reject the planted one ${asked("reject")}`);
  });
});
