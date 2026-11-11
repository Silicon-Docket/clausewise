import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IssueRow } from "../../src/services/views.js";
import { urls } from "../../src/server/urls.js";
import { WordsHelp } from "../../src/server/pages/help.js";
import { render } from "../../src/server/pages/index.js";
import { expectAccessible, tabStops, accessibleName } from "../a11y/rules.js";
import { all, attr, byId, byTag, hasAttr, hasClass, parseHtml, readable, type El } from "./html.js";
import { checkInvariants } from "./invariants.js";
import { runPage } from "./render.js";
import { buildIssueRows } from "./support.js";

/**
 * The help on the review page (package W2.8): "What the words mean", after the keyboard list. It
 * lists the statuses, severities and passage roles and the flags the review carries, and it must not
 * take the keyboard list's place: the `?` key still opens that list and no other.
 */

const rows = buildIssueRows();

/** The flags a list of rows carries, once each. */
const flagsOf = (list: readonly IssueRow[]): string[] => [
  ...new Set(list.flatMap((row) => row.escalations.map((e) => e.code))),
];

/** The titles of the groups in the disclosure, and each group's terms. */
function groupsOf(root: El): { title: string; terms: string[] }[] {
  const details = byId(root, "words-help") as El;
  const out: { title: string; terms: string[] }[] = [];
  const children = details.children.filter((c): c is El => c.type === "element");
  children.forEach((child, index) => {
    if (child.name !== "p" || byTag(child, "strong").length === 0) return;
    const list = children[index + 1] as El;
    out.push({ title: readable(child), terms: byTag(list, "dt").map((dt) => readable(dt)) });
  });
  return out;
}

describe("the help on the review page", () => {
  const html = runPage();
  const root = checkInvariants(html);
  const details = byId(root, "words-help") as El;

  it("is a disclosure that is closed until opened, with a summary that says what it is", () => {
    expect(details.name).toBe("details");
    expect(hasClass(details, "disclosure")).toBe(true);
    expect(hasAttr(details, "open")).toBe(false);
    expect(readable(byTag(details, "summary")[0] as El)).toBe("What the words mean");
  });

  it("comes after the keyboard list, and is not the keyboard list", () => {
    const elements = all(
      root,
      (el) => attr(el, "id") === "keys-help" || attr(el, "id") === "words-help",
    );
    expect(elements.map((el) => attr(el, "id"))).toEqual(["keys-help", "words-help"]);
    expect(hasAttr(byId(root, "keys-help") as El, "data-keys-help")).toBe(true);
    expect(hasAttr(details, "data-keys-help")).toBe(false);
    expect(all(root, (el) => hasAttr(el, "data-keys-help"))).toHaveLength(1);
  });

  it("is left alone by the script: the ? key reaches the keyboard list and nothing else", () => {
    const script = readFileSync(join(import.meta.dirname, "../../public/parol.js"), "utf8");
    expect([...script.matchAll(/data-keys-help/g)]).toHaveLength(1);
    expect(script).not.toContain("words-help");
    expect(script).not.toContain("context-help");
  });

  it("lists the statuses, the severities and the passage roles, and the flags this review carries", () => {
    const groups = groupsOf(root);
    expect(groups.map((g) => g.title)).toEqual([
      "Statuses",
      "Severity",
      "Flags in this review",
      "What a passage is for",
    ]);
    expect(groups[0]!.terms).toEqual([
      "Deviation",
      "Missing",
      "Undetermined",
      "Compliant",
      "Not applicable",
    ]);
    expect(groups[1]!.terms).toEqual(["High", "Medium", "Low"]);
    // The rows of the fixture carry two flags, and these are the two.
    expect(flagsOf(rows)).toEqual(["conflicting_sources", "playbook_escalation"]);
    expect(groups[2]!.terms).toEqual(["Sources conflict", "Playbook says escalate"]);
    expect(groups[3]!.terms).toEqual([
      "Governing",
      "Supporting",
      "Definition",
      "Superseded",
      "Conflicting",
    ]);
  });

  it("lists no flag that no row carries", () => {
    const text = readable(details);
    for (const absent of [
      "Quote not found",
      "Too long to analyze",
      "No status given",
      "Client name differs",
    ])
      expect(text).not.toContain(absent);
  });

  it("leaves the group of flags out when no row carries one", () => {
    const calm = rows.map((row) => ({
      ...row,
      escalations: [],
      verificationState: "verified" as const,
    }));
    const bare = checkInvariants(runPage({ issues: calm }));
    expect(groupsOf(bare).map((g) => g.title)).toEqual([
      "Statuses",
      "Severity",
      "What a passage is for",
    ]);
  });

  it("lists every flag a review carries, once each, in the order of the vocabulary", () => {
    const many = rows.map((row, index) => ({
      ...row,
      escalations:
        index === 0
          ? [
              { code: "model_abstained" as const, detail: "a" },
              { code: "quote_not_verified" as const, detail: "b" },
              { code: "model_abstained" as const, detail: "again" },
            ]
          : row.escalations,
    }));
    const flags = groupsOf(checkInvariants(runPage({ issues: many }))).find(
      (g) => g.title === "Flags in this review",
    );
    // quote_not_verified comes before model_abstained in the vocabulary, whichever row had it first.
    expect(flags!.terms).toEqual([
      "Quote not found",
      "Sources conflict",
      "Playbook says escalate",
      "No status given",
    ]);
  });

  it("links to all the words on the help page", () => {
    const link = all(details, (el) => el.name === "a");
    expect(link.map((l) => readable(l))).toEqual(["All the words"]);
    expect(attr(link[0] as El, "href")).toBe(urls.help());
  });

  it("gives its words no anchors of their own, so that no id repeats on a page that has the finding's help too", () => {
    expect(all(details, (el) => hasAttr(el, "id") && el !== details)).toEqual([]);
  });

  it("meets every rule of the keyboard and the labels, and is reached by one stop, its summary and its link", () => {
    expectAccessible(html);
    const names = tabStops(root).map((el) => accessibleName(root, el));
    const summary = names.indexOf("What the words mean");
    expect(summary).toBeGreaterThan(names.indexOf("Keyboard shortcuts"));
    // A closed disclosure's link is not a stop; the summary is.
    expect(names.filter((n) => n === "What the words mean")).toHaveLength(1);
  });

  it("renders by itself too, for a run with no rows", () => {
    const alone = parseHtml(render(WordsHelp({ rows: [] })));
    expect(readable(byTag(alone, "summary")[0] as El)).toBe("What the words mean");
  });
});
