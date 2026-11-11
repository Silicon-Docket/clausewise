import { describe, expect, it } from "vitest";
import { CHECK_IDS, CHECK_LABEL } from "../../src/server/views/labels.js";
import { expectAccessible, tabStops } from "../a11y/rules.js";
import { checkInvariants } from "./invariants.js";
import { all, hasAttr, hasClass, readable, withClass, type El } from "./html.js";
import { findingPage, paneOnly, runPage } from "./render.js";
import { buildFindingView, buildIssueRows } from "./support.js";
import {
  VARIANTS_USAGE,
  buildSettledFinding,
  buildSettledThenOpenFinding,
  rowsWithSettled,
  settledRow,
} from "./variants-usage.js";

/**
 * Settled statuses on the pages. The playbook's flags settled the status the workflow stated to
 * another one, and a reviewer must see that code, not the workflow, decided it: the issue table
 * says so under the status, and the finding says what the workflow stated, why the rule settles it
 * and that the texts beside it were written for the status the workflow stated. A finding nothing
 * settled shows none of it.
 */

const noteOf = (root: El): El | undefined => all(root, (el) => hasAttr(el, "data-settled-note"))[0];
const rowNotes = (root: El): El[] => all(root, (el) => hasAttr(el, "data-settled-row"));

describe("the finding pane", () => {
  it("opens What the review found with what the workflow stated, why, and what the status is", () => {
    const root = checkInvariants(paneOnly(buildSettledFinding()), { fragment: true });
    const note = noteOf(root)!;
    expect(readable(note)).toBe(
      "Status settled by the playbook. The workflow stated Missing; the rule is not required, so the status is Not applicable. The discrepancy and explanation below were written for the status the workflow stated.",
    );
    // At the top of the section: before the meaning of the status and before the discrepancy.
    const section = all(root, (el) => el.name === "section").find((el) =>
      el.attrs.some((a) => a.name === "aria-labelledby" && a.value === "found-heading"),
    )!;
    const children = section.children.filter((c): c is El => "name" in c);
    expect(children[0]?.name).toBe("h3");
    expect(children[1]).toBe(note);
    expect(note.name).toBe("p");
  });

  it("says so when a flag then left the status undetermined, and names no settled status", () => {
    const root = checkInvariants(paneOnly(buildSettledThenOpenFinding()), { fragment: true });
    const text = readable(noteOf(root)!);
    expect(text).toBe(
      "Status settled by the playbook, then left open. The workflow stated Missing; the rule is not required, so the playbook settles it differently, and a flag below then made the status undetermined. The discrepancy and explanation below were written for the status the workflow stated.",
    );
    expect(text).not.toContain("so the status is");
  });

  it("gives each of the three reasons in the reason's own words", () => {
    for (const [reason, status, stated] of [
      ["the rule is required", "missing", "not_applicable"],
      ["the rule is not required", "not_applicable", "missing"],
      ["the rule forbids something and a contract without it passes", "compliant", "missing"],
    ] as const) {
      const finding = buildSettledFinding({
        issue: settledRow({ status, modelStatus: stated, settlementReason: reason }),
      });
      const text = readable(noteOf(checkInvariants(paneOnly(finding), { fragment: true }))!);
      expect(text).toContain(`; ${reason}, so the status is `);
    }
  });

  it("shows nothing for a finding nothing settled, whether the field is absent or null", () => {
    for (const modelStatus of [undefined, null]) {
      const finding = buildFindingView();
      finding.issue = { ...finding.issue, modelStatus };
      const root = checkInvariants(paneOnly(finding), { fragment: true });
      expect(noteOf(root)).toBeUndefined();
      expect(readable(root)).not.toContain("settled by the playbook");
    }
  });

  it("adds no control and no tab stop to the pane", () => {
    const settled = checkInvariants(paneOnly(buildSettledFinding()), { fragment: true });
    const note = noteOf(settled)!;
    expect(
      all(note, (el) => ["a", "button", "input", "select", "textarea"].includes(el.name)),
    ).toEqual([]);
    expect(all(note, (el) => hasAttr(el, "tabindex") || hasAttr(el, "onclick"))).toEqual([]);
    // Nothing inside the paragraph, and not the paragraph, is a stop of the pane.
    const stops = tabStops(settled);
    expect(stops.filter((el) => el === note || all(note).includes(el))).toEqual([]);
  });

  it("shows the trail row with its label, and the label is a plain phrase", () => {
    const root = checkInvariants(paneOnly(buildSettledFinding()), { fragment: true });
    expect(readable(root)).toContain("The status was settled by the playbook");
    expect(CHECK_IDS).toContain("status_settled");
    expect(CHECK_LABEL.status_settled).toBe("The status was settled by the playbook");
  });
});

describe("the finding page", () => {
  it("carries the same note", () => {
    const root = checkInvariants(findingPage(buildSettledFinding()));
    expect(readable(noteOf(root)!)).toContain("Status settled by the playbook.");
    expect(readable(noteOf(root)!)).toContain("The workflow stated Missing");
  });
});

describe("the issue table of the run page", () => {
  it("says under the status of the settled row what the workflow stated, and under no other", () => {
    const root = checkInvariants(runPage({ issues: rowsWithSettled() }));
    const notes = rowNotes(root);
    expect(notes).toHaveLength(1);
    expect(readable(notes[0]!)).toBe("Settled by the playbook; the workflow stated Missing");
    // It is inside the row of ret-1 and nowhere else.
    const rows = all(root, (el) => hasAttr(el, "data-issue-row"));
    const settled = rows.filter((row) => rowNotes(row).length > 0);
    expect(settled).toHaveLength(1);
    expect(readable(settled[0]!)).toContain("Return or destruction of information");
    expect(hasClass(notes[0]!, "row-sub")).toBe(true);
  });

  it("shows no note when no row was settled", () => {
    const root = checkInvariants(runPage({ issues: buildIssueRows() }));
    expect(rowNotes(root)).toEqual([]);
  });

  it("keeps one focusable row for the keys: the note adds no stop and no link", () => {
    const withNote = checkInvariants(runPage({ issues: rowsWithSettled() }));
    const without = checkInvariants(runPage({ issues: buildIssueRows() }));
    const stops = (root: El) => tabStops(root).length;
    expect(stops(withNote)).toBe(stops(without));
    const note = rowNotes(withNote)[0]!;
    expect(all(note, (el) => el.name === "a" || hasAttr(el, "tabindex"))).toEqual([]);
  });
});

describe("accessibility", () => {
  it("passes the rules on every page of the settled fixtures", () => {
    expect(VARIANTS_USAGE.length).toBeGreaterThan(3);
    for (const [name, make, options] of VARIANTS_USAGE)
      expect(
        () => expectAccessible(make(), options?.fragment === true ? { fragment: true } : {}),
        name,
      ).not.toThrow();
  });

  it("reaches the settled paragraph in reading order, with the heading of its section before it", () => {
    const root = expectAccessible(paneOnly(buildSettledFinding()), { fragment: true });
    const headings = all(root, (el) => /^h[1-6]$/.test(el.name)).map((el) => readable(el));
    expect(headings).toContain("What the review found");
    expect(withClass(root, "basis").some((el) => hasAttr(el, "data-settled-note"))).toBe(true);
  });
});
