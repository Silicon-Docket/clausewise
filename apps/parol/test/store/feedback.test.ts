import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { REASON_CODES } from "../../src/contracts.js";
import { ContentMismatchError, ValidationError } from "../../src/store/index.js";
import { ACTORS, messageOf, reviewable, type World, makeWorld } from "./fixtures.js";

/**
 * What the store keeps of feedback (package W2.6a). Slice A: the reason code and the minor-edit
 * mark of a decision. The store checks them before it writes anything, the database checks them
 * again (`feedback-migration.test.ts`), the audit event of the decision names the code and the mark
 * and never the reason, and a refused decision leaves nothing behind. The later slices add the
 * tests of a missed issue, a note and the rating below.
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
