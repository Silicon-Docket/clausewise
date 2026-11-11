import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEMO_PLAYBOOK_PATH, DEMO_PLAYBOOK_SLUG } from "../../src/boot/index.js";
import { loadPlaybook } from "../../src/playbooks/load.js";
import {
  TRAINING_WHO_LABEL,
  plainStrong,
  strongSegments,
} from "../../src/server/views/training.js";
import { openDatabase, createRepository } from "../../src/store/index.js";
import {
  QUICKSTART_STEPS,
  T01,
  TRAINING_STEPS,
  publicStep,
  type ControlRef,
} from "../../src/training/index.js";
import { all, byTag, readable, type El, parseHtml } from "../pages/html.js";
import { variants } from "../pages/variants.js";

/**
 * The two lists of steps, the single source that the quickstart page renders and that document 8
 * is compared with (`doc-agree.test.ts`). These tests hold what the lists must be on their own:
 * numbered, written without a dash, worded as the plan words them, and free of the
 * trainer's answer where a trainee reads. Whether each word a task uses is on a page is checked
 * here too, against the fixtures of the pages.
 */

const DASH = /[\u2013\u2014]/;

describe("the training steps", () => {
  it("are seven, numbered 1 to 7 in order, each with every field filled", () => {
    expect(TRAINING_STEPS.map((step) => step.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const step of TRAINING_STEPS) {
      for (const field of [step.title, step.task, step.teaches, step.key]) {
        expect(field.trim(), `step ${step.n}`).toBe(field);
        expect(field.length, `step ${step.n}`).toBeGreaterThan(5);
        expect(field, `step ${step.n}`).not.toMatch(DASH);
        expect(field, `step ${step.n}`).not.toContain("**");
      }
      expect(Object.keys(TRAINING_WHO_LABEL), `step ${step.n}`).toContain(step.who);
      expect(step.controls.length, `step ${step.n}`).toBeGreaterThan(0);
    }
  });

  it("record steps 3 to 7 from stored events, step 1 as set up and step 2 as the trainer's", () => {
    expect(TRAINING_STEPS.map((step) => step.record)).toEqual([
      "seeded",
      "trainer",
      "state",
      "state",
      "state",
      "state",
      "state",
    ]);
  });

  it("tell the trainee to choose a reason code where a rejection is made (steps 4 and 7)", () => {
    for (const n of [4, 7])
      expect(TRAINING_STEPS[n - 1]!.task, `step ${n}`).toContain("a reason and a reason code");
  });

  it("never name the planted rule or its title in a text a trainee reads", () => {
    const trainee = TRAINING_STEPS.flatMap((step) => [step.title, step.task, step.teaches]);
    for (const text of trainee) {
      expect(text).not.toMatch(/pds-1/i);
      expect(text).not.toMatch(/disclosure to representatives/i);
      expect(text).not.toMatch(/definition clause/i);
    }
    // The key is where the rule is named, and it is the one field a page never receives.
    expect(TRAINING_STEPS[3]!.key).toContain("pds-1");
  });

  it("hand a page everything but the key and the words to look for", () => {
    for (const step of TRAINING_STEPS) {
      const given = publicStep(step);
      expect(Object.keys(given).sort()).toEqual(
        ["n", "record", "task", "teaches", "title", "who"].sort(),
      );
      expect(JSON.stringify(given)).not.toContain(step.key);
    }
  });

  it("name the playbook version the demonstration playbook has, in the key of step 1", () => {
    const loaded = loadPlaybook({
      yaml: readFileSync(DEMO_PLAYBOOK_PATH, "utf8"),
      slug: DEMO_PLAYBOOK_SLUG,
    });
    expect(TRAINING_STEPS[0]!.key).toContain(`playbook ${loaded.version}`);
  });

  it("use the playbook the demonstration ships, and the two demonstration names that say who is who", () => {
    expect(T01.playbookSlug).toBe(DEMO_PLAYBOOK_SLUG);
    const repo = createRepository(openDatabase(":memory:"));
    repo.seedDemoUsers();
    const names = repo.listUsers().map((user) => user.displayName);
    expect(names.filter((name) => name.includes("(associate)"))).toHaveLength(1);
    expect(names.filter((name) => name.includes("(reviewing attorney)"))).toHaveLength(1);
  });
});

describe("the quickstart steps", () => {
  it("are ten, numbered 1 to 10 in order, each with a text in the page's markup", () => {
    expect(QUICKSTART_STEPS.map((step) => step.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const step of QUICKSTART_STEPS) {
      expect(step.text.trim(), `step ${step.n}`).toBe(step.text);
      expect(step.text.length, `step ${step.n}`).toBeGreaterThan(20);
      expect(step.text, `step ${step.n}`).not.toMatch(DASH);
      // Bold is a pair of **, and every pair is closed.
      expect(step.text.split("**").length % 2, `step ${step.n}`).toBe(1);
      expect(
        strongSegments(step.text).some((s) => s.strong),
        `step ${step.n}`,
      ).toBe(true);
      expect(plainStrong(step.text)).not.toContain("**");
    }
  });

  it("word step 8 as the plan words it: a reason for edits, rejections and escalations, a code for edits and rejections", () => {
    expect(QUICKSTART_STEPS[7]!.text).toBe(
      "**Reviewer:** accept, edit, reject or escalate every finding. Edits, rejections and escalations need a reason, and edits and rejections need a reason code.",
    );
  });

  it("say that sign-in is a demonstration identity with no passwords, in step 1", () => {
    expect(QUICKSTART_STEPS[0]!.text).toContain("demo identity");
    expect(QUICKSTART_STEPS[0]!.text).toContain("no passwords");
  });

  it("mark steps 7 and 10 as not built, and no other", () => {
    // When the notes (7) or the rating and the missed-issue report (10) are built, change
    // `availability` in src/training/quickstart.ts, link the step, and change this list with it.
    const notBuilt = QUICKSTART_STEPS.filter((step) => step.availability === "not_built").map(
      (step) => step.n,
    );
    expect(
      notBuilt,
      "a step changed availability: change QUICKSTART_STEPS and this test together",
    ).toEqual([7, 10]);
  });
});

describe("the words a task uses", () => {
  /** The pages of each kind, as the fixtures of the page tests render them. */
  const KIND: Record<ControlRef["page"], (name: string) => boolean> = {
    matter: (name) => name.startsWith("matter,"),
    run: (name) => name.startsWith("run,"),
    finding: (name) => name.startsWith("finding page") || name.startsWith("pane,"),
    memos: (name) => name.startsWith("memos,"),
  };

  /** The visible text of every link, button, label, legend, heading, option and summary of a page. */
  function names(html: string): Set<string> {
    const root = parseHtml(html);
    const found = new Set<string>();
    const add = (el: El): void => {
      found.add(readable(el).replace(/[.:]$/, ""));
    };
    for (const tag of ["a", "button", "label", "legend", "summary", "option", "th", "strong"])
      for (const el of byTag(root, tag)) add(el);
    for (const el of all(root, (e) => /^h[1-6]$/.test(e.name))) add(el);
    return found;
  }

  const pages = (kind: ControlRef["page"]): Set<string>[] =>
    variants.filter(([name]) => KIND[kind](name)).map(([, make]) => names(make()));

  for (const step of TRAINING_STEPS)
    for (const control of step.controls)
      it(`step ${step.n}: "${control.label}" is the visible text of a control on a ${control.page} page`, () => {
        const seen = pages(control.page);
        expect(seen.length, `no ${control.page} page in the fixtures`).toBeGreaterThan(0);
        expect(
          seen.some((found) => [...found].some((text) => text === control.label)),
          `no ${control.page} page shows "${control.label}"`,
        ).toBe(true);
      });
});
