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
import { decisionPane, feedbackProps, runPageWith } from "../pages/feedback-support.js";

/**
 * The words of the refusals of the reason code and the minor-edit mark (package W2.6a, slice A):
 * each code has a phrase, a sentence inside the phrase that says what to do, and a link to the
 * control of the decision form where it is mended.
 *
 * Slice B adds the codes of the report of a missed issue: each has a phrase, a sentence inside it
 * that says what to do, and (where one field of the form is to blame) a link to that field. The
 * later slices add the codes of a note and the rating to the same fragment and the tests of their
 * words below.
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
    expect(Object.keys(REFUSALS_FEEDBACK.notices)).toEqual(["missed-issue-saved"]);
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

describe("the codes the report can raise", () => {
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
        "location_too_long",
        "note_required",
        "note_too_long",
        "rule_required",
        "unknown_rule",
      ].sort(),
    );
    expect([...service]).toEqual(["run_has_no_findings"]);
    const store = codesIn(addFeedbackText());
    // What the store raises that a person can mend has a phrase.
    for (const code of ["unknown_rule", "feedback_limit"]) {
      expect(store, code).toContain(code);
      expect(Object.keys(REFUSAL_PHRASES), code).toContain(code);
    }
    for (const code of [...parsers, ...service])
      expect(Object.keys(REFUSAL_PHRASES), code).toContain(code);
  });

  it("leave only the guards of the store that no route can reach without a phrase, and the list of them is exact", () => {
    // The service gives the store the person, the matter and the review and nothing else, and the
    // parsers give it a note that says something, so these are for code that calls the store another way.
    const guards = [
      "bad_kind",
      "bad_rating",
      "field_not_allowed",
      "finding_not_allowed",
      "finding_required",
      "rating_required",
      "run_required",
      "text_required",
    ];
    const store = codesIn(addFeedbackText());
    const withoutPhrase = [...store].filter((code) => !Object.keys(REFUSAL_PHRASES).includes(code));
    expect(withoutPhrase.sort()).toEqual(guards.sort());
  });
});
