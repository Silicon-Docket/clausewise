import { describe, expect, it } from "vitest";
import { expectAccessible, tabStops } from "../a11y/rules.js";
import { all, attr, hasAttr, hasClass, readable, withClass, type El } from "./html.js";
import { checkInvariants } from "./invariants.js";
import { runPage } from "./render.js";
import { buildRunSummary } from "./support.js";
import {
  CUT_SHORT,
  PRICED,
  UNREPORTED,
  VARIANTS_USAGE,
  modelOf,
  spendStoppedRun,
  usageOf,
  usageRun,
} from "./variants-usage.js";

/**
 * The "Usage" section of the review page and the line that says which model answered. The
 * sentences are built by the service from the recorded calls (usage/summary.ts) and the page only
 * shows them, so these tests read what the page shows against what the summary says.
 */

const page = (run = usageRun(PRICED)) => checkInvariants(runPage({ run }));

/** The section named by the heading "Usage", or undefined. */
function usageSection(root: El): El | undefined {
  return all(root, (el) => el.name === "section").find((section) => {
    const labelled = attr(section, "aria-labelledby");
    const heading = all(section, (el) => /^h[1-6]$/.test(el.name))[0];
    return (
      heading !== undefined && labelled === attr(heading, "id") && readable(heading) === "Usage"
    );
  });
}

const sentences = (section: El): string[] => all(section, (el) => el.name === "p").map(readable);

describe("the Usage section", () => {
  it("shows the sentences of the summary, in order, under a heading that names the section", () => {
    const run = usageRun(PRICED);
    const section = usageSection(page(run))!;
    expect(section).toBeDefined();
    expect(all(section, (el) => /^h[1-6]$/.test(el.name)).map(readable)).toEqual(["Usage"]);
    expect(sentences(section)).toEqual(run.usage?.lines);
    expect(sentences(section)[0]).toContain("from 9 of 9 recorded model calls.");
    expect(sentences(section)[1]).toContain("Estimated cost about $0.0123 for the 9 calls");
    expect(sentences(section)[1]).toContain("a computed estimate, not an invoice");
  });

  it("says what each state is, and prints a dollar sign only where a price was applied", () => {
    const cases: [string, ReturnType<typeof usageRun>, string[], boolean][] = [
      [
        "reported and partly priced",
        usageRun({ ...PRICED, callsPriced: 4, costUsd: 0.05 }),
        ["Estimated cost at least $0.0500: 4 of 9 calls with usage have a price."],
        true,
      ],
      [
        "reported and not priced",
        usageRun({
          ...PRICED,
          callsPriced: 0,
          costUsd: null,
          priceTables: 0,
          priceTableSha256: null,
        }),
        ["Cost: not priced. No price is configured for this model."],
        false,
      ],
      [
        "reported by some calls only",
        usageRun({ ...PRICED, callsWithUsage: 6, callsPriced: 6 }),
        ["from 6 of 9 recorded model calls. 3 reported no usage."],
        true,
      ],
      [
        "not reported",
        usageRun(UNREPORTED),
        ["The provider did not report usage for the 9 model calls of this review."],
        false,
      ],
      [
        "not reported by another provider",
        usageRun(UNREPORTED, { model: modelOf("openai", null) }, "openai"),
        [
          "Parol records usage only for the anthropic provider, so the cost of this review is not known.",
        ],
        false,
      ],
      [
        "no call yet",
        usageRun({ ...UNREPORTED, calls: 0 }),
        ["No model call has been recorded for this review yet."],
        false,
      ],
      [
        "a stand-in reader",
        usageRun(PRICED, { model: modelOf("simulated", null) }, "simulated"),
        ["No model was called, so there is no usage to record."],
        false,
      ],
    ];
    for (const [name, run, wanted, dollars] of cases) {
      const text = sentences(usageSection(page(run))!).join(" ");
      for (const sentence of wanted) expect(text, name).toContain(sentence);
      expect(text.includes("$"), name).toBe(dollars);
    }
  });

  it("is the only place the page gets the sentences from: a summary with other lines shows those", () => {
    const run = usageRun(PRICED);
    const changed = {
      ...run,
      usage: { ...usageOf(PRICED), lines: ["A sentence from the service."] },
    };
    expect(sentences(usageSection(page(changed))!)).toEqual(["A sentence from the service."]);
  });

  it("is not on the page of a run whose summary carries no usage", () => {
    const { usage: _usage, ...bare } = buildRunSummary();
    const root = page(bare);
    expect(usageSection(root)).toBeUndefined();
    expect(readable(root)).not.toContain("recorded model call");
  });

  it("is shown for a review that is still running, and for one that failed", () => {
    const running = usageRun(
      { ...PRICED, calls: 3, callsWithUsage: 3, callsPriced: 3 },
      { status: "analyzing", finishedAt: null, progress: { stage: "analyze", done: 1, total: 8 } },
    );
    expect(sentences(usageSection(page(running))!)[0]).toContain(
      "from 3 of 3 recorded model calls.",
    );
    const failed = usageRun(PRICED, { status: "failed", errorKind: "provider_auth" });
    expect(usageSection(page(failed))).toBeDefined();
  });

  it("adds no control, no link, no tab stop and no script hook", () => {
    const withUsage = page(usageRun(PRICED));
    const section = usageSection(withUsage)!;
    expect(
      all(section, (el) =>
        ["a", "button", "input", "select", "textarea", "form"].includes(el.name),
      ),
    ).toEqual([]);
    expect(all(section, (el) => hasAttr(el, "tabindex") || hasAttr(el, "onclick"))).toEqual([]);
    expect(all(section, (el) => el.attrs.some((a) => a.name.startsWith("data-")))).toEqual([]);
    const { usage: _usage, ...bare } = usageRun(PRICED);
    const without = page(bare);
    expect(tabStops(withUsage).length).toBe(tabStops(without).length);
    expect(tabStops(withUsage).filter((el) => all(section).includes(el))).toEqual([]);
  });

  it("comes after the issue table and the inspector, so the table is read first", () => {
    const html = runPage({ run: usageRun(PRICED) });
    expect(html.indexOf("run-usage-heading")).toBeGreaterThan(html.indexOf("data-issue-table"));
    expect(html.indexOf("run-usage-heading")).toBeGreaterThan(html.indexOf("data-inspector"));
  });

  it("keeps the stand-in banner above the table and says there too that no model was called", () => {
    const run = usageRun(PRICED, { model: modelOf("simulated", null) }, "simulated");
    const html = runPage({ run });
    expect(html.indexOf("banner-standin")).toBeLessThan(html.indexOf("data-issue-table"));
    expect(withClass(checkInvariants(html), "banner-standin")).toHaveLength(1);
  });
});

describe("the Usage section of a review the spend guard stopped", () => {
  it("adds, after the figures, that the calls cut short are in the day's total and not listed", () => {
    const run = spendStoppedRun();
    const lines = sentences(usageSection(page(run))!);
    expect(lines).toEqual(run.usage?.lines);
    expect(lines.at(-1)).toBe(CUT_SHORT);
    expect(lines[0]).toContain("from 4 of 4 recorded model calls.");
    expect(lines).toHaveLength(3);
  });

  it("says it for the limit of a day as for the limit of one review, and with no call recorded", () => {
    for (const run of [
      spendStoppedRun("spend_daily_limit"),
      spendStoppedRun("spend_review_limit", { ...UNREPORTED, calls: 0 }),
    ])
      expect(sentences(usageSection(page(run))!).at(-1)).toBe(CUT_SHORT);
  });

  it("is not said of a review that was not stopped by a limit, or that no model read", () => {
    for (const run of [
      usageRun(PRICED, { status: "failed", errorKind: "provider_auth" }),
      usageRun(PRICED),
      usageRun(PRICED, { model: modelOf("simulated", null) }, "simulated"),
    ])
      expect(sentences(usageSection(page(run))!).join(" ")).not.toContain("cut short");
    // A stand-in never has a spend stop, even if its summary is told so.
    const standIn = usageOf(PRICED, "simulated", { stoppedBySpend: true });
    expect(standIn.stoppedBySpend).toBe(false);
    expect(standIn.lines).toEqual(["No model was called, so there is no usage to record."]);
  });

  it("tells the person what to do, in the words of the kind, on the banner of the failed run", () => {
    expect(readable(page(spendStoppedRun()))).toContain(
      "The review stopped because its cost reached the limit for one review. What was finished is kept. Ask whoever runs this server to raise the limit, then resume: finished work is not paid for again.",
    );
    expect(readable(page(spendStoppedRun("spend_daily_limit")))).toContain(
      "The review stopped because today's cost limit was reached. What was finished is kept. Resume it after midnight UTC, or ask whoever runs this server to raise the daily limit.",
    );
  });
});

describe("the line that says which model answered", () => {
  const lineOf = (model: ReturnType<typeof modelOf>): string =>
    readable(all(page(usageRun(PRICED, { model })), (el) => hasClass(el, "run-meta"))[0] as El);

  it("names the model that answered", () => {
    const line = lineOf({ provider: "anthropic", requested: "model-a", reported: "model-a" });
    expect(line).toContain("Answered by model-a");
    expect(line).not.toContain("requested");
  });

  it("names both when the provider answered with another model than the one asked for", () => {
    const line = lineOf({
      provider: "anthropic",
      requested: "model-a",
      reported: "model-a-20260101",
    });
    expect(line).toContain("Answered by model-a-20260101 (requested model-a)");
  });

  it("says the provider did not say which model answered, and names the one asked for", () => {
    const line = lineOf({ provider: "anthropic", requested: "model-a", reported: null });
    expect(line).toContain("Requested model-a; the provider did not say which model answered");
    expect(line).not.toContain("Answered by");
  });

  it("calls a stand-in a stand-in, and does not say a model answered", () => {
    const line = lineOf({ provider: "simulated", requested: "parol-reader", reported: null });
    expect(line).toContain("Read by a scripted stand-in (simulated, parol-reader)");
    expect(line).not.toContain("Answered by");
  });
});

describe("accessibility", () => {
  it("passes the rules on every usage fixture", () => {
    for (const [name, make, options] of VARIANTS_USAGE)
      expect(
        () => expectAccessible(make(), options?.fragment === true ? { fragment: true } : {}),
        name,
      ).not.toThrow();
  });

  it("gives the section a heading in the outline, below the page's own", () => {
    const root = expectAccessible(runPage({ run: usageRun(PRICED) }));
    const headings = all(root, (el) => /^h[1-6]$/.test(el.name));
    const usage = headings.find((h) => readable(h) === "Usage")!;
    expect(usage.name).toBe("h2");
    expect(headings.find((h) => h.name === "h1")).toBeDefined();
    expect(headings.indexOf(usage)).toBeGreaterThan(headings.findIndex((h) => h.name === "h1"));
  });
});
