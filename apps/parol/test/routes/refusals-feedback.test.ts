import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NOTICES,
  REFUSAL_JUMP,
  REFUSAL_PHRASES,
  REFUSAL_TODO,
  noticeFor,
  refusalOf,
} from "../../src/server/routes/notices.js";
import { REFUSALS_FEEDBACK } from "../../src/server/routes/refusals-feedback.js";
import { ConflictError, ValidationError } from "../../src/store/index.js";
import { byId, parseHtml } from "../pages/html.js";
import {
  decisionPane,
  feedbackProps,
  memosPageWith,
  notesPane,
  ratingProps,
  runPageWith,
} from "../pages/feedback-support.js";

/**
 * The words of the refusals of the reason code and the minor-edit mark (package W2.6a, slice A):
 * each code has a phrase, a sentence inside the phrase that says what to do, and a link to the
 * control of the decision form where it is mended.
 *
 * Slice B adds the codes of the report of a missed issue: each has a phrase, a sentence inside it
 * that says what to do, and (where one field of the form is to blame) a link to that field.
 *
 * Slice C adds the codes of the rating of a matter: the mark and the comment have a link to their
 * controls, and the two conflicts (a rating already given, a matter not yet exported) are told in
 * words with the thing to do instead.
 *
 * Slice D adds the codes of a note on a finding: an empty or a too long note has a link to the note
 * of the finding pane, and a finding that has gone out of date says so and leads nowhere. A note has
 * codes of its own, apart from the report's, so that each link leads to the control that is wrong.
 */

const SLICE_A = [
  "reason_code_required",
  "reason_code_not_allowed",
  "bad_reason_code",
  "minor_edit_not_allowed",
  "minor_edit_status",
] as const;

const DASH = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");

describe("the fragment of the feedback package", () => {
  it("defines each code of the slice once, with a phrase, a todo and a jump", () => {
    for (const code of SLICE_A) {
      expect(Object.keys(REFUSALS_FEEDBACK.phrases), code).toContain(code);
      expect(Object.keys(REFUSALS_FEEDBACK.todo), code).toContain(code);
      expect(Object.keys(REFUSALS_FEEDBACK.jump), code).toContain(code);
      // The merged tables hold them, from this fragment and from no other.
      expect(REFUSAL_PHRASES[code], code).toBe(REFUSALS_FEEDBACK.phrases[code]);
      expect(REFUSAL_TODO[code], code).toBe(REFUSALS_FEEDBACK.todo[code]);
      expect(REFUSAL_JUMP[code], code).toEqual(REFUSALS_FEEDBACK.jump[code]);
    }
  });

  it("gives each phrase as one plain sentence group, with the todo inside it as a sentence of its own", () => {
    for (const code of SLICE_A) {
      const phrase = REFUSAL_PHRASES[code]!;
      const todo = REFUSAL_TODO[code]!;
      expect(phrase, code).toMatch(/^[A-Z][^<>&"]*\.$/);
      expect(phrase, code).toContain(todo);
      // The todo is a whole sentence of the phrase and not the whole of it: the phrase says what is
      // wrong in the other sentence, before or after.
      expect(todo.length, code).toBeLessThan(phrase.length);
      expect(todo, code).toMatch(/^[A-Z][^<>&"]*\.$/);
      const at = phrase.indexOf(todo);
      expect(at === 0 || /\.\s$/.test(phrase.slice(0, at)), `${code} starts a sentence`).toBe(true);
      const end = at + todo.length;
      expect(end === phrase.length || phrase[end] === " ", `${code} ends a sentence`).toBe(true);
      for (const text of [phrase, todo, REFUSAL_JUMP[code]!.label])
        expect(text, code).not.toMatch(DASH);
    }
  });

  it("says what to do with the control it leads to", () => {
    expect(REFUSAL_TODO["reason_code_required"]).toBe("Choose a reason code.");
    expect(REFUSAL_TODO["bad_reason_code"]).toBe("Choose one from the list.");
    expect(REFUSAL_TODO["minor_edit_status"]).toBe("Clear the box, or leave the status as it is.");
    expect(REFUSAL_PHRASES["reason_code_required"]).toBe(
      "Choose a reason code. An edit or a reject needs one.",
    );
    expect(REFUSAL_PHRASES["minor_edit_status"]).toBe(
      "An edit that changes the status is not a minor edit. Clear the box, or leave the status as it is.",
    );
  });

  it("jumps to a control that the decision form has, by the id the link names", () => {
    const form = parseHtml(decisionPane());
    const expected: Record<(typeof SLICE_A)[number], string> = {
      reason_code_required: "#decision-reason-code",
      reason_code_not_allowed: "#decision-reason-code",
      bad_reason_code: "#decision-reason-code",
      minor_edit_not_allowed: "#edit-minor",
      minor_edit_status: "#edit-minor",
    };
    for (const code of SLICE_A) {
      const jump = REFUSAL_JUMP[code]!;
      expect(jump.href, code).toBe(expected[code]);
      expect(jump.label, code).toMatch(/^Go to the [a-z -]+$/);
      expect(byId(form, jump.href.slice(1)), code).toBeDefined();
    }
  });
});

describe("the refusal the person is shown", () => {
  it("is the phrase with its todo and its jump, with the status of the store's error", () => {
    for (const code of SLICE_A) {
      const refusal = refusalOf(new ValidationError(code, "words the store wrote for itself"));
      expect(refusal, code).toEqual({
        status: 400,
        code,
        notice: {
          kind: "error",
          text: REFUSAL_PHRASES[code],
          todo: REFUSAL_TODO[code],
          jump: REFUSAL_JUMP[code],
        },
      });
    }
  });

  it("never repeats what the store's message said, whatever it said", () => {
    const hostile = "ZQ-WORDS-OF-THE-REQUEST";
    for (const code of SLICE_A) {
      const refusal = refusalOf(new ValidationError(code, hostile));
      expect(JSON.stringify(refusal), code).not.toContain(hostile);
    }
  });

  it("is not a 409: these are the person's to mend, in the form, and the store says 400", () => {
    for (const code of SLICE_A)
      expect(refusalOf(new ConflictError(code, "x"))?.status, code).toBe(409);
    for (const code of SLICE_A)
      expect(refusalOf(new ValidationError(code, "x"))?.status, code).toBe(400);
  });
});

describe("the codes the store and the routes can throw", () => {
  it("are all in the fragment: no refusal of the reason code or the mark falls back to the general sentence", () => {
    const here = join(import.meta.dirname, "../../src");
    const found = new Set<string>();
    for (const file of ["store/repo-findings.ts", "server/routes/decision.ts"]) {
      const text = readFileSync(join(here, file), "utf8");
      for (const m of text.matchAll(/new ValidationError\(\s*"([a-z_]+)"/g)) {
        const code = m[1]!;
        if (/reason_code|minor_edit/.test(code)) found.add(code);
      }
    }
    expect([...found].sort()).toEqual([...SLICE_A].sort());
    for (const code of found) expect(Object.keys(REFUSAL_PHRASES), code).toContain(code);
  });
});

// ---------------------------------------------------------------------------------------------
// Slice B: the report of a missed issue
// ---------------------------------------------------------------------------------------------

/** The codes of the report that a field of the form is to blame for, and the control each leads to. */
const SLICE_B_FIELD = {
  rule_required: "#missed-issue-rule",
  note_required: "#missed-issue-note",
  note_too_long: "#missed-issue-note",
  location_too_long: "#missed-issue-location",
} as const;
/**
 * The codes that no field mends, or that more than one form can raise: they say what to do and lead
 * nowhere. `unknown_rule` is the reference list's too (decision R10 of the plan), whose page has no
 * such list, and a link to a list that is not on the page would dangle there.
 */
const SLICE_B_NO_JUMP = ["unknown_rule", "run_has_no_findings", "feedback_limit"] as const;
const SLICE_B = [...Object.keys(SLICE_B_FIELD), ...SLICE_B_NO_JUMP] as (
  keyof typeof SLICE_B_FIELD | (typeof SLICE_B_NO_JUMP)[number]
)[];
const CONFLICTS = ["run_has_no_findings", "feedback_limit"];

describe("the fragment of the feedback package, the report of a missed issue", () => {
  it("defines each code once, with a phrase and a todo, in the merged tables and from this fragment alone", () => {
    expect(SLICE_B).toHaveLength(7);
    for (const code of SLICE_B) {
      expect(Object.keys(REFUSALS_FEEDBACK.phrases), code).toContain(code);
      expect(Object.keys(REFUSALS_FEEDBACK.todo), code).toContain(code);
      expect(REFUSAL_PHRASES[code], code).toBe(REFUSALS_FEEDBACK.phrases[code]);
      expect(REFUSAL_TODO[code], code).toBe(REFUSALS_FEEDBACK.todo[code]);
    }
  });

  it("gives each phrase as plain sentences with the todo inside it as a sentence of its own", () => {
    for (const code of SLICE_B) {
      const phrase = REFUSAL_PHRASES[code]!;
      const todo = REFUSAL_TODO[code]!;
      expect(phrase, code).toMatch(/^[A-Z][^<>&"]*\.$/);
      expect(phrase, code).toContain(todo);
      expect(todo.length, code).toBeLessThan(phrase.length);
      expect(todo, code).toMatch(/^[A-Z][^<>&"]*\.$/);
      const at = phrase.indexOf(todo);
      expect(at === 0 || /\.\s$/.test(phrase.slice(0, at)), `${code} starts a sentence`).toBe(true);
      const end = at + todo.length;
      expect(end === phrase.length || phrase[end] === " ", `${code} ends a sentence`).toBe(true);
      expect(phrase, code).not.toMatch(DASH);
      expect(todo, code).not.toMatch(DASH);
    }
  });

  it("leads each code that one field is to blame for to that field, and no other code anywhere", () => {
    for (const [code, href] of Object.entries(SLICE_B_FIELD)) {
      const jump = REFUSAL_JUMP[code]!;
      expect(jump.href, code).toBe(href);
      expect(jump.label, code).toMatch(/^Go to the [a-z -]+$/);
      expect(jump.label, code).not.toMatch(DASH);
      expect(REFUSALS_FEEDBACK.jump[code as keyof typeof SLICE_B_FIELD], code).toEqual(jump);
    }
    for (const code of SLICE_B_NO_JUMP) expect(REFUSAL_JUMP[code], code).toBeUndefined();
  });

  it("leads to a control the report form has, by the id the link names, of the kind it is about", () => {
    const page = parseHtml(runPageWith(feedbackProps()));
    const kinds = {
      rule_required: "select",
      note_required: "textarea",
      note_too_long: "textarea",
      location_too_long: "input",
    } as const;
    for (const [code, href] of Object.entries(SLICE_B_FIELD))
      expect(byId(page, href.slice(1))?.name, code).toBe(kinds[code as keyof typeof kinds]);
  });

  it("says what to do about the things it asks of the person", () => {
    expect(REFUSAL_PHRASES["rule_required"]).toBe(
      "No rule was chosen. Choose the rule the review should have applied, or Not covered by any rule.",
    );
    expect(REFUSAL_PHRASES["unknown_rule"]).toBe(
      "That rule is not in the playbook of this matter. Choose one from the list.",
    );
    expect(REFUSAL_PHRASES["note_too_long"]).toBe(
      "The note is longer than 4,000 characters. Shorten it.",
    );
    expect(REFUSAL_PHRASES["location_too_long"]).toBe(
      "The location is longer than 200 characters. Shorten it.",
    );
    expect(REFUSAL_TODO["run_has_no_findings"]).toBe("Open a review that has findings.");
  });

  it("has a notice for a saved report that is a success and says the report changes nothing", () => {
    expect(Object.keys(REFUSALS_FEEDBACK.notices)).toContain("missed-issue-saved");
    expect(NOTICES["missed-issue-saved"]).toEqual({
      kind: "success",
      text: "Your report was saved. It does not change any finding or decision.",
    });
    expect(noticeFor("missed-issue-saved")).toEqual(NOTICES["missed-issue-saved"]);
  });
});

describe("the refusal of a report the person is shown", () => {
  it("is the phrase with its todo and its jump, with the status of the store's error: 400 for the form, 409 for the state", () => {
    for (const code of SLICE_B) {
      const conflict = CONFLICTS.includes(code);
      const refusal = refusalOf(
        conflict
          ? new ConflictError(code, "words the store wrote for itself")
          : new ValidationError(code, "words the store wrote for itself"),
      );
      const jump = REFUSAL_JUMP[code];
      expect(refusal, code).toEqual({
        status: conflict ? 409 : 400,
        code,
        notice: {
          kind: "error",
          text: REFUSAL_PHRASES[code],
          todo: REFUSAL_TODO[code],
          ...(jump === undefined ? {} : { jump }),
        },
      });
    }
  });

  it("never repeats what the store's message said, whatever it said", () => {
    const hostile = "ZQ-WORDS-OF-THE-REQUEST";
    for (const code of SLICE_B) {
      const refusal = refusalOf(
        CONFLICTS.includes(code)
          ? new ConflictError(code, hostile)
          : new ValidationError(code, hostile),
      );
      expect(JSON.stringify(refusal), code).not.toContain(hostile);
    }
  });
});

describe("the codes the capture can raise", () => {
  const here = join(import.meta.dirname, "../../src");
  const codesIn = (text: string): Set<string> => {
    const found = new Set<string>();
    for (const m of text.matchAll(/new (?:Validation|Conflict)Error\(\s*"([a-z_]+)"/g))
      found.add(m[1]!);
    return found;
  };
  /** The text of the function of the store that adds feedback, up to the function that lists it. */
  const addFeedbackText = (): string => {
    const text = readFileSync(join(here, "store/repo-findings.ts"), "utf8");
    return text.slice(text.indexOf("function addFeedback("), text.indexOf("const listFeedback"));
  };

  it("are all in the fragment when a person can reach them: the parsers, the service, and the codes of the store a route can pass on", () => {
    const parsers = codesIn(readFileSync(join(here, "server/routes/feedback.ts"), "utf8"));
    const service = codesIn(readFileSync(join(here, "services/feedback.ts"), "utf8"));
    expect([...parsers].sort()).toEqual(
      [
        // The report of a missed issue (slice B).
        "location_too_long",
        "note_required",
        "note_too_long",
        "rule_required",
        "unknown_rule",
        // The rating of a matter (slice C).
        "bad_rating",
        "comment_too_long",
        "rating_required",
        // The note on a finding (slice D).
        "finding_note_required",
        "finding_note_too_long",
      ].sort(),
    );
    expect([...service].sort()).toEqual([
      "bad_rating",
      "finding_not_current",
      "not_exported",
      "run_has_no_findings",
    ]);
    const store = codesIn(addFeedbackText());
    // What the store raises that a person can mend has a phrase.
    for (const code of ["unknown_rule", "feedback_limit", "already_rated"]) {
      expect(store, code).toContain(code);
      expect(Object.keys(REFUSAL_PHRASES), code).toContain(code);
    }
    for (const code of [...parsers, ...service])
      expect(Object.keys(REFUSAL_PHRASES), code).toContain(code);
  });

  it("leave only the guards of the store that no route can reach without a phrase, and the list of them is exact", () => {
    // The service gives the store the person, the matter, the review and a mark it has checked, and
    // the parsers give it a note that says something, so these are for code that calls the store
    // another way. The mark and its absence are not among them: the store's `bad_rating` and
    // `rating_required` are the same codes the parsers and the service raise, with phrases.
    const guards = [
      "bad_kind",
      "field_not_allowed",
      "finding_not_allowed",
      "finding_required",
      // A note names the review its finding belongs to; the service gives the finding's own.
      "run_mismatch",
      "run_required",
      "text_required",
    ];
    const store = codesIn(addFeedbackText());
    const withoutPhrase = [...store].filter((code) => !Object.keys(REFUSAL_PHRASES).includes(code));
    expect(withoutPhrase.sort()).toEqual(guards.sort());
  });
});

// ---------------------------------------------------------------------------------------------
// Slice C: the rating of a matter
// ---------------------------------------------------------------------------------------------

/** The codes of the rating that a control of the form is to blame for, and the control each leads to. */
const SLICE_C_FIELD = {
  rating_required: "#rating-choice",
  bad_rating: "#rating-choice",
  comment_too_long: "#rating-comment",
} as const;
/**
 * The codes that no control mends: the matter has been rated already, or has no memo yet. They say
 * what to do instead and lead nowhere, because the page shows the rating that was given or the
 * sentence that there is no memo, and not the form.
 */
const SLICE_C_NO_JUMP = ["already_rated", "not_exported"] as const;
const SLICE_C = [...Object.keys(SLICE_C_FIELD), ...SLICE_C_NO_JUMP] as (
  keyof typeof SLICE_C_FIELD | (typeof SLICE_C_NO_JUMP)[number]
)[];
const SLICE_C_CONFLICTS: readonly string[] = SLICE_C_NO_JUMP;

describe("the fragment of the feedback package, the rating of a matter", () => {
  it("defines each code once, with a phrase and a todo, in the merged tables and from this fragment alone", () => {
    expect(SLICE_C).toHaveLength(5);
    for (const code of SLICE_C) {
      expect(Object.keys(REFUSALS_FEEDBACK.phrases), code).toContain(code);
      expect(Object.keys(REFUSALS_FEEDBACK.todo), code).toContain(code);
      expect(REFUSAL_PHRASES[code], code).toBe(REFUSALS_FEEDBACK.phrases[code]);
      expect(REFUSAL_TODO[code], code).toBe(REFUSALS_FEEDBACK.todo[code]);
    }
  });

  it("gives each phrase as plain sentences with the todo inside it as a sentence of its own", () => {
    for (const code of SLICE_C) {
      const phrase = REFUSAL_PHRASES[code]!;
      const todo = REFUSAL_TODO[code]!;
      expect(phrase, code).toMatch(/^[A-Z][^<>&"]*\.$/);
      expect(phrase, code).toContain(todo);
      expect(todo.length, code).toBeLessThan(phrase.length);
      expect(todo, code).toMatch(/^[A-Z][^<>&"]*\.$/);
      const at = phrase.indexOf(todo);
      expect(at === 0 || /\.\s$/.test(phrase.slice(0, at)), `${code} starts a sentence`).toBe(true);
      const end = at + todo.length;
      expect(end === phrase.length || phrase[end] === " ", `${code} ends a sentence`).toBe(true);
      expect(phrase, code).not.toMatch(DASH);
      expect(todo, code).not.toMatch(DASH);
    }
  });

  it("leads each code that one control is to blame for to that control, and no other code anywhere", () => {
    for (const [code, href] of Object.entries(SLICE_C_FIELD)) {
      const jump = REFUSAL_JUMP[code]!;
      expect(jump.href, code).toBe(href);
      expect(jump.label, code).toMatch(/^Go to the [a-z -]+$/);
      expect(jump.label, code).not.toMatch(DASH);
      expect(REFUSALS_FEEDBACK.jump[code as keyof typeof SLICE_C_FIELD], code).toEqual(jump);
    }
    for (const code of SLICE_C_NO_JUMP) expect(REFUSAL_JUMP[code], code).toBeUndefined();
  });

  it("leads to a control the rating form has, by the id the link names, of the kind it is about", () => {
    const page = parseHtml(memosPageWith(ratingProps({ hasMemo: true, given: null })));
    const kinds = {
      rating_required: "fieldset",
      bad_rating: "fieldset",
      comment_too_long: "textarea",
    } as const;
    for (const [code, href] of Object.entries(SLICE_C_FIELD))
      expect(byId(page, href.slice(1))?.name, code).toBe(kinds[code as keyof typeof kinds]);
  });

  it("says what to do about the things it asks of the person", () => {
    expect(REFUSAL_PHRASES["rating_required"]).toBe(
      "No rating was chosen. Choose a rating from 1 to 5.",
    );
    expect(REFUSAL_PHRASES["bad_rating"]).toBe(
      "That is not a rating the form offers. Choose a rating from 1 to 5.",
    );
    expect(REFUSAL_PHRASES["comment_too_long"]).toBe(
      "The comment is longer than 4,000 characters. Shorten it.",
    );
    expect(REFUSAL_PHRASES["not_exported"]).toBe(
      "A matter can be rated once a memo has been exported. Ask a reviewer to export the memo, then rate the matter.",
    );
    // A rating is final, so the phrase says so and points to the other way to say more.
    expect(REFUSAL_PHRASES["already_rated"]).toBe(
      "You have already rated this matter, and a rating cannot be changed. To say more, report a missed issue on a review.",
    );
  });

  it("has a notice for a saved rating that is a success and thanks the person", () => {
    expect(Object.keys(REFUSALS_FEEDBACK.notices).sort()).toEqual([
      "missed-issue-saved",
      "note-saved",
      "rating-saved",
    ]);
    expect(NOTICES["rating-saved"]).toEqual({
      kind: "success",
      text: "Your rating was saved. Thank you.",
    });
    expect(noticeFor("rating-saved")).toEqual(NOTICES["rating-saved"]);
  });
});

describe("the refusal of a rating the person is shown", () => {
  it("is the phrase with its todo and its jump, with the status of the store's error: 400 for the form, 409 for the state", () => {
    for (const code of SLICE_C) {
      const conflict = SLICE_C_CONFLICTS.includes(code);
      const refusal = refusalOf(
        conflict
          ? new ConflictError(code, "words the store wrote for itself")
          : new ValidationError(code, "words the store wrote for itself"),
      );
      const jump = REFUSAL_JUMP[code];
      expect(refusal, code).toEqual({
        status: conflict ? 409 : 400,
        code,
        notice: {
          kind: "error",
          text: REFUSAL_PHRASES[code],
          todo: REFUSAL_TODO[code],
          ...(jump === undefined ? {} : { jump }),
        },
      });
    }
  });

  it("never repeats what the store's message said, whatever it said", () => {
    const hostile = "ZQ-WORDS-OF-THE-REQUEST";
    for (const code of SLICE_C) {
      const refusal = refusalOf(
        SLICE_C_CONFLICTS.includes(code)
          ? new ConflictError(code, hostile)
          : new ValidationError(code, hostile),
      );
      expect(JSON.stringify(refusal), code).not.toContain(hostile);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Slice D: a note on a finding
// ---------------------------------------------------------------------------------------------

/** The codes of the note that its control is to blame for, and the control each leads to. */
const SLICE_D_FIELD = {
  finding_note_required: "#note-text",
  finding_note_too_long: "#note-text",
} as const;
/**
 * The code that no control mends: the finding is out of date, so the page shows the sentence and
 * not the form. `feedback_limit` is the report's code again (more than one form raises it, so it
 * has no link, as the slice B tests pin).
 */
const SLICE_D_NO_JUMP = ["finding_not_current"] as const;
const SLICE_D = [...Object.keys(SLICE_D_FIELD), ...SLICE_D_NO_JUMP] as (
  keyof typeof SLICE_D_FIELD | (typeof SLICE_D_NO_JUMP)[number]
)[];

describe("the fragment of the feedback package, the note on a finding", () => {
  it("defines each code once, with a phrase and a todo, in the merged tables and from this fragment alone", () => {
    expect(SLICE_D).toHaveLength(3);
    for (const code of SLICE_D) {
      expect(Object.keys(REFUSALS_FEEDBACK.phrases), code).toContain(code);
      expect(Object.keys(REFUSALS_FEEDBACK.todo), code).toContain(code);
      expect(REFUSAL_PHRASES[code], code).toBe(REFUSALS_FEEDBACK.phrases[code]);
      expect(REFUSAL_TODO[code], code).toBe(REFUSALS_FEEDBACK.todo[code]);
    }
  });

  it("gives each phrase as plain sentences with the todo inside it as a sentence of its own", () => {
    for (const code of SLICE_D) {
      const phrase = REFUSAL_PHRASES[code]!;
      const todo = REFUSAL_TODO[code]!;
      expect(phrase, code).toMatch(/^[A-Z][^<>&"]*\.$/);
      expect(phrase, code).toContain(todo);
      expect(todo.length, code).toBeLessThan(phrase.length);
      expect(todo, code).toMatch(/^[A-Z][^<>&"]*\.$/);
      const at = phrase.indexOf(todo);
      expect(at === 0 || /\.\s$/.test(phrase.slice(0, at)), `${code} starts a sentence`).toBe(true);
      const end = at + todo.length;
      expect(end === phrase.length || phrase[end] === " ", `${code} ends a sentence`).toBe(true);
      expect(phrase, code).not.toMatch(DASH);
      expect(todo, code).not.toMatch(DASH);
    }
  });

  it("leads each code that the note is to blame for to the note, and the code of an out of date finding nowhere", () => {
    for (const [code, href] of Object.entries(SLICE_D_FIELD)) {
      const jump = REFUSAL_JUMP[code]!;
      expect(jump.href, code).toBe(href);
      expect(jump.label, code).toBe("Go to the note");
      expect(REFUSALS_FEEDBACK.jump[code as keyof typeof SLICE_D_FIELD], code).toEqual(jump);
    }
    for (const code of SLICE_D_NO_JUMP) expect(REFUSAL_JUMP[code], code).toBeUndefined();
    // The report's own note codes still lead to the report's note, not to this one.
    expect(REFUSAL_JUMP["note_required"]?.href).toBe("#missed-issue-note");
    expect(REFUSAL_JUMP["note_too_long"]?.href).toBe("#missed-issue-note");
  });

  it("leads to the textarea of the note form, by the id the link names, on the finding pane", () => {
    const pane = parseHtml(notesPane([]));
    for (const [code, href] of Object.entries(SLICE_D_FIELD))
      expect(byId(pane, href.slice(1))?.name, code).toBe("textarea");
  });

  it("says what to do about the things it asks of the person", () => {
    expect(REFUSAL_PHRASES["finding_note_required"]).toBe(
      "The note is empty. Write what the reviewer should know about this finding.",
    );
    expect(REFUSAL_PHRASES["finding_note_too_long"]).toBe(
      "The note is longer than 4,000 characters. Shorten it.",
    );
    expect(REFUSAL_PHRASES["finding_not_current"]).toBe(
      "This finding is out of date, so notes can no longer be added to it. Open the current review to add a note.",
    );
    // The cap is the report's code: its phrase fits a note as it fits a report.
    expect(REFUSAL_PHRASES["feedback_limit"]).toContain("The most that can be added here");
  });

  it("has a notice for a saved note that is a success and says what was done", () => {
    expect(NOTICES["note-saved"]).toEqual({
      kind: "success",
      text: "Your note was added to the finding.",
    });
    expect(noticeFor("note-saved")).toEqual(NOTICES["note-saved"]);
  });
});

describe("the refusal of a note the person is shown", () => {
  it("is the phrase with its todo and its jump, with the status of the store's error: 400 for the note, 409 for the state", () => {
    for (const code of SLICE_D) {
      const conflict = code === "finding_not_current";
      const refusal = refusalOf(
        conflict
          ? new ConflictError(code, "words the store wrote for itself")
          : new ValidationError(code, "words the store wrote for itself"),
      );
      const jump = REFUSAL_JUMP[code];
      expect(refusal, code).toEqual({
        status: conflict ? 409 : 400,
        code,
        notice: {
          kind: "error",
          text: REFUSAL_PHRASES[code],
          todo: REFUSAL_TODO[code],
          ...(jump === undefined ? {} : { jump }),
        },
      });
    }
  });

  it("never repeats what the store's message said, whatever it said", () => {
    const hostile = "ZQ-WORDS-OF-THE-REQUEST";
    for (const code of [...SLICE_D, "feedback_limit"]) {
      const refusal = refusalOf(
        code === "finding_not_current" || code === "feedback_limit"
          ? new ConflictError(code, hostile)
          : new ValidationError(code, hostile),
      );
      expect(JSON.stringify(refusal), code).not.toContain(hostile);
    }
  });
});
