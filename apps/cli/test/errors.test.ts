import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRequestError, type ObjectGenerator } from "@clausewise/llm";
import { createOracleGenerator } from "@clausewise/review/testing";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import {
  buildDocx,
  compliantScript,
  expectedScript,
  failingGenerator,
  listing,
  makeIo,
  playbookPath,
  stage,
  tempDirs,
} from "./support.js";

const PLAYBOOK = playbookPath("nda-mutual.yaml");
const HINT = 'Run "clausewise --help" for usage.';
const NOTICE = "Sending the contract text to:";
const SECRET = "SECRET-CLAUSE-TEXT-4402";

describe("a command line that is wrong", () => {
  const review = (...rest: string[]) => [
    "review",
    "contract.docx",
    "--playbook",
    "p.yaml",
    ...rest,
  ];

  const cases: [string, string[], string][] = [
    ["an unknown option", review("--frobnicate"), "Unknown option: --frobnicate"],
    ["an unknown short option", review("-x"), "Unknown option: -x"],
    ["an unknown option with a value", review("--bogus=1"), "Unknown option: --bogus"],
    ["a negated switch", review("--no-force"), "Unknown option: --no-force"],
    ["a missing value", ["review", "c.docx", "--playbook"], "Option --playbook needs a value."],
    ["an empty value", review("--out="), "Option --out needs a value."],
    ["a value that is the next option", review("--out", "--force"), "Option --out needs a value."],
    [
      "a repeated option",
      review("--out", "a", "--out", "b"),
      "Option --out was given more than once.",
    ],
    ["a value given to a switch", review("--force=yes"), "Option --force does not take a value."],
    ["no contract", ["review", "--playbook", "p.yaml"], "review needs the contract to check"],
    [
      "two contracts",
      ["review", "a.docx", "b.docx", "--playbook", "p.yaml"],
      "review takes one contract, but 2 were given.",
    ],
    ["no playbook", ["review", "c.docx"], "review needs a playbook: add --playbook <file.yaml>."],
    ["a severity that does not exist", review("--fail-on", "urgent"), "--fail-on must be one of"],
    ["a blank author", review("--author", " "), "--author needs a name."],
    ["an unknown command", ["frobnicate"], "Unknown command: frobnicate"],
    ["an unknown option before any command", ["--frobnicate"], "Unknown option: --frobnicate"],
    ["a playbook command that is missing", ["playbook"], "playbook needs a command"],
    [
      "an unknown playbook command",
      ["playbook", "lint", "p.yaml"],
      "Unknown playbook command: lint",
    ],
    ["an unknown playbook option", ["playbook", "--frobnicate"], "Unknown option: --frobnicate"],
    ["no playbook file to check", ["playbook", "check"], "playbook check needs a playbook file."],
    [
      "two playbook files to check",
      ["playbook", "check", "a.yaml", "b.yaml"],
      "playbook check takes one file, but 2 were given.",
    ],
    [
      "an unknown option for playbook check",
      ["playbook", "check", "p.yaml", "--frobnicate"],
      "Unknown option: --frobnicate",
    ],
  ];

  it.each(cases)(
    "%s exits 1, says what is wrong and shows the usage hint",
    async (_, args, message) => {
      const { io, stderr, stdout } = makeIo();

      expect(await run(args, io)).toBe(1);

      expect(stderr()).toContain(`Error: ${message}`);
      expect(stderr()).toContain(HINT);
      expect(stdout()).toBe("");
    },
  );

  it("asks for nothing else once --help is given", async () => {
    const { io, stdout, stderr } = makeIo();

    expect(await run(["review", "--frobnicate", "--help"], io)).toBe(0);

    expect(stdout()).toContain("Usage:");
    expect(stderr()).toBe("");
  });
});

describe("a contract that cannot be reviewed", () => {
  const makeDir = tempDirs();

  async function expectRejected(
    prepare: (dir: string) => Promise<string>,
    message: string | RegExp,
  ): Promise<{ dir: string; stderr: string }> {
    const dir = await makeDir();
    const input = await prepare(dir);
    const generator = createOracleGenerator(compliantScript());
    const { io, stderr, stdout } = makeIo({ generator });

    const code = await run(["review", input, "--playbook", PLAYBOOK], io);

    expect(code).toBe(1);
    expect(stderr()).toMatch(message);
    expect(stderr()).not.toContain(NOTICE);
    expect(stderr()).not.toContain("    at ");
    expect(stdout()).toBe("");
    expect(generator.calls).toHaveLength(0);
    expect(
      (await listing(dir)).filter((name) => /\.(redlined|report|summary)\./.test(name)),
    ).toEqual([]);
    return { dir, stderr: stderr() };
  }

  it("says so when the file does not exist", async () => {
    await expectRejected(
      async (dir) => join(dir, "missing.docx"),
      /Error: Contract file not found: .*missing\.docx\n/,
    );
  });

  it("says why when the path cannot be looked at at all", async () => {
    await expectRejected(async (dir) => {
      // Two links that point at each other: neither the file nor its absence can be told.
      await symlink("loop-b.docx", join(dir, "loop-a.docx"));
      await symlink("loop-a.docx", join(dir, "loop-b.docx"));
      return join(dir, "loop-a.docx");
    }, /Error: Cannot access .*loop-a\.docx: too many levels of symbolic links\.\n/);
  });

  it("says so when the path is a folder", async () => {
    await expectRejected(async (dir) => dir, /is not a file\./);
  });

  it("says so when the file is not a zip, and suggests saving an old .doc as .docx", async () => {
    await expectRejected(async (dir) => {
      const path = join(dir, "notes.docx");
      await writeFile(path, "just some text, not a Word file");
      return path;
    }, /notes\.docx is not a \.docx file: it is not a zip archive\. If it is an older \.doc file/);
  });

  it("says so when the file is empty", async () => {
    await expectRejected(async (dir) => {
      const path = join(dir, "empty.docx");
      await writeFile(path, "");
      return path;
    }, /empty\.docx is not a \.docx file/);
  });

  it("explains a zip that is not a Word document, before saying anything is sent", async () => {
    await expectRejected(async (dir) => {
      const zip = new JSZip();
      zip.file("notes.txt", "hello");
      const path = join(dir, "sheet.docx");
      await writeFile(path, await zip.generateAsync({ type: "uint8array" }));
      return path;
    }, "Error: Not a .docx file: word/document.xml is missing");
  });

  it("explains a damaged zip", async () => {
    await expectRejected(async (dir) => {
      const path = join(dir, "damaged.docx");
      await writeFile(path, Buffer.from("PK\u0003\u0004 and then nothing a zip reader can use"));
      return path;
    }, "Error: Not a .docx file: it is not a valid zip archive");
  });

  it("explains a document with nothing to review", async () => {
    const dir = await makeDir();
    const path = join(dir, "blank.docx");
    await writeFile(path, await buildDocx(["", ""]));
    const generator = createOracleGenerator(compliantScript());
    const { io, stderr } = makeIo({ generator });

    expect(await run(["review", path, "--playbook", PLAYBOOK], io)).toBe(1);

    expect(stderr()).toContain("Error: The document has no reviewable clauses");
    expect(generator.calls).toHaveLength(0);
    expect(await listing(dir)).toEqual(["blank.docx"]);
  });
});

describe("a playbook that cannot be used", () => {
  const makeDir = tempDirs();

  async function review(playbook: string | undefined) {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    let path = join(dir, "playbook.yaml");
    if (playbook === undefined) path = join(dir, "missing.yaml");
    else await writeFile(path, playbook);
    const generator = createOracleGenerator(compliantScript());
    const { io, stderr, stdout } = makeIo({ generator });

    const code = await run(["review", input, "--playbook", path], io);

    expect(code).toBe(1);
    expect(stdout()).toBe("");
    expect(stderr()).not.toContain(NOTICE);
    expect(generator.calls).toHaveLength(0);
    expect(await listing(dir)).toEqual([
      "nda-balanced.docx",
      ...(playbook === undefined ? [] : ["playbook.yaml"]),
    ]);
    return { stderr: stderr(), path };
  }

  it("prints every problem in a playbook that does not validate", async () => {
    const { stderr, path } = await review(
      [
        "name: Broken",
        "contractTypes: []",
        "rules:",
        "  - id: Bad_ID",
        '    title: ""',
        "    severity: urgent",
        "    standard: fine",
        "    colour: red",
      ].join("\n"),
    );

    expect(stderr).toContain(`Error: ${path} is invalid:`);
    for (const problem of [
      "contractTypes:",
      "perspective:",
      "rules[0].id:",
      "rules[0].title:",
      "rules[0].severity:",
      'rules[0]: Unrecognized key: "colour"',
    ]) {
      expect(stderr).toContain(`  ${problem}`);
    }
  });

  it("reports a duplicate rule id", async () => {
    const rule = (id: string) => `  - {id: ${id}, title: T, severity: low, standard: s}`;
    const { stderr } = await review(
      ["name: N", "contractTypes: [nda]", "perspective: P", "rules:", rule("a"), rule("a")].join(
        "\n",
      ),
    );

    expect(stderr).toContain('duplicate rule id "a"');
  });

  it("reports text that is not YAML", async () => {
    const { stderr } = await review("name: [unclosed\n");

    expect(stderr).toMatch(/Error: .*playbook\.yaml is not valid YAML/);
  });

  it("reports a playbook file that does not exist", async () => {
    const { stderr } = await review(undefined);

    expect(stderr).toMatch(
      /Error: Cannot read the playbook .*missing\.yaml: no such file or directory\./,
    );
  });

  it("reports a playbook path that is a folder", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    await mkdir(join(dir, "folder"));
    const { io, stderr } = makeIo({ generator: createOracleGenerator(compliantScript()) });

    expect(await run(["review", input, "--playbook", join(dir, "folder")], io)).toBe(1);

    expect(stderr()).toContain("it is a directory");
  });
});

describe("a model that cannot be set up", () => {
  const makeDir = tempDirs();

  async function review(env: Record<string, string | undefined>) {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    // No generatorFactory: the real configuration is read from `env`.
    const { io, stderr, stdout } = makeIo({ env });

    const code = await run(["review", input, "--playbook", PLAYBOOK], io);

    expect(code).toBe(1);
    expect(stdout()).toBe("");
    expect(stderr()).not.toContain(NOTICE);
    expect(await listing(dir)).toEqual(["nda-balanced.docx"]);
    return stderr();
  }

  it("names ANTHROPIC_API_KEY when the environment is empty", async () => {
    const text = await review({});

    expect(text).toContain("Error: ANTHROPIC_API_KEY is required");
    expect(text.trim().split("\n")).toHaveLength(1);
  });

  it("does not take another provider's key for the default provider", async () => {
    expect(await review({ OPENAI_API_KEY: "sk-unused" })).toContain("ANTHROPIC_API_KEY");
  });

  it("treats a key that is only whitespace as missing", async () => {
    expect(await review({ ANTHROPIC_API_KEY: "  \n" })).toContain("ANTHROPIC_API_KEY");
  });

  it("names the variable that holds a bad value, without repeating the value", async () => {
    const text = await review({ ANTHROPIC_API_KEY: "sk-unused", CLAUSEWISE_PROVIDER: "gpt-nine" });

    expect(text).toContain("CLAUSEWISE_PROVIDER must be one of");
    expect(text).not.toContain("gpt-nine");
  });
});

describe("a model provider that refuses the key", () => {
  const makeDir = tempDirs();

  it.each([401, 403, 404])("stops on HTTP %i and writes nothing", async (status) => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    const generator = failingGenerator(
      () => new ModelRequestError(`The request failed with HTTP ${status}: nope`, status),
    );
    const { io, stderr, stdout } = makeIo({ generator });

    const code = await run(["review", input, "--playbook", PLAYBOOK], io);

    expect(code).toBe(1);
    expect(stderr()).toContain(`Error: The model provider answered HTTP ${status}`);
    expect(stderr()).toContain("failing-model");
    expect(stdout()).toBe("");
    expect(await listing(dir)).toEqual(["nda-balanced.docx"]);
  });

  it("writes nothing when the failure comes after some rules were checked", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    const inner = createOracleGenerator(expectedScript("nda-balanced.docx"));
    let calls = 0;
    const generator: ObjectGenerator = {
      provider: inner.provider,
      model: inner.model,
      disclosure: inner.disclosure,
      async generate(request) {
        calls += 1;
        if (calls > 4) throw new ModelRequestError("The key was revoked.", 401);
        return inner.generate(request);
      },
    };
    const { io, stderr, stdout } = makeIo({ generator });

    const code = await run(["review", input, "--playbook", PLAYBOOK], io);

    expect(code).toBe(1);
    expect(stderr()).toContain("[1/10]");
    expect(stderr()).toContain("Error: The model provider answered HTTP 401");
    expect(stdout()).toBe("");
    expect(await listing(dir)).toEqual(["nda-balanced.docx"]);
  });
});

describe("a failure nobody planned for", () => {
  const makeDir = tempDirs();

  async function fail(thrown: () => unknown) {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    const { io, stderr, stdout } = makeIo();
    io.generatorFactory = () => {
      throw thrown();
    };

    const code = await run(["review", input, "--playbook", PLAYBOOK], io);

    expect(code).toBe(1);
    expect(stdout()).toBe("");
    expect(stderr()).not.toContain(SECRET);
    expect(stderr()).not.toContain("    at ");
    expect(await listing(dir)).toEqual(["nda-balanced.docx"]);
    return stderr();
  }

  it("is reported by name only, because its message may hold contract text", async () => {
    const text = await fail(() => new RangeError(`bad clause: ${SECRET}`));

    expect(text).toContain("Error: Unexpected error (RangeError).");
  });

  it("copes with something that is not an Error at all", async () => {
    expect(await fail(() => SECRET)).toContain("Unexpected error (Error).");
  });

  it("does not repeat an error name that could carry text", async () => {
    class Odd extends Error {
      override name = `Odd ${SECRET}\nsecond line`;
    }

    expect(await fail(() => new Odd("x"))).toContain("Unexpected error (Error).");
  });
});
