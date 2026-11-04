import { describe, expect, it } from "vitest";
import { EscalateWhenSchema, PlaybookError, parsePlaybook } from "../src/index.js";

// The four optional fields Parol adds to the base format: version, category, fallbackLanguage and
// escalateWhen. They are optional so that the playbooks Clausewise already ships stay valid, and
// strict where they are present so that a typo is caught when the file is written and not when a
// matter runs.

type Json = Record<string, unknown>;

/** JSON is a subset of YAML, so a playbook can be built as an object. Undefined members drop out. */
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

// Characters that draw nothing, written as escapes so that this file stays plain ASCII.
const INVISIBLE = "\u200b\u200d \u00ad\u2800";

describe("version", () => {
  it("is optional, so a playbook written before Parol still parses", () => {
    expect(parsePlaybook(yamlOf()).version).toBeUndefined();
  });

  it("keeps three dot-separated numbers exactly as written", () => {
    for (const version of ["1.0.0", "0.0.1", "2.14.3", "10.20.30"]) {
      expect(parsePlaybook(yamlOf({}, { version })).version, version).toBe(version);
    }
  });

  it.each([
    ["two numbers", "1.0"],
    ["four numbers", "1.0.0.0"],
    ["a v prefix", "v1.0.0"],
    ["a pre-release tag", "1.0.0-rc1"],
    ["build metadata", "1.0.0+build5"],
    ["a word", "one"],
    ["an empty string", ""],
    ["leading white space", " 1.0.0"],
    ["trailing white space", "1.0.0 "],
    ["a number that is not ASCII", "\u0661.\u0660.\u0660"],
    ["a negative number", "-1.0.0"],
  ])("refuses %s", (_label, version) => {
    const problems = problemsOf(yamlOf({}, { version }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^version: use three numbers separated by dots, such as 1\.0\.0$/);
  });

  // The rest of a playbook, as YAML text, for tests that must control how the version is written.
  const rest = [
    "name: Invented playbook",
    "contractTypes: [nda]",
    "perspective: p",
    "rules:",
    "  - id: r-1",
    "    title: t",
    "    severity: low",
    "    standard: s",
    "",
  ].join("\n");

  it("refuses a version with a trailing line break, which a YAML block scalar produces", () => {
    const problems = problemsOf(`version: |\n  1.0.0\n${rest}`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^version: use three numbers/);
  });

  it("refuses a bare number, null or boolean, because 1.0 unquoted is not the text 1.0", () => {
    for (const written of ["1.0", "1", "null", "true"]) {
      const problems = problemsOf(`version: ${written}\n${rest}`);
      expect(problems.join("\n"), written).toMatch(/^version:/m);
    }
  });

  it("checks only the shape, so leading zeros pass here and are refused by Parol's loader", () => {
    // 1.0.0, 01.0.0 and 1.00.0 are three spellings of one version. The base format is shared with
    // tools that never read a version, so the canonical form is enforced by loadPlaybook in
    // apps/parol (see its tests). If this pattern is ever tightened, move these to the table above.
    for (const version of ["01.0.0", "1.00.0", "1.0.00"]) {
      expect(parsePlaybook(yamlOf({}, { version })).version, version).toBe(version);
    }
  });

  it("accepts the same version when it is quoted in YAML", () => {
    expect(parsePlaybook(`version: "1.0.0"\n${rest}`).version).toBe("1.0.0");
    expect(parsePlaybook(`version: 1.0.0\n${rest}`).version).toBe("1.0.0");
  });
});

describe("category", () => {
  it("is optional", () => {
    expect(parsePlaybook(yamlOf()).rules[0]?.category).toBeUndefined();
  });

  it("accepts lowercase letters, digits and hyphens", () => {
    for (const category of ["duration", "ci-definition", "return-destruction", "a", "9", "a1-b2"]) {
      expect(parsePlaybook(yamlOf({ category })).rules[0]?.category, category).toBe(category);
    }
  });

  it("does not know the list of categories, which is Parol's to enforce", () => {
    // The base format is shared with tools that have no such list, so a well-formed value passes.
    expect(parsePlaybook(yamlOf({ category: "not-a-parol-category" })).rules[0]?.category).toBe(
      "not-a-parol-category",
    );
  });

  it.each([
    ["capital letters", "Duration"],
    ["an underscore", "ci_definition"],
    ["a leading hyphen", "-duration"],
    ["a space", "return destruction"],
    ["an empty string", ""],
    ["a trailing line break", "duration\n"],
    ["a dot", "governing.law"],
    ["a non-ASCII letter", "d\u00fcration"],
  ])("refuses %s", (_label, category) => {
    const problems = problemsOf(yamlOf({ category }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^rules\[0\]\.category: use lowercase letters, digits and hyphens$/,
    );
  });

  it("reports the rule it is on", () => {
    const rules = [
      { id: "a", title: "A", severity: "low", standard: "s", category: "duration" },
      { id: "b", title: "B", severity: "low", standard: "s", category: "Bad" },
    ];
    const problems = problemsOf(yamlOf({}, { rules }));
    expect(problems).toEqual(["rules[1].category: use lowercase letters, digits and hyphens"]);
  });
});

describe("fallbackLanguage", () => {
  it("is optional and kept as written", () => {
    expect(parsePlaybook(yamlOf()).rules[0]?.fallbackLanguage).toBeUndefined();
    const text = 'The Receiving Party shall return "all" copies; see (a) below.';
    expect(parsePlaybook(yamlOf({ fallbackLanguage: text })).rules[0]?.fallbackLanguage).toBe(text);
  });

  it("refuses text that is empty or draws nothing", () => {
    for (const fallbackLanguage of ["", "   ", INVISIBLE]) {
      expect(problemsOf(yamlOf({ fallbackLanguage })).join("\n")).toMatch(
        /^rules\[0\]\.fallbackLanguage: must contain a visible character/m,
      );
    }
  });

  it("is distinct from fallback, which describes a position, so each can be given alone", () => {
    const withBoth = parsePlaybook(
      yamlOf({ fallback: "A position.", fallbackLanguage: "Wording." }),
    );
    expect(withBoth.rules[0]).toMatchObject({
      fallback: "A position.",
      fallbackLanguage: "Wording.",
    });
    const only = parsePlaybook(yamlOf({ fallbackLanguage: "Wording." }));
    expect(only.rules[0]?.fallback).toBeUndefined();
  });

  it("refuses a list, because a rule has one approved wording", () => {
    expect(problemsOf(yamlOf({ fallbackLanguage: ["one", "two"] })).join("\n")).toMatch(
      /^rules\[0\]\.fallbackLanguage:/m,
    );
  });
});

describe("escalateWhen", () => {
  const ok = [
    { id: "over-five-years", text: "The period is longer than the fallback." },
    { id: "forum-2", text: "The forum is outside the approved list." },
  ];

  it("is optional, and an empty list is accepted", () => {
    expect(parsePlaybook(yamlOf()).rules[0]?.escalateWhen).toBeUndefined();
    expect(parsePlaybook(yamlOf({ escalateWhen: [] })).rules[0]?.escalateWhen).toEqual([]);
  });

  it("keeps the items in the order written", () => {
    expect(parsePlaybook(yamlOf({ escalateWhen: ok })).rules[0]?.escalateWhen).toEqual(ok);
    expect(
      parsePlaybook(yamlOf({ escalateWhen: [...ok].reverse() })).rules[0]?.escalateWhen,
    ).toEqual([...ok].reverse());
  });

  it("must be a list of objects, not a string, a mapping or a list of strings", () => {
    for (const escalateWhen of [
      "over-five-years",
      { id: "a", text: "b" },
      ["over-five-years"],
      [null],
      [["a", "b"]],
    ]) {
      const problems = problemsOf(yamlOf({ escalateWhen }));
      expect(problems.length, JSON.stringify(escalateWhen)).toBeGreaterThan(0);
      expect(problems.join("\n"), JSON.stringify(escalateWhen)).toMatch(
        /^rules\[0\]\.escalateWhen/m,
      );
    }
  });

  it("needs both an id and a text on every item and names the item", () => {
    const noText = problemsOf(yamlOf({ escalateWhen: [ok[0], { id: "second-one" }] }));
    expect(noText).toHaveLength(1);
    expect(noText[0]).toMatch(/^rules\[0\]\.escalateWhen\[1\]\.text:/);
    const noId = problemsOf(yamlOf({ escalateWhen: [{ text: "A situation." }] }));
    expect(noId).toHaveLength(1);
    expect(noId[0]).toMatch(/^rules\[0\]\.escalateWhen\[0\]\.id:/);
  });

  it("refuses a key it does not know, so a misspelt field is not dropped", () => {
    const problems = problemsOf(
      yamlOf({ escalateWhen: [{ id: "a-case", text: "A situation.", txt: "x" }] }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^rules\[0\]\.escalateWhen\[0\]:.*txt/);
  });

  it.each([
    ["capital letters", "Over-Five"],
    ["an underscore", "over_five"],
    ["a space", "over five"],
    ["a leading hyphen", "-over"],
    ["an empty string", ""],
    ["a trailing line break", "over-five\n"],
  ])("refuses an id with %s", (_label, id) => {
    const problems = problemsOf(yamlOf({ escalateWhen: [{ id, text: "A situation." }] }));
    expect(problems).toEqual([
      "rules[0].escalateWhen[0].id: use lowercase letters, digits and hyphens",
    ]);
  });

  it("accepts an id that is a single word or starts with a digit", () => {
    for (const id of ["short", "5-years", "a-b-c-d"]) {
      const parsed = parsePlaybook(yamlOf({ escalateWhen: [{ id, text: "A situation." }] }));
      expect(parsed.rules[0]?.escalateWhen?.[0]?.id, id).toBe(id);
    }
  });

  it("refuses a text that is empty or draws nothing", () => {
    for (const text of ["", "  ", INVISIBLE]) {
      expect(problemsOf(yamlOf({ escalateWhen: [{ id: "a-case", text }] })).join("\n")).toMatch(
        /^rules\[0\]\.escalateWhen\[0\]\.text: must contain a visible character/m,
      );
    }
  });

  it("refuses a duplicate id within one rule and names the rule, the id and the later item", () => {
    const problems = problemsOf(
      yamlOf({
        id: "dur-1",
        escalateWhen: [
          { id: "case-a", text: "First." },
          { id: "case-b", text: "Second." },
          { id: "case-a", text: "Third." },
        ],
      }),
    );
    expect(problems).toEqual([
      'rules[0].escalateWhen[2].id: duplicate escalateWhen id "case-a" in rule "dur-1"',
    ]);
  });

  it("reports every duplicate, not only the first", () => {
    const problems = problemsOf(
      yamlOf({
        escalateWhen: [
          { id: "x", text: "1." },
          { id: "x", text: "2." },
          { id: "y", text: "3." },
          { id: "y", text: "4." },
        ],
      }),
    );
    expect(problems).toEqual([
      'rules[0].escalateWhen[1].id: duplicate escalateWhen id "x" in rule "r-1"',
      'rules[0].escalateWhen[3].id: duplicate escalateWhen id "y" in rule "r-1"',
    ]);
  });

  it("scopes ids to the rule: the same id in two rules is accepted, because a finding cites it with its rule", () => {
    const rules = [
      {
        id: "a",
        title: "A",
        severity: "low",
        standard: "s",
        escalateWhen: [{ id: "shared", text: "One." }],
      },
      {
        id: "b",
        title: "B",
        severity: "low",
        standard: "s",
        escalateWhen: [{ id: "shared", text: "Two." }],
      },
    ];
    expect(problemsOf(yamlOf({}, { rules }))).toEqual([]);
  });

  it("is checked together with format problems elsewhere, so an author sees them in one pass", () => {
    const rules = [
      {
        id: "a",
        title: "A",
        severity: "low",
        standard: INVISIBLE,
        category: "Bad",
        escalateWhen: [
          { id: "dup", text: "1." },
          { id: "dup", text: "2." },
        ],
      },
    ];
    const problems = problemsOf(yamlOf({}, { rules, version: "1.0" }));
    expect(problems.map((p) => p.split(":")[0]).sort()).toEqual([
      "rules[0].category",
      "rules[0].escalateWhen[1].id",
      "rules[0].standard",
      "version",
    ]);
  });
});

describe("EscalateWhenSchema", () => {
  it("is exported for tools that read a single condition", () => {
    expect(EscalateWhenSchema.parse({ id: "a-case", text: "A situation." })).toEqual({
      id: "a-case",
      text: "A situation.",
    });
    expect(EscalateWhenSchema.safeParse({ id: "A", text: "A situation." }).success).toBe(false);
    expect(EscalateWhenSchema.safeParse({ id: "a", text: "x", extra: 1 }).success).toBe(false);
  });
});

describe("the new fields do not loosen the rest of the format", () => {
  it("still refuses an absence rule that is required, whatever the new fields hold", () => {
    const problems = problemsOf(
      yamlOf({
        kind: "absence",
        required: true,
        category: "duration",
        fallbackLanguage: "Wording.",
        escalateWhen: [{ id: "a-case", text: "A situation." }],
      }),
    );
    expect(problems).toEqual([
      'rules[0].required: rule "r-1" is an absence rule, which passes when the clause is not there, so it cannot be required',
    ]);
  });

  it("still refuses an unknown key on a rule and on the playbook", () => {
    expect(problemsOf(yamlOf({ fallbacklanguage: "x" })).join("\n")).toMatch(/fallbacklanguage/);
    expect(problemsOf(yamlOf({}, { versions: "1.0.0" })).join("\n")).toMatch(/versions/);
  });

  it("parses a playbook that uses all four fields together", () => {
    const parsed = parsePlaybook(
      yamlOf(
        {
          category: "duration",
          fallbackLanguage: "Obligations continue for three (3) years.",
          escalateWhen: [{ id: "over-five-years", text: "Longer than the fallback." }],
        },
        { version: "1.2.3" },
      ),
    );
    expect(parsed.version).toBe("1.2.3");
    expect(parsed.rules[0]).toMatchObject({
      category: "duration",
      fallbackLanguage: "Obligations continue for three (3) years.",
      escalateWhen: [{ id: "over-five-years", text: "Longer than the fallback." }],
    });
  });
});
