import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ObjectGenerator } from "@clausewise/llm";
import { createOracleGenerator } from "@clausewise/review/testing";
import { describe, expect, it } from "vitest";
import { run, type CliIo } from "../src/index.js";
import { createFile } from "../src/output.js";
import {
  bytesOf,
  compliantScript,
  listing,
  makeIo,
  playbookPath,
  same,
  stage,
  tempDirs,
} from "./support.js";

const PLAYBOOK = playbookPath("nda-mutual.yaml");
const SENTINEL = "an earlier file that must survive";

describe("outputs that already exist", () => {
  const makeDir = tempDirs();

  async function setup(): Promise<{
    dir: string;
    input: string;
    generator: ReturnType<typeof createOracleGenerator>;
  }> {
    const dir = await makeDir();
    return {
      dir,
      input: await stage(dir, "nda-balanced.docx"),
      generator: createOracleGenerator(compliantScript()),
    };
  }

  it.each(["redlined.docx", "report.json", "summary.md"])(
    "refuses to replace an existing %s and names it",
    async (suffix) => {
      const { dir, input, generator } = await setup();
      const existing = join(dir, `nda-balanced.${suffix}`);
      await writeFile(existing, SENTINEL);
      const { io, stderr, stdout } = makeIo({ generator });

      const code = await run(["review", input, "--playbook", PLAYBOOK], io);

      expect(code).toBe(1);
      expect(stderr()).toContain(`Refusing to overwrite an existing file:\n  ${existing}\n`);
      expect(stderr()).toContain("--force");
      expect(stdout()).toBe("");
      // The refusal comes before anything is sent, and nothing else is written.
      expect(generator.calls).toHaveLength(0);
      expect(stderr()).not.toContain("Sending the contract text");
      expect(await listing(dir)).toEqual(["nda-balanced.docx", `nda-balanced.${suffix}`].sort());
      expect(await readFile(existing, "utf8")).toBe(SENTINEL);
    },
  );

  it("names every existing output when there are several", async () => {
    const { dir, input, generator } = await setup();
    const first = join(dir, "nda-balanced.redlined.docx");
    const second = join(dir, "nda-balanced.summary.md");
    await writeFile(first, SENTINEL);
    await writeFile(second, SENTINEL);
    const { io, stderr } = makeIo({ generator });

    expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(1);

    expect(stderr()).toContain(`Refusing to overwrite existing files:\n  ${first}\n  ${second}\n`);
  });

  it("replaces them all with --force", async () => {
    const { dir, input, generator } = await setup();
    const paths = ["redlined.docx", "report.json", "summary.md"].map((suffix) =>
      join(dir, `nda-balanced.${suffix}`),
    );
    for (const path of paths) await writeFile(path, SENTINEL);
    const { io } = makeIo({ generator });

    expect(await run(["review", input, "--playbook", PLAYBOOK, "--force"], io)).toBe(0);

    for (const path of paths) expect(await readFile(path, "utf8")).not.toBe(SENTINEL);
    expect(same(await bytesOf(paths[0] ?? ""), await bytesOf(input))).toBe(true);
    expect(JSON.parse(await readFile(paths[1] ?? "", "utf8"))).toHaveProperty("counts");
  });

  it("checks the paths given with --out, --report and --summary too", async () => {
    const { dir, input, generator } = await setup();
    const taken = join(dir, "mine.json");
    await writeFile(taken, SENTINEL);
    const { io, stderr } = makeIo({ generator });

    const code = await run(["review", input, "--playbook", PLAYBOOK, "--report", taken], io);

    expect(code).toBe(1);
    expect(stderr()).toContain(taken);
    expect(await listing(dir)).toEqual(["mine.json", "nda-balanced.docx"]);
  });

  it("does not replace a file that appeared while the review was running", async () => {
    const { dir, input } = await setup();
    const racing = join(dir, "nda-balanced.report.json");
    const inner = createOracleGenerator(compliantScript());
    const generator: ObjectGenerator = {
      provider: inner.provider,
      model: inner.model,
      disclosure: inner.disclosure,
      async generate(request) {
        await writeFile(racing, SENTINEL, { flag: "w" });
        return inner.generate(request);
      },
    };
    const { io, stderr } = makeIo({ generator });

    expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(1);

    expect(stderr()).toContain(racing);
    expect(await readFile(racing, "utf8")).toBe(SENTINEL);
    expect(await listing(dir)).toEqual(["nda-balanced.docx", "nda-balanced.report.json"]);
  });
});

describe("the input file", () => {
  const makeDir = tempDirs();

  async function expectRefused(args: (input: string) => string[], alias?: string): Promise<void> {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    if (alias !== undefined) await symlink(input, join(dir, alias));
    const before = await bytesOf(input);
    const generator = createOracleGenerator(compliantScript());
    const { io, stderr } = makeIo({ generator });

    const code = await run(["review", input, "--playbook", PLAYBOOK, ...args(input)], io);

    expect(code).toBe(1);
    expect(stderr()).toContain("Refusing to overwrite the input file");
    expect(same(await bytesOf(input), before)).toBe(true);
    expect(generator.calls).toHaveLength(0);
    expect((await listing(dir)).filter((name) => name.includes("redlined"))).toEqual([]);
  }

  it("is never overwritten by --out, even with --force", async () => {
    await expectRefused((input) => ["--out", input, "--force"]);
  });

  it("is never overwritten by --report", async () => {
    await expectRefused((input) => ["--report", input, "--force"]);
  });

  it("is never overwritten by --summary", async () => {
    await expectRefused((input) => ["--summary", input]);
  });

  it("is recognised under another spelling of its path", async () => {
    await expectRefused((input) => ["--out", join(input, "..", "nope", "..", "nda-balanced.docx")]);
  });

  it("is recognised through a symbolic link", async () => {
    await expectRefused(
      (input) => ["--out", join(input, "..", "alias.docx"), "--force"],
      "alias.docx",
    );
  });

  it("is recognised through a hard link", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    const alias = join(dir, "alias.docx");
    await link(input, alias);
    const generator = createOracleGenerator(compliantScript());
    const { io, stderr } = makeIo({ generator });

    const code = await run(
      ["review", input, "--playbook", PLAYBOOK, "--out", alias, "--force"],
      io,
    );

    expect(code).toBe(1);
    expect(stderr()).toContain("Refusing to overwrite the input file");
    expect(generator.calls).toHaveLength(0);
  });
});

describe("output paths that cannot work", () => {
  const makeDir = tempDirs();

  async function expectRefusedBeforeSending(
    args: (dir: string) => string[],
    message: string,
  ): Promise<string> {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    const generator = createOracleGenerator(compliantScript());
    const { io, stderr } = makeIo({ generator });

    const code = await run(["review", input, "--playbook", PLAYBOOK, ...args(dir)], io);

    expect(code).toBe(1);
    expect(stderr()).toContain(message);
    expect(generator.calls).toHaveLength(0);
    expect(stderr()).not.toContain("Sending the contract text");
    return dir;
  }

  it("refuses two outputs that are the same file", async () => {
    const dir = await expectRefusedBeforeSending(
      (d) => ["--out", join(d, "x.out"), "--report", join(d, ".", "x.out")],
      "would both be written to",
    );
    expect(await listing(dir)).toEqual(["nda-balanced.docx"]);
  });

  it("refuses an output in a folder that does not exist", async () => {
    const missing = (d: string) => join(d, "no", "such", "report.json");
    await expectRefusedBeforeSending(
      (d) => ["--report", missing(d)],
      "The folder for the report does not exist:",
    );
  });

  it("refuses an output that is a directory, even with --force", async () => {
    await expectRefusedBeforeSending((d) => ["--summary", d, "--force"], "is not a regular file");
  });

  it("writes into a folder that exists", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    await mkdir(join(dir, "out"));
    const { io } = makeIo({ generator: createOracleGenerator(compliantScript()) });

    const code = await run(
      ["review", input, "--playbook", PLAYBOOK, "--report", join(dir, "out", "r.json")],
      io,
    );

    expect(code).toBe(0);
    expect(await listing(join(dir, "out"))).toEqual(["r.json"]);
  });
});

describe("a write that fails after the review", () => {
  const makeDir = tempDirs();

  /** A stand-in for the file system that fails for the temporary file of one output. */
  function failingFor(name: string, code: string): NonNullable<CliIo["writeFile"]> {
    return async (path, data, mode) => {
      if (basename(path).includes(name)) {
        throw Object.assign(new Error(`${code}: leaked detail`), { code });
      }
      await createFile(path, data, mode);
    };
  }

  it("leaves nothing behind and says which file failed", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    const report = join(dir, "nda-balanced.report.json");
    const { io, stderr, stdout } = makeIo({
      generator: createOracleGenerator(compliantScript()),
    });
    io.writeFile = failingFor("nda-balanced.report.json", "ENOSPC");

    const code = await run(["review", input, "--playbook", PLAYBOOK], io);

    expect(code).toBe(1);
    expect(stderr()).toContain(
      `Could not write the report to ${report}: no space left on the device. ` +
        "The review finished, but its results were not saved.",
    );
    expect(stderr()).not.toContain("leaked detail");
    expect(stdout()).toBe("");
    expect(await listing(dir)).toEqual(["nda-balanced.docx"]);
  });

  it("keeps every file that was there before, since nothing is moved until all are written", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    const redlined = join(dir, "nda-balanced.redlined.docx");
    const report = join(dir, "nda-balanced.report.json");
    await writeFile(redlined, SENTINEL);
    await writeFile(report, SENTINEL);
    const { io } = makeIo({ generator: createOracleGenerator(compliantScript()) });
    io.writeFile = failingFor("nda-balanced.summary.md", "EACCES");

    expect(await run(["review", input, "--playbook", PLAYBOOK, "--force"], io)).toBe(1);

    expect(await listing(dir)).toEqual([
      "nda-balanced.docx",
      "nda-balanced.redlined.docx",
      "nda-balanced.report.json",
    ]);
    expect(await readFile(redlined, "utf8")).toBe(SENTINEL);
    expect(await readFile(report, "utf8")).toBe(SENTINEL);
  });
});
