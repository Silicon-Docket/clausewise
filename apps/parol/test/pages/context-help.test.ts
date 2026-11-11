import { describe, expect, it } from "vitest";
import type { EvidenceView, FindingView } from "../../src/services/views.js";
import { ContextHelp } from "../../src/server/pages/help.js";
import { contextHelp, helpGroups } from "../../src/server/views/help.js";
import { accessibleName, expectAccessible, tabStops } from "../a11y/rules.js";
import { all, attr, byId, byTag, hasAttr, hasClass, parseHtml, readable, type El } from "./html.js";
import { checkInvariants } from "./invariants.js";
import { findingPage, paneOnly } from "./render.js";
import {
  buildAllKindsFinding,
  buildConflictFinding,
  buildEvidence,
  buildFindingView,
  buildIssueRows,
} from "./support.js";
import { helpHtml } from "./training-support.js";

/**
 * The help inside the finding pane (package W2.8): only the words this finding shows, each linked to
 * its place on the help page. These tests build findings that show different words and read what the
 * disclosure lists, so it cannot list a word the finding does not show or leave one out.
 */

/** The terms of the disclosure of a pane: group title, and each term with the address it links to. */
function disclosure(html: string): { title: string; terms: [string, string][] }[] | null {
  const root = parseHtml(html);
  const found = all(root, (el) => el.name === "details" && hasClass(el, "context-help"));
  if (found.length === 0) return null;
  expect(found).toHaveLength(1);
  const details = found[0] as El;
  expect(readable(byTag(details, "summary")[0] as El)).toBe(
    "What these words mean for this finding",
  );
  const out: { title: string; terms: [string, string][] }[] = [];
  const children = details.children.filter((c): c is El => c.type === "element");
  for (const [index, child] of children.entries()) {
    if (child.name !== "p") continue;
    const list = children[index + 1] as El;
    expect(list.name).toBe("dl");
    const terms = byTag(list, "dt").map((dt): [string, string] => {
      const link = byTag(dt, "a")[0] as El;
      return [readable(link), attr(link, "href") as string];
    });
    out.push({ title: readable(child), terms });
  }
  return out;
}

const titles = (html: string): string[] => (disclosure(html) ?? []).map((g) => g.title);
const termsOf = (html: string, title: string): string[] =>
  (disclosure(html) ?? []).find((g) => g.title === title)?.terms.map(([t]) => t) ?? [];

/** A finding with a superseded passage, a flag, and no second look at any passage. */
function flaggedFinding(): FindingView {
  const base = buildFindingView();
  return {
    ...base,
    issue: {
      ...base.issue,
      verificationState: "escalated_by_system",
      escalations: [{ code: "superseded_evidence", detail: "dv_d1v1:p19" }],
    },
    evidence: base.evidence.map((e): EvidenceView => ({ ...e, supportCheck: "not_run" })),
  };
}

/** A compliant finding whose one quote was found and checked by nobody else. */
function cleanFinding(): FindingView {
  const base = buildFindingView();
  const row = buildIssueRows().find((r) => r.ruleKey === "def-1");
  return {
    ...base,
    issue: {
      ...base.issue,
      ...(row ?? {}),
      status: "compliant",
      severity: "low",
      escalations: [],
      evidenceCount: 1,
    },
    evidence: [
      buildEvidence({
        id: "ev_clean",
        spanId: "dv_d1v1:p4",
        location: "Mutual NDA (v1), Section 1.2, paragraph 4",
        quote: "marked or identified as confidential",
        role: "governing",
        spanText:
          "Confidential Information means information marked or identified as confidential.",
        supportCheck: "not_run",
      }),
    ],
  };
}

describe("the help in the finding pane, for a finding with a superseded passage, a flag and no support check", () => {
  const html = paneOnly(flaggedFinding());

  it("lists exactly the words that finding shows, in groups", () => {
    expect(titles(html)).toEqual([
      "Status and severity",
      "Flags",
      "What each passage is for",
      "Quote and support checks",
    ]);
    expect(termsOf(html, "Status and severity")).toEqual(["Deviation", "High"]);
    expect(termsOf(html, "Flags")).toEqual(["Replaced clause relied on"]);
    // Superseded is first because it is the one that changes how a passage reads.
    expect(termsOf(html, "What each passage is for")).toEqual([
      "Superseded",
      "Governing",
      "Supporting",
    ]);
    expect(termsOf(html, "Quote and support checks")).toEqual([
      "Quote found",
      "Support not checked",
    ]);
  });

  it("lists no word of another status, flag, role or check", () => {
    const text = readable(all(parseHtml(html), (el) => hasClass(el, "context-help"))[0] as El);
    for (const absent of [
      "Compliant",
      "Missing",
      "Quote not found",
      "Conflicting",
      "Definition",
      "Supported",
    ])
      expect(text).not.toContain(absent);
    expect(text).not.toContain("Sources conflict");
  });

  it("says the superseded sentence and the sentence about a quote that is found", () => {
    const text = readable(all(parseHtml(html), (el) => hasClass(el, "context-help"))[0] as El);
    expect(text).toContain(
      "A quote that is found in it is still a correct quote; what it says no longer governs.",
    );
    expect(text).toContain("The quote appears word for word in this paragraph, once.");
    expect(text).toContain("No second check was run on this passage.");
  });

  it("links every word to its place on the help page, and the place is there", () => {
    const help = parseHtml(helpHtml());
    for (const group of disclosure(html) ?? [])
      for (const [term, href] of group.terms) {
        expect(href, term).toMatch(/^\/help#[a-z][a-z0-9-]*$/);
        expect(byId(help, href.slice("/help#".length)), `${term} -> ${href}`).toBeDefined();
      }
  });

  it("is closed until it is opened, and sits before the evidence", () => {
    const root = parseHtml(html);
    const details = all(root, (el) => hasClass(el, "context-help"))[0] as El;
    expect(hasAttr(details, "open")).toBe(false);
    const pane = byTag(root, "article")[0] as El;
    const order = all(
      pane,
      (el) => hasClass(el, "context-help") || attr(el, "id") === "evidence-heading",
    );
    expect(order.map((el) => (hasClass(el, "context-help") ? "help" : "evidence"))).toEqual([
      "help",
      "evidence",
    ]);
  });

  it("takes one stop on the keyboard while closed, its summary, and a stop for each link once it is open", () => {
    const stopsOfPane = (source: string): string[] => {
      const root = parseHtml(source);
      return tabStops(root).map((el) => accessibleName(root, el));
    };
    const closed = stopsOfPane(html);
    expect(closed.filter((name) => name === "What these words mean for this finding")).toHaveLength(
      1,
    );
    expect(closed).not.toContain("Replaced clause relied on");
    // Opened, the links are reached after the summary and before the evidence, in the order read.
    const opened = stopsOfPane(
      html.replace(
        '<details class="disclosure context-help">',
        '<details class="disclosure context-help" open>',
      ),
    );
    const at = opened.indexOf("What these words mean for this finding");
    expect(opened.slice(at + 1, at + 8)).toEqual([
      "Deviation",
      "High",
      "Replaced clause relied on",
      "Superseded",
      "Governing",
      "Supporting",
      "Quote found",
    ]);
    expect(opened.length - closed.length).toBe(8);
  });

  it("meets every rule of the keyboard and the labels, as a pane and on the page of the finding", () => {
    expectAccessible(html, { fragment: true });
    const page = findingPage(flaggedFinding());
    checkInvariants(page);
    expectAccessible(page);
  });
});

describe("the help in the finding pane, for a finding that shows little", () => {
  it("has no flag entry for a finding with no flag", () => {
    const html = paneOnly(cleanFinding());
    expect(titles(html)).toEqual([
      "Status and severity",
      "What each passage is for",
      "Quote and support checks",
    ]);
    expect(termsOf(html, "Status and severity")).toEqual(["Compliant", "Low"]);
    expect(termsOf(html, "What each passage is for")).toEqual(["Governing"]);
    expect(termsOf(html, "Quote and support checks")).toEqual([
      "Quote found",
      "Support not checked",
    ]);
    expectAccessible(html, { fragment: true });
  });

  it("has no passage or check entry for a finding that cites no passage", () => {
    const base = buildFindingView();
    const html = paneOnly({ ...base, evidence: [] });
    expect(titles(html)).toEqual(["Status and severity"]);
  });

  it("lists every flag a finding carries, once each, in the order it carries them", () => {
    const base = buildConflictFinding();
    const html = paneOnly({
      ...base,
      issue: {
        ...base.issue,
        escalations: [
          { code: "playbook_escalation", detail: "a" },
          { code: "conflicting_sources", detail: "b" },
          { code: "playbook_escalation", detail: "again" },
        ],
      },
    });
    expect(termsOf(html, "Flags")).toEqual(["Playbook says escalate", "Sources conflict"]);
    expect(termsOf(html, "What each passage is for")).toEqual(["Conflicting"]);
    // The first passage was supported and the second was not enough, in the order they are cited.
    expect(termsOf(html, "Quote and support checks")).toEqual([
      "Quote found",
      "Supported",
      "Not enough to support",
    ]);
  });

  it("lists every kind of passage a finding that cites one of each shows", () => {
    const html = paneOnly(buildAllKindsFinding());
    expect(termsOf(html, "What each passage is for")).toEqual([
      "Superseded",
      "Governing",
      "Supporting",
      "Definition",
      "Conflicting",
    ]);
    expect(termsOf(html, "Quote and support checks")).toEqual(
      expect.arrayContaining(["Quote found", "Quote found more than once"]),
    );
  });
});

describe("the help in the finding pane, for a code the page has no word for", () => {
  it("leaves it out, and never repeats it", () => {
    const base = flaggedFinding();
    const hostile = "<script>window.pwned=1</script>";
    const finding = {
      ...base,
      issue: {
        ...base.issue,
        status: hostile as never,
        severity: "constructor" as never,
        escalations: [{ code: hostile as never, detail: "x" }],
      },
      evidence: base.evidence.map((e) => ({
        ...e,
        role: "__proto__" as never,
        quoteCheck: hostile as never,
        supportCheck: "toString" as never,
      })),
    };
    const groups = contextHelp(finding);
    expect(groups).toEqual([]);
    const html = paneOnly(finding);
    expect(disclosure(html)).toBeNull();
    expect(html).not.toContain("<script>window.pwned");
  });

  it("is a disclosure that is not there at all when the finding shows nothing it has words for", () => {
    const base = buildFindingView();
    const finding = {
      ...base,
      evidence: [],
      issue: { ...base.issue, status: "x" as never, severity: "y" as never, escalations: [] },
    };
    expect(ContextHelp({ finding })).toBeNull();
  });
});

describe("the terms the pane links to are the terms of the help page", () => {
  it("have the same words in the same sentence", () => {
    const page = new Map(helpGroups().flatMap((g) => g.terms.map((t) => [t.id, t] as const)));
    for (const finding of [
      flaggedFinding(),
      cleanFinding(),
      buildConflictFinding(),
      buildAllKindsFinding(),
    ])
      for (const group of contextHelp(finding))
        for (const term of group.terms) expect(page.get(term.id), term.id).toEqual(term);
  });
});
