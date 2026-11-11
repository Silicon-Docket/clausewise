import { describe, expect, it } from "vitest";
import { REASON_CODES } from "../../src/contracts.js";
import { FIELDS, MINOR_EDIT_VALUE, NOT_COVERED_VALUE } from "../../src/server/pages/forms.js";
import { urls } from "../../src/server/urls.js";
import {
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
  REASON_CODE_LABEL,
  REASON_CODE_MEANING,
  reasonCodeLabel,
  ruleChoiceLabel,
} from "../../src/server/views/feedback.js";
import { REFUSAL_PHRASES } from "../../src/server/routes/notices.js";
import { expectAccessible } from "../a11y/rules.js";
import {
  RULE_CHOICES,
  decision,
  decidedWith,
  decisionPane,
  editWith,
  feedbackProps,
  paneOf,
  refusedFindingPage,
  refusedRunPage,
  report,
  runPageWith,
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
 * the pages that answer each refusal of a report. The later slices add the tests of their panes
 * below.
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
      expect(
        () => expectAccessible(make(), options?.fragment === true ? { fragment: true } : {}),
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
