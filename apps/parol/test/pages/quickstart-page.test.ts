import { describe, expect, it } from "vitest";
import { MATTER_ACTIONS, roleAllows, type MatterAction } from "../../src/auth/actions.js";
import { FIELDS } from "../../src/server/pages/forms.js";
import { NO_PLAYBOOK_SENTENCE } from "../../src/server/pages/quickstart.js";
import { REFUSALS_TRAINING } from "../../src/server/routes/refusals-training.js";
import { TRAINING_WHO_LABEL, plainStrong } from "../../src/server/views/training.js";
import { urls } from "../../src/server/urls.js";
import { QUICKSTART_STEPS, TRAINING_STEPS } from "../../src/training/index.js";
import { accessibleName, expectAccessible, tabStops } from "../a11y/rules.js";
import {
  all,
  attr,
  byId,
  byTag,
  controls,
  forms,
  formsTo,
  hasAttr,
  hasClass,
  readable,
  withClass,
  type El,
} from "./html.js";
import { checkInvariants } from "./invariants.js";
import { OWN_TRAINING, REFUSED_CHROME, START_VIEW, quickstartHtml } from "./training-support.js";
import { buildChrome } from "./support.js";
import { VARIANTS_TRAINING } from "./variants-training.js";

/**
 * The quickstart page (package W2.8): the ten steps, the seven of the exercise and the start form.
 * A page of fixed sentences and a person's own matter link, so these tests read the HTML a view
 * makes, state by state, and hold it to the rules every page has (`checkInvariants`) and to the
 * keyboard and label rules of test/a11y/rules.ts. The routes that serve it are in
 * test/routes/training-routes.test.ts.
 */

const SIGNED_IN = buildChrome();

/** What the start form tells the trainee a trainer can do. A trainer is added as a viewer. */
const TRAINER_HINT =
  "A trainer can open the matter and read it. Like any member they can add notes, report a missed issue and rate the matter. They cannot decide a finding, start or change a review, export the memo or change the matter.";

type VisibleAction = Exclude<MatterAction, "matter.delete">;

/** The words by which the hint above names each action of the role table. */
const VIEWER_PHRASES: Record<VisibleAction, readonly string[]> = {
  "matter.read": ["read"],
  "run.read": ["read"],
  "finding.read": ["read"],
  "memo.read": ["read"],
  "feedback.add": ["add notes", "report a missed issue", "rate the matter"],
  "review.decide": ["decide a finding"],
  "run.start": ["start or change a review"],
  "run.resume": ["start or change a review"],
  "memo.export": ["export the memo"],
  "matter.update": ["change the matter"],
  "document.write": ["change the matter"],
  "member.add": ["change the matter"],
};

const read = (html: string): { html: string; root: El } => ({ html, root: checkInvariants(html) });

const startForm = (root: El): El | undefined => formsTo(root, urls.training())[0];

/** The forms of the page itself: the sign-out form of the frame is on every page of a signed-in person. */
const pageForms = (root: El): El[] =>
  forms(root).filter((f) => attr(f, "action") !== urls.session());

describe("the quickstart, for a visitor", () => {
  const { html, root } = read(quickstartHtml());

  it("is a whole page with one heading, a title, and every rule of the keyboard and the labels met", () => {
    expect(readable(byTag(root, "h1")[0] as El)).toBe("Quickstart");
    expect(readable(byTag(root, "title")[0] as El)).toBe("Quickstart | Parol");
    expectAccessible(html);
  });

  it("lists the ten steps in order, with the bold of each, and says Not built yet on a step only when the list marks it so", () => {
    const list = withClass(root, "quickstart-steps")[0] as El;
    expect(list.name).toBe("ol");
    const items = byTag(list, "li");
    expect(items).toHaveLength(10);
    items.forEach((item, index) => {
      const step = QUICKSTART_STEPS[index]!;
      const notBuilt = step.availability === "not_built";
      // The step's words, with the bold marks gone, then "Not built yet." when it is not built.
      expect(readable(item)).toBe(
        notBuilt ? `${plainStrong(step.text)} Not built yet.` : plainStrong(step.text),
      );
      expect(byTag(item, "strong").length, `step ${step.n}`).toBeGreaterThan(0);
    });
    expect(
      items
        .map((item, i) => (readable(item).endsWith("Not built yet.") ? i + 1 : null))
        .filter(Boolean),
    ).toEqual(
      QUICKSTART_STEPS.filter((step) => step.availability === "not_built").map((step) => step.n),
    );
  });

  it("lists the seven steps of the exercise with who does them, the task and what it teaches, each under a heading", () => {
    const list = withClass(root, "training-steps")[0] as El;
    expect(list.name).toBe("ol");
    const items = byTag(list, "li");
    expect(items).toHaveLength(7);
    items.forEach((item, index) => {
      const step = TRAINING_STEPS[index]!;
      const heading = byTag(item, "h3");
      expect(heading).toHaveLength(1);
      expect(readable(heading[0] as El)).toBe(`Step ${step.n}: ${step.title}`);
      const text = readable(item);
      expect(text).toContain(`Who: ${TRAINING_WHO_LABEL[step.who]}`);
      expect(text).toContain(step.task);
      expect(text).toContain(`What it teaches: ${step.teaches}`);
    });
  });

  it("does not end a task that ends in a question mark with a second mark", () => {
    const text = readable(withClass(root, "training-steps")[0] as El);
    expect(text).toContain("What will Parol do with that paragraph?");
    expect(text).not.toContain("paragraph?.");
    expect(text).not.toMatch(/\.\./);
  });

  it("tells the visitor to sign in first, with a link to the start page, and offers no form", () => {
    expect(readable(root)).toContain("Sign in first.");
    const link = all(root, (el) => el.name === "a" && readable(el) === "Choose a demo identity")[0];
    expect(attr(link as El, "href")).toBe(urls.home());
    expect(formsTo(root, urls.training())).toEqual([]);
    expect(pageForms(root)).toEqual([]);
  });

  it("says what the page cannot show: a program and not a language model, nobody timed it, no person has done it, no passwords", () => {
    const text = readable(root);
    expect(text).toContain(
      "a program with a table of answers written in advance, not a language model",
    );
    expect(text).toContain("nobody has timed it");
    expect(text).toContain("No person has done the exercise yet");
    expect(text).toContain("The sign-in has no passwords and is not authentication");
    expect(text).toContain("Parol drafts findings. An attorney decides every one.");
    expect(text).toContain("When documents change, earlier decisions stop counting.");
    expect(text).toContain("PAROL_SCRIPTED=1");
  });

  it("has a list of its three sections whose links lead to places on the page", () => {
    const nav = all(root, (el) => el.name === "nav" && attr(el, "aria-label") === "On this page");
    expect(nav).toHaveLength(1);
    const links = byTag(nav[0] as El, "a");
    expect(links.map((l) => readable(l))).toEqual([
      "Before you start",
      "The ten steps",
      "The training exercise",
    ]);
    for (const link of links) {
      const target = byId(root, (attr(link, "href") as string).slice(1));
      expect(target, attr(link, "href") as string).toBeDefined();
      expect(target!.name).toBe("section");
    }
  });

  it("links to the help page", () => {
    const link = all(root, (el) => el.name === "a" && readable(el) === "help page")[0];
    expect(attr(link as El, "href")).toBe(urls.help());
  });

  it("carries no answer key, no rule key and no title of the rule the exercise plants", () => {
    const text = readable(root).toLowerCase();
    for (const step of TRAINING_STEPS) expect(text).not.toContain(step.key.toLowerCase());
    expect(text).not.toContain("pds-1");
    expect(text).not.toContain("disclosure to representatives");
    expect(text).not.toContain("definition clause");
    expect(html).not.toContain(urls.trainerKey());
  });

  it("puts the keyboard in order: the skip link, the navigation, the section links, then the links in the page", () => {
    const names = tabStops(root).map((el) => accessibleName(root, el));
    expect(names.slice(0, 4)).toEqual(["Skip to main content", "Parol", "Matters", "Quickstart"]);
    expect(names.slice(4, 6)).toEqual(["Help", "Before you start"]);
    expect(names).toContain("Choose a demo identity");
    expect(names).toContain("help page");
  });
});

describe("the quickstart, for a signed-in person without a training matter", () => {
  const { html, root } = read(quickstartHtml({ chrome: SIGNED_IN, start: START_VIEW }));
  const form = startForm(root) as El;

  it("meets every rule of the keyboard and the labels", () => {
    expectAccessible(html);
  });

  it("offers one form to the start route, with the token, two labelled selects and one button", () => {
    expect(form).toBeDefined();
    expect(attr(form, "method")).toBe("post");
    expect(attr(form, "id")).toBe("training-start");
    expect(all(form, (el) => attr(el, "name") === "_csrf")).toHaveLength(1);
    expect(byTag(form, "button").map((b) => readable(b))).toEqual(["Start the training matter"]);
    expect(byTag(form, "select")).toHaveLength(2);
    for (const [id, name, label] of [
      ["training-reviewer", FIELDS.reviewerUserId, "Reviewing attorney"],
      ["training-trainer", FIELDS.trainerUserId, "Trainer (optional)"],
    ] as const) {
      const select = controls(form, name)[0] as El;
      expect(attr(select, "id")).toBe(id);
      expect(accessibleName(root, select)).toBe(label);
      expect(attr(select, "aria-describedby")).toBe(`${id}-hint`);
      expect(byId(root, `${id}-hint`)).toBeDefined();
    }
  });

  it("requires the reviewing attorney and not the trainer, and lists every person after the empty choice", () => {
    const reviewer = controls(form, FIELDS.reviewerUserId)[0] as El;
    const trainer = controls(form, FIELDS.trainerUserId)[0] as El;
    expect(hasAttr(reviewer, "required")).toBe(true);
    expect(hasAttr(trainer, "required")).toBe(false);
    const options = (select: El): string[] => byTag(select, "option").map((o) => readable(o));
    expect(options(reviewer)).toEqual([
      "Choose a person",
      ...START_VIEW.people.map((p) => p.displayName),
    ]);
    expect(options(trainer)).toEqual([
      "No trainer",
      ...START_VIEW.people.map((p) => p.displayName),
    ]);
    // Nothing is chosen for the person.
    expect(all(form, (el) => el.name === "option" && hasAttr(el, "selected"))).toEqual([]);
    expect(attr(byTag(reviewer, "option")[0] as El, "value")).toBe("");
  });

  it("says the reviewing attorney cannot be the person, and what the trainer can do", () => {
    expect(readable(byId(root, "training-reviewer-hint") as El)).toBe(
      "This person decides the findings. It cannot be you unless the server is set for one person.",
    );
    expect(readable(byId(root, "training-trainer-hint") as El)).toBe(TRAINER_HINT);
  });

  it("says of the trainer what the role table says of a viewer, which is the role a trainer is given", () => {
    const hint = readable(byId(root, "training-trainer-hint") as El);
    // The sentence that was there said they cannot change anything, and a viewer can add feedback.
    expect(hint).not.toMatch(/cannot change anything|change nothing/);
    const [can, cannot] = hint.split("They cannot ") as [string, string];
    expect(cannot).toBeDefined();
    // Every action of the table is covered by a phrase, so a new action cannot go unsaid.
    const actions = Object.keys(MATTER_ACTIONS).filter((a) => a !== "matter.delete");
    expect(actions.sort()).toEqual(Object.keys(VIEWER_PHRASES).sort());
    for (const action of actions as VisibleAction[]) {
      const allowed = roleAllows("viewer", action);
      for (const phrase of VIEWER_PHRASES[action])
        expect(allowed ? can : cannot, `${action}: ${phrase}`).toContain(phrase);
      for (const phrase of VIEWER_PHRASES[action])
        expect(allowed ? cannot : can, `${action}: ${phrase}`).not.toContain(phrase);
    }
  });

  it("does not say Sign in first, and does not link to a training matter that does not exist", () => {
    expect(readable(root)).not.toContain("Sign in first.");
    expect(all(root, (el) => readable(el) === "Open the training matter")).toEqual([]);
  });

  it("puts the start form's controls after the links of the page, in reading order", () => {
    const names = tabStops(root).map((el) => accessibleName(root, el));
    const at = (name: string): number => names.indexOf(name);
    expect(at("Before you start")).toBeLessThan(at("Reviewing attorney"));
    expect(at("Reviewing attorney")).toBeLessThan(at("Trainer (optional)"));
    expect(at("Trainer (optional)")).toBeLessThan(at("Start the training matter"));
  });
});

describe("the quickstart for a server that lets one person do both", () => {
  const { html, root } = read(
    quickstartHtml({ chrome: SIGNED_IN, start: { ...START_VIEW, relaxedSegregation: true } }),
  );

  it("does not require the reviewing attorney, and says why", () => {
    const form = startForm(root) as El;
    expect(hasAttr(controls(form, FIELDS.reviewerUserId)[0] as El, "required")).toBe(false);
    expect(readable(byId(root, "training-reviewer-hint") as El)).toBe(
      "This person decides the findings. You may leave it empty, because this server lets one person do both.",
    );
    expectAccessible(html);
  });
});

describe("the quickstart after a refusal", () => {
  const { html, root } = read(
    quickstartHtml({
      chrome: REFUSED_CHROME,
      start: { ...START_VIEW, chosen: { reviewerUserId: "u_ruiz", trainerUserId: "u_okafor" } },
    }),
  );

  it("shows the refusal in one alert with the sentence to follow in bold and a link to the field", () => {
    const alerts = all(root, (el) => attr(el, "role") === "alert");
    expect(alerts).toHaveLength(1);
    expect(hasClass(alerts[0] as El, "notice-error")).toBe(true);
    const todo = withClass(alerts[0] as El, "todo");
    expect(todo.map((el) => readable(el))).toEqual([REFUSALS_TRAINING.todo.bad_reviewer]);
    const jump = all(alerts[0] as El, (el) => el.name === "a");
    expect(jump).toHaveLength(1);
    expect(attr(jump[0] as El, "href")).toBe("#training-reviewer");
    // The link leads to a place on this page: the select it names.
    expect(byId(root, "training-reviewer")?.name).toBe("select");
    expectAccessible(html);
  });

  it("keeps the choices the person made", () => {
    const form = startForm(root) as El;
    const selected = (name: string): string[] =>
      all(
        controls(form, name)[0] as El,
        (el) => el.name === "option" && hasAttr(el, "selected"),
      ).map((o) => attr(o, "value") as string);
    expect(selected(FIELDS.reviewerUserId)).toEqual(["u_ruiz"]);
    expect(selected(FIELDS.trainerUserId)).toEqual(["u_okafor"]);
  });
});

describe("the quickstart for a person who has a training matter", () => {
  const { html, root } = read(quickstartHtml({ chrome: SIGNED_IN, ownTraining: OWN_TRAINING }));

  it("links to the matter and offers no form", () => {
    const link = all(root, (el) => el.name === "a" && readable(el) === "Open the training matter");
    expect(link).toHaveLength(1);
    expect(attr(link[0] as El, "href")).toBe(urls.matter(OWN_TRAINING.matterId));
    expect(pageForms(root)).toEqual([]);
    expectAccessible(html);
  });

  it("names the matter by its address only, not by a name or a title", () => {
    expect(html).not.toContain("Training: Lanternfish");
  });
});

describe("the quickstart when no playbook version is approved", () => {
  const { html, root } = read(
    quickstartHtml({ chrome: SIGNED_IN, start: { ...START_VIEW, playbookAvailable: false } }),
  );

  it("says so, in the words of the refusal, and offers no form", () => {
    expect(NO_PLAYBOOK_SENTENCE).toBe(REFUSALS_TRAINING.phrases.no_playbook);
    expect(readable(root)).toContain(NO_PLAYBOOK_SENTENCE);
    expect(pageForms(root)).toEqual([]);
    expectAccessible(html);
  });
});

describe("the fixtures of the quickstart", () => {
  it("are all whole pages that pass the rules of the keyboard and the labels", () => {
    const pages = VARIANTS_TRAINING.filter(([name]) => name.startsWith("quickstart"));
    expect(pages.length).toBeGreaterThanOrEqual(6);
    for (const [name, make] of pages) {
      const html = make();
      checkInvariants(html);
      expectAccessible(html);
      expect(html.toLowerCase(), name).not.toContain("pds-1");
    }
  });
});
