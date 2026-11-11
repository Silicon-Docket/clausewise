import { describe, expect, it } from "vitest";
import { SIMULATED_PROVIDER } from "../../src/demo/simulated-model.js";
import type { TrainingProgressView } from "../../src/services/views.js";
import { FindingPage, MemosPage, render } from "../../src/server/pages/index.js";
import { TrainingBanner, TrainingSection } from "../../src/server/pages/training.js";
import { urls } from "../../src/server/urls.js";
import {
  SIMULATED_PROVIDER_NAME,
  STEP_STATE_LABEL,
  TRAINING_BANNER,
  progressSentence,
  trainingBannerHeading,
} from "../../src/server/views/training.js";
import { TRAINING_STEPS } from "../../src/training/index.js";
import { expectAccessible, tabStops } from "../a11y/rules.js";
import {
  all,
  attr,
  byId,
  byTag,
  hasClass,
  parseHtml,
  readable,
  textOf,
  withClass,
  type El,
} from "./html.js";
import { checkInvariants } from "./invariants.js";
import { matterPage } from "./render.js";
import { expectAccessibleExceptTheMemoList } from "./feedback-support.js";
import { IDS, buildChrome, buildFindingView, buildMatterSummary, buildMemo } from "./support.js";
import { progressWith, trainingMatterView, trainingRunHtml } from "./training-support.js";

/**
 * The training matter's banner and the table of progress (package W2.8). Pages of fixed sentences
 * and a progress view, so these tests read the HTML a view makes, state by state, and hold it to
 * the rules every page has and to the keyboard and label rules of test/a11y/rules.ts. They also
 * hold the page to what the exercise needs it to say and not to say: that the reader is a program
 * with a script, that every number has its denominator, and that nothing outside the banner says a
 * finding is planted.
 */

/** A component that shows nothing returns null; its markup is then the empty string. */
const markup = (node: { toString(): string | Promise<string> } | null): string =>
  node === null ? "" : render(node);
const section = (progress: TrainingProgressView | null | undefined): string =>
  markup(TrainingSection({ progress }));
const banner = (props: Parameters<typeof TrainingBanner>[0]): string =>
  markup(TrainingBanner(props));

/** The text of a page outside the banner of the training matter. */
function outsideBanner(root: El): string {
  const inBanner = new Set(all(withClass(root, "banner-training")[0] as El));
  const pieces: string[] = [];
  const visit = (el: El): void => {
    if (inBanner.has(el)) return;
    for (const child of el.children) {
      if (child.type === "text") pieces.push(child.text);
      else visit(child);
    }
  };
  for (const el of byTag(root, "main")) visit(el);
  return pieces.join(" ").replace(/\s+/g, " ");
}

describe("the table of progress", () => {
  const fresh = section(progressWith());

  it("is a section with a heading, a sentence that states both denominators, and a captioned table", () => {
    const root = expectAccessible(fresh, { fragment: true });
    const heading = byTag(root, "h2")[0] as El;
    expect(readable(heading)).toBe("Training progress");
    expect(attr(byTag(root, "section")[0] as El, "aria-labelledby")).toBe(attr(heading, "id"));
    expect(readable(byTag(root, "p").find((p) => !hasClass(p, "section-note")) as El)).toBe(
      "Parol can check 5 of the 7 steps from what it stores (steps 3 to 7). 0 of those 5 are done. Step 1 was set up for you, and step 2 is checked by your trainer.",
    );
    const table = byTag(root, "table")[0] as El;
    expect(readable(byTag(table, "caption")[0] as El)).toBe(
      "Where each step of the training exercise stands",
    );
    expect(
      byTag(table, "th")
        .filter((th) => attr(th, "scope") === "col")
        .map(readable),
    ).toEqual(["Step", "Where it stands", "Note"]);
  });

  it("sits in a region that scrolls and that the keyboard reaches", () => {
    const root = expectAccessible(fresh, { fragment: true });
    const box = withClass(root, "table-scroll")[0] as El;
    expect(attr(box, "role")).toBe("region");
    expect(attr(box, "tabindex")).toBe("0");
    expect(attr(box, "aria-label")).toBe("Steps of the training exercise");
    expect(tabStops(root)).toContain(box);
  });

  it("has one row per step, in order, with the step's title, a state in words and a note", () => {
    const root = expectAccessible(fresh, { fragment: true });
    const rows = byTag(byTag(root, "tbody")[0] as El, "tr");
    expect(rows).toHaveLength(7);
    rows.forEach((row, index) => {
      const step = TRAINING_STEPS[index]!;
      const [head, state, note] = [byTag(row, "th")[0] as El, ...byTag(row, "td")];
      expect(attr(head, "scope")).toBe("row");
      expect(readable(head)).toBe(`Step ${step.n}: ${step.title}`);
      expect(hasClass(state as El, "chip") || withClass(state as El, "chip").length === 1).toBe(
        true,
      );
      expect(readable(note as El).length).toBeGreaterThan(5);
    });
    // Step 1 and 2 are not counted: one is set up, the other is the trainer's.
    expect(rows.map((row) => readable(byTag(row, "td")[0] as El))).toEqual([
      STEP_STATE_LABEL.seeded,
      STEP_STATE_LABEL.trainer,
      STEP_STATE_LABEL.not_yet,
      STEP_STATE_LABEL.not_yet,
      STEP_STATE_LABEL.not_yet,
      STEP_STATE_LABEL.not_yet,
      STEP_STATE_LABEL.not_yet,
    ]);
  });

  it("states how many of the five are done, out of five, whatever is done", () => {
    for (const [done, count] of [
      [{ 3: true }, 1],
      [{ 3: true, 4: true }, 2],
      [{ 3: true, 4: true, 5: true, 6: true, 7: true }, 5],
    ] as const) {
      const root = expectAccessible(section(progressWith(done)), { fragment: true });
      const sentence = readable(byTag(root, "p").find((p) => !hasClass(p, "section-note")) as El);
      expect(sentence).toContain(`${count} of those 5 are done`);
      expect(sentence).toContain("5 of the 7 steps");
      const states = byTag(byTag(root, "tbody")[0] as El, "tr").map((row) =>
        readable(byTag(row, "td")[0] as El),
      );
      expect(states.filter((s) => s === STEP_STATE_LABEL.done)).toHaveLength(count);
    }
  });

  it("builds its sentence from the numbers it is given and never from a count of its own", () => {
    expect(progressSentence(3, 5, 7)).toContain("3 of those 5 are done");
    expect(progressSentence(0, 5, 7)).toContain("Parol can check 5 of the 7 steps");
  });

  it("shows the state as a word and a shape, so colour is never the only signal", () => {
    const root = expectAccessible(section(progressWith({ 3: true })), { fragment: true });
    for (const chip of withClass(root, "chip")) {
      expect(readable(chip).length).toBeGreaterThan(3);
      expect(withClass(chip, "shape")).toHaveLength(1);
      expect(attr(withClass(chip, "shape")[0] as El, "aria-hidden")).toBe("true");
    }
  });

  it("shows a state it does not know as not yet, and builds no class from it", () => {
    const hostile = progressWith();
    hostile.steps[2] = { ...hostile.steps[2]!, state: "done tone-bad<script>" as never };
    const html = section(hostile);
    const root = expectAccessible(html, { fragment: true });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("tone-bad<");
    const row = byTag(byTag(root, "tbody")[0] as El, "tr")[2] as El;
    expect(readable(byTag(row, "td")[0] as El)).toBe(STEP_STATE_LABEL.not_yet);
  });

  it("escapes a note, as it escapes every text", () => {
    const hostile = progressWith();
    hostile.steps[3] = { ...hostile.steps[3]!, note: "<b>bold</b> & more" };
    const html = section(hostile);
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; more");
    expect(html).not.toContain("<b>");
  });

  it("shows nothing for an ordinary matter", () => {
    expect(section(null)).toBe("");
    expect(section(undefined)).toBe("");
  });

  it("is on the matter page of a training matter between the banner and the documents, and only there", () => {
    const html = matterPage(trainingMatterView(progressWith({ 3: true })));
    const root = checkInvariants(html);
    const order = all(
      root,
      (el) =>
        el.name === "section" &&
        ["training-banner-heading", "training-progress-heading", "documents-heading"].includes(
          attr(el, "aria-labelledby") ?? "",
        ),
    ).map((el) => attr(el, "aria-labelledby"));
    expect(order).toEqual([
      "training-banner-heading",
      "training-progress-heading",
      "documents-heading",
    ]);
    // An ordinary matter has neither.
    const ordinary = checkInvariants(matterPage());
    expect(byId(ordinary, "training-progress")).toBeUndefined();
    expect(withClass(ordinary, "banner-training")).toHaveLength(0);
  });
});

describe("the banner of a training matter", () => {
  it("names the matter, says what reads the documents and what is wrong on purpose, and links the quickstart", () => {
    const root = expectAccessible(banner({ training: "T01" }), { fragment: true });
    const el = withClass(root, "banner-training")[0] as El;
    expect(el.name).toBe("section");
    expect(hasClass(el, "banner")).toBe(true);
    const heading = byTag(el, "h2")[0] as El;
    expect(readable(heading)).toBe(trainingBannerHeading("T01"));
    expect(attr(el, "aria-labelledby")).toBe(attr(heading, "id"));
    const text = readable(el);
    expect(text).toContain(TRAINING_BANNER.full);
    expect(text).toContain("simulated reader, a program with a script, not a language model");
    expect(text).toContain("one finding wrong on purpose");
    expect(text).toContain("Nothing here says how well any model reads an NDA");
    const link = byTag(el, "a")[0] as El;
    expect(attr(link, "href")).toBe(urls.quickstart());
    expect(readable(link)).toBe("Quickstart");
  });

  it("is shorter on the review page, and says the same things", () => {
    const root = expectAccessible(banner({ training: "T01", compact: true }), { fragment: true });
    const text = readable(withClass(root, "banner-training")[0] as El);
    expect(text).toContain(TRAINING_BANNER.compact);
    expect(TRAINING_BANNER.compact.length).toBeLessThan(TRAINING_BANNER.full.length);
    expect(text).toContain("not a language model");
    expect(text).toContain("on purpose");
    expect(text).toContain("Nothing here says how well any model reads an NDA");
  });

  it("shows nothing for an ordinary matter", () => {
    expect(banner({ training: null })).toBe("");
    expect(banner({})).toBe("");
    expect(banner({ compact: true, training: undefined, provider: "simulated" })).toBe("");
  });

  it("adds a second sentence on the review page when the review was not read by the simulated reader, and not when it was", () => {
    const readBy = (provider: string | undefined) =>
      readable(
        withClass(
          expectAccessible(banner({ training: "T01", compact: true, provider }), {
            fragment: true,
          }),
          "banner-training",
        )[0] as El,
      );
    expect(readBy("simulated")).not.toContain(TRAINING_BANNER.notSimulated);
    expect(readBy(undefined)).not.toContain(TRAINING_BANNER.notSimulated);
    for (const provider of ["scripted", "anthropic", "other"])
      expect(readBy(provider), provider).toContain(TRAINING_BANNER.notSimulated);
    expect(TRAINING_BANNER.notSimulated).toContain("not read by the simulated reader");
  });

  it("compares the provider with the name the simulated reader gives itself", () => {
    expect(SIMULATED_PROVIDER_NAME).toBe(SIMULATED_PROVIDER);
  });

  it("escapes a key it is given", () => {
    const html = banner({ training: "T01<script>" });
    expect(html).not.toContain("<script>");
  });
});

describe("every page of a training matter says what reads it", () => {
  const says = (text: string): boolean =>
    /simulated reader/i.test(text) && /not a language model/i.test(text);

  it("is said on the matter page and on the review page, whoever read the review", () => {
    for (const [name, html] of [
      ["matter", matterPage(trainingMatterView())],
      ["run, simulated", trainingRunHtml("simulated")],
      ["run, other", trainingRunHtml("scripted")],
    ] as const) {
      const root = checkInvariants(html);
      const banners = withClass(root, "banner-training");
      expect(banners, name).toHaveLength(1);
      expect(says(readable(banners[0] as El)), name).toBe(true);
    }
  });

  it("is said by a stand-in notice as well on the review page, which the banner does not replace", () => {
    const root = checkInvariants(trainingRunHtml("simulated"));
    expect(withClass(root, "banner-standin")).toHaveLength(1);
    expect(withClass(root, "banner-training")).toHaveLength(1);
  });

  it("keeps the word planted, and the words on purpose and deliberately, inside the banner on the review page", () => {
    for (const html of [trainingRunHtml("simulated"), trainingRunHtml("scripted")]) {
      const root = checkInvariants(html);
      const text = outsideBanner(root).toLowerCase();
      for (const word of ["planted", "on purpose", "deliberately"])
        expect(text, word).not.toContain(word);
      // And the banner is what carries them.
      expect(textOf(withClass(root, "banner-training")[0] as El)).toContain("on purpose");
    }
  });

  it("says on the matter page, outside the banner, only what the title of step 4 says", () => {
    const root = checkInvariants(
      matterPage(trainingMatterView(progressWith({ 3: true, 4: true }))),
    );
    const text = outsideBanner(root).toLowerCase();
    expect(text).not.toContain("on purpose");
    expect(text).not.toContain("deliberately");
    // The one place the word is: the title of step 4 in the table of progress, shown to the trainee
    // as a step of the exercise, like the quickstart's own text for it.
    expect(text.match(/planted/g) ?? []).toHaveLength(1);
    expect(text).toContain(`step 4: ${TRAINING_STEPS[3]!.title.toLowerCase()}`);
  });

  it("names no rule of the exercise on the matter page, in a note or anywhere else", () => {
    const text = readable(
      byTag(
        checkInvariants(matterPage(trainingMatterView(progressWith({ 3: true })))),
        "main",
      )[0] as El,
    ).toLowerCase();
    expect(text).not.toContain("disclosure to representatives");
    expect(text).not.toContain("pds-1");
    for (const step of TRAINING_STEPS) expect(text).not.toContain(step.key.toLowerCase());
  });

  it("holds the rules of the keyboard and the labels for the banner and the table together", () => {
    const html = banner({ training: "T01" }) + section(progressWith({ 3: true }));
    const root = expectAccessible(html, { fragment: true });
    // The banner's link and the table's region are both stops, in that order.
    const stops = tabStops(root).map((el) => (el.name === "a" ? "link" : attr(el, "role")));
    expect(stops).toEqual(["link", "region"]);
  });
});

describe("the banner on the pages that hang off a training matter", () => {
  const memos = (training: string | null): string =>
    render(
      MemosPage({
        chrome: buildChrome(),
        matter: buildMatterSummary({ training }),
        memos: [buildMemo()],
        canExport: true,
        exportBlockedReason: null,
      }),
    );
  const finding = (training: string | null): string =>
    render(
      FindingPage({
        chrome: buildChrome(),
        matterId: IDS.matter,
        matterName: "Training matter",
        finding: buildFindingView(),
        training,
      }),
    );

  // The memos page names two landmarks "Exported memos" until the polish sweep (W2.9-fix) renames
  // one; the helper lets exactly that through and nothing else.
  for (const [name, make, audit] of [
    ["memos page", memos, expectAccessibleExceptTheMemoList],
    ["finding page", finding, (html: string) => expectAccessible(html)],
  ] as const) {
    it(`the ${name} of a training matter carries the short banner, in the main region, before its other sections`, () => {
      const root = audit(make("T01"));
      const banners = withClass(root, "banner-training");
      expect(banners).toHaveLength(1);
      const text = readable(banners[0] as El);
      expect(text).toContain(TRAINING_BANNER.compact);
      expect(text).toContain("not a language model");
      expect(attr(byTag(banners[0] as El, "a")[0] as El, "href")).toBe(urls.quickstart());
      // The page has one h1 (that it comes first is held for all three pages, below), and nothing
      // says a finding is planted outside the banner.
      const main = byTag(root, "main")[0] as El;
      expect(all(main, (el) => el.name === "h1")).toHaveLength(1);
      expect(outsideBanner(root).toLowerCase()).not.toMatch(/planted|deliberately|on purpose/);
    });

    it(`the ${name} of an ordinary matter has no banner`, () => {
      const root = audit(make(null));
      expect(withClass(root, "banner-training")).toHaveLength(0);
    });
  }

  it("puts the banner after the page's one h1 in the document, on the review, memos and finding pages alike", () => {
    for (const [name, html] of [
      ["review page", trainingRunHtml("simulated")],
      ["memos page", memos("T01")],
      ["finding page", finding("T01")],
    ] as const) {
      const root = parseHtml(html);
      const main = byTag(root, "main")[0] as El;
      const h1s = byTag(main, "h1");
      const banners = withClass(main, "banner-training");
      expect(h1s, name).toHaveLength(1);
      expect(banners, name).toHaveLength(1);
      // Document order is the order a screen reader and the keyboard meet them in.
      const order = all(main);
      expect(order.indexOf(h1s[0] as El), name).toBeLessThan(order.indexOf(banners[0] as El));
      // The banner's h2 is not the first heading of the page: the title is.
      const headings = all(main, (el) => /^h[1-6]$/.test(el.name));
      expect(headings[0], name).toBe(h1s[0]);
      expect(headings.indexOf(byTag(banners[0] as El, "h2")[0] as El), name).toBeGreaterThan(0);
    }
  });
});
