import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../apps/parol/src/canonical.js";
import type { DocLabel, WarningCode } from "../../apps/parol/src/contracts.js";
import { parseDocument } from "../../apps/parol/src/ingest/parse.js";
import { documentTextSha256 } from "../../apps/parol/src/ingest/text-hash.js";
import { cleanup, makeWorld, newMatter } from "../../apps/parol/test/services/support.js";
import {
  TraceabilityError,
  analyzeCases,
  buildDataset,
  compareUploadStep,
  keyFileNames,
  orderWarnings,
  readPlaybookFacts,
  simulateUploads,
  splitHash,
  splitKeyParts,
  type BuiltDataset,
  type UploadFileFacts,
} from "../../fixtures/parol/build.js";
import { PLAYBOOK_FILE, PLAYBOOK_SLUG } from "../../fixtures/parol/cases.js";
import { D01 } from "../../fixtures/parol/cases/d01.js";
import { D05 } from "../../fixtures/parol/cases/d05.js";
import {
  addDocument,
  addVersion,
  identicalCopyOf,
  identicalFile,
  newDocument,
  newVersion,
  refused,
  resaveOf,
  sameText,
} from "../../fixtures/parol/draft.js";
import { renderDocx } from "../../fixtures/parol/render.js";
import type {
  CaseDefinition,
  SourceParagraph,
  UploadExpectation,
  UploadStep,
} from "../../fixtures/parol/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const YAML = readFileSync(join(ROOT, PLAYBOOK_FILE), "utf8");
const facts = readPlaybookFacts(YAML, PLAYBOOK_SLUG);

const problemsFor = (definitions: CaseDefinition[]): string[] =>
  analyzeCases(definitions, facts).problems;

function changed(definition: CaseDefinition, edit: (copy: CaseDefinition) => void): CaseDefinition {
  const copy = structuredClone(definition);
  edit(copy);
  return copy;
}

const stepsOf = (definition: CaseDefinition): UploadStep[] => definition.uploads!.steps;

// ---------------------------------------------------------------------------------------------
// Sample cases. They are test data and are not registered: the real cases are written elsewhere.
// ---------------------------------------------------------------------------------------------

const NDA = D01.documents[0]!;

/** D01's NDA with the last clause worded another way: the version that was replaced. */
function earlierText(): SourceParagraph[] {
  return NDA.paragraphs.map((paragraph) =>
    paragraph.kind === "clause" && paragraph.number === "8.2"
      ? {
          ...paragraph,
          text: "The Parties may sign separate copies of this Agreement, which together form one agreement.",
        }
      : paragraph,
  );
}

/**
 * Like PAROL-D09: version 1, then version 2 (which governs), then version 1 again under another
 * name. Every expectation is D01's, which holds for version 2.
 */
function sampleD09(): CaseDefinition {
  return {
    case: "PAROL-D09",
    split: "dev",
    phenomenon: "Sample: a second version that governs, and the first uploaded again",
    intake: { ...D01.intake },
    documents: [
      {
        ...NDA,
        file: "parol-d09-nda-v1.docx",
        operative: false,
        versionNo: 1,
        paragraphs: earlierText(),
      },
      { ...NDA, file: "parol-d09-nda-v2.docx", versionNo: 2, statedDate: "2026-03-24" },
    ],
    expect: structuredClone(D01.expect),
    warnings: ["duplicate_document"],
    uploads: {
      files: [identicalCopyOf("parol-d09-nda-v1.docx", "parol-d09-nda-v1-copy.docx")],
      steps: [
        addDocument(
          "parol-d09-nda-v1.docx",
          { label: "D1", title: NDA.title, kind: "nda", statedDate: NDA.statedDate },
          newDocument("D1"),
        ),
        addVersion("parol-d09-nda-v2.docx", "D1", "2026-03-24", newVersion("D1", 2)),
        addVersion(
          "parol-d09-nda-v1-copy.docx",
          "D1",
          NDA.statedDate,
          identicalFile("D1", 1, false),
        ),
      ],
    },
  };
}

/** Like PAROL-H08: a Word NDA, the same file under another name, and a re-save of it. */
function sampleH08Docx(): CaseDefinition {
  return {
    case: "PAROL-H08",
    split: "heldout",
    phenomenon: "Sample: the same file under two names, and a re-save with the same text",
    intake: { ...D01.intake },
    documents: [{ ...NDA, file: "parol-h08-nda.docx" }],
    expect: structuredClone(D01.expect),
    warnings: ["duplicate_document", "near_duplicate_version"],
    uploads: {
      files: [
        identicalCopyOf("parol-h08-nda.docx", "parol-h08-nda-copy.docx"),
        resaveOf("parol-h08-nda.docx", "parol-h08-nda-resaved.docx"),
      ],
      steps: [
        addDocument(
          "parol-h08-nda.docx",
          { label: "D1", title: NDA.title, kind: "nda", statedDate: NDA.statedDate },
          newDocument("D1"),
        ),
        addVersion("parol-h08-nda-copy.docx", "D1", null, identicalFile("D1", 1, true)),
        addVersion(
          "parol-h08-nda-resaved.docx",
          "D1",
          NDA.statedDate,
          sameText("D1", 2, { label: "D1", versionNo: 1 }),
        ),
      ],
    },
  };
}

/** The worked example with its amendment (a text file) uploaded twice and saved again. */
function sampleH08Txt(): CaseDefinition {
  const renamed = structuredClone(D05);
  renamed.case = "PAROL-H08";
  renamed.split = "heldout";
  for (const doc of renamed.documents) doc.file = doc.file.replace("parol-d05-", "parol-h08-");
  const [nda, amendment] = renamed.documents as [
    CaseDefinition["documents"][number],
    CaseDefinition["documents"][number],
  ];
  return {
    ...renamed,
    warnings: ["duplicate_document", "near_duplicate_version"],
    uploads: {
      files: [
        identicalCopyOf(amendment.file, "parol-h08-amendment-1-copy.txt"),
        resaveOf(amendment.file, "parol-h08-amendment-1-resaved.txt"),
      ],
      steps: [
        addDocument(
          nda.file,
          { label: "D1", title: nda.title, kind: "nda", statedDate: nda.statedDate },
          newDocument("D1"),
        ),
        addDocument(
          amendment.file,
          {
            label: "D2",
            title: amendment.title,
            kind: "amendment",
            statedDate: amendment.statedDate,
          },
          newDocument("D2"),
        ),
        addDocument(
          "parol-h08-amendment-1-copy.txt",
          {
            label: "D3",
            title: "Amendment again",
            kind: "amendment",
            statedDate: amendment.statedDate,
          },
          identicalFile("D2", 1, true),
        ),
        addVersion(
          "parol-h08-amendment-1-resaved.txt",
          "D2",
          amendment.statedDate,
          sameText("D2", 2, { label: "D2", versionNo: 1 }),
        ),
      ],
    },
  };
}

const SAMPLES: [string, () => CaseDefinition][] = [
  ["a second version and the first uploaded again", sampleD09],
  ["the same Word file twice and a Word re-save", sampleH08Docx],
  ["a text amendment twice and a text re-save", sampleH08Txt],
];

const builds = new Map<string, BuiltDataset>();
async function builtFor(definition: CaseDefinition): Promise<BuiltDataset> {
  const key = JSON.stringify(definition);
  const known = builds.get(key);
  if (known !== undefined) return known;
  const built = await buildDataset({
    cases: [definition],
    playbookYaml: YAML,
    playbookSlug: PLAYBOOK_SLUG,
  });
  builds.set(key, built);
  return built;
}

const bytesOf = (built: BuiltDataset): Map<string, Uint8Array> =>
  new Map(built.files.map((file) => [file.name, file.bytes]));

/** What the application and the real parser make of a file: the facts the rules are played on. */
async function realFacts(
  bytes: ReadonlyMap<string, Uint8Array>,
): Promise<Map<string, UploadFileFacts>> {
  const out = new Map<string, UploadFileFacts>();
  for (const [name, content] of bytes) {
    const parsed = await parseDocument({
      bytes: content,
      mediaType: name.endsWith(".docx") ? "docx" : "txt",
    });
    out.set(name, { bytesId: sha256Hex(content), textId: documentTextSha256(parsed.paragraphs) });
  }
  return out;
}

afterAll(cleanup);

// ---------------------------------------------------------------------------------------------

describe("the sample cases", () => {
  it.each(SAMPLES)("are sound: %s", (_name, sample) => {
    expect(problemsFor([sample()])).toEqual([]);
  });

  it("write the steps and the extra files into the answer key, and nothing for a case without them", async () => {
    const built = await builtFor(sampleH08Docx());
    const key = built.answerKeys.cases[0]!;
    expect(key.uploads).toEqual({
      files: [
        {
          file: "parol-h08-nda-copy.docx",
          kind: "identical_copy",
          of: "parol-h08-nda.docx",
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        {
          file: "parol-h08-nda-resaved.docx",
          kind: "resave",
          of: "parol-h08-nda.docx",
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ],
      steps: [
        {
          action: "addDocument",
          file: "parol-h08-nda.docx",
          label: "D1",
          title: "Mutual Confidentiality Agreement",
          kind: "nda",
          statedDate: "2026-03-10",
          expect: {
            effect: "new_document",
            label: "D1",
            versionNo: 1,
            operative: true,
            warnings: [],
          },
        },
        {
          action: "addVersion",
          file: "parol-h08-nda-copy.docx",
          label: "D1",
          statedDate: null,
          expect: {
            effect: "identical_file",
            label: "D1",
            versionNo: 1,
            operative: true,
            warnings: ["duplicate_document"],
          },
        },
        {
          action: "addVersion",
          file: "parol-h08-nda-resaved.docx",
          label: "D1",
          statedDate: "2026-03-10",
          expect: {
            effect: "same_text",
            label: "D1",
            versionNo: 2,
            operative: false,
            warnings: ["near_duplicate_version"],
            sameTextAs: { label: "D1", versionNo: 1 },
          },
        },
      ],
    });
    // The key lists the document of the case once; the extra files are not documents.
    expect(key.documents.map((d) => d.file)).toEqual(["parol-h08-nda.docx"]);
    expect(built.files.map((f) => f.name)).toEqual([
      "parol-h08-nda-copy.docx",
      "parol-h08-nda-resaved.docx",
      "parol-h08-nda.docx",
    ]);
    // A case with no uploads has no such field, not even an empty one.
    const plain = await buildDataset({
      cases: [D01],
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
    expect(Object.keys(plain.answerKeys.cases[0]!)).toEqual([
      "case",
      "split",
      "phenomenon",
      "intake",
      "documents",
      "expect",
      "warnings",
    ]);
  });

  it("write the warnings of a step in the order of the warning codes, whatever the author's order", async () => {
    const sample = changed(sampleH08Docx(), (c) => {
      const step = stepsOf(c)[2]!;
      if (step.expect.effect !== "same_text") throw new Error("sample changed");
      step.expect.warnings = ["instruction_like_text", "near_duplicate_version"];
      c.warnings.push("instruction_like_text");
    });
    // The text of the file raises nothing, so ingest does not add that code: the builder cannot
    // tell, and accepts it (the checker, which reads the file, does not).
    expect(problemsFor([sample])).toEqual([]);
    const key = (await builtFor(sample)).answerKeys.cases[0]!;
    const last = key.uploads!.steps[2]!.expect;
    expect(last.effect === "refused" ? [] : last.warnings).toEqual([
      "instruction_like_text",
      "near_duplicate_version",
    ]);
    expect(
      orderWarnings(["near_duplicate_version", "instruction_like_text", "duplicate_document"]),
    ).toEqual(["instruction_like_text", "duplicate_document", "near_duplicate_version"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the extra files", () => {
  it.each(SAMPLES)(
    "are an identical copy and a re-save that the real parser reads as described: %s",
    async (_name, sample) => {
      const built = await builtFor(sample());
      const bytes = bytesOf(built);
      const real = await realFacts(bytes);
      for (const extra of sample().uploads!.files ?? []) {
        const copy = bytes.get(extra.file)!;
        const source = bytes.get(extra.of)!;
        if (extra.kind === "identical_copy") {
          expect(Buffer.from(copy).equals(Buffer.from(source)), extra.file).toBe(true);
          expect(real.get(extra.file)).toEqual(real.get(extra.of));
        } else {
          expect(Buffer.from(copy).equals(Buffer.from(source)), extra.file).toBe(false);
          expect(real.get(extra.file)!.bytesId).not.toBe(real.get(extra.of)!.bytesId);
          expect(real.get(extra.file)!.textId, "the text is the same").toBe(
            real.get(extra.of)!.textId,
          );
        }
      }
    },
  );

  it("agree with the builder's prediction of which files are the same file and which have the same text", async () => {
    for (const [, make] of SAMPLES) {
      const sample = make();
      const analyzed = analyzeCases([sample], facts).cases[0]!;
      const real = await realFacts(bytesOf(await builtFor(sample)));
      const names = [...analyzed.uploads!.facts.keys()];
      expect(names.length).toBeGreaterThan(1);
      for (const a of names) {
        for (const b of names) {
          const predicted = analyzed.uploads!.facts.get(a)!;
          const actual = real.get(a)!;
          expect(predicted.bytesId === analyzed.uploads!.facts.get(b)!.bytesId, `${a} ${b}`).toBe(
            actual.bytesId === real.get(b)!.bytesId,
          );
          expect(predicted.textId === analyzed.uploads!.facts.get(b)!.textId, `${a} ${b}`).toBe(
            actual.textId === real.get(b)!.textId,
          );
        }
      }
    }
  });

  it("re-save a Word file by changing its properties and a text file by its line endings", async () => {
    const docx = bytesOf(await builtFor(sampleH08Docx()));
    const original = docx.get("parol-h08-nda.docx")!;
    const resaved = docx.get("parol-h08-nda-resaved.docx")!;
    const JSZip = (await import("jszip")).default;
    const before = await JSZip.loadAsync(original);
    const after = await JSZip.loadAsync(resaved);
    const names = Object.keys(before.files).sort();
    expect(Object.keys(after.files).sort()).toEqual(names);
    const differing: string[] = [];
    for (const name of names) {
      const a = await before.files[name]!.async("string");
      const b = await after.files[name]!.async("string");
      if (a !== b) differing.push(name);
    }
    expect(differing).toEqual(["docProps/core.xml"]);
    const core = await after.file("docProps/core.xml")!.async("string");
    expect(core).toContain("<cp:revision>2</cp:revision>");
    // Every zip entry still carries the fixed date, so the re-save is as reproducible as the file.
    expect([
      ...new Set(Object.values(after.files).map((entry) => entry.date.toISOString())),
    ]).toEqual(["2026-01-01T00:00:00.000Z"]);

    const txt = bytesOf(await builtFor(sampleH08Txt()));
    const lf = new TextDecoder().decode(txt.get("parol-h08-amendment-1.txt")!);
    const crlf = new TextDecoder().decode(txt.get("parol-h08-amendment-1-resaved.txt")!);
    expect(crlf).toBe(lf.replace(/\n/g, "\r\n"));
    expect(lf).not.toContain("\r");
  });

  it("are the same bytes in two builds, in two processes' worth of time, and on another day", async () => {
    const once = await builtFor(sampleH08Docx());
    const again = await buildDataset({
      cases: [sampleH08Docx()],
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2033-03-03T03:03:03Z"));
      const later = await buildDataset({
        cases: [sampleH08Docx()],
        playbookYaml: YAML,
        playbookSlug: PLAYBOOK_SLUG,
      });
      for (const built of [again, later]) {
        expect(built.files.map((f) => f.name)).toEqual(once.files.map((f) => f.name));
        for (const file of built.files) {
          const first = once.files.find((f) => f.name === file.name)!;
          expect(Buffer.from(file.bytes).equals(Buffer.from(first.bytes)), file.name).toBe(true);
        }
        expect(built.answerKeys).toEqual(once.answerKeys);
        expect(built.splits).toEqual(once.splits);
      }
    } finally {
      vi.useRealTimers();
    }
    // And the txt re-save.
    const txtOnce = await builtFor(sampleH08Txt());
    const txtAgain = await buildDataset({
      cases: [sampleH08Txt()],
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
    expect(txtAgain.splits).toEqual(txtOnce.splits);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------

describe("the hash of a split", () => {
  it("covers the extra files, the steps and what they expect", async () => {
    const built = await builtFor(sampleH08Docx());
    const key = built.answerKeys.cases[0]!;
    const files = built.files.map((f) => ({ name: f.name, bytes: new Uint8Array(f.bytes) }));
    const recorded = built.splits.splits.heldout!.sha256;
    const parts = splitKeyParts(built.answerKeys, "heldout");
    expect(splitHash(parts, files)).toBe(recorded);
    expect(built.splits.splits.heldout!.files).toBe(3);

    // One extra file less.
    expect(
      splitHash(
        parts,
        files.filter((f) => f.name !== "parol-h08-nda-copy.docx"),
      ),
    ).not.toBe(recorded);
    // One byte of the re-save.
    const flipped = files.map((f) =>
      f.name === "parol-h08-nda-resaved.docx"
        ? { name: f.name, bytes: Uint8Array.from(f.bytes, (b, i) => (i === 40 ? b ^ 1 : b)) }
        : f,
    );
    expect(splitHash(parts, flipped)).not.toBe(recorded);
    // One field of one step, and the order of two steps.
    const edit = (change: (copy: typeof key) => void): string => {
      const copy = structuredClone(key);
      change(copy);
      return splitHash({ cases: [copy], twins: [] }, files);
    };
    expect(edit((k) => (k.uploads!.steps[1]!.statedDate = "2026-03-10"))).not.toBe(recorded);
    expect(edit((k) => k.uploads!.steps.reverse())).not.toBe(recorded);
    expect(edit((k) => (k.uploads!.files[0]!.kind = "resave"))).not.toBe(recorded);
    expect(edit((k) => delete k.uploads)).not.toBe(recorded);
    // The file names are not in the way of the order the files come in.
    expect(splitHash(parts, [...files].reverse())).toBe(recorded);
  });

  it("moves with the bytes of a re-save when the document it is made from is reworded", async () => {
    const before = await builtFor(sampleH08Docx());
    const reworded = changed(sampleH08Docx(), (c) => {
      const paragraph = c.documents[0]!.paragraphs.find(
        (p) => p.kind === "clause" && p.number === "8.2",
      )!;
      if (paragraph.kind !== "clause") throw new Error("not a clause");
      paragraph.text =
        "The Parties may sign this Agreement in copies, which together form one agreement.";
    });
    const after = await builtFor(reworded);
    const hash = (built: BuiltDataset, name: string): string =>
      sha256Hex(built.files.find((f) => f.name === name)!.bytes);
    expect(hash(after, "parol-h08-nda-resaved.docx")).not.toBe(
      hash(before, "parol-h08-nda-resaved.docx"),
    );
    expect(after.splits.splits.heldout!.sha256).not.toBe(before.splits.splits.heldout!.sha256);
  });

  it("leaves the other split alone: a held-out case with uploads does not move the development hash", async () => {
    const dev = await buildDataset({
      cases: [D01],
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
    const both = await buildDataset({
      cases: [D01, sampleH08Docx()],
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
    expect(both.splits.splits.dev).toEqual(dev.splits.splits.dev);
    expect(both.splits.splits.heldout!.files).toBe(3);
    expect(both.splits.splits.heldout!.cases).toBe(1);
  });

  it("is recomputed from the committed keys by the same two helpers that the evaluation can use", async () => {
    const built = await builtFor(sampleD09());
    const names = keyFileNames(built.answerKeys);
    expect(names.sort()).toEqual([
      "parol-d09-nda-v1-copy.docx",
      "parol-d09-nda-v1.docx",
      "parol-d09-nda-v2.docx",
    ]);
    expect(keyFileNames(built.answerKeys, "heldout")).toEqual([]);
    const files = names.map((name) => ({ name, bytes: bytesOf(built).get(name)! }));
    expect(splitHash(splitKeyParts(built.answerKeys, "dev"), files)).toBe(
      built.splits.splits.dev!.sha256,
    );
    // Reading only the documents misses the copy, and the hash then differs: the reason for the helper.
    const documentsOnly = built.answerKeys.cases.flatMap((c) => c.documents.map((d) => d.file));
    expect(documentsOnly).not.toContain("parol-d09-nda-v1-copy.docx");
    const partial = documentsOnly.map((name) => ({ name, bytes: bytesOf(built).get(name)! }));
    expect(splitHash(splitKeyParts(built.answerKeys, "dev"), partial)).not.toBe(
      built.splits.splits.dev!.sha256,
    );
  });
});

// ---------------------------------------------------------------------------------------------

describe("what the builder refuses in the uploads of a case", () => {
  const expectProblem = (definition: CaseDefinition, fragment: string | RegExp): void => {
    const problems = problemsFor([definition]);
    expect(problems.length, "no problem was reported").toBeGreaterThan(0);
    expect(
      problems.some((p) =>
        typeof fragment === "string" ? p.includes(fragment) : fragment.test(p),
      ),
      problems.join("\n"),
    ).toBe(true);
  };

  it("an uploads field with no steps", () => {
    expectProblem(
      changed(sampleD09(), (c) => (c.uploads = { steps: [] })),
      "PAROL-D09: the uploads have no steps",
    );
  });

  it("a case with an injected paragraph, because its twin would need steps of its own", () => {
    expectProblem(
      changed(sampleD09(), (c) => {
        c.documents[1]!.paragraphs[1] = { ...c.documents[1]!.paragraphs[1]!, injected: true };
        c.warnings.push("instruction_like_text");
      }),
      "cannot have an injected paragraph",
    );
  });

  describe("an extra file", () => {
    const edit = (
      change: (extra: NonNullable<NonNullable<CaseDefinition["uploads"]>["files"]>[number]) => void,
    ) => changed(sampleD09(), (c) => change(c.uploads!.files![0]!));

    it("without the case prefix, with a bad name, or with a name already taken", () => {
      expectProblem(
        edit((e) => (e.file = "parol-d10-nda-copy.docx")),
        "PAROL-D09 extra file 0: the file name must start with parol-d09-",
      );
      expectProblem(
        edit((e) => (e.file = "Parol D09 copy.docx")),
        "extra file 0: the file name is not lower case words",
      );
      expectProblem(
        edit((e) => (e.file = "parol-d09-nda-v2.docx")),
        "extra file 0: the file name is already used by PAROL-D09",
      );
    });

    it("whose source is not a document of the case, or of another type, or of an unknown kind", () => {
      expectProblem(
        edit((e) => (e.of = "parol-d09-nothing.docx")),
        "extra file 0: `of` is not the file of a document of the case",
      );
      expectProblem(
        edit((e) => (e.file = "parol-d09-nda-v1-copy.txt")),
        "extra file 0: the file type differs",
      );
      expectProblem(
        edit((e) => (e.kind = "copy" as never)),
        "extra file 0: the kind is not identical_copy or resave",
      );
    });

    it("that has the name of a file of another case is refused by the prefix rule, so two cases cannot clash", () => {
      const other = changed(sampleD09(), (c) => {
        c.case = "PAROL-D10";
        for (const doc of c.documents) doc.file = doc.file.replace("parol-d09-", "parol-d10-");
        c.uploads = {
          files: [identicalCopyOf("parol-d10-nda-v1.docx", "parol-d10-nda-v1-copy.docx")],
          steps: stepsOf(sampleD09()).map((step) => ({
            ...step,
            file: step.file.replace("parol-d09-", "parol-d10-"),
          })),
        };
      });
      expect(problemsFor([sampleD09(), other])).toEqual([]);
      const clash = changed(
        sampleD09(),
        (c) => (c.uploads!.files![0]!.file = "parol-d10-nda-v1-copy.docx"),
      );
      expect(
        problemsFor([other, clash]).some((p) =>
          p.includes("PAROL-D09 extra file 0: the file name must start with parol-d09-"),
        ),
      ).toBe(true);
    });
  });

  describe("a step", () => {
    const first = (c: CaseDefinition): UploadStep => stepsOf(c)[0]!;
    const second = (c: CaseDefinition): UploadStep => stepsOf(c)[1]!;
    const third = (c: CaseDefinition): UploadStep => stepsOf(c)[2]!;

    it("that names a file the case does not have, a label that is not one, or a bad date or kind", () => {
      expectProblem(
        changed(sampleD09(), (c) => (first(c).file = "parol-d09-none.docx")),
        "upload step 1: the file is neither a document of the case nor an extra file",
      );
      expectProblem(
        changed(sampleD09(), (c) => (first(c).label = "D4" as DocLabel)),
        "upload step 1: the label is not D1, D2 or D3",
      );
      expectProblem(
        changed(sampleD09(), (c) => (second(c).statedDate = "24 March")),
        "upload step 2: the stated date is not an ISO date",
      );
      expectProblem(
        changed(sampleD09(), (c) => ((first(c) as { kind: string }).kind = "memo")),
        "upload step 1: the kind is not nda or amendment",
      );
      expectProblem(
        changed(sampleD09(), (c) => ((first(c) as { action: string }).action = "upload")),
        "upload step 1: the action is not addDocument or addVersion",
      );
    });

    it("whose entered title is empty, padded or has a dash", () => {
      for (const title of ["", " Mutual NDA", "Mutual \u2014 NDA"]) {
        expectProblem(
          changed(sampleD09(), (c) => ((first(c) as { title: string }).title = title)),
          "upload step 1: the title is empty",
        );
      }
    });

    it("with an expectation that is not one", () => {
      expectProblem(
        changed(sampleD09(), (c) => ((first(c) as { expect: unknown }).expect = undefined)),
        "upload step 1: the step has no expected outcome",
      );
      expectProblem(
        changed(sampleD09(), (c) => ((first(c).expect as { effect: string }).effect = "stored")),
        "the expected effect is not one of the upload effects",
      );
      expectProblem(
        changed(
          sampleD09(),
          (c) =>
            (third(c).expect = {
              ...(third(c).expect as object),
              versionNo: 0,
            } as UploadExpectation),
        ),
        "the expected version number is not a whole number from 1",
      );
      expectProblem(
        changed(
          sampleD09(),
          (c) =>
            (third(c).expect = {
              ...(third(c).expect as object),
              warnings: ["duplicate_document", "duplicate_document"],
            } as UploadExpectation),
        ),
        "an expected warning is listed twice",
      );
      expectProblem(
        changed(
          sampleD09(),
          (c) =>
            (third(c).expect = {
              ...(third(c).expect as object),
              warnings: ["whatever"],
            } as unknown as UploadExpectation),
        ),
        "an expected warning is not a Parol warning",
      );
      expectProblem(
        changed(sampleD09(), (c) => (third(c).expect = refused("nda_exists"))),
        "the application answers identical_file",
      );
      expectProblem(
        changed(
          sampleD09(),
          (c) =>
            (third(c).expect = {
              effect: "refused",
              code: "teapot",
            } as unknown as UploadExpectation),
        ),
        "the expected refusal is not one that can be played",
      );
    });

    it("that declares an identical copy as anything but identical", () => {
      expectProblem(
        changed(sampleD09(), (c) => (third(c).expect = newVersion("D1", 3))),
        "upload step 3: the application answers identical_file (the file has the bytes of a version already stored, so it is an identical file) and the step expects new_version",
      );
      expectProblem(
        changed(
          sampleD09(),
          (c) => (third(c).expect = sameText("D1", 3, { label: "D1", versionNo: 1 })),
        ),
        "the application answers identical_file",
      );
    });

    it("that declares a file as identical when it is not", () => {
      expectProblem(
        changed(sampleD09(), (c) => (second(c).expect = identicalFile("D1", 1, true))),
        "upload step 2: the application answers new_version (the file has text that no stored version has, so it is a new version that governs) and the step expects identical_file",
      );
    });

    it("that declares a re-save as a new version, or a new version as a re-save", () => {
      expectProblem(
        changed(sampleH08Docx(), (c) => (stepsOf(c)[2]!.expect = newVersion("D1", 2))),
        "upload step 3: the application answers same_text",
      );
      expectProblem(
        changed(
          sampleD09(),
          (c) => (second(c).expect = sameText("D1", 2, { label: "D1", versionNo: 1 })),
        ),
        "upload step 2: the application answers new_version",
      );
    });

    it("whose answer names the wrong document, version or operative flag", () => {
      expectProblem(
        changed(sampleD09(), (c) => (second(c).expect = newVersion("D1", 3))),
        "upload step 2: the answer names version 2, and the step expects 3",
      );
      expectProblem(
        changed(sampleD09(), (c) => (third(c).expect = identicalFile("D1", 1, true))),
        "upload step 3: that version is not operative afterwards, and the step expects operative",
      );
      expectProblem(
        changed(sampleD09(), (c) => (third(c).expect = identicalFile("D1", 2, false))),
        "upload step 3: the answer names version 1, and the step expects 2",
      );
      expectProblem(
        changed(sampleH08Txt(), (c) => (stepsOf(c)[2]!.expect = identicalFile("D3", 1, true))),
        "upload step 3: the answer names D2, and the step expects D3",
      );
    });

    it("whose warnings leave out a notice of the application or invent one", () => {
      expectProblem(
        changed(
          sampleD09(),
          (c) => ((third(c).expect as { warnings: WarningCode[] }).warnings = []),
        ),
        "upload step 3: the answer carries duplicate_document, and the step does not list it",
      );
      expectProblem(
        changed(
          sampleH08Docx(),
          (c) => ((stepsOf(c)[2]!.expect as { warnings: WarningCode[] }).warnings = []),
        ),
        "upload step 3: the answer carries near_duplicate_version, and the step does not list it",
      );
      expectProblem(
        changed(
          sampleD09(),
          (c) =>
            ((second(c).expect as { warnings: WarningCode[] }).warnings = ["duplicate_document"]),
        ),
        "upload step 2: the step lists duplicate_document, which neither the application's rules nor ingest of a file raise here",
      );
      expectProblem(
        changed(
          sampleD09(),
          (c) =>
            ((third(c).expect as { warnings: WarningCode[] }).warnings = [
              "duplicate_document",
              "instruction_like_text",
            ]),
        ),
        "upload step 3: the step lists instruction_like_text, and an identical file carries only duplicate_document",
      );
    });

    it("whose sameTextAs is missing, wrong, or given for a text that is new", () => {
      expectProblem(
        changed(
          sampleH08Docx(),
          (c) => delete (stepsOf(c)[2]!.expect as { sameTextAs?: unknown }).sameTextAs,
        ),
        "upload step 3: the text is that of D1 version 1, and sameTextAs says otherwise",
      );
      expectProblem(
        changed(
          sampleH08Docx(),
          (c) =>
            ((stepsOf(c)[2]!.expect as { sameTextAs: unknown }).sameTextAs = {
              label: "D1",
              versionNo: 2,
            }),
        ),
        "and sameTextAs says otherwise",
      );
      expectProblem(
        changed(
          sampleD09(),
          (c) =>
            ((second(c).expect as { sameTextAs?: unknown }).sameTextAs = {
              label: "D1",
              versionNo: 1,
            }),
        ),
        "upload step 2: sameTextAs is given and the text is not that of a stored version",
      );
    });

    it("that adds a version to a document no earlier step added", () => {
      expectProblem(
        changed(sampleD09(), (c) => {
          const [a, b, d] = stepsOf(c) as [UploadStep, UploadStep, UploadStep];
          c.uploads!.steps = [b, a, d];
        }),
        "upload step 1: addVersion names D1, which no earlier step added",
      );
    });

    it("that adds a document the application would give another label than the one meant", () => {
      expectProblem(
        changed(sampleD09(), (c) => (first(c).label = "D2")),
        "the application gives a new document the label D1, and the step means it to be D2",
      );
    });

    it("that the application refuses, when the step expects it to succeed, and the other way round", () => {
      const refusedAmendmentFirst = changed(sampleH08Txt(), (c) => {
        const [a, b, ...rest] = stepsOf(c);
        c.uploads!.steps = [b!, a!, ...rest];
      });
      expectProblem(
        refusedAmendmentFirst,
        "upload step 1: the application answers refused (the application refuses it) and the step expects new_document",
      );
      // Expecting the right refusal is accepted, as long as the documents still agree with what is stored.
      const withRefusal = changed(sampleH08Docx(), (c) => {
        c.uploads!.steps.splice(
          1,
          0,
          addDocument(
            "parol-h08-nda-resaved.docx",
            { label: "D2", title: "Again", kind: "nda", statedDate: null },
            refused("nda_exists"),
          ),
        );
      });
      expect(problemsFor([withRefusal])).toEqual([]);
      expectProblem(
        changed(withRefusal, (c) => (stepsOf(c)[1]!.expect = refused("nda_first"))),
        "upload step 2: the application refuses with nda_exists and the step expects nda_first",
      );
    });

    it("that enters a different stated date for a file the matter already holds", () => {
      const dated = changed(sampleD09(), (c) => (third(c).statedDate = "2026-03-11"));
      expectProblem(dated, "upload step 3: the application answers refused");
      const asRefusal = changed(dated, (c) => (third(c).expect = refused("duplicate_stated_date")));
      // A refused copy changes nothing, which the documents and warnings of the case then show.
      expect(problemsFor([asRefusal])).toEqual([
        "PAROL-D09: the case lists duplicate_document and no upload returns it",
      ]);
    });

    it("that exceeds three documents", () => {
      const crowded = changed(sampleH08Txt(), (c) => {
        c.uploads!.steps.push(
          addDocument(
            "parol-h08-nda-copy.docx",
            { label: "D3", title: "Extra", kind: "amendment", statedDate: null },
            refused("document_limit"),
          ),
        );
      });
      // The file does not exist as an extra file, so the step is reported for that first.
      expectProblem(
        crowded,
        "upload step 5: the file is neither a document of the case nor an extra file",
      );
    });
  });

  describe("documents that do not agree with the steps", () => {
    it("a file no step stores, a label, version number, date, operative flag, title or kind that differs", () => {
      expectProblem(
        changed(sampleD09(), (c) => c.uploads!.steps.pop()),
        "the case lists duplicate_document and no upload returns it",
      );
      expectProblem(
        changed(sampleD09(), (c) => (c.uploads!.steps = [stepsOf(c)[0]!, stepsOf(c)[2]!])),
        "PAROL-D09 D1 version 2: no step stores the file of this document",
      );
      expectProblem(
        changed(sampleD09(), (c) => (c.documents[1]!.versionNo = 3)),
        "PAROL-D09 D1 version 3: the steps store it as version 2 and the document says 3",
      );
      expectProblem(
        changed(sampleD09(), (c) => (c.documents[1]!.statedDate = "2026-03-25")),
        "PAROL-D09 D1 version 2: its stated date is not the date entered in the step that stores it",
      );
      expectProblem(
        changed(sampleD09(), (c) => (c.documents[0]!.operative = true)),
        "PAROL-D09 D1 version 1: the steps leave it not operative and the document says operative",
      );
      expectProblem(
        changed(sampleD09(), (c) => (c.documents[1]!.operative = false)),
        "PAROL-D09 D1 version 2: the steps leave it operative and the document says not operative",
      );
      expectProblem(
        changed(sampleD09(), (c) => (c.documents[1]!.title = "Another title")),
        "its title is not the title entered when the document was added",
      );
      expectProblem(
        changed(sampleH08Txt(), (c) => (c.documents[1]!.label = "D3")),
        "the steps store it as D2",
      );
    });

    it("a version that governs at the end although it is not a document of the case", () => {
      const swapped = changed(sampleH08Docx(), (c) => {
        // The re-save is uploaded first, so the original is then the near duplicate, and the version
        // that governs is a file the case does not list as a document.
        const [a, b, d] = stepsOf(c) as [UploadStep, UploadStep, UploadStep];
        const resaved = {
          ...d,
          action: "addDocument" as const,
          label: "D1" as const,
          title: NDA.title,
          kind: "nda" as const,
          expect: newDocument("D1"),
        } as UploadStep;
        c.uploads!.steps = [
          resaved,
          {
            ...a,
            action: "addVersion",
            label: "D1",
            expect: sameText("D1", 2, { label: "D1", versionNo: 1 }),
          } as UploadStep,
          b,
        ];
      });
      const problems = problemsFor([swapped]);
      expect(
        problems.some((p) =>
          p.includes(
            "the version that governs D1 at the end is an extra file, not a document of the case",
          ),
        ),
      ).toBe(true);
      expect(
        problems.some((p) =>
          p.includes("the steps leave it not operative and the document says operative"),
        ),
      ).toBe(true);
    });

    it("a warning an upload returns that the case does not list, and a notice no upload returns", () => {
      expectProblem(
        changed(sampleD09(), (c) => (c.warnings = [])),
        "PAROL-D09: an upload returns duplicate_document and the case does not list it in its warnings",
      );
      expectProblem(
        changed(sampleD09(), (c) => c.warnings.push("near_duplicate_version")),
        "PAROL-D09: the case lists near_duplicate_version and no upload returns it",
      );
    });

    it("two documents of the case with the same bytes, which the steps then cannot store twice", () => {
      const twice = changed(sampleH08Docx(), (c) => {
        c.documents.push({
          ...c.documents[0]!,
          label: "D2",
          kind: "amendment",
          file: "parol-h08-nda-two.docx",
        });
        c.uploads!.steps.push(
          addDocument(
            "parol-h08-nda-two.docx",
            { label: "D2", title: NDA.title, kind: "amendment", statedDate: NDA.statedDate },
            newDocument("D2"),
          ),
        );
      });
      const problems = problemsFor([twice]);
      expect(problems).toContain(
        "PAROL-H08 upload step 4: the application answers identical_file (the file has the bytes of a version already stored, so it is an identical file) and the step expects new_document",
      );
      expect(problems).toContain("PAROL-H08 D2 version 1: the steps store it as D1");
    });
  });

  it("never puts the text of a document in a message", () => {
    const messages = problemsFor([
      changed(sampleD09(), (c) => {
        c.uploads!.steps[2]!.expect = newVersion("D1", 3);
        c.documents[1]!.versionNo = 5;
      }),
    ]).join("\n");
    for (const word of [
      "Quillfeather",
      "Tidewater",
      "Confidentiality Agreement",
      "thirty (30) days",
    ]) {
      expect(messages).not.toContain(word);
    }
    expect(/[\u2013\u2014]/.test(messages)).toBe(false);
  });

  it("reports the problems of several steps together", () => {
    const problems = problemsFor([
      changed(sampleD09(), (c) => {
        c.uploads!.steps[1]!.expect = newVersion("D1", 4);
        c.uploads!.steps[2]!.expect = newVersion("D1", 3);
      }),
    ]);
    expect(problems.filter((p) => p.includes("upload step"))).toHaveLength(2);
  });

  it("fails the build, with a TraceabilityError, and names the case", async () => {
    const broken = changed(sampleD09(), (c) => (c.uploads!.steps[2]!.expect = newVersion("D1", 3)));
    const attempt = buildDataset({
      cases: [broken],
      playbookYaml: YAML,
      playbookSlug: PLAYBOOK_SLUG,
    });
    await expect(attempt).rejects.toBeInstanceOf(TraceabilityError);
    await expect(attempt).rejects.toThrow(/PAROL-D09 upload step 3/);
  });
});

// ---------------------------------------------------------------------------------------------
// The application agrees. Every step is played through the real upload service in a temporary
// store, and the answer, the stored version and the operative documents are compared with what the
// rules in build.ts say, which is what the key records.
// ---------------------------------------------------------------------------------------------

interface Actual {
  effect: string;
  label?: string;
  versionNo?: number;
  operative?: boolean;
  warnings?: string[];
  sameTextAs?: { label: string; versionNo: number };
  code?: string;
  stored?: boolean;
}

async function playThroughTheApplication(
  steps: readonly UploadStep[],
  bytes: ReadonlyMap<string, Uint8Array>,
  clientLegalName: string,
) {
  const w = makeWorld();
  const { matterId, am } = newMatter(w, "Replay");
  w.services.matters.update(am, { clientLegalName });
  const actual: Actual[] = [];
  for (const step of steps) {
    const content = bytes.get(step.file)!;
    const before = w.repo.listVersions(matterId).length;
    try {
      let result: {
        documentId?: string;
        versionId: string;
        warnings: { code: string; detail: string }[];
      };
      if (step.action === "addDocument") {
        result = await w.services.matters.addDocument(am, {
          title: step.title,
          kind: step.kind,
          fileName: step.file,
          bytes: content,
          statedDate: step.statedDate,
        });
      } else {
        const document = w.repo.listDocuments(matterId).find((d) => d.label === step.label);
        if (document === undefined) throw new Error(`no document ${step.label}`);
        result = await w.services.matters.addVersion(am, document.id, {
          fileName: step.file,
          bytes: content,
          statedDate: step.statedDate,
        });
      }
      const stored = w.repo.listVersions(matterId).length > before;
      const version = w.repo.getVersion(matterId, result.versionId)!;
      const label = w.repo.getDocument(matterId, version.documentId)!.label;
      const codes = result.warnings.map((x) => x.code);
      const near = result.warnings.find((x) => x.code === "near_duplicate_version");
      const match = near === undefined ? null : /^same text as (D\d) v(\d+),/.exec(near.detail);
      const effect = !stored
        ? "identical_file"
        : step.action === "addDocument"
          ? "new_document"
          : version.operative
            ? "new_version"
            : "same_text";
      actual.push({
        effect,
        label,
        versionNo: version.versionNo,
        operative: version.operative,
        warnings: [...codes].sort(),
        stored,
        ...(match === null
          ? {}
          : { sameTextAs: { label: match[1]!, versionNo: Number(match[2]) } }),
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === undefined) throw error;
      actual.push({ effect: "refused", code });
    }
  }
  const operative = w.repo.listOperativeDocuments(matterId).map((o) => ({
    label: o.document.label,
    sha256: o.version.fileSha256,
    versionNo: o.version.versionNo,
  }));
  const versions = w.repo.listVersions(matterId).map((v) => ({
    label: w.repo.getDocument(matterId, v.documentId)!.label,
    versionNo: v.versionNo,
    operative: v.operative,
    sha256: v.fileSha256,
  }));
  const view = w.services.matters.view(am);
  return { actual, operative, versions, start: view.start, status: view.matter.status };
}

function expectAgreement(
  steps: readonly UploadStep[],
  simulated: ReturnType<typeof simulateUploads>,
  actual: readonly Actual[],
): void {
  expect(actual).toHaveLength(steps.length);
  steps.forEach((step, i) => {
    const sim = simulated.steps[i]!;
    const real = actual[i]!;
    const at = `step ${i + 1} (${step.action} ${step.label} ${step.file})`;
    expect(real.effect, at).toBe(sim.effect);
    if (sim.effect === "refused") {
      expect(real.code, at).toBe(sim.code);
      return;
    }
    if (sim.effect === "invalid") throw new Error(`${at}: invalid step in a replay`);
    expect(real.label, at).toBe(sim.label);
    expect(real.versionNo, at).toBe(sim.versionNo);
    expect(real.operative, at).toBe(sim.operative);
    expect(real.stored, at).toBe(sim.stored);
    // The rules know the application's own notices; the file's own warnings are ingest's.
    const own = (real.warnings ?? []).filter(
      (code) => code === "duplicate_document" || code === "near_duplicate_version",
    );
    expect(own, at).toEqual(orderOf(sim.warnings));
    expect(real.sameTextAs, at).toEqual(sim.sameTextAs);
  });
}

const orderOf = (codes: readonly string[]): string[] => [...codes].sort();

describe("the application agrees with the rules the builder plays", () => {
  it.each(SAMPLES)("for the sample case: %s", async (_name, make) => {
    const sample = make();
    const built = await builtFor(sample);
    const bytes = bytesOf(built);
    const steps = stepsOf(sample);
    const real = await realFacts(bytes);
    const simulated = simulateUploads(steps, (file) => real.get(file));
    expect(simulated.problems).toEqual([]);

    // The rules say what the key says.
    steps.forEach((step, i) =>
      expect(compareUploadStep(step, simulated.steps[i]!), `step ${i + 1}`).toEqual([]),
    );

    const played = await playThroughTheApplication(steps, bytes, sample.intake.clientLegalName);
    expectAgreement(steps, simulated, played.actual);

    // Every step answers as the key's expectation says, in the application's own words.
    steps.forEach((step, i) => {
      const expected = step.expect;
      const got = played.actual[i]!;
      expect(got.effect).toBe(expected.effect);
      if (expected.effect === "refused") return;
      expect(got.label).toBe(expected.label);
      expect(got.versionNo).toBe(expected.versionNo);
      expect(got.operative).toBe(expected.operative);
      expect(got.warnings).toEqual(orderOf(expected.warnings));
      expect(got.sameTextAs).toEqual(expected.sameTextAs);
    });

    // The documents that govern at the end are the operative documents of the key.
    const key = built.answerKeys.cases[0]!;
    const governing = key.documents
      .filter((d) => d.operative)
      .map((d) => ({ label: d.label, sha256: d.sha256, versionNo: d.versionNo }));
    expect(played.operative).toEqual(governing);
    // Each stored version is a document of the key or an extra file of the case, and nothing else.
    const known = new Set([
      ...key.documents.map((d) => d.sha256),
      ...key.uploads!.files.map((f) => f.sha256),
    ]);
    for (const version of played.versions) expect(known.has(version.sha256)).toBe(true);
    // Each document of the key is stored, as the version number and flag the key says.
    for (const doc of key.documents) {
      expect(
        played.versions.find((v) => v.sha256 === doc.sha256),
        doc.file,
      ).toMatchObject({
        label: doc.label,
        versionNo: doc.versionNo,
        operative: doc.operative,
      });
    }
    // A re-save that the application stores does not govern.
    for (const extra of key.uploads!.files.filter((f) => f.kind === "resave")) {
      const stored = played.versions.find((v) => v.sha256 === extra.sha256);
      expect(stored, extra.file).toBeDefined();
      expect(stored!.operative, extra.file).toBe(false);
    }
  });

  it("for PAROL-D09 the application starts the review at once: the version uploaded last governs, and no version is left to choose", async () => {
    const sample = sampleD09();
    const built = await builtFor(sample);
    const played = await playThroughTheApplication(
      stepsOf(sample),
      bytesOf(built),
      sample.intake.clientLegalName,
    );
    expect(played.versions.map((v) => [v.label, v.versionNo, v.operative])).toEqual([
      ["D1", 1, false],
      ["D1", 2, true],
    ]);
    // The readiness check has a reason for "choose which version is operative", but the upload
    // service never leaves a document without an operative version, so it is not raised here.
    expect(played.start).toEqual({ ready: true, reasons: [] });
    expect(played.status).toBe("ready");
    const key = built.answerKeys.cases[0]!;
    expect(played.operative.map((o) => o.sha256)).toEqual([
      key.documents.find((d) => d.versionNo === 2)!.sha256,
    ]);
  });

  it("for a hand-made run of twelve steps that meets every refusal and every kind of answer", async () => {
    const built = await builtFor(sampleH08Txt());
    const files = bytesOf(built);
    const nda = "parol-h08-nda.docx";
    const am = "parol-h08-amendment-1.txt";
    // A Word file with other text, made the way the builder makes files.
    const edited = NDA.paragraphs.map((p) =>
      p.kind === "clause" && p.number === "8.2"
        ? { ...p, text: "A later wording of the closing clause of this Agreement." }
        : p,
    );
    files.set("edited-nda.docx", await renderDocx({ paragraphs: edited, title: NDA.title }));
    files.set(
      "nda-resaved.docx",
      await renderDocx(
        {
          paragraphs: structuredClone(D05.documents[0]!.paragraphs),
          title: D05.documents[0]!.title,
        },
        { resave: true },
      ),
    );
    const date = D05.documents[0]!.statedDate;
    const amDate = D05.documents[1]!.statedDate;
    const steps: UploadStep[] = [
      addDocument(
        am,
        { label: "D1", title: "An amendment first", kind: "amendment", statedDate: amDate },
        refused("nda_first"),
      ),
      addDocument(
        nda,
        { label: "D1", title: "Mutual NDA", kind: "nda", statedDate: date },
        newDocument("D1"),
      ),
      addDocument(
        am,
        { label: "D2", title: "Second NDA", kind: "nda", statedDate: amDate },
        refused("nda_exists"),
      ),
      addDocument(
        nda,
        { label: "D2", title: "The NDA again", kind: "amendment", statedDate: date },
        identicalFile("D1", 1, true),
      ),
      addDocument(
        nda,
        { label: "D2", title: "The NDA again", kind: "amendment", statedDate: "2031-01-01" },
        refused("duplicate_stated_date"),
      ),
      addDocument(
        am,
        { label: "D2", title: "Amendment No. 1", kind: "amendment", statedDate: amDate },
        newDocument("D2"),
      ),
      addDocument(
        "parol-h08-amendment-1-resaved.txt",
        { label: "D3", title: "Amendment saved again", kind: "amendment", statedDate: null },
        newDocument("D3", { sameTextAs: { label: "D2", versionNo: 1 } }),
      ),
      addDocument(
        "edited-nda.docx",
        { label: "D3", title: "A fourth document", kind: "amendment", statedDate: null },
        refused("document_limit"),
      ),
      addVersion("nda-resaved.docx", "D1", date, sameText("D1", 2, { label: "D1", versionNo: 1 })),
      addVersion("parol-h08-amendment-1-copy.txt", "D3", null, identicalFile("D2", 1, true)),
      addVersion("edited-nda.docx", "D1", date, newVersion("D1", 3)),
      addVersion(nda, "D2", null, identicalFile("D1", 1, false)),
    ];
    const real = await realFacts(files);
    const simulated = simulateUploads(steps, (file) => real.get(file));
    expect(simulated.problems).toEqual([]);
    steps.forEach((step, i) =>
      expect(compareUploadStep(step, simulated.steps[i]!), `step ${i + 1}`).toEqual([]),
    );
    const played = await playThroughTheApplication(steps, files, "Lanternfish Software, Inc.");
    expectAgreement(steps, simulated, played.actual);
    expect(played.versions.map((v) => [v.label, v.versionNo, v.operative])).toEqual([
      ["D1", 1, false],
      ["D1", 2, false],
      ["D1", 3, true],
      ["D2", 1, true],
      ["D3", 1, true],
    ]);
    expect(played.start.ready).toBe(true);
  }, 60_000);

  it("for a text that two documents share: the earlier upload is the one a notice names", async () => {
    const built = await builtFor(sampleH08Txt());
    const files = bytesOf(built);
    const amendment = "parol-h08-amendment-1.txt";
    const steps: UploadStep[] = [
      addDocument(
        "parol-h08-nda.docx",
        { label: "D1", title: "NDA", kind: "nda", statedDate: null },
        newDocument("D1"),
      ),
      addDocument(
        amendment,
        { label: "D2", title: "Amendment", kind: "amendment", statedDate: null },
        newDocument("D2"),
      ),
      addVersion(
        "parol-h08-amendment-1-resaved.txt",
        "D2",
        null,
        sameText("D2", 2, { label: "D2", versionNo: 1 }),
      ),
      addVersion("parol-h08-amendment-1-resaved.txt", "D1", null, identicalFile("D2", 2, false)),
    ];
    const real = await realFacts(files);
    const simulated = simulateUploads(steps, (file) => real.get(file));
    steps.forEach((step, i) =>
      expect(compareUploadStep(step, simulated.steps[i]!), `step ${i + 1}`).toEqual([]),
    );
    const played = await playThroughTheApplication(steps, files, "Lanternfish Software, Inc.");
    expectAgreement(steps, simulated, played.actual);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------------------------

describe("the case checker with uploads", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "parol-checker-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(definition: CaseDefinition, ...flags: string[]): { status: number; out: string } {
    const file = join(
      dir,
      `${definition.case.toLowerCase()}-${Math.abs(JSON.stringify(definition).length)}.mts`,
    );
    writeFileSync(file, `export const CASE = ${JSON.stringify(definition)};\n`);
    try {
      const out = execFileSync(
        process.execPath,
        ["--import", "tsx", "evals/src/parol/check-case.ts", file, ...flags],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
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

  it("accepts a case with uploads, checks them against the real parser, and prints them in the summary", () => {
    const result = run(sampleH08Docx(), "--summary");
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("uploads: 3 steps, 2 extra files");
    expect(result.out).toContain(
      "file parol-h08-nda-copy.docx: identical copy of parol-h08-nda.docx",
    );
    expect(result.out).toContain(
      "file parol-h08-nda-resaved.docx: re-save (same text, other bytes) of parol-h08-nda.docx",
    );
    expect(result.out).toContain(
      "step 2: addVersion to D1, parol-h08-nda-copy.docx, stated date none",
    );
    expect(result.out).toContain(
      "expects identical_file D1 v1, operative, warnings duplicate_document",
    );
    expect(result.out).toContain(
      "expects same_text D1 v2, not operative, warnings near_duplicate_version, same text as D1 v1",
    );
    expect(result.out).toContain(
      "warnings the case lists: duplicate_document near_duplicate_version",
    );
    expect(result.out).toContain("ok: PAROL-H08");
  }, 120_000);

  it("shows a reader every version and what the person uploads, and no expectation", () => {
    const result = run(sampleD09(), "--docs", "--no-ingest");
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("version 1, superseded");
    expect(result.out).toContain("version 2, operative");
    expect(result.out).toContain("what the person uploads, in order");
    expect(result.out).toContain(
      "step 3: add a version to D1 from parol-d09-nda-v1-copy.docx, stated date 2026-03-10",
    );
    expect(result.out).not.toContain("expects");
    expect(result.out).not.toContain("identical_file");
  }, 120_000);

  it("fails when a step is wrong, with the message of the builder", () => {
    const result = run(
      changed(sampleD09(), (c) => (c.uploads!.steps[2]!.expect = newVersion("D1", 3))),
    );
    expect(result.status).toBe(1);
    expect(result.out).toContain("PAROL-D09 upload step 3: the application answers identical_file");
  }, 120_000);

  it("fails when the steps leave a document in a state the key does not say", () => {
    const result = run(changed(sampleD09(), (c) => (c.documents[0]!.operative = true)));
    expect(result.status).toBe(1);
    expect(result.out).toContain(
      "the steps leave it not operative and the document says operative",
    );
  }, 120_000);

  it("fails when a code the real ingest raises for a stored file is not listed by the step", () => {
    // The file raises nothing, so listing a warning of ingest on its step is a claim the checker refutes.
    const result = run(
      changed(sampleD09(), (c) => {
        (c.uploads!.steps[1]!.expect as { warnings: WarningCode[] }).warnings = [
          "no_reviewable_text",
        ];
        c.warnings.push("no_reviewable_text");
      }),
    );
    expect(result.status).toBe(1);
    expect(result.out).toContain(
      "upload step 2: the answer carries none by the real ingest and the step lists no_reviewable_text",
    );
  }, 120_000);
});
