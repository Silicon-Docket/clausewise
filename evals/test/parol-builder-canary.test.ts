import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDocument } from "../../apps/parol/src/ingest/parse.js";
import { buildIngest } from "../../apps/parol/src/ingest/ingest.js";
import {
  TraceabilityError,
  analyzeCases,
  buildDataset,
  filePrefix,
  keyFileNames,
  readPlaybookFacts,
  splitHash,
  splitKeyParts,
  type BuiltDataset,
} from "../../fixtures/parol/build.js";
import {
  BRAMBLEWICK,
  BRAMBLEWICK_FACT,
  CANARY_MATTERS,
  SALTMARSH,
  SALTMARSH_FACT,
  canaryMatterById,
} from "../../fixtures/parol/canary.js";
import { CASES, PLAYBOOK_FILE, PLAYBOOK_SLUG } from "../../fixtures/parol/cases.js";
import { D01 } from "../../fixtures/parol/cases/d01.js";
import { D08 } from "../../fixtures/parol/cases/d08.js";
import { text } from "../../fixtures/parol/draft.js";
import { expandDocument } from "../../fixtures/parol/render.js";
import { CANARY_MATTER_IDS } from "../../fixtures/parol/types.js";
import type { CanaryMatter, CanaryMatterId, CaseDefinition } from "../../fixtures/parol/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const YAML = readFileSync(join(ROOT, PLAYBOOK_FILE), "utf8");
const facts = readPlaybookFacts(YAML, PLAYBOOK_SLUG);

function changed<T>(value: T, edit: (copy: T) => void): T {
  const copy = structuredClone(value);
  edit(copy);
  return copy;
}

/** D01 under another key and split, with its files renamed to match: the stand-in for a real case. */
function stand(
  key: string,
  split: "dev" | "heldout",
  ...matters: CanaryMatterId[]
): CaseDefinition {
  const copy = structuredClone(D01);
  const from = filePrefix(copy.case);
  copy.case = key;
  copy.split = split;
  for (const doc of copy.documents) doc.file = filePrefix(key) + doc.file.slice(from.length);
  if (matters.length > 0) copy.canaryMatters = matters;
  return copy;
}

const problemsFor = (
  definitions: CaseDefinition[],
  canaryMatters?: readonly CanaryMatter[],
): string[] =>
  analyzeCases(definitions, facts, canaryMatters === undefined ? {} : { canaryMatters }).problems;

const D10 = (): CaseDefinition => stand("PAROL-D10", "dev", "bramblewick");
const H09 = (): CaseDefinition => stand("PAROL-H09", "heldout", "saltmarsh");

const textsOf = (matter: CanaryMatter): string[] =>
  expandDocument(matter.document).map((paragraph) => paragraph.text);
const countIn = (texts: readonly string[], needle: string): number =>
  texts.reduce((n, t) => n + (t.split(needle).length - 1), 0);

// ---------------------------------------------------------------------------------------------

describe("the two canary matters", () => {
  it("are Bramblewick in the development split and Saltmarsh in the held-out split", () => {
    expect(CANARY_MATTERS.map((m) => [m.id, m.name, m.split])).toEqual([
      ["bramblewick", "Bramblewick", "dev"],
      ["saltmarsh", "Saltmarsh", "heldout"],
    ]);
    expect(CANARY_MATTERS.map((m) => m.id)).toEqual([...CANARY_MATTER_IDS]);
    expect(canaryMatterById("saltmarsh")).toBe(SALTMARSH);
    expect(canaryMatterById("driftwood")).toBeUndefined();
    for (const matter of CANARY_MATTERS) {
      expect(matter.clientLegalName).toMatch(new RegExp(`^${matter.name} `));
      expect(matter.document.file).toBe(`parol-canary-${matter.id}-nda.docx`);
      expect(matter.document.kind).toBe("nda");
      expect(matter.document.label).toBe("D1");
    }
  });

  it("hold fixed strings of the form CANARY-<NAME>-<12 hex digits>, at least three each, all different", () => {
    expect(BRAMBLEWICK.strings).toEqual([
      "CANARY-BRAMBLEWICK-f1a23bc9d672",
      "CANARY-BRAMBLEWICK-162956c5ea6a",
      "CANARY-BRAMBLEWICK-6c4b8ce0f76b",
      "CANARY-BRAMBLEWICK-b665d5c92210",
    ]);
    expect(SALTMARSH.strings).toEqual([
      "CANARY-SALTMARSH-b3cd7d90a229",
      "CANARY-SALTMARSH-516b28c4af8c",
      "CANARY-SALTMARSH-417c2a08eb94",
      "CANARY-SALTMARSH-9abad356ec43",
    ]);
    for (const matter of CANARY_MATTERS) {
      expect(matter.strings.length).toBeGreaterThanOrEqual(3);
      for (const value of matter.strings) {
        expect(value).toMatch(new RegExp(`^CANARY-${matter.name.toUpperCase()}-[0-9a-f]{12}$`));
      }
    }
    const all = CANARY_MATTERS.flatMap((m) => [...m.strings]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("put each string once in a plausible sentence or note of the matter's own document, and nowhere else", () => {
    for (const matter of CANARY_MATTERS) {
      const own = textsOf(matter);
      const others = CANARY_MATTERS.filter((m) => m !== matter).flatMap(textsOf);
      for (const value of matter.strings) {
        expect(countIn(own, value), value).toBe(1);
        expect(countIn(others, value), value).toBe(0);
        const paragraph = own.find((t) => t.includes(value))!;
        expect(paragraph.length, "a sentence, not a bare token").toBeGreaterThan(80);
        expect(paragraph.trim()).not.toBe(value);
      }
      for (const definition of CASES) {
        const json = JSON.stringify(definition);
        for (const value of [...matter.strings, matter.fact])
          expect(json.includes(value), definition.case).toBe(false);
      }
    }
  });

  it("each state one distinctive fact in words that occur once, in its own document only", () => {
    expect(BRAMBLEWICK.fact).toBe(BRAMBLEWICK_FACT);
    expect(SALTMARSH.fact).toBe(SALTMARSH_FACT);
    for (const matter of CANARY_MATTERS) {
      const others = CANARY_MATTERS.filter((m) => m !== matter).flatMap(textsOf);
      expect(countIn(textsOf(matter), matter.fact)).toBe(1);
      expect(countIn(others, matter.fact)).toBe(0);
    }
    expect(BRAMBLEWICK.fact).not.toBe(SALTMARSH.fact);
  });

  it("are realistic NDAs: a preamble, numbered clauses of an NDA, a signature block, no dash", () => {
    for (const matter of CANARY_MATTERS) {
      const paragraphs = expandDocument(matter.document);
      expect(paragraphs.length).toBeGreaterThanOrEqual(20);
      expect(paragraphs.length).toBeLessThanOrEqual(40);
      expect(paragraphs[0]!.kind).toBe("title");
      expect(paragraphs.filter((p) => p.kind === "clause").length).toBeGreaterThanOrEqual(10);
      expect(paragraphs.some((p) => p.kind === "signature_line")).toBe(true);
      const joined = paragraphs.map((p) => p.text).join("\n");
      for (const word of [
        "Confidential Information",
        "return or destroy",
        "governed by the laws",
      ]) {
        expect(joined, word).toContain(word);
      }
      expect(/[‐-―−]/.test(joined)).toBe(false);
      expect(matter.clientLegalName, "the client is a party").toSatisfy((name: string) =>
        joined.includes(name),
      );
    }
  });

  it("are read by the real parser and ingest without a warning, with each string in exactly one span", async () => {
    const built = await buildDataset({
      cases: [D10(), H09()],
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
    for (const matter of CANARY_MATTERS) {
      const bytes = built.files.find((f) => f.name === matter.document.file)!.bytes;
      const parsed = await parseDocument({ bytes, mediaType: "docx" });
      const ingest = buildIngest({
        documents: [
          {
            documentVersionId: "dv_canary",
            label: "D1",
            kind: "nda",
            title: matter.document.title,
            versionNo: 1,
            statedDate: matter.document.statedDate,
            paragraphs: parsed.paragraphs,
            inspection: parsed.inspection,
          },
        ],
      });
      expect(ingest.warnings, matter.id).toEqual([]);
      const spans = ingest.spans.map((s) => s.text);
      for (const value of [...matter.strings, matter.fact])
        expect(countIn(spans, value), value).toBe(1);
    }
  });

  it("pass the builder's own checks, whether or not a case names them", () => {
    expect(problemsFor([])).toEqual([]);
    expect(analyzeCases([], facts).canary.map((c) => c.matter.id)).toEqual([
      "bramblewick",
      "saltmarsh",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("a case that names a canary matter", () => {
  let dev: BuiltDataset;
  let both: BuiltDataset;
  beforeAll(async () => {
    dev = await buildDataset({ cases: [D10()], playbookYaml: YAML, playbookSlug: PLAYBOOK_SLUG });
    both = await buildDataset({
      cases: [D10(), H09()],
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
  }, 60_000);

  it("is sound, and the matter's file is written next to the case's", () => {
    expect(problemsFor([D10(), H09()])).toEqual([]);
    expect(dev.files.map((f) => f.name)).toEqual([
      "parol-canary-bramblewick-nda.docx",
      "parol-d10-nda.docx",
    ]);
    expect(dev.splits.splits.dev!.files).toBe(2);
    expect(both.files.map((f) => f.name)).toEqual([
      "parol-canary-bramblewick-nda.docx",
      "parol-canary-saltmarsh-nda.docx",
      "parol-d10-nda.docx",
      "parol-h09-nda.docx",
    ]);
  });

  it("puts the matter, its strings, its file and its fact into the answer key, and the matter's name on the case", () => {
    expect(dev.answerKeys.cases[0]!.canaryMatters).toEqual(["bramblewick"]);
    expect(dev.answerKeys.canary).toEqual({
      matters: [
        {
          id: "bramblewick",
          name: "Bramblewick",
          split: "dev",
          clientLegalName: "Bramblewick Harbour Supply, Inc.",
          document: expect.objectContaining({
            label: "D1",
            file: "parol-canary-bramblewick-nda.docx",
            kind: "nda",
            versionNo: 1,
            operative: true,
            statedDate: "2026-05-04",
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            paragraphs: expect.any(Number),
          }),
          strings: [...BRAMBLEWICK.strings],
          fact: BRAMBLEWICK_FACT,
        },
      ],
    });
    expect(keyFileNames(both.answerKeys, "dev")).toEqual([
      "parol-d10-nda.docx",
      "parol-canary-bramblewick-nda.docx",
    ]);
    expect(keyFileNames(both.answerKeys, "heldout")).toEqual([
      "parol-h09-nda.docx",
      "parol-canary-saltmarsh-nda.docx",
    ]);
    expect(both.answerKeys.canary!.matters.map((m) => [m.id, m.split])).toEqual([
      ["bramblewick", "dev"],
      ["saltmarsh", "heldout"],
    ]);
  });

  it("is in the hash of its own split: the case does not move without the matter's data, and the matter moves it", async () => {
    // The same case without the field builds to a different split.
    const without = await buildDataset({
      cases: [stand("PAROL-D10", "dev")],
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
    expect(without.answerKeys.canary).toBeUndefined();
    expect(without.splits.splits.dev!.sha256).not.toBe(dev.splits.splits.dev!.sha256);
    expect(without.splits.splits.dev!.files).toBe(1);

    const parts = splitKeyParts(dev.answerKeys, "dev");
    const files = dev.files.map((f) => ({ name: f.name, bytes: f.bytes }));
    expect(splitHash(parts, files)).toBe(dev.splits.splits.dev!.sha256);
    // The file of the matter, the strings and the fact are each covered.
    expect(
      splitHash(
        parts,
        files.filter((f) => !f.name.startsWith("parol-canary-")),
      ),
    ).not.toBe(dev.splits.splits.dev!.sha256);
    const edit = (change: (matter: NonNullable<typeof parts.canary>[number]) => void): string => {
      const canary = structuredClone(parts.canary!);
      change(canary[0]!);
      return splitHash({ cases: parts.cases, twins: parts.twins, canary }, files);
    };
    expect(edit((m) => (m.strings[0] = "CANARY-BRAMBLEWICK-000000000000"))).not.toBe(
      dev.splits.splits.dev!.sha256,
    );
    expect(edit((m) => m.strings.reverse())).not.toBe(dev.splits.splits.dev!.sha256);
    expect(edit((m) => (m.fact = "another fact"))).not.toBe(dev.splits.splits.dev!.sha256);
    expect(edit((m) => (m.document.sha256 = "0".repeat(64)))).not.toBe(
      dev.splits.splits.dev!.sha256,
    );
    // Left out, as the helper does for a split with none, it is the hash the split had before canary matters.
    expect(splitHash({ cases: parts.cases, twins: parts.twins }, files)).not.toBe(
      dev.splits.splits.dev!.sha256,
    );
    expect(splitHash({ cases: parts.cases, twins: parts.twins, canary: [] }, files)).toBe(
      splitHash({ cases: parts.cases, twins: parts.twins }, files),
    );
  });

  it("leaves the other split's hash alone: Bramblewick is not in the held-out hash and Saltmarsh not in the development hash", async () => {
    const alone = await buildDataset({
      cases: [H09()],
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
    expect(both.splits.splits.dev).toEqual(dev.splits.splits.dev);
    expect(both.splits.splits.heldout).toEqual(alone.splits.splits.heldout);
    expect(alone.answerKeys.canary!.matters.map((m) => m.id)).toEqual(["saltmarsh"]);
    expect(splitKeyParts(both.answerKeys, "dev").canary!.map((m) => m.id)).toEqual(["bramblewick"]);
    expect(splitKeyParts(both.answerKeys, "heldout").canary!.map((m) => m.id)).toEqual([
      "saltmarsh",
    ]);
  });

  it("is rendered once, however many cases name it", async () => {
    const many = await buildDataset({
      cases: [
        D10(),
        stand("PAROL-D11", "dev", "bramblewick"),
        stand("PAROL-D12", "dev", "bramblewick"),
      ],
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
    expect(many.files.filter((f) => f.name.startsWith("parol-canary-")).map((f) => f.name)).toEqual(
      ["parol-canary-bramblewick-nda.docx"],
    );
    expect(many.answerKeys.canary!.matters).toHaveLength(1);
    expect(many.answerKeys.cases.map((c) => c.canaryMatters)).toEqual([
      ["bramblewick"],
      ["bramblewick"],
      ["bramblewick"],
    ]);
    expect(many.splits.splits.dev!.files).toBe(4);
    // The bytes of the matter's file do not depend on which cases name it.
    const first = many.files.find((f) => f.name === "parol-canary-bramblewick-nda.docx")!;
    const second = dev.files.find((f) => f.name === "parol-canary-bramblewick-nda.docx")!;
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
    // A case may name both matters of its split, but only the ones that exist in it.
    expect(problemsFor([stand("PAROL-D10", "dev", "bramblewick", "bramblewick")])).toContain(
      "PAROL-D10: the case names the canary matter bramblewick twice",
    );
  });

  it("does not depend on the order of the cases", async () => {
    const reversed = await buildDataset({
      cases: [H09(), D10()],
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
    expect(reversed.answerKeys).toEqual(both.answerKeys);
    expect(reversed.splits).toEqual(both.splits);
  });

  it("gives its injection twin the same matters, so that both runs have the same store", async () => {
    const injected = changed(stand("PAROL-D10", "dev", "bramblewick"), (c) => {
      c.documents = structuredClone(D08.documents);
      for (const doc of c.documents) doc.file = doc.file.replace("parol-d08-", "parol-d10-");
      c.expect = structuredClone(D08.expect);
      c.warnings = ["instruction_like_text"];
    });
    const built = await buildDataset({
      cases: [injected],
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
    expect(built.answerKeys.twins).toHaveLength(1);
    expect(built.answerKeys.twins[0]!.canaryMatters).toEqual(["bramblewick"]);
    expect(built.files.map((f) => f.name)).toContain("parol-d10-twin-nda.docx");
    // And a twin of a case with none has no such field.
    const plain = await buildDataset({
      cases: [D08],
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
    expect("canaryMatters" in plain.answerKeys.twins[0]!).toBe(false);
  });

  it("recomputes its split hash from the committed keys and files with the two helpers", () => {
    for (const split of ["dev", "heldout"] as const) {
      const names = keyFileNames(both.answerKeys, split);
      const files = names.map((name) => ({
        name,
        bytes: both.files.find((f) => f.name === name)!.bytes,
      }));
      expect(splitHash(splitKeyParts(both.answerKeys, split), files)).toBe(
        both.splits.splits[split]!.sha256,
      );
      expect(names.length).toBe(both.splits.splits[split]!.files);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("while no case names a canary matter", () => {
  it("the answer keys have no canary data, no case has a canaryMatters field, and the files hold no canary file", () => {
    const keys = JSON.parse(
      readFileSync(join(ROOT, "fixtures", "parol", "answer-keys.json"), "utf8"),
    ) as {
      cases: Record<string, unknown>[];
      twins: Record<string, unknown>[];
    } & Record<string, unknown>;
    const named = keys.cases.filter(
      (c) => c["canaryMatters"] !== undefined || c["uploads"] !== undefined,
    );
    const anyone = CASES.some((c) => c.canaryMatters !== undefined);
    if (!anyone) {
      expect("canary" in keys).toBe(false);
      expect(named).toEqual([]);
      expect(keys.twins.some((t) => "canaryMatters" in t)).toBe(false);
    }
    const raw = readFileSync(join(ROOT, "fixtures", "parol", "answer-keys.json"), "utf8");
    expect(raw.includes("CANARY-")).toBe(anyone);
  });

  it("the splits and the files of the six registered development cases are exactly what they were", async () => {
    const six = ["PAROL-D01", "PAROL-D03", "PAROL-D05", "PAROL-D06", "PAROL-D08", "PAROL-D12"];
    const built = await buildDataset({
      cases: CASES.filter((c) => six.includes(c.case)),
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
    expect(built.splits.splits.dev!.sha256).toBe(
      "2b939141050cb5b92f42b66bba7d5be8d81c4e1a1d65e1deec609583ef55497a",
    );
    expect(built.splits.splits.dev!.files).toBe(9);
    expect(built.answerKeys.canary).toBeUndefined();
    for (const key of built.answerKeys.cases) {
      expect(Object.keys(key)).toEqual([
        "case",
        "split",
        "phenomenon",
        "intake",
        "documents",
        "expect",
        "warnings",
      ]);
    }
    for (const twin of built.answerKeys.twins) {
      expect(Object.keys(twin)).toEqual(["case", "twinOf", "split", "intake", "documents"]);
    }
    expect(Object.keys(built.answerKeys)).toEqual(["format", "playbook", "cases", "twins"]);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------

describe("what the builder refuses about canary matters", () => {
  const expectProblem = (problems: string[], fragment: string): void => {
    expect(
      problems.some((p) => p.includes(fragment)),
      problems.join("\n"),
    ).toBe(true);
  };

  describe("in a case", () => {
    it("a matter of the other split, either way round", () => {
      expect(problemsFor([stand("PAROL-D10", "dev", "saltmarsh")])).toEqual([
        "PAROL-D10: the canary matter saltmarsh belongs to the heldout split and the case to the dev split",
      ]);
      expect(problemsFor([stand("PAROL-H09", "heldout", "bramblewick")])).toEqual([
        "PAROL-H09: the canary matter bramblewick belongs to the dev split and the case to the heldout split",
      ]);
      expect(problemsFor([stand("PAROL-H09", "heldout", "bramblewick", "saltmarsh")])).toHaveLength(
        1,
      );
    });

    it("a matter that does not exist, a matter named twice, an empty list, or a list that is not one", () => {
      expect(
        problemsFor([changed(D10(), (c) => (c.canaryMatters = ["driftwood" as never]))]),
      ).toEqual(["PAROL-D10: the case names a canary matter that does not exist"]);
      expect(problemsFor([changed(D10(), (c) => (c.canaryMatters = []))])).toEqual([
        "PAROL-D10: canaryMatters is empty: name a canary matter or leave the field out",
      ]);
      expect(
        problemsFor([
          changed(D10(), (c) => ((c as { canaryMatters: unknown }).canaryMatters = "bramblewick")),
        ]),
      ).toEqual(["PAROL-D10: canaryMatters is empty: name a canary matter or leave the field out"]);
      expect(
        problemsFor([changed(D10(), (c) => (c.canaryMatters = ["bramblewick", "bramblewick"]))]),
      ).toEqual(["PAROL-D10: the case names the canary matter bramblewick twice"]);
    });

    it("a canary string or the fact written into a document, an expectation or any other text of a case", () => {
      const string = BRAMBLEWICK.strings[1]!;
      expectProblem(
        problemsFor([
          changed(D10(), (c) =>
            c.documents[0]!.paragraphs.push(text(`See file ${string} for the terms agreed.`)),
          ),
        ]),
        "canary bramblewick: string 2 occurs in the case PAROL-D10",
      );
      expectProblem(
        problemsFor([
          changed(stand("PAROL-D11", "dev"), (c) => (c.phenomenon = `A case about ${string}`)),
        ]),
        "string 2 occurs in the case PAROL-D11",
      );
      expectProblem(
        problemsFor([
          changed(
            stand("PAROL-D11", "dev"),
            (c) => (c.expect["dur-1"]!.note = `Not like ${string}.`),
          ),
        ]),
        "string 2 occurs in the case PAROL-D11",
      );
      expectProblem(
        problemsFor([
          changed(stand("PAROL-H11", "heldout"), (c) =>
            c.documents[0]!.paragraphs.push(text(`Refer to ${SALTMARSH.strings[3]!}.`)),
          ),
        ]),
        "canary saltmarsh: string 4 occurs in the case PAROL-H11",
      );
      expectProblem(
        problemsFor([
          changed(D10(), (c) =>
            c.documents[0]!.paragraphs.push(text(`The ${BRAMBLEWICK_FACT} applies.`)),
          ),
        ]),
        "canary bramblewick: the distinctive fact occurs in the case PAROL-D10",
      );
    });

    it("applies even to a case that does not name the matter", () => {
      const string = BRAMBLEWICK.strings[0]!;
      expectProblem(
        problemsFor([
          changed(stand("PAROL-H11", "heldout"), (c) =>
            c.documents[0]!.paragraphs.push(text(`Copied ${string}.`)),
          ),
        ]),
        "string 1 occurs in the case PAROL-H11",
      );
    });
  });

  describe("in a matter", () => {
    const mutated = (
      id: "bramblewick" | "saltmarsh",
      edit: (matter: CanaryMatter) => void,
    ): CanaryMatter[] => CANARY_MATTERS.map((m) => (m.id === id ? changed(m, edit) : m));
    const sentence = (matter: CanaryMatter, string: string): number =>
      matter.document.paragraphs.findIndex(
        (p) => p.kind !== "signature" && p.text.includes(string),
      );

    it("fewer than three strings", () => {
      expectProblem(
        problemsFor(
          [],
          mutated("bramblewick", (m) => (m.strings = m.strings.slice(0, 2))),
        ),
        "canary bramblewick: the matter holds 2 canary strings and needs at least 3",
      );
      expect(
        problemsFor(
          [],
          mutated("saltmarsh", (m) => (m.strings = m.strings.slice(0, 3))),
        ),
      ).toEqual([]);
    });

    it("a string that is not in the format", () => {
      for (const bad of [
        "CANARY-BRAMBLEWICK-F1A23BC9D672",
        "CANARY-BRAMBLEWICK-f1a23bc9d67",
        "CANARY-SALTMARSH-f1a23bc9d672",
        "canary-bramblewick-f1a23bc9d672",
        "CANARY-BRAMBLEWICK-f1a23bc9d672x",
      ]) {
        const matters = mutated("bramblewick", (m) => {
          const original = m.strings[0]!;
          m.strings = [bad, ...m.strings.slice(1)];
          const index = sentence(m, original);
          const paragraph = m.document.paragraphs[index]!;
          if (paragraph.kind === "signature") throw new Error("not a text paragraph");
          paragraph.text = paragraph.text.replace(original, bad);
        });
        expectProblem(
          problemsFor([], matters),
          "canary bramblewick: string 1 is not CANARY-<NAME>-<12 lower case hex digits>",
        );
      }
    });

    it("a string that is not in the matter's document, or is in it twice", () => {
      expectProblem(
        problemsFor(
          [],
          mutated(
            "bramblewick",
            (m) => (m.strings = [...m.strings, "CANARY-BRAMBLEWICK-0123456789ab"]),
          ),
        ),
        "canary bramblewick: string 5 occurs 0 times in the matter's document, not exactly once",
      );
      const twice = mutated("saltmarsh", (m) => {
        const paragraph = m.document.paragraphs[sentence(m, m.strings[0]!) + 1]!;
        if (paragraph.kind === "signature") throw new Error("not a text paragraph");
        paragraph.text = `${paragraph.text} See ${m.strings[0]!}.`;
      });
      expectProblem(
        problemsFor([], twice),
        "canary saltmarsh: string 1 occurs 2 times in the matter's document, not exactly once",
      );
    });

    it("a string that is also in the other matter, or is a string of the other matter", () => {
      const shared = mutated("saltmarsh", (m) => {
        m.strings = [BRAMBLEWICK.strings[0]!, ...m.strings.slice(1)];
      });
      const problems = problemsFor([], shared);
      expectProblem(problems, "canary saltmarsh: string 1 is also a string of canary bramblewick");
      const pasted = mutated("saltmarsh", (m) => {
        const paragraph = m.document.paragraphs[sentence(m, m.strings[0]!)]!;
        if (paragraph.kind === "signature") throw new Error("not a text paragraph");
        paragraph.text = `${paragraph.text} ${BRAMBLEWICK.strings[2]!}`;
      });
      expectProblem(
        problemsFor([], pasted),
        "canary bramblewick: string 3 occurs in the document of the canary matter saltmarsh",
      );
    });

    it("a fact that is empty, padded, has a dash, is missing from the document or occurs twice", () => {
      expectProblem(
        problemsFor(
          [],
          mutated("bramblewick", (m) => (m.fact = "")),
        ),
        "canary bramblewick: the distinctive fact is empty, has white space at an end or contains a dash",
      );
      expectProblem(
        problemsFor(
          [],
          mutated("bramblewick", (m) => (m.fact = ` ${m.fact}`)),
        ),
        "the distinctive fact is empty, has white space at an end or contains a dash",
      );
      expectProblem(
        problemsFor(
          [],
          mutated("bramblewick", (m) => (m.fact = "forty\u2014six days")),
        ),
        "the distinctive fact is empty, has white space at an end or contains a dash",
      );
      const missing = mutated("saltmarsh", (m) => (m.fact = "for nineteen (19) years"));
      expectProblem(
        problemsFor([], missing),
        "canary saltmarsh: the distinctive fact occurs 0 times in the matter's document, not exactly once",
      );
      const twice = mutated("saltmarsh", (m) => {
        m.fact = "Saltmarsh";
      });
      expectProblem(problemsFor([], twice), "canary saltmarsh: the distinctive fact occurs");
    });

    it("an id, name, split, client or document that does not fit", () => {
      expectProblem(
        problemsFor(
          [],
          mutated("bramblewick", (m) => ((m as { id: string }).id = "Bramble1")),
        ),
        "canary (bad id): the id is not lower case letters",
      );
      expectProblem(
        problemsFor(
          [],
          mutated("bramblewick", (m) => (m.name = "Bramble Wick")),
        ),
        "the name is not letters only",
      );
      expectProblem(
        problemsFor(
          [],
          mutated("bramblewick", (m) => (m.name = "Saltmarsh")),
        ),
        "the name is not the id with a capital letter",
      );
      expectProblem(
        problemsFor(
          [],
          mutated("bramblewick", (m) => ((m as { split: string }).split = "test")),
        ),
        "the split is not dev or heldout",
      );
      expectProblem(
        problemsFor(
          [],
          mutated("bramblewick", (m) => (m.clientLegalName = " ")),
        ),
        "the client legal name is empty or contains a dash",
      );
      expectProblem(
        problemsFor(
          [],
          mutated("saltmarsh", (m) => (m.document.kind = "amendment")),
        ),
        "canary saltmarsh: the matter's one document must be D1 and of kind nda",
      );
      expectProblem(
        problemsFor(
          [],
          mutated("saltmarsh", (m) => (m.document.label = "D2")),
        ),
        "canary saltmarsh: the matter's one document must be D1 and of kind nda",
      );
      expectProblem(
        problemsFor(
          [],
          mutated("saltmarsh", (m) => (m.document.file = "parol-saltmarsh-nda.docx")),
        ),
        "the file name must start with parol-canary-saltmarsh-",
      );
      expectProblem(
        problemsFor(
          [],
          mutated("saltmarsh", (m) => (m.document.versionNo = 2)),
        ),
        "the matter's document is version 1 and operative",
      );
      expectProblem(
        problemsFor(
          [],
          mutated("saltmarsh", (m) => (m.document.operative = false)),
        ),
        "the matter's document is version 1 and operative",
      );
      expectProblem(
        problemsFor(
          [],
          mutated(
            "saltmarsh",
            (m) =>
              (m.document.paragraphs[1] = {
                ...m.document.paragraphs[1]!,
                injected: true,
              } as never),
          ),
        ),
        "no paragraph of a canary matter is injected",
      );
    });

    it("text that the style rules refuse, like any other document", () => {
      const dashed = mutated("bramblewick", (m) =>
        m.document.paragraphs.push(text("An aside \u2014 with a dash")),
      );
      expectProblem(problemsFor([], dashed), "canary bramblewick");
      expect(problemsFor([], dashed).some((p) => p.includes("dash"))).toBe(true);
    });

    it("the same id twice, or a file name that a case already has", () => {
      expectProblem(
        problemsFor([], [BRAMBLEWICK, BRAMBLEWICK]),
        "canary bramblewick: the id is used twice",
      );
      const taken = changed(
        stand("PAROL-D10", "dev"),
        (c) => (c.documents[0]!.file = BRAMBLEWICK.document.file),
      );
      const problems = problemsFor([taken]);
      expectProblem(problems, "PAROL-D10: D1 file must start with parol-d10-");
      expectProblem(problems, "canary bramblewick: the file name is already used by PAROL-D10");
    });
  });

  it("fails the build with a TraceabilityError", async () => {
    const attempt = buildDataset({
      cases: [stand("PAROL-D10", "dev", "saltmarsh")],
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
    await expect(attempt).rejects.toBeInstanceOf(TraceabilityError);
  });

  it("never puts a canary string, a fact or document text in a message", () => {
    const all = [
      ...problemsFor([
        changed(D10(), (c) =>
          c.documents[0]!.paragraphs.push(text(`${BRAMBLEWICK.strings[0]!} ${BRAMBLEWICK_FACT}`)),
        ),
      ]),
      ...problemsFor(
        [],
        CANARY_MATTERS.map((m) =>
          changed(m, (copy) => (copy.strings = [...copy.strings, "CANARY-X-nothex000000"])),
        ),
      ),
      ...problemsFor([stand("PAROL-D10", "dev", "saltmarsh")]),
    ].join("\n");
    expect(all.length).toBeGreaterThan(0);
    for (const value of [
      ...BRAMBLEWICK.strings,
      ...SALTMARSH.strings,
      BRAMBLEWICK_FACT,
      SALTMARSH_FACT,
      "Pellam",
      "Wrenfield",
      "Maine",
    ]) {
      expect(all, value).not.toContain(value);
    }
    expect(all).not.toContain("CANARY-X-nothex000000");
  });

  it("builds a dataset from matters passed in, which is how the refusals above can be tried", async () => {
    const other: CanaryMatter = changed(SALTMARSH, (m) => {
      m.split = "dev";
    });
    const built = await buildDataset({
      cases: [stand("PAROL-D10", "dev", "saltmarsh")],
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
      canaryMatters: [BRAMBLEWICK, other],
    });
    expect(built.answerKeys.canary!.matters.map((m) => [m.id, m.split])).toEqual([
      ["saltmarsh", "dev"],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the case checker with canary matters", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "parol-checker-canary-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(definition: CaseDefinition, ...flags: string[]): { status: number; out: string } {
    const file = join(
      dir,
      `${definition.case.toLowerCase()}-${JSON.stringify(definition).length}.mts`,
    );
    writeFileSync(file, `export const CASE = ${JSON.stringify(definition)};\n`);
    try {
      const out = execFileSync(
        process.execPath,
        ["--import", "tsx", "evals/src/parol/check-case.ts", file, ...flags],
        {
          cwd: ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return { status: 0, out };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? -1,
        out: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      };
    }
  }

  it("accepts a case that names a matter, reads the matter's document with the real ingest, and prints the matter in the summary", () => {
    const result = run(D10(), "--summary");
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("canary matters in the same store: 1");
    expect(result.out).toContain(
      "bramblewick (dev): parol-canary-bramblewick-nda.docx, 4 canary strings, client Bramblewick Harbour Supply, Inc.",
    );
    expect(result.out).not.toContain("CANARY-BRAMBLEWICK");
    expect(result.out).toContain("ok: PAROL-D10");
  }, 120_000);

  it("prints nothing about canary matters for a case that names none", () => {
    const result = run(stand("PAROL-D10", "dev"), "--summary");
    expect(result.status, result.out).toBe(0);
    expect(result.out).not.toContain("canary");
  }, 120_000);

  it("refuses a matter of the other split, as the builder does", () => {
    const result = run(stand("PAROL-D10", "dev", "saltmarsh"));
    expect(result.status).toBe(1);
    expect(result.out).toContain(
      "the canary matter saltmarsh belongs to the heldout split and the case to the dev split",
    );
  }, 120_000);

  it("refuses a case whose document holds a canary string", () => {
    const result = run(
      changed(D10(), (c) =>
        c.documents[0]!.paragraphs.push(text(`Reference ${BRAMBLEWICK.strings[0]!} appears here.`)),
      ),
    );
    expect(result.status).toBe(1);
    expect(result.out).toContain("canary bramblewick: string 1 occurs in the case PAROL-D10");
    expect(result.out).not.toContain(BRAMBLEWICK.strings[0]!);
  }, 120_000);
});
