import { createHash } from "node:crypto";
import { PlaybookError } from "@clausewise/playbook";
import { describe, expect, it } from "vitest";
import { CATEGORY_IDS, type PlaybookRuleRecord } from "../../src/contracts.js";
import { findRule, loadPlaybook } from "../../src/playbooks/load.js";
import { loadObject, playbookErrorOf, playbookOf, ruleFor, rulesWith, yamlOf } from "./support.js";

const RECORD_KEYS: (keyof PlaybookRuleRecord)[] = [
  "key",
  "category",
  "title",
  "severity",
  "required",
  "kind",
  "standard",
  "fallback",
  "unacceptable",
  "guidance",
  "fallbackLanguage",
  "escalateWhen",
];

describe("loadPlaybook: mapping a valid playbook", () => {
  it("maps every field of a fully specified rule", () => {
    const loaded = loadObject(
      playbookOf({
        description: "An invented description.",
        rules: rulesWith(
          "duration",
          ruleFor("duration", {
            id: "dur-9",
            title: "Invented duration rule",
            severity: "high",
            required: true,
            kind: "presence",
            standard: "Invented standard.",
            fallback: "Invented fallback.",
            unacceptable: "Invented unacceptable.",
            guidance: "Invented guidance.",
            fallbackLanguage: "Invented approved wording.",
            escalateWhen: [
              { id: "first-case", text: "Invented first condition." },
              { id: "second-case", text: "Invented second condition." },
            ],
          }),
        ),
      }),
    );
    expect(loaded.slug).toBe("test-playbook");
    expect(loaded.name).toBe("Invented test playbook");
    expect(loaded.version).toBe("1.0.0");
    expect(loaded.description).toBe("An invented description.");
    expect(loaded.perspective).toBe("We act for the invented receiving party.");
    expect(findRule(loaded, "dur-9")).toEqual({
      key: "dur-9",
      category: "duration",
      title: "Invented duration rule",
      severity: "high",
      required: true,
      kind: "presence",
      standard: "Invented standard.",
      fallback: "Invented fallback.",
      unacceptable: "Invented unacceptable.",
      guidance: "Invented guidance.",
      fallbackLanguage: "Invented approved wording.",
      escalateWhen: [
        { id: "first-case", text: "Invented first condition." },
        { id: "second-case", text: "Invented second condition." },
      ],
    });
  });

  it("gives every record exactly the contract's fields and no others", () => {
    const loaded = loadObject(playbookOf());
    expect(loaded.rules).toHaveLength(CATEGORY_IDS.length);
    for (const rule of loaded.rules) {
      expect(Object.keys(rule).sort()).toEqual([...RECORD_KEYS].sort());
      for (const item of rule.escalateWhen) expect(Object.keys(item).sort()).toEqual(["id", "text"]);
    }
  });

  it("defaults kind to presence, required to false, absent optional fields to null and escalateWhen to the empty list", () => {
    const loaded = loadObject(
      playbookOf({
        rules: rulesWith("duration", {
          id: "bare",
          category: "duration",
          title: "A bare rule",
          severity: "low",
          standard: "Only the mandatory fields.",
        }),
      }),
    );
    expect(findRule(loaded, "bare")).toEqual({
      key: "bare",
      category: "duration",
      title: "A bare rule",
      severity: "low",
      required: false,
      kind: "presence",
      standard: "Only the mandatory fields.",
      fallback: null,
      unacceptable: null,
      guidance: null,
      fallbackLanguage: null,
      escalateWhen: [],
    });
  });

  it("maps an empty escalateWhen list to the empty list", () => {
    const loaded = loadObject(
      playbookOf({ rules: rulesWith("duration", ruleFor("duration", { escalateWhen: [] })) }),
    );
    expect(findRule(loaded, "rule-duration")?.escalateWhen).toEqual([]);
  });

  it("maps an absent description to null", () => {
    expect(loadObject(playbookOf()).description).toBeNull();
  });

  it("maps an absence rule to kind absence and keeps it optional", () => {
    const loaded = loadObject(
      playbookOf({
        rules: rulesWith(
          "governing-law",
          ruleFor("governing-law", { kind: "absence", required: false }),
        ),
      }),
    );
    const rule = findRule(loaded, "rule-governing-law");
    expect(rule?.kind).toBe("absence");
    expect(rule?.required).toBe(false);
  });

  it("refuses an absence rule that is required, because a contract without the clause passes it", () => {
    const err = playbookErrorOf(() =>
      loadObject(
        playbookOf({
          rules: rulesWith(
            "governing-law",
            ruleFor("governing-law", { kind: "absence", required: true }),
          ),
        }),
      ),
    );
    expect(err.problems.join("\n")).toMatch(/rule-governing-law.*absence rule.*cannot be required/);
  });

  it("keeps the playbook's rule order, and lets a category hold several rules", () => {
    const rules = [
      ruleFor("permitted-disclosures", { id: "z-last-alphabetically" }),
      ...CATEGORY_IDS.map((c) => ruleFor(c)),
    ];
    const loaded = loadObject(playbookOf({ rules }));
    expect(loaded.rules.map((r) => r.key)).toEqual([
      "z-last-alphabetically",
      ...CATEGORY_IDS.map((c) => `rule-${c}`),
    ]);
    expect(loaded.rules.filter((r) => r.category === "permitted-disclosures")).toHaveLength(2);
  });

  it("returns the YAML text exactly as given", () => {
    const yaml = `${yamlOf(playbookOf())}\n# a trailing comment\n`;
    expect(loadPlaybook({ yaml, slug: "test-playbook" }).yaml).toBe(yaml);
  });
});

describe("loadPlaybook: the hash", () => {
  const yaml = yamlOf(playbookOf());
  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

  it("is the SHA-256 of the YAML text, computed independently", () => {
    expect(loadPlaybook({ yaml, slug: "a" }).sha256).toBe(sha(yaml));
  });

  it("is stable across loads and does not depend on the slug or the source label", () => {
    const a = loadPlaybook({ yaml, slug: "first" }).sha256;
    const b = loadPlaybook({ yaml, slug: "second", source: "elsewhere.yaml" }).sha256;
    expect(a).toBe(b);
  });

  it("changes when one character of the text changes", () => {
    const changed = yaml.replace("Standard for duration.", "Standard for duratioN.");
    expect(changed).not.toBe(yaml);
    expect(loadPlaybook({ yaml: changed, slug: "a" }).sha256).not.toBe(
      loadPlaybook({ yaml, slug: "a" }).sha256,
    );
  });

  it("is over the text and not over the parsed rules, so a comment or line ending changes it", () => {
    const base = loadPlaybook({ yaml, slug: "a" });
    const withComment = loadPlaybook({ yaml: `${yaml}\n# reviewed\n`, slug: "a" });
    const withCrlf = loadPlaybook({ yaml: yaml.replaceAll("\n", "\r\n"), slug: "a" });
    expect(withComment.rules).toEqual(base.rules);
    expect(withCrlf.rules).toEqual(base.rules);
    expect(new Set([base.sha256, withComment.sha256, withCrlf.sha256]).size).toBe(3);
  });
});

describe("loadPlaybook: what it refuses", () => {
  it("requires a version and says so", () => {
    const err = playbookErrorOf(() => loadObject(playbookOf({ version: undefined })));
    expect(err.problems).toHaveLength(1);
    expect(err.problems[0]).toMatch(/^version: required/);
    expect(err.message).toMatch(/version: required/);
  });

  it("refuses a malformed version through the base format", () => {
    for (const version of ["1.0", "v1.0.0", "1.0.0-rc1", "one", ""]) {
      const err = playbookErrorOf(() => loadObject(playbookOf({ version })));
      expect(err.problems.join("\n"), version).toMatch(/^version:/m);
    }
    // 1.0 unquoted in YAML is the number one, not a version string.
    const bare = yamlOf(playbookOf({ version: undefined })).replace("{", '{\n  "version": 1.0,');
    expect(playbookErrorOf(() => loadPlaybook({ yaml: bare, slug: "a" })).problems.join("\n")).toMatch(
      /^version:/m,
    );
  });

  it("requires a category on every rule and names the rule", () => {
    const err = playbookErrorOf(() =>
      loadObject(playbookOf({ rules: rulesWith("duration", ruleFor("duration", { category: undefined })) })),
    );
    const durIndex = CATEGORY_IDS.indexOf("duration");
    expect(err.problems).toContainEqual(
      expect.stringMatching(new RegExp(`^rules\\[${durIndex}\\]\\.category: rule "rule-duration" has no category`)),
    );
    // The rule was the only one for its category, so the category is also uncovered.
    expect(err.problems).toContainEqual(
      expect.stringContaining('no rule covers the category "duration"'),
    );
  });

  it("refuses a category that is not one of the seven and names it", () => {
    const err = playbookErrorOf(() =>
      loadObject(playbookOf({ rules: rulesWith("duration", ruleFor("duration", { category: "dration" })) })),
    );
    expect(err.problems.join("\n")).toMatch(
      /rules\[\d+\]\.category: rule "rule-duration" has the unknown category "dration"; use one of parties,/,
    );
    expect(err.problems).toContainEqual(
      expect.stringContaining('no rule covers the category "duration"'),
    );
  });

  it("cuts a very long unknown category in the message", () => {
    const long = "x".repeat(500);
    const err = playbookErrorOf(() =>
      loadObject(playbookOf({ rules: rulesWith("duration", ruleFor("duration", { category: long })) })),
    );
    expect(err.message).not.toContain("x".repeat(100));
    expect(err.message).toContain("xxx...");
  });

  it("refuses a category written in the wrong form through the base format", () => {
    for (const category of ["Duration", "ci_definition", ""]) {
      const err = playbookErrorOf(() =>
        loadObject(playbookOf({ rules: rulesWith("duration", ruleFor("duration", { category })) })),
      );
      expect(err.problems.join("\n"), category).toMatch(/\.category:/);
    }
  });

  it("requires every category to have a rule and lists each one that has none", () => {
    const rules = CATEGORY_IDS.filter((c) => c !== "return-destruction" && c !== "exclusions").map(
      (c) => ruleFor(c),
    );
    const err = playbookErrorOf(() => loadObject(playbookOf({ rules })));
    expect(err.problems).toEqual([
      'rules: no rule covers the category "exclusions"; every category needs one',
      'rules: no rule covers the category "return-destruction"; every category needs one',
    ]);
  });

  it("accepts a playbook whose only extra rules repeat a covered category", () => {
    const rules = [...CATEGORY_IDS.map((c) => ruleFor(c)), ruleFor("parties", { id: "pty-2" })];
    expect(loadObject(playbookOf({ rules })).rules).toHaveLength(8);
  });

  it("refuses a duplicate escalateWhen id in one rule and names it", () => {
    const err = playbookErrorOf(() =>
      loadObject(
        playbookOf({
          rules: rulesWith(
            "duration",
            ruleFor("duration", {
              escalateWhen: [
                { id: "same-case", text: "First wording." },
                { id: "same-case", text: "Second wording." },
              ],
            }),
          ),
        }),
      ),
    );
    expect(err.problems).toContainEqual(
      expect.stringContaining('duplicate escalateWhen id "same-case" in rule "rule-duration"'),
    );
  });

  it("refuses a duplicate rule id", () => {
    const rules = [...CATEGORY_IDS.map((c) => ruleFor(c)), ruleFor("parties")];
    const err = playbookErrorOf(() => loadObject(playbookOf({ rules })));
    expect(err.problems.join("\n")).toMatch(/duplicate rule id "rule-parties"/);
  });

  // Characters that draw nothing, written as escapes so that this file stays plain ASCII.
  const INVISIBLE = "​‍ ­⠀";
  it.each([
    ["standard", (v: string) => ruleFor("duration", { standard: v }), /rules\[\d+\]\.standard:/],
    ["title", (v: string) => ruleFor("duration", { title: v }), /rules\[\d+\]\.title:/],
    [
      "fallbackLanguage",
      (v: string) => ruleFor("duration", { fallbackLanguage: v }),
      /rules\[\d+\]\.fallbackLanguage:/,
    ],
    [
      "escalateWhen text",
      (v: string) => ruleFor("duration", { escalateWhen: [{ id: "case", text: v }] }),
      /rules\[\d+\]\.escalateWhen\[0\]\.text:/,
    ],
  ])("refuses a %s that holds only invisible characters", (_label, build, expected) => {
    const err = playbookErrorOf(() =>
      loadObject(playbookOf({ rules: rulesWith("duration", build(INVISIBLE)) })),
    );
    expect(err.problems.join("\n")).toMatch(expected);
    expect(err.problems.join("\n")).toMatch(/visible character/);
  });

  it("refuses text that is not YAML, an empty document and a document that is not a mapping", () => {
    expect(() => loadPlaybook({ yaml: "name: [unclosed", slug: "a" })).toThrow(/not valid YAML/);
    expect(() => loadPlaybook({ yaml: "", slug: "a" })).toThrow(PlaybookError);
    expect(() => loadPlaybook({ yaml: "- one\n- two\n", slug: "a" })).toThrow(PlaybookError);
  });

  it("refuses an unknown key, so that a misspelt optional field is not silently dropped", () => {
    const misspelt = playbookOf({ rules: rulesWith("duration", ruleFor("duration", { fallbacklanguage: "x" })) });
    expect(playbookErrorOf(() => loadObject(misspelt)).problems.join("\n")).toMatch(/fallbacklanguage/);
    const topLevel = playbookOf({ versoin: "1.0.0" });
    expect(playbookErrorOf(() => loadObject(topLevel)).problems.join("\n")).toMatch(/versoin/);
  });

  it("lists every Parol problem at once, so an author fixes the file in one pass", () => {
    const rules = [
      ruleFor("parties", { category: undefined }),
      ruleFor("ci-definition", { category: "ci-defintion" }),
      ruleFor("exclusions"),
      ruleFor("duration"),
    ];
    const err = playbookErrorOf(() => loadObject(playbookOf({ version: undefined, rules })));
    expect(err.problems).toEqual([
      expect.stringMatching(/^version: required/),
      expect.stringMatching(/^rules\[0\]\.category: rule "rule-parties" has no category/),
      expect.stringMatching(/^rules\[1\]\.category: .*unknown category "ci-defintion"/),
      'rules: no rule covers the category "parties"; every category needs one',
      'rules: no rule covers the category "ci-definition"; every category needs one',
      'rules: no rule covers the category "permitted-disclosures"; every category needs one',
      'rules: no rule covers the category "return-destruction"; every category needs one',
      'rules: no rule covers the category "governing-law"; every category needs one',
    ]);
    for (const problem of err.problems) expect(err.message).toContain(problem);
  });

  it("names the source in the message, and falls back to the slug", () => {
    const bad = playbookOf({ version: undefined });
    expect(playbookErrorOf(() => loadObject(bad, "uploads/draft.yaml")).message).toMatch(
      /^uploads\/draft\.yaml is not a valid Parol playbook:/,
    );
    expect(playbookErrorOf(() => loadObject(bad)).message).toMatch(
      /^test-playbook is not a valid Parol playbook:/,
    );
    const baseFailure = yamlOf({ name: "x" });
    expect(
      playbookErrorOf(() => loadPlaybook({ yaml: baseFailure, slug: "s", source: "p.yaml" })).message,
    ).toMatch(/^p\.yaml is invalid:/);
  });

  it("never puts the text of a rule in an error, whichever check fails", () => {
    const secret = "SECRET-NEGOTIATING-POSITION";
    const rules = (extra: Record<string, unknown>) =>
      rulesWith(
        "duration",
        ruleFor("duration", {
          standard: secret,
          fallback: secret,
          unacceptable: secret,
          guidance: secret,
          fallbackLanguage: secret,
          escalateWhen: [{ id: "case", text: secret }],
          ...extra,
        }),
      );
    const failures: unknown[] = [
      playbookOf({ version: undefined, rules: rules({ category: "no-such-category" }) }),
      playbookOf({ rules: rules({ category: undefined }) }),
      playbookOf({ version: "not-a-version", rules: rules({}) }),
      playbookOf({ rules: rules({ severity: "critical" }) }),
      playbookOf({ rules: rules({ escalateWhen: [{ id: "a", text: secret }, { id: "a", text: secret }] }) }),
    ];
    for (const failure of failures) {
      const err = playbookErrorOf(() => loadObject(failure));
      expect(err.message).not.toContain(secret);
      expect(err.problems.join("\n")).not.toContain(secret);
    }
  });
});

describe("findRule", () => {
  const loaded = loadObject(playbookOf());

  it("finds a rule by its key", () => {
    expect(findRule(loaded, "rule-duration")).toBe(loaded.rules[CATEGORY_IDS.indexOf("duration")]);
  });

  it("returns undefined for an unknown key and compares keys exactly", () => {
    expect(findRule(loaded, "rule-nothing")).toBeUndefined();
    expect(findRule(loaded, "RULE-DURATION")).toBeUndefined();
    expect(findRule(loaded, " rule-duration")).toBeUndefined();
    expect(findRule(loaded, "")).toBeUndefined();
  });

  it("does not mistake an inherited object property for a rule", () => {
    for (const key of ["constructor", "__proto__", "toString", "length"]) {
      expect(findRule(loaded, key), key).toBeUndefined();
    }
  });
});
