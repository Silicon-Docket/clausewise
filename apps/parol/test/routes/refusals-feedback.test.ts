import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REFUSAL_JUMP,
  REFUSAL_PHRASES,
  REFUSAL_TODO,
  refusalOf,
} from "../../src/server/routes/notices.js";
import { REFUSALS_FEEDBACK } from "../../src/server/routes/refusals-feedback.js";
import { ConflictError, ValidationError } from "../../src/store/index.js";
import { byId, parseHtml } from "../pages/html.js";
import { decisionPane } from "../pages/feedback-support.js";

/**
 * The words of the refusals of the reason code and the minor-edit mark (package W2.6a, slice A):
 * each code has a phrase, a sentence inside the phrase that says what to do, and a link to the
 * control of the decision form where it is mended. The later slices add the codes of a missed
 * issue, a note and the rating to the same fragment and the tests of their words below.
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
