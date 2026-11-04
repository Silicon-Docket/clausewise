import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { HERONBRIDGE_NDA } from "../../src/demo/matters.js";
import { viewOfPrompt } from "../../src/demo/prompt-view.js";
import { isKnownBlock, isKnownClause } from "../../src/demo/reader.js";
import { renderContractBlock } from "../../src/prompts/render.js";
import {
  DURATION,
  EXTRACT_TABLE,
  IDENTITY_NAMES,
  KNOWN_PARAGRAPHS,
  NOT_SHOWN,
  NOT_THE_EXAMPLE,
  PASSAGES,
  RETURN,
  SIMPLE_RULES,
  UNKNOWN_RULE,
  UNORDERED,
  type PassageId,
} from "../../src/demo/worked-example.js";
import { buildCaseWorld, spanOfRef } from "../integration/pipeline.js";

/**
 * The reader's table is copied from the answer key and the worked example, not imported from
 * them. These tests are what keep the copy honest: every phrase is in the committed documents, in
 * the paragraph the key points at, and the rules it covers are the playbook's.
 */

const world = await buildCaseWorld("PAROL-D05");
const ids = Object.keys(PASSAGES) as PassageId[];

/** The paragraphs of a document, whitespace folded as the reader folds them. */
const paragraphs = (doc: "D1" | "D2") =>
  world.ingest.spans
    .filter((s) => s.docLabel === doc)
    .map((s) => ({ label: s.label, text: s.text.replace(/\s+/g, " ").trim() }));

describe("the table against the committed documents", () => {
  it.each(ids)("finds %s in exactly one paragraph of its document, with its quote in it", (id) => {
    const passage = PASSAGES[id];
    const holding = paragraphs(passage.doc).filter((p) => p.text.includes(passage.find));
    expect(holding, `${id} find`).toHaveLength(1);
    expect(holding[0]!.text, `${id} quote`).toContain(passage.quote);
    // Plain ASCII, so the words match whatever the file's typography is.
    expect(passage.find + passage.quote).toMatch(/^[\x20-\x7e]*$/);
  });

  it("holds each phrase once in the whole of its document, so a quote is never ambiguous", () => {
    for (const id of ids) {
      const { doc, quote } = PASSAGES[id];
      const text = paragraphs(doc)
        .map((p) => p.text)
        .join("\n");
      expect(text.split(quote).length - 1, id).toBe(1);
    }
  });

  it("covers every anchor of the key, in the paragraph the key names", () => {
    let anchors = 0;
    for (const [ruleKey, expectation] of Object.entries(world.key.expect)) {
      for (const ref of [
        ...expectation.governing,
        ...expectation.superseded,
        ...expectation.relevant,
      ]) {
        anchors++;
        const span = spanOfRef(world, ref);
        const covering = ids.filter(
          (id) =>
            PASSAGES[id].quote.includes(ref.anchor) &&
            span.text.replace(/\s+/g, " ").includes(PASSAGES[id].find),
        );
        expect(covering, `${ruleKey} ${ref.doc} ${ref.clause}: ${ref.anchor}`).not.toEqual([]);
      }
    }
    expect(anchors).toBeGreaterThan(10);
  });

  it("names the parties of the example, who are in its preamble", () => {
    for (const name of IDENTITY_NAMES)
      expect(
        paragraphs("D1").some((p) => p.text.includes(name)),
        name,
      ).toBe(true);
    expect(IDENTITY_NAMES).toHaveLength(2);
  });
});

describe("the fingerprints of the example's paragraphs", () => {
  it("are those of every paragraph of the two committed documents, once each", () => {
    for (const doc of ["D1", "D2"] as const) {
      const expected = [...new Set(paragraphs(doc).map((p) => sha256Hex(p.text)))].sort();
      expect([...KNOWN_PARAGRAPHS[doc]].sort(), doc).toEqual(expected);
    }
    expect(Object.keys(KNOWN_PARAGRAPHS).sort()).toEqual(["D1", "D2"]);
  });

  it("are digests and not the text of the documents", () => {
    for (const digest of Object.values(KNOWN_PARAGRAPHS).flat())
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("recognise every clause of the example as the stages render it, and no clause of the second matter's NDA", () => {
    const block = renderContractBlock(world.ingest.spans);
    const view = viewOfPrompt(`${block}\n\nRule ID: dur-1`);
    expect(view.clauses).toHaveLength(world.ingest.spans.length);
    expect(view.clauses.every(isKnownClause)).toBe(true);
    expect(isKnownBlock(view)).toBe(true);
    for (const paragraph of HERONBRIDGE_NDA)
      expect(
        isKnownClause({ label: "c1", doc: "D1", text: paragraph.replace(/\s+/g, " ").trim() }),
        paragraph,
      ).toBe(false);
  });

  it("know a paragraph only under the label of the document it is in, and not when a character changes", () => {
    const [nda, amendment] = [world.span("D1-p19"), world.span("D2-p3")];
    const folded = (text: string) => text.replace(/\s+/g, " ").trim();
    expect(isKnownClause({ label: "c1", doc: "D1", text: folded(nda.text) })).toBe(true);
    expect(isKnownClause({ label: "c1", doc: "D2", text: folded(nda.text) })).toBe(false);
    expect(isKnownClause({ label: "c1", doc: "D1", text: folded(amendment.text) })).toBe(false);
    expect(isKnownClause({ label: "c1", doc: null, text: folded(nda.text) })).toBe(false);
    expect(isKnownClause({ label: "c1", doc: "D1", text: `${folded(nda.text)} ` })).toBe(true);
    expect(isKnownClause({ label: "c1", doc: "D1", text: `${folded(nda.text)}.` })).toBe(false);
    expect(isKnownClause({ label: "c1", doc: "D1", text: folded(nda.text).toLowerCase() })).toBe(
      false,
    );
  });

  it("do not make an empty block the example's", () => {
    expect(isKnownBlock(viewOfPrompt(""))).toBe(false);
  });
});

describe("the table against the playbook and the key", () => {
  const ruleKeys = world.playbook.rules.map((r) => r.key);

  it("covers every rule of the demonstration playbook, and no other", () => {
    expect([...Object.keys(SIMPLE_RULES), DURATION.ruleKey, RETURN.ruleKey].sort()).toEqual(
      [...ruleKeys].sort(),
    );
  });

  it("gives each single-clause rule the clause the key gives it as governing", () => {
    for (const [ruleKey, rule] of Object.entries(SIMPLE_RULES)) {
      const governing = world.key.expect[ruleKey]!.governing.map((r) => spanOfRef(world, r).label);
      const passage = PASSAGES[rule.passage];
      const holding = paragraphs(passage.doc).find((p) => p.text.includes(passage.find))!;
      expect(governing, ruleKey).toEqual([holding.label]);
      expect(world.key.expect[ruleKey]!.status, ruleKey).toBe("compliant");
    }
  });

  it("locates, for each category, a clause that one of that category's rules rests on", () => {
    const categories = new Map(world.playbook.rules.map((r) => [r.key, r.category]));
    for (const entry of EXTRACT_TABLE) {
      for (const id of entry.passages) {
        const passage = PASSAGES[id];
        const label = paragraphs(passage.doc).find((p) => p.text.includes(passage.find))!.label;
        const rests = Object.entries(world.key.expect).some(
          ([ruleKey, expectation]) =>
            categories.get(ruleKey) === entry.category &&
            [...expectation.governing, ...expectation.superseded, ...expectation.relevant].some(
              (ref) => spanOfRef(world, ref).label === label,
            ),
        );
        expect(rests, `${entry.category}: ${id}`).toBe(true);
      }
    }
  });

  it("leaves the clauses of the amendment and the survival clause out of the locator's answer (H1)", () => {
    const located = EXTRACT_TABLE.flatMap((entry) => entry.passages);
    for (const id of ["deletion", "returnAmendment", "survival"] as const)
      expect(located, id).not.toContain(id);
    for (const id of located) expect(PASSAGES[id].doc, id).toBe("D1");
  });

  it("is adapted from the rules' approved text, which has the words the adaptation replaces", () => {
    const rule = (key: string) => world.playbook.rules.find((r) => r.key === key)!;
    expect(rule("dur-1").fallbackLanguage).toContain(DURATION.adaptation.from);
    expect(rule("ret-1").fallbackLanguage?.startsWith("Within thirty (30) days")).toBe(true);
  });
});

describe("the words it writes", () => {
  const texts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") texts.push(value);
    else if (typeof value === "function") texts.push(value("a topic") as string);
    else if (value !== null && typeof value === "object")
      for (const inner of Object.values(value)) collect(inner);
  };
  collect([
    DURATION,
    RETURN,
    UNORDERED,
    NOT_THE_EXAMPLE,
    UNKNOWN_RULE,
    NOT_SHOWN,
    SIMPLE_RULES,
    EXTRACT_TABLE,
  ]);

  it("are plain sentences with no clause label, no dash, no line break and nothing but ASCII", () => {
    expect(texts.length).toBeGreaterThan(25);
    for (const text of texts) {
      expect(text, text).not.toMatch(/\bc\d{1,4}\b/);
      expect(text, text).not.toMatch(/[\n\r]/);
      expect(text, text).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it("say what the simulated reader is when it declines", () => {
    expect(NOT_THE_EXAMPLE.reason).toMatch(/only knows the worked example/);
    expect(NOT_THE_EXAMPLE.support).toMatch(/only knows the worked example/);
    expect(UNKNOWN_RULE.reason).toMatch(/demonstration playbook/);
  });

  it("describe the duration finding as the worked example does", () => {
    expect(DURATION.deviationDiscrepancy).toContain("Amendment No. 1 deletes Section 6.1");
    expect(DURATION.deviationDiscrepancy).toContain("Section 9.3 keeps Section 4 in force");
    expect(DURATION.deviationDiscrepancyWithoutSurvival).not.toContain("9.3");
    expect(DURATION.baselineExplanation).toContain("within the three-year standard");
  });
});

describe("the second matter's NDA", () => {
  const text = HERONBRIDGE_NDA.join("\n");

  it("is not the worked example: no party of it, and none of its known phrases", () => {
    for (const name of IDENTITY_NAMES) expect(text).not.toContain(name);
    for (const id of ids) expect(text, id).not.toContain(PASSAGES[id].find);
  });

  it("is synthetic, short and numbered as an upload carries numbers", () => {
    expect(HERONBRIDGE_NDA.length).toBeGreaterThanOrEqual(8);
    expect(HERONBRIDGE_NDA.slice(2).map((p) => p.split(" ")[0])).toEqual([
      "1.",
      "2.",
      "3.",
      "4.",
      "5.",
      "6.",
      "7.",
    ]);
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
  });
});
