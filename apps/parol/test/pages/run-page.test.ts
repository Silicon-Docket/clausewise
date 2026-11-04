import { describe, expect, it } from "vitest";
import { urls } from "../../src/server/urls.js";
import { ISSUE_FILTERS, orderIssues, runHref } from "../../src/server/pages/index.js";
import type { IssueRow } from "../../src/services/views.js";
import { checkInvariants } from "./invariants.js";
import {
  all,
  attr,
  byId,
  byTag,
  first,
  hasAttr,
  hasClass,
  readable,
  textsOf,
  withClass,
  type El,
} from "./html.js";
import { runPage } from "./render.js";
import {
  IDS,
  buildConflictFinding,
  buildFindingView,
  buildIssueRows,
  buildRunSummary,
  buildStaleFinding,
} from "./support.js";

const M = IDS.matter;
const R = IDS.run;
const page = (options: Parameters<typeof runPage>[0] = {}) => checkInvariants(runPage(options));
const rowsOf = (root: El): El[] =>
  withClass(root, "issue-table").flatMap((t) =>
    all(t, (el) => el.name === "tr" && hasAttr(el, "data-issue-row")),
  );
const keysOf = (root: El): string[] =>
  rowsOf(root).map((r) => readable(first(r, (el) => el.name === "code")));

describe("orderIssues", () => {
  it("sorts by severity, then by status that needs action first, then by rule key", () => {
    expect(orderIssues(buildIssueRows()).map((r) => r.ruleKey)).toEqual([
      "dur-1", // high, deviation
      "exc-1", // high, compliant
      "def-1", // medium, deviation
      "pds-2", // medium, missing
      "gov-1", // medium, undetermined
      "pds-1", // medium, compliant
      "pty-1", // medium, compliant
      "ret-1", // low, not applicable
    ]);
  });

  it("does not change the list it is given", () => {
    const rows = buildIssueRows();
    const before = rows.map((r) => r.ruleKey);
    orderIssues(rows);
    expect(rows.map((r) => r.ruleKey)).toEqual(before);
  });

  it("puts a severity or status it does not know last instead of failing", () => {
    const rows = buildIssueRows();
    const odd = { ...rows[0]!, ruleKey: "x-1", severity: "urgent" as IssueRow["severity"] };
    const odd2 = { ...rows[0]!, ruleKey: "x-2", status: "weird" as IssueRow["status"] };
    const sorted = orderIssues([odd, odd2, ...rows]).map((r) => r.ruleKey);
    expect(sorted.indexOf("x-1")).toBeGreaterThan(sorted.indexOf("ret-1"));
    expect(sorted.indexOf("x-2")).toBeGreaterThan(sorted.indexOf("pty-1"));
  });
});

describe("the fixture rows", () => {
  it("have distinct finding ids, so a link names one row", () => {
    const ids = buildIssueRows().map((r) => r.findingId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("runHref", () => {
  it("is the shared run URL, with the finding in the query when there is one", () => {
    expect(runHref(M, R)).toBe(urls.run(M, R));
    expect(runHref(M, R, { findingId: "f_1" })).toBe(urls.run(M, R, "f_1"));
  });

  it("adds a filter before the finding, and leaves the default filter out", () => {
    expect(runHref(M, R, { filter: "open", findingId: "f_1" })).toBe(
      `${urls.run(M, R)}?filter=open&finding=f_1`,
    );
    expect(runHref(M, R, { filter: "stale" })).toBe(`${urls.run(M, R)}?filter=stale`);
    expect(runHref(M, R, { filter: "all", findingId: "f_1" })).toBe(urls.run(M, R, "f_1"));
  });

  it("escapes the finding id", () => {
    expect(runHref(M, R, { filter: "open", findingId: 'a&b="x"' })).toBe(
      `${urls.run(M, R)}?filter=open&finding=a%26b%3D%22x%22`,
    );
  });

  it("lists the filters the page offers", () => {
    expect([...ISSUE_FILTERS]).toEqual(["all", "open", "escalated", "stale"]);
  });
});

describe("RunPage issue table (screen S2)", () => {
  const root = page();

  it("shows the run's identity", () => {
    const meta = withClass(root, "run-meta")[0]!;
    expect(readable(meta)).toContain(`Run ${R}`);
    expect(readable(meta)).toContain("Workflow v2");
    expect(readable(meta)).toContain("Playbook parol-nda-recipient 1.0.0");
    expect(readable(meta)).toContain("by A. Ruiz");
    expect(readable(meta)).toContain("Finished");
  });

  it("has the five columns with scoped headers", () => {
    const table = withClass(root, "issue-table")[0]!;
    const heads = byTag(
      first(table, (el) => el.name === "thead"),
      "th",
    );
    expect(heads.map((h) => readable(h))).toEqual([
      "Severity",
      "Category and rule",
      "Status",
      "Review",
      "Flags",
    ]);
    for (const h of heads) expect(attr(h, "scope")).toBe("col");
    for (const th of byTag(
      first(table, (el) => el.name === "tbody"),
      "th",
    ))
      expect(attr(th, "scope")).toBe("row");
  });

  it("orders the rows by severity then status", () => {
    expect(keysOf(root)).toEqual([
      "dur-1",
      "exc-1",
      "def-1",
      "pds-2",
      "gov-1",
      "pds-1",
      "pty-1",
      "ret-1",
    ]);
  });

  it("shows severity, status and review state as words", () => {
    const [first_, second, third] = rowsOf(root);
    expect(readable(first_!)).toContain("High");
    expect(readable(first_!)).toContain("Deviation");
    expect(readable(first_!)).toContain("Not decided");
    expect(readable(second!)).toContain("Compliant");
    expect(readable(second!)).toContain("Accepted");
    expect(readable(third!)).toContain("Edited");
    const missing = rowsOf(root).find((r) => readable(r).includes("pds-2"))!;
    expect(readable(missing)).toContain("Missing");
    const na = rowsOf(root).find((r) => readable(r).includes("ret-1"))!;
    expect(readable(na)).toContain("Not applicable");
    expect(readable(na)).toContain("Low");
  });

  it("explains each escalation code in plain words on the row", () => {
    const row = rowsOf(root).find((r) => readable(r).includes("gov-1"))!;
    expect(readable(row)).toContain("Undetermined");
    expect(readable(row)).toContain("Sources conflict");
    expect(readable(row)).toContain("Playbook says escalate");
    expect(readable(row)).not.toContain("conflicting_sources");
    const chip = first(row, (el) => hasClass(el, "chip") && readable(el) === "Sources conflict");
    expect(attr(chip, "title")).toBe(
      "Two passages disagree and the documents do not settle which one governs.",
    );
  });

  it("says None where a row has no escalation", () => {
    const row = rowsOf(root)[0]!;
    expect(readable(all(row, (el) => el.name === "td").at(-1)!)).toBe("None");
  });

  it("selects a row with a plain link that carries ?finding=", () => {
    const row = rowsOf(root)[0]!;
    const link = first(row, (el) => el.name === "a");
    expect(attr(link, "href")).toBe(urls.run(M, R, IDS.finding));
    expect(attr(link, "href")).toContain("?finding=");
    expect(readable(link)).toBe("Duration of confidentiality obligations");
    expect(hasClass(row, "is-selected")).toBe(true);
    expect(attr(link, "aria-current")).toBe("true");
    for (const other of rowsOf(root).slice(1)) {
      expect(
        attr(
          first(other, (el) => el.name === "a"),
          "aria-current",
        ),
      ).toBeUndefined();
      expect(hasClass(other, "is-selected")).toBe(false);
    }
  });

  it("marks every row link for the keyboard script", () => {
    const links = all(root, (el) => el.name === "a" && hasAttr(el, "data-row-link"));
    expect(links).toHaveLength(8);
  });

  it("lists the keyboard shortcuts in a disclosure that works without script", () => {
    const help = byId(root, "keys-help")!;
    expect(help.name).toBe("details");
    expect(hasAttr(help, "data-keys-help")).toBe(true);
    const text = readable(help);
    for (const key of ["j", "k", "Enter", "?"]) {
      expect(byTag(help, "kbd").map((k) => readable(k))).toContain(key);
    }
    expect(text).toContain("Next row");
  });

  it("shows the matter's warnings under the table", () => {
    expect(readable(withClass(root, "run-warnings")[0]!)).toContain(
      "reads like an instruction to software",
    );
  });

  it("omits the warnings block when there are none", () => {
    expect(withClass(page({ withWarnings: false }), "run-warnings")).toHaveLength(0);
  });
});

describe("RunPage inspector", () => {
  it("shows the selected finding beside the table", () => {
    const root = page();
    const layout = withClass(root, "run-layout")[0]!;
    const [left, aside] = layout.children.filter((c): c is El => c.type === "element");
    expect(hasClass(left!, "run-table")).toBe(true);
    expect(aside!.name).toBe("aside");
    expect(attr(aside!, "aria-label")).toBe("Evidence inspector");
    // It scrolls by itself beside the table, so a keyboard must be able to reach it.
    expect(attr(aside!, "tabindex")).toBe("0");
    const pane = first(aside!, (el) => hasClass(el, "finding-pane"));
    expect(attr(pane, "data-finding")).toBe(IDS.finding);
    expect(readable(pane)).toContain("Duration of confidentiality obligations");
  });

  it("invites a choice when nothing is selected", () => {
    const root = page({ selected: null });
    expect(withClass(root, "finding-pane")).toHaveLength(0);
    expect(readable(byId(root, "inspector")!)).toContain("Choose a rule in the table");
  });

  it("says so when ?finding= named something that is not in this run", () => {
    const root = page({ selected: null, selectionMissing: true });
    expect(readable(byId(root, "inspector")!)).toContain("That finding is not part of this review");
    expect(withClass(root, "finding-pane")).toHaveLength(0);
  });

  it("shows a conflict finding with its passages side by side", () => {
    const finding = buildConflictFinding();
    const root = page({ selected: finding });
    expect(withClass(root, "passages-conflict")).toHaveLength(1);
  });

  it("keeps a selected finding visible even when the filter would hide its row", () => {
    const root = page({ filter: "stale", selected: buildFindingView() });
    expect(keysOf(root)).toEqual(["dur-1"]);
  });
});

describe("RunPage filters", () => {
  it("counts each filter and links to it", () => {
    const root = page();
    const nav = first(
      root,
      (el) => el.name === "nav" && attr(el, "aria-label") === "Filter findings",
    );
    const links = byTag(nav, "a");
    expect(links.map((l) => readable(l))).toEqual([
      "All 8",
      "Open 6",
      "Escalated 1",
      "Out of date 0",
    ]);
    expect(attr(links[0]!, "aria-current")).toBe("true");
    expect(attr(links[1]!, "href")).toBe(`${urls.run(M, R)}?filter=open&finding=${IDS.finding}`);
    expect(attr(links[0]!, "href")).toBe(urls.run(M, R, IDS.finding));
  });

  it("shows only matching rows, and keeps the filter in the row links", () => {
    const root = page({ filter: "escalated", selected: null });
    expect(keysOf(root)).toEqual(["gov-1"]);
    const link = first(rowsOf(root)[0]!, (el) => el.name === "a");
    expect(attr(link, "href")).toContain("filter=escalated");
    const current = all(
      root,
      (el) => el.name === "a" && attr(el, "aria-current") === "true" && hasClass(el, "filter"),
    );
    expect(current.map((c) => readable(c))).toEqual(["Escalated 1"]);
  });

  it("open means current and not yet decided", () => {
    const rows = buildIssueRows();
    rows[0]!.validity = "stale";
    const root = page({ issues: rows, filter: "open", selected: null });
    expect(keysOf(root)).not.toContain("exc-1");
    expect(keysOf(root)).not.toContain("def-1");
    expect(keysOf(root)).not.toContain(rows[0]!.ruleKey);
    expect(keysOf(root)).toHaveLength(5);
  });

  it("says no finding matches when a filter is empty", () => {
    const root = page({ filter: "stale", selected: null });
    expect(readable(withClass(root, "run-table")[0]!)).toContain("No finding matches this filter");
    expect(withClass(root, "issue-table")).toHaveLength(0);
  });

  it("says the review has no findings when it has none", () => {
    const root = page({ issues: [], selected: null });
    expect(readable(withClass(root, "run-table")[0]!)).toContain("This review has no findings");
  });

  it("summarises the counts in a sentence", () => {
    expect(readable(page()).replace(/\s+/g, " ")).toContain(
      "8 findings: 6 open, 1 escalated, 0 out of date.",
    );
  });
});

describe("RunPage run states", () => {
  it("shows progress instead of a table while the review runs", () => {
    const run = buildRunSummary({
      status: "analyzing",
      progress: { stage: "analyze", done: 5, total: 8 },
      finishedAt: null,
    });
    const root = page({ run, issues: [], selected: null });
    const live = withClass(root, "progress-box")[0]!;
    expect(attr(live, "aria-live")).toBe("polite");
    expect(attr(live, "data-status-url")).toBe(`/matters/${M}/runs/${R}/status`);
    expect(
      attr(
        first(live, (el) => el.name === "progress"),
        "value",
      ),
    ).toBe("5");
    expect(readable(live)).toContain("Analyzing rules: 5 of 8");
    expect(withClass(root, "issue-table")).toHaveLength(0);
  });

  it("says a failed review whose inputs changed cannot be resumed", () => {
    const run = buildRunSummary({ status: "failed", errorKind: "provider_auth", current: false });
    const banner = withClass(page({ run, issues: [], selected: null }), "banner-failed")[0]!;
    expect(readable(banner)).toContain("so it cannot be resumed");
    expect(readable(banner)).not.toContain("resume it");
    expect(
      attr(
        first(banner, (el) => el.name === "a"),
        "href",
      ),
    ).toBe(urls.matter(M));
  });

  it("explains a failed review and points to where it can be resumed", () => {
    const run = buildRunSummary({ status: "failed", errorKind: "provider_auth", current: true });
    const root = page({ run, issues: [], selected: null });
    const banner = withClass(root, "banner-failed")[0]!;
    expect(readable(banner)).toContain("did not accept the credentials");
    expect(
      attr(
        first(banner, (el) => el.name === "a"),
        "href",
      ),
    ).toBe(urls.matter(M));
  });

  it("does not repeat the error code, only its meaning", () => {
    const run = buildRunSummary({
      status: "failed",
      errorKind: "totally_new_code",
      current: false,
    });
    const root = page({ run, issues: [], selected: null });
    expect(readable(root)).not.toContain("totally_new_code");
    expect(readable(withClass(root, "banner-failed")[0]!)).toContain("no wording for");
  });

  it("warns that an out-of-date review cannot be exported and links to re-run it", () => {
    const root = page({ run: buildRunSummary({ current: false }) });
    const banner = withClass(root, "banner-stale")[0]!;
    expect(readable(banner)).toContain("This review is out of date");
    expect(readable(banner)).toContain("its memo cannot be exported");
    expect(
      attr(
        first(banner, (el) => el.name === "a"),
        "href",
      ),
    ).toBe(urls.matter(M));
  });

  it("does not call a cancelled or failed review out of date", () => {
    for (const status of ["cancelled", "failed"] as const) {
      const root = page({
        run: buildRunSummary({ status, current: false }),
        issues: [],
        selected: null,
      });
      expect(withClass(root, "banner-stale"), status).toHaveLength(0);
    }
  });

  it("shows a stale finding as out of date in the table and in the pane, with no form", () => {
    const stale = buildStaleFinding();
    const rows = buildIssueRows().map((r) => (r.findingId === IDS.finding ? stale.issue : r));
    const root = page({ issues: rows, selected: stale });
    const row = rowsOf(root)[0]!;
    expect(readable(row)).toContain("Out of date");
    expect(all(byId(root, "inspector")!, (el) => el.name === "form")).toHaveLength(0);
  });

  it("lists the texts of every chip so none is empty", () => {
    expect(textsOf(page(), "chip").every((t) => t.length > 0)).toBe(true);
  });
});
