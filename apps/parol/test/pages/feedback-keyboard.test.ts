import { describe, expect, it } from "vitest";
import { FIELDS } from "../../src/server/pages/forms.js";
import { accessibleName, expectAccessible, tabStops } from "../a11y/rules.js";
import { FakeElement, event, runScript } from "./fake-dom.js";
import { decisionPane, refusedFindingPage } from "./feedback-support.js";
import { all, ancestorsOf, attr, byId, first, hasAttr, hasClass, type El } from "./html.js";
import { runPage } from "./render.js";
import { buildFindingView } from "./support.js";

/**
 * The reason code and the minor-edit box are reached and used with the keyboard alone (package
 * W2.6a, slice A). Both are native controls, so Tab reaches them in the order of use and the arrow
 * keys, type-ahead and Space operate them with no script. The checks read the markup the pages
 * write: which elements take a tab stop, in which order, with which name, and whether the script
 * that handles the issue table's keys can capture a key typed in them. No browser is run here.
 * The later slices add the order of their own controls below.
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
