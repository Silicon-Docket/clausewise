import { describe, expect, it } from "vitest";
import { PILOT_SEVERITIES } from "../../src/pilot/index.js";
import { FIELDS } from "../../src/server/pages/forms.js";
import {
  PILOT_ANCHORS,
  referenceSeverityField,
  ruleKeyOfSeverityField,
} from "../../src/server/pages/pilotfields.js";
import { referenceListFromForm } from "../../src/server/routes/pilot-input.js";
import { REFUSALS_PILOT } from "../../src/server/routes/refusals-pilot.js";
import { urls } from "../../src/server/urls.js";
import {
  OUTSIDE_LABEL,
  REFERENCE_HEADING,
  REFERENCE_LOCKED,
  REFERENCE_LOCKED_EMPTY,
  REFERENCE_NOTE,
  REFERENCE_NO_PLAYBOOK,
  REFERENCE_SAVE_LABEL,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  referenceSummary,
  severitySelectLabel,
} from "../../src/server/views/pilot.js";
import { accessibleName, expectAccessible, tabStops } from "../a11y/rules.js";
import { all, attr, byId, byTag, hasAttr, hasClass, parseHtml, readable, type El } from "./html.js";
import { checkInvariants } from "./invariants.js";
import {
  REFERENCE_RULES,
  buildReference,
  buildTimer,
  matterPagePilot,
  referencePane,
  violationsAddedByPanels,
  withSeverities,
} from "./pilot-support.js";
import { IDS } from "./support.js";

/**
 * The reference list of a matter (package W2.6b), as a section of the matter page: each state of
 * it, that only the reviewing attorney is given it, that every control is native and labelled and
 * reached by Tab in reading order, and that the field names it posts are the ones the route reads.
 * The routes that receive the form are in test/routes/pilot.test.ts.
 */

const SAVED = buildReference({
  rules: withSeverities({ "dur-1": "high", "pds-1": "medium" }),
  outside: { high: 1, medium: 0, low: 2 },
  issues: 5,
});
const LOCKED = buildReference({ ...SAVED, state: "locked" });
const NO_PLAYBOOK = buildReference({ state: "no_playbook", rules: [] });

function sectionOf(html: string): { root: El; section: El } {
  const root = expectAccessible(html, { fragment: true });
  const section = byId(root, PILOT_ANCHORS.referenceList);
  if (section === undefined) throw new Error("the pane has no reference list section");
  return { root, section };
}

/**
 * The pane with the place its one link leads to beside it. The no-playbook sentence links to the
 * matter's settings, which the matter page holds and a pane on its own does not.
 */
const withSettings = (html: string): string =>
  `<section id="settings" aria-labelledby="settings-heading"><h2 id="settings-heading">Client and playbook</h2></section>${html}`;

const formOf = (section: El): El => byTag(section, "form")[0] as El;
const selectsOf = (section: El): El[] => byTag(section, "select");

describe("the reference list, open", () => {
  const { section } = sectionOf(referencePane(SAVED));

  it("is a section of its own, named by a heading, with the note that says when it closes", () => {
    expect(section.name).toBe("section");
    expect(attr(section, "id")).toBe("reference-list");
    expect(attr(section, "aria-labelledby")).toBe("reference-list-heading");
    expect(readable(byId(section, "reference-list-heading") as El)).toBe(
      "Reference list for shadow mode",
    );
    expect(readable(section)).toContain(
      "Record the issues found in the manual review before Parol reads this matter. The list closes when the first review starts, so it cannot be changed after Parol has seen the documents.",
    );
  });

  it("is one form to the reference route, with the token and one button", () => {
    const forms = byTag(section, "form");
    expect(forms).toHaveLength(1);
    expect(attr(formOf(section), "method")).toBe("post");
    expect(attr(formOf(section), "action")).toBe(urls.matterReferenceList(IDS.matter));
    expect(
      all(formOf(section), (el) => el.name === "input" && attr(el, "name") === "_csrf"),
    ).toHaveLength(1);
    expect(byTag(section, "button").map((b) => readable(b))).toEqual(["Save the reference list"]);
    expect(attr(byTag(section, "button")[0] as El, "type")).toBe("submit");
  });

  it("has one select for each rule of the playbook, in the playbook's order, named by the rule's key", () => {
    const selects = selectsOf(section);
    expect(selects.map((s) => attr(s, "name"))).toEqual(
      REFERENCE_RULES.map((rule) => referenceSeverityField(rule.ruleKey)),
    );
    for (const select of selects) {
      expect(
        byTag(select, "option").map((o) => ({ value: attr(o, "value"), text: readable(o) })),
      ).toEqual([
        { value: "", text: "Not an issue" },
        { value: "high", text: "High" },
        { value: "medium", text: "Medium" },
        { value: "low", text: "Low" },
      ]);
    }
  });

  it("shows the saved choice of each rule as the one selected, and none selected twice", () => {
    const chosen = Object.fromEntries(
      selectsOf(section).map((select) => {
        const selected = byTag(select, "option").filter((o) => hasAttr(o, "selected"));
        expect(selected).toHaveLength(1);
        return [
          ruleKeyOfSeverityField(attr(select, "name") ?? ""),
          attr(selected[0] as El, "value"),
        ];
      }),
    );
    expect(chosen).toEqual({
      "pty-1": "",
      "def-1": "",
      "exc-1": "",
      "pds-1": "medium",
      "pds-2": "",
      "dur-1": "high",
      "ret-1": "",
      "gov-1": "",
    });
  });

  it("labels every select with the rule it is for, and shows the rule in the row header with its key", () => {
    const root = parseHtml(referencePane(SAVED));
    for (const rule of REFERENCE_RULES) {
      const select = selectsOf(section).find(
        (s) => attr(s, "name") === referenceSeverityField(rule.ruleKey),
      ) as El;
      const label = all(
        root,
        (el) => el.name === "label" && attr(el, "for") === attr(select, "id"),
      );
      expect(label).toHaveLength(1);
      expect(readable(label[0] as El)).toBe(`Severity of the issue for ${rule.title}`);
      expect(accessibleName(root, select)).toBe(`Severity of the issue for ${rule.title}`);
      const row = all(section, (el) => el.name === "tr").find((tr) =>
        readable(tr).includes(rule.title),
      ) as El;
      const header = byTag(row, "th")[0] as El;
      expect(readable(header).startsWith(rule.title)).toBe(true);
      expect(readable(all(header, (el) => hasClass(el, "hint"))[0] as El)).toBe(rule.ruleKey);
    }
  });

  it("has three counts for the issues no rule covers, each labelled, from 0 to 9, in a group the refusals lead to", () => {
    const group = byId(section, PILOT_ANCHORS.referenceOutside) as El;
    expect(group.name).toBe("fieldset");
    expect(readable(byTag(group, "legend")[0] as El)).toBe(
      "Issues that no rule of the playbook covers",
    );
    const inputs = byTag(group, "input");
    expect(inputs.map((i) => attr(i, "name"))).toEqual([
      FIELDS.outsideHigh,
      FIELDS.outsideMedium,
      FIELDS.outsideLow,
    ]);
    expect(inputs.map((i) => attr(i, "value"))).toEqual(["1", "0", "2"]);
    const root = parseHtml(referencePane(SAVED));
    for (const input of inputs) {
      expect(attr(input, "type")).toBe("number");
      expect(attr(input, "min")).toBe("0");
      expect(attr(input, "max")).toBe("9");
      expect(attr(input, "inputmode")).toBe("numeric");
    }
    expect(inputs.map((i) => accessibleName(root, i))).toEqual([
      "High-severity issues no rule covers",
      "Medium-severity issues no rule covers",
      "Low-severity issues no rule covers",
    ]);
  });

  it("says what is saved, each number with what it is out of", () => {
    expect(readable(section)).toContain(
      "Saved: 2 of 8 rules marked as an issue, and 3 issues no rule covers.",
    );
    const { section: empty } = sectionOf(referencePane(buildReference()));
    expect(readable(empty)).toContain(
      "Saved: 0 of 8 rules marked as an issue, and 0 issues no rule covers.",
    );
  });

  it("puts the table in a scroll box with a name, a caption and a header for every column and row", () => {
    const boxes = all(section, (el) => hasClass(el, "table-scroll"));
    expect(boxes).toHaveLength(1);
    expect(attr(boxes[0] as El, "aria-label")).toBe("Issues found by hand, rule by rule");
    const table = byTag(section, "table")[0] as El;
    expect(readable(byTag(table, "caption")[0] as El)).toBe("Issues found by hand, rule by rule");
    expect(byTag(table, "th").filter((th) => attr(th, "scope") === "col")).toHaveLength(2);
    expect(all(table, (el) => el.name === "th" && attr(el, "scope") === "row")).toHaveLength(
      REFERENCE_RULES.length,
    );
  });
});

describe("the reference list, with no playbook chosen", () => {
  const { section } = sectionOf(withSettings(referencePane(NO_PLAYBOOK)));

  it("says who chooses one and where, and links to the place", () => {
    expect(readable(section)).toContain(REFERENCE_NO_PLAYBOOK);
    const links = byTag(section, "a");
    expect(links.map((a) => attr(a, "href"))).toEqual(["#settings"]);
    expect(readable(links[0] as El)).toBe("Go to Client and playbook");
  });

  it("still offers the counts of issues no rule covers, and no select", () => {
    expect(selectsOf(section)).toEqual([]);
    expect(byTag(section, "table")).toEqual([]);
    expect(byId(section, PILOT_ANCHORS.referenceOutside)).toBeDefined();
    expect(byTag(section, "button").map((b) => readable(b))).toEqual([REFERENCE_SAVE_LABEL]);
    expect(readable(section)).toContain(
      "Saved: 0 of 0 rules marked as an issue, and 0 issues no rule covers.",
    );
  });

  it("links to a place that is on the matter page, for the reviewing attorney who reads it", () => {
    const root = parseHtml(matterPagePilot("reviewer", { reference: NO_PLAYBOOK }));
    expect(byId(root, "settings")).toBeDefined();
    expect(violationsAddedByPanels("reviewer", { reference: NO_PLAYBOOK })).toEqual([]);
  });
});

describe("the reference list, closed by a review", () => {
  const { section } = sectionOf(referencePane(LOCKED));

  it("says that it is closed and why, and holds no form, no control and no button", () => {
    expect(readable(section)).toContain("This list is closed because a review has started.");
    expect(byTag(section, "form")).toEqual([]);
    expect(byTag(section, "button")).toEqual([]);
    expect(byTag(section, "input")).toEqual([]);
    expect(selectsOf(section)).toEqual([]);
    expect(byId(section, PILOT_ANCHORS.referenceOutside)).toBeUndefined();
  });

  it("shows the list as it was left, one row for each issue that was recorded", () => {
    const table = byTag(section, "table")[0] as El;
    expect(readable(byTag(table, "caption")[0] as El)).toBe("Reference list as it was closed");
    const rows = all(byTag(table, "tbody")[0] as El, (el) => el.name === "tr").map((tr) =>
      [...byTag(tr, "th"), ...byTag(tr, "td")].map((cell) => readable(cell)),
    );
    expect(rows).toEqual([
      ["Disclosure to advisers is allowed", "Medium", "1"],
      ["The obligations end after a fixed term", "High", "1"],
      ["No rule covers it", "High", "1"],
      ["No rule covers it", "Low", "2"],
    ]);
    expect(readable(section)).toContain(
      "Saved: 2 of 8 rules marked as an issue, and 3 issues no rule covers.",
    );
  });

  it("says so when nothing was recorded before the review started", () => {
    const { section: empty } = sectionOf(referencePane(buildReference({ state: "locked" })));
    expect(readable(empty)).toContain(REFERENCE_LOCKED_EMPTY);
    expect(byTag(empty, "table")).toEqual([]);
  });

  it("has no tab stop but the scroll box of its table", () => {
    const root = expectAccessible(referencePane(LOCKED), { fragment: true });
    expect(tabStops(root).map((el) => attr(el, "aria-label"))).toEqual([
      "Reference list as it was closed",
    ]);
  });
});

describe("who is given the section", () => {
  it("leaves it out when the service gave no list: a role that may not write it, or no view", () => {
    expect(referencePane(null)).toBe("");
    expect(referencePane(undefined)).toBe("");
  });

  it("is on the matter page of the reviewing attorney, and not on that of an associate or a viewer", () => {
    const reviewer = checkInvariants(matterPagePilot("reviewer", { reference: SAVED }));
    expect(byId(reviewer, "reference-list")).toBeDefined();
    for (const role of ["associate", "viewer"] as const) {
      const root = checkInvariants(matterPagePilot(role, { reference: null }));
      expect(byId(root, "reference-list"), role).toBeUndefined();
      expect(readable(root)).not.toContain(REFERENCE_HEADING);
    }
  });

  it("is placed after the timer and before the people, so Tab reaches it in the order of the page", () => {
    const root = checkInvariants(matterPagePilot("reviewer", { reference: SAVED }));
    const order = all(root, (el) => el.name === "section").map((s) => attr(s, "id"));
    expect(order.indexOf("reference-list")).toBeGreaterThan(order.indexOf("memos"));
    expect(order.indexOf("reference-list")).toBeLessThan(order.indexOf("people"));
  });
});

describe("keyboard and labels", () => {
  const states: [string, string][] = [
    ["open, with a saved list", referencePane(SAVED)],
    ["open, nothing saved", referencePane(buildReference())],
    ["no playbook", withSettings(referencePane(NO_PLAYBOOK))],
    ["closed", referencePane(LOCKED)],
    ["closed, empty", referencePane(buildReference({ state: "locked" }))],
  ];
  for (const [name, html] of states)
    it(`passes the accessibility rules as a pane: ${name}`, () => {
      expectAccessible(html, { fragment: true });
    });

  it("reaches the table, each select, each count and the button in reading order, and nothing twice", () => {
    const root = expectAccessible(referencePane(SAVED), { fragment: true });
    const stops = tabStops(root).map((el) => attr(el, "name") ?? attr(el, "aria-label") ?? el.name);
    expect(stops).toEqual([
      "Issues found by hand, rule by rule",
      ...REFERENCE_RULES.map((rule) => referenceSeverityField(rule.ruleKey)),
      FIELDS.outsideHigh,
      FIELDS.outsideMedium,
      FIELDS.outsideLow,
      "button",
    ]);
    expect(all(root, (el) => hasAttr(el, "tabindex") && attr(el, "tabindex") !== "0")).toEqual([]);
  });

  it("uses native controls only, with no script", () => {
    const root = expectAccessible(referencePane(SAVED), { fragment: true });
    expect(byTag(root, "script")).toEqual([]);
    expect(all(root, (el) => hasAttr(el, "data-zone"))).toEqual([]);
    expect(all(root, (el) => el.name === "div" && attr(el, "role") === "button")).toEqual([]);
  });

  it("adds no problem to the matter page: the page rules hold, and the accessibility rules find nothing the page did not have without it", () => {
    for (const reference of [SAVED, buildReference(), NO_PLAYBOOK, LOCKED]) {
      checkInvariants(matterPagePilot("reviewer", { reference }));
      expect(violationsAddedByPanels("reviewer", { reference })).toEqual([]);
    }
  });

  it("puts the button of the list after the table of reviews and before the people form", () => {
    const root = parseHtml(matterPagePilot("reviewer", { reference: SAVED }));
    const names = tabStops(root).map((el) => accessibleName(root, el));
    const at = names.indexOf("Save the reference list");
    expect(at).toBeGreaterThan(-1);
    expect(names.slice(0, at)).toContain("Open the issue table");
    expect(names.slice(at + 1)).toContain("People on this matter");
  });
});

describe("the form it posts", () => {
  it("is read by the route as the playbook's severities and three counts, from the fields the page names", () => {
    const form: Record<string, string> = { _csrf: "t" };
    for (const select of selectsOf(sectionOf(referencePane(SAVED)).section)) {
      const chosen = byTag(select, "option").find((o) => hasAttr(o, "selected")) as El;
      form[attr(select, "name") ?? ""] = attr(chosen, "value") ?? "";
    }
    for (const input of byTag(sectionOf(referencePane(SAVED)).section, "input"))
      if (attr(input, "type") === "number")
        form[attr(input, "name") ?? ""] = attr(input, "value") ?? "";
    expect(referenceListFromForm(form)).toEqual({
      rules: [
        { ruleKey: "pds-1", severity: "medium" },
        { ruleKey: "dur-1", severity: "high" },
      ],
      outsideHigh: 1,
      outsideMedium: 0,
      outsideLow: 2,
    });
  });

  it("round-trips a rule key through the field name", () => {
    for (const key of ["dur-1", "a:b", "x severity:y"])
      expect(ruleKeyOfSeverityField(referenceSeverityField(key))).toBe(key);
    expect(ruleKeyOfSeverityField("outsideHigh")).toBeNull();
    expect(ruleKeyOfSeverityField("severity:")).toBeNull();
  });
});

describe("a rule key that would collide with a place on the page", () => {
  it("never gives a select the id of another element: the keys list and outside are rules like any other", () => {
    const reference = buildReference({
      rules: [
        { ruleKey: "list", title: "A rule called list", severity: null },
        { ruleKey: "outside", title: "A rule called outside", severity: null },
        { ruleKey: "time", title: "A rule called time", severity: null },
        { ruleKey: "settings", title: "A rule called settings", severity: null },
      ],
    });
    const html = matterPagePilot("reviewer", { timer: buildTimer(), reference });
    // checkInvariants fails on a repeated id; the section ids are still where the refusals lead.
    const root = checkInvariants(html);
    for (const id of ["time", "reference-list", "reference-outside", "settings"])
      expect(
        all(root, (el) => attr(el, "id") === id),
        id,
      ).toHaveLength(1);
    expect(violationsAddedByPanels("reviewer", { timer: buildTimer(), reference })).toEqual([]);
  });
});

describe("a rule title or key the playbook could hold", () => {
  const hostile = buildReference({
    rules: [
      {
        ruleKey: "k<b>1",
        title: `<img src=x onerror=1>${String.fromCharCode(0x200b)}Term`,
        severity: "low",
      },
      { ruleKey: 'a b"c', title: 'Quote " and & ampersand', severity: null },
    ],
  });

  it("is escaped, shows an invisible character as a marker, and still labels and names its control", () => {
    const html = referencePane(hostile);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain(String.fromCharCode(0x200b));
    expect(html).toContain("&lt;img src=x");
    const root = expectAccessible(html, { fragment: true });
    const selects = byTag(root, "select");
    expect(selects).toHaveLength(2);
    // Ids are made safe for a label to point at, whatever the key holds.
    expect(new Set(selects.map((s) => attr(s, "id"))).size).toBe(2);
    for (const select of selects) expect(accessibleName(root, select).length).toBeGreaterThan(10);
    // The field name carries the key as the route reads it back.
    expect(selects.map((s) => ruleKeyOfSeverityField(attr(s, "name") ?? ""))).toEqual([
      "k<b>1",
      'a b"c',
    ]);
  });
});

describe("the words", () => {
  it("are fixed: the heading, the note, the labels and the sentences of the states", () => {
    expect(REFERENCE_HEADING).toBe("Reference list for shadow mode");
    expect(REFERENCE_NOTE).toContain("The list closes when the first review starts");
    expect(REFERENCE_SAVE_LABEL).toBe("Save the reference list");
    expect(REFERENCE_LOCKED).toBe("This list is closed because a review has started.");
    expect(REFERENCE_NO_PLAYBOOK).toContain("You can still record issues no rule covers.");
    expect(SEVERITY_LABEL).toEqual({ high: "High", medium: "Medium", low: "Low" });
    expect(OUTSIDE_LABEL.high).toBe("High-severity issues no rule covers");
    expect(severitySelectLabel("X")).toBe("Severity of the issue for X");
    expect(referenceSummary(1, 1, 1)).toBe(
      "Saved: 1 of 1 rule marked as an issue, and 1 issue no rule covers.",
    );
  });

  it("offer the severities the store accepts, in the order of the form", () => {
    expect([...SEVERITY_ORDER]).toEqual([...PILOT_SEVERITIES]);
  });

  it("are the ones the refusals lead to: every place a refusal names is on the page that shows it", () => {
    const open = parseHtml(matterPagePilot("reviewer", { reference: SAVED }));
    const jumps = Object.values(REFUSALS_PILOT.jump).map((jump) => jump.href.slice(1));
    for (const id of jumps.filter((id) => ["reference-list", "reference-outside"].includes(id)))
      expect(byId(open, id), id).toBeDefined();
    expect(REFUSALS_PILOT.jump.bad_count.href).toBe(`#${PILOT_ANCHORS.referenceOutside}`);
    expect(REFUSALS_PILOT.jump.bad_severity.href).toBe(`#${PILOT_ANCHORS.referenceList}`);
    expect(REFUSALS_PILOT.jump.duplicate_rule.href).toBe(`#${PILOT_ANCHORS.referenceList}`);
  });

  it("state no figure of their own, no rate and no claim of accuracy", () => {
    const text = [
      REFERENCE_NOTE,
      REFERENCE_NO_PLAYBOOK,
      REFERENCE_LOCKED,
      REFERENCE_LOCKED_EMPTY,
      ...Object.values(OUTSIDE_LABEL),
    ].join(" ");
    expect(text).not.toMatch(/saved|accura|adoption|%|average|faster/i);
  });
});
