import { afterAll, describe, expect, it } from "vitest";
import { cleanup, decideAll, makeWorld, reviewed, type World } from "./support.js";

afterAll(cleanup);

/**
 * The words of a report (package W2.6a, slice B) are text a person typed, and a person can paste a
 * clause into them. They are stored with the matter and deleted with it, and they go nowhere else:
 * not into the audit trail, a log line, an error message, a file name, or any column of the database
 * but the two that hold them (`feedback.text` and `feedback.location`). The check is the one of
 * `privacy.test.ts`: plant a marker in every field a person can fill, make the refusals that involve
 * the marker too, and look for it everywhere. Slice C adds the comment of a rating, which is as
 * private as a report and more so: no member reads another member's rating at all. Slice D adds the
 * note on a finding, which is typed text of the same kind and, unlike a rating, is read by every
 * member of the matter next to the finding.
 */

const NOTE = "QZXNOTE-4d19a7";
const PLACE = "QZXPLACE-82c0e3";
const RULE = "QZXRULE-17b6f5";
const RUN = "QZXRUN-6e3d92";
const WORDS = "QZXWORDS-5a08c1";
const OTHER_WORDS = "QZXOTHER-93f7b2";
const REMARK = "QZXREMARK-2c64d8";
const FINDING = "QZXFINDING-0b9e41";

/** Every column of every table that holds `needle`, as `table.column`. */
function where(w: World, needle: string): string[] {
  const found: string[] = [];
  const tables = w.repo.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    const columns = w.repo.db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
    for (const column of columns) {
      const row = w.repo.db
        .prepare(
          `SELECT count(*) AS n FROM "${name}" WHERE instr(CAST("${column.name}" AS TEXT), ?) > 0`,
        )
        .get(needle) as { n: number };
      if (row.n > 0) found.push(`${name}.${column.name}`);
    }
  }
  return found;
}

const caught = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected an error");
};

describe("the words of a report of a missed issue", () => {
  it("are in feedback.text and feedback.location and in no other column, log line, event, error or file name", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm, runId } = await reviewed(w);

    const stored = w.services.feedback.reportMissedIssue(reviewerAm, runId, {
      ruleKey: "dur-1",
      location: `Section 6.1 ${PLACE}`,
      note: `The amendment deletes it. ${NOTE}`,
    });
    w.services.feedback.reportMissedIssue(am, runId, {
      ruleKey: null,
      location: null,
      note: `Nothing covers this either. ${NOTE}`,
    });

    // Refusals that involve text of the caller's: none of it comes back in what the error says.
    const errors = [
      caught(() =>
        w.services.feedback.reportMissedIssue(am, runId, {
          ruleKey: RULE,
          location: PLACE,
          note: NOTE,
        }),
      ),
      caught(() =>
        w.services.feedback.reportMissedIssue(am, runId, {
          ruleKey: null,
          location: `${PLACE}\n${PLACE}`,
          note: NOTE,
        }),
      ),
      caught(() =>
        w.services.feedback.reportMissedIssue(am, runId, {
          ruleKey: null,
          location: PLACE.repeat(40),
          note: NOTE,
        }),
      ),
      caught(() =>
        w.services.feedback.reportMissedIssue(am, runId, {
          ruleKey: null,
          location: null,
          note: NOTE.repeat(400),
        }),
      ),
      caught(() =>
        w.services.feedback.reportMissedIssue(am, `${RUN}`, {
          ruleKey: null,
          location: PLACE,
          note: NOTE,
        }),
      ),
      caught(() => w.services.feedback.ruleChoices(am, `${RUN}`)),
    ];
    expect(errors.map((e) => e.name)).toEqual([
      "ValidationError",
      "ValidationError",
      "ValidationError",
      "ValidationError",
      "NotFoundError",
      "NotFoundError",
    ]);

    // --- the scan ---
    const audit = JSON.stringify(w.repo.listAuditEvents({ limit: 10000 }));
    const logs = w.logs.join("\n");
    const errorText = errors.map((e) => `${e.name}: ${e.message}\n${JSON.stringify(e)}`).join("\n");
    const needles = [NOTE, PLACE, RULE, RUN];
    for (const [name, haystack] of Object.entries({ audit, logs, errors: errorText }))
      for (const needle of needles)
        expect(haystack.includes(needle), `${name} holds ${needle}`).toBe(false);

    // The words did get into the places that are meant to hold them, so the scan above means something.
    expect(where(w, NOTE)).toEqual(["feedback.text"]);
    expect(where(w, PLACE)).toEqual(["feedback.location"]);
    // What the author reads back is theirs to read.
    expect(JSON.stringify(stored)).toContain(PLACE);
    // The refusals kept nothing: two reports are all there is, and the rule key that is no rule
    // was never stored.
    expect(w.repo.listFeedback(matterId, { kind: "missed_issue" })).toHaveLength(2);
    expect(where(w, RULE)).toEqual([]);
    expect(where(w, RUN)).toEqual([]);

    // Every line the services logged is a sentence of ours around ids and closed codes.
    for (const line of w.logs) expect(line).not.toContain("QZX");
  });
});

describe("the comment of a rating", () => {
  it("is in feedback.text and in no other column, log line, event, error or file name, and is read by the person who wrote it", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm, runId } = await reviewed(w);
    decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
    await w.services.reviews.exportMemo(reviewerAm);

    const given = w.services.feedback.rate(am, { rating: 4, comment: `Useful. ${WORDS}` });
    // Refusals that involve the words: a second rating and a mark that is no mark.
    const errors = [
      caught(() => w.services.feedback.rate(am, { rating: 5, comment: `Again. ${WORDS}` })),
      caught(() => w.services.feedback.rate(reviewerAm, { rating: 9, comment: WORDS })),
      caught(() => w.services.feedback.rate(reviewerAm, { rating: 3, comment: WORDS.repeat(400) })),
    ];
    expect(errors.map((e) => e.name)).toEqual([
      "ConflictError",
      "ValidationError",
      "ValidationError",
    ]);

    const audit = JSON.stringify(w.repo.listAuditEvents({ limit: 10000 }));
    const logs = w.logs.join("\n");
    const errorText = errors.map((e) => `${e.name}: ${e.message}\n${JSON.stringify(e)}`).join("\n");
    for (const [name, haystack] of Object.entries({ audit, logs, errors: errorText }))
      expect(haystack.includes(WORDS), `${name} holds the words`).toBe(false);

    // The words are in the one column meant to hold them, and in no other.
    expect(where(w, WORDS)).toEqual(["feedback.text"]);
    expect(JSON.stringify(given)).toContain(WORDS);
    expect(JSON.stringify(w.services.feedback.myRating(am))).toContain(WORDS);
    // The refusals kept nothing: one rating is all there is.
    expect(w.repo.listFeedback(matterId, { kind: "rating" })).toHaveLength(1);
    for (const line of w.logs) expect(line).not.toContain("QZX");
  });

  it("is read by nobody but the person who gave it: not by another member, in no view the services make", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm, runId } = await reviewed(w);
    decideAll(w, reviewerAm, w.services.runs.issues(am, runId));
    await w.services.reviews.exportMemo(reviewerAm);
    w.services.feedback.rate(am, { rating: 1, comment: WORDS });
    w.services.feedback.rate(reviewerAm, { rating: 5, comment: OTHER_WORDS });

    // Everything the services let each of the two read of the matter, as text.
    const readBy = (caller: typeof am): string =>
      JSON.stringify({
        mine: w.services.feedback.myRating(caller),
        list: w.services.feedback.list(caller),
        matter: w.services.matters.view(caller),
        memos: w.services.reviews.listMemos(caller),
        issues: w.services.runs.issues(caller, runId),
        run: w.services.runs.get(caller, runId),
      });
    expect(readBy(am)).toContain(WORDS);
    expect(readBy(am)).not.toContain(OTHER_WORDS);
    expect(readBy(reviewerAm)).toContain(OTHER_WORDS);
    expect(readBy(reviewerAm)).not.toContain(WORDS);
    // The marks themselves: each reads their own and the list agrees with it.
    expect(w.services.feedback.list(am).myRating?.rating).toBe(1);
    expect(w.services.feedback.list(reviewerAm).myRating?.rating).toBe(5);
    // And nothing outside the feedback table has them, so no other read can reach them.
    expect(where(w, WORDS)).toEqual(["feedback.text"]);
    expect(where(w, OTHER_WORDS)).toEqual(["feedback.text"]);
    expect(matterId).toBeTruthy();
  });
});

describe("the words of a note on a finding", () => {
  it("are in feedback.text and in no other column, log line, event, error or file name", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm, runId } = await reviewed(w);
    const issues = w.services.runs.issues(am, runId);
    const first = issues[0]!;
    const second = issues[1]!;

    const stored = w.services.feedback.addNote(reviewerAm, first.findingId, {
      note: `I read Section 9.3 differently. ${REMARK}`,
    });
    w.services.feedback.addNote(am, first.findingId, { note: `A reply. ${REMARK}` });
    const other = await reviewed(w);
    const foreign = w.services.runs.issues(other.am, other.runId)[0]!;

    // Refusals that involve text of the caller's: none of it comes back in what the error says.
    const errors = [
      caught(() => w.services.feedback.addNote(am, `fnd_${FINDING}`, { note: REMARK })),
      caught(() => w.services.feedback.addNote(am, foreign.findingId, { note: REMARK })),
      caught(() => w.services.feedback.addNote(am, second.findingId, { note: REMARK.repeat(400) })),
      caught(() => w.services.feedback.addNote(am, second.findingId, { note: `${REMARK}\u0007` })),
    ];
    // A finding that went out of date, and a person who has written the most they may.
    for (let i = 0; i < 20; i += 1)
      w.services.feedback.addNote(am, second.findingId, { note: `Note ${i}. ${REMARK}` });
    errors.push(
      caught(() => w.services.feedback.addNote(am, second.findingId, { note: `${REMARK}!` })),
    );
    expect(errors.map((e) => `${e.name} ${(e as { code?: string }).code ?? ""}`.trim())).toEqual([
      "NotFoundError not_found",
      "NotFoundError not_found",
      "ValidationError bad_text",
      "ValidationError bad_text",
      "ConflictError feedback_limit",
    ]);
    w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    errors.push(
      caught(() => w.services.feedback.addNote(am, first.findingId, { note: `${REMARK} late` })),
    );
    expect((errors.at(-1) as { code?: string }).code).toBe("finding_not_current");

    // --- the scan ---
    const audit = JSON.stringify(w.repo.listAuditEvents({ limit: 10000 }));
    const logs = w.logs.join("\n");
    const errorText = errors.map((e) => `${e.name}: ${e.message}\n${JSON.stringify(e)}`).join("\n");
    for (const [name, haystack] of Object.entries({ audit, logs, errors: errorText }))
      for (const needle of [REMARK, FINDING])
        expect(haystack.includes(needle), `${name} holds ${needle}`).toBe(false);

    // The words did get into the one place that is meant to hold them, so the scan means something.
    expect(where(w, REMARK)).toEqual(["feedback.text"]);
    expect(JSON.stringify(stored)).toContain(REMARK);
    // The refusals kept nothing: 2 notes on the first finding and 20 on the second are all there is.
    expect(w.repo.listFeedback(matterId, { kind: "comment" })).toHaveLength(22);
    expect(where(w, FINDING)).toEqual([]);
    for (const line of w.logs) expect(line).not.toContain("QZX");
  });

  it("are read by every member of the matter beside the finding, and by nobody outside it", async () => {
    const w = makeWorld();
    const { matterId, am, reviewerAm, runId } = await reviewed(w);
    const other = await reviewed(w);
    const finding = w.services.runs.issues(am, runId)[0]!;
    w.services.feedback.addNote(am, finding.findingId, { note: `Mine. ${WORDS}` });
    w.services.feedback.addNote(reviewerAm, finding.findingId, { note: `Theirs. ${OTHER_WORDS}` });

    // What each of the two members is allowed to read of the matter, as text: both notes, in both.
    const readBy = (caller: typeof am): string =>
      JSON.stringify({
        finding: w.services.runs.finding(caller, finding.findingId),
        list: w.services.feedback.list(caller),
        issues: w.services.runs.issues(caller, runId),
      });
    for (const caller of [am, reviewerAm]) {
      expect(readBy(caller)).toContain(WORDS);
      expect(readBy(caller)).toContain(OTHER_WORDS);
    }
    // Another matter's members read neither, whatever they ask for.
    const outside = JSON.stringify({
      list: w.services.feedback.list(other.am),
      issues: w.services.runs.issues(other.am, other.runId),
      matter: w.services.matters.view(other.am),
    });
    expect(outside).not.toContain(WORDS);
    expect(outside).not.toContain(OTHER_WORDS);
    expect(() => w.services.runs.finding(other.am, finding.findingId)).toThrow();
    expect(where(w, WORDS)).toEqual(["feedback.text"]);
    expect(matterId).toBeTruthy();
  });
});
