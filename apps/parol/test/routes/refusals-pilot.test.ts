import { describe, expect, it } from "vitest";
import {
  NOTICES,
  REFUSAL_FRAGMENTS,
  REFUSAL_JUMP,
  REFUSAL_PHRASES,
  REFUSAL_TODO,
  noticeFor,
  refusalOf,
} from "../../src/server/routes/notices.js";
import { REFUSALS_FEEDBACK } from "../../src/server/routes/refusals-feedback.js";
import { REFUSALS_PILOT } from "../../src/server/routes/refusals-pilot.js";
import { PILOT_ANCHORS } from "../../src/server/pages/pilotfields.js";
import {
  ConflictError,
  MAX_OUTSIDE_ISSUES,
  MAX_PARTICIPANTS,
  PILOT_REFUSAL_CODES,
  ValidationError,
} from "../../src/store/index.js";

/**
 * The words of the refusals and notices of the pilot measures, the timer and the reference list
 * (package W2.6b): each code the store raises has a phrase, the sentence of the phrase that says
 * what to do, and, where one control is to blame, a link to it. The links are checked against the
 * ids the pages give (`PILOT_ANCHORS`); the pages' own tests check that the ids are there.
 */

const DASH = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");

/** The codes this fragment defines: every code the store raises except the one the feedback fragment owns. */
const OWN = PILOT_REFUSAL_CODES.filter((code) => code !== "unknown_rule");

describe("the fragment of the pilot package", () => {
  it("defines every code the store raises, once, except unknown_rule, which the feedback fragment owns", () => {
    expect(Object.keys(REFUSALS_PILOT.phrases).sort()).toEqual([...OWN].sort());
    expect(Object.keys(REFUSALS_PILOT.todo).sort()).toEqual([...OWN].sort());
    expect(Object.keys(REFUSALS_PILOT.phrases)).not.toContain("unknown_rule");
    expect(Object.keys(REFUSALS_FEEDBACK.phrases)).toContain("unknown_rule");
    // The merged tables hold every code, from this fragment or the feedback one.
    for (const code of PILOT_REFUSAL_CODES) expect(REFUSAL_PHRASES[code], code).toBeDefined();
    for (const code of OWN) {
      expect(REFUSAL_PHRASES[code], code).toBe(REFUSALS_PILOT.phrases[code]);
      expect(REFUSAL_TODO[code], code).toBe(REFUSALS_PILOT.todo[code]);
    }
  });

  it("is one of the fragments the tables are merged from, and no other defines a code of it", () => {
    const names = REFUSAL_FRAGMENTS.map((fragment) => fragment.name);
    expect(names).toContain("pilot");
    const owners = REFUSAL_FRAGMENTS.filter((fragment) =>
      OWN.some((code) => Object.hasOwn(fragment.fragment.phrases, code)),
    ).map((fragment) => fragment.name);
    expect(owners).toEqual(["pilot"]);
  });

  it("gives each phrase as plain sentences, with the todo inside it as a sentence of its own", () => {
    for (const code of OWN) {
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

  it("says what to do in words a person can follow", () => {
    expect(REFUSAL_PHRASES["timer_open"]).toBe(
      "You already have a timer running. Stop it before starting another one.",
    );
    // Not "Press Start timer": a person whose timer runs on another matter has no such button.
    expect(REFUSAL_PHRASES["no_open_timer"]).toBe(
      "No timer is running on this matter, so there is nothing to stop. The timer section of this page shows what you can do now.",
    );
    expect(REFUSAL_PHRASES["timer_training"]).toBe(
      "A training matter is not timed, because the pilot measures leave it out. Time an ordinary matter instead.",
    );
    expect(REFUSAL_PHRASES["reference_training"]).toBe(
      "A training matter has no reference list, because the pilot measures leave it out. Record the list on an ordinary matter instead.",
    );
    expect(REFUSAL_TODO["bad_count"]).toBe("Enter a whole number from 0 to 9.");
    expect(REFUSAL_TODO["bad_calendar_date"]).toBe(
      "Enter the first day of the pilot as year-month-day, for example 2026-11-09.",
    );
    expect(REFUSAL_TODO["reference_locked"]).toBe(
      "Report anything the review missed on the review page.",
    );
  });

  it("states the limits that the store holds, so the words and the store cannot drift apart", () => {
    expect(REFUSAL_PHRASES["too_many_participants"]).toContain(
      `more than ${MAX_PARTICIPANTS} people`,
    );
    expect(REFUSAL_PHRASES["bad_count"]).toContain(`0 to ${MAX_OUTSIDE_ISSUES}`);
  });

  it("jumps only where one control is to blame, and to the id the pages give that control", () => {
    const expected: Record<string, string> = {
      bad_calendar_date: PILOT_ANCHORS.startDate,
      unknown_user: PILOT_ANCHORS.participants,
      duplicate_user: PILOT_ANCHORS.participants,
      too_many_participants: PILOT_ANCHORS.participants,
      no_open_timer: PILOT_ANCHORS.timer,
      duplicate_rule: PILOT_ANCHORS.referenceList,
      bad_severity: PILOT_ANCHORS.referenceList,
      bad_count: PILOT_ANCHORS.referenceOutside,
    };
    expect(Object.keys(REFUSALS_PILOT.jump).sort()).toEqual(Object.keys(expected).sort());
    for (const [code, id] of Object.entries(expected)) {
      const jump = REFUSAL_JUMP[code]!;
      expect(jump.href, code).toBe(`#${id}`);
      expect(jump.label, code).toMatch(/^Go to the [a-z -]+$/);
      expect(jump.label, code).not.toMatch(DASH);
    }
    // A refusal that is about the matter or the person, not a control, leads nowhere.
    for (const code of [
      "timer_open",
      "timer_role",
      "timer_training",
      "reference_locked",
      "reference_role",
      "reference_training",
    ])
      expect(REFUSAL_JUMP[code], code).toBeUndefined();
  });
});

describe("the refusal the person is shown", () => {
  it("is the phrase with its todo and its jump, in the status of the store's error", () => {
    const cases: [string, ValidationError | ConflictError, 400 | 409][] = [
      ["bad_calendar_date", new ValidationError("bad_calendar_date", "words"), 400],
      ["unknown_user", new ValidationError("unknown_user", "words"), 400],
      ["too_many_participants", new ValidationError("too_many_participants", "words"), 400],
      ["bad_severity", new ValidationError("bad_severity", "words"), 400],
      ["bad_count", new ValidationError("bad_count", "words"), 400],
      ["timer_open", new ConflictError("timer_open", "words"), 409],
      ["no_open_timer", new ConflictError("no_open_timer", "words"), 409],
      ["timer_training", new ConflictError("timer_training", "words"), 409],
      ["reference_training", new ConflictError("reference_training", "words"), 409],
      ["reference_locked", new ConflictError("reference_locked", "words"), 409],
    ];
    for (const [code, error, status] of cases) {
      const refusal = refusalOf(error);
      const jump = REFUSAL_JUMP[code];
      expect(refusal, code).toEqual({
        status,
        code,
        notice: {
          kind: "error",
          text: REFUSAL_PHRASES[code],
          todo: REFUSAL_TODO[code],
          ...(jump === undefined ? {} : { jump: { href: jump.href, label: jump.label } }),
        },
      });
    }
  });

  it("is the feedback fragment's words for a rule that is not the playbook's", () => {
    const refusal = refusalOf(new ValidationError("unknown_rule", "words"));
    expect(refusal?.notice.text).toBe(
      "That rule is not in the playbook of this matter. Choose one from the list.",
    );
    expect(refusal?.notice.jump).toBeUndefined();
  });
});

describe("the notices", () => {
  it("has the five codes, each a success notice in plain words that claims nothing beyond what was done", () => {
    const codes = [
      "calendar-saved",
      "participants-saved",
      "timer-started",
      "timer-stopped",
      "reference-saved",
    ];
    expect(Object.keys(REFUSALS_PILOT.notices).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      const notice = noticeFor(code);
      expect(notice?.kind, code).toBe("success");
      expect(notice?.text, code).toMatch(/^[A-Z][^<>&"]*\.$/);
      expect(notice?.text, code).not.toMatch(DASH);
      expect(NOTICES[code], code).toBeDefined();
    }
    expect(noticeFor("timer-started")?.text).toBe(
      "The timer is running. Press Stop timer when you pause or finish.",
    );
  });

  it("takes a code that is not one of ours as no notice", () => {
    for (const code of ["timer", "reference-saved ", "REFERENCE-SAVED", undefined, 4])
      expect(noticeFor(code)).toBeNull();
  });
});
