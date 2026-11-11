import { describe, expect, it } from "vitest";
import {
  DECISION_LABEL,
  MODE_WORDS,
  NOT_A_RECOMMENDATION,
  NOT_CLEAN,
  PROBLEM_ACTION,
  WHY_NOT_LABEL,
  draftPromotionRecord,
  sealComparisonPage,
  pageFileName,
  parseComparisonPage,
  type ComparisonBody,
} from "../../src/evaluations/index.js";
import { expectAccessible, accessibleName, tabStops } from "../a11y/rules.js";
import {
  CASE_KEY,
  D1_TERM,
  D2_DELETES,
  comparisonBody,
  comparisonPage,
  devSection,
  gateViews,
  heldoutBody,
  liveBody,
  sideFacts,
} from "../evaluations/fixtures.js";
import {
  chrome,
  comparisonHtml,
  comparisonView,
  listHtml,
  memorySource,
} from "../evaluations/render.js";
import { all, attr, byTag, hasAttr, hasClass, parseHtml, type El, type Node } from "./html.js";
import { checkInvariants } from "./invariants.js";
import { VARIANTS_EVALUATIONS } from "./variants-evaluations.js";

/**
 * The evaluation comparison page, from documents made by hand and shown through the real service.
 * The page only reads: these tests hold it to showing every gate, every denominator and every
 * label of a scripted run, to offering no way to promote anything, and to being usable by keyboard
 * alone. Each page is also held to the page invariants and to the accessibility rules.
 */

const SLOT = { caseKey: CASE_KEY, ruleKey: "dur-1" } as const;

const mainOf = (root: El): El => byTag(root, "main")[0] as El;

/**
 * What a person reads from an element: its text, a space between one element and the next (the test
 * reader's own `readable` joins them), and the draft's box left out unless asked for. The box holds
 * a copy of the page's capital words, so counting them with it would count them twice.
 */
function said(node: Node, keepBox = false): string {
  const parts: string[] = [];
  const visit = (n: Node): void => {
    if (n.type === "text") {
      parts.push(n.text);
      return;
    }
    if (n.name === "textarea" && !keepBox) return;
    parts.push(" ");
    for (const child of n.children) visit(child);
    parts.push(" ");
  };
  visit(node);
  return parts.join("").replace(/\s+/g, " ").trim();
}

const textOfMain = (html: string): string => said(mainOf(parseHtml(html)));
const marks = (root: El): string[] => all(root, (el) => el.name === "mark").map((m) => said(m));

describe("every fixture of the page", () => {
  it("has some", () => {
    expect(VARIANTS_EVALUATIONS.length).toBeGreaterThanOrEqual(10);
  });

  for (const [name, make] of VARIANTS_EVALUATIONS) {
    it(`${name}: satisfies the page invariants and the accessibility rules`, () => {
      const html = make();
      checkInvariants(html);
      const root = expectAccessible(html);
      // One h1, no positive tabindex, and every tab stop is something a person can use.
      expect(byTag(root, "h1")).toHaveLength(1);
      expect(all(root, (el) => Number(attr(el, "tabindex")) > 0)).toEqual([]);
      expect(tabStops(root).length).toBeGreaterThan(3);
    });
  }
});

describe("the list", () => {
  it("says when nothing has been published, and gives the commands that publish", () => {
    const html = listHtml(memorySource([]));
    const text = textOfMain(html);
    expect(text).toContain("No comparison has been published to this application.");
    expect(text).toContain(
      "pnpm eval:parol --simulate --workflow v1 --out evals/results/sim-v1.json",
    );
    expect(text).toContain(
      "pnpm eval:parol --simulate --workflow v2 --compare evals/results/sim-v1.json --out evals/results/sim-v2.json --publish ./data/parol",
    );
    expect(text).toContain("PAROL_DATA_DIR");
    expect(byTag(parseHtml(html), "table")).toHaveLength(0);
    expect(text).not.toContain("Scripted or replayed runs");
  });

  it("gives each comparison a row with its two workflows, their modes in capitals and its gate counts", () => {
    const sim = comparisonPage();
    const scripted = comparisonPage(
      {
        sides: {
          baseline: sideFacts("v1", { mode: "selftest" }),
          candidate: sideFacts("v2", { mode: "replay" }),
        },
        sections: [
          devSection(),
          devSection({ split: "heldout", gates: { baseline: null, candidate: null } }),
        ],
      },
      "scripted",
    );
    const live = comparisonPage(liveBody(), "live");
    const html = listHtml(memorySource([sim, scripted, live]));
    const root = parseHtml(html);
    const rows = all(root, (el) => el.name === "tr").slice(1);
    expect(rows).toHaveLength(3);
    const [simRow, scriptedRow, liveRow] = rows.map((r) => said(r));
    expect(simRow).toContain("v1 SIMULATED");
    expect(simRow).toContain("v2 SIMULATED");
    expect(simRow).toContain(sim.id.slice(0, 12));
    // 14 gates, counted from the candidate: 8 pass, 1 fail, 5 not evaluated.
    expect(simRow).toContain("Dev: 8 pass, 1 fail, 5 not evaluated of 14");
    expect(scriptedRow).toContain("v1 SELFTEST");
    expect(scriptedRow).toContain("v2 REPLAY");
    expect(scriptedRow).toContain("Dev, Held-out");
    expect(scriptedRow).toContain("Held-out: No gate report");
    expect(liveRow).toContain("v1 Live");
    expect(liveRow).not.toContain("SIMULATED");
    // Each row's link leads to its comparison, built from the url table.
    const hrefs = all(
      root,
      (el) => el.name === "a" && (attr(el, "href") ?? "").includes("comparison="),
    );
    expect(hrefs.map((a) => attr(a, "href"))).toEqual(
      [sim, scripted, live].map((p) => `/evaluations?comparison=${p.id}`),
    );
  });

  it("warns once, in capitals, when any comparison is scripted or replayed, and not otherwise", () => {
    const warned = textOfMain(listHtml(memorySource([comparisonPage()])));
    expect(warned).toContain(
      "Some comparisons below involve a SELFTEST, a SIMULATED run or a REPLAY. See each comparison.",
    );
    const live = textOfMain(listHtml(memorySource([comparisonPage(liveBody())])));
    expect(live).not.toContain("SELFTEST");
    expect(live).not.toContain("Scripted or replayed runs");
  });

  it("shows a file that cannot be used with the problem in words and what to do, and no content", () => {
    const html = listHtml(
      memorySource(
        [],
        [
          { name: "cmp_aaaaaaaaaaaaaaaa.json", problem: "fingerprint_mismatch" },
          { name: "cmp_bbbbbbbbbbbbbbbb.json", problem: "too_large" },
        ],
      ),
    );
    const text = textOfMain(html);
    expect(text).toContain("cmp_aaaaaaaaaaaaaaaa.json");
    expect(text).toContain("Changed after it was written");
    expect(text).toContain(PROBLEM_ACTION.fingerprint_mismatch);
    expect(text).toContain("File too large");
    expect(text).toContain(PROBLEM_ACTION.too_large);
    expect(text).not.toContain("No comparison has been published");
  });

  it("says when files are left out of the list", () => {
    const source = memorySource([comparisonPage()]);
    const truncated = { ...source, list: () => ({ ...source.list(), truncated: true }) };
    expect(textOfMain(listHtml(truncated))).toContain("Only the newest are shown.");
    expect(textOfMain(listHtml(source))).not.toContain("Only the newest are shown.");
  });
});

describe("a comparison", () => {
  const page = comparisonPage();
  const html = comparisonHtml(page);
  const root = parseHtml(html);
  const text = said(mainOf(root));

  it("shows both versions, their pins and what they were run on", () => {
    expect(text).toContain("v1 against v2");
    expect(text).toMatch(/Workflow v1 [0-9a-f]{12}/);
    expect(text).toMatch(/Workflow v2 [0-9a-f]{12}/);
    expect(text).toContain("Retrieval R1");
    expect(text).toContain("Retrieval R2");
    expect(text).toContain("Model requested parol-simulated-reader");
    expect(text).toContain("Model reported not reported (A scripted stand-in reports no model.)");
    expect(text).toContain("Results file sim-v1.json");
    expect(text).toContain("Results file sim-v2.json");
    expect(text).toContain("Dataset parol-cases v1");
    expect(text).toContain("Playbook parol-nda-recipient 1.0.1");
    expect(text).toContain("Evaluation version parol-eval v2");
    // Every pin that differs, with its status in words.
    expect(text).toContain("workflow label v1 v2 Declared variable");
    expect(text).toContain("workflow retrieval R1 R2 Declared variable");
  });

  it("says in capitals, once, that the runs are simulated", () => {
    expect(text.split(MODE_WORDS.simulated)).toHaveLength(2);
    expect(text).not.toContain(MODE_WORDS.selftest);
    expect(text).not.toContain(MODE_WORDS.replay);
    const banners = all(root, (el) => el.name === "section" && hasClass(el, "banner"));
    expect(banners).toHaveLength(1);
    expect(hasClass(banners[0] as El, "banner-standin")).toBe(true);
  });

  it("shows all fourteen gates for both versions, each with an outcome chip and its reason in view", () => {
    const table = byTag(root, "table").find((t) =>
      said(byTag(t, "caption")[0] as El).startsWith("Release gates"),
    ) as El;
    const rows = byTag(table, "tbody").flatMap((tbody) => byTag(tbody, "tr"));
    expect(rows).toHaveLength(14);
    const ids = rows.map((row) => said(byTag(row, "th")[0] as El).split(" ")[0]);
    expect(ids).toEqual([
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
      "G6",
      "G7",
      "G8",
      "G9",
      "G10",
      "G11",
      "G12",
      "G13",
      "G14",
    ]);
    for (const row of rows) {
      const cells = byTag(row, "td");
      expect(cells).toHaveLength(3);
      const chips = (cells.slice(1) as El[]).map((cell) =>
        all(cell, (el) => hasClass(el, "chip")).map((c) => said(c)),
      );
      expect(chips[0]).toHaveLength(1);
      expect(chips[1]).toHaveLength(1);
      expect(["Pass", "Fail", "Not evaluated"]).toContain(chips[0]?.[0]);
    }
  });

  it("puts the reason a gate was not evaluated in the cell, outside any disclosure", () => {
    const reasons = all(root, (el) => hasClass(el, "eval-gate-reason"));
    expect(reasons).toHaveLength(28);
    const notEvaluated = gateViews().filter((g) => g.outcome === "not_evaluated");
    expect(notEvaluated.length).toBeGreaterThan(4);
    for (const gate of notEvaluated) {
      const found = reasons.filter((r) => said(r) === gate.detail);
      expect(found, gate.id).toHaveLength(2);
      for (const reason of found) {
        // Not inside a <details>: it is read without opening anything.
        const inside = all(root, (el) => el.name === "details").some(
          (d) => all(d, (x) => x === reason).length > 0,
        );
        expect(inside).toBe(false);
      }
    }
    // The counts of a gate that was tested are in a disclosure with a name that says which.
    const summaries = byTag(root, "summary").map((s) => said(s));
    expect(summaries).toContain("Counts for G2, baseline");
    expect(summaries).toContain("Counts for G6, candidate");
    expect(summaries.every((s) => s.startsWith("Counts for G"))).toBe(true);
  });

  it("shows the metrics as given, with the counts beside the rates", () => {
    const table = byTag(root, "table").find((t) =>
      said(byTag(t, "caption")[0] as El).startsWith("Metrics"),
    ) as El;
    const rows = byTag(byTag(table, "tbody")[0] as El, "tr");
    expect(rows).toHaveLength(14);
    expect(said(rows[0] as El)).toBe(
      "Issue recall (strict) 0.38 (3 of 8) 0.50 (4 of 8) +0.12 n/a n/a",
    );
    expect(text).toContain(
      "Change is the candidate minus the baseline, in the unit of the metric. A cell without data is n/a. Latency and cost are never shown for a scripted run.",
    );
  });

  it("gives the denominators of what was run and of the slots that changed", () => {
    expect(text).toContain("Baseline: 1 of 14 cases of the split, 1 repeat scored.");
    expect(text).toContain("Candidate: 1 of 14 cases of the split, 1 repeat scored.");
    expect(text).toContain("At least one of the two runs did not cover the whole split.");
    expect(text).toContain(
      "2 of 8 paired slots changed (0 not paired). Regressions are listed first.",
    );
  });

  it("says the held-out split is absent, and says nothing about which run covered it", () => {
    expect(text).toContain("The held-out split is not in this comparison.");
    // The document has no field that says which results file ran which split, so the page cannot
    // say that neither did.
    expect(text).not.toContain("neither");
  });

  it("does not say neither file ran the held-out split beside the note that one file did not", () => {
    // The note a comparison records when one side has a held-out section and the other has none.
    const note = "The candidate has no heldout section, so it is not compared.";
    const oneSided = comparisonPage(comparisonBody({ notes: [note] }), "one sided");
    const one = textOfMain(comparisonHtml(oneSided));
    expect(one).toContain(note);
    expect(one).toContain("The held-out split is not in this comparison.");
    expect(one).not.toContain("neither");
    expect(one).not.toContain("ran it");
  });

  it("lists the changed slots with a link whose name says which slot it opens", () => {
    const table = byTag(root, "table").find((t) =>
      said(byTag(t, "caption")[0] as El).startsWith("Slots whose"),
    ) as El;
    const rows = byTag(byTag(table, "tbody")[0] as El, "tr");
    expect(rows).toHaveLength(2);
    const links = rows.map((row) => all(row, (el) => el.name === "a")[0] as El);
    expect(links.map((a) => accessibleName(root, a))).toEqual([
      "Open the trail for PAROL-D05, dur-1",
      "Open the trail for PAROL-D05, ret-1",
    ]);
    expect(links.map((a) => attr(a, "href"))).toEqual([
      `/evaluations?comparison=${page.id}&split=dev&case=PAROL-D05&rule=dur-1#trail`,
      `/evaluations?comparison=${page.id}&split=dev&case=PAROL-D05&rule=ret-1#trail`,
    ]);
    const row = said(rows[0] as El);
    expect(row).toContain("compliant x1, 0 of 1 right");
    expect(row).toContain("Missed an issue and raised no flag");
    expect(row).toContain("deviation x1, 1 of 1 right");
    expect(row).toContain("Improvement");
  });

  it("says the decision rule was not applied, with the file's reason, when it was not", () => {
    expect(text).toContain("Decision rule The decision rule was not applied: it needs a live run");
    expect(text).not.toContain("Gate result under the decision rule");
  });

  it("ends with the footer note: a file, not a proof", () => {
    expect(text).toContain(
      "This page shows a file written by the evaluation command. It does not prove who made the file or that a model was called.",
    );
  });
});

describe("the page never offers promotion", () => {
  const live = comparisonPage(liveBody(), "live");

  it("cannot be given a label of its own for the outcome: a document that carries one is refused", () => {
    const body = liveBody();
    (body.sections[0]!.decision as unknown as Record<string, unknown>).label =
      "RECOMMEND PROMOTION NOW";
    const forged = sealComparisonPage(body);
    expect(parseComparisonPage(JSON.stringify(forged), pageFileName(forged.id))).toEqual({
      ok: false,
      problem: "not_a_comparison",
    });
  });

  it("states the decision rule's outcome as a gate result, in the application's words, whatever else the file says", () => {
    const body = liveBody();
    body.sections[0]!.decision!.reasons = ["RECOMMEND PROMOTION NOW"];
    body.sections[0]!.notes = ["Promote this version."];
    const text = textOfMain(comparisonHtml(sealComparisonPage(body)));
    expect(text).toContain(`Gate result under the decision rule: ${DECISION_LABEL.promote}`);
    expect(text).toContain(NOT_A_RECOMMENDATION);
    expect(text).toContain("Conditions of the rule that this comparison cannot check");
    // What the file wrote is shown as what the file wrote, beside the application's own sentence.
    expect(text).toContain("RECOMMEND PROMOTION NOW");
    const plain = textOfMain(comparisonHtml(live));
    expect(plain).toContain("Every gate passed and no slot got worse.");
  });

  it("has no form, no button, no input and no link that leads to promotion, on any page", () => {
    for (const [name, make] of VARIANTS_EVALUATIONS) {
      const root = parseHtml(make());
      const main = mainOf(root);
      expect(
        all(main, (el) => el.name === "form" || el.name === "button" || el.name === "input"),
        name,
      ).toEqual([]);
      for (const a of all(root, (el) => el.name === "a"))
        expect((attr(a, "href") ?? "").toLowerCase(), name).not.toContain("promot");
      // Nor a path that writes: every link of the page is a read of this page or a place on it.
      for (const a of all(main, (el) => el.name === "a")) {
        const href = attr(a, "href") ?? "";
        expect(href.startsWith("#") || href.startsWith("/evaluations"), `${name}: ${href}`).toBe(
          true,
        );
      }
    }
  });

  it("uses the words promote and recommend only inside the application's fixed phrases", () => {
    const plain = comparisonPage();
    for (const p of [plain, live]) {
      const root = parseHtml(comparisonHtml(p));
      // The draft is text in a box and holds the same phrases; the rest of the page is checked here.
      const box = all(root, (el) => el.name === "textarea")[0] as El;
      let rest = said(mainOf(root)).replace(said(box), "");
      for (const label of Object.values(DECISION_LABEL)) rest = rest.split(label).join("");
      rest = rest.split(NOT_A_RECOMMENDATION).join("");
      expect(rest).not.toMatch(/recommend/i);
      expect(rest).not.toMatch(/\bpromote\b/i);
    }
  });

  it("puts the draft in a read-only box, labelled, whose text is the draft of the shown split", () => {
    const view = comparisonView(live);
    const root = parseHtml(comparisonHtml(live));
    const box = all(root, (el) => el.name === "textarea")[0] as El;
    expect(hasAttr(box, "readonly")).toBe(true);
    expect(accessibleName(root, box)).toBe("Draft text for the Dev split");
    expect(said(box, true)).toBe(said({ type: "text", text: draftPromotionRecord(live, "dev") }));
    expect(view.draft).toBe(draftPromotionRecord(live, "dev"));
    // The text itself, line breaks included, after the one newline a browser would drop.
    const text = box.children.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toBe(`\n${draftPromotionRecord(live, "dev")}`);
  });
});

describe("a run that was not clean, and runs that were live", () => {
  const live = comparisonPage(liveBody(), "live");
  const root = parseHtml(comparisonHtml(live));
  const text = said(mainOf(root));

  it("says NOT A CLEAN MEASUREMENT for the side that was not clean, with its problems, and for it alone", () => {
    const banners = all(root, (el) => el.name === "section" && hasClass(el, "banner-failed"));
    expect(banners).toHaveLength(1);
    expect(said(banners[0] as El)).toContain(`${NOT_CLEAN}: the candidate run`);
    expect(said(banners[0] as El)).toContain("2 calls were lost on the wire.");
    expect(text).not.toContain(`${NOT_CLEAN}: the baseline run`);
  });

  it("has no capital banner for a live run, and shows the model as requested and as reported", () => {
    for (const words of Object.values(MODE_WORDS)) expect(text).not.toContain(words);
    expect(text).toContain("Model requested model-requested-1");
    expect(text).toContain("Model reported model-reported-1");
    expect(text).toContain("Model reported not reported (The provider reported no model.)");
    expect(text).toContain("Endpoint https://models.example.org/v1");
    expect(text).toContain("uncommitted changes");
  });

  it("lists the slots a failed G12 names, each a link to its trail", () => {
    const cell = all(root, (el) => el.name === "td").find((td) =>
      said(td).includes("Slots that regressed"),
    );
    expect(cell).toBeDefined();
    const link = all(cell as El, (el) => el.name === "a")[0] as El;
    expect(said(link)).toBe("PAROL-D05 dur-1");
    expect(attr(link, "href")).toBe(
      `/evaluations?comparison=${live.id}&split=dev&case=PAROL-D05&rule=dur-1#trail`,
    );
  });
});

describe("the evidence trail of a slot", () => {
  const page = comparisonPage();
  const html = comparisonHtml(page, SLOT);
  const root = parseHtml(html);
  const trail = byTag(root, "section").find((s) => attr(s, "aria-labelledby") === "trail") as El;

  it("is a section whose heading takes focus from a link to #trail, and leads back to the slots", () => {
    const heading = byTag(trail, "h2")[0] as El;
    expect(attr(heading, "id")).toBe("trail");
    expect(attr(heading, "tabindex")).toBe("-1");
    expect(said(heading)).toBe("Evidence trail for PAROL-D05 dur-1");
    const back = all(trail, (el) => el.name === "a" && attr(el, "href") === "#changes");
    expect(back.length).toBeGreaterThan(0);
    expect(byTag(root, "section").some((s) => attr(s, "id") === "changes")).toBe(true);
  });

  it("says what the page shows and does not show, by the mode of each run", () => {
    const text = said(trail);
    expect(text).toContain(
      "This page shows where each version looked and what it cited. It does not show what it wrote.",
    );
    expect(text).toContain("The simulated reader answers only the worked example (PAROL-D05)");
    const mixed = comparisonPage(
      {
        sides: {
          baseline: sideFacts("v1", { mode: "selftest" }),
          candidate: sideFacts("v2", { mode: "live" }),
        },
      },
      "mixed",
    );
    const mixedText = said(
      byTag(parseHtml(comparisonHtml(mixed, SLOT)), "section").find(
        (s) => attr(s, "aria-labelledby") === "trail",
      ) as El,
    );
    expect(mixedText).toContain(
      "Baseline: The selftest oracle writes no answer; it reads the key.",
    );
    expect(mixedText).toContain(
      "Candidate: The answers of that run are in its recording, if one was written.",
    );
  });

  it("shows the answer key and the passages it points at, with the key's words marked", () => {
    const key = all(trail, (el) => el.name === "div" && hasClass(el, "eval-trail"))[0] as El;
    expect(said(key)).toContain("The answer key");
    expect(said(key)).toContain("Expected status Deviation");
    expect(said(key)).toContain("The amendment deletes the term of the NDA");
    const figures = all(key, (el) => el.name === "figure");
    expect(figures).toHaveLength(2);
    expect(said(figures[0] as El)).toContain(
      "D2, Amendment No. 1 (version 1), clause 2, paragraph 3, governing in the key",
    );
    expect(said(figures[0] as El)).toContain(D2_DELETES);
    expect(marks(figures[0] as El)).toEqual(["Section 6.1 of the Agreement is deleted"]);
    expect(said(figures[1] as El)).toContain(D1_TERM);
    expect(marks(figures[1] as El)).toEqual(["five (5) years"]);
  });

  it("shows, for each version and repeat, what it was shown, what it cited with the quote marked, and the checks", () => {
    const sides = all(trail, (el) => el.name === "div" && hasClass(el, "eval-trail")).slice(1);
    expect(sides.map((s) => said(byTag(s, "h3")[0] as El))).toEqual(["Baseline", "Candidate"]);
    const [baseline, candidate] = sides as [El, El];

    const b = said(baseline);
    expect(b).toContain("0 of 1 repeat right.");
    expect(b).toContain("Repeat 1 Compliant Wrong Silent miss");
    expect(b).toContain("Shown to the reader: D1-p19 (located by the reader)");
    expect(b).toContain("Passed: Quotes appear word for word in the cited paragraphs;");
    expect(b).toContain(
      "Did not apply: The finding does not rely on a clause an amendment replaces",
    );
    expect(marks(baseline)).toEqual(["five (5) years"]);

    const c = said(candidate);
    expect(c).toContain("1 of 1 repeat right.");
    expect(c).toContain("Repeat 1 Deviation Right");
    expect(c).toContain("No failure. 2 verified quotes.");
    expect(c).toContain("D2-p4 (a cross reference)");
    // A verified quote is marked in its paragraph.
    expect(marks(candidate)).toEqual(["Section 6.1 of the Agreement is deleted"]);
  });

  it("shows the passage and the words 'quote not found in this passage' for a quote that was not found, and not the quote", () => {
    const candidate = all(trail, (el) => el.name === "div" && hasClass(el, "eval-trail"))[2] as El;
    const figures = all(candidate, (el) => el.name === "figure");
    const notFound = figures.find((f) => said(f).includes("Quote not found in this passage."));
    expect(notFound).toBeDefined();
    expect(said(notFound as El)).toContain(D1_TERM);
    expect(marks(notFound as El)).toEqual([]);
    expect(said(notFound as El)).toContain("Quote not found");
  });

  it("says plainly that a trail was not recorded, and still shows the scores", () => {
    const text = said(
      byTag(
        parseHtml(comparisonHtml(page, { caseKey: CASE_KEY, ruleKey: "ret-1" })),
        "section",
      ).find((s) => attr(s, "aria-labelledby") === "trail") as El,
    );
    expect(text).toContain(WHY_NOT_LABEL.not_recorded);
    expect(text).toContain("The scores below are still shown.");
    expect(text).toContain("0 of 1 repeat right.");
    expect(text).toContain("1 of 1 repeat right.");
    expect(text).toContain("No repeat is recorded for this slot.");
    // The key and its passage are shown all the same.
    expect(text).toContain("The answer key");
    expect(text).toContain(`${"fourteen (14) days"}`);
  });

  it("says why a case's trail is not shown when the case documents are not the ones the run read", () => {
    const body = comparisonBody();
    const change = body.sections[0]!.changes[0]!;
    if ("sealed" in change.trail) throw new Error("fixture");
    change.trail.baseline = { recorded: false, whyNot: "case_changed", repeats: [] };
    const text = said(
      byTag(parseHtml(comparisonHtml(sealComparisonPage(body), SLOT)), "section").find(
        (s) => attr(s, "aria-labelledby") === "trail",
      ) as El,
    );
    expect(text).toContain(WHY_NOT_LABEL.case_changed);
  });

  it("says a slot that did not change is not among the slots that changed, and echoes nothing of the query", () => {
    const hostile = { caseKey: "<script>alert(1)</script>", ruleKey: "dur-1" };
    const out = comparisonHtml(page, hostile);
    expect(out).toContain("That slot is not among the slots that changed in this comparison.");
    expect(out).not.toContain("alert(1)");
    const one = comparisonHtml(page, { caseKey: CASE_KEY });
    expect(one).toContain("That slot is not among the slots that changed in this comparison.");
    const other = comparisonHtml(page, { caseKey: CASE_KEY, ruleKey: "gov-1" });
    expect(other).not.toContain("gov-1");
  });
});

describe("the held-out split", () => {
  const page = comparisonPage(heldoutBody());
  const html = comparisonHtml(page, { split: "heldout" });
  const root = parseHtml(html);
  const text = said(mainOf(root));

  it("is switched to by a link, and the chosen split is marked current", () => {
    const nav = all(root, (el) => el.name === "nav" && attr(el, "aria-label") === "Split")[0] as El;
    const links = all(nav, (el) => el.name === "a");
    expect(links.map((a) => said(a))).toEqual(["Dev", "Held-out"]);
    expect(links.map((a) => attr(a, "aria-current") ?? null)).toEqual([null, "page"]);
    expect(links.map((a) => attr(a, "href"))).toEqual([
      `/evaluations?comparison=${page.id}&split=dev`,
      `/evaluations?comparison=${page.id}&split=heldout`,
    ]);
    expect(text).not.toContain("The held-out split is not in this comparison");
  });

  it("lists the changed slots as sealed, without a link, and says why a trail is not there", () => {
    const table = byTag(root, "table").find((t) =>
      said(byTag(t, "caption")[0] as El).startsWith("Slots whose"),
    ) as El;
    const row = byTag(byTag(table, "tbody")[0] as El, "tr")[0] as El;
    expect(said(row)).toContain("Sealed");
    expect(all(row, (el) => el.name === "a")).toEqual([]);
    expect(text).toContain("1 of 4 paired slots changed");

    const selected = comparisonHtml(page, {
      split: "heldout",
      caseKey: "PAROL-H02",
      ruleKey: "dur-1",
    });
    const pane = said(
      byTag(parseHtml(selected), "section").find(
        (s) => attr(s, "aria-labelledby") === "trail",
      ) as El,
    );
    expect(pane).toContain("Its evidence trail is sealed and is not in the file.");
    expect(pane).not.toContain("The answer key");
  });

  it("shows the contamination note of a side only on the held-out split", () => {
    expect(text).toContain("Two earlier live runs of the held-out split used this workflow.");
    expect(said(mainOf(parseHtml(comparisonHtml(page, { split: "dev" }))))).not.toContain(
      "Two earlier live runs",
    );
  });

  it("says the held-out set was opened when the file says its trails were", () => {
    const opened = comparisonPage({ ...heldoutBody(), heldoutTrailsOpened: true }, "opened");
    expect(textOfMain(comparisonHtml(opened, { split: "heldout" }))).toContain(
      "THE HELD-OUT SET WAS OPENED FOR THIS PAGE.",
    );
    expect(text).not.toContain("THE HELD-OUT SET WAS OPENED");
  });

  it("falls back to the first section for a split the file does not hold", () => {
    const first = comparisonView(page, { split: "other" });
    expect(first.split).toBe("dev");
    const noHeldout = comparisonView(comparisonPage(), { split: "heldout" });
    expect(noHeldout.split).toBe("dev");
  });

  it("names a sealed slot in a failed G12 without a link", () => {
    const body = heldoutBody();
    body.sections[1] = {
      ...body.sections[1]!,
      gates: {
        baseline: null,
        candidate: gateViews({
          G12: {
            outcome: "fail",
            detail: "A slot regressed.",
            slots: [{ caseKey: "PAROL-H02", ruleKey: "dur-1" }],
          },
        }),
      },
    };
    const root2 = parseHtml(comparisonHtml(sealComparisonPage(body), { split: "heldout" }));
    const cell = all(root2, (el) => el.name === "td").find((td) =>
      said(td).includes("Slots that regressed"),
    ) as El;
    expect(said(cell)).toContain("PAROL-H02 dur-1 (sealed)");
    expect(all(cell, (el) => el.name === "a")).toEqual([]);
  });
});

describe("a comparison with a gate report missing on a side", () => {
  it("says so in the cell and shows the other side", () => {
    const body = comparisonBody({
      sections: [devSection({ gates: { baseline: null, candidate: gateViews() } })],
    });
    const root = parseHtml(comparisonHtml(sealComparisonPage(body)));
    expect(said(mainOf(root))).toContain("No gate report was recorded for this version.");
    const none = comparisonBody({
      sections: [devSection({ gates: { baseline: null, candidate: null } })],
    });
    expect(textOfMain(comparisonHtml(sealComparisonPage(none)))).toContain(
      "No gate report was recorded for this split.",
    );
  });
});

describe("the keyboard", () => {
  const page = comparisonPage();
  const root = parseHtml(comparisonHtml(page, SLOT));
  const stops = tabStops(root);
  const indexOf = (predicate: (el: El) => boolean): number => stops.findIndex(predicate);

  it("reaches, in order, the skip link, the split links, a gate's counts, a slot's trail link, the back link and the draft", () => {
    const skip = indexOf((el) => el.name === "a" && hasClass(el, "skip-link"));
    const nav = indexOf((el) => el.name === "a" && attr(el, "href") === "/evaluations");
    const split = indexOf(
      (el) => el.name === "a" && (attr(el, "href") ?? "").endsWith("&split=dev"),
    );
    const summary = indexOf((el) => el.name === "summary");
    const trailLink = indexOf(
      (el) => el.name === "a" && (attr(el, "href") ?? "").endsWith("&rule=dur-1#trail"),
    );
    const back = indexOf((el) => el.name === "a" && attr(el, "href") === "#changes");
    const draft = indexOf((el) => el.name === "textarea");
    const order = [skip, nav, split, summary, trailLink, back, draft];
    expect(
      order.every((i) => i >= 0),
      JSON.stringify(order),
    ).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("has no positive tabindex and no tab stop hidden inside a closed disclosure", () => {
    expect(all(root, (el) => Number(attr(el, "tabindex")) > 0)).toEqual([]);
    for (const stop of stops) {
      const closed = all(root, (d) => d.name === "details" && !hasAttr(d, "open")).filter(
        (d) => all(d, (x) => x === stop).length > 0,
      );
      for (const details of closed)
        expect(
          stop.name === "summary" && details.children.find((c) => c.type === "element") === stop,
        ).toBe(true);
    }
  });

  it("gives the trail heading focus by link, and no other heading", () => {
    const withTabindex = all(root, (el) => /^h[1-6]$/.test(el.name) && hasAttr(el, "tabindex"));
    expect(withTabindex.map((h) => attr(h, "id"))).toEqual(["trail"]);
  });

  it("names every table and every scroll box, once", () => {
    const names = all(root, (el) => hasClass(el, "table-scroll")).map((el) =>
      attr(el, "aria-label"),
    );
    expect(new Set(names).size).toBe(names.length);
    for (const table of byTag(root, "table")) expect(byTag(table, "caption")).toHaveLength(1);
  });
});

describe("text from a file", () => {
  const HOSTILE = "<script>alert(1)</script> \u202e reversed \u200b zero width \u0007 bell";

  /** Replaces every free-text string of a body, leaving the codes, ids and hashes the schema fixes. */
  function hostile<T>(value: T, path: string[] = []): T {
    const FIXED = new Set([
      "mode",
      "status",
      "split",
      "kind",
      "outcome",
      "severity",
      "expected",
      "modal",
      "failure",
      "role",
      "doc",
      "quoteCheck",
      "why",
      "verificationState",
      "whyNot",
      "id",
      "ruleKey",
      "caseKey",
      "sha256",
      "answerKeysSha256",
      "splitsFileSha256",
      "format",
      "acceptable",
      "failures",
      "escalations",
      "files",
      "pass",
      "fail",
      "notApplicable",
    ]);
    if (typeof value === "string") {
      if (path.some((p) => FIXED.has(p))) return value;
      if (/documents\.\d+\.label$/.test(path.join("."))) return value;
      return HOSTILE as unknown as T;
    }
    if (Array.isArray(value))
      return value.map((item, i) => hostile(item, [...path, String(i)])) as T;
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, hostile(v, [...path, k])]),
      ) as T;
    return value;
  }

  const body = hostile(comparisonBody());
  // The free text of every field, hostile, in a document that the schema still accepts.
  const page = sealComparisonPage(body as ComparisonBody);

  for (const [name, query] of [
    ["the comparison", {}],
    ["a slot's trail", SLOT],
  ] as const)
    it(`is escaped or shown as markers on ${name}`, () => {
      const html = comparisonHtml(page, query);
      expect(html).not.toContain("<script>alert");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      for (const raw of ["\u202e", "\u200b", "\u0007"])
        expect(html.includes(raw), JSON.stringify(raw)).toBe(false);
      expect(html).toContain("[U+202E]");
      expect(html).toContain("[U+200B]");
      const root = checkInvariants(html);
      expectAccessible(html);
      expect(byTag(root, "script")).toHaveLength(1);
    });

  it("is escaped in the list too", () => {
    const html = listHtml(memorySource([page]));
    expect(html).not.toContain("<script>alert");
    expect(html.includes("\u202e")).toBe(false);
    expectAccessible(html);
  });
});

describe("the chrome", () => {
  it("shows the Evaluations link in the navigation to the roles that may open the page, and keeps the page the same", () => {
    const withLink = parseHtml(
      listHtml(memorySource([]), chrome({ globalRole: "legal_engineer" })),
    );
    const nav = all(
      withLink,
      (el) => el.name === "nav" && attr(el, "aria-label") === "Primary",
    )[0] as El;
    expect(all(nav, (el) => el.name === "a").map((a) => said(a))).toContain("Evaluations");
    const member = parseHtml(listHtml(memorySource([]), chrome({ globalRole: "member" })));
    const memberNav = all(
      member,
      (el) => el.name === "nav" && attr(el, "aria-label") === "Primary",
    )[0] as El;
    expect(all(memberNav, (el) => el.name === "a").map((a) => said(a))).not.toContain(
      "Evaluations",
    );
  });
});
