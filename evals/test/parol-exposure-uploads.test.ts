import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnswerKeyFile, UploadStep } from "../../fixtures/parol/types.js";
import { EvalError } from "../src/errors.js";
import type { Dataset } from "../src/parol/dataset.js";
import { runUploadReplay, UploadReplayMismatch } from "../src/parol/exposure/index.js";
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

const replay = (dataset: Dataset, splits?: ("dev" | "heldout")[]) =>
  runUploadReplay({
    root: ROOT,
    dataset,
    playbook,
    signal: never(),
    ...(splits ? { splits } : {}),
  });

type Edit = (keys: AnswerKeyFile) => void;
const step = (keys: AnswerKeyFile, caseKey: string, number: number): UploadStep =>
  keys.cases.find((entry) => entry.case === caseKey)!.uploads!.steps[number - 1]!;

async function mismatch(edit: Edit, splits?: ("dev" | "heldout")[]): Promise<UploadReplayMismatch> {
  const error = await replay(await completeDataset(edit), splits).then(
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
    // None of the title or any 24 character run of the documents' text is in the message.
    const text = built.answerKeys.cases.find((entry) => entry.case === "PAROL-D09")!.documents[0]!
      .title;
    expect(failure.message).not.toContain(text);
    expect(failure.message).not.toMatch(DASHES);
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
