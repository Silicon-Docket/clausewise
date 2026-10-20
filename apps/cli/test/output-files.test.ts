import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createOracleGenerator } from "@clausewise/review/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type CliIo } from "../src/index.js";
import { createFile } from "../src/output.js";
import { compliantScript, listing, makeIo, playbookPath, stage, tempDirs } from "./support.js";

const PLAYBOOK = playbookPath("nda-mutual.yaml");
const SENTINEL = "an earlier file that must survive";
const SUFFIXES = ["redlined.docx", "report.json", "summary.md"];

type WriteFile = NonNullable<CliIo["writeFile"]>;

/** The real file creation, with a note of every file it is asked for. */
function recording(): {
  writeFile: WriteFile;
  calls: { path: string; mode: number | undefined }[];
} {
  const calls: { path: string; mode: number | undefined }[] = [];
  return {
    calls,
    writeFile: async (path, data, mode) => {
      calls.push({ path, mode });
      await createFile(path, data, mode);
    },
  };
}

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

async function setup(makeDir: () => Promise<string>) {
  const dir = await makeDir();
  const input = await stage(dir, "nda-balanced.docx");
  const paths = SUFFIXES.map((suffix) => join(dir, `nda-balanced.${suffix}`));
  const generator = createOracleGenerator(compliantScript());
  return { dir, input, paths, generator };
}

describe("the permissions of the outputs", () => {
  const makeDir = tempDirs();
  let umask: number;

  beforeEach(() => {
    // Zero, so that what a file ends up with is what the command asked for and not what the
    // umask happened to hide.
    umask = process.umask(0);
  });
  afterEach(() => {
    process.umask(umask);
  });

  it.each([
    [0o600, 0o600],
    [0o400, 0o400],
    [0o640, 0o640],
    [0o644, 0o644],
    [0o664, 0o644],
    [0o666, 0o644],
    [0o755, 0o755],
    [0o777, 0o755],
  ])("a contract with mode %o gives outputs with mode %o", async (inputMode, expected) => {
    const { input, paths, generator } = await setup(makeDir);
    await chmod(input, inputMode);
    const { io } = makeIo({ generator });

    expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(0);

    for (const path of paths) expect(await modeOf(path)).toBe(expected);
  });

  it("never gives outputs more than the umask allows", async () => {
    const { input, paths, generator } = await setup(makeDir);
    await chmod(input, 0o644);
    process.umask(0o077);
    const { io } = makeIo({ generator });

    expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(0);

    for (const path of paths) expect(await modeOf(path)).toBe(0o600);
  });

  it("keeps a private contract's outputs private when they go to another folder", async () => {
    const { dir, input, generator } = await setup(makeDir);
    await chmod(input, 0o600);
    await mkdir(join(dir, "elsewhere"));
    const out = join(dir, "elsewhere", "marked-up.docx");
    const { io } = makeIo({ generator });

    expect(await run(["review", input, "--playbook", PLAYBOOK, "--out", out], io)).toBe(0);

    expect(await modeOf(out)).toBe(0o600);
  });

  it("gives a file it replaces under --force the mode of the contract, not the old file's", async () => {
    const { input, paths, generator } = await setup(makeDir);
    await chmod(input, 0o600);
    for (const path of paths) {
      await writeFile(path, SENTINEL);
      await chmod(path, 0o666);
    }
    const { io } = makeIo({ generator });

    expect(await run(["review", input, "--playbook", PLAYBOOK, "--force"], io)).toBe(0);

    for (const path of paths) {
      expect(await readFile(path, "utf8")).not.toBe(SENTINEL);
      expect(await modeOf(path)).toBe(0o600);
    }
  });
});

describe("how the outputs are written", () => {
  const makeDir = tempDirs();

  it("writes each one under a hidden temporary name in its own folder, then renames it", async () => {
    const { dir, input, paths, generator } = await setup(makeDir);
    await chmod(input, 0o640);
    const { writeFile: spy, calls } = recording();
    const { io } = makeIo({ generator });
    io.writeFile = spy;

    expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(0);

    const staged = calls.filter(({ path }) => !basename(path).startsWith(".clausewise-probe"));
    expect(staged).toHaveLength(3);
    for (const { path, mode } of staged) {
      expect(dirname(path)).toBe(dir);
      expect(basename(path)).toMatch(/^\.nda-balanced\.[a-z.]+\.[0-9a-f]{12}\.tmp$/);
      expect(paths).not.toContain(path);
      expect(mode).toBe(0o640);
    }
    // Nothing of the staging is left.
    expect(await listing(dir)).toEqual(
      ["nda-balanced.docx", ...SUFFIXES.map((suffix) => `nda-balanced.${suffix}`)].sort(),
    );
    expect((await readdir(dir)).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("moves nothing into place until every output is written", async () => {
    const { dir, input, paths, generator } = await setup(makeDir);
    for (const path of paths) await writeFile(path, SENTINEL);
    const { io } = makeIo({ generator });
    const seen: string[][] = [];
    io.writeFile = async (path, data, mode) => {
      if (basename(path).includes("summary.md")) {
        seen.push(await Promise.all(paths.map((existing) => readFile(existing, "utf8"))));
      }
      await createFile(path, data, mode);
    };

    expect(await run(["review", input, "--playbook", PLAYBOOK, "--force"], io)).toBe(0);

    // While the last file was being written, the first two were still the old ones.
    expect(seen).toEqual([[SENTINEL, SENTINEL, SENTINEL]]);
    for (const path of paths) expect(await readFile(path, "utf8")).not.toBe(SENTINEL);
    expect(await listing(dir)).toHaveLength(4);
  });

  it("replaces an existing file instead of rewriting it, so no other name for it changes", async () => {
    const { dir, input, paths, generator } = await setup(makeDir);
    const [redlined = ""] = paths;
    await writeFile(redlined, SENTINEL);
    const other = join(dir, "other-name-for-the-old-file");
    await link(redlined, other);
    const { io } = makeIo({ generator });

    expect(await run(["review", input, "--playbook", PLAYBOOK, "--force"], io)).toBe(0);

    expect(await readFile(other, "utf8")).toBe(SENTINEL);
    expect(await readFile(redlined, "utf8")).not.toBe(SENTINEL);
  });

  it("removes a file that was only half written when the disk fills up", async () => {
    const { dir, input, generator } = await setup(makeDir);
    const { io, stderr } = makeIo({ generator });
    io.writeFile = async (path, data, mode) => {
      if (!basename(path).includes("report.json")) return createFile(path, data, mode);
      await createFile(path, "{ half a report", mode);
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    };

    expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(1);

    expect(stderr()).toContain("no space left on the device");
    expect(await listing(dir)).toEqual(["nda-balanced.docx"]);
  });

  it("takes back what it already moved into place when a later move fails", async () => {
    const { dir, input, paths, generator } = await setup(makeDir);
    const [redlined = "", report = ""] = paths;
    const { io, stderr, stdout } = makeIo({ generator });
    io.writeFile = async (path, data, mode) => {
      // While the summary is staged, something turns the report's name into a folder.
      if (basename(path).includes("summary.md")) await mkdir(report);
      await createFile(path, data, mode);
    };

    expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(1);

    expect(stderr()).toContain(
      `Could not write the report to ${report}: it is not a regular file.`,
    );
    expect(stderr()).toContain("The review finished, but its results were not saved.");
    expect(stdout()).toBe("");
    expect(await listing(dir)).toEqual(["nda-balanced.docx", "nda-balanced.report.json"]);
    expect((await lstat(report)).isDirectory()).toBe(true);
    await expect(lstat(redlined)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("a move that fails after others went through, under --force", () => {
  const makeDir = tempDirs();

  it("puts back the files it had replaced", async () => {
    const { dir, input, paths, generator } = await setup(makeDir);
    const [redlined = "", report = "", summary = ""] = paths;
    for (const path of [redlined, report]) {
      await writeFile(path, SENTINEL);
      await chmod(path, 0o640);
    }
    const { io, stderr, stdout } = makeIo({ generator });
    io.writeFile = async (path, data, mode) => {
      // The summary has no file yet, and while it is staged its name turns into a folder.
      if (basename(path).includes("summary.md")) await mkdir(summary);
      await createFile(path, data, mode);
    };

    expect(await run(["review", input, "--playbook", PLAYBOOK, "--force"], io)).toBe(1);

    expect(stderr()).toContain(
      `Could not write the summary to ${summary}: it is not a regular file.`,
    );
    expect(stdout()).toBe("");
    for (const path of [redlined, report]) {
      expect(await readFile(path, "utf8")).toBe(SENTINEL);
      expect(await modeOf(path)).toBe(0o640);
    }
    // Neither temporary files nor the second names kept for the way back are left.
    expect(await listing(dir)).toEqual([
      "nda-balanced.docx",
      "nda-balanced.redlined.docx",
      "nda-balanced.report.json",
      "nda-balanced.summary.md",
    ]);
  });
});

describe("links and files at the output paths", () => {
  const makeDir = tempDirs();

  it.each([false, true])(
    "refuses a dangling symbolic link and creates nothing through it (--force: %s)",
    async (force) => {
      const { dir, input, paths, generator } = await setup(makeDir);
      const [, report = ""] = paths;
      const victim = join(dir, "created-by-clausewise.txt");
      await symlink(victim, report);
      const { io, stderr } = makeIo({ generator });

      const code = await run(
        ["review", input, "--playbook", PLAYBOOK, ...(force ? ["--force"] : [])],
        io,
      );

      expect(code).toBe(1);
      expect(stderr()).toContain(`to ${report}: it is a symbolic link.`);
      expect(generator.calls).toHaveLength(0);
      await expect(lstat(victim)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(report)).isSymbolicLink()).toBe(true);
      expect(await listing(dir)).toEqual(["nda-balanced.docx", "nda-balanced.report.json"]);
    },
  );

  it("refuses a link to another file even with --force and leaves that file alone", async () => {
    const { dir, input, paths, generator } = await setup(makeDir);
    const [, report = ""] = paths;
    const victim = join(dir, "somebody-elses-notes.txt");
    await writeFile(victim, SENTINEL);
    await symlink(victim, report);
    const { io, stderr } = makeIo({ generator });

    expect(await run(["review", input, "--playbook", PLAYBOOK, "--force"], io)).toBe(1);

    expect(stderr()).toContain("it is a symbolic link.");
    expect(await readFile(victim, "utf8")).toBe(SENTINEL);
    expect(generator.calls).toHaveLength(0);
  });

  it("does not write through a hard link to another file when replacing under --force", async () => {
    const { dir, input, paths, generator } = await setup(makeDir);
    const [, report = ""] = paths;
    const victim = join(dir, "somebody-elses-notes.txt");
    await writeFile(victim, SENTINEL);
    await link(victim, report);
    const { io } = makeIo({ generator });

    expect(await run(["review", input, "--playbook", PLAYBOOK, "--force"], io)).toBe(0);

    expect(await readFile(victim, "utf8")).toBe(SENTINEL);
    expect(JSON.parse(await readFile(report, "utf8"))).toHaveProperty("counts");
  });

  it("refuses a link that appears while the files are being staged, and writes nothing through it", async () => {
    const { dir, input, paths, generator } = await setup(makeDir);
    const [redlined = ""] = paths;
    const victim = join(dir, "created-by-clausewise.txt");
    const { io, stderr } = makeIo({ generator });
    io.writeFile = async (path, data, mode) => {
      if (basename(path).includes("summary.md")) await symlink(victim, redlined);
      await createFile(path, data, mode);
    };

    expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(1);

    expect(stderr()).toContain("it is a symbolic link.");
    await expect(lstat(victim)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await listing(dir)).toEqual(["nda-balanced.docx", "nda-balanced.redlined.docx"]);
    expect((await lstat(redlined)).isSymbolicLink()).toBe(true);
  });

  it("does not replace a file that appears while the files are being staged, without --force", async () => {
    const { dir, input, paths, generator } = await setup(makeDir);
    const [, report = ""] = paths;
    const { io, stderr } = makeIo({ generator });
    io.writeFile = async (path, data, mode) => {
      if (basename(path).includes("summary.md")) await writeFile(report, SENTINEL);
      await createFile(path, data, mode);
    };

    expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(1);

    expect(stderr()).toContain(`Could not write the report to ${report}: a file appeared there`);
    expect(await readFile(report, "utf8")).toBe(SENTINEL);
    expect(await listing(dir)).toEqual(["nda-balanced.docx", "nda-balanced.report.json"]);
  });
});

describe("a folder that cannot be written to", () => {
  const makeDir = tempDirs();

  const refusingProbe = (folder: string): WriteFile => {
    return async (path, data, mode) => {
      if (dirname(path) === folder && basename(path).startsWith(".clausewise-probe")) {
        throw Object.assign(new Error("EACCES: leaked detail"), { code: "EACCES" });
      }
      await createFile(path, data, mode);
    };
  };

  it("is found out before the first model call and before anything is announced as sent", async () => {
    const { dir, input, generator } = await setup(makeDir);
    const { io, stderr, stdout } = makeIo({ generator });
    io.writeFile = refusingProbe(dir);

    const code = await run(["review", input, "--playbook", PLAYBOOK], io);

    expect(code).toBe(1);
    expect(stderr()).toContain(
      `Error: Cannot write to the folder for the redlined contract: ${dir} (permission denied). ` +
        "Nothing was sent to the model.",
    );
    expect(stderr()).not.toContain("leaked detail");
    expect(stderr()).not.toContain("Sending the contract text");
    expect(generator.calls).toHaveLength(0);
    expect(stdout()).toBe("");
    expect(await listing(dir)).toEqual(["nda-balanced.docx"]);
  });

  it("looks at the folder of an output given with --report, not only the default one", async () => {
    const { dir, input, generator } = await setup(makeDir);
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere);
    const { io, stderr } = makeIo({ generator });
    io.writeFile = refusingProbe(elsewhere);

    const code = await run(
      ["review", input, "--playbook", PLAYBOOK, "--report", join(elsewhere, "r.json")],
      io,
    );

    expect(code).toBe(1);
    expect(stderr()).toContain(`folder for the report: ${elsewhere} `);
    expect(generator.calls).toHaveLength(0);
    expect(await listing(elsewhere)).toEqual([]);
  });

  it("is checked with a file that is created and removed again, once for each folder", async () => {
    const { dir, input, generator } = await setup(makeDir);
    const { writeFile: spy, calls } = recording();
    const { io } = makeIo({ generator });
    io.writeFile = spy;

    expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(0);

    const probes = calls.filter(({ path }) => basename(path).startsWith(".clausewise-probe"));
    expect(probes).toHaveLength(1);
    expect(dirname(probes[0]?.path ?? "")).toBe(dir);
    expect((await readdir(dir)).filter((name) => name.includes("probe"))).toEqual([]);
  });

  // Root can write anywhere, so the permission bits prove nothing for it.
  it.skipIf(process.getuid?.() === 0)(
    "is found out on a real read-only folder before the model is called",
    async () => {
      const { dir, input, generator } = await setup(makeDir);
      await chmod(dir, 0o500);
      const { io, stderr } = makeIo({ generator });

      try {
        expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(1);
      } finally {
        await chmod(dir, 0o700);
      }

      expect(stderr()).toContain("Cannot write to the folder for the redlined contract");
      expect(generator.calls).toHaveLength(0);
    },
  );
});
