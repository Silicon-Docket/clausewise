import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnswerKeyFile, UploadStep } from "../../fixtures/parol/types.js";
import { EvalError } from "../src/errors.js";
import type { Dataset } from "../src/parol/dataset.js";
import { runUploadReplay, UploadReplayMismatch } from "../src/parol/exposure/index.js";
import { codeOf, show, type UploadReplayHooks } from "../src/parol/exposure/uploads.js";
import {
  DASHES,
  builtDataset,
  completeDataset,
  memoryDataset,
  never,
  playbook,
  ROOT,
} from "./parol-exposure-support.js";

/**
 * The upload replay: the application is played the upload steps of a case and has to do what the
 * key says. A mismatch is an `UploadReplayMismatch` (exit code 2) that names the case, the step and
 * the field, and holds no document text.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const replay = (dataset: Dataset, splits?: ("dev" | "heldout")[], hooks?: UploadReplayHooks) =>
  runUploadReplay({
    root: ROOT,
    dataset,
    playbook,
    signal: never(),
    ...(splits ? { splits } : {}),
    ...(hooks ? { hooks } : {}),
  });

type Edit = (keys: AnswerKeyFile) => void;
const step = (keys: AnswerKeyFile, caseKey: string, number: number): UploadStep =>
  keys.cases.find((entry) => entry.case === caseKey)!.uploads!.steps[number - 1]!;

/** Lower case, every run of white space made one space. */
const squash = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/** The text of a Word file's document part, without markup. */
async function textOfDocx(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")!.async("string");
  return xml
    .replace(/<\/w:p>/g, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function mismatch(
  edit: Edit,
  splits?: ("dev" | "heldout")[],
  hooks?: UploadReplayHooks,
): Promise<UploadReplayMismatch> {
  const error = await replay(await completeDataset(edit), splits, hooks).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(UploadReplayMismatch);
  const failure = error as UploadReplayMismatch;
  expect(failure.name).toBe("UploadReplayMismatch");
  expect(failure.exitCode).toBe(2);
  return failure;
}

describe("the application, played the upload steps of the cases", () => {
  it("does what the key says for D09: a first version, a second that governs, the first again", async () => {
    const result = await replay(await completeDataset());
    expect(result.cases).toEqual(["PAROL-D09"]);
    expect(result.steps).toBe(3);
    expect(result.sentence).toMatch(
      /^Upload replay: played the 3 upload steps of 1 case \(PAROL-D09\)/,
    );
    expect(result.sentence).not.toMatch(DASHES);
  });

  it("does what the key says for H08: the same file under two names and a re-save, when the split is named", async () => {
    const result = await replay(await completeDataset(), ["heldout"]);
    expect(result.cases).toEqual(["PAROL-H08"]);
    expect(result.steps).toBe(3);
  });

  it("covers an identical copy, a re-save and a new version between them", async () => {
    const built = await builtDataset();
    const effects = built.answerKeys.cases.flatMap((entry) =>
      (entry.uploads?.steps ?? []).map((s) => s.expect.effect),
    );
    expect(new Set(effects)).toEqual(
      new Set(["new_document", "new_version", "identical_file", "same_text"]),
    );
  });
});

describe("a step that the application does not carry out as the key says", () => {
  it("is named by case, step and field: an operative flag", async () => {
    const failure = await mismatch((keys) => {
      const s = step(keys, "PAROL-D09", 2);
      if (s.expect.effect === "refused") throw new Error("unexpected");
      s.expect.operative = false;
    });
    expect(failure.message).toContain("PAROL-D09 step 2 (addVersion)");
    expect(failure.message).toContain("field operative (expected false, got true)");
  });

  it("is named by its effect when the application stores what the key says it will not", async () => {
    const failure = await mismatch((keys) => {
      const s = step(keys, "PAROL-D09", 3);
      s.expect = {
        effect: "new_version",
        label: "D1",
        versionNo: 3,
        operative: true,
        warnings: [],
      };
    });
    expect(failure.message).toContain("PAROL-D09 step 3 (addVersion)");
    expect(failure.message).toMatch(/effect \(expected "new_version", got "identical_file"\)/);
    expect(failure.message).toContain("versionNo (expected 3, got 1)");
  });

  it("is named by its warnings", async () => {
    const failure = await mismatch((keys) => {
      const s = step(keys, "PAROL-D09", 3);
      if (s.expect.effect === "refused") throw new Error("unexpected");
      s.expect.warnings = [];
    });
    expect(failure.message).toContain('warnings (expected [], got ["duplicate_document"])');
  });

  it("is named by the refusal it expected and did not get", async () => {
    const failure = await mismatch((keys) => {
      step(keys, "PAROL-D09", 3).expect = { effect: "refused", code: "nda_exists" };
    });
    expect(failure.message).toContain("PAROL-D09 step 3");
    expect(failure.message).toContain('code (expected "nda_exists", got "no_refusal")');
  });

  it("is named by the refusal it got and did not expect", async () => {
    // A second NDA is refused, with a code.
    const failure = await mismatch((keys) => {
      const s = step(keys, "PAROL-D09", 2);
      keys.cases.find((entry) => entry.case === "PAROL-D09")!.uploads!.steps[1] = {
        action: "addDocument",
        file: s.file,
        label: "D1",
        title: "Another NDA",
        kind: "nda",
        statedDate: s.statedDate,
        expect: {
          effect: "new_document",
          label: "D1",
          versionNo: 1,
          operative: true,
          warnings: [],
        },
      };
    });
    expect(failure.message).toContain("PAROL-D09 step 2 (addDocument)");
    expect(failure.message).toMatch(/answer \(expected "new_document", got "refused_nda_exists"\)/);
  });

  it("is named by the version a re-save is the text of", async () => {
    const failure = await mismatch(
      (keys) => {
        const s = step(keys, "PAROL-H08", 3);
        if (s.expect.effect !== "same_text") throw new Error("unexpected");
        s.expect.sameTextAs = { label: "D1", versionNo: 7 };
      },
      ["heldout"],
    );
    expect(failure.message).toContain("PAROL-H08 step 3");
    expect(failure.message).toContain("sameTextAs");
  });

  it("is named after the last step when the version that governs is not the one the key says", async () => {
    const failure = await mismatch((keys) => {
      const documents = keys.cases.find((entry) => entry.case === "PAROL-D09")!.documents;
      documents.find((doc) => doc.versionNo === 2)!.operative = false;
      documents.find((doc) => doc.versionNo === 1)!.operative = true;
    });
    expect(failure.message).toContain("PAROL-D09 after the last step");
    expect(failure.message).toContain("final.D1.v2.operative (expected false, got true)");
    expect(failure.message).toContain("final.D1.v1.operative (expected true, got false)");
  });

  it("holds no document text, however the key is altered, and nothing but plain characters", async () => {
    const built = await builtDataset();
    const failure = await mismatch((keys) => {
      const s = step(keys, "PAROL-D09", 2);
      s.expect = {
        effect: "new_document",
        label: "D1",
        versionNo: 1,
        operative: false,
        warnings: ["duplicate_document"],
      };
    });
    expect(failure.message).toMatch(/^[\x20-\x7e]+$/);
    expect(failure.message.length).toBeLessThan(900);
    expect(failure.message).not.toMatch(/CANARY-[A-Z]+-[0-9a-f]{12}/i);
    // None of the title and no 24 character run of the text of the case's documents is in the message.
    const key = built.answerKeys.cases.find((entry) => entry.case === "PAROL-D09")!;
    expect(failure.message).not.toContain(key.documents[0]!.title);
    const message = squash(failure.message);
    for (const doc of key.documents) {
      const text = squash(
        await textOfDocx(built.files.find((file) => file.name === doc.file)!.bytes),
      );
      expect(text.length, doc.file).toBeGreaterThan(200);
      for (let at = 0; at + 24 <= text.length; at += 1)
        expect(message.includes(text.slice(at, at + 24)), `${doc.file} at ${at}`).toBe(false);
    }
    expect(failure.message).not.toMatch(DASHES);
  });

  it("does not show a value of the key that is text, even if the key held a run of the document's own words", async () => {
    // A label that is a run of the document's text: if the message showed it, the test above could
    // not tell, because it only looks at a key whose values are codes.
    const built = await builtDataset();
    const key = built.answerKeys.cases.find((entry) => entry.case === "PAROL-D09")!;
    const words = squash(
      await textOfDocx(built.files.find((f) => f.name === key.documents[0]!.file)!.bytes),
    )
      .slice(40, 70)
      .trim();
    expect(words.length).toBeGreaterThan(24);
    const failure = await mismatch((keys) => {
      const s = step(keys, "PAROL-D09", 2);
      if (s.expect.effect === "refused") throw new Error("unexpected");
      (s.expect as { label: string }).label = words;
    });
    expect(failure.message).toContain('label (expected (not shown), got "D1")');
    expect(squash(failure.message)).not.toContain(words);
  });

  it("stops a whole run, with the exit code of an integrity failure", async () => {
    const dataset = await completeDataset((keys) => {
      const s = step(keys, "PAROL-D09", 1);
      if (s.expect.effect === "refused") throw new Error("unexpected");
      s.expect.operative = false;
    });
    const { runExposureSuite } = await import("../src/parol/exposure/index.js");
    await expect(
      runExposureSuite({ root: ROOT, dataset, playbook, signal: never() }),
    ).rejects.toMatchObject({ name: "UploadReplayMismatch", exitCode: 2 });
  });
});

describe("every comparison of the replay can fail", () => {
  // A comparison that no test can fail is one that could be removed without anyone knowing. The
  // key is edited for what a key can disagree about, and a fault is planted in the store (between
  // a step and its comparison) for what the key cannot reach.
  const demoteAll = (
    site: { repo: { db: { prepare(sql: string): { run(...a: string[]): unknown } } } },
    matterId: string,
  ) =>
    site.repo.db
      .prepare("UPDATE document_versions SET operative = 0 WHERE matter_id = ?")
      .run(matterId);

  it("names the label of a step the key gives another document", async () => {
    const failure = await mismatch((keys) => {
      const s = step(keys, "PAROL-D09", 2);
      if (s.expect.effect === "refused") throw new Error("unexpected");
      s.expect.label = "D2";
    });
    expect(failure.message).toContain("PAROL-D09 step 2 (addVersion)");
    expect(failure.message).toContain('label (expected "D2", got "D1")');
  });

  it("names the labels of the documents at the end when the key relabels them", async () => {
    const failure = await mismatch((keys) => {
      for (const doc of keys.cases.find((entry) => entry.case === "PAROL-D09")!.documents)
        doc.label = "D2";
    });
    expect(failure.message).toContain("PAROL-D09 after the last step");
    expect(failure.message).toContain('documents (expected ["D2"], got ["D1"])');
  });

  it("names the stated date of a version at the end when the key says another", async () => {
    const failure = await mismatch((keys) => {
      keys.cases
        .find((entry) => entry.case === "PAROL-D09")!
        .documents.find((doc) => doc.versionNo === 2)!.statedDate = "2026-04-01";
    });
    expect(failure.message).toContain("PAROL-D09 after the last step");
    expect(failure.message).toContain(
      'final.D1.v2.statedDate (expected "2026-04-01", got "2026-03-20")',
    );
  });

  it("names the number of a version at the end when the key says another", async () => {
    const failure = await mismatch((keys) => {
      keys.cases
        .find((entry) => entry.case === "PAROL-D09")!
        .documents.find((doc) => doc.versionNo === 2)!.versionNo = 5;
    });
    expect(failure.message).toContain("PAROL-D09 after the last step");
    expect(failure.message).toContain("final.D1.v5.versionNo (expected 5, got 2)");
  });

  it("names a version that the key lists and the application never stored", async () => {
    // A file of another case, with its real hash, listed as a third version of D1.
    const failure = await mismatch((keys) => {
      const other = keys.cases.find((entry) => entry.case === "PAROL-D05")!.documents[0]!;
      const documents = keys.cases.find((entry) => entry.case === "PAROL-D09")!.documents;
      documents.push({ ...documents[0]!, versionNo: 3, file: other.file, sha256: other.sha256 });
    });
    expect(failure.message).toContain("PAROL-D09 after the last step");
    expect(failure.message).toContain("final.D1.v3.stored (expected true, got false)");
  });

  it("names the code of a refusal that is not the one the key expects", async () => {
    // A second NDA is refused as nda_exists, and the key says nda_first.
    const failure = await mismatch((keys) => {
      const s = step(keys, "PAROL-D09", 2);
      keys.cases.find((entry) => entry.case === "PAROL-D09")!.uploads!.steps[1] = {
        action: "addDocument",
        file: s.file,
        label: "D1",
        title: "Another NDA",
        kind: "nda",
        statedDate: s.statedDate,
        expect: { effect: "refused", code: "nda_first" },
      };
    });
    expect(failure.message).toContain("PAROL-D09 step 2 (addDocument)");
    expect(failure.message).toContain('code (expected "nda_first", got "nda_exists")');
    // It was refused, as the key says, and nothing was stored.
    expect(failure.message).not.toContain("storedDocuments");
    expect(failure.message).not.toContain("storedVersions");
  });

  it("names what a request that the key says is refused stored", async () => {
    // Step 2 is a new version, which the application stores. The key says it is refused.
    const failure = await mismatch((keys) => {
      step(keys, "PAROL-D09", 2).expect = { effect: "refused", code: "nda_exists" };
    });
    expect(failure.message).toContain("PAROL-D09 step 2 (addVersion)");
    expect(failure.message).toContain('code (expected "nda_exists", got "no_refusal")');
    expect(failure.message).toContain("storedVersions (expected 0, got 1)");
    expect(failure.message).not.toContain("storedDocuments");
  });

  it("names the document that a request the key says is refused stored", async () => {
    // Step 1 is a new document, which the application stores. The key says it is refused.
    const failure = await mismatch((keys) => {
      step(keys, "PAROL-D09", 1).expect = { effect: "refused", code: "nda_exists" };
    });
    expect(failure.message).toContain("PAROL-D09 step 1 (addDocument)");
    expect(failure.message).toContain('code (expected "nda_exists", got "no_refusal")');
    expect(failure.message).toContain("storedDocuments (expected 0, got 1)");
    expect(failure.message).toContain("storedVersions (expected 0, got 1)");
  });

  it("names the stated date of a step that the store holds otherwise than the step gave", async () => {
    // The step's date is the one it was given, so no key edit disagrees with it: a fault does.
    const failure = await mismatch(() => {}, undefined, {
      afterStep: (site, { matterId, step: number }) => {
        if (number === 2)
          site.repo.db
            .prepare(
              "UPDATE document_versions SET stated_date = '2001-01-01' WHERE matter_id = ? AND version_no = 2",
            )
            .run(matterId);
      },
    });
    expect(failure.message).toContain("PAROL-D09 step 2 (addVersion)");
    expect(failure.message).toContain('statedDate (expected "2026-03-20", got "2001-01-01")');
  });

  it("names a document with no governing version after a step whose own version is not meant to govern", async () => {
    // Step 3 is an identical copy of the first file, which is not operative either way. Nothing
    // else compared at that step sees that the version that governed has stopped doing so.
    const failure = await mismatch(() => {}, undefined, {
      afterStep: (site, { matterId, step: number }) => {
        if (number === 3) demoteAll(site, matterId);
      },
    });
    expect(failure.message).toContain("PAROL-D09 step 3 (addVersion)");
    expect(failure.message).toContain("operativeVersions (expected 1, got 0)");
    expect(failure.message).not.toContain("operative (expected");
  });

  it("names a document with no governing version at the end", async () => {
    const failure = await mismatch(() => {}, undefined, {
      beforeFinal: (site, { matterId }) => demoteAll(site, matterId),
    });
    expect(failure.message).toContain("PAROL-D09 after the last step");
    expect(failure.message).toContain("final.D1.operativeVersions (expected 1, got 0)");
  });
});

describe("what a message may show", () => {
  it("shows numbers, booleans and null, and words that are codes or labels", () => {
    expect(show(3)).toBe("3");
    expect(show(false)).toBe("false");
    expect(show(null)).toBe("null");
    expect(show("nda_exists")).toBe('"nda_exists"');
    expect(show("D1")).toBe('"D1"');
    expect(show("2026-03-20")).toBe('"2026-03-20"');
    expect(show(["duplicate_document", 2])).toBe('["duplicate_document", 2]');
  });

  it("does not show text, a word too long for a code, or anything that is not a plain value", () => {
    expect(show("the Recipient shall hold in confidence")).toBe("(not shown)");
    expect(show("a".repeat(41))).toBe("(not shown)");
    expect(show("")).toBe("(not shown)");
    expect(show("line\nbreak")).toBe("(not shown)");
    expect(show(undefined)).toBe("(not shown)");
    expect(show({ text: "x" })).toBe("(not shown)");
    expect(show(["fine_code", "not a code"])).toBe('["fine_code", (not shown)]');
  });

  it("takes the code of a refusal, the name of an error if that is a plain word, and nothing else", () => {
    expect(codeOf({ code: "nda_exists" })).toBe("nda_exists");
    expect(codeOf(Object.assign(new Error("x"), { code: "bad_body" }))).toBe("bad_body");
    // A code that is not a code is not shown; the name is, if it is a plain word.
    expect(
      codeOf({ code: "the Recipient shall hold in confidence", name: "ValidationError" }),
    ).toBe("ValidationError");
    expect(codeOf({ code: "Upper_Case", name: "Not A Word" })).toBe("unknown");
    expect(codeOf({ code: "x".repeat(41), name: "x".repeat(41) })).toBe("unknown");
    expect(codeOf("a string")).toBe("unknown");
    expect(codeOf(null)).toBe("unknown");
  });
});

describe("the files of a dataset that was loaded the way the command loads it", () => {
  let root = "";
  let loaded: Dataset;

  beforeAll(async () => {
    // A repository root with the files that the builder wrote, and a dataset that holds only the
    // files the cases and twins name as documents, as `loadDataset` reads them.
    root = await mkdtemp(join(tmpdir(), "parol-exposure-test-root-"));
    const dir = join(root, "fixtures", "parol", "files");
    await mkdir(dir, { recursive: true });
    const built = await builtDataset();
    for (const file of built.files) await writeFile(join(dir, file.name), file.bytes);
    loaded = await memoryDataset();
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("reads an extra file (an identical copy, a re-save) from the files folder", async () => {
    // The dataset does not hold them: they are not documents of the case.
    expect(
      [...loaded.files.keys()].some(
        (name) => name.endsWith("resaved.docx") || name.endsWith("copy.docx"),
      ),
    ).toBe(false);
    const result = await runUploadReplay({
      root,
      dataset: loaded,
      playbook,
      signal: never(),
      splits: ["heldout"],
    });
    expect(result.steps).toBe(3);
  });

  it("refuses a file whose bytes are not the ones the key hashes, with an integrity exit code", async () => {
    const name = (await readdir(join(root, "fixtures", "parol", "files"))).find(
      (n) => n.includes("h08") && n.includes("resaved"),
    )!;
    expect(name).toBeDefined();
    const path = join(root, "fixtures", "parol", "files", name);
    const { readFile } = await import("node:fs/promises");
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from("x")]));
    try {
      const error = await runUploadReplay({
        root,
        dataset: loaded,
        playbook,
        signal: never(),
        splits: ["heldout"],
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(EvalError);
      expect((error as EvalError).exitCode).toBe(2);
      expect((error as EvalError).message).toMatch(/differs from the hash/);
    } finally {
      await writeFile(path, original);
    }
  });

  it("refuses a file that is not there", async () => {
    const gone = await mkdtemp(join(tmpdir(), "parol-exposure-test-empty-"));
    try {
      await expect(
        runUploadReplay({
          root: gone,
          dataset: loaded,
          playbook,
          signal: never(),
          splits: ["heldout"],
        }),
      ).rejects.toThrow(/is missing/);
    } finally {
      await rm(gone, { recursive: true, force: true });
    }
  });

  it("refuses a file name that is not a plain name", async () => {
    const odd = await completeDataset((keys) => {
      keys.cases.find((entry) => entry.case === "PAROL-H08")!.uploads!.files[0]!.file =
        "../escape.docx";
    });
    await expect(replay(odd, ["heldout"])).rejects.toThrow(/not a plain name/);
  });
});
