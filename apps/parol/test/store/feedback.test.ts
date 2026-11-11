import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { REASON_CODES } from "../../src/contracts.js";
import {
  ConflictError,
  ContentMismatchError,
  NotFoundError,
  ValidationError,
} from "../../src/store/index.js";
import {
  ACTORS,
  PLAYBOOK_YAML,
  RULES,
  addMatter,
  messageOf,
  reviewable,
  startRun,
  type World,
  makeWorld,
} from "./fixtures.js";

/**
 * What the store keeps of feedback (package W2.6a). Slice A: the reason code and the minor-edit
 * mark of a decision. The store checks them before it writes anything, the database checks them
 * again (`feedback-migration.test.ts`), the audit event of the decision names the code and the mark
 * and never the reason, and a refused decision leaves nothing behind.
 *
 * Slice B: a missed issue is feedback about a run, naming a rule of the run's playbook or none, and
 * where it was missed. The store checks its shape before it writes anything, the database checks it
 * again (`feedback-migration.test.ts`), the audit event names the rule and says whether a location
 * was given and never holds the text of either, and a refused report leaves nothing behind.
 *
 * Slice C: a rating is a person's mark, from 1 to 5, of a whole matter, with words of their own if
 * they choose. The store checks its shape before it writes anything (no finding, no reason code, no
 * rule, no place), refuses a second rating by the same person on the same matter (the database
 * refuses it too, in `feedback-migration.test.ts`), and audits the mark and whether there were
 * words and never the words.
 *
 * Slice D: a note is a comment that names a finding. The store checks that the finding is the
 * matter's and that the run, if one is named, is the finding's own, holds a note to the words and
 * nothing else, and allows 20 of them to one person on one finding (the database does not count,
 * so the cap is held here). It is audited by ids and flags and never by the words.
 */

let w: World;
beforeEach(() => {
  w = makeWorld();
});

const setup = () => reviewable(w);

const decide = (
  matterId: string,
  f: { id: string; contentSha256: string },
  over: Record<string, unknown> = {},
) =>
  w.repo.recordReview(matterId, f.id, {
    reviewerId: ACTORS.reviewer,
    decision: "accept",
    findingContentSha256: f.contentSha256,
    ...over,
  } as never);

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as ValidationError).code;
  }
  return undefined;
};

describe("the reason code of a decision", () => {
  it("is stored with the decision, read back, and audited by code and never by text", () => {
    const { m, findings } = setup();
    const f = findings[1]!;
    const reason = "ZQ-REASON-MARKER the clause says something else.";
    const review = decide(m.id, f, {
      decision: "reject",
      reason,
      reasonCode: "wrong_evidence",
    });
    expect(review).toMatchObject({
      decision: "reject",
      reasonCode: "wrong_evidence",
      minorEdit: null,
    });
    expect(w.repo.listReviews(m.id, f.id)[0]).toMatchObject({ reasonCode: "wrong_evidence" });
    expect(w.repo.getFinding(m.id, f.id)?.currentReview).toMatchObject({
      reasonCode: "wrong_evidence",
      minorEdit: null,
    });

    const events = w.repo.listAuditEvents({ matterId: m.id, action: "review.decide" });
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({
      reviewId: review.id,
      decision: "reject",
      reasonCode: "wrong_evidence",
      minorEdit: null,
    });
    // The code is in the event; the words the reviewer typed are not.
    expect(JSON.stringify(events[0])).not.toContain("ZQ-REASON-MARKER");
  });

  it("is required for an edit and for a reject, whatever else the decision holds", () => {
    const { m, findings } = setup();
    const f = findings[1]!;
    const edit = { decision: "edit", reason: "r", edits: { discrepancy: "x" } };
    for (const over of [
      { decision: "reject", reason: "r" },
      { decision: "reject", reason: "r", reasonCode: null },
      { decision: "reject", reason: "r", reasonCode: undefined },
      edit,
      { ...edit, reasonCode: null },
    ])
      expect(
        codeOf(() => decide(m.id, f, over)),
        JSON.stringify(over),
      ).toBe("reason_code_required");
    // Nothing was written: no decision, no event, and the matter is where it was.
    expect(w.repo.listReviews(m.id, f.id)).toEqual([]);
    expect(w.repo.listAuditEvents({ matterId: m.id, action: "review.decide" })).toEqual([]);
    expect(w.repo.getMatter(m.id)?.status).toBe("in_review");
  });

  it("is refused for an accept and for an escalate, which carry none", () => {
    const { m, findings } = setup();
    const f = findings[1]!;
    for (const decision of ["accept", "escalate"])
      for (const reasonCode of REASON_CODES)
        expect(
          codeOf(() => decide(m.id, f, { decision, reason: "r", reasonCode })),
          `${decision} ${reasonCode}`,
        ).toBe("reason_code_not_allowed");
    expect(w.repo.listReviews(m.id, f.id)).toEqual([]);
    // Without one they are recorded, with no code.
    expect(decide(m.id, f, { decision: "escalate", reason: "r" })).toMatchObject({
      decision: "escalate",
      reasonCode: null,
      minorEdit: null,
    });
    expect(decide(m.id, f, { decision: "accept" })).toMatchObject({
      decision: "accept",
      reasonCode: null,
    });
  });

  it("accepts each of the six codes for a reject and for an edit, and no other word", () => {
    const { m, findings } = setup();
    const [a, b] = findings as [(typeof findings)[0], (typeof findings)[0]];
    for (const code of REASON_CODES) {
      expect(
        decide(m.id, a, { decision: "reject", reason: "r", reasonCode: code }).reasonCode,
      ).toBe(code);
      expect(
        decide(m.id, b, {
          decision: "edit",
          reason: "r",
          reasonCode: code,
          edits: { discrepancy: `Edited for ${code}.` },
        }).reasonCode,
      ).toBe(code);
    }
    const marker = "ZQ-BAD-CODE-MARKER";
    for (const bad of [
      "",
      "Other",
      " other",
      "other ",
      "wrong status",
      "none",
      "constructor",
      "__proto__",
      "toString",
      marker,
      5,
      true,
      {},
      ["other"],
    ]) {
      let error: unknown;
      try {
        decide(m.id, a, { decision: "reject", reason: "r", reasonCode: bad });
      } catch (e) {
        error = e;
      }
      expect(error, JSON.stringify(bad)).toBeInstanceOf(ValidationError);
      // A string "" is a value that is no code, the same as any other; none of them is echoed.
      expect((error as ValidationError).code, JSON.stringify(bad)).toBe("bad_reason_code");
      expect((error as ValidationError).message).not.toContain(marker);
    }
  });

  it("is refused in words that say the rule and never repeat the value that was sent", () => {
    const { m, findings } = setup();
    const f = findings[1]!;
    const sent = "ZQ-SENT-CODE";
    const messages = [
      messageOf(() => decide(m.id, f, { decision: "reject", reason: "r", reasonCode: sent })),
      messageOf(() => decide(m.id, f, { decision: "reject", reason: "r" })),
      messageOf(() => decide(m.id, f, { decision: "accept", reasonCode: "other" })),
      messageOf(() =>
        decide(m.id, f, { decision: "accept", minorEdit: true, reasonCode: undefined }),
      ),
    ];
    for (const message of messages) {
      expect(message).not.toContain(sent);
      expect(message).toMatch(/^[a-z][^A-Z]*$/);
    }
    expect(messages).toEqual([
      "the reason code is not one of the listed codes",
      "a decision to reject needs a reason code",
      "only an edit or a reject carries a reason code",
      "only an edit carries a minor-edit mark, and the mark is true or false",
    ]);
  });

  it("is checked after the reason and the edits, so each refusal names one thing", () => {
    const { m, findings } = setup();
    const f = findings[1]!;
    // A reject with neither a reason nor a code is told about the reason first.
    expect(codeOf(() => decide(m.id, f, { decision: "reject" }))).toBe("reason_required");
    // An edit that carries no edits is told so before it is told about the code.
    expect(codeOf(() => decide(m.id, f, { decision: "edit", reason: "r" }))).toBe("edits_required");
    expect(
      codeOf(() => decide(m.id, f, { decision: "accept", edits: { status: "missing" } })),
    ).toBe("edits_not_allowed");
  });

  it("belongs to the decision, so a decision on content that moved stores neither", () => {
    const { m, findings } = setup();
    const f = findings[1]!;
    expect(() =>
      decide(m.id, f, {
        decision: "reject",
        reason: "r",
        reasonCode: "other",
        findingContentSha256: sha256Hex("older content"),
      }),
    ).toThrow(ContentMismatchError);
    expect(w.db.prepare("SELECT count(*) AS n FROM reviews").get()).toEqual({ n: 0 });
  });

  it("is the decision's own: a changed mind records a new code and the old one stays on the stale decision", () => {
    const { m, findings } = setup();
    const f = findings[1]!;
    const first = decide(m.id, f, { decision: "reject", reason: "r", reasonCode: "unclear" });
    w.clock.tick();
    const second = decide(m.id, f, {
      decision: "edit",
      reason: "Better to correct it.",
      reasonCode: "bad_fallback",
      edits: { fallbackLanguage: "6.1 Two years." },
      minorEdit: true,
    });
    expect(second.supersedesReviewId).toBe(first.id);
    expect(
      w.repo
        .listReviews(m.id, f.id)
        .map((r) => [r.decision, r.reasonCode, r.minorEdit, r.validity]),
    ).toEqual([
      ["reject", "unclear", null, "stale"],
      ["edit", "bad_fallback", true, "current"],
    ]);
    // A reviewer who then accepts leaves one current decision, and it carries no code.
    w.clock.tick();
    const third = decide(m.id, f, { decision: "accept" });
    expect(third).toMatchObject({ reasonCode: null, minorEdit: null });
    expect(
      w.repo.listReviews(m.id, f.id).map((r) => [r.decision, r.reasonCode, r.validity]),
    ).toEqual([
      ["reject", "unclear", "stale"],
      ["edit", "bad_fallback", "stale"],
      ["accept", null, "current"],
    ]);
  });
});

describe("the minor-edit mark of an edit", () => {
  const edit = { decision: "edit", reason: "r", reasonCode: "other" };

  it("is stored as false when an edit says nothing, and as true when it is marked", () => {
    const { m, findings } = setup();
    const f = findings[1]!;
    const plain = decide(m.id, f, { ...edit, edits: { discrepancy: "One." } });
    expect(plain.minorEdit).toBe(false);
    const nulled = decide(m.id, f, { ...edit, edits: { discrepancy: "Two." }, minorEdit: null });
    expect(nulled.minorEdit).toBe(false);
    const marked = decide(m.id, f, {
      ...edit,
      edits: { discrepancy: "Three." },
      minorEdit: true,
    });
    expect(marked.minorEdit).toBe(true);
    const unmarked = decide(m.id, f, {
      ...edit,
      edits: { discrepancy: "Four." },
      minorEdit: false,
    });
    expect(unmarked.minorEdit).toBe(false);
    expect(w.db.prepare("SELECT minor_edit FROM reviews WHERE id = ?").get(marked.id)).toEqual({
      minor_edit: 1,
    });
    expect(
      w.repo
        .listAuditEvents({ matterId: m.id, action: "review.decide" })
        .map((e) => e.detail["minorEdit"]),
    ).toEqual([false, false, true, false]);
  });

  it("is refused with any decision but an edit, true or false", () => {
    const { m, findings } = setup();
    const f = findings[1]!;
    for (const decision of ["accept", "reject", "escalate"])
      for (const minorEdit of [true, false])
        expect(
          codeOf(() =>
            decide(m.id, f, {
              decision,
              reason: "r",
              reasonCode: decision === "reject" ? "other" : null,
              minorEdit,
            }),
          ),
          `${decision} ${minorEdit}`,
        ).toBe("minor_edit_not_allowed");
    expect(
      codeOf(() => decide(m.id, f, { ...edit, edits: { discrepancy: "x" }, minorEdit: "yes" })),
    ).toBe("minor_edit_not_allowed");
    expect(
      codeOf(() => decide(m.id, f, { ...edit, edits: { discrepancy: "x" }, minorEdit: 1 })),
    ).toBe("minor_edit_not_allowed");
    expect(w.repo.listReviews(m.id, f.id)).toEqual([]);
  });

  it("is refused for an edit that changes the status, however many other things it changes", () => {
    const { m, findings } = setup();
    const f = findings[1]!;
    const other = f.status === "compliant" ? "deviation" : "compliant";
    for (const edits of [{ status: other }, { status: other, discrepancy: "Also this." }])
      expect(
        codeOf(() => decide(m.id, f, { ...edit, edits, minorEdit: true })),
        JSON.stringify(edits),
      ).toBe("minor_edit_status");
    expect(w.repo.listReviews(m.id, f.id)).toEqual([]);
    expect(w.repo.listAuditEvents({ matterId: m.id, action: "review.decide" })).toEqual([]);
    // Unmarked, the same edit is an ordinary edit; marked, an edit of something else is minor.
    expect(decide(m.id, f, { ...edit, edits: { status: other }, minorEdit: false })).toMatchObject({
      minorEdit: false,
      edits: { status: other },
    });
    expect(
      decide(m.id, f, { ...edit, edits: { fallbackLanguage: "6.1 Two years." }, minorEdit: true }),
    ).toMatchObject({ minorEdit: true });
  });

  it("does not count a status the edit left as it was, which the store drops from the edit", () => {
    const { m, findings } = setup();
    const f = findings[1]!;
    // Naming the status the finding already has is no change of status: the edit that remains is
    // the wording, and it may be marked minor.
    const review = decide(m.id, f, {
      ...edit,
      edits: { status: f.status, discrepancy: "Reworded." },
      minorEdit: true,
    });
    expect(review).toMatchObject({ minorEdit: true, edits: { discrepancy: "Reworded." } });
  });

  it("is refused in words that say the rule", () => {
    const { m, findings } = setup();
    const f = findings[1]!;
    const other = f.status === "compliant" ? "deviation" : "compliant";
    expect(
      messageOf(() => decide(m.id, f, { ...edit, edits: { status: other }, minorEdit: true })),
    ).toBe("an edit that changes the status is not a minor edit");
  });
});

// ---------------------------------------------------------------------------------------------
// Slice B: a missed issue
// ---------------------------------------------------------------------------------------------

const report = (
  matterId: string,
  runId: string | null | undefined,
  over: Record<string, unknown> = {},
) =>
  w.repo.addFeedback(matterId, {
    userId: ACTORS.reviewer,
    kind: "missed_issue",
    runId,
    text: "The review should have flagged the amendment.",
    ...over,
  } as never);

describe("a missed issue", () => {
  it("is stored against its run with the rule, the place and the note, read back, and null for no rule", () => {
    const { m, run } = setup();
    w.clock.tick();
    const named = report(m.id, run.id, {
      ruleKey: "dur-1",
      location: "  NDA Section 6.1  ",
      text: "Section 6.1 is deleted by the amendment.\nSay so.",
    });
    expect(named).toMatchObject({
      kind: "missed_issue",
      matterId: m.id,
      runId: run.id,
      findingId: null,
      userId: ACTORS.reviewer,
      ruleKey: "dur-1",
      // The place is trimmed, as every label is; the note is kept exactly as typed.
      location: "NDA Section 6.1",
      text: "Section 6.1 is deleted by the amendment.\nSay so.",
      reasonCode: null,
      rating: null,
    });
    w.clock.tick();
    const uncovered = report(m.id, run.id, {
      userId: ACTORS.associate,
      text: "Nothing covers it.",
    });
    expect(uncovered).toMatchObject({ ruleKey: null, location: null, userId: ACTORS.associate });
    expect(w.repo.listFeedback(m.id).map((f) => [f.id, f.ruleKey, f.location])).toEqual([
      [named.id, "dur-1", "NDA Section 6.1"],
      [uncovered.id, null, null],
    ]);
  });

  it("is audited by the rule and by whether a place was given, and never by the words", () => {
    const { m, run } = setup();
    const note = "ZQ-NOTE-MARKER the amendment deletes the clause.";
    const place = "ZQ-PLACE-MARKER section 6.1";
    const row = report(m.id, run.id, { ruleKey: "gov-1", location: place, text: note });
    report(m.id, run.id, { ruleKey: null, text: "Nothing covers it." });
    const events = w.repo.listAuditEvents({ matterId: m.id, action: "feedback.add" });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      actorId: ACTORS.reviewer,
      targetType: "feedback",
      targetId: row.id,
      detail: {
        kind: "missed_issue",
        runId: run.id,
        ruleKey: "gov-1",
        hasText: true,
        hasLocation: true,
        findingId: null,
        reasonCode: null,
        rating: null,
      },
    });
    expect(events[1]?.detail).toMatchObject({ ruleKey: null, hasLocation: false, hasText: true });
    expect(JSON.stringify(events)).not.toContain("ZQ-NOTE-MARKER");
    expect(JSON.stringify(events)).not.toContain("ZQ-PLACE-MARKER");
    expect(w.repo.verifyAuditChain().ok).toBe(true);
  });

  it("needs a run of the matter, and a run of another matter is not found, as one that is not there", () => {
    const { m, run } = setup();
    const other = setup();
    expect(codeOf(() => report(m.id, undefined))).toBe("run_required");
    expect(codeOf(() => report(m.id, null))).toBe("run_required");
    expect(() => report(m.id, other.run.id)).toThrow(NotFoundError);
    expect(() => report(m.id, "run_does_not_exist")).toThrow(NotFoundError);
    // The same error for both, so nothing says which of the two it was.
    expect(messageOf(() => report(m.id, other.run.id))).toBe(
      messageOf(() => report(m.id, "run_does_not_exist")),
    );
    expect(() => report("mat_does_not_exist", run.id)).toThrow(NotFoundError);
    expect(() => report(m.id, run.id, { userId: "usr_nobody" })).toThrow(NotFoundError);
    expect(w.repo.listFeedback(m.id)).toEqual([]);
    expect(w.repo.listFeedback(other.m.id)).toEqual([]);
  });

  it("carries no finding and no reason code, and needs words", () => {
    const { m, run, findings } = setup();
    expect(codeOf(() => report(m.id, run.id, { findingId: findings[0]!.id }))).toBe(
      "finding_not_allowed",
    );
    expect(codeOf(() => report(m.id, run.id, { reasonCode: "other" }))).toBe("field_not_allowed");
    for (const text of [undefined, null, "", "   ", "\n\t "])
      expect(
        codeOf(() => report(m.id, run.id, { text })),
        JSON.stringify(text),
      ).toBe("text_required");
    expect(codeOf(() => report(m.id, run.id, { text: "t".repeat(4001) }))).toBe("bad_text");
    expect(report(m.id, run.id, { text: "t".repeat(4000) }).text).toHaveLength(4000);
    expect(codeOf(() => report(m.id, run.id, { text: "a\u0007b" }))).toBe("bad_text");
    expect(w.repo.listFeedback(m.id)).toHaveLength(1);
  });

  it("names a rule of the playbook the run was made with, and no other", () => {
    const { m, run } = setup();
    for (const key of ["pty-1", "dur-1", "gov-1"])
      expect(report(m.id, run.id, { ruleKey: key }).ruleKey, key).toBe(key);
    // A key of no rule, a key of the wrong case, and what cannot be a key at all are all unknown,
    // and are told in the same words.
    const words = new Set<string>();
    for (const bad of ["zzz-9", "DUR-1", "dur-1 ", "has space", "", "../dur-1", "x".repeat(65)]) {
      expect(
        codeOf(() => report(m.id, run.id, { ruleKey: bad })),
        JSON.stringify(bad),
      ).toBe("unknown_rule");
      words.add(messageOf(() => report(m.id, run.id, { ruleKey: bad })));
    }
    expect([...words]).toEqual(["the rule is not in this review's playbook"]);
    expect(w.repo.listFeedback(m.id)).toHaveLength(3);
  });

  it("does not take the rule of another playbook for a rule of this run's", () => {
    const other = w.repo.approvePlaybookVersion(
      w.repo.importPlaybookDraft(
        {
          slug: "other-playbook",
          version: "1.0.0",
          yaml: `${PLAYBOOK_YAML}# other\n`,
          sha256: sha256Hex(`${PLAYBOOK_YAML}# other\n`),
          rules: RULES.map((rule) => ({ ...rule, key: `o${rule.key}` })),
        },
        { actorId: ACTORS.legalEngineer },
      ).id,
      { actorId: ACTORS.admin },
    );
    const mine = setup();
    const theirs = addMatter(w, { pinPlaybook: false });
    w.repo.setPlaybookVersion(theirs.id, other.id, { actorId: ACTORS.associate });
    const theirRun = startRun(w, theirs);
    // Each run takes the rules of its own playbook.
    expect(report(theirs.id, theirRun.id, { ruleKey: "odur-1" }).ruleKey).toBe("odur-1");
    expect(codeOf(() => report(theirs.id, theirRun.id, { ruleKey: "dur-1" }))).toBe("unknown_rule");
    expect(codeOf(() => report(mine.m.id, mine.run.id, { ruleKey: "odur-1" }))).toBe(
      "unknown_rule",
    );
  });

  it("keeps the place to a line of at most 200 characters, and refuses control characters", () => {
    const { m, run } = setup();
    expect(report(m.id, run.id, { location: "x".repeat(200) }).location).toHaveLength(200);
    for (const bad of ["x".repeat(201), "", "   ", "line\nbreak", "tab\there", "bell\u0007"])
      expect(
        codeOf(() => report(m.id, run.id, { location: bad })),
        JSON.stringify(bad),
      ).toBe("bad_text");
    expect(w.repo.listFeedback(m.id)).toHaveLength(1);
  });

  it("is refused in words that say the rule and never repeat what was sent", () => {
    const { m, run, findings } = setup();
    const sent = "ZQ-SENT-VALUE";
    const messages = [
      messageOf(() => report(m.id, run.id, { ruleKey: sent })),
      messageOf(() => report(m.id, run.id, { ruleKey: "zzz-9" })),
      messageOf(() => report(m.id, run.id, { location: `${sent}\n${sent}` })),
      messageOf(() => report(m.id, run.id, { location: sent.repeat(20) })),
      messageOf(() => report(m.id, run.id, { text: sent.repeat(400) })),
      messageOf(() => report(m.id, run.id, { findingId: findings[0]!.id })),
      messageOf(() => report(m.id, run.id, { reasonCode: "other" })),
      messageOf(() => report(m.id, null, { text: sent })),
      messageOf(() => report(m.id, "run_ZQ-SENT-VALUE")),
    ];
    for (const message of messages) {
      expect(message).not.toContain(sent);
      expect(message).not.toBe("");
    }
    expect(messages.slice(0, 2)).toEqual([
      "the rule is not in this review's playbook",
      "the rule is not in this review's playbook",
    ]);
  });

  it("keeps the rule and the place to a missed issue: no other kind carries them", () => {
    const { m, run } = setup();
    for (const kind of ["comment", "rating", "finding_reason"])
      for (const over of [{ ruleKey: "dur-1" }, { location: "Section 6.1" }])
        expect(
          codeOf(() =>
            w.repo.addFeedback(m.id, {
              userId: ACTORS.reviewer,
              kind,
              runId: run.id,
              rating: kind === "rating" ? 4 : null,
              findingId: kind === "finding_reason" ? setup().findings[0]!.id : null,
              text: kind === "rating" ? null : "t",
              ...over,
            } as never),
          ),
          `${kind} ${JSON.stringify(over)}`,
        ).toBe("field_not_allowed");
    expect(w.repo.listFeedback(m.id)).toEqual([]);
  });

  it("is limited to 50 for one person on one run, and the limit is for that person and that run", () => {
    const { m, run } = setup();
    for (let i = 0; i < 50; i += 1) report(m.id, run.id, { text: `Miss number ${i}.` });
    const refused = (() => {
      try {
        report(m.id, run.id);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refused).toBeInstanceOf(ConflictError);
    expect((refused as ConflictError).code).toBe("feedback_limit");
    expect((refused as ConflictError).message).not.toMatch(/[0-9]/);
    expect(w.repo.listFeedback(m.id, { userId: ACTORS.reviewer })).toHaveLength(50);
    expect(w.repo.listAuditEvents({ matterId: m.id, action: "feedback.add" })).toHaveLength(50);
    // Another person is not held to the first one's count, nor is a comment, nor another run.
    expect(report(m.id, run.id, { userId: ACTORS.associate })).toMatchObject({
      userId: ACTORS.associate,
    });
    expect(
      w.repo.addFeedback(m.id, { userId: ACTORS.reviewer, kind: "comment", text: "A remark." }),
    ).toMatchObject({ kind: "comment" });
    const second = setup();
    expect(report(second.m.id, second.run.id).runId).toBe(second.run.id);
  });

  it("is written with its audit event or not at all", () => {
    const { m, run } = setup();
    w.db.exec(`CREATE TRIGGER zz_refuse_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'feedback.add'
      BEGIN SELECT RAISE(ABORT, 'parol-test: audit event refused'); END`);
    const before = (w.db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number })
      .n;
    expect(() => report(m.id, run.id, { ruleKey: "dur-1", location: "Section 6.1" })).toThrow(
      /audit event refused/,
    );
    expect(w.repo.listFeedback(m.id)).toEqual([]);
    expect((w.db.prepare("SELECT COUNT(*) AS n FROM feedback").get() as { n: number }).n).toBe(0);
    expect((w.db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n).toBe(
      before,
    );
  });
});

describe("listFeedback", () => {
  it("filters by kind, run, finding and person, all of them together, and stays on the matter", () => {
    const a = setup();
    const b = setup();
    const x = report(a.m.id, a.run.id, { ruleKey: "dur-1" });
    w.clock.tick();
    const y = report(a.m.id, a.run.id, { userId: ACTORS.associate });
    w.clock.tick();
    const note = w.repo.addFeedback(a.m.id, {
      userId: ACTORS.reviewer,
      kind: "comment",
      runId: a.run.id,
      findingId: a.findings[0]!.id,
      text: "A note.",
    });
    w.clock.tick();
    const rating = w.repo.addFeedback(a.m.id, {
      userId: ACTORS.reviewer,
      kind: "rating",
      rating: 4,
    });
    const foreign = report(b.m.id, b.run.id);
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    expect(ids(w.repo.listFeedback(a.m.id))).toEqual([x.id, y.id, note.id, rating.id]);
    expect(ids(w.repo.listFeedback(a.m.id, {}))).toEqual([x.id, y.id, note.id, rating.id]);
    expect(ids(w.repo.listFeedback(a.m.id, { kind: "missed_issue" }))).toEqual([x.id, y.id]);
    expect(ids(w.repo.listFeedback(a.m.id, { kind: "rating" }))).toEqual([rating.id]);
    expect(ids(w.repo.listFeedback(a.m.id, { runId: a.run.id }))).toEqual([x.id, y.id, note.id]);
    expect(ids(w.repo.listFeedback(a.m.id, { findingId: a.findings[0]!.id }))).toEqual([note.id]);
    expect(ids(w.repo.listFeedback(a.m.id, { userId: ACTORS.associate }))).toEqual([y.id]);
    expect(
      ids(w.repo.listFeedback(a.m.id, { kind: "missed_issue", userId: ACTORS.reviewer })),
    ).toEqual([x.id]);
    expect(ids(w.repo.listFeedback(a.m.id, { kind: "comment", userId: ACTORS.associate }))).toEqual(
      [],
    );
    // The matter anchors every filter: the other matter's report is never in this matter's answer,
    // whatever run, finding or person the filter names.
    expect(ids(w.repo.listFeedback(a.m.id, { runId: b.run.id }))).toEqual([]);
    expect(ids(w.repo.listFeedback(a.m.id, { findingId: b.findings[0]!.id }))).toEqual([]);
    expect(ids(w.repo.listFeedback(b.m.id, { userId: ACTORS.reviewer }))).toEqual([foreign.id]);
    expect(ids(w.repo.listFeedback(b.m.id, { runId: a.run.id }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Slice C: the rating of a matter
// ---------------------------------------------------------------------------------------------

const rate = (matterId: string, over: Record<string, unknown> = {}) =>
  w.repo.addFeedback(matterId, {
    userId: ACTORS.reviewer,
    kind: "rating",
    rating: 4,
    ...over,
  } as never);

const ratings = (matterId: string) => w.repo.listFeedback(matterId, { kind: "rating" });
const auditOf = (matterId: string) => w.repo.listAuditEvents({ matterId, action: "feedback.add" });

describe("the rating of a matter", () => {
  it("is stored with the mark and the words, read back, and audited by the mark and never the words", () => {
    const { m, run } = setup();
    w.clock.tick();
    const words = "ZQ-WORDS-OF-THE-RATING it found what I would have.";
    const given = rate(m.id, { runId: run.id, text: words });
    expect(given).toMatchObject({
      matterId: m.id,
      userId: ACTORS.reviewer,
      kind: "rating",
      rating: 4,
      text: words,
      runId: run.id,
      findingId: null,
      reasonCode: null,
      ruleKey: null,
      location: null,
    });
    expect(ratings(m.id)).toEqual([given]);
    const events = auditOf(m.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: ACTORS.reviewer,
      targetType: "feedback",
      targetId: given.id,
      detail: {
        kind: "rating",
        rating: 4,
        hasText: true,
        hasLocation: false,
        ruleKey: null,
        findingId: null,
        runId: run.id,
      },
    });
    // The mark is in the event; the words are not.
    expect(JSON.stringify(events)).not.toContain("ZQ-WORDS-OF-THE-RATING");
  });

  it("needs no words and no run, and words that say nothing are none", () => {
    const { m } = setup();
    const bare = rate(m.id, { userId: ACTORS.reviewer });
    expect(bare).toMatchObject({ text: null, runId: null, rating: 4 });
    const blank = rate(m.id, { userId: ACTORS.associate, rating: 2, text: " \n\t " });
    expect(blank).toMatchObject({ text: null, rating: 2 });
    expect(auditOf(m.id).map((e) => (e.detail as { hasText: boolean }).hasText)).toEqual([
      false,
      false,
    ]);
  });

  it("takes each of the five marks and no other number", () => {
    const first = setup();
    const marks = [1, 2, 3, 4, 5];
    marks.forEach((rating, i) => {
      const { m } = i === 0 ? first : setup();
      expect(rate(m.id, { rating }).rating).toBe(rating);
    });
    const { m } = setup();
    for (const rating of [0, -1, 6, 7, 2.5, 4.0000001, Number.NaN, Infinity])
      expect(
        codeOf(() => rate(m.id, { rating })),
        String(rating),
      ).toBe("bad_rating");
    expect(codeOf(() => rate(m.id, { rating: null }))).toBe("rating_required");
    expect(codeOf(() => rate(m.id, { rating: undefined }))).toBe("rating_required");
    expect(ratings(m.id)).toEqual([]);
    expect(auditOf(m.id)).toEqual([]);
  });

  it("is about the matter: no finding, no reason code, no rule and no place, and no mark on any other kind", () => {
    const { m, run, findings } = setup();
    const refused: [Record<string, unknown>, string][] = [
      [{ findingId: findings[0]!.id }, "finding_not_allowed"],
      [{ reasonCode: "other" }, "field_not_allowed"],
      [{ ruleKey: "dur-1" }, "field_not_allowed"],
      [{ location: "Section 6.1" }, "field_not_allowed"],
    ];
    for (const [over, code] of refused)
      expect(
        codeOf(() => rate(m.id, { runId: run.id, ...over })),
        JSON.stringify(over),
      ).toBe(code);
    // A mark belongs to a rating: a report, a comment or a reason does not carry one.
    for (const kind of ["missed_issue", "comment", "finding_reason"])
      expect(
        codeOf(() =>
          w.repo.addFeedback(m.id, {
            userId: ACTORS.reviewer,
            kind,
            runId: run.id,
            findingId: kind === "finding_reason" ? findings[0]!.id : null,
            rating: 3,
            text: "t",
          } as never),
        ),
        kind,
      ).toBe("field_not_allowed");
    expect(w.repo.listFeedback(m.id)).toEqual([]);
    expect(w.repo.listAuditEvents({ matterId: m.id, action: "feedback.add" })).toEqual([]);
  });

  it("refuses words that are too long or hold control characters, and a run of another matter, and writes nothing", () => {
    const first = setup();
    const second = setup();
    expect(codeOf(() => rate(first.m.id, { text: "w".repeat(4001) }))).toBe("bad_text");
    expect(codeOf(() => rate(first.m.id, { text: "a\u0000b" }))).toBe("bad_text");
    expect(codeOf(() => rate(first.m.id, { text: "a\u0007b" }))).toBe("bad_text");
    // Exactly the longest the store keeps is kept.
    expect(rate(first.m.id, { text: "w".repeat(4000) }).text).toHaveLength(4000);
    expect(() => rate(second.m.id, { runId: first.run.id })).toThrow(NotFoundError);
    expect(ratings(second.m.id)).toEqual([]);
    expect(auditOf(second.m.id)).toEqual([]);
  });

  it("is given once by a person for a matter, whatever the second one says, and it stays as it was", () => {
    const { m, run } = setup();
    const first = rate(m.id, { rating: 2, text: "ZQ-FIRST-WORDS" });
    w.clock.tick();
    for (const over of [
      { rating: 2 },
      { rating: 5, text: "ZQ-SECOND-WORDS" },
      { rating: 5, runId: run.id },
    ]) {
      const refused = (() => {
        try {
          rate(m.id, over);
        } catch (error) {
          return error;
        }
        return undefined;
      })();
      expect(refused, JSON.stringify(over)).toBeInstanceOf(ConflictError);
      expect((refused as ConflictError).code).toBe("already_rated");
      // The message says the rule and repeats nothing that was sent.
      expect((refused as ConflictError).message).not.toMatch(/ZQ-|[0-9]/);
    }
    expect(ratings(m.id)).toEqual([first]);
    expect(auditOf(m.id)).toHaveLength(1);
  });

  it("is one for each person and matter: another person may rate, and the same person another matter", () => {
    const a = setup();
    const b = setup();
    rate(a.m.id, { userId: ACTORS.reviewer, rating: 5 });
    expect(rate(a.m.id, { userId: ACTORS.associate, rating: 1 })).toMatchObject({ rating: 1 });
    expect(rate(b.m.id, { userId: ACTORS.reviewer, rating: 3 })).toMatchObject({
      matterId: b.m.id,
      rating: 3,
    });
    expect(
      ratings(a.m.id)
        .map((r) => [r.userId, r.rating])
        .sort(),
    ).toEqual(
      [
        [ACTORS.reviewer, 5],
        [ACTORS.associate, 1],
      ].sort(),
    );
    // A report or a comment by a person who has rated is not held to the rating.
    expect(
      w.repo.addFeedback(a.m.id, { userId: ACTORS.reviewer, kind: "comment", text: "A remark." }),
    ).toMatchObject({ kind: "comment" });
  });

  it("is written with its audit event or not at all, and a refused second rating adds no event", () => {
    const { m } = setup();
    w.db.exec(`CREATE TRIGGER zz_refuse_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'feedback.add'
      BEGIN SELECT RAISE(ABORT, 'parol-test: audit event refused'); END`);
    expect(() => rate(m.id, { text: "Words." })).toThrow(/audit event refused/);
    expect(ratings(m.id)).toEqual([]);
    expect((w.db.prepare("SELECT COUNT(*) AS n FROM feedback").get() as { n: number }).n).toBe(0);
    // With the trigger gone the same rating is written, with its event, and only once.
    w.db.exec("DROP TRIGGER zz_refuse_audit");
    rate(m.id, { text: "Words." });
    expect(() => rate(m.id)).toThrow(ConflictError);
    expect(ratings(m.id)).toHaveLength(1);
    expect(auditOf(m.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Slice D: a note on a finding
// ---------------------------------------------------------------------------------------------

const note = (
  matterId: string,
  finding: { id: string; runId: string },
  over: Record<string, unknown> = {},
) =>
  w.repo.addFeedback(matterId, {
    userId: ACTORS.reviewer,
    kind: "comment",
    runId: finding.runId,
    findingId: finding.id,
    text: "I read Section 9.3 differently.",
    ...over,
  } as never);

describe("a note on a finding", () => {
  it("is a comment on the finding, in the finding's own run, read back, and found by the finding", () => {
    const { m, run, findings } = setup();
    const f = findings[0]!;
    w.clock.tick();
    const added = note(m.id, f, { text: "Line one.\nLine two." });
    expect(added).toMatchObject({
      kind: "comment",
      matterId: m.id,
      runId: run.id,
      findingId: f.id,
      userId: ACTORS.reviewer,
      text: "Line one.\nLine two.",
      reasonCode: null,
      rating: null,
      ruleKey: null,
      location: null,
    });
    expect(added.runId).toBe(f.runId);
    w.clock.tick();
    const other = note(m.id, findings[1]!, { userId: ACTORS.associate, text: "Another finding." });
    expect(w.repo.listFeedback(m.id, { kind: "comment", findingId: f.id })).toEqual([added]);
    expect(w.repo.listFeedback(m.id, { findingId: findings[1]!.id })).toEqual([other]);
    expect(w.repo.listFeedback(m.id, { kind: "comment" }).map((n) => n.id)).toEqual([
      added.id,
      other.id,
    ]);
  });

  it("is given the finding's run when it names none, and one that it names must be the finding's", () => {
    const { m, run, findings } = setup();
    const f = findings[0]!;
    // Left out: the store takes the finding's own review.
    expect(note(m.id, f, { runId: undefined })).toMatchObject({ runId: run.id, findingId: f.id });
    expect(note(m.id, f, { runId: null }).runId).toBe(run.id);
    // Named and right.
    expect(note(m.id, f, { runId: run.id }).runId).toBe(run.id);
    // Named, and the run of another matter: not found, as for a missed issue.
    const second = setup();
    expect(() => note(m.id, f, { runId: second.run.id })).toThrow(NotFoundError);
    // Named, in the matter, and not the finding's: refused. The documents change, which lets a
    // second review start, and the first review's finding is not that review's.
    w.repo.setStatedDate(m.id, m.nda.versionId, "2026-06-30", { actorId: ACTORS.associate });
    const again = startRun(w, m);
    expect(again.id).not.toBe(run.id);
    expect(codeOf(() => note(m.id, f, { runId: again.id }))).toBe("run_mismatch");
    expect(messageOf(() => note(m.id, f, { runId: again.id }))).toBe(
      "the finding does not belong to that review",
    );
    expect(w.repo.listFeedback(m.id, { kind: "comment" })).toHaveLength(3);
  });

  it("is audited by ids and flags, and never by the words", () => {
    const { m, run, findings } = setup();
    const f = findings[0]!;
    const words = "ZQ-NOTE-WORDS the clause says something else.";
    const added = note(m.id, f, { text: words });
    const events = w.repo.listAuditEvents({ matterId: m.id, action: "feedback.add" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: ACTORS.reviewer,
      targetType: "feedback",
      targetId: added.id,
      detail: {
        kind: "comment",
        findingId: f.id,
        runId: run.id,
        hasText: true,
        hasLocation: false,
        ruleKey: null,
        reasonCode: null,
        rating: null,
      },
    });
    expect(JSON.stringify(events)).not.toContain("ZQ-NOTE-WORDS");
    expect(w.repo.verifyAuditChain().ok).toBe(true);
  });

  it("needs a finding of the matter, and a finding of another matter is not found as one that is not there", () => {
    const { m, findings } = setup();
    const other = setup();
    const foreign = other.findings[0]!;
    // Written against the right run so only the finding is wrong.
    expect(() => note(m.id, { id: foreign.id, runId: findings[0]!.runId })).toThrow(NotFoundError);
    expect(() => note(m.id, { id: "fnd_nowhere", runId: findings[0]!.runId })).toThrow(
      NotFoundError,
    );
    expect(messageOf(() => note(m.id, { id: foreign.id, runId: findings[0]!.runId }))).toBe(
      messageOf(() => note(m.id, { id: "fnd_nowhere", runId: findings[0]!.runId })),
    );
    expect(() => note("mat_does_not_exist", findings[0]!)).toThrow(NotFoundError);
    expect(() => note(m.id, findings[0]!, { userId: "usr_nobody" })).toThrow(NotFoundError);
    expect(w.repo.listFeedback(m.id)).toEqual([]);
    expect(w.repo.listFeedback(other.m.id)).toEqual([]);
  });

  it("needs words, keeps them as typed up to 4000 characters, and refuses control characters", () => {
    const { m, findings } = setup();
    const f = findings[0]!;
    for (const text of [undefined, null, "", "   ", "\n\t "])
      expect(
        codeOf(() => note(m.id, f, { text })),
        JSON.stringify(text),
      ).toBe("text_required");
    expect(codeOf(() => note(m.id, f, { text: "t".repeat(4001) }))).toBe("bad_text");
    expect(codeOf(() => note(m.id, f, { text: "a\u0007b" }))).toBe("bad_text");
    expect(note(m.id, f, { text: "t".repeat(4000) }).text).toHaveLength(4000);
    expect(w.repo.listFeedback(m.id)).toHaveLength(1);
  });

  it("carries the words and nothing else: no reason code, no rule, no place, no mark", () => {
    const { m, findings } = setup();
    const f = findings[0]!;
    const refused: [Record<string, unknown>, string][] = [
      [{ reasonCode: "other" }, "field_not_allowed"],
      [{ ruleKey: "dur-1" }, "field_not_allowed"],
      [{ location: "Section 6.1" }, "field_not_allowed"],
      [{ rating: 4 }, "field_not_allowed"],
    ];
    for (const [over, code] of refused)
      expect(
        codeOf(() => note(m.id, f, over)),
        JSON.stringify(over),
      ).toBe(code);
    expect(w.repo.listFeedback(m.id)).toEqual([]);
    expect(w.repo.listAuditEvents({ matterId: m.id, action: "feedback.add" })).toEqual([]);
  });

  it("is refused in words that say the rule and never repeat what was sent", () => {
    const { m, findings } = setup();
    const f = findings[0]!;
    const second = setup();
    const sent = "ZQ-SENT-VALUE";
    const messages = [
      messageOf(() => note(m.id, f, { text: sent.repeat(400) })),
      messageOf(() => note(m.id, f, { text: `${sent}\u0007` })),
      messageOf(() => note(m.id, f, { reasonCode: sent })),
      messageOf(() => note(m.id, f, { runId: second.run.id })),
      messageOf(() => note(m.id, { id: `fnd_${sent}`, runId: f.runId })),
    ];
    for (const message of messages) {
      expect(message).not.toContain(sent);
      expect(message).not.toBe("");
    }
    for (let i = 0; i < 20; i += 1) note(m.id, f, { text: `Note ${i}.` });
    expect(messageOf(() => note(m.id, f))).not.toMatch(/[0-9]|ZQ-/);
  });

  it("is limited to 20 for one person on one finding, and the limit is for that person and that finding", () => {
    const { m, findings } = setup();
    const f = findings[0]!;
    for (let i = 0; i < 20; i += 1) note(m.id, f, { text: `Note number ${i}.` });
    const refused = (() => {
      try {
        note(m.id, f);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refused).toBeInstanceOf(ConflictError);
    expect((refused as ConflictError).code).toBe("feedback_limit");
    expect((refused as ConflictError).message).not.toMatch(/[0-9]/);
    expect(w.repo.listFeedback(m.id, { findingId: f.id, userId: ACTORS.reviewer })).toHaveLength(
      20,
    );
    expect(w.repo.listAuditEvents({ matterId: m.id, action: "feedback.add" })).toHaveLength(20);
    // Another person, another finding, a comment that names no finding and a report are not held to
    // the first person's count on the first finding.
    expect(note(m.id, f, { userId: ACTORS.associate })).toMatchObject({
      userId: ACTORS.associate,
    });
    expect(note(m.id, findings[1]!)).toMatchObject({ findingId: findings[1]!.id });
    expect(
      w.repo.addFeedback(m.id, { userId: ACTORS.reviewer, kind: "comment", text: "A remark." }),
    ).toMatchObject({ kind: "comment", findingId: null });
    expect(report(m.id, f.runId)).toMatchObject({ kind: "missed_issue" });
    // Nor is the count of one matter another's: the same person has their 20 on a finding of each.
    const second = setup();
    for (let i = 0; i < 20; i += 1) note(second.m.id, second.findings[0]!, { text: `Note ${i}.` });
    expect(() => note(second.m.id, second.findings[0]!)).toThrow(ConflictError);
  });

  it("does not count the comments that name no finding against the 20, nor the notes of other people", () => {
    const { m, findings } = setup();
    const f = findings[0]!;
    for (let i = 0; i < 25; i += 1)
      w.repo.addFeedback(m.id, {
        userId: ACTORS.reviewer,
        kind: "comment",
        text: `A remark about the matter ${i}.`,
      });
    for (let i = 0; i < 20; i += 1) note(m.id, f, { userId: ACTORS.associate, text: `Mine ${i}.` });
    // Twenty notes by the associate and twenty-five loose comments by the reviewer: the reviewer
    // has written no note on the finding, so the first is theirs to write.
    expect(note(m.id, f, { text: "The reviewer's first." }).userId).toBe(ACTORS.reviewer);
  });

  it("is written with its audit event or not at all, and a note refused for the cap adds no event", () => {
    const { m, findings } = setup();
    const f = findings[0]!;
    w.db.exec(`CREATE TRIGGER zz_refuse_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'feedback.add'
      BEGIN SELECT RAISE(ABORT, 'parol-test: audit event refused'); END`);
    expect(() => note(m.id, f)).toThrow(/audit event refused/);
    expect(w.repo.listFeedback(m.id)).toEqual([]);
    w.db.exec("DROP TRIGGER zz_refuse_audit");
    for (let i = 0; i < 20; i += 1) note(m.id, f, { text: `Note ${i}.` });
    const events = w.repo.listAuditEvents({ matterId: m.id, action: "feedback.add" }).length;
    expect(() => note(m.id, f)).toThrow(ConflictError);
    expect(w.repo.listAuditEvents({ matterId: m.id, action: "feedback.add" })).toHaveLength(events);
    expect(w.repo.listFeedback(m.id, { findingId: f.id })).toHaveLength(20);
  });

  it("is written once, and never changed or replaced by code that goes round the store", () => {
    const { m, findings } = setup();
    const added = note(m.id, findings[0]!);
    expect(() =>
      w.db.prepare("UPDATE feedback SET text = 'changed' WHERE id = ?").run(added.id),
    ).toThrow(/never edited/);
    expect(w.repo.listFeedback(m.id)[0]?.text).toBe("I read Section 9.3 differently.");
  });
});
