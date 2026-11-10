import { readdir, readFile, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadDataset,
  selectCases,
  CaseSelectionError,
  type Dataset,
} from "../src/parol/dataset.js";
import {
  REPO_ROOT,
  changeKey,
  copyRoot,
  editJson,
  filePath,
  makeTempDir,
  rehash,
  readKeys,
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
      {
        split: "heldout",
        sha256: recorded.splits.heldout!.sha256,
        recorded: recorded.splits.heldout!.sha256,
        matches: true,
      },
    ]);
    // Every file the keys name is loaded: the documents of the cases and their twins, the extra
    // files of the upload steps and the documents of the canary matters. Nothing else is on disk.
    const onDisk = await readdir(`${REPO_ROOT}/fixtures/parol/files`);
    expect([...loaded.dataset.files.keys()].sort()).toEqual(onDisk.sort());
    expect(loaded.dataset.files.size).toBe(
      recorded.splits.dev!.files + recorded.splits.heldout!.files,
    );
    expect(loaded.dataset.files.size).toBe(40);
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

  it("fails when one byte of an extra file of an upload step is altered, and names the case and the file", async () => {
    const keys = await readKeys(REPO_ROOT);
    const withExtra = keys.cases.filter((c) => (c.uploads?.files.length ?? 0) > 0);
    expect(withExtra.map((c) => c.case)).toContain("PAROL-H08");
    for (const entry of withExtra) {
      for (const extra of entry.uploads!.files) {
        const root = await freshRoot();
        const path = filePath(root, extra.file);
        const bytes = await readFile(path);
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x01;
        await writeFile(path, bytes);
        const loaded = await loadDataset(root);
        expect(loaded.ok, extra.file).toBe(false);
        if (loaded.ok) return;
        expect(loaded.problems, extra.file).toContain(
          `${entry.case} ${extra.file}: the file differs from the hash in the answer key`,
        );
        expect(
          loaded.problems.some((p) =>
            p.startsWith(`split ${entry.split}: the answer keys and files hash to`),
          ),
          extra.file,
        ).toBe(true);
      }
    }
  });

  it("fails when one byte of the document of a canary matter is altered, and names the matter and its split", async () => {
    const keys = await readKeys(REPO_ROOT);
    expect(keys.canary!.matters.map((m) => m.id)).toEqual(["bramblewick", "saltmarsh"]);
    for (const matter of keys.canary!.matters) {
      const root = await freshRoot();
      const path = filePath(root, matter.document.file);
      const bytes = await readFile(path);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x01;
      await writeFile(path, bytes);
      const loaded = await loadDataset(root);
      expect(loaded.ok, matter.id).toBe(false);
      if (loaded.ok) return;
      expect(loaded.problems, matter.id).toContain(
        `canary matter ${matter.id} ${matter.document.file}: the file differs from the hash in the answer key`,
      );
      // Only the split of the matter is affected: the other split's hash still holds.
      const other = matter.split === "dev" ? "heldout" : "dev";
      expect(
        loaded.problems.some((p) =>
          p.startsWith(`split ${matter.split}: the answer keys and files hash to`),
        ),
      ).toBe(true);
      expect(
        loaded.problems.some((p) =>
          p.startsWith(`split ${other}: the answer keys and files hash to`),
        ),
      ).toBe(false);
    }
  });

  it("fails when a file that only an upload step or a canary matter names is missing", async () => {
    const keys = await readKeys(REPO_ROOT);
    const extra = keys.cases.find((c) => c.case === "PAROL-H08")!.uploads!.files[0]!;
    const root = await freshRoot();
    await removeDir(filePath(root, extra.file));
    const missing = await loadDataset(root);
    expect(missing.ok).toBe(false);
    if (!missing.ok)
      expect(missing.problems).toContain(`PAROL-H08 ${extra.file}: the file is missing`);

    const matter = keys.canary!.matters[0]!;
    const root2 = await freshRoot();
    await removeDir(filePath(root2, matter.document.file));
    const lost = await loadDataset(root2);
    expect(lost.ok).toBe(false);
    if (!lost.ok) {
      expect(lost.problems).toContain(
        `canary matter ${matter.id} ${matter.document.file}: the file is missing`,
      );
    }
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
  const load = async (): Promise<Dataset> => {
    const loaded = await loadDataset(REPO_ROOT);
    if (!loaded.ok) throw new Error("the committed dataset must load");
    return loaded.dataset;
  };
  /** The dataset as it would be with only the cases of the splits kept: nothing else changes. */
  const only = (dataset: Dataset, ...keep: ("dev" | "heldout")[]): Dataset => ({
    ...dataset,
    keys: {
      ...dataset.keys,
      cases: dataset.keys.cases.filter((c) => keep.includes(c.split)),
      twins: dataset.keys.twins.filter((t) => keep.includes(t.split)),
    },
  });

  it("takes the dev split by default, with the injection twin of a chosen case", async () => {
    const dataset = await load();
    const [all] = selectCases(dataset, "dev", []);
    expect(all!.split).toBe("dev");
    expect(all!.cases.map((c) => c.case)).toEqual(
      Array.from({ length: 14 }, (_, i) => `PAROL-D${String(i + 1).padStart(2, "0")}`),
    );
    expect(all!.twins.map((t) => t.case)).toEqual(["PAROL-D08-twin", "PAROL-D10-twin"]);
    const [some] = selectCases(dataset, "dev", ["PAROL-D05"]);
    expect(some!.cases.map((c) => c.case)).toEqual(["PAROL-D05"]);
    expect(some!.twins).toEqual([]);
    expect(some!.splitCases).toBe(14);
    const [withTwin] = selectCases(dataset, "dev", ["PAROL-D08"]);
    expect(withTwin!.twins.map((t) => t.case)).toEqual(["PAROL-D08-twin"]);
    const [crossMatter] = selectCases(dataset, "dev", ["PAROL-D10"]);
    expect(crossMatter!.twins.map((t) => t.case)).toEqual(["PAROL-D10-twin"]);
  });

  it("selects the held-out split with the twins of H07 and H09", async () => {
    const dataset = await load();
    const [heldout] = selectCases(dataset, "heldout", []);
    expect(heldout!.split).toBe("heldout");
    expect(heldout!.cases.map((c) => c.case)).toEqual(
      Array.from({ length: 12 }, (_, i) => `PAROL-H${String(i + 1).padStart(2, "0")}`),
    );
    expect(heldout!.twins.map((t) => [t.case, t.twinOf])).toEqual([
      ["PAROL-H07-twin", "PAROL-H07"],
      ["PAROL-H09-twin", "PAROL-H09"],
    ]);
    expect(heldout!.splitCases).toBe(12);
    const [one] = selectCases(dataset, "heldout", ["PAROL-H07"]);
    expect(one!.twins.map((t) => t.case)).toEqual(["PAROL-H07-twin"]);
    // A held-out case is not a case of the dev split, and the other way round.
    expect(() => selectCases(dataset, "dev", ["PAROL-H07"])).toThrow(CaseSelectionError);
    expect(() => selectCases(dataset, "heldout", ["PAROL-D05"])).toThrow(CaseSelectionError);
  });

  it("refuses a case that is not there, a twin named as a case, and a split with no cases", async () => {
    const dataset = await load();
    expect(() => selectCases(dataset, "dev", ["PAROL-D99"])).toThrow(CaseSelectionError);
    expect(() => selectCases(dataset, "dev", ["PAROL-D08-twin"])).toThrow(CaseSelectionError);
    expect(() => selectCases(only(dataset, "dev"), "heldout", [])).toThrow(
      "The heldout split has no cases in this dataset.",
    );
    expect(() => selectCases(only(dataset, "heldout"), "dev", [])).toThrow(
      "The dev split has no cases in this dataset.",
    );
    // The message counts the unknown names and does not repeat them.
    try {
      selectCases(dataset, "dev", ["PAROL-D99", "secret-looking-input"]);
    } catch (error) {
      expect((error as Error).message).toContain("2 cases you named are not in the chosen split");
      expect((error as Error).message).not.toContain("secret-looking-input");
    }
  });

  it("selects both splits for `all`, and only those that have cases", async () => {
    const dataset = await load();
    expect(selectCases(dataset, "all", []).map((g) => g.split)).toEqual(["dev", "heldout"]);
    expect(selectCases(dataset, "all", []).map((g) => g.cases.length)).toEqual([14, 12]);
    expect(selectCases(only(dataset, "dev"), "all", []).map((g) => g.split)).toEqual(["dev"]);
    expect(selectCases(only(dataset, "heldout"), "all", []).map((g) => g.split)).toEqual([
      "heldout",
    ]);
    // A case named for `all` is found in whichever split holds it.
    expect(
      selectCases(dataset, "all", ["PAROL-D05", "PAROL-H05"]).map((g) => [
        g.split,
        g.cases.map((c) => c.case),
      ]),
    ).toEqual([
      ["dev", ["PAROL-D05"]],
      ["heldout", ["PAROL-H05"]],
    ]);
  });
});
