import { describe, expect, it } from "vitest";
import { REASON_CODES } from "../../src/contracts.js";
import { FIELDS, MINOR_EDIT_VALUE, NOT_COVERED_VALUE } from "../../src/server/pages/forms.js";
import { urls } from "../../src/server/urls.js";
import {
  NOTE_BUTTON,
  NOTE_CANNOT_ADD,
  NOTE_HINT,
  NOTE_LABEL,
  NOTES_EMPTY,
  NOTES_HEADING,
  NOTES_INTRO,
  NOTES_JUMP,
  noteCountLabel,
  MINOR_EDIT_HINT,
  MINOR_EDIT_LABEL,
  MINOR_EDIT_MARKED,
  MISSED_ISSUE_BUTTON,
  MISSED_ISSUE_EMPTY,
  MISSED_ISSUE_HEADING,
  MISSED_ISSUE_INTRO,
  MISSED_ISSUE_LIST_HEADING,
  MISSED_ISSUE_LOCATION_HINT,
  MISSED_ISSUE_NO_FINDINGS,
  NOT_COVERED_LABEL,
  RATING_BUTTON,
  RATING_COMMENT_LABEL,
  RATING_FORM_HINT,
  RATING_HEADING,
  RATING_LABEL,
  RATING_MISSED_ISSUE_LINK,
  RATING_NO_MEMO,
  RATING_QUESTION,
  REASON_CODE_LABEL,
  REASON_CODE_MEANING,
  ratingChoiceLabel,
  ratingLabel,
  reasonCodeLabel,
  ruleChoiceLabel,
} from "../../src/server/views/feedback.js";
import { REFUSAL_PHRASES } from "../../src/server/routes/notices.js";
import { CANNOT_ADD_NOTE } from "../../src/services/phrases.js";
import { expectAccessible, tabStops } from "../a11y/rules.js";
import {
  RULE_CHOICES,
  decision,
  decidedWith,
  decisionPane,
  editWith,
  expectAccessibleExceptTheMemoList,
  feedbackProps,
  memosPageWith,
  noteOf,
  notesPane,
  paneOf,
  ratingGiven,
  ratingProps,
  ratingSectionOf,
  refusedFindingPage,
  refusedMemosPage,
  refusedNotePage,
  refusedRunPage,
  report,
  runPageWith,
  runPageWithNotes,
} from "./feedback-support.js";
import { checkInvariants } from "./invariants.js";
import {
  all,
  ancestorsOf,
  attr,
  byId,
  first,
  hasAttr,
  hasClass,
  readable,
  withClass,
  type El,
} from "./html.js";
import { IDS, buildFindingView, buildIssueRows, buildRunSummary } from "./support.js";
import { VARIANTS_FEEDBACK } from "./variants-feedback.js";

/**
 * The reason code and the minor-edit mark on the finding pane (package W2.6a, slice A): the two
 * controls of the decision form, what the history says of a decision that carries them, and the
 * page that answers a refused decision.
 *
 * Slice B: the section of the review page that reports a missed issue, in each state it has, and
 * the pages that answer each refusal of a report.
 *
 * Slice C: the section of the memos page that rates the matter, in the four states it has, and the
 * pages that answer each refusal of a rating.
 *
 * Slice D: the notes on a finding, a section of the finding pane (on the finding's own page and in
 * the inspector of the review page), in each state it has, the count of notes in the issue table,
 * and the page that answers each refusal of a note.
 */

const DASH = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");

const form = (root: El): El =>
  first(root, (el) => el.name === "form" && hasAttr(el, "data-decision-form"));
const control = (root: El, name: string): El =>
  first(
    root,
    (el) => ["input", "select", "textarea"].includes(el.name) && attr(el, "name") === name,
  );
const labelOf = (root: El, id: string): El =>
  first(root, (el) => el.name === "label" && attr(el, "for") === id, `label for ${id}`);

describe("the decision form, reason code", () => {
  const pane = checkInvariants(decisionPane(), { fragment: true });

  it("is a labelled list with a placeholder first and the six codes in order, each with its label", () => {
    const select = control(pane, FIELDS.reasonCode);
    expect(select.name).toBe("select");
    expect(attr(select, "id")).toBe("decision-reason-code");
    expect(readable(labelOf(pane, "decision-reason-code"))).toBe("Reason code");
    const options = all(select, (el) => el.name === "option");
    expect(options.map((o) => attr(o, "value"))).toEqual(["", ...REASON_CODES]);
    expect(options.map(readable)).toEqual([
      "Choose a reason code",
      ...REASON_CODES.map((code) => REASON_CODE_LABEL[code]),
    ]);
    // Nothing is chosen until the reviewer chooses, and the control is not `required`: an accept and
    // an escalate carry no code, so the server is the one that says an edit or a reject needs it.
    expect(options.filter((o) => hasAttr(o, "selected")).map((o) => attr(o, "value"))).toEqual([
      "",
    ]);
    expect(hasAttr(select, "required")).toBe(false);
  });

  it("sits after the reason and before the edits, in the decision form", () => {
    const names = all(
      form(pane),
      (el) => ["input", "select", "textarea"].includes(el.name) && attr(el, "type") !== "hidden",
    )
      .map((el) => attr(el, "name"))
      .filter((name, i, list) => list.indexOf(name) === i);
    expect(names.slice(0, 4)).toEqual([
      FIELDS.decision,
      FIELDS.reason,
      FIELDS.reasonCode,
      FIELDS.status,
    ]);
    expect(names.at(-1)).toBe(FIELDS.minorEdit);
  });

  it("says when it is needed in a hint that the list is tied to", () => {
    const select = control(pane, FIELDS.reasonCode);
    const hint = byId(pane, attr(select, "aria-describedby") ?? "");
    expect(hint).toBeDefined();
    expect(readable(hint!)).toBe(
      "Required for edit and reject. Leave it unchosen for accept and escalate.",
    );
    expect(hasClass(hint!, "hint")).toBe(true);
  });

  it("explains every code in a disclosure, as a list of terms and meanings, closed until opened", () => {
    const details = first(form(pane), (el) => el.name === "details");
    expect(hasAttr(details, "open")).toBe(false);
    expect(readable(first(details, (el) => el.name === "summary"))).toBe(
      "What the reason codes mean",
    );
    const terms = all(details, (el) => el.name === "dt").map(readable);
    const meanings = all(details, (el) => el.name === "dd").map(readable);
    expect(terms).toEqual(REASON_CODES.map((code) => REASON_CODE_LABEL[code]));
    expect(meanings).toEqual(REASON_CODES.map((code) => REASON_CODE_MEANING[code]));
    // The words are plain sentences with no dash and no markup.
    for (const text of [...terms, ...meanings]) {
      expect(text).toMatch(/^[A-Z][^<>]*$/);
      expect(text).not.toMatch(DASH);
    }
  });

  it("shows the chosen code again after a refusal, and only a code that exists", () => {
    const again = checkInvariants(decisionPane({ decision: "edit", reasonCode: "bad_fallback" }), {
      fragment: true,
    });
    const chosen = all(
      control(again, FIELDS.reasonCode),
      (el) => el.name === "option" && hasAttr(el, "selected"),
    );
    expect(chosen.map((o) => attr(o, "value"))).toEqual(["bad_fallback"]);
    // A value the type does not allow is not offered as a choice: nothing is selected then.
    const hostile = checkInvariants(decisionPane({ reasonCode: "ZQ<script>" as never }), {
      fragment: true,
    });
    expect(
      all(
        control(hostile, FIELDS.reasonCode),
        (el) => el.name === "option" && hasAttr(el, "selected"),
      ),
    ).toEqual([]);
    expect(readable(hostile)).not.toContain("ZQ");
  });
});

describe("the decision form, minor edit", () => {
  const pane = checkInvariants(decisionPane(), { fragment: true });

  it("is one checkbox with a label, inside the Edits fieldset, after everything else there", () => {
    const box = control(pane, FIELDS.minorEdit);
    expect(attr(box, "type")).toBe("checkbox");
    expect(attr(box, "value")).toBe(MINOR_EDIT_VALUE);
    expect(attr(box, "id")).toBe("edit-minor");
    expect(readable(labelOf(pane, "edit-minor"))).toBe(MINOR_EDIT_LABEL);
    expect(hasAttr(box, "checked")).toBe(false);
    expect(hasAttr(box, "required")).toBe(false);
    const fieldset = ancestorsOf(pane, box).filter((el) => el.name === "fieldset");
    expect(fieldset.map((el) => hasClass(el, "edits"))).toContain(true);
    const edits = fieldset.find((el) => hasClass(el, "edits"))!;
    const controls = all(edits, (el) => ["input", "select", "textarea"].includes(el.name));
    expect(controls.at(-1)).toBe(box);
    expect(readable(first(edits, (el) => el.name === "legend"))).toBe(
      "Edits, used only when you choose Edit",
    );
  });

  it("is tied to a hint that says what a minor edit is and that a change of status never is", () => {
    const box = control(pane, FIELDS.minorEdit);
    const hint = byId(pane, attr(box, "aria-describedby") ?? "");
    expect(readable(hint!)).toBe(MINOR_EDIT_HINT);
    expect(MINOR_EDIT_HINT).toContain("A change of status is never minor");
    expect(MINOR_EDIT_HINT).toContain("Used only when you choose Edit");
  });

  it("is ticked again after a refusal when it was ticked", () => {
    const again = checkInvariants(decisionPane({ decision: "edit", minorEdit: true }), {
      fragment: true,
    });
    expect(hasAttr(control(again, FIELDS.minorEdit), "checked")).toBe(true);
    const never = checkInvariants(decisionPane({ decision: "edit", minorEdit: false }), {
      fragment: true,
    });
    expect(hasAttr(control(never, FIELDS.minorEdit), "checked")).toBe(false);
  });

  it("is not offered when the finding cannot be decided, with the list of codes", () => {
    const blocked = paneOf({
      ...buildFindingView(),
      canDecide: { allowed: false, reason: "Only the reviewing attorney can decide findings." },
    });
    const root = checkInvariants(blocked, { fragment: true });
    expect(all(root, (el) => attr(el, "name") === FIELDS.reasonCode)).toEqual([]);
    expect(all(root, (el) => attr(el, "name") === FIELDS.minorEdit)).toEqual([]);
  });
});

describe("the history of a decision", () => {
  const history = (html: string): El =>
    first(
      checkInvariants(html, { fragment: true }),
      (el) => el.name === "ol" && hasClass(el, "history"),
    );

  it("names the reason code of an edit and says it was marked minor", () => {
    const text = readable(history(paneOf(decidedWith([editWith("bad_fallback", true)]))));
    expect(text).toContain(`Reason code: ${REASON_CODE_LABEL.bad_fallback}`);
    expect(text).toContain(MINOR_EDIT_MARKED);
  });

  it("names the code of an edit that was not minor, and says nothing of the mark", () => {
    const text = readable(history(paneOf(decidedWith([editWith("wrong_evidence", false)]))));
    expect(text).toContain(`Reason code: ${REASON_CODE_LABEL.wrong_evidence}`);
    expect(text).not.toContain(MINOR_EDIT_MARKED);
    expect(text).not.toContain("minor");
  });

  it("names the code of a reject, and of a decision that has gone stale", () => {
    const root = history(
      paneOf(
        decidedWith([
          editWith("unclear", false, "stale"),
          decision({ decision: "reject", reasonCode: "other" }),
        ]),
      ),
    );
    // The decisions are the list's own items; an edit's list of changes has items of its own.
    const items = root.children.filter((c): c is El => c.type === "element" && c.name === "li");
    expect(
      items.map((li) => readable(li).includes(`Reason code: ${REASON_CODE_LABEL.unclear}`)),
    ).toEqual([true, false]);
    expect(readable(items[1]!)).toContain(`Reason code: ${REASON_CODE_LABEL.other}`);
    expect(hasClass(items[0]!, "is-stale")).toBe(true);
  });

  it("says nothing of a code on a decision made before the code existed, or on an accept", () => {
    const old = readable(history(paneOf(decidedWith([editWith(null, null)]))));
    expect(old).not.toContain("Reason code");
    expect(old).not.toContain(MINOR_EDIT_MARKED);
    // The same for a history item built without the fields at all, as the older fixtures are.
    const { reasonCode: _code, minorEdit: _mark, ...without } = decision({ decision: "accept" });
    expect("reasonCode" in without || "minorEdit" in without).toBe(false);
    const bare = readable(history(paneOf(decidedWith([without]))));
    expect(bare).not.toContain("Reason code");
  });

  it("puts the words of the code and the mark under the reason, as plain text", () => {
    const root = history(paneOf(decidedWith([editWith("missed_context", true)])));
    const lines = withClass(root, "muted").map(readable);
    expect(lines.some((line) => line === `Reason code: ${REASON_CODE_LABEL.missed_context}`)).toBe(
      true,
    );
    expect(lines).toContain(MINOR_EDIT_MARKED);
  });

  it("gives a fixed phrase to a code this version does not know, and never the code", () => {
    const text = readable(
      history(
        paneOf(decidedWith([{ ...editWith("other", false), reasonCode: "ZQ-<b>x</b>" as never }])),
      ),
    );
    expect(text).toContain(`Reason code: ${reasonCodeLabel("ZQ-<b>x</b>")}`);
    expect(text).not.toContain("ZQ-");
    expect(reasonCodeLabel("constructor")).not.toContain("function");
    expect(reasonCodeLabel("__proto__")).toBe(reasonCodeLabel("nothing"));
  });
});

describe("the page that answers a refused decision", () => {
  it("shows the words, the todo marked inside them, and a link to the control to mend", () => {
    for (const [code, target] of [
      ["reason_code_required", "decision-reason-code"],
      ["bad_reason_code", "decision-reason-code"],
      ["reason_code_not_allowed", "decision-reason-code"],
      ["minor_edit_status", "edit-minor"],
      ["minor_edit_not_allowed", "edit-minor"],
    ] as const) {
      const root = expectAccessible(refusedFindingPage(code, { decision: "edit", reason: "r" }));
      const alert = first(root, (el) => attr(el, "role") === "alert");
      expect(withClass(alert, "todo")).toHaveLength(1);
      const link = first(alert, (el) => el.name === "a" && hasClass(el, "notice-jump"));
      expect(attr(link, "href"), code).toBe(`#${target}`);
      expect(byId(root, target), `${code} leads to ${target}`).toBeDefined();
    }
  });

  it("keeps what was typed in the form beside the refusal", () => {
    const root = checkInvariants(
      refusedFindingPage("reason_code_required", {
        decision: "reject",
        reason: "Not what it says.",
      }),
    );
    expect(
      all(root, (el) => attr(el, "name") === FIELDS.decision && hasAttr(el, "checked")).map((el) =>
        attr(el, "value"),
      ),
    ).toEqual(["reject"]);
    expect(readable(control(root, FIELDS.reason))).toBe("Not what it says.");
  });
});

describe("the fixtures of the pane", () => {
  it("are all in the composed list, each a well-formed pane or page that passes the accessibility rules", () => {
    expect(VARIANTS_FEEDBACK.length).toBeGreaterThanOrEqual(8);
    const titles = VARIANTS_FEEDBACK.map(([title]) => title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const [title, make, options] of VARIANTS_FEEDBACK) {
      checkInvariants(make(), options);
      // The memos page has one problem of its own that is not this package's (see
      // `isKnownProblemOfTheMemoList`); the section of the rating is audited alone as well.
      expect(
        () =>
          expectAccessibleExceptTheMemoList(
            make(),
            options?.fragment === true ? { fragment: true } : {},
          ),
        title,
      ).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Slice B: the report of a missed issue on the review page
// ---------------------------------------------------------------------------------------------

const missedForm = (root: El): El =>
  first(
    byId(root, "missed-issue")!,
    (el) => el.name === "form" && attr(el, "action") === urls.missedIssues(IDS.matter, IDS.run),
    "the report form",
  );
const missedSection = (root: El): El => byId(root, "missed-issue")!;
const selectedValues = (select: El): (string | null | undefined)[] =>
  all(select, (el) => el.name === "option" && hasAttr(el, "selected")).map((o) => attr(o, "value"));

describe("the report of a missed issue, the form", () => {
  const page = expectAccessible(runPageWith(feedbackProps()));

  it("is a section of the review page with its own heading, after the table and the inspector", () => {
    const section = missedSection(page);
    expect(section.name).toBe("section");
    expect(attr(section, "aria-labelledby")).toBe("missed-issue-heading");
    expect(readable(first(section, (el) => el.name === "h2"))).toBe(MISSED_ISSUE_HEADING);
    // After the layout that holds the table and the inspector, so a person who reads down meets it last.
    const layout = first(page, (el) => hasClass(el, "run-layout"));
    const order = all(page, (el) => el === layout || el === section);
    expect(order).toEqual([layout, section]);
    expect(readable(section)).toContain(MISSED_ISSUE_INTRO);
    expect(MISSED_ISSUE_INTRO).toContain("does not change any finding or decision");
  });

  it("posts to the review's own address with the token, and nowhere else", () => {
    const form = missedForm(page);
    expect(attr(form, "method")).toBe("post");
    const token = first(form, (el) => el.name === "input" && attr(el, "name") === "_csrf");
    expect(attr(token, "type")).toBe("hidden");
    expect(attr(token, "value")).toBeTruthy();
    // Nothing in the form names a person, a matter or a review: the route takes all three from the path.
    const names = all(form, (el) => ["input", "select", "textarea"].includes(el.name)).map((el) =>
      attr(el, "name"),
    );
    expect(names).toEqual(["_csrf", FIELDS.ruleKey, FIELDS.location, FIELDS.note]);
  });

  it("has a labelled rule list that starts at a placeholder, holds every rule in the playbook's order and ends with Not covered", () => {
    const select = first(missedForm(page), (el) => el.name === "select");
    expect(attr(select, "name")).toBe(FIELDS.ruleKey);
    expect(attr(select, "id")).toBe("missed-issue-rule");
    expect(hasAttr(select, "required")).toBe(true);
    expect(
      readable(first(page, (el) => el.name === "label" && attr(el, "for") === "missed-issue-rule")),
    ).toBe("Rule");
    const options = all(select, (el) => el.name === "option");
    expect(options.map((o) => attr(o, "value"))).toEqual([
      "",
      ...RULE_CHOICES.map((r) => r.ruleKey),
      NOT_COVERED_VALUE,
    ]);
    expect(options.map(readable)).toEqual([
      "Choose a rule",
      ...RULE_CHOICES.map((r) => ruleChoiceLabel(r.ruleKey, r.title)),
      NOT_COVERED_LABEL,
    ]);
    // The playbook's order, which is not the alphabet's.
    expect(RULE_CHOICES.map((r) => r.ruleKey)).not.toEqual(
      RULE_CHOICES.map((r) => r.ruleKey).sort(),
    );
    expect(selectedValues(select)).toEqual([""]);
    // The hint is tied to the list.
    const hint = byId(page, attr(select, "aria-describedby") ?? "");
    expect(hasClass(hint!, "hint")).toBe(true);
  });

  it("has a labelled place and a labelled note, the note required and limited, and a button that is not disabled", () => {
    const form = missedForm(page);
    const place = control(form, FIELDS.location);
    expect(attr(place, "type")).toBe("text");
    expect(attr(place, "maxlength")).toBe("200");
    expect(hasAttr(place, "required")).toBe(false);
    expect(
      readable(
        first(page, (el) => el.name === "label" && attr(el, "for") === "missed-issue-location"),
      ),
    ).toBe("Location");
    expect(readable(byId(page, attr(place, "aria-describedby") ?? "")!)).toBe(
      MISSED_ISSUE_LOCATION_HINT,
    );
    const note = control(form, FIELDS.note);
    expect(note.name).toBe("textarea");
    expect(attr(note, "maxlength")).toBe("4000");
    expect(hasAttr(note, "required")).toBe(true);
    expect(
      readable(first(page, (el) => el.name === "label" && attr(el, "for") === "missed-issue-note")),
    ).toBe("Note");
    const button = first(form, (el) => el.name === "button");
    expect(attr(button, "type")).toBe("submit");
    expect(readable(button)).toBe(MISSED_ISSUE_BUTTON);
    expect(hasAttr(button, "disabled")).toBe(false);
  });

  it("says that nobody has reported yet, and has no table, until somebody has", () => {
    const section = missedSection(page);
    expect(readable(first(section, (el) => el.name === "h3"))).toBe(MISSED_ISSUE_LIST_HEADING);
    expect(readable(first(section, (el) => hasClass(el, "empty")))).toBe(MISSED_ISSUE_EMPTY);
    expect(all(section, (el) => el.name === "table")).toEqual([]);
  });

  it("is not there on a page made without it, and not while the review is running", () => {
    const none = expectAccessible(runPageWith(null));
    expect(byId(none, "missed-issue")).toBeUndefined();
    expect(all(none, (el) => attr(el, "href") === "#missed-issue")).toEqual([]);
    const running = expectAccessible(
      runPageWith(feedbackProps(), {
        run: buildRunSummary({
          status: "analyzing",
          current: true,
          finishedAt: null,
          progress: null,
        }),
      }),
    );
    expect(byId(running, "missed-issue")).toBeUndefined();
    expect(all(running, (el) => attr(el, "href") === "#missed-issue")).toEqual([]);
  });

  it("is there on a review that is out of date, which its reports are still true of", () => {
    const stale = expectAccessible(
      runPageWith(feedbackProps({ items: [report()] }), {
        run: buildRunSummary({ current: false }),
      }),
    );
    expect(all(missedSection(stale), (el) => el.name === "form")).toHaveLength(1);
    expect(all(missedSection(stale), (el) => el.name === "tr")).toHaveLength(2);
  });

  it("has a link at the top of the page that leads to it, among the other links that skip ahead", () => {
    const jumps = withClass(page, "jump").map(readable);
    expect(jumps).toEqual(["Go to the evidence inspector", "Report a missed issue"]);
    const link = first(
      page,
      (el) => el.name === "a" && attr(el, "href") === "#missed-issue",
      "the link to the report",
    );
    expect(byId(page, "missed-issue")).toBeDefined();
    // It comes before the table, so a person who skips ahead meets it before the rows.
    const order = all(page, (el) => el === link || hasClass(el, "run-layout"));
    expect(order[0]).toBe(link);
  });
});

describe("the report of a missed issue, the list of reports", () => {
  const items = [
    report(),
    report({
      feedbackId: "fbk_2",
      ruleKey: null,
      ruleTitle: null,
      location: null,
      note: "No rule covers a non-solicitation clause.\nIt is in Section 11.",
      reporterName: "A. Ruiz",
      at: "2026-11-04T08:00:00Z",
    }),
    report({ feedbackId: "fbk_3", ruleKey: "gov-1", ruleTitle: null, reporterName: "R. Okoye" }),
  ];
  const page = expectAccessible(runPageWith(feedbackProps({ items })));

  it("is a table with a caption and scoped headers, inside a box that scrolls and has a name", () => {
    const section = missedSection(page);
    const region = first(section, (el) => attr(el, "role") === "region");
    expect(attr(region, "aria-label")).toBe(MISSED_ISSUE_LIST_HEADING);
    expect(attr(region, "tabindex")).toBe("0");
    const table = first(region, (el) => el.name === "table");
    expect(readable(first(table, (el) => el.name === "caption"))).toBe(MISSED_ISSUE_LIST_HEADING);
    const headers = all(table, (el) => el.name === "th");
    expect(headers.map(readable)).toEqual(["Rule", "Location", "Note", "Reported by", "Time"]);
    expect(headers.every((th) => attr(th, "scope") === "col")).toBe(true);
    // No empty sentence once there is a report.
    expect(all(section, (el) => hasClass(el, "empty"))).toEqual([]);
  });

  it("keeps the order the reports were made in, and names the rule with its title, or says not covered, or shows the key alone", () => {
    const rows = all(missedSection(page), (el) => el.name === "tr")
      .filter((tr) => all(tr, (el) => el.name === "td").length > 0)
      .map((tr) => all(tr, (el) => el.name === "td").map(readable));
    expect(rows).toHaveLength(3);
    expect(rows[0]![0]).toBe("dur-1 Duration of confidentiality obligations");
    expect(rows[1]![0]).toBe(NOT_COVERED_LABEL);
    // A key whose title the playbook no longer gives is shown by its key alone.
    expect(rows[2]![0]).toBe("gov-1");
    expect(rows.map((r) => r[3])).toEqual(["D. Whitfield", "A. Ruiz", "R. Okoye"]);
    expect(rows[0]![1]).toBe("Amendment No. 1, paragraph 2");
    expect(rows[1]![1]).toBe("Not given");
  });

  it("shows the note as text that keeps its line breaks, in a quotation box, with the time as a time", () => {
    const cells = all(missedSection(page), (el) => el.name === "td");
    const note = cells.find((td) => readable(td).startsWith("No rule covers"))!;
    expect(
      hasClass(
        first(note, (el) => el.name === "div"),
        "doc-text",
      ),
    ).toBe(true);
    expect(first(note, (el) => hasClass(el, "doc-text")).children.length).toBeGreaterThan(0);
    const times = all(missedSection(page), (el) => el.name === "time");
    expect(times.map((t) => attr(t, "datetime"))).toEqual([
      "2026-11-03T15:30:00Z",
      "2026-11-04T08:00:00Z",
      "2026-11-03T15:30:00Z",
    ]);
  });

  it("escapes what a person typed and makes the invisible characters visible", () => {
    const hostile = runPageWith(
      feedbackProps({
        items: [
          report({
            ruleTitle: "<script>window.pwned = 1</script>",
            location: '"><img src=x onerror="window.pwned=1">',
            note: "pay \u202e1000\u202c now, con\u200bfi\u200ddential",
            reporterName: "<b>Mallory</b>",
          }),
        ],
      }),
    );
    const root = expectAccessible(hostile);
    expect(hostile).not.toContain("<script>window");
    expect(hostile).not.toContain("<img src=x");
    expect(hostile).not.toContain("<b>Mallory");
    expect(hostile).not.toMatch(/[\u202e\u202c\u200b\u200d]/);
    const cells = all(missedSection(root), (el) => el.name === "td").map(readable);
    expect(cells.some((c) => c.includes("<script>window.pwned = 1</script>"))).toBe(true);
    expect(cells.some((c) => c.includes("<b>Mallory</b>"))).toBe(true);
    expect(withClass(missedSection(root), "invisible").length).toBeGreaterThanOrEqual(4);
  });
});

describe("the report of a missed issue, after a refusal", () => {
  it("shows again what was typed: the rule, the place and the note, the note with its line breaks", () => {
    const root = expectAccessible(
      refusedRunPage("note_required", {
        ruleKey: "gov-1",
        location: "NDA, Section 9.2",
        note: "Governing law is Delaware.\nIt is not on the list.",
      }),
    );
    const form = missedForm(root);
    expect(selectedValues(control(form, FIELDS.ruleKey))).toEqual(["gov-1"]);
    expect(attr(control(form, FIELDS.location), "value")).toBe("NDA, Section 9.2");
    const note = control(form, FIELDS.note);
    const text = note.children.map((c) => (c.type === "text" ? c.text : "")).join("");
    // The textarea holds the note exactly: one line feed ahead of it, which a browser drops.
    expect(text).toBe("\nGoverning law is Delaware.\nIt is not on the list.");
  });

  it("keeps the choice 'Not covered', and starts again at the placeholder for a rule the list does not hold", () => {
    const covered = expectAccessible(
      refusedRunPage("note_required", { ruleKey: NOT_COVERED_VALUE }),
    );
    expect(selectedValues(control(missedForm(covered), FIELDS.ruleKey))).toEqual([
      NOT_COVERED_VALUE,
    ]);
    for (const ruleKey of ["not-a-rule", "", undefined, "dur-1 ", "constructor"]) {
      const root = expectAccessible(
        refusedRunPage("unknown_rule", ruleKey === undefined ? {} : { ruleKey }),
      );
      expect(selectedValues(control(missedForm(root), FIELDS.ruleKey)), String(ruleKey)).toEqual([
        "",
      ]);
    }
  });

  it("answers each refusal with its words, the sentence that says what to do marked, and a link to the control it is about", () => {
    const cases = [
      ["rule_required", "missed-issue-rule", "select"],
      ["note_required", "missed-issue-note", "textarea"],
      ["note_too_long", "missed-issue-note", "textarea"],
      ["location_too_long", "missed-issue-location", "input"],
    ] as const;
    for (const [code, target, tag] of cases) {
      const root = expectAccessible(refusedRunPage(code, { ruleKey: "dur-1", note: "A note." }));
      const alert = first(root, (el) => attr(el, "role") === "alert");
      expect(readable(alert), code).toContain(REFUSAL_PHRASES[code]);
      expect(withClass(alert, "todo"), code).toHaveLength(1);
      const link = first(alert, (el) => el.name === "a" && hasClass(el, "notice-jump"));
      expect(attr(link, "href"), code).toBe(`#${target}`);
      expect(byId(root, target)?.name, code).toBe(tag);
    }
    // The codes that no control mends say what to do and lead nowhere.
    for (const [code, kind] of [
      ["unknown_rule", "validation"],
      ["feedback_limit", "conflict"],
      ["run_has_no_findings", "conflict"],
    ] as const) {
      const root = expectAccessible(refusedRunPage(code, {}, { status: kind }));
      const alert = first(root, (el) => attr(el, "role") === "alert");
      expect(withClass(alert, "todo"), code).toHaveLength(1);
      expect(
        all(alert, (el) => hasClass(el, "notice-jump")),
        code,
      ).toEqual([]);
    }
  });
});

describe("the report of a missed issue, on a review with no findings", () => {
  const empty = () =>
    runPageWith(feedbackProps(), {
      issues: [],
      run: buildRunSummary({ status: "failed", errorKind: "provider_error", findingCount: 0 }),
    });

  it("says why there is nothing to report against, in place of the form, and has no link that leads to it", () => {
    const root = expectAccessible(empty());
    const section = missedSection(root);
    expect(all(section, (el) => el.name === "form")).toEqual([]);
    expect(readable(first(section, (el) => hasClass(el, "empty")))).toBe(MISSED_ISSUE_NO_FINDINGS);
    // The sentence is the first of the phrase of the refusal that a post to such a review gets.
    expect(REFUSAL_PHRASES["run_has_no_findings"]).toContain(MISSED_ISSUE_NO_FINDINGS);
    expect(all(root, (el) => attr(el, "href") === "#missed-issue")).toEqual([]);
    expect(buildIssueRows().length).toBeGreaterThan(0);
  });

  it("still lists the reports that were made against it before", () => {
    const root = expectAccessible(
      runPageWith(feedbackProps({ items: [report()] }), {
        issues: [],
        run: buildRunSummary({ status: "cancelled", findingCount: 0 }),
      }),
    );
    expect(all(missedSection(root), (el) => el.name === "form")).toEqual([]);
    expect(all(missedSection(root), (el) => el.name === "tr")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Slice C: the rating of a matter on the memos page
// ---------------------------------------------------------------------------------------------

const ratingSection = (root: El): El => byId(root, "rating")!;
const ratingForm = (root: El): El =>
  first(
    ratingSection(root),
    (el) => el.name === "form" && attr(el, "action") === urls.rating(IDS.matter),
    "the rating form",
  );
const radios = (root: El): El[] =>
  all(ratingSection(root), (el) => el.name === "input" && attr(el, "type") === "radio");
const checkedMarks = (root: El): (string | null | undefined)[] =>
  radios(root)
    .filter((r) => hasAttr(r, "checked"))
    .map((r) => attr(r, "value"));
const memos = (html: string): El => expectAccessibleExceptTheMemoList(html);

describe("the rating of a matter, the form", () => {
  const page = memos(memosPageWith(ratingProps()));

  it("is a section of the memos page with its own heading, after the memos and the export", () => {
    const section = ratingSection(page);
    expect(section.name).toBe("section");
    expect(attr(section, "aria-labelledby")).toBe("rating-heading");
    expect(readable(first(section, (el) => el.name === "h2"))).toBe(RATING_HEADING);
    // After the list of memos and the form that exports one, so a person who reads down meets it last.
    const order = all(
      page,
      (el) =>
        el.name === "section" && ["memo-list", "export", "rating"].includes(attr(el, "id") ?? ""),
    ).map((el) => attr(el, "id"));
    expect(order).toEqual(["memo-list", "export", "rating"]);
  });

  it("is shown to a person who cannot export too: the section does not depend on the export", () => {
    const viewer = memos(memosPageWith(ratingProps(), { canExport: false }));
    expect(byId(viewer, "export")).toBeUndefined();
    expect(ratingForm(viewer)).toBeDefined();
    expect(radios(viewer)).toHaveLength(5);
  });

  it("posts to the matter's rating address with the token, and nowhere else", () => {
    const form = ratingForm(page);
    expect(attr(form, "method")).toBe("post");
    const token = first(form, (el) => el.name === "input" && attr(el, "name") === "_csrf");
    expect(attr(token, "type")).toBe("hidden");
    expect(attr(token, "value")).toBeTruthy();
    // Nothing in the form names a person, a matter or a review: the route takes the first two from
    // the session and the path, and records the third itself.
    const names = all(form, (el) => ["input", "select", "textarea"].includes(el.name)).map((el) =>
      attr(el, "name"),
    );
    expect(names).toEqual([
      "_csrf",
      FIELDS.rating,
      FIELDS.rating,
      FIELDS.rating,
      FIELDS.rating,
      FIELDS.rating,
      FIELDS.comment,
    ]);
  });

  it("asks the question as the legend of one group of five marks, in order, each labelled with its mark and its words", () => {
    const fieldset = first(ratingForm(page), (el) => el.name === "fieldset");
    expect(readable(first(fieldset, (el) => el.name === "legend"))).toBe(RATING_QUESTION);
    expect(RATING_QUESTION).toBe("I would use this for my next NDA");
    const marks = radios(page);
    expect(marks.map((r) => attr(r, "value"))).toEqual(["1", "2", "3", "4", "5"]);
    expect(marks.map((r) => attr(r, "id"))).toEqual([1, 2, 3, 4, 5].map((n) => `rating-${n}`));
    expect(marks.map((r) => readable(labelOf(page, attr(r, "id")!)))).toEqual(
      [1, 2, 3, 4, 5].map((n) => ratingChoiceLabel(n as 1 | 2 | 3 | 4 | 5)),
    );
    expect(RATING_LABEL[1]).toBe("Strongly disagree");
    expect(RATING_LABEL[5]).toBe("Strongly agree");
    // Every mark is needed before the form is sent, and none is chosen for the person.
    for (const mark of marks) expect(hasAttr(mark, "required")).toBe(true);
    expect(checkedMarks(page)).toEqual([]);
    // The group says how the scale runs, in a hint the group is described by.
    const hint = byId(page, "rating-scale-hint")!;
    expect(attr(fieldset, "aria-describedby")).toBe("rating-scale-hint");
    expect(readable(hint)).toBe("Choose from 1, strongly disagree, to 5, strongly agree.");
  });

  it("has a labelled optional comment, limited to what the store keeps, and a button that is not disabled", () => {
    const comment = control(page, FIELDS.comment);
    expect(comment.name).toBe("textarea");
    expect(readable(labelOf(page, "rating-comment"))).toBe(RATING_COMMENT_LABEL);
    expect(hasAttr(comment, "required")).toBe(false);
    expect(attr(comment, "maxlength")).toBe("4000");
    expect(attr(comment, "aria-describedby")).toBe("rating-comment-hint");
    expect(readable(byId(page, "rating-comment-hint")!)).toMatch(/^Optional\. /);
    const button = first(ratingForm(page), (el) => el.name === "button");
    expect(readable(button)).toBe(RATING_BUTTON);
    expect(attr(button, "type")).toBe("submit");
    expect(hasAttr(button, "disabled")).toBe(false);
  });

  it("says where the rating is kept, who cannot see it, that it is final, and that a demonstration rating is not a pilot result", () => {
    const hint = readable(ratingSection(page));
    expect(hint).toContain(RATING_FORM_HINT);
    expect(RATING_FORM_HINT).toContain("stored with this matter and deleted with it");
    expect(RATING_FORM_HINT).toContain("Other people on this matter cannot see it");
    expect(RATING_FORM_HINT).toContain("cannot be changed once it is saved");
    expect(RATING_FORM_HINT).toContain("not a pilot result");
  });

  it("leads to the report of a missed issue on the review the memo was made from", () => {
    const link = first(
      ratingSection(page),
      (el) => el.name === "a" && readable(el) === RATING_MISSED_ISSUE_LINK,
    );
    expect(attr(link, "href")).toBe(`${urls.run(IDS.matter, IDS.run)}#missed-issue`);
    // The link is the name of what it leads to and says what it is for.
    expect(RATING_MISSED_ISSUE_LINK).toBe("Anything Parol missed? Report a missed issue");
    // It follows the run the memo names, and not a run of the page's own.
    const other = memos(memosPageWith(ratingProps({ runId: "r_0777" })));
    expect(
      attr(
        first(ratingSection(other), (el) => el.name === "a"),
        "href",
      ),
    ).toBe(`${urls.run(IDS.matter, "r_0777")}#missed-issue`);
  });
});

describe("the rating of a matter, the other states", () => {
  it("says there is nothing to rate before a memo exists, and has no form and no link", () => {
    const root = memos(memosPageWith(ratingProps({ hasMemo: false, runId: null })));
    const section = ratingSection(root);
    expect(readable(first(section, (el) => hasClass(el, "empty")))).toBe(RATING_NO_MEMO);
    expect(RATING_NO_MEMO).toBe("You can rate the matter once a memo has been exported.");
    expect(
      all(section, (el) => ["form", "input", "textarea", "button", "a"].includes(el.name)),
    ).toEqual([]);
  });

  it("shows the rating that was given with its denominator, its words and the time, and no form: a rating is final", () => {
    const root = memos(memosPageWith(ratingProps({ given: ratingGiven() })));
    const section = ratingSection(root);
    expect(readable(section)).toContain("You rated this matter 4 of 5 (Agree) on ");
    const time = first(section, (el) => el.name === "time");
    expect(attr(time, "datetime")).toBe("2026-11-05T10:20:00Z");
    expect(readable(first(section, (el) => hasClass(el, "doc-text")))).toBe(
      "It found the deletion that I had missed.",
    );
    expect(all(section, (el) => ["form", "input", "textarea", "button"].includes(el.name))).toEqual(
      [],
    );
    // The way to say more is still there.
    expect(readable(section)).toContain(RATING_MISSED_ISSUE_LINK);
  });

  it("names the mark in words for each of the five, and a given rating with no words has no quotation box", () => {
    for (const mark of [1, 2, 3, 4, 5] as const) {
      const root = memos(
        memosPageWith(ratingProps({ given: ratingGiven({ rating: mark, comment: null }) })),
      );
      expect(readable(ratingSection(root))).toContain(
        `You rated this matter ${mark} of 5 (${RATING_LABEL[mark]}) on `,
      );
      expect(all(ratingSection(root), (el) => hasClass(el, "doc-text"))).toEqual([]);
    }
  });

  it("gives a fixed phrase to a mark this version does not know, and never the number", () => {
    expect(ratingLabel(3)).toBe("Neither agree nor disagree");
    for (const odd of [0, 6, -1, 2.5, Number.NaN]) {
      expect(ratingLabel(odd)).toBe("A rating this version does not know");
    }
  });

  it("is not there on a page made without it", () => {
    const root = memos(memosPageWith(null));
    expect(byId(root, "rating")).toBeUndefined();
    expect(all(root, (el) => attr(el, "href")?.endsWith("#missed-issue") === true)).toEqual([]);
  });
});

describe("the rating of a matter, after a refusal", () => {
  it("shows again what was chosen and typed: the mark and the comment, the comment with its line breaks", () => {
    const root = memos(
      refusedMemosPage("comment_too_long", {
        rating: 2,
        comment: "First line.\nSecond line, with <b>markup</b>.",
      }),
    );
    expect(checkedMarks(root)).toEqual(["2"]);
    expect(radios(root).filter((r) => hasAttr(r, "checked"))).toHaveLength(1);
    // The box holds the comment exactly: one line feed ahead of it, which a browser drops.
    const text = control(root, FIELDS.comment)
      .children.map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(text).toBe("\nFirst line.\nSecond line, with <b>markup</b>.");
  });

  it("keeps the comment when no mark was chosen, and chooses none", () => {
    const root = memos(refusedMemosPage("rating_required", { comment: "My own words." }));
    expect(checkedMarks(root)).toEqual([]);
    expect(readable(control(root, FIELDS.comment))).toBe("My own words.");
  });

  it("offers back no mark that the scale does not hold", () => {
    const root = memos(refusedMemosPage("bad_rating", { rating: 9, comment: "x" }));
    expect(checkedMarks(root)).toEqual([]);
  });

  it("answers each refusal with its words, the sentence that says what to do marked, and a link to the control it is about", () => {
    const cases = [
      ["rating_required", "rating-choice", "fieldset"],
      ["bad_rating", "rating-choice", "fieldset"],
      ["comment_too_long", "rating-comment", "textarea"],
    ] as const;
    for (const [code, target, tag] of cases) {
      const root = memos(refusedMemosPage(code, { rating: 3, comment: "A comment." }));
      const alert = first(root, (el) => attr(el, "role") === "alert");
      expect(readable(alert), code).toContain(REFUSAL_PHRASES[code]);
      expect(withClass(alert, "todo"), code).toHaveLength(1);
      const link = first(alert, (el) => el.name === "a" && hasClass(el, "notice-jump"));
      expect(attr(link, "href"), code).toBe(`#${target}`);
      expect(byId(root, target)?.name, code).toBe(tag);
      expect(
        all(root, (el) => attr(el, "id") === target),
        code,
      ).toHaveLength(1);
    }
    // The codes that no control mends say what to do and lead nowhere.
    for (const [code, rating] of [
      ["already_rated", { given: ratingGiven({ rating: 2 }) }],
      ["not_exported", { hasMemo: false, runId: null }],
    ] as const) {
      const root = memos(refusedMemosPage(code, { rating: 5 }, { status: "conflict", rating }));
      const alert = first(root, (el) => attr(el, "role") === "alert");
      expect(readable(alert), code).toContain(REFUSAL_PHRASES[code]);
      expect(withClass(alert, "todo"), code).toHaveLength(1);
      expect(
        all(alert, (el) => hasClass(el, "notice-jump")),
        code,
      ).toEqual([]);
      // And no form that the refusal could be mended in.
      expect(
        all(ratingSection(root), (el) => el.name === "form"),
        code,
      ).toEqual([]);
    }
  });
});

describe("the rating of a matter, text a person typed", () => {
  const hostile =
    'pay \u202e1000\u202c now, con\u200bfi\u200ddential </textarea><script>window.pwned = 1</script> "quoted"';

  it("is escaped where it is shown as a rating, and its invisible characters are made visible", () => {
    const html = memosPageWith(ratingProps({ given: ratingGiven({ comment: hostile }) }));
    expect(html).not.toContain("<script>window.pwned");
    expect(html).not.toContain("\u202e");
    expect(html).not.toContain("\u200b");
    const root = memos(html);
    expect(readable(ratingSection(root))).toContain("</textarea><script>window.pwned = 1</script>");
    expect(withClass(ratingSection(root), "invisible").length).toBeGreaterThanOrEqual(3);
  });

  it("is escaped where it is put back in the form, which closes its own box only where the page does", () => {
    const html = ratingSectionOf(ratingProps({ draft: { rating: 3, comment: hostile } }));
    expect(html).not.toContain("<script>window.pwned");
    const root = expectAccessible(html, { fragment: true });
    // The text is the person's own, back in the box exactly as it was typed.
    expect(readable(control(root, FIELDS.comment))).toBe(hostile);
    expect(all(root, (el) => el.name === "script")).toEqual([]);
  });
});

describe("the rating of a matter, in the page's own classes", () => {
  it("uses the two rules the stylesheet has for the scale, and classes that already exist", () => {
    const html = ratingSectionOf(ratingProps());
    const root = expectAccessible(html, { fragment: true });
    expect(all(root, (el) => hasClass(el, "rating-scale"))).toHaveLength(1);
    // One box for each mark, in the scale and in no other place.
    const scale = first(root, (el) => hasClass(el, "rating-scale"));
    expect(all(scale, (el) => hasClass(el, "check"))).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------------------------
// Slice D: the notes on a finding
// ---------------------------------------------------------------------------------------------

const notesSection = (root: El): El => byId(root, "notes")!;
const noteForm = (root: El): El =>
  first(
    notesSection(root),
    (el) => el.name === "form" && attr(el, "action") === urls.notes(IDS.matter, IDS.finding),
    "the note form",
  );
const SEVERAL = [
  noteOf(),
  noteOf({
    feedbackId: "fbk_0201",
    note: "The amendment is dated after the NDA.\nSo Section 9.3 may not reach it.",
    authorName: "D. Whitfield",
    at: "2026-11-03T14:40:00Z",
  }),
];
const headingLevel = (el: El): number => Number(first(el, (x) => /^h[1-6]$/.test(x.name)).name[1]);

describe("the notes on a finding, the form", () => {
  const root = checkInvariants(notesPane([]), { fragment: true });

  it("is a section of the pane with its own heading, after the decision and before the history", () => {
    const section = notesSection(root);
    expect(section.name).toBe("section");
    expect(attr(section, "aria-labelledby")).toBe("notes-heading");
    expect(readable(byId(root, "notes-heading")!)).toBe(NOTES_HEADING);
    // One level under the pane's title, as every other section of the pane is.
    expect(headingLevel(section)).toBe(headingLevel(byId(root, "decision")!));
    const order = all(root, (el) => el.name === "section" && hasClass(el, "pane-section")).map(
      (el) => attr(el, "id") ?? attr(el, "aria-labelledby"),
    );
    expect(order.indexOf("notes")).toBeGreaterThan(order.indexOf("decision"));
    expect(order.indexOf("notes")).toBeLessThan(order.indexOf("history-heading"));
    expect(order.filter((x) => x === "notes")).toHaveLength(1);
  });

  it("says who can write a note and that it is not part of the decision or the memo", () => {
    expect(readable(notesSection(root))).toContain(NOTES_INTRO);
    expect(NOTES_INTRO).toContain("is not part of the decision and is not printed in the memo");
  });

  it("posts to the finding's own address with the token, and nowhere else", () => {
    const section = notesSection(root);
    const forms = all(section, (el) => el.name === "form");
    expect(forms).toHaveLength(1);
    const f = noteForm(root);
    expect(attr(f, "method")).toBe("post");
    expect(
      attr(
        first(f, (el) => attr(el, "name") === "_csrf"),
        "value",
      ),
    ).toBe(IDS.csrf);
    // The finding is in the path, and no field of the form names a person, a matter or a finding.
    const names = all(f, (el) => ["input", "select", "textarea"].includes(el.name)).map((el) =>
      attr(el, "name"),
    );
    expect(names).toEqual(["_csrf", FIELDS.note]);
  });

  it("has a labelled note, required and limited to what the store keeps, tied to its hint, and a button that is not disabled", () => {
    const textarea = control(noteForm(root), FIELDS.note);
    expect(textarea.name).toBe("textarea");
    expect(attr(textarea, "id")).toBe("note-text");
    expect(readable(labelOf(root, "note-text"))).toBe(NOTE_LABEL);
    expect(hasAttr(textarea, "required")).toBe(true);
    expect(attr(textarea, "maxlength")).toBe("4000");
    expect(attr(textarea, "aria-describedby")).toBe("note-text-hint");
    expect(readable(byId(root, "note-text-hint")!)).toBe(NOTE_HINT);
    const button = first(noteForm(root), (el) => el.name === "button");
    expect(readable(button)).toBe(NOTE_BUTTON);
    expect(attr(button, "type")).toBe("submit");
    expect(hasAttr(button, "disabled")).toBe(false);
    // The button does not read as the decision's or the report's.
    expect(NOTE_BUTTON).toBe("Add note");
  });

  it("is in the tab order after the decision form, as the note and then the button", () => {
    const stops = tabStops(notesSection(root)).map((el) => attr(el, "name") ?? el.name);
    expect(stops.filter((n) => n !== "_csrf")).toEqual([FIELDS.note, "button"]);
  });

  it("says that nobody has written a note, and has no list, until somebody has", () => {
    expect(readable(first(notesSection(root), (el) => hasClass(el, "empty")))).toBe(NOTES_EMPTY);
    expect(all(notesSection(root), (el) => el.name === "ol")).toEqual([]);
  });

  it("is an empty box, with nothing in it, when nothing has been typed", () => {
    expect(readable(control(noteForm(root), FIELDS.note))).toBe("");
  });
});

describe("the notes on a finding, the list", () => {
  const root = checkInvariants(notesPane(SEVERAL), { fragment: true });
  const items = all(notesSection(root), (el) => el.name === "li");

  it("is an ordered list in the order the notes were written, one item for each note", () => {
    expect(all(notesSection(root), (el) => el.name === "ol")).toHaveLength(1);
    expect(items).toHaveLength(2);
    expect(readable(items[0]!)).toContain("A. Ruiz");
    expect(readable(items[1]!)).toContain("D. Whitfield");
    expect(
      hasClass(
        first(notesSection(root), (el) => el.name === "ol"),
        "feedback-list",
      ),
    ).toBe(true);
    // Something is there to read, so the sentence that says nobody has written is not.
    expect(all(notesSection(root), (el) => hasClass(el, "empty"))).toEqual([]);
  });

  it("names the author and the time of each note, the time as a time", () => {
    for (const [i, note] of SEVERAL.entries()) {
      const time = first(items[i]!, (el) => el.name === "time");
      expect(attr(time, "datetime")).toBe(note.at);
      expect(readable(items[i]!)).toContain(note.authorName);
    }
  });

  it("shows the words of a note as text that keeps its line breaks, in a quotation box", () => {
    const box = first(items[1]!, (el) => hasClass(el, "doc-text"));
    // The box holds the text as it was written, line break and all; the stylesheet keeps the break.
    expect(box.children.map((c) => (c.type === "text" ? c.text : "")).join("")).toBe(
      SEVERAL[1]!.note,
    );
    expect(readable(box)).toBe(SEVERAL[1]!.note.replace("\n", " "));
  });

  it("still lists the notes when the form is replaced by the reason a note cannot be added", () => {
    const stale = checkInvariants(
      notesPane(SEVERAL, { canAddNote: { allowed: false, reason: CANNOT_ADD_NOTE.stale } }),
      { fragment: true },
    );
    expect(all(notesSection(stale), (el) => el.name === "li")).toHaveLength(2);
    expect(all(notesSection(stale), (el) => el.name === "form")).toEqual([]);
  });
});

describe("the notes on a finding, when a note cannot be added", () => {
  it("says why in a note of its own, in place of the form: a finding out of date, a role that cannot", () => {
    for (const reason of [CANNOT_ADD_NOTE.stale, CANNOT_ADD_NOTE.role]) {
      const root = checkInvariants(notesPane([], { canAddNote: { allowed: false, reason } }), {
        fragment: true,
      });
      const blocked = first(notesSection(root), (el) => attr(el, "role") === "note");
      expect(readable(blocked)).toBe(reason);
      expect(
        all(notesSection(root), (el) => ["form", "textarea", "button"].includes(el.name)),
      ).toEqual([]);
    }
    expect(CANNOT_ADD_NOTE.stale).toBe(
      "This finding is out of date, so notes can no longer be added to it.",
    );
    // The page's phrase for a stale finding is the first sentence of the refusal's.
    expect(REFUSAL_PHRASES["finding_not_current"]).toContain(CANNOT_ADD_NOTE.stale.slice(0, -1));
  });

  it("is never left without a reason: a blank or missing one gets the general sentence", () => {
    for (const reason of [null, "", "   "]) {
      const root = checkInvariants(notesPane([], { canAddNote: { allowed: false, reason } }), {
        fragment: true,
      });
      expect(readable(first(notesSection(root), (el) => attr(el, "role") === "note"))).toBe(
        NOTE_CANNOT_ADD,
      );
    }
  });

  it("is not there at all on a finding made before notes existed: the page says nothing it does not know", () => {
    const root = checkInvariants(paneOf(buildFindingView()), { fragment: true });
    expect(byId(root, "notes")).toBeUndefined();
    expect(all(root, (el) => attr(el, "href") === "#notes")).toEqual([]);
  });
});

describe("the notes on a finding, the link to them", () => {
  it("leads from the header of the pane to the section, beside the link to the decision", () => {
    const root = checkInvariants(notesPane([]), { fragment: true });
    const header = first(root, (el) => el.name === "header" && hasClass(el, "pane-head"));
    const links = all(header, (el) => el.name === "a").map((a) => [attr(a, "href"), readable(a)]);
    expect(links).toEqual([
      ["#decision", "Go to the decision"],
      ["#notes", NOTES_JUMP],
    ]);
    expect(all(root, (el) => attr(el, "id") === "notes")).toHaveLength(1);
  });

  it("is there when the decision cannot be made, since the notes can still be read and written", () => {
    const root = checkInvariants(
      notesPane([], {
        finding: buildFindingView({ canDecide: { allowed: false, reason: "Not yours." } }),
      }),
      { fragment: true },
    );
    const header = first(root, (el) => el.name === "header" && hasClass(el, "pane-head"));
    expect(all(header, (el) => el.name === "a").map((a) => attr(a, "href"))).toEqual(["#notes"]);
  });
});

describe("the notes on a finding, text a person typed", () => {
  const hostile =
    'pay \u202e1000\u202c now, con\u200bfi\u200ddential </textarea><script>window.pwned = 1</script> "quoted"';

  it("is escaped where it is shown as a note, and its invisible characters are made visible", () => {
    const html = notesPane([noteOf({ note: hostile, authorName: "<b>Mallory</b>" })]);
    expect(html).not.toContain("<script>window.pwned");
    expect(html).not.toContain("<b>Mallory</b>");
    expect(html).not.toContain("\u202e");
    expect(html).not.toContain("\u200b");
    const root = expectAccessible(html, { fragment: true });
    expect(readable(notesSection(root))).toContain("</textarea><script>window.pwned = 1</script>");
    expect(readable(notesSection(root))).toContain("<b>Mallory</b>");
    expect(withClass(notesSection(root), "invisible").length).toBeGreaterThanOrEqual(3);
    expect(all(root, (el) => el.name === "script")).toEqual([]);
  });

  it("is escaped where it is put back in the form, which closes its own box only where the page does", () => {
    const html = notesPane([], { noteDraft: { note: hostile } });
    expect(html).not.toContain("<script>window.pwned");
    const root = expectAccessible(html, { fragment: true });
    // The text is the person's own, back in the box exactly as it was typed.
    expect(readable(control(noteForm(root), FIELDS.note))).toBe(hostile);
    expect(all(root, (el) => el.name === "script")).toEqual([]);
  });
});

describe("the notes on a finding, after a refusal", () => {
  it("shows again what was typed, with its line breaks, in the form", () => {
    const root = expectAccessible(
      refusedNotePage("finding_note_too_long", { note: "Line one.\nLine two." }),
    );
    const text = control(noteForm(root), FIELDS.note)
      .children.map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    // The textarea holds the note exactly: one line feed ahead of it, which a browser drops.
    expect(text).toBe("\nLine one.\nLine two.");
  });

  it("answers each refusal of the note with its words, the sentence that says what to do marked, and a link to the note", () => {
    for (const code of ["finding_note_required", "finding_note_too_long"] as const) {
      const root = expectAccessible(refusedNotePage(code, { note: "A note." }));
      const alert = first(root, (el) => attr(el, "role") === "alert");
      expect(readable(alert), code).toContain(REFUSAL_PHRASES[code]);
      expect(withClass(alert, "todo"), code).toHaveLength(1);
      const link = first(alert, (el) => el.name === "a" && hasClass(el, "notice-jump"));
      expect(attr(link, "href"), code).toBe("#note-text");
      expect(byId(root, "note-text")?.name, code).toBe("textarea");
    }
  });

  it("answers the cap and an out of date finding in words, and leads nowhere: no control mends them", () => {
    for (const [code, options] of [
      ["feedback_limit", { status: "conflict" }],
      [
        "finding_not_current",
        {
          status: "conflict",
          canAddNote: { allowed: false, reason: CANNOT_ADD_NOTE.stale },
        },
      ],
    ] as const) {
      const root = expectAccessible(refusedNotePage(code, { note: "Late." }, options));
      const alert = first(root, (el) => attr(el, "role") === "alert");
      expect(readable(alert), code).toContain(REFUSAL_PHRASES[code]);
      expect(withClass(alert, "todo"), code).toHaveLength(1);
      expect(
        all(alert, (el) => hasClass(el, "notice-jump")),
        code,
      ).toEqual([]);
    }
    // An out of date finding has no form for the sentence to point at.
    const stale = expectAccessible(
      refusedNotePage(
        "finding_not_current",
        { note: "Late." },
        { status: "conflict", canAddNote: { allowed: false, reason: CANNOT_ADD_NOTE.stale } },
      ),
    );
    expect(all(notesSection(stale), (el) => el.name === "form")).toEqual([]);
  });
});

describe("the notes on a finding, in the inspector of the review page", () => {
  const html = runPageWithNotes(SEVERAL, { counts: { "dur-1": 2, "exc-1": 1 } });
  const root = expectAccessible(html);

  it("are the section of the finding pane inside the inspector, and nowhere else on the page", () => {
    const inspector = first(root, (el) => attr(el, "id") === "inspector");
    expect(all(root, (el) => attr(el, "id") === "notes")).toHaveLength(1);
    expect(byId(inspector, "notes")).toBeDefined();
    expect(all(notesSection(root), (el) => el.name === "li")).toHaveLength(2);
    expect(attr(noteForm(root), "action")).toBe(urls.notes(IDS.matter, IDS.finding));
  });

  it("says in the issue table how many notes a finding has, under the review chip, only when it has any", () => {
    const rows = all(root, (el) => el.name === "tr" && hasAttr(el, "data-issue-row"));
    const counted = rows
      .map((row) => [
        readable(first(row, (el) => hasClass(el, "rule-key"))),
        all(row, (el) => hasAttr(el, "data-note-count")).map(readable),
      ])
      .filter(([, said]) => (said as string[]).length > 0);
    expect(counted).toEqual([
      ["dur-1", [noteCountLabel(2)]],
      ["exc-1", [noteCountLabel(1)]],
    ]);
    expect(noteCountLabel(1)).toBe("1 note");
    expect(noteCountLabel(2)).toBe("2 notes");
    // The count is in the review cell, so a reader finds it where the decision is.
    const cell = first(
      rows.find((row) => readable(row).includes("dur-1"))!,
      (el) => el.name === "td" && all(el, (x) => hasAttr(x, "data-note-count")).length > 0,
    );
    expect(readable(cell)).toContain("2 notes");
  });

  it("says nothing of notes on a row with none, or with a count of nothing", () => {
    const none = expectAccessible(runPageWithNotes([], { counts: { "dur-1": 0 } }));
    expect(all(none, (el) => hasAttr(el, "data-note-count"))).toEqual([]);
    expect(readable(none)).not.toMatch(/\b0 notes\b/);
  });

  it("is a page of the inspector's own words when no finding is chosen: no notes section anywhere", () => {
    const bare = expectAccessible(runPageWith(feedbackProps()));
    expect(byId(bare, "notes")).toBeUndefined();
  });
});
