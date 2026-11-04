import { readFile, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDataset, selectCases, CaseSelectionError } from "../src/parol/dataset.js";
import {
  REPO_ROOT,
  changeKey,
  copyRoot,
  editJson,
  filePath,
  makeTempDir,
  rehash,
  relabelAsHeldout,
  removeDir,
} from "../src/parol/testing-run.js";
import type { SplitsFile } from "../../fixtures/parol/types.js";

let dir = "";
beforeAll(async () => {
  dir = await makeTempDir();
});
afterAll(async () => {
  await removeDir(dir);
});

let counter = 0;
const freshRoot = async (): Promise<string> => copyRoot(`${dir}/${++counter}`);

describe("the integrity check of the dataset", () => {
  it("passes for the committed dataset and recomputes the recorded hash of each split", async () => {
    const loaded = await loadDataset(REPO_ROOT);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const recorded = JSON.parse(
      await readFile(`${REPO_ROOT}/fixtures/parol/splits.json`, "utf8"),
    ) as SplitsFile;
    expect(loaded.dataset.integrity).toEqual([
      {
        split: "dev",
        sha256: recorded.splits.dev!.sha256,
        recorded: recorded.splits.dev!.sha256,
        matches: true,
      },
    ]);
    // Every file the keys name is loaded: six cases and one twin, nine files.
    expect(loaded.dataset.files.size).toBe(9);
    expect(loaded.dataset.label).toBe("parol-cases v1");
  });

  it("fails when one entry of an answer key is altered", async () => {
    const root = await freshRoot();
    // One status, in one case: the smallest change to a key that changes what a run is scored on.
    await changeKey(root, (keys) => {
      keys.cases.find((c) => c.case === "PAROL-D01")!.expect["dur-1"]!.status = "deviation";
    });
    const loaded = await loadDataset(root);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(
      loaded.problems.some((p) => p.startsWith("split dev: the answer keys and files hash to")),
    ).toBe(true);
    // No file changed, so no file is named.
    expect(loaded.problems.some((p) => p.includes("differs from the hash in the answer key"))).toBe(
      false,
    );
  });

  it("fails when one byte of one document is altered, and names the case and the file", async () => {
    const root = await freshRoot();
    const path = filePath(root, "parol-d05-amendment-1.txt");
    const bytes = await readFile(path);
    bytes[10] = bytes[10]! ^ 0x01;
    await writeFile(path, bytes);
    const loaded = await loadDataset(root);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.problems).toContain(
      "PAROL-D05 parol-d05-amendment-1.txt: the file differs from the hash in the answer key",
    );
    expect(
      loaded.problems.some((p) => p.startsWith("split dev: the answer keys and files hash to")),
    ).toBe(true);
  });

  it("fails when the splits file records a different hash", async () => {
    const root = await freshRoot();
    await editJson<SplitsFile>(`${root}/fixtures/parol/splits.json`, (splits) => {
      splits.splits.dev!.sha256 = "0".repeat(64);
    });
    const loaded = await loadDataset(root);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.problems).toEqual([
      expect.stringMatching(
        /^split dev: the answer keys and files hash to [0-9a-f]{12} but splits\.json records 000000000000$/,
      ),
    ]);
  });

  it("fails when a recorded total is not what the keys give, and when a file is missing", async () => {
    const root = await freshRoot();
    await editJson<SplitsFile>(`${root}/fixtures/parol/splits.json`, (splits) => {
      splits.splits.dev!.expectedFlags = 99;
    });
    const loaded = await loadDataset(root);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.problems).toEqual([
        'split dev: the recorded total "expectedFlags" is not what the keys give',
      ]);
    }

    const root2 = await freshRoot();
    await removeDir(filePath(root2, "parol-d03-nda.docx"));
    const missing = await loadDataset(root2);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.problems).toContain("PAROL-D03 parol-d03-nda.docx: the file is missing");
    }
  });

  it("fails for an unreadable or malformed file, and for a file name that is not a plain name", async () => {
    const root = await freshRoot();
    await writeFile(`${root}/fixtures/parol/answer-keys.json`, "{ not json");
    const broken = await loadDataset(root);
    expect(broken).toMatchObject({ ok: false, problems: ["answer-keys.json is not valid JSON"] });

    const root2 = await freshRoot();
    await changeKey(root2, (keys) => {
      keys.cases[0]!.documents[0]!.file = "../../../etc/passwd";
    });
    const unsafe = await loadDataset(root2);
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) {
      expect(unsafe.problems.join("\n")).toContain(
        "a document has a file name that is not a plain name",
      );
      // The name is not repeated: it came from a file that has not been verified.
      expect(unsafe.problems.join("\n")).not.toContain("passwd");
    }

    const root3 = await freshRoot();
    await removeDir(`${root3}/fixtures/parol/splits.json`);
    expect(await loadDataset(root3)).toMatchObject({
      ok: false,
      problems: ["splits.json cannot be read"],
    });
  });

  it("refuses a split that the keys hold but splits.json does not record", async () => {
    const root = await freshRoot();
    await editJson<SplitsFile>(`${root}/fixtures/parol/splits.json`, (splits) => {
      delete splits.splits.dev;
    });
    const loaded = await loadDataset(root);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.problems).toEqual([
        "split dev: the answer keys hold cases but splits.json records no hash",
      ]);
    }
  });

  it("is satisfied again once splits.json is rewritten, which is why the held-out hash is committed", async () => {
    const root = await freshRoot();
    await changeKey(root, (keys) => {
      keys.cases[0]!.expect["dur-1"]!.status = "deviation";
    });
    expect((await loadDataset(root)).ok).toBe(false);
    await rehash(root);
    expect((await loadDataset(root)).ok).toBe(true);
  });
});

describe("choosing cases", () => {
  it("takes the dev split by default, with the injection twin of a chosen case", async () => {
    const loaded = await loadDataset(REPO_ROOT);
    if (!loaded.ok) throw new Error("the committed dataset must load");
    const [all] = selectCases(loaded.dataset, "dev", []);
    expect(all!.cases.map((c) => c.case)).toEqual([
      "PAROL-D01",
      "PAROL-D03",
      "PAROL-D05",
      "PAROL-D06",
      "PAROL-D08",
      "PAROL-D12",
    ]);
    expect(all!.twins.map((t) => t.case)).toEqual(["PAROL-D08-twin"]);
    const [some] = selectCases(loaded.dataset, "dev", ["PAROL-D05"]);
    expect(some!.cases.map((c) => c.case)).toEqual(["PAROL-D05"]);
    expect(some!.twins).toEqual([]);
    expect(some!.splitCases).toBe(6);
    const [withTwin] = selectCases(loaded.dataset, "dev", ["PAROL-D08"]);
    expect(withTwin!.twins.map((t) => t.case)).toEqual(["PAROL-D08-twin"]);
  });

  it("refuses a case that is not there, a twin named as a case, and a split with no cases", async () => {
    const loaded = await loadDataset(REPO_ROOT);
    if (!loaded.ok) throw new Error("the committed dataset must load");
    expect(() => selectCases(loaded.dataset, "dev", ["PAROL-D99"])).toThrow(CaseSelectionError);
    expect(() => selectCases(loaded.dataset, "dev", ["PAROL-D08-twin"])).toThrow(
      CaseSelectionError,
    );
    expect(() => selectCases(loaded.dataset, "heldout", [])).toThrow(
      "The heldout split has no cases in this dataset.",
    );
    // The message counts the unknown names and does not repeat them.
    try {
      selectCases(loaded.dataset, "dev", ["PAROL-D99", "secret-looking-input"]);
    } catch (error) {
      expect((error as Error).message).toContain("2 cases you named are not in the chosen split");
      expect((error as Error).message).not.toContain("secret-looking-input");
    }
  });

  it("selects both splits for `all`, and only those that have cases", async () => {
    const root = await freshRoot();
    await relabelAsHeldout(root);
    const loaded = await loadDataset(root);
    if (!loaded.ok) throw new Error(loaded.problems.join("; "));
    expect(selectCases(loaded.dataset, "all", []).map((g) => g.split)).toEqual(["heldout"]);
    expect(selectCases(loaded.dataset, "heldout", []).map((g) => g.cases.length)).toEqual([6]);
  });
});
