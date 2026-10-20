import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlaybookError, parsePlaybook } from "../src/index.js";

const here = import.meta.dirname;
const repoRoot = join(here, "..", "..", "..");

// The server parses playbook text from whoever can reach it, so parsePlaybook has to refuse
// the YAML features that cost more than they say, or that mean more than text.

const valid = `name: Test playbook
contractTypes: [nda]
perspective: We are the receiving party.
rules:
  - id: term
    title: Term
    severity: high
    required: true
    standard: No more than three years.
  - id: law
    title: Governing law
    severity: low
    standard: A US state we operate in.
`;

function failure(text: string): PlaybookError {
  try {
    parsePlaybook(text, "test.yaml");
  } catch (err) {
    expect(err).toBeInstanceOf(PlaybookError);
    return err as PlaybookError;
  }
  throw new Error("expected parsePlaybook to throw");
}

/** Throws PlaybookError, and says how long it took. */
function timedFailure(text: string): { error: PlaybookError; ms: number } {
  const started = performance.now();
  const error = failure(text);
  return { error, ms: performance.now() - started };
}

// A second is far more than these take (a few milliseconds), and far less than any expansion.
const QUICK_MS = 1000;

describe("a YAML alias bomb", () => {
  /**
   * The "billion laughs" shape: the first list holds `width` strings, and each later list holds
   * `width` references to the list before it. The text stays small, and expanded it is
   * width^levels strings.
   */
  function aliasBomb(levels: number, width: number): { text: string; expandedChars: number } {
    const lines = [`lol0: &a0 [${Array.from({ length: width }, () => '"lol"').join(", ")}]`];
    for (let level = 1; level < levels; level++) {
      const refs = Array.from({ length: width }, () => `*a${level - 1}`).join(", ");
      lines.push(`lol${level}: &a${level} [${refs}]`);
    }
    return { text: lines.join("\n"), expandedChars: width ** levels * "lol".length };
  }

  it("is refused in milliseconds, with the bomb far smaller than what it would expand to", () => {
    const { text, expandedChars } = aliasBomb(9, 9);
    // Small enough to send in one request, and a gigabyte if it were expanded.
    expect(text.length).toBeLessThan(1000);
    expect(expandedChars).toBeGreaterThan(1_000_000_000);

    const { error, ms } = timedFailure(`${valid}${text}\n`);
    expect(ms).toBeLessThan(QUICK_MS);
    expect(error.message).toMatch(/^test\.yaml is not valid YAML: line \d+: an alias/);
    expect(error.problems).toHaveLength(1);
  });

  it("is refused whatever the shape, narrow or wide", () => {
    for (const [levels, width] of [
      [20, 2],
      [3, 40],
      [2, 400],
    ] as const) {
      const { text } = aliasBomb(levels, width);
      const { ms } = timedFailure(`${valid}${text}\n`);
      expect(ms, `${levels} levels of ${width}`).toBeLessThan(QUICK_MS);
    }
  });

  it("is refused when the root of the document is the bomb", () => {
    const { text } = aliasBomb(9, 9);
    const { ms } = timedFailure(text);
    expect(ms).toBeLessThan(QUICK_MS);
  });

  it("is refused as a chain of lists that each hold the one before, which would overflow the stack", () => {
    const lines = ["c0: &c0 [x]"];
    for (let i = 1; i < 3000; i++) lines.push(`c${i}: &c${i} [*c${i - 1}]`);
    const { error, ms } = timedFailure(`${valid}${lines.join("\n")}\n`);
    expect(ms).toBeLessThan(QUICK_MS);
    expect(error.message).toMatch(/an alias/);
  });

  it("is refused even when it uses one alias, because a playbook can write a sentence twice", () => {
    // This is a valid playbook but for the alias.
    const text = valid.replace(
      "    standard: A US state we operate in.",
      "    standard: &s A US state we operate in.\n    guidance: *s",
    );
    expect(parsePlaybook(text.replace("&s ", "").replace("*s", "x")).rules).toHaveLength(2);
    const error = failure(text);
    expect(error.message).toMatch(/^test\.yaml is not valid YAML: line 14: an alias \(\*name\)/);
  });

  it("does not refuse an anchor that nothing refers to, which expands to nothing", () => {
    const text = valid.replace("standard: No more", "standard: &note No more");
    expect(parsePlaybook(text).rules[0]?.standard).toBe("No more than three years.");
  });
});

describe("a YAML merge key", () => {
  // A merge key is an alias by another name: the mapping it names is copied in, once for each
  // time it is listed, and a mapping that merges others can itself be merged.
  function mergeBomb(levels: number, width: number): string {
    const lines = ["m0: &m0 {k0: 1, k1: 2}"];
    for (let level = 1; level < levels; level++) {
      const refs = Array.from({ length: width }, () => `*m${level - 1}`).join(", ");
      lines.push(`m${level}: &m${level} {<<: [${refs}], own${level}: 1}`);
    }
    return lines.join("\n");
  }

  it("bomb is refused in milliseconds", () => {
    const { error, ms } = timedFailure(`${valid}${mergeBomb(12, 9)}\n`);
    expect(ms).toBeLessThan(QUICK_MS);
    expect(error.message).toMatch(/not valid YAML/);
  });

  it("is not merged, so a merge cannot add what the playbook does not spell out", () => {
    // The merge key is written with a mapping and no alias, which is the case the alias check
    // cannot see. Merged, this would be a valid playbook.
    const text = valid.replace(
      "    title: Governing law\n    severity: low\n",
      "    title: Governing law\n    <<: {severity: low}\n",
    );
    const { problems } = failure(text);
    expect(problems.join("\n")).toMatch(/Unrecognized key.*<</);
    expect(problems.join("\n")).toMatch(/severity/);
  });

  it("is not merged either when the document asks for YAML 1.1, which turns merge keys on", () => {
    const text = `%YAML 1.1\n---\n${valid.replace(
      "    title: Governing law\n    severity: low\n",
      "    title: Governing law\n    <<: {severity: low}\n",
    )}`;
    const { problems } = failure(text);
    expect(problems.join("\n")).toMatch(/Unrecognized key.*<</);
  });
});

describe("the YAML schema", () => {
  it("is the core one, so yes is text and not true, even when the document asks for YAML 1.1", () => {
    const withYes = valid.replace("required: true", "required: yes");
    for (const text of [withYes, `%YAML 1.1\n---\n${withYes}`]) {
      expect(failure(text).problems).toContain(
        "rules[0].required: Invalid input: expected boolean, received string",
      );
    }
  });

  it("reads true and false as booleans", () => {
    expect(parsePlaybook(valid).rules[0]?.required).toBe(true);
  });
});

describe("a YAML tag", () => {
  const withName = (name: string): string => valid.replace("name: Test playbook", `name: ${name}`);

  it("!!js/function is refused and its code never runs", () => {
    const sentinel = "__clausewiseTagRan";
    const text = withName(`!!js/function "function () { globalThis.${sentinel} = true; }"`);
    const error = failure(text);
    expect(error.message).toMatch(
      /^test\.yaml is not valid YAML: line 1: the tag !!js\/function is not allowed/,
    );
    expect((globalThis as Record<string, unknown>)[sentinel]).toBeUndefined();
  });

  it.each([
    ["!!binary", "!!binary aGVsbG8="],
    ["!!set", "!!set {a, b}"],
    ["!!timestamp", "!!timestamp 2020-01-01"],
    ["!!omap", "!!omap [a: 1]"],
    ["!!int", "!!int 12"],
    ["!!str", "!!str Test playbook"],
    ["!custom", "!custom Test playbook"],
    ["!!python/object:os.system", "!!python/object:os.system Test playbook"],
  ])("%s is refused, so it can never stand where text is needed", (tag, value) => {
    const error = failure(withName(value));
    expect(error.message).toContain(`the tag ${tag} is not allowed`);
    expect(error.problems).toHaveLength(1);
  });

  it("is refused in its verbatim form, which names the same tag", () => {
    const error = failure(withName("!<tag:yaml.org,2002:binary> aGVsbG8="));
    expect(error.message).toContain("the tag !!binary is not allowed");
  });

  it("is refused on a key, on a list and on a mapping, with the line the tagged value begins on", () => {
    expect(
      failure(valid.replace("contractTypes: [nda]", "contractTypes: !!set [nda]")).message,
    ).toMatch(/line 2: the tag !!set/);
    // The tag is on line 4 and the list it tags begins on line 5.
    expect(failure(valid.replace("rules:\n", "rules: !!seq\n")).message).toMatch(
      /line 5: the tag !!seq/,
    );
    expect(failure(valid.replace("  - id: law", "  - !!map\n    id: law")).message).toMatch(
      /the tag !!map is not allowed/,
    );
    expect(failure(valid.replace("    severity: low", "    !!str severity: low")).message).toMatch(
      /line 12: the tag !!str/,
    );
  });

  it("is refused through a %TAG directive that gives it another name", () => {
    const text = `%TAG !e! tag:example.com,2000:\n---\n${withName("!e!thing Test playbook")}`;
    expect(failure(text).message).toContain("tag:example.com,2000:thing");
  });

  it("is named briefly even when it is very long", () => {
    const error = failure(withName(`!${"x".repeat(5000)} Test playbook`));
    expect(error.message.length).toBeLessThan(500);
  });

  it("is not mistaken for an exclamation mark in text", () => {
    const text = valid
      .replace("name: Test playbook", 'name: "!!binary is only a word here"')
      .replace(
        "standard: No more than three years.",
        "standard: Mind the !important flag, and !!this.",
      );
    const playbook = parsePlaybook(text);
    expect(playbook.name).toBe("!!binary is only a word here");
    expect(playbook.rules[0]?.standard).toBe("Mind the !important flag, and !!this.");
  });
});

describe("a key that is written twice", () => {
  const message = (text: string): string => failure(text).message;

  it("is an error at the top of the document, with the line of the second one", () => {
    expect(message(`${valid}name: Another\n`)).toMatch(
      /^test\.yaml is not valid YAML: line 14: the key "name" is written twice in one mapping/,
    );
  });

  it("is an error inside a rule, where the last one would otherwise win", () => {
    expect(
      message(valid.replace("    severity: high\n", "    severity: high\n    severity: low\n")),
    ).toMatch(/line 8: the key "severity" is written twice/);
  });

  it("is an error whatever the quoting of the two", () => {
    expect(
      message(valid.replace("name: Test playbook", 'name: Test playbook\n"name": Other')),
    ).toMatch(/the key "name" is written twice/);
  });

  it("is an error in a mapping written in braces", () => {
    expect(message(`${valid}extra: {a: 1, b: 2, a: 3}\n`)).toMatch(/the key "a" is written twice/);
  });

  it("is an error when one is a number and the other the same digits as text, which read as one key", () => {
    expect(message(`${valid}1: one\n"1": other\n`)).toMatch(/the key "1" is written twice/);
  });

  it("is not an error when two different mappings use the same key", () => {
    // Every rule has an id and a title, and so has the next.
    expect(parsePlaybook(valid).rules.map((rule) => rule.title)).toEqual(["Term", "Governing law"]);
  });

  it("names a very long key briefly", () => {
    const key = "k".repeat(5000);
    expect(message(`${valid}${key}: 1\n${key}: 2\n`).length).toBeLessThan(400);
  });

  it("is found in a mapping of many keys without the quadratic cost of comparing each with all", () => {
    // The YAML library's own check takes about eight seconds for these 20,000 keys. Here they are
    // all different, so the error is the schema's, but the time is what is measured.
    const keys = Array.from({ length: 20_000 }, (_, i) => `key${i}: v`).join("\n");
    const { error, ms } = timedFailure(`${valid}${keys}\n`);
    expect(ms).toBeLessThan(3000);
    expect(error.problems.join("\n")).toMatch(/Unrecognized keys/);
    // And with a repeat at the very end of them.
    const { error: repeated } = timedFailure(`${valid}${keys}\nkey0: again\n`);
    expect(repeated.message).toMatch(/the key "key0" is written twice/);
  });
});

describe("nesting", () => {
  const nested = (depth: number): string =>
    `${valid}extra: ${"[".repeat(depth)}${"]".repeat(depth)}\n`;

  it("is refused when it is deeper than a playbook can be, in every shape", () => {
    const shapes: [string, string][] = [
      ["flow lists", nested(1000)],
      ["flow mappings", `${valid}extra: ${"{a: ".repeat(1000)}1${"}".repeat(1000)}\n`],
      ["a chain of dashes", `${valid}extra:\n  ${"- ".repeat(1000)}x\n`],
      [
        "indented mappings",
        `${valid}${Array.from({ length: 300 }, (_, i) => `${" ".repeat(i)}k${i}:`).join("\n")}\n`,
      ],
      ["brackets never closed", `${valid}extra: ${"[".repeat(2000)}\n`],
    ];
    for (const [shape, text] of shapes) {
      const { error, ms } = timedFailure(text);
      expect(ms, shape).toBeLessThan(QUICK_MS);
      expect(error.message, shape).toMatch(
        /^test\.yaml is not valid YAML: the document is nested more than \d+ levels deep/,
      );
    }
  });

  it("does not kill the process, which a document too deep for the stack otherwise does", () => {
    // Without the depth check the first of these overflows the stack inside the YAML library, and
    // a later call then ends the whole process with an out of memory error. So it runs in a
    // process of its own, where that is a failed test and not a dead test runner.
    const child = spawnSync(
      join(repoRoot, "node_modules", ".bin", "tsx"),
      [join(here, "hardening-child.ts"), "3000", "6"],
      { encoding: "utf8", timeout: 120_000, cwd: repoRoot },
    );
    expect(child.status, child.stderr.slice(0, 500)).toBe(0);
    expect(JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "")).toEqual({
      refused: 6,
      name: "Test playbook",
    });
  });

  it("is not refused at a depth that is only unusual", () => {
    // Too deep for a playbook to hold, but not for the reader: the schema reports it instead.
    const error = failure(nested(30));
    expect(error.message).not.toMatch(/nested more than/);
    expect(error.problems.join("\n")).toMatch(/Unrecognized key/);
  });
});

describe("other input", () => {
  it("a key called __proto__ is only an unknown key, and pollutes nothing", () => {
    const error = failure(`${valid}__proto__: {polluted: true}\n`);
    expect(error.problems.join("\n")).toMatch(/Unrecognized key.*__proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("two documents in one text are refused", () => {
    expect(failure(`${valid}---\n${valid}`).message).toMatch(/multiple documents/);
  });

  it("an empty text is reported as a playbook with nothing in it", () => {
    expect(failure("").problems.join("\n")).toMatch(/^\(root\): /m);
  });

  it("keeps the line and column of a syntax error in the message", () => {
    expect(failure("name: [unclosed").message).toMatch(/^test\.yaml is not valid YAML: .*line 1/s);
  });
});
