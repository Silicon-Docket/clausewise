import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import { UploadError } from "../../src/module-contracts.js";
import {
  NOTICES,
  REFUSAL_FRAGMENTS,
  REFUSAL_JUMP,
  REFUSAL_PHRASES,
  REFUSAL_TODO,
  refusalOf,
  type NamedRefusalFragment,
} from "../../src/server/routes/notices.js";
import { SpendRefusedError } from "../../src/services/errors.js";
import { ConflictError, ValidationError } from "../../src/store/errors.js";
import { attributeValues, parseHtml } from "../pages/html.js";
import { variants, type Variant } from "../pages/variants.js";
import { VARIANTS_FEEDBACK } from "../pages/variants-feedback.js";
import { VARIANTS_PILOT } from "../pages/variants-pilot.js";
import { VARIANTS_RETENTION } from "../pages/variants-retention.js";
import { VARIANTS_TRAINING } from "../pages/variants-training.js";

/**
 * The refusals of every fragment (the core of the application and the four packages that added
 * codes) are complete: each phrase says what to do, in a sentence that occurs inside it; each place
 * a refusal leads to is an element of a page of that fragment's own page fixtures; and each phrase
 * that leads nowhere says why. What these tests can show: the tables are consistent with each other
 * and with the pages the fixtures render. What they cannot show: that a person who is led to a
 * place finds there the control that is wrong, or that the words are clear.
 */

const NO_DASH = /[\u2013\u2014]/;

/** The page fixtures each fragment's places are looked for in. */
const OWN_PAGES: Record<string, readonly Variant[]> = {
  feedback: VARIANTS_FEEDBACK,
  pilot: VARIANTS_PILOT,
  retention: VARIANTS_RETENTION,
  training: VARIANTS_TRAINING,
};
const packagePages = new Set<Variant>(Object.values(OWN_PAGES).flat());
/** The core fragment's places are on the pages that no package added: the matter, the run, the finding. */
const PAGES: Record<string, readonly Variant[]> = {
  ...OWN_PAGES,
  core: variants.filter((variant) => !packagePages.has(variant)),
};

/** The ids of the elements of every page in the list, as the pages render them. */
function idsOn(pages: readonly Variant[]): Set<string> {
  const ids = new Set<string>();
  for (const [, render] of pages)
    for (const found of attributeValues(parseHtml(render())))
      if (found.name === "id") ids.add(found.value);
  return ids;
}

/**
 * The phrases that lead nowhere, each with the reason. A refusal that is fixed in a control of a
 * form leads to it; one that is about the matter, the review, a person's role or the data folder
 * has no control to lead to, or is raised by more than one form, and says so here. The list is
 * written to be argued with: a phrase that can lead to a control belongs in its fragment's `jump`.
 */
const NO_PLACE_TO_GO: Record<string, string> = {
  // core: the decision
  edits_not_allowed:
    "raised only by a form posted by hand, which sends edits with another decision",
  bad_hash: "the page itself was made badly or is old; reloading it is the fix",
  too_many_roles:
    "raised only by a form posted by hand, with more labels than the finding has passages",
  content_mismatch: "about the finding, which changed after the page was opened",
  stale_finding: "about the finding, which the documents or the playbook left behind",
  decision_conflict: "about another reviewer's decision, not a control",
  matter_exported: "about the matter, whose memo was exported",
  matter_not_in_review: "about the matter's state, not a control",
  run_not_succeeded: "about the review, which has not finished",
  // core: text, reviews, the memo
  bad_text: "raised for many fields of many forms, so no one place is right",
  invalid_transition: "about the review's state, not a control",
  stale_run: "about the review, which the documents or the playbook left behind",
  export_blocked: "about the findings and the review, not a control of the export form",
  memo_quote_unverified: "about a passage of a finding, not a control",
  reviews_changed: "about decisions made while the memo was built, not a control",
  memo_file_missing: "about a file on the server's disk, which only the operator can restore",
  memo_file_changed: "about a file on the server's disk, which only the operator can look at",
  // feedback
  unknown_rule: "raised by the report form and the reference list, which are on different pages",
  run_has_no_findings: "about the review, which has nothing to report against",
  feedback_limit: "raised by the report form and the note form, which are on different pages",
  finding_not_current: "about the finding, whose page shows the sentence in place of the note form",
  already_rated: "about the matter, which has been rated, and a rating is final",
  not_exported: "about the matter, which has no memo yet",
  // pilot
  timer_open: "about a timer that is running, which the page shows as running",
  timer_role: "about the person's role on the matter",
  reference_locked: "about the list, which a review closed",
  reference_role: "about the person's role on the matter",
  timer_training: "about the matter, which is a training matter and takes no timer",
  reference_training: "about the matter, which is a training matter and has no reference list",
  // retention
  matter_residue: "about the data, which only the operator can look at",
  // training
  no_playbook: "about the installation, which only the operator can fix",
  training_files_missing: "about the installation, which only the operator can fix",
};

const sentenceShape = /^[A-Z][^]*\.$/;

describe("the fragments", () => {
  it("are the core and the four packages that added codes, and each holds codes", () => {
    expect(REFUSAL_FRAGMENTS.map(({ name }) => name)).toEqual([
      "core",
      "feedback",
      "pilot",
      "retention",
      "training",
    ]);
    for (const { name, fragment } of REFUSAL_FRAGMENTS)
      expect(Object.keys(fragment.phrases).length, name).toBeGreaterThan(0);
  });

  it("make the merged tables, and nothing else is in them", () => {
    const union = (pick: (fragment: NamedRefusalFragment["fragment"]) => object | undefined) =>
      REFUSAL_FRAGMENTS.flatMap(({ fragment }) => Object.keys(pick(fragment) ?? {})).sort();
    expect(Object.keys(REFUSAL_PHRASES).sort()).toEqual(union((f) => f.phrases));
    expect(Object.keys(REFUSAL_TODO).sort()).toEqual(union((f) => f.todo));
    expect(Object.keys(REFUSAL_JUMP).sort()).toEqual(union((f) => f.jump));
    expect(Object.keys(NOTICES).sort()).toEqual(union((f) => f.notices));
  });
});

for (const { name, fragment } of REFUSAL_FRAGMENTS) {
  describe(`the ${name} fragment`, () => {
    const codes = Object.keys(fragment.phrases);

    it("gives every phrase a todo that occurs inside it, and no todo without a phrase", () => {
      const without = codes.filter((code) => !Object.hasOwn(fragment.todo, code));
      expect(without, `phrases with no todo: ${without.join(", ")}`).toEqual([]);
      for (const [code, todo] of Object.entries(fragment.todo)) {
        expect(Object.hasOwn(fragment.phrases, code), `a todo for ${code} with no phrase`).toBe(
          true,
        );
        expect(
          fragment.phrases[code]!.includes(todo),
          `the todo of ${code} is not in its phrase`,
        ).toBe(true);
        expect(todo, code).toMatch(sentenceShape);
        expect(todo, code).not.toMatch(NO_DASH);
      }
      for (const [code, phrase] of Object.entries(fragment.phrases)) {
        expect(phrase, code).toMatch(sentenceShape);
        expect(phrase, code).not.toMatch(NO_DASH);
      }
    });

    it("leads every jump to an element that a page of this fragment's fixtures has", () => {
      const ids = idsOn(PAGES[name] ?? []);
      expect(ids.size, `the fixtures of ${name} render pages`).toBeGreaterThan(0);
      for (const [code, jump] of Object.entries(fragment.jump ?? {})) {
        expect(Object.hasOwn(fragment.phrases, code), `a jump for ${code} with no phrase`).toBe(
          true,
        );
        expect(Object.hasOwn(fragment.todo, code), `${code} has a jump and no todo`).toBe(true);
        expect(jump.href.startsWith("#"), code).toBe(true);
        expect(
          ids.has(jump.href.slice(1)),
          `${code} leads to ${jump.href}, which no page has`,
        ).toBe(true);
        expect(jump.label.trim(), code).not.toBe("");
        expect(jump.label, code).not.toMatch(NO_DASH);
      }
    });

    it("gives every phrase a place to go, or the reason it has none", () => {
      const jumps = fragment.jump ?? {};
      const unplaced = codes.filter(
        (code) => !Object.hasOwn(jumps, code) && !Object.hasOwn(NO_PLACE_TO_GO, code),
      );
      expect(
        unplaced,
        `phrases that lead nowhere and say nothing why: ${unplaced.join(", ")}`,
      ).toEqual([]);
      const stale = codes.filter(
        (code) => Object.hasOwn(jumps, code) && Object.hasOwn(NO_PLACE_TO_GO, code),
      );
      expect(
        stale,
        `phrases listed as leading nowhere that lead somewhere: ${stale.join(", ")}`,
      ).toEqual([]);
    });
  });
}

describe("the list of phrases that lead nowhere", () => {
  const phrases = new Set(Object.keys(REFUSAL_PHRASES));

  it("holds no code that has no phrase, and a reason of one line in plain words for each", () => {
    for (const [code, reason] of Object.entries(NO_PLACE_TO_GO)) {
      expect(phrases.has(code), `${code} has no phrase`).toBe(true);
      expect(reason.trim(), code).not.toBe("");
      expect(reason, code).not.toMatch(/[\n\r]/);
      expect(reason.length, code).toBeLessThanOrEqual(120);
      expect(reason, code).not.toMatch(NO_DASH);
    }
  });
});

describe("what a person is shown", () => {
  it("is a notice with the todo of the code, that occurs in its words, for every phrase of every fragment", () => {
    for (const code of Object.keys(REFUSAL_PHRASES)) {
      const refusal = refusalOf(new ConflictError(code, "x"));
      expect(refusal, code).not.toBeNull();
      expect(refusal!.notice.text, code).toBe(REFUSAL_PHRASES[code]);
      expect(refusal!.notice.todo, code).toBe(REFUSAL_TODO[code]);
      expect(refusal!.notice.text.includes(refusal!.notice.todo ?? "\u0000"), code).toBe(true);
      expect(refusal!.notice.jump, code).toEqual(REFUSAL_JUMP[code]);
    }
  });

  it("is a notice with a todo that occurs in its words for every other refusal too: a code with no phrase, a form that could not be read, an upload and a review the spend guard refused", () => {
    const parse = z.object({ a: z.string() }).safeParse({ a: 1 });
    const errors: [string, unknown][] = [
      ["a conflict with a code nobody wrote", new ConflictError("a_code_nobody_wrote", "x")],
      [
        "a validation error with a code nobody wrote",
        new ValidationError("a_code_nobody_wrote", "x"),
      ],
      ["a validation error with no code of the shape", new ValidationError("Not A Code", "x")],
      ["a form that could not be parsed", (parse as { error: ZodError }).error],
      ["an upload the ingest refused", new UploadError("This file is empty.")],
      [
        "a review over a limit",
        new SpendRefusedError(
          "spend_over_review_limit",
          { boundUsd: 3, limitUsd: 2, usedUsd: 0, heldUsd: 0 },
          "start",
        ),
      ],
    ];
    for (const [what, error] of errors) {
      const refusal = refusalOf(error);
      expect(refusal, what).not.toBeNull();
      expect(refusal!.notice.kind, what).toBe("error");
      expect(refusal!.notice.todo, what).toBeDefined();
      expect(refusal!.notice.text.includes(refusal!.notice.todo!), what).toBe(true);
    }
  });
});
