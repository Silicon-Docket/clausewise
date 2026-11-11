import { describe, expect, it } from "vitest";
import { hashOf } from "../../src/canonical.js";
import {
  GATE_IDS,
  MAX_PAGE_BYTES,
  isPageId,
  pageFileName,
  pageIdOf,
  parseComparisonPage,
  sealComparisonPage,
  type ComparisonBody,
  type PageProblem,
} from "../../src/evaluations/index.js";
import { comparisonBody, comparisonPage, devSection, gateViews, hex } from "./fixtures.js";

/**
 * The page document is the contract between the evaluation command, which writes it, and the
 * application, which reads it. These tests fix what the reader accepts and what it refuses, and
 * that a refusal is one of six fixed codes and never a word of the file.
 */

const body = (): ComparisonBody => comparisonBody();

/** Seals a changed body, so that only the schema (and not the fingerprint) can refuse it. */
function problemOf(change: (b: ComparisonBody) => void): PageProblem | null {
  const b = body();
  change(b);
  const page = sealComparisonPage(b);
  const parsed = parseComparisonPage(JSON.stringify(page), pageFileName(page.id));
  return parsed.ok ? null : parsed.problem;
}

describe("a sealed page", () => {
  it("is accepted as it was written, and read back equal", () => {
    const page = comparisonPage();
    const parsed = parseComparisonPage(JSON.stringify(page), pageFileName(page.id));
    expect(parsed).toEqual({ ok: true, page });
  });

  it("has the fingerprint of everything but the fingerprint and the id, and an id made from it", () => {
    const page = comparisonPage();
    const { id, sha256, ...rest } = page;
    expect(sha256).toBe(hashOf(rest));
    expect(id).toBe(`cmp_${sha256.slice(0, 16)}`);
    expect(pageIdOf(sha256)).toBe(id);
    expect(isPageId(id)).toBe(true);
    expect(pageFileName(id)).toBe(`${id}.json`);
  });

  it("is the same for the same body, and changes with one gate's reason", () => {
    const a = sealComparisonPage(body());
    const b = sealComparisonPage(body());
    expect(b).toEqual(a);
    const changed = body();
    const section = changed.sections[0];
    if (section === undefined || section.gates.candidate === null) throw new Error("fixture");
    section.gates.candidate[0] = { ...section.gates.candidate[0]!, detail: "Another reason." };
    const c = sealComparisonPage(changed);
    expect(c.sha256).not.toBe(a.sha256);
    expect(c.id).not.toBe(a.id);
  });

  it("holds exactly the gates G1 to G14, in order, on each side", () => {
    const page = comparisonPage();
    for (const section of page.sections) {
      expect(section.gates.baseline?.map((g) => g.id)).toEqual([...GATE_IDS]);
      expect(section.gates.candidate?.map((g) => g.id)).toEqual([...GATE_IDS]);
    }
  });

  it("is accepted with no gate report on a side, and with two sections", () => {
    expect(
      problemOf((b) => {
        const section = b.sections[0]!;
        b.sections = [{ ...section, gates: { baseline: null, candidate: null } }];
      }),
    ).toBeNull();
    expect(
      problemOf((b) => void b.sections.push({ ...devSection(), split: "heldout" })),
    ).toBeNull();
  });
});

describe("the strict schema refuses", () => {
  it("accepts the unchanged body, so that each refusal below is the change and nothing else", () => {
    expect(problemOf(() => undefined)).toBeNull();
  });

  const cases: [string, (b: ComparisonBody) => void][] = [
    [
      "an unknown key at the top",
      (b) => void ((b as unknown as Record<string, unknown>).extra = 1),
    ],
    [
      "an unknown key inside a side",
      (b) => void ((b.sides.baseline as unknown as Record<string, unknown>).extra = 1),
    ],
    [
      "an unknown key inside a changed slot",
      (b) => void ((b.sections[0]!.changes[0] as unknown as Record<string, unknown>).extra = 1),
    ],
    ["a string over 2,000 characters", (b) => void b.notes.push("x".repeat(2001))],
    [
      "a passage over 8,000 characters",
      (b) => void (b.cases["PAROL-D05"]!.passages[0]!.text = "x".repeat(8001)),
    ],
    [
      "a fifteenth gate",
      (b) => void b.sections[0]!.gates.candidate!.push({ ...gateViews()[0]!, id: "G14" }),
    ],
    [
      "a duplicated gate id in place of another",
      (b) => void (b.sections[0]!.gates.candidate![5] = { ...gateViews()[0]! }),
    ],
    [
      "gates out of order",
      (b) => {
        const gates = b.sections[0]!.gates.candidate!;
        [gates[0], gates[1]] = [gates[1]!, gates[0]!];
      },
    ],
    ["thirteen gates", (b) => void b.sections[0]!.gates.baseline!.pop()],
    [
      "a gate id that is not G1 to G14",
      (b) => void ((b.sections[0]!.gates.candidate![0] as unknown as { id: string }).id = "G15"),
    ],
    [
      "an unknown status",
      (b) =>
        void ((b.sections[0]!.changes[0] as unknown as { expected: string }).expected = "maybe"),
    ],
    [
      "an unknown evidence role",
      (b) => {
        const trail = b.sections[0]!.changes[0]!.trail;
        if ("sealed" in trail) throw new Error("fixture");
        (trail.candidate.repeats[0]!.cited[0] as unknown as { role: string }).role = "decisive";
      },
    ],
    [
      "an unknown failure kind",
      (b) =>
        void ((b.sections[0]!.changes[0]!.baseline as unknown as { failures: string[] }).failures =
          ["bad_luck"]),
    ],
    [
      "an unknown mode",
      (b) => void ((b.sides.baseline as unknown as { mode: string }).mode = "dry_run"),
    ],
    [
      "501 changes in a section",
      (b) =>
        void (b.sections[0]!.changes = Array.from(
          { length: 501 },
          () => b.sections[0]!.changes[0]!,
        )),
    ],
    [
      "41 cases",
      (b) => {
        const one = b.cases["PAROL-D05"]!;
        b.cases = Object.fromEntries(
          Array.from({ length: 41 }, (_, i) => [`PAROL-D${i + 10}`, one]),
        );
      },
    ],
    [
      "61 passages in a case",
      (b) =>
        void (b.cases["PAROL-D05"]!.passages = Array.from(
          { length: 61 },
          () => b.cases["PAROL-D05"]!.passages[0]!,
        )),
    ],
    ["a case key that is a path", (b) => void (b.cases["../x"] = b.cases["PAROL-D05"]!)],
    ["no section", (b) => void (b.sections = [])],
    ["three sections", (b) => void (b.sections = [devSection(), devSection(), devSection()])],
    ["two sections of one split", (b) => void (b.sections = [devSection(), devSection()])],
    ["a hash that is not 64 hex digits", (b) => void (b.dataset.answerKeysSha256 = "abc")],
    ["a results file name with a path", (b) => void (b.files.baseline = "../results/a.json")],
    [
      "a correct count over the repeats",
      (b) => void (b.sections[0]!.changes[0]!.baseline.correct = 2),
    ],
    [
      "a check id with spaces",
      (b) => {
        const trail = b.sections[0]!.changes[0]!.trail;
        if ("sealed" in trail) throw new Error("fixture");
        trail.candidate.repeats[0]!.checks!.pass.push("quote exists");
      },
    ],
    [
      "a negative offset",
      (b) => {
        const trail = b.sections[0]!.changes[0]!.trail;
        if ("sealed" in trail) throw new Error("fixture");
        trail.candidate.repeats[0]!.cited[0]!.start = -1;
      },
    ],
    [
      "a rule key with a space in it, which is a sentence and not a key",
      (b) => void (b.sections[0]!.changes[0]!.ruleKey = "Duration of confidentiality"),
    ],
    ["a wrong format", (b) => void ((b as unknown as { format: number }).format = 2)],
    ["a wrong kind", (b) => void ((b as unknown as { kind: string }).kind = "parol-eval-results")],
  ];

  for (const [name, change] of cases)
    it(name, () => {
      expect(problemOf(change)).toBe("not_a_comparison");
    });
});

describe("a rule key", () => {
  // The alphabet the application stores a playbook's rule keys in, so that a comparison of any
  // playbook it accepts can be published.
  it.each(["dur-1", "Non_solicit.2", "A", `A${"x".repeat(63)}`])(
    "is accepted as the application stores it: %s",
    (key) => {
      expect(problemOf((b) => void (b.sections[0]!.changes[0]!.ruleKey = key))).toBeNull();
    },
  );

  it.each(["", `A${"x".repeat(64)}`, "a b", "-dur", ".dur", "dur/1", "dur\n1", "<b>"])(
    "is refused when it is not a key: %j",
    (key) => {
      expect(problemOf((b) => void (b.sections[0]!.changes[0]!.ruleKey = key))).toBe(
        "not_a_comparison",
      );
    },
  );
});

describe("the reader names the first thing wrong", () => {
  const page = comparisonPage();
  const text = JSON.stringify(page);
  const name = pageFileName(page.id);

  it("not JSON", () => {
    expect(parseComparisonPage("{", name)).toEqual({ ok: false, problem: "not_json" });
    expect(parseComparisonPage("", name)).toEqual({ ok: false, problem: "not_json" });
    expect(parseComparisonPage("not json at all", name)).toEqual({
      ok: false,
      problem: "not_json",
    });
  });

  it("JSON that is not a comparison", () => {
    for (const other of ["null", "[]", "{}", '"a string"', "42", '{"format":1}'])
      expect(parseComparisonPage(other, name), other).toEqual({
        ok: false,
        problem: "not_a_comparison",
      });
  });

  it("a file changed after it was written, even to another valid value", () => {
    const edited = text.replace('"baseline":"sim-v1.json"', '"baseline":"sim-v9.json"');
    expect(edited).not.toBe(text);
    expect(parseComparisonPage(edited, name)).toEqual({
      ok: false,
      problem: "fingerprint_mismatch",
    });
  });

  it("a file whose name is not its id", () => {
    expect(parseComparisonPage(text, "cmp_0000000000000000.json")).toEqual({
      ok: false,
      problem: "name_mismatch",
    });
    expect(parseComparisonPage(text, `${page.id}.JSON`)).toEqual({
      ok: false,
      problem: "name_mismatch",
    });
  });

  it("an id that is not the fingerprint's, although the fingerprint holds", () => {
    // The fingerprint leaves the id out, so only the id check can find this.
    const forged = { ...page, id: "cmp_0123456789abcdef" };
    expect(parseComparisonPage(JSON.stringify(forged), pageFileName(forged.id))).toEqual({
      ok: false,
      problem: "name_mismatch",
    });
  });

  it("a file over the size limit, counted in bytes, before it is read as JSON", () => {
    expect(parseComparisonPage("x".repeat(MAX_PAGE_BYTES + 1), name)).toEqual({
      ok: false,
      problem: "too_large",
    });
    // Two bytes a character: under the limit in characters and over it in bytes.
    expect(parseComparisonPage("é".repeat(MAX_PAGE_BYTES / 2 + 1), name)).toEqual({
      ok: false,
      problem: "too_large",
    });
    expect(parseComparisonPage("x".repeat(MAX_PAGE_BYTES), name)).toEqual({
      ok: false,
      problem: "not_json",
    });
  });

  it("never repeats a character of the file", () => {
    const marker = "SECRET-MARKER-7f3a";
    const hostile = [
      `{"kind":"${marker}"}`,
      `{"format":1,"kind":"parol-comparison-page","id":"${marker}"}`,
      `${marker} {`,
      text.replace('"sim-v1.json"', `"${marker}"`),
      JSON.stringify({ ...page, extra: marker }),
    ];
    for (const input of hostile) {
      const result = parseComparisonPage(input, name);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(marker);
      if (!result.ok)
        expect([
          "too_large",
          "unreadable",
          "not_json",
          "not_a_comparison",
          "fingerprint_mismatch",
          "name_mismatch",
        ]).toContain(result.problem);
    }
  });
});

describe("a page id", () => {
  it("is cmp_ and 16 lower case hex digits, and nothing else", () => {
    expect(isPageId("cmp_0123456789abcdef")).toBe(true);
    for (const bad of [
      "cmp_0123456789abcde",
      "cmp_0123456789abcdef0",
      "cmp_0123456789ABCDEF",
      "CMP_0123456789abcdef",
      "../cmp_0123456789abcdef",
      "cmp_0123456789abcdef.json",
      "cmp_0123456789abcdeg",
      "",
      " cmp_0123456789abcdef",
    ])
      expect(isPageId(bad), bad).toBe(false);
    expect(isPageId(undefined)).toBe(false);
    expect(isPageId(7)).toBe(false);
    expect(hex("x")).toHaveLength(64);
  });
});
