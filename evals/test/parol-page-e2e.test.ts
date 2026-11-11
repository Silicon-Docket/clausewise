import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DURATION, NOT_THE_EXAMPLE, RETURN } from "../../apps/parol/src/demo/worked-example.js";
import {
  MODE_WORDS,
  WHY_NOT_LABEL,
  draftPromotionRecord,
  parseComparisonPage,
  type ComparisonPage,
} from "../../apps/parol/src/evaluations/index.js";
import { urls } from "../../apps/parol/src/server/urls.js";
import { expectAccessible, tabStops } from "../../apps/parol/test/a11y/rules.js";
import {
  all,
  byTag,
  hasClass,
  parseHtml,
  readable,
  textOf,
  type El,
} from "../../apps/parol/test/pages/html.js";
import { IDS, cleanup, makeSite, type Site } from "../../apps/parol/test/routes/support.js";
import {
  containsDocumentText,
  documentWindows,
  makeTempDir,
  removeDir,
  run,
} from "../src/parol/testing-run.js";
import {
  GIT,
  HELDOUT_ALLOW,
  loadWorld,
  readCase,
  scriptedHeldoutRun,
  simulatedRun,
} from "./parol-page-support.js";

/**
 * The whole way, across the two packages: the evaluation command writes a page document into a data
 * folder, and the real application (the real shell, the real routes, the real service and page)
 * reads that folder and shows it to a legal engineer. The results files are real ones written by the
 * command in this test: SIMULATED runs of the worked example (the demo's scripted reader) and a
 * SIMULATED and a SELFTEST run of one held-out case. No model is called, no key is read, and the
 * numbers on the page are those of scripted stand-ins, which is what the page says.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let dir = "";
let data = "";
let site: Site;
let world: Awaited<ReturnType<typeof loadWorld>>;
let published: { dev: ComparisonPage; sealed: ComparisonPage; opened: ComparisonPage };

async function pages(): Promise<ComparisonPage[]> {
  const folder = join(data, "evaluations");
  return Promise.all(
    (await readdir(folder)).map(async (name) => {
      const parsed = parseComparisonPage(await readFile(join(folder, name), "utf8"), name);
      if (!parsed.ok)
        throw new Error(`${name} is not accepted by the application: ${parsed.problem}`);
      return parsed.page;
    }),
  );
}

beforeAll(async () => {
  dir = await makeTempDir();
  data = join(dir, "data");
  await mkdir(data);
  world = await loadWorld();
  const io = {
    resultsDir: join(dir, "results"),
    gitInfo: GIT,
    now: () => new Date("2026-11-05T09:00:00.000Z"),
  };

  // The worked example, run twice by the command, the second time with --compare and --publish:
  // the command's own flow, from a run to a page.
  const v1 = await simulatedRun(dir, "sim-v1.json", "v1");
  const second = await run(
    [
      "--simulate",
      "--workflow",
      "v2",
      "--case",
      "PAROL-D05",
      "--compare",
      v1,
      "--out",
      join(dir, "sim-v2.json"),
      "--publish",
      data,
    ],
    io,
  );
  expect(second.code, second.stderr).toBe(0);

  // The held-out split: a SIMULATED run against a SELFTEST run of one case, published sealed and opened.
  const heldSim = await scriptedHeldoutRun(dir, "held-sim.json", "simulate");
  const heldSelf = await scriptedHeldoutRun(dir, "held-self.json", "selftest");
  for (const extra of [[], ["--open-heldout-trails"]]) {
    const out = await run(
      [
        "--baseline",
        heldSim,
        "--candidate",
        heldSelf,
        "--allow-differences",
        HELDOUT_ALLOW.join(","),
        "--publish",
        data,
        ...extra,
      ],
      io,
    );
    expect(out.code, out.stderr).toBe(0);
  }

  const written = await pages();
  expect(written).toHaveLength(3);
  const pick = (want: (page: ComparisonPage) => boolean): ComparisonPage => {
    const found = written.filter(want);
    expect(found).toHaveLength(1);
    return found[0] as ComparisonPage;
  };
  published = {
    dev: pick((page) => page.sections[0]!.split === "dev"),
    sealed: pick((page) => page.sections[0]!.split === "heldout" && !page.heldoutTrailsOpened),
    opened: pick((page) => page.sections[0]!.split === "heldout" && page.heldoutTrailsOpened),
  };
  site = makeSite({ evaluations: join(data, "evaluations") });
});

afterAll(async () => {
  cleanup();
  await removeDir(dir);
});

const main = (html: string): El => byTag(parseHtml(html), "main")[0] as El;
const said = (html: string): string => readable(main(html));

/** Every string of a value that is long enough to be a sentence, to look for the reader's own words. */
function sentences(value: unknown): string[] {
  if (typeof value === "string") return value.length >= 40 ? [value] : [];
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap((inner) => sentences(inner));
  return [];
}

describe("a legal engineer, on what the command published", () => {
  it("sees the three comparisons in a list, with the mode of each run in capitals", async () => {
    const browser = await site.as(IDS.legalEngineer);
    const { html, root } = await browser.page(urls.evaluations());
    const text = said(html);
    for (const page of [published.dev, published.sealed, published.opened]) {
      expect(text).toContain(page.id.slice(0, 12));
    }
    // The worked example: two simulated runs. The held-out pair: a simulated baseline and a
    // selftest candidate, both of workflow v1.
    expect(text).toContain("v2 SIMULATED");
    expect(text).toContain("v1 SELFTEST");
    expect(text.match(/v1 SIMULATED/g)).toHaveLength(3);
    expectAccessible(html);
    expect(tabStops(root).length).toBeGreaterThan(3);
  });

  it("opens the comparison of the worked example: the words of the run in capitals, both versions and every gate", async () => {
    const page = published.dev;
    const browser = await site.as(IDS.legalEngineer);
    const { html, root } = await browser.page(urls.evaluations({ comparison: page.id }));
    const text = said(html);
    // The application's own words for a simulated run, from its mode in the document.
    expect(text).toContain(MODE_WORDS.simulated);
    expect(text).toContain("Compare workflow versions");
    expect(text).toContain("v1");
    expect(text).toContain("v2");
    // All fourteen gates of both versions are on the page, and the reason a gate was not
    // evaluated is read from the page without opening anything.
    for (let gate = 1; gate <= 14; gate += 1) expect(text, `G${gate}`).toContain(`G${gate} `);
    const g1 = page.sections[0]!.gates.candidate![0]!;
    expect(g1.outcome).toBe("not_evaluated");
    const reasonInOpenText = all(root, (el) => el.name === "td" || el.name === "th")
      .filter((cell) => !all(cell, (inner) => inner.name === "details").length)
      .some((cell) => readable(cell).includes(g1.detail));
    expect(reasonInOpenText).toBe(true);
    // The metrics, the denominator of the changed slots and one link for each.
    expect(text).toContain("Issue recall, strict (count)");
    expect(text).toContain("2 of 8 paired slots changed");
    const links = all(root, (el) => el.name === "a").filter((a) =>
      readable(a).startsWith("Open the trail"),
    );
    expect(links).toHaveLength(2);
    // No way to promote anything: the page's own content holds no form and no button. (The sign-out
    // form is in the header, outside it.)
    const content = byTag(root, "main")[0] as El;
    expect(byTag(content, "form")).toHaveLength(0);
    expect(byTag(content, "button")).toHaveLength(0);
    expectAccessible(html);
  });

  it("opens the evidence of the duration slot: the key's passage marked, and what each version said of it", async () => {
    const page = published.dev;
    const browser = await site.as(IDS.legalEngineer);
    const { html, root } = await browser.page(
      urls.evaluations({ comparison: page.id, caseKey: "PAROL-D05", ruleKey: "dur-1" }),
    );
    const marks = all(root, (el) => el.name === "mark").map((mark) => readable(mark));
    expect(marks.some((mark) => mark.includes("Section 6.1 of the Agreement is deleted"))).toBe(
      true,
    );
    expect(
      marks.some((mark) => mark.includes("two (2) years from the date of each disclosure")),
    ).toBe(true);
    const text = said(html);
    // What each version said of the slot, in its own part of the trail: the baseline read it as
    // compliant and missed the issue, the candidate as a deviation, which is what the key expects.
    const panes = all(root, (el) => el.name === "div" && hasClass(el, "eval-trail"));
    const pane = (title: string): string => {
      const found = panes.find((el) => readable(byTag(el, "h3")[0] as El) === title);
      if (found === undefined) throw new Error(`the trail has no part called ${title}`);
      return readable(found);
    };
    expect(pane("The answer key")).toContain("Deviation");
    expect(pane("Baseline")).toContain("Compliant");
    expect(pane("Baseline")).toContain("Wrong");
    expect(pane("Baseline")).toContain("Silent miss");
    expect(pane("Baseline")).not.toContain("Deviation");
    expect(pane("Candidate")).toContain("Deviation");
    expect(pane("Candidate")).toContain("Right");
    expect(pane("Candidate")).not.toContain("Compliant");
    // A results file of this version records no trail, and the page says so, for both versions.
    expect(text.split(WHY_NOT_LABEL.not_recorded)).toHaveLength(3);
    expect(html).toContain('id="trail"');
    expectAccessible(html);
    expect(tabStops(parseHtml(html)).length).toBeGreaterThan(5);
  });

  it("holds none of the words the simulated reader wrote: the page shows where the key points and what was scored, not an answer", async () => {
    const page = published.dev;
    const browser = await site.as(IDS.legalEngineer);
    const answers = [...sentences(DURATION), ...sentences(RETURN), ...sentences(NOT_THE_EXAMPLE)];
    // Every sentence the reader can write on this case, so the list is not empty by accident.
    expect(answers.length).toBeGreaterThan(8);
    const requests = [
      urls.evaluations({ comparison: page.id }),
      urls.evaluations({ comparison: page.id, caseKey: "PAROL-D05", ruleKey: "dur-1" }),
      urls.evaluations({ comparison: page.id, caseKey: "PAROL-D05", ruleKey: "ret-1" }),
    ];
    const document = JSON.stringify(page);
    for (const sentence of answers) expect(document).not.toContain(sentence);
    for (const url of requests) {
      const { html } = await browser.page(url);
      for (const sentence of answers) {
        expect(said(html), url).not.toContain(sentence);
      }
    }
  });

  it("is given, in the draft record, the same text the application drafts from the document, with its banner and blank fields", async () => {
    const page = published.dev;
    const browser = await site.as(IDS.legalEngineer);
    const { root } = await browser.page(urls.evaluations({ comparison: page.id }));
    const [box] = byTag(root, "textarea");
    expect(box).toBeDefined();
    // A browser drops the one newline that opens a text area.
    const draft = textOf(box!).replace(/^\n/, "");
    expect(draft).toBe(draftPromotionRecord(page, "dev"));
    expect(draft).toContain(
      "DRAFT TEXT FROM A COMPARISON FILE. IT IS NOT A DECISION AND IT PROMOTES NOTHING.",
    );
    expect(draft).toContain(MODE_WORDS.simulated);
    expect(draft).toContain("Signed off by (legal engineer): ____");
  });

  it("administrators read it too", async () => {
    const browser = await site.as(IDS.admin);
    const { html } = await browser.page(urls.evaluations({ comparison: published.dev.id }));
    expect(said(html)).toContain(MODE_WORDS.simulated);
  });
});

describe("a member, and a visitor", () => {
  const urlsToTry = (): string[] => [
    urls.evaluations(),
    urls.evaluations({ comparison: published.dev.id }),
    urls.evaluations({ comparison: published.dev.id, caseKey: "PAROL-D05", ruleKey: "dur-1" }),
  ];

  it("get the shell's 403 and none of what the command wrote", async () => {
    for (const userId of [IDS.associate, IDS.reviewer]) {
      const browser = await site.as(userId);
      for (const url of urlsToTry()) {
        const response = await browser.get(url);
        expect(response.status, url).toBe(403);
        const body = await response.text();
        for (const page of [published.dev, published.sealed, published.opened]) {
          expect(body).not.toContain(page.id);
        }
        expect(body).not.toContain("Section 6.1");
      }
    }
  });

  it("are sent to sign in, or refused", async () => {
    const visitor = site.anonymous();
    for (const url of urlsToTry()) {
      const response = await visitor.get(url);
      expect(response.status, url).toBe(303);
      expect(response.headers.get("location")).toBe("/");
    }
  });
});

describe("the held-out split, sealed and opened by the command", () => {
  it("shows the changed slots as sealed and holds nothing of the held-out documents or its key", async () => {
    const page = published.sealed;
    const { key, spans } = await readCase(world.dataset, "PAROL-H01");
    const windows = documentWindows(spans);
    const slot = page.sections[0]!.changes[0]!;
    const browser = await site.as(IDS.legalEngineer);
    const list = await browser.page(urls.evaluations({ comparison: page.id, split: "heldout" }));
    const chosen = await browser.page(
      urls.evaluations({
        comparison: page.id,
        split: "heldout",
        caseKey: slot.caseKey,
        ruleKey: slot.ruleKey,
      }),
    );
    for (const { html } of [list, chosen]) {
      expect(said(html)).toContain("Sealed");
      expect(containsDocumentText(html, windows)).toBe(false);
      expect(all(parseHtml(html), (el) => el.name === "mark")).toEqual([]);
      for (const expectation of Object.values(key.expect))
        expect(html).not.toContain(expectation.basis);
    }
    expectAccessible(chosen.html);
  });

  it("shows the key's passages of the held-out slot, marked, only on the page that was opened", async () => {
    const page = published.opened;
    expect(page.heldoutTrailsOpened).toBe(true);
    const { spans } = await readCase(world.dataset, "PAROL-H01");
    const slot = page.sections[0]!.changes[0]!;
    const browser = await site.as(IDS.legalEngineer);
    const chosen = await browser.page(
      urls.evaluations({
        comparison: page.id,
        split: "heldout",
        caseKey: slot.caseKey,
        ruleKey: slot.ruleKey,
      }),
    );
    expect(said(chosen.html)).toContain("THE HELD-OUT SET WAS OPENED FOR THIS PAGE");
    // Without this the negative check on the sealed page could not fail.
    expect(containsDocumentText(chosen.html, documentWindows(spans))).toBe(true);
    expectAccessible(chosen.html);
  });
});
