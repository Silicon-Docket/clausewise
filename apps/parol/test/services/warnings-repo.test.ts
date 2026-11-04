import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { NotFoundError, ValidationError } from "../../src/store/index.js";
import { cleanup, makeWorld, newMatter, uploadCase } from "./support.js";

afterAll(cleanup);

async function twoMatters() {
  const w = makeWorld();
  const a = newMatter(w, "a");
  const ua = await uploadCase(w, a.matterId);
  const b = newMatter(w, "b");
  const ub = await uploadCase(w, b.matterId);
  return { w, a, ua, b, ub };
}

describe("upload warnings in the store", () => {
  it("replaces all the warnings of a version at once, in order, and reads them back", async () => {
    const { w, a, ua } = await twoMatters();
    const [span] = w.repo.listSpans(a.matterId, [ua.versionIds[0]!]);
    const stored = w.repo.replaceIngestWarnings(a.matterId, ua.versionIds[0]!, [
      { code: "instruction_like_text", spanId: span!.id, detail: "matched a pattern" },
      { code: "unreviewed_content", detail: "not reviewed: comments=2" },
    ]);
    expect(stored.map((x) => [x.code, x.spanId, x.detail])).toEqual([
      ["instruction_like_text", span!.id, "matched a pattern"],
      ["unreviewed_content", null, "not reviewed: comments=2"],
    ]);
    const second = w.repo.replaceIngestWarnings(a.matterId, ua.versionIds[0]!, [
      { code: "no_reviewable_text", detail: "none" },
    ]);
    expect(second.map((x) => x.code)).toEqual(["no_reviewable_text"]);
    expect(w.repo.listIngestWarnings(a.matterId, [ua.versionIds[0]!]).map((x) => x.code)).toEqual([
      "no_reviewable_text",
    ]);
    // Other versions are untouched, and an empty list clears.
    w.repo.replaceIngestWarnings(a.matterId, ua.versionIds[1]!, [
      { code: "near_duplicate_version", detail: "d" },
    ]);
    expect(w.repo.listIngestWarnings(a.matterId)).toHaveLength(2);
    w.repo.replaceIngestWarnings(a.matterId, ua.versionIds[0]!, []);
    expect(w.repo.listIngestWarnings(a.matterId).map((x) => x.documentVersionId)).toEqual([
      ua.versionIds[1],
    ]);
  });

  it("keeps each matter's warnings to itself", async () => {
    const { w, a, ua, b, ub } = await twoMatters();
    expect(() =>
      w.repo.replaceIngestWarnings(a.matterId, ub.versionIds[0]!, [
        { code: "unreviewed_content", detail: "x" },
      ]),
    ).toThrow(NotFoundError);
    const [foreignSpan] = w.repo.listSpans(b.matterId, [ub.versionIds[0]!]);
    expect(() =>
      w.repo.replaceIngestWarnings(a.matterId, ua.versionIds[0]!, [
        { code: "instruction_like_text", spanId: foreignSpan!.id, detail: "x" },
      ]),
    ).toThrow(NotFoundError);
    // A span of the same matter but another version is not this version's either.
    const [other] = w.repo.listSpans(a.matterId, [ua.versionIds[1]!]);
    expect(() =>
      w.repo.replaceIngestWarnings(a.matterId, ua.versionIds[0]!, [
        { code: "instruction_like_text", spanId: other!.id, detail: "x" },
      ]),
    ).toThrow(NotFoundError);
    expect(w.repo.listIngestWarnings(a.matterId)).toEqual([]);
    expect(w.repo.listIngestWarnings(b.matterId)).toEqual([]);
  });

  it("refuses a code that is not one and a detail too long to be anything but text, without echoing either", async () => {
    const { w, a, ua } = await twoMatters();
    const code = await (async () => {
      try {
        w.repo.replaceIngestWarnings(a.matterId, ua.versionIds[0]!, [
          { code: "QZX" as never, detail: "x" },
        ]);
      } catch (error) {
        return error as ValidationError;
      }
    })();
    expect(code).toBeInstanceOf(ValidationError);
    expect(code!.message).not.toContain("QZX");
    const long = await (async () => {
      try {
        w.repo.replaceIngestWarnings(a.matterId, ua.versionIds[0]!, [
          { code: "unreviewed_content", detail: "QZX".repeat(200) },
        ]);
      } catch (error) {
        return error as ValidationError;
      }
    })();
    expect(long).toBeInstanceOf(ValidationError);
    expect(long!.message).not.toContain("QZX");
    expect(w.repo.listIngestWarnings(a.matterId)).toEqual([]);
  });

  it("leaves the old set when a new one is refused part-way", async () => {
    const { w, a, ua } = await twoMatters();
    w.repo.replaceIngestWarnings(a.matterId, ua.versionIds[0]!, [
      { code: "unreviewed_content", detail: "old" },
    ]);
    expect(() =>
      w.repo.replaceIngestWarnings(a.matterId, ua.versionIds[0]!, [
        { code: "no_reviewable_text", detail: "new" },
        { code: "instruction_like_text", spanId: "ver_ffffffffffffffff:p0", detail: "bad span" },
      ]),
    ).toThrow(NotFoundError);
    expect(w.repo.listIngestWarnings(a.matterId).map((x) => x.detail)).toEqual(["old"]);
  });

  it("goes with the version, and with the matter", async () => {
    const { w, a, ua } = await twoMatters();
    w.repo.replaceIngestWarnings(a.matterId, ua.versionIds[1]!, [
      { code: "near_duplicate_version", detail: "d" },
    ]);
    w.repo.replaceIngestWarnings(a.matterId, ua.versionIds[0]!, [
      { code: "unreviewed_content", detail: "d" },
    ]);
    w.services.matters.removeDocument(a.am, ua.documentIds[1]!);
    expect(w.repo.listIngestWarnings(a.matterId).map((x) => x.documentVersionId)).toEqual([
      ua.versionIds[0],
    ]);
    await w.services.matters.delete(a.am);
    const left = w.repo.db
      .prepare("SELECT count(*) AS n FROM ingest_warnings WHERE matter_id = ?")
      .get(a.matterId) as { n: number };
    expect(left.n).toBe(0);
  });

  it("cannot be edited in place", async () => {
    const { w, a, ua } = await twoMatters();
    w.repo.replaceIngestWarnings(a.matterId, ua.versionIds[0]!, [
      { code: "unreviewed_content", detail: "d" },
    ]);
    expect(() => w.repo.db.prepare("UPDATE ingest_warnings SET detail = 'changed'").run()).toThrow(
      /replaced, never edited/,
    );
    expect(() =>
      w.repo.db
        .prepare(
          "INSERT INTO ingest_warnings (matter_id, document_version_id, span_id, code, detail, created_at) VALUES (?, ?, NULL, 'unreviewed_content', 'x', 't')",
        )
        .run(a.matterId, "ver_ffffffffffffffff"),
    ).toThrow();
    expect(sha256Hex("x")).toBeTruthy();
  });
});

describe("replacing annotations", () => {
  it("swaps the annotations of the named versions, in the order given, and leaves the others alone", async () => {
    const { w, a, ua, b, ub } = await twoMatters();
    const theirs = JSON.stringify(w.repo.listAnnotations(b.matterId, ub.versionIds));
    const spans = w.repo.listSpans(a.matterId, ua.versionIds);
    const first = spans[0]!;
    const second = spans[2]!;
    w.repo.replaceAnnotations(
      a.matterId,
      [ua.versionIds[0]!],
      [
        { kind: "keyword_hint", spanId: second.id, category: "duration" },
        { kind: "defines_term", spanId: first.id, term: "Thing" },
      ],
    );
    expect(w.repo.listAnnotations(a.matterId, [ua.versionIds[0]!])).toEqual([
      { kind: "keyword_hint", spanId: second.id, category: "duration" },
      { kind: "defines_term", spanId: first.id, term: "Thing" },
    ]);
    // The amendment's annotations were not among the named versions, so they are as they were.
    expect(w.repo.listAnnotations(a.matterId, [ua.versionIds[1]!]).length).toBeGreaterThan(0);
    expect(JSON.stringify(w.repo.listAnnotations(b.matterId, ub.versionIds))).toBe(theirs);
  });

  it("refuses a span that is not in the named versions, and then changes nothing", async () => {
    const { w, a, ua, ub } = await twoMatters();
    const before = JSON.stringify(w.repo.listAnnotations(a.matterId, ua.versionIds));
    const [foreign] = w.repo.listSpans(a.matterId, [ua.versionIds[1]!]);
    expect(() =>
      w.repo.replaceAnnotations(
        a.matterId,
        [ua.versionIds[0]!],
        [{ kind: "keyword_hint", spanId: foreign!.id, category: "duration" }],
      ),
    ).toThrow(NotFoundError);
    expect(() => w.repo.replaceAnnotations(a.matterId, ub.versionIds, [])).not.toThrow();
    expect(JSON.stringify(w.repo.listAnnotations(a.matterId, ua.versionIds))).toBe(before);
  });
});
