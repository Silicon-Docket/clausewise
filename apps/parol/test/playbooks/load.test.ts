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
  "hintTopics",
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
      hintTopics: [],
    });
  });

  it("gives every record exactly the contract's fields and no others", () => {
    const loaded = loadObject(playbookOf());
    expect(loaded.rules).toHaveLength(CATEGORY_IDS.length);
    for (const rule of loaded.rules) {
      expect(Object.keys(rule).sort()).toEqual([...RECORD_KEYS].sort());
      for (const item of rule.escalateWhen)
        expect(Object.keys(item).sort()).toEqual(["id", "text"]);
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
      hintTopics: [],
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
    expect(
      playbookErrorOf(() => loadPlaybook({ yaml: bare, slug: "a" })).problems.join("\n"),
    ).toMatch(/^version:/m);
  });

  it("requires a category on every rule and names the rule", () => {
    const err = playbookErrorOf(() =>
      loadObject(
        playbookOf({ rules: rulesWith("duration", ruleFor("duration", { category: undefined })) }),
      ),
    );
    const durIndex = CATEGORY_IDS.indexOf("duration");
    expect(err.problems).toContainEqual(
      expect.stringMatching(
        new RegExp(`^rules\\[${durIndex}\\]\\.category: rule "rule-duration" has no category`),
      ),
    );
    // The rule was the only one for its category, so the category is also uncovered.
    expect(err.problems).toContainEqual(
      expect.stringContaining('no rule covers the category "duration"'),
    );
  });

  it("refuses a category that is not one of the seven and names it", () => {
    const err = playbookErrorOf(() =>
      loadObject(
        playbookOf({ rules: rulesWith("duration", ruleFor("duration", { category: "dration" })) }),
      ),
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
      loadObject(
        playbookOf({ rules: rulesWith("duration", ruleFor("duration", { category: long })) }),
      ),
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
  const INVISIBLE = "\u200b\u200d \u00ad\u2800";
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
    const misspelt = playbookOf({
      rules: rulesWith("duration", ruleFor("duration", { fallbacklanguage: "x" })),
    });
    expect(playbookErrorOf(() => loadObject(misspelt)).problems.join("\n")).toMatch(
      /fallbacklanguage/,
    );
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
      playbookErrorOf(() => loadPlaybook({ yaml: baseFailure, slug: "s", source: "p.yaml" }))
        .message,
    ).toMatch(/^p\.yaml is invalid:/);
  });

  it("keeps only the position of a YAML syntax error, never a line of the file", () => {
    // A file saved as .yaml by mistake must not have its own text echoed into an error message.
    const secret = "SECRET-LINE-OF-A-CONTRACT";
    const cases = [
      `name: x\nrules:\n  - standard: ${secret}: still: wrong\n`,
      `name: [${secret}`,
      `name: x\nperspective: *${secret}\n`,
      `name: x\n\ttab: ${secret}\n`,
    ];
    for (const yaml of cases) {
      const err = playbookErrorOf(() => loadPlaybook({ yaml, slug: "a", source: "up.yaml" }));
      expect(err.message, yaml).not.toContain(secret);
      expect(err.problems.join("\n"), yaml).not.toContain(secret);
      expect(err.message, yaml).toMatch(/^up\.yaml is not valid YAML( at line \d+, column \d+)?$/);
      expect(err.problems, yaml).toHaveLength(1);
      expect(err.problems[0], yaml).toMatch(/^\(root\): not valid YAML/);
    }
    const located = playbookErrorOf(() =>
      loadPlaybook({ yaml: "name: x\nrules:\n  - id: [unclosed\n", slug: "a", source: "up.yaml" }),
    );
    expect(located.message).toMatch(/^up\.yaml is not valid YAML at line \d+, column \d+$/);
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
      playbookOf({
        rules: rules({
          escalateWhen: [
            { id: "a", text: secret },
            { id: "a", text: secret },
          ],
        }),
      }),
    ];
    for (const failure of failures) {
      const err = playbookErrorOf(() => loadObject(failure));
      expect(err.message).not.toContain(secret);
      expect(err.problems.join("\n")).not.toContain(secret);
    }
  });
});

describe("loadPlaybook: what the store would refuse", () => {
  // importPlaybookDraft refuses a rule key over 64 characters, a version over 32 and YAML over
  // 1,000,000 characters. store-import.test.ts checks the loader's limits against the store itself.
  const withRuleId = (id: string) =>
    playbookOf({ rules: rulesWith("parties", ruleFor("parties", { id })) });

  it("accepts a rule id of 64 characters and refuses one of 65, naming the rule's position", () => {
    const id = "x".repeat(64);
    expect(loadObject(withRuleId(id)).rules[0]?.key).toBe(id);
    const err = playbookErrorOf(() => loadObject(withRuleId("x".repeat(65))));
    expect(err.problems).toEqual([
      expect.stringMatching(/^rules\[0\]\.id: .*65 characters.*the limit is 64$/),
    ]);
  });

  it("accepts a version of 32 characters and refuses one of 33", () => {
    const longest = "1234567890.1234567890.1234567890";
    expect(longest).toHaveLength(32);
    expect(loadObject(playbookOf({ version: longest })).version).toBe(longest);
    const err = playbookErrorOf(() =>
      loadObject(playbookOf({ version: "1234567890.1234567890.12345678901" })),
    );
    expect(err.problems).toEqual([
      expect.stringMatching(/^version: .*33 characters.*the limit is 32$/),
    ]);
  });

  it("accepts YAML of 1,000,000 characters and refuses 1,000,001, without echoing it", () => {
    const head = `${yamlOf(playbookOf())}\n#`;
    const padded = (length: number) => head + "x".repeat(length - head.length);
    expect(loadPlaybook({ yaml: padded(1_000_000), slug: "big" }).version).toBe("1.0.0");
    const err = playbookErrorOf(() => loadPlaybook({ yaml: padded(1_000_001), slug: "big" }));
    expect(err.problems).toEqual(["(root): the YAML is 1000001 characters; the limit is 1000000"]);
    expect(err.message).not.toContain("xxxxxxxxxx");
  });

  it("checks the size before parsing, so text that is not YAML at all is refused for its size", () => {
    const err = playbookErrorOf(() => loadPlaybook({ yaml: "[".repeat(1_000_001), slug: "big" }));
    expect(err.problems).toEqual(["(root): the YAML is 1000001 characters; the limit is 1000000"]);
  });

  it("reports the length problems together with the other Parol problems", () => {
    const err = playbookErrorOf(() =>
      loadObject(
        playbookOf({
          version: "1234567890.1234567890.12345678901",
          rules: rulesWith("parties", ruleFor("parties", { id: "x".repeat(65), category: "nope" })),
        }),
      ),
    );
    expect(err.problems.map((p) => p.split(":")[0])).toEqual([
      "version",
      "rules[0].id",
      "rules[0].category",
      "rules",
    ]);
  });
});

describe("loadPlaybook: the form of a version", () => {
  it("refuses a leading zero in any part, because 1.0.0 and 01.0.0 would be two versions of one playbook", () => {
    for (const version of ["01.0.0", "1.00.0", "1.0.00", "00.0.0", "01.00.000"]) {
      const err = playbookErrorOf(() => loadObject(playbookOf({ version })));
      expect(err.problems, version).toEqual([expect.stringMatching(/^version: .*leading zero/)]);
    }
  });

  it("accepts zero itself and numbers with a zero inside", () => {
    for (const version of ["0.0.0", "0.10.0", "10.0.100", "1.20.3", "100.200.300"]) {
      expect(loadObject(playbookOf({ version })).version, version).toBe(version);
    }
  });
});

describe("loadPlaybook: text from the file in an error", () => {
  const secret = "SECRET-CLAUSE-TEXT";
  const sentence = `The Receiving Party shall keep ${secret} confidential for three years`;
  const invalidKey = 'The key is a sentence, with commas and "quotes" in it';

  /** A valid playbook with one extra member on the top level, a rule or an escalation item. */
  const withExtra = (where: "top" | "rule" | "item", key: string) => {
    if (where === "top") return playbookOf({ [key]: "x" });
    const item = where === "item";
    return playbookOf({
      rules: rulesWith(
        "duration",
        ruleFor("duration", {
          ...(item
            ? { escalateWhen: [{ id: "case", text: "A case.", [key]: "x" }] }
            : { [key]: "x" }),
        }),
      ),
    });
  };

  it("does not echo an unrecognised key that is not a short plain word, such as a line of a contract", () => {
    // A contract saved as .yaml reads as a mapping whose first key is a line up to its first colon.
    const err = playbookErrorOf(() =>
      loadPlaybook({ yaml: `${sentence}: yes\nname: x\n`, slug: "p", source: "up.yaml" }),
    );
    expect(err.message).not.toContain(secret);
    expect(err.problems.join("\n")).not.toContain(secret);
    expect(err.problems).toContainEqual(expect.stringMatching(/^\(root\): Unrecognized key/));
    for (const where of ["top", "rule", "item"] as const) {
      for (const key of [sentence, invalidKey, `${secret}\nsecond line`, "a".repeat(200)]) {
        const failure = playbookErrorOf(() => loadObject(withExtra(where, key)));
        const shown = `${failure.message}\n${failure.problems.join("\n")}`;
        expect(shown, `${where}: ${key.slice(0, 20)}`).not.toContain(secret);
        expect(shown, `${where}: ${key.slice(0, 20)}`).not.toContain("quotes");
        expect(shown, `${where}: ${key.slice(0, 20)}`).not.toContain("aaaaaaaaaa");
        expect(failure.problems).toHaveLength(1);
        expect(failure.problems[0]).toMatch(/^[\w[\].()]+: Unrecognized key/);
      }
    }
  });

  it("still names a short plain word that is a misspelling, in the right place", () => {
    const rule = playbookErrorOf(() => loadObject(withExtra("rule", "fallbacklanguage")));
    expect(rule.problems).toEqual(['rules[4]: Unrecognized key: "fallbacklanguage"']);
    const top = playbookErrorOf(() => loadObject(withExtra("top", "versoin")));
    expect(top.problems).toEqual(['(root): Unrecognized key: "versoin"']);
    const item = playbookErrorOf(() => loadObject(withExtra("item", "txt")));
    expect(item.problems).toEqual(['rules[4].escalateWhen[0]: Unrecognized key: "txt"']);
  });

  it("hides every name when one of several unrecognised keys is not a plain word", () => {
    const err = playbookErrorOf(() =>
      loadObject(playbookOf({ versoin: "1", [sentence]: "x", another: "y" })),
    );
    expect(`${err.message}${err.problems.join("")}`).not.toContain(secret);
    expect(err.problems).toHaveLength(1);
    expect(err.problems[0]).toMatch(/^\(root\): Unrecognized keys/);
  });

  it("does not echo a rule id or an escalation id that fails the id format", () => {
    const bad = `${secret} not an id`;
    const rules = (over: Record<string, unknown>[]) => [
      ...CATEGORY_IDS.map((c) => ruleFor(c)),
      ...over.map((o) => ruleFor("parties", o)),
    ];
    const failures = [
      // Two rules with the same id that is not an id.
      rules([{ id: bad }, { id: bad }]),
      // An absence rule that is required, with an id that is not an id.
      rules([{ id: bad, kind: "absence", required: true }]),
      // A repeated escalation id that is not an id.
      rules([
        {
          id: "extra",
          escalateWhen: [
            { id: bad, text: "One." },
            { id: bad, text: "Two." },
          ],
        },
      ]),
      // A repeated escalation id inside a rule whose own id is not an id.
      rules([
        {
          id: bad,
          escalateWhen: [
            { id: "same", text: "One." },
            { id: "same", text: "Two." },
          ],
        },
      ]),
    ];
    for (const failure of failures) {
      const err = playbookErrorOf(() => loadObject(playbookOf({ rules: failure })));
      expect(`${err.message}\n${err.problems.join("\n")}`).not.toContain(secret);
      expect(err.problems.length).toBeGreaterThan(0);
    }
  });

  it("still names a well-formed id in a duplicate or an absence-rule problem", () => {
    const dupRule = playbookErrorOf(() =>
      loadObject(
        playbookOf({ rules: [...CATEGORY_IDS.map((c) => ruleFor(c)), ruleFor("parties")] }),
      ),
    );
    expect(dupRule.problems).toEqual(['rules[7].id: duplicate rule id "rule-parties"']);
    const dupItem = playbookErrorOf(() =>
      loadObject(
        playbookOf({
          rules: rulesWith(
            "duration",
            ruleFor("duration", {
              escalateWhen: [
                { id: "same-case", text: "One." },
                { id: "same-case", text: "Two." },
              ],
            }),
          ),
        }),
      ),
    );
    expect(dupItem.problems).toEqual([
      'rules[4].escalateWhen[1].id: duplicate escalateWhen id "same-case" in rule "rule-duration"',
    ]);
    const absent = playbookErrorOf(() =>
      loadObject(
        playbookOf({
          rules: rulesWith("duration", ruleFor("duration", { kind: "absence", required: true })),
        }),
      ),
    );
    expect(absent.problems).toEqual([
      'rules[4].required: rule "rule-duration" is an absence rule, which passes when the clause is not there, so it cannot be required',
    ]);
  });

  it("tells the author that the Parol checks follow when the base format is violated", () => {
    // The base format stops the load before the version, the categories and their coverage are
    // looked at, so the message says they are still to come.
    const err = playbookErrorOf(() =>
      loadObject(
        playbookOf({
          version: undefined,
          rules: rulesWith("duration", ruleFor("duration", { severity: "critical" })),
        }),
      ),
    );
    expect(err.problems).toHaveLength(1);
    expect(err.problems[0]).toMatch(/^rules\[4\]\.severity:/);
    expect(err.message).toMatch(
      /\n {2}The version, a category on every rule and the coverage of all seven categories are checked once these are fixed\.$/,
    );
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
