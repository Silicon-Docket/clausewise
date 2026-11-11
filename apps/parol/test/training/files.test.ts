import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { authorizeMatter } from "../../src/auth/authorize.js";
import { sha256Hex } from "../../src/canonical.js";
import { parseDocument } from "../../src/ingest/parse.js";
import { DEFAULT_TRAINING_DIR, readTrainingFile } from "../../src/training/files.js";
import { T01 } from "../../src/training/t01.js";
import { ConflictError, DEMO_USER_IDS } from "../../src/store/index.js";
import {
  TRAINING_FILE_NAMES,
  buildTrainingFiles,
  trainingNdaParagraphs,
} from "../../../../tools/parol-training-files.js";
import { D05 } from "../../../../fixtures/parol/cases/d05.js";
import { D08 } from "../../../../fixtures/parol/cases/d08.js";
import { expandDocument } from "../../../../fixtures/parol/render.js";
import { ROOT } from "../integration/pipeline.js";
import { cleanupWorlds, simulatedWorld } from "./support.js";
import { seedDemo } from "../../src/seed.js";

/**
 * The two files of the training matter. They are built from the evaluation cases by
 * tools/parol-training-files.ts, committed under apps/parol/training, and read from there by the
 * application. Every document and party in them is synthetic.
 */

afterAll(cleanupWorlds);

const TRAINING = DEFAULT_TRAINING_DIR;

describe("the committed files", () => {
  it("are what the builder makes from the cases, byte for byte (what pnpm fixtures:parol:training --check compares)", async () => {
    const built = await buildTrainingFiles();
    expect(built.map((f) => f.name)).toEqual([...TRAINING_FILE_NAMES]);
    for (const file of built) {
      const committed = readFileSync(join(TRAINING, file.name));
      expect(sha256Hex(committed), file.name).toBe(sha256Hex(file.bytes));
      expect(committed.byteLength).toBe(file.bytes.byteLength);
    }
    // Nothing else is in the folder.
    expect(readdirSync(TRAINING).sort()).toEqual([...TRAINING_FILE_NAMES].sort());
  });

  it("are the files T01 names, with the titles and dates of the matter", () => {
    expect(T01.documents.map((d) => d.fileName)).toEqual([...TRAINING_FILE_NAMES]);
    expect(T01.documents.map((d) => [d.kind, d.statedDate])).toEqual([
      ["nda", "2026-02-02"],
      ["amendment", "2026-09-15"],
    ]);
    // The dates are the worked example's.
    expect(T01.documents.map((d) => d.statedDate)).toEqual(D05.documents.map((d) => d.statedDate));
    expect(T01.clientLegalName).toBe(D05.intake.clientLegalName);
  });

  it("make a NDA that is D05's with the instruction paragraph of D08 at index 1, and nothing else different", async () => {
    const parsed = await parseDocument({
      bytes: readTrainingFile("t01-nda.docx"),
      mediaType: "docx",
    });
    const d05 = D05.documents.find((d) => d.label === "D1")!;
    const expected = expandDocument(d05).map((p) => p.text);
    const note = D08.documents
      .find((d) => d.label === "D1")!
      .paragraphs.find((p) => p.injected === true)!;
    expect(note.kind).toBe("text");
    const texts = parsed.paragraphs.map((p) => p.text);
    expect(texts).toEqual([expected[0], (note as { text: string }).text, ...expected.slice(1)]);
    expect(texts).toHaveLength(expected.length + 1);
    // The builder's own list is the same: the title first, then the note, then the rest.
    expect(trainingNdaParagraphs().map((p) => p.kind)).toEqual([
      "title",
      "text",
      ...d05.paragraphs.slice(1).map((p) => p.kind),
    ]);
  });

  it("make an amendment that is the amendment of D05 byte for byte", () => {
    const amendment = readFileSync(join(TRAINING, "t01-amendment-1.txt"));
    expect(
      amendment.equals(
        readFileSync(join(ROOT, "fixtures", "parol", "files", "parol-d05-amendment-1.txt")),
      ),
    ).toBe(true);
  });

  it("are reached through the root script that rebuilds and checks them", () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<
      string,
      string
    >;
    expect(scripts["fixtures:parol:training"]).toBe("tsx tools/make-parol-training.ts");
    expect(readFileSync(join(ROOT, ".prettierignore"), "utf8").split("\n")).toContain(
      "apps/parol/training",
    );
  });
});

describe("reading a file", () => {
  it("refuses a name that is not one of T01's documents before any path is made", () => {
    for (const name of [
      "../../package.json",
      "t01-nda.docx/../x",
      "/etc/passwd",
      "",
      "T01-NDA.DOCX",
    ])
      expect(() => readTrainingFile(name), name).toThrow(TypeError);
  });

  it("says that a file is missing with a fixed message that names no path", () => {
    let caught: unknown;
    try {
      readTrainingFile("t01-nda.docx", join(simulatedWorld().root, "not-there"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).code).toBe("training_files_missing");
    expect((caught as Error).message).not.toMatch(/[\\/]/);
    expect((caught as Error).message).not.toContain("t01");
  });
});

describe("uploading them", () => {
  it("raises exactly one warning on the NDA, an instruction to software at the second paragraph, and none on the amendment", async () => {
    const w = simulatedWorld();
    const report = await seedDemo({ repo: w.repo, files: w.files, training: true });
    const am = authorizeMatter(
      w.repo,
      w.principal(DEMO_USER_IDS.associate),
      report.training!.matterId,
      "matter.read",
    );
    const warnings = w.services.matters.view(am).warnings;
    expect(warnings.map((x) => [x.code, x.documentLabel, x.spanLabel])).toEqual([
      ["instruction_like_text", "D1", "D1-p1"],
    ]);
  });
});
