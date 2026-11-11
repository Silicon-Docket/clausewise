import { describe, expect, it } from "vitest";
import { urls } from "../../src/server/urls.js";
import { TRAINER_NOTES, TRAINING_STEPS } from "../../src/training/index.js";
import { TRAINING_WHO_LABEL } from "../../src/server/views/training.js";
import { expectAccessible, tabStops } from "../a11y/rules.js";
import {
  all,
  attr,
  byTag,
  forms,
  hasClass,
  parseHtml,
  readable,
  withClass,
  type El,
} from "./html.js";
import { checkInvariants } from "./invariants.js";
import { buildChrome } from "./support.js";
import { quickstartHtml, trainerKeyHtml } from "./training-support.js";
import { variants } from "./variants.js";

/**
 * The trainer's key page (package W2.8): the answer to each step and the trainer's notes. The route
 * gives it to the legal engineer and the administrators only (test/routes/trainer-key-routes.test.ts
 * proves the 403 for everyone else), so what is shown here is what a trainer reads: the answers, the
 * limit of the page stated as a courtesy and not a control, and nothing of any matter. The other
 * half of this file is the other direction: no other page a fixture can make holds an answer.
 */

describe("the trainer's key", () => {
  const html = trainerKeyHtml();
  const root = checkInvariants(html);

  it("is a whole page with one heading, a title, and every rule of the keyboard and the labels met", () => {
    expect(readable(byTag(root, "h1")[0] as El)).toBe("Trainer's key");
    expect(readable(byTag(root, "title")[0] as El)).toBe("Trainer's key | Parol");
    expectAccessible(html);
  });

  it("states the limit of itself: a courtesy and not a control, no passwords, and the same answers elsewhere", () => {
    const text = readable(byTag(root, "main")[0] as El);
    expect(text).toContain("legal engineer and the administrators");
    expect(text).toContain("the server refuses anyone else");
    expect(text).toContain("a courtesy to trainees and not a control");
    expect(text).toContain("no passwords");
    expect(text).toContain("docs/parol/08");
    expect(text).toContain("in the source");
    // And what the exercise cannot show, as the quickstart says it.
    expect(text).toContain("walked by a script and not by a person");
    expect(text).toContain("nobody has timed");
  });

  it("holds a captioned table with one row per step: its title, task, who does it and the answer", () => {
    const table = withClass(root, "training-key")[0] as El;
    expect(table.name).toBe("table");
    expect(readable(byTag(table, "caption")[0] as El)).toBe("Answer key");
    expect(
      byTag(table, "th")
        .filter((th) => attr(th, "scope") === "col")
        .map(readable),
    ).toEqual(["Step", "Task", "Answer"]);
    const rows = byTag(byTag(table, "tbody")[0] as El, "tr");
    expect(rows).toHaveLength(7);
    rows.forEach((row, index) => {
      const step = TRAINING_STEPS[index]!;
      const cells = byTag(row, "td");
      expect(readable(byTag(row, "th")[0] as El)).toBe(`Step ${step.n}: ${step.title}`);
      expect(readable(cells[0] as El)).toContain(step.task);
      expect(readable(cells[0] as El)).toContain(`Who: ${TRAINING_WHO_LABEL[step.who]}`);
      // The answer is the key of the step, whole.
      expect(readable(cells[1] as El).replace(/\.$/, "")).toBe(step.key.replace(/\.$/, ""));
    });
  });

  it("names the finding the exercise is about, which is the point of the page", () => {
    const text = readable(byTag(root, "main")[0] as El).toLowerCase();
    expect(text).toContain("pds-1");
    expect(text).toContain("disclosure to representatives");
    expect(text).toContain("support not checked");
  });

  it("holds the four notes, each under its own heading", () => {
    const notes = byTag(root, "h3").map(readable);
    expect(notes).toEqual(TRAINER_NOTES.map((n) => n.heading));
    for (const note of TRAINER_NOTES) expect(readable(root)).toContain(note.text);
  });

  it("has no form, no field, no matter link and no script of its own: it reads and changes nothing", () => {
    // The only form is the frame's own sign-out, which every page of a signed-in person has.
    expect(forms(root).map((f) => attr(f, "action"))).toEqual([urls.session()]);
    expect(byTag(root, "input").filter((i) => attr(i, "type") !== "hidden")).toHaveLength(0);
    // The frame loads the shared script from a file; the page adds none of its own.
    for (const script of byTag(root, "script")) {
      expect(attr(script, "src")).toMatch(/^\/assets\//);
      expect(script.children).toHaveLength(0);
    }
    const hrefs = byTag(root, "main")
      .flatMap((main) => byTag(main, "a"))
      .map((a) => attr(a, "href"));
    expect(hrefs).toEqual([urls.quickstart()]);
  });

  it("reaches the keyboard: the table's region is a stop, and so is the way back", () => {
    const stops = tabStops(root);
    const region = stops.filter((el) => attr(el, "role") === "region");
    expect(region.map((el) => attr(el, "aria-label"))).toEqual(["Answers to the seven steps"]);
    expect(stops.some((el) => attr(el, "href") === urls.quickstart())).toBe(true);
    for (const el of all(root, (e) => hasClass(e, "table-scroll")))
      expect(attr(el, "tabindex")).toBe("0");
  });

  it("is shown the way to by the quickstart to the legal engineer and the administrator, and to nobody else", () => {
    const link = (chrome: ReturnType<typeof buildChrome>) =>
      all(
        checkInvariants(quickstartHtml({ chrome })),
        (el) => el.name === "a" && attr(el, "href") === urls.trainerKey(),
      );
    expect(link(buildChrome({ globalRole: "legal_engineer" }))).toHaveLength(1);
    expect(link(buildChrome({ globalRole: "admin" }))).toHaveLength(1);
    expect(link(buildChrome({ globalRole: "member" }))).toHaveLength(0);
    expect(link(buildChrome())).toHaveLength(0);
    expect(
      all(checkInvariants(quickstartHtml()), (el) => attr(el, "href") === urls.trainerKey()),
    ).toHaveLength(0);
  });
});

describe("no other page a fixture can make holds the trainer's answer", () => {
  // The seven answers, each looked for whole and in lower case, on every page but the key.
  const keys = TRAINING_STEPS.map((step) => step.key.toLowerCase().replace(/\.$/, ""));

  it("holds for every fixture of every page, the quickstart and the help page among them", () => {
    let checked = 0;
    for (const [name, make] of variants) {
      if (name === "trainer key") continue;
      const text = readable(parseHtml(make())).toLowerCase();
      for (const [index, key] of keys.entries())
        expect(text, `${name}: the answer to step ${index + 1}`).not.toContain(key);
      checked += 1;
    }
    // The sweep is not empty, and it covers the pages of this package.
    expect(checked).toBeGreaterThan(40);
    const names = variants.map(([name]) => name);
    for (const wanted of ["quickstart, visitor", "help", "matter, training, nothing done yet"])
      expect(names).toContain(wanted);
  });

  it("finds the answers on the key page, so that the sweep above can fail", () => {
    const text = readable(parseHtml(trainerKeyHtml())).toLowerCase();
    for (const key of keys) expect(text).toContain(key);
  });
});
