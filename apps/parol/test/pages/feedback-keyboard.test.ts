import { describe, expect, it } from "vitest";
import { FIELDS } from "../../src/server/pages/forms.js";
import { accessibleName, expectAccessible, tabStops } from "../a11y/rules.js";
import { FakeElement, event, runScript } from "./fake-dom.js";
import {
  decisionPane,
  feedbackProps,
  refusedFindingPage,
  refusedRunPage,
  report,
  runPageWith,
} from "./feedback-support.js";
import { all, ancestorsOf, attr, byId, first, hasAttr, hasClass, type El } from "./html.js";
import { runPage } from "./render.js";
import { buildFindingView } from "./support.js";

/**
 * The reason code and the minor-edit box are reached and used with the keyboard alone (package
 * W2.6a, slice A). Both are native controls, so Tab reaches them in the order of use and the arrow
 * keys, type-ahead and Space operate them with no script. The checks read the markup the pages
 * write: which elements take a tab stop, in which order, with which name, and whether the script
 * that handles the issue table's keys can capture a key typed in them. No browser is run here.
 *
 * Slice B: the same for the report of a missed issue, a section at the end of the review page: the
 * rule list, the place, the note and the button, in that order, each reached by Tab, named for what
 * it is, and out of reach of the issue table's keys; and the links that lead to the section and to
 * the controls of it. The later slices add the order of their own controls below.
 */

const decisionForm = (root: El): El =>
  first(root, (el) => el.name === "form" && hasAttr(el, "data-decision-form"));

/** The tab stops of the decision form by name, a radio group as one stop and a disclosure as its summary. */
const stops = (root: El): string[] =>
  tabStops(decisionForm(root)).map((el) =>
    el.name === "summary" ? "summary" : (attr(el, "name") ?? el.name),
  );

describe("the decision form, by keyboard", () => {
  const html = decisionPane();
  const root = expectAccessible(html, { fragment: true });

  it("takes Tab to the reason code after the reason and before the edits, then to the box last", () => {
    const order = stops(root).filter((name) => name !== "_csrf");
    expect(order).toEqual([
      FIELDS.decision,
      FIELDS.reason,
      FIELDS.reasonCode,
      "summary",
      FIELDS.status,
      FIELDS.discrepancy,
      FIELDS.fallbackLanguage,
      ...order.filter((name) => name.startsWith("evidenceRole:")),
      FIELDS.minorEdit,
      "button",
    ]);
    // The button that saves comes after the box, so the box is never skipped on the way to it.
    expect(order.at(-1)).toBe("button");
    expect(order.indexOf(FIELDS.reasonCode)).toBeLessThan(order.indexOf(FIELDS.status));
  });

  it("gives each a name a person can say: the list is Reason code, the box is the minor-edit sentence", () => {
    const select = byId(root, "decision-reason-code")!;
    const box = byId(root, "edit-minor")!;
    expect(accessibleName(root, select)).toBe("Reason code");
    expect(accessibleName(root, box)).toBe("This is a minor edit");
    const summary = first(decisionForm(root), (el) => el.name === "summary");
    expect(accessibleName(root, summary)).toBe("What the reason codes mean");
  });

  it("uses native controls only: no positive tabindex, nothing removed from the order, no script handler", () => {
    for (const id of ["decision-reason-code", "edit-minor"]) {
      const el = byId(root, id)!;
      expect(hasAttr(el, "tabindex"), id).toBe(false);
      expect(hasAttr(el, "disabled"), id).toBe(false);
      expect(hasAttr(el, "hidden"), id).toBe(false);
      expect(
        el.attrs.filter((a) => /^on/i.test(a.name)),
        id,
      ).toEqual([]);
      expect(tabStops(root)).toContain(el);
    }
    const positive = all(root, (el) => Number(attr(el, "tabindex") ?? "0") > 0);
    expect(positive).toEqual([]);
  });

  it("leaves the save button enabled in the markup, so a keyboard user always reaches it", () => {
    const button = first(decisionForm(root), (el) => el.name === "button");
    expect(hasAttr(button, "disabled")).toBe(false);
    expect(tabStops(root)).toContain(button);
  });

  it("opens the meanings from the keyboard: the summary is a stop, and what is inside is not one while it is closed", () => {
    const details = first(decisionForm(root), (el) => el.name === "details");
    expect(hasAttr(details, "open")).toBe(false);
    const summary = first(details, (el) => el.name === "summary");
    const reachable = tabStops(root);
    expect(reachable).toContain(summary);
    // Only the summary: the terms and meanings hold no link and no control.
    expect(
      all(details, (el) => ["a", "button", "input", "select", "textarea"].includes(el.name)),
    ).toEqual([]);
  });
});

describe("the targets of the links that lead to the controls", () => {
  it("exist once each, and are the controls themselves", () => {
    const root = expectAccessible(decisionPane(), { fragment: true });
    for (const [id, tag] of [
      ["decision-reason-code", "select"],
      ["edit-minor", "input"],
    ] as const) {
      const found = all(root, (el) => attr(el, "id") === id);
      expect(found, id).toHaveLength(1);
      expect(found[0]!.name).toBe(tag);
    }
  });

  it("are reached by the link of a refusal, which is the first stop after the notice", () => {
    for (const [code, target] of [
      ["reason_code_required", "decision-reason-code"],
      ["minor_edit_status", "edit-minor"],
    ] as const) {
      const root = expectAccessible(refusedFindingPage(code));
      const stopsOfPage = tabStops(root);
      const link = first(root, (el) => el.name === "a" && hasClass(el, "notice-jump"));
      expect(attr(link, "href")).toBe(`#${target}`);
      // The notice comes before the form in the document, so Tab meets the link on the way to it.
      const form = decisionForm(root);
      expect(stopsOfPage.indexOf(link), code).toBeGreaterThan(-1);
      expect(stopsOfPage.indexOf(link), code).toBeLessThan(
        stopsOfPage.indexOf(byId(root, target)!),
      );
      expect(stopsOfPage.indexOf(link), code).toBeLessThan(
        stopsOfPage.indexOf(first(form, (el) => el.name === "button")),
      );
    }
  });
});

describe("the keys of the issue table", () => {
  const withFinding = () => runPage({ selected: buildFindingView() });

  it("do not reach the controls: the list, the box and the meanings are in the inspector, outside the table's zone", () => {
    const html = withFinding();
    const root = expectAccessible(html);
    const form = first(root, (el) => el.name === "form" && hasAttr(el, "data-decision-form"));
    const mine = [
      byId(root, "decision-reason-code")!,
      byId(root, "edit-minor")!,
      ...all(form, (el) => el.name === "summary"),
    ];
    expect(mine).toHaveLength(3);
    for (const el of mine) {
      const zones = ancestorsOf(root, el).filter((a) => attr(a, "data-zone") === "issues");
      expect(zones, el.name).toEqual([]);
    }
  });

  it("do nothing when j, k, ? or Enter are typed into a list or a box, even placed where the script listens", () => {
    const h = runScript(withFinding());
    const zone = h.doc.querySelector('[data-zone="issues"]')!;
    const before = h.doc.querySelectorAll("tr.is-current").length;
    for (const tag of ["select", "input"]) {
      const field = new FakeElement(h.doc, null, tag);
      field.parent = zone;
      for (const key of ["j", "k", "?", "Enter"]) {
        const e = event("keydown", field, { key });
        field.dispatch(e);
        expect(e.defaultPrevented, `${tag} ${key}`).toBe(false);
      }
    }
    expect(h.doc.querySelectorAll("tr.is-current")).toHaveLength(before);
    expect(h.fetchCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Slice B: the report of a missed issue
// ---------------------------------------------------------------------------------------------

const reportForm = (root: El): El =>
  first(
    byId(root, "missed-issue")!,
    (el) => el.name === "form",
    "the form of the report of a missed issue",
  );

describe("the report of a missed issue, by keyboard", () => {
  const html = runPageWith(feedbackProps({ items: [report()] }));
  const root = expectAccessible(html);

  it("takes Tab through the rule, the place, the note and the button, in the order they are used", () => {
    const stopsOfForm = tabStops(reportForm(root)).map((el) => attr(el, "name") ?? el.name);
    expect(stopsOfForm.filter((n) => n !== "_csrf")).toEqual([
      FIELDS.ruleKey,
      FIELDS.location,
      FIELDS.note,
      "button",
    ]);
    // On the page the section is after the table and the inspector, so Tab meets it last of the
    // controls, and the box that scrolls the reports comes after the button of the form.
    const stopsOfPage = tabStops(root);
    const section = byId(root, "missed-issue")!;
    const mine = stopsOfPage.filter((el) => ancestorsOf(root, el).includes(section));
    expect(mine.map((el) => attr(el, "name") ?? attr(el, "role") ?? el.name)).toEqual([
      FIELDS.ruleKey,
      FIELDS.location,
      FIELDS.note,
      "button",
      "region",
    ]);
    const inspector = byId(root, "inspector")!;
    const before = stopsOfPage.filter((el) => ancestorsOf(root, el).includes(inspector));
    for (const el of before)
      expect(stopsOfPage.indexOf(el)).toBeLessThan(stopsOfPage.indexOf(mine[0]!));
  });

  it("names each control for what it is, and the box of reports for what it holds", () => {
    expect(accessibleName(root, byId(root, "missed-issue-rule")!)).toBe("Rule");
    expect(accessibleName(root, byId(root, "missed-issue-location")!)).toBe("Location");
    expect(accessibleName(root, byId(root, "missed-issue-note")!)).toBe("Note");
    expect(
      accessibleName(
        root,
        first(reportForm(root), (el) => el.name === "button"),
      ),
    ).toBe("Report missed issue");
    const region = first(byId(root, "missed-issue")!, (el) => attr(el, "role") === "region");
    expect(accessibleName(root, region)).toBe("Missed issues reported on this review");
  });

  it("uses native controls only: no positive tabindex, nothing removed from the order, no script handler", () => {
    for (const id of ["missed-issue-rule", "missed-issue-location", "missed-issue-note"]) {
      const el = byId(root, id)!;
      expect(hasAttr(el, "tabindex"), id).toBe(false);
      expect(hasAttr(el, "disabled"), id).toBe(false);
      expect(hasAttr(el, "hidden"), id).toBe(false);
      expect(
        el.attrs.filter((a) => /^on/i.test(a.name)),
        id,
      ).toEqual([]);
      expect(tabStops(root)).toContain(el);
    }
    const button = first(reportForm(root), (el) => el.name === "button");
    expect(hasAttr(button, "disabled")).toBe(false);
    expect(tabStops(root)).toContain(button);
    expect(all(root, (el) => Number(attr(el, "tabindex") ?? "0") > 0)).toEqual([]);
  });

  it("is reached by the link at the top of the page, whose target is the section and is there once", () => {
    const links = all(root, (el) => el.name === "a" && attr(el, "href") === "#missed-issue");
    expect(links).toHaveLength(1);
    expect(all(root, (el) => attr(el, "id") === "missed-issue")).toHaveLength(1);
    // The link is a stop before the table's own, so a keyboard user can skip the rows.
    const stopsOfPage = tabStops(root);
    const table = byId(root, "issue-table") ?? first(root, (el) => hasClass(el, "issue-table"));
    const firstRow = stopsOfPage.find((el) => ancestorsOf(root, el).includes(table))!;
    expect(stopsOfPage.indexOf(links[0]!)).toBeGreaterThan(-1);
    expect(stopsOfPage.indexOf(links[0]!)).toBeLessThan(stopsOfPage.indexOf(firstRow));
  });
});

describe("the links of a refused report", () => {
  it("lead to the control to mend, and are the first stop after the notice, before the form", () => {
    for (const [code, target] of [
      ["rule_required", "missed-issue-rule"],
      ["note_required", "missed-issue-note"],
      ["note_too_long", "missed-issue-note"],
      ["location_too_long", "missed-issue-location"],
    ] as const) {
      const page = expectAccessible(refusedRunPage(code, { ruleKey: "dur-1", note: "x" }));
      const stopsOfPage = tabStops(page);
      const link = first(page, (el) => el.name === "a" && hasClass(el, "notice-jump"));
      expect(attr(link, "href"), code).toBe(`#${target}`);
      expect(stopsOfPage.indexOf(link), code).toBeGreaterThan(-1);
      // The notice is above the table and the form: Tab meets the link before either.
      expect(stopsOfPage.indexOf(link), code).toBeLessThan(
        stopsOfPage.indexOf(byId(page, target)!),
      );
      expect(stopsOfPage.indexOf(link), code).toBeLessThan(
        stopsOfPage.indexOf(first(reportForm(page), (el) => el.name === "button")),
      );
      // The target is the control, once.
      expect(all(page, (el) => attr(el, "id") === target)).toHaveLength(1);
    }
  });
});

describe("the keys of the issue table, and the report of a missed issue", () => {
  it("do not reach the report: it sits outside the zone of the table", () => {
    const page = expectAccessible(runPageWith(feedbackProps({ items: [report()] })));
    const section = byId(page, "missed-issue")!;
    const controls = all(
      section,
      (el) =>
        ["select", "input", "textarea", "button"].includes(el.name) ||
        attr(el, "role") === "region",
    );
    expect(controls.length).toBeGreaterThanOrEqual(5);
    for (const el of controls) {
      const zones = ancestorsOf(page, el).filter((a) => attr(a, "data-zone") === "issues");
      expect(zones, `${el.name} ${attr(el, "name") ?? ""}`).toEqual([]);
    }
    // And the section is not inside the inspector, which the script handles on its own.
    expect(ancestorsOf(page, section).filter((a) => attr(a, "id") === "inspector")).toEqual([]);
  });

  it("do nothing when j, k, ? or Enter are typed into the list, the place or the note, even placed where the script listens", () => {
    const h = runScript(runPageWith(feedbackProps()));
    const zone = h.doc.querySelector('[data-zone="issues"]')!;
    const before = h.doc.querySelectorAll("tr.is-current").length;
    for (const tag of ["select", "input", "textarea"]) {
      const field = new FakeElement(h.doc, null, tag);
      field.parent = zone;
      for (const key of ["j", "k", "?", "Enter"]) {
        const e = event("keydown", field, { key });
        field.dispatch(e);
        expect(e.defaultPrevented, `${tag} ${key}`).toBe(false);
      }
    }
    expect(h.doc.querySelectorAll("tr.is-current")).toHaveLength(before);
    expect(h.fetchCalls).toEqual([]);
  });
});
