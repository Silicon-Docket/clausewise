import { describe, expect, it } from "vitest";
import { PlaybookError, parsePlaybook } from "../src/index.js";

// `hintTopics` is the one field a rule gains for keyword hints: the kinds of hint that matter to
// it, for a category that several rules share. It is optional so that every playbook written
// before it stays valid, and strict where present so that a misspelt topic is caught when the file
// is written. Which topics exist is the hinting tool's to know, so the format fixes spelling only.

type Json = Record<string, unknown>;

/** JSON is a subset of YAML, so a playbook can be built as an object. */
const yamlOf = (rule: Json = {}, top: Json = {}): string =>
  JSON.stringify({
    name: "Invented playbook",
    contractTypes: ["nda"],
    perspective: "We are the invented receiving party.",
    rules: [
      {
        id: "r-1",
        title: "Invented rule",
        severity: "low",
        standard: "Invented standard.",
        ...rule,
      },
    ],
    ...top,
  });

const problemsOf = (yaml: string): string[] => {
  try {
    parsePlaybook(yaml, "t.yaml");
  } catch (err) {
    expect(err).toBeInstanceOf(PlaybookError);
    return (err as PlaybookError).problems;
  }
  return [];
};

describe("hintTopics", () => {
  it("is optional, so a playbook written before it still parses", () => {
    expect(parsePlaybook(yamlOf()).rules[0]?.hintTopics).toBeUndefined();
  });

  it("keeps the topics in the order written", () => {
    const hintTopics = ["legal-compulsion", "representatives", "a1-b2"];
    expect(parsePlaybook(yamlOf({ hintTopics })).rules[0]?.hintTopics).toEqual(hintTopics);
    expect(
      parsePlaybook(yamlOf({ hintTopics: [...hintTopics].reverse() })).rules[0]?.hintTopics,
    ).toEqual([...hintTopics].reverse());
  });

  it("accepts an empty list, which means every topic of the category", () => {
    expect(parsePlaybook(yamlOf({ hintTopics: [] })).rules[0]?.hintTopics).toEqual([]);
  });

  it("accepts a single word and a topic that starts with a digit", () => {
    for (const topic of ["representatives", "5-years", "a"]) {
      expect(parsePlaybook(yamlOf({ hintTopics: [topic] })).rules[0]?.hintTopics, topic).toEqual([
        topic,
      ]);
    }
  });

  it.each([
    ["capital letters", "Legal-Compulsion"],
    ["an underscore", "legal_compulsion"],
    ["a space", "legal compulsion"],
    ["a leading hyphen", "-legal"],
    ["an empty string", ""],
    ["a trailing line break", "legal\n"],
    ["a dot", "legal.compulsion"],
    ["a non-ASCII letter", "légal"],
  ])("refuses a topic with %s and names the position, not the value", (_label, topic) => {
    const problems = problemsOf(yamlOf({ hintTopics: ["fine", topic] }));
    expect(problems).toEqual(["rules[0].hintTopics[1]: use lowercase letters, digits and hyphens"]);
  });

  it("refuses a topic of more than 64 characters and accepts one of exactly 64", () => {
    expect(problemsOf(yamlOf({ hintTopics: ["a".repeat(64)] }))).toEqual([]);
    expect(problemsOf(yamlOf({ hintTopics: ["a".repeat(65)] }))).toEqual([
      "rules[0].hintTopics[0]: use at most 64 characters",
    ]);
  });

  it("must be a list of strings, not a string, a mapping or a list of other things", () => {
    for (const hintTopics of [
      "representatives",
      { topic: "representatives" },
      [1],
      [null],
      [["a", "b"]],
      [{ id: "a" }],
    ]) {
      const problems = problemsOf(yamlOf({ hintTopics }));
      expect(problems.length, JSON.stringify(hintTopics)).toBeGreaterThan(0);
      expect(problems.join("\n"), JSON.stringify(hintTopics)).toMatch(/^rules\[0\]\.hintTopics/m);
    }
  });

  it("refuses a topic listed twice, names the later position and repeats no topic", () => {
    const problems = problemsOf(
      yamlOf({ hintTopics: ["representatives", "legal-compulsion", "representatives"] }),
    );
    expect(problems).toEqual(["rules[0].hintTopics[2]: list each hint topic once"]);
    expect(problems.join("")).not.toContain("representatives");
  });

  it("reports every duplicate, not only the first", () => {
    const problems = problemsOf(yamlOf({ hintTopics: ["a", "a", "b", "b", "a"] }));
    expect(problems).toEqual([
      "rules[0].hintTopics[1]: list each hint topic once",
      "rules[0].hintTopics[3]: list each hint topic once",
      "rules[0].hintTopics[4]: list each hint topic once",
    ]);
  });

  it("scopes topics to the rule: two rules may list the same topic", () => {
    const rules = [
      { id: "a", title: "A", severity: "low", standard: "s", hintTopics: ["shared"] },
      { id: "b", title: "B", severity: "low", standard: "s", hintTopics: ["shared"] },
    ];
    expect(problemsOf(yamlOf({}, { rules }))).toEqual([]);
  });

  it("does not know which topics exist, which is the hinting tool's to enforce", () => {
    expect(
      parsePlaybook(yamlOf({ hintTopics: ["a-topic-no-tool-has-heard-of"] })).rules[0]?.hintTopics,
    ).toEqual(["a-topic-no-tool-has-heard-of"]);
  });

  it("does not make a rule that lacks the field fail, and leaves the other fields as they were", () => {
    const parsed = parsePlaybook(
      yamlOf({
        hintTopics: ["representatives"],
        category: "permitted-disclosures",
        required: true,
      }),
    );
    expect(parsed.rules[0]).toMatchObject({
      id: "r-1",
      category: "permitted-disclosures",
      required: true,
      hintTopics: ["representatives"],
    });
  });

  it("is a known key, but a misspelt one is still refused so it is not silently dropped", () => {
    for (const key of ["hintTopic", "hint_topics", "hintTopicsList", "topics"]) {
      const problems = problemsOf(yamlOf({ [key]: ["representatives"] }));
      expect(problems, key).toHaveLength(1);
      expect(problems[0], key).toMatch(/^rules\[0\]: Unrecognized key/);
    }
  });

  it("is checked together with problems elsewhere, so an author sees them in one pass", () => {
    const rules = [
      { id: "a", title: "A", severity: "low", standard: "s", hintTopics: ["Bad"] },
      { id: "b", title: "B", severity: "nope", standard: "s", hintTopics: ["ok"] },
    ];
    const problems = problemsOf(yamlOf({}, { rules }));
    expect(problems).toContain("rules[0].hintTopics[0]: use lowercase letters, digits and hyphens");
    expect(problems.some((p) => p.startsWith("rules[1].severity:"))).toBe(true);
  });

  it("finds a duplicate topic and a duplicate rule id in the same pass", () => {
    const rules = [
      { id: "a", title: "A", severity: "low", standard: "s", hintTopics: ["x", "x"] },
      { id: "a", title: "B", severity: "low", standard: "s" },
    ];
    expect(problemsOf(yamlOf({}, { rules }))).toEqual([
      "rules[0].hintTopics[1]: list each hint topic once",
      'rules[1].id: duplicate rule id "a"',
    ]);
  });
});
