import { afterAll, describe, expect, it } from "vitest";
import { cleanup, makeWorld, reviewed, type World } from "./support.js";

afterAll(cleanup);

/**
 * The words of a report (package W2.6a, slice B) are text a person typed, and a person can paste a
 * clause into them. They are stored with the matter and deleted with it, and they go nowhere else:
 * not into the audit trail, a log line, an error message, a file name, or any column of the database
 * but the two that hold them (`feedback.text` and `feedback.location`). The check is the one of
 * `privacy.test.ts`: plant a marker in every field a person can fill, make the refusals that involve
 * the marker too, and look for it everywhere. The later slices add the note and the rating comment.
 */

const NOTE = "QZXNOTE-4d19a7";
const PLACE = "QZXPLACE-82c0e3";
const RULE = "QZXRULE-17b6f5";
const RUN = "QZXRUN-6e3d92";

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
