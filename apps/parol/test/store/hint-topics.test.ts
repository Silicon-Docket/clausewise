import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import type { PlaybookRuleRecord, SpanAnnotation } from "../../src/contracts.js";
import { ValidationError } from "../../src/store/index.js";
import { ACTORS, addMatter, makeWorld } from "./fixtures.js";

/**
 * A keyword hint carries a topic and a rule lists the topics it cares about. Both pass through the
 * store, which keeps annotations as JSON next to the span and a rule as JSON next to its columns,
 * and each must come back exactly as it went in. A store that dropped the topic would give every
 * rule every hint of its category again, which is the defect the topics exist to fix.
 */

describe("a hint annotation with a topic", () => {
  it("is stored with its topic and read back unchanged, with the hints that have none beside it", () => {
    const w = makeWorld();
    // `spans: false` leaves the version without spans, so that they can be inserted here.
    const m = addMatter(w, { spans: false });
    const ids = m.nda.spanIds;
    const inserted = w.repo.insertSpans(
      m.id,
      m.nda.texts.map((text, i) => ({
        id: ids[i] as string,
        label: `D1-p${i}`,
        modelLabel: `c${i + 1}`,
        documentVersionId: m.nda.versionId,
        docLabel: "D1" as const,
        paragraphIndex: i,
        clauseId: `c${i + 1}`,
        clauseNumber: null,
        heading: null,
        text,
        textSha256: sha256Hex(text),
      })),
      [
        {
          kind: "keyword_hint",
          spanId: ids[1] as string,
          category: "permitted-disclosures",
          topic: "legal-compulsion",
        },
        {
          kind: "keyword_hint",
          spanId: ids[1] as string,
          category: "permitted-disclosures",
          topic: "representatives",
        },
        { kind: "keyword_hint", spanId: ids[2] as string, category: "duration" },
      ],
    );
    expect(inserted.inserted).toBe(m.nda.texts.length);
    const read = w.repo.listAnnotations(m.id, [m.nda.versionId]);
    expect(read).toStrictEqual([
      {
        kind: "keyword_hint",
        spanId: ids[1],
        category: "permitted-disclosures",
        topic: "legal-compulsion",
      },
      {
        kind: "keyword_hint",
        spanId: ids[1],
        category: "permitted-disclosures",
        topic: "representatives",
      },
      { kind: "keyword_hint", spanId: ids[2], category: "duration" },
    ]);
    // A hint with no topic stays without the key; it is not read back as an empty topic.
    expect("topic" in (read[2] as object)).toBe(false);
  });

  it("is replaced as a whole when annotations are refreshed, topic included", () => {
    const w = makeWorld();
    const m = addMatter(w);
    const [first] = m.nda.spanIds;
    const replaced: SpanAnnotation[] = [
      {
        kind: "keyword_hint",
        spanId: first as string,
        category: "permitted-disclosures",
        topic: "representatives",
      },
    ];
    w.repo.replaceAnnotations(m.id, [m.nda.versionId], replaced);
    expect(w.repo.listAnnotations(m.id, [m.nda.versionId])).toStrictEqual(replaced);
    w.repo.replaceAnnotations(
      m.id,
      [m.nda.versionId],
      [{ kind: "keyword_hint", spanId: first as string, category: "permitted-disclosures" }],
    );
    expect(w.repo.listAnnotations(m.id, [m.nda.versionId])).toStrictEqual([
      { kind: "keyword_hint", spanId: first, category: "permitted-disclosures" },
    ]);
  });

  it.each([
    ["capital letters", "Legal-Compulsion"],
    ["a space", "legal compulsion"],
    ["a path", "../etc"],
    ["an empty string", ""],
    ["more than 64 characters", "a".repeat(65)],
    ["a line break", "legal\ncompulsion"],
  ])("is refused when the topic has %s, and nothing is stored", (_name, topic) => {
    const w = makeWorld();
    const m = addMatter(w);
    const before = JSON.stringify(w.repo.listAnnotations(m.id, [m.nda.versionId]));
    expect(() =>
      w.repo.replaceAnnotations(
        m.id,
        [m.nda.versionId],
        [
          {
            kind: "keyword_hint",
            spanId: m.nda.spanIds[0] as string,
            category: "permitted-disclosures",
            topic,
          },
        ],
      ),
    ).toThrow(ValidationError);
    expect(JSON.stringify(w.repo.listAnnotations(m.id, [m.nda.versionId]))).toBe(before);
  });
});

describe("a rule with hintTopics", () => {
  const rule = (over: Partial<PlaybookRuleRecord>): PlaybookRuleRecord => ({
    key: "pds-9",
    category: "permitted-disclosures",
    title: "Disclosure required by law",
    severity: "medium",
    required: true,
    kind: "presence",
    standard: "A dedicated clause.",
    fallback: null,
    unacceptable: null,
    guidance: null,
    fallbackLanguage: null,
    escalateWhen: [],
    ...over,
  });
  const importRules = (version: string, rules: PlaybookRuleRecord[]) => {
    const w = makeWorld();
    const yaml = `name: Another playbook\nversion: ${version}\n`;
    const draft = w.repo.importPlaybookDraft(
      { slug: "other-playbook", version, yaml, sha256: sha256Hex(yaml), rules },
      { actorId: ACTORS.legalEngineer },
    );
    return { w, rules: w.repo.listRules(draft.id) };
  };

  it("reads back with the topics in the order written", () => {
    const { rules } = importRules("1.0.0", [
      rule({ hintTopics: ["legal-compulsion", "representatives"] }),
    ]);
    expect(rules[0]?.hintTopics).toEqual(["legal-compulsion", "representatives"]);
  });

  it("reads back with an empty list when the list is empty, and without the field when there was none", () => {
    const { rules: empty } = importRules("1.0.0", [rule({ hintTopics: [] })]);
    expect(empty[0]?.hintTopics).toEqual([]);
    const { rules: none } = importRules("1.0.0", [rule({})]);
    expect("hintTopics" in (none[0] as object)).toBe(false);
  });

  it("is part of the rule's identity: the same rule with other topics has another hash", () => {
    const hashOf = (hintTopics: string[] | undefined): string => {
      const { rules } = importRules("1.0.0", [
        rule(hintTopics === undefined ? {} : { hintTopics }),
      ]);
      return rules[0]!.ruleSha256;
    };
    const none = hashOf(undefined);
    const legal = hashOf(["legal-compulsion"]);
    const reps = hashOf(["representatives"]);
    expect(new Set([none, legal, reps]).size).toBe(3);
    expect(hashOf(["legal-compulsion"])).toBe(legal);
  });

  it.each([
    ["capital letters", "Legal"],
    ["a space", "legal compulsion"],
    ["an empty string", ""],
    ["more than 64 characters", "a".repeat(65)],
  ])("is refused at import when a topic has %s", (_name, topic) => {
    expect(() => importRules("1.0.0", [rule({ hintTopics: [topic] })])).toThrow(ValidationError);
  });

  it("is refused at import when it is not a list of strings", () => {
    expect(() =>
      importRules("1.0.0", [rule({ hintTopics: "legal-compulsion" as unknown as string[] })]),
    ).toThrow(ValidationError);
  });
});
