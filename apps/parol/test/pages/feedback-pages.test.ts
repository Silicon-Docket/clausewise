import { describe, expect, it } from "vitest";
import { REASON_CODES } from "../../src/contracts.js";
import { FIELDS, MINOR_EDIT_VALUE } from "../../src/server/pages/forms.js";
import {
  MINOR_EDIT_HINT,
  MINOR_EDIT_LABEL,
  MINOR_EDIT_MARKED,
  REASON_CODE_LABEL,
  REASON_CODE_MEANING,
  reasonCodeLabel,
} from "../../src/server/views/feedback.js";
import { expectAccessible } from "../a11y/rules.js";
import {
  decision,
  decidedWith,
  decisionPane,
  editWith,
  paneOf,
  refusedFindingPage,
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
import { buildFindingView } from "./support.js";
import { VARIANTS_FEEDBACK } from "./variants-feedback.js";

/**
 * The reason code and the minor-edit mark on the finding pane (package W2.6a, slice A): the two
 * controls of the decision form, what the history says of a decision that carries them, and the
 * page that answers a refused decision. The later slices add the tests of their panes below.
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
