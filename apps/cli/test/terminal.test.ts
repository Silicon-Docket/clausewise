import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRequestError, type ObjectGenerator } from "@clausewise/llm";
import { createOracleGenerator } from "@clausewise/review/testing";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { plain, safeBlock, visible } from "../src/text.js";
import {
  compliantScript,
  fixturePath,
  listing,
  makeIo,
  playbookPath,
  stage,
  tempDirs,
} from "./support.js";

const PLAYBOOK = playbookPath("nda-mutual.yaml");

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(7);
const CR = String.fromCharCode(13);
const RLO = String.fromCharCode(0x202e);
const NEL = String.fromCharCode(0x85);
const ZWSP = String.fromCharCode(0x200b);
const E_ACUTE = String.fromCharCode(0xe9);
const CJK = String.fromCharCode(0x65e5, 0x672c);

// Anything that can start, redraw or reorder what the terminal shows.
const DANGEROUS = new RegExp(
  "[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]",
);

describe("text for the terminal", () => {
  it("shows a control character as an escape instead of acting on it", () => {
    expect(visible(`a${ESC}[31mb${BEL}c${CR}d`)).toBe("a\\x1b[31mb\\x07c\\x0dd");
    expect(visible(`x${RLO}y${ZWSP}z${NEL}`)).toBe("x\\u{202e}y\\u{200b}z\\x85");
    expect(visible("line\nbreak")).toBe("line\\x0abreak");
  });

  it("leaves ordinary names alone, spaces and other scripts included", () => {
    const name = `my contract  (v2) ${E_ACUTE} ${CJK}.docx`;

    expect(visible(name)).toBe(name);
    expect(safeBlock(name)).toBe(name);
  });

  it("keeps the line breaks of a message and nothing else", () => {
    expect(safeBlock(`one\ntwo${ESC}[2J\nthree`)).toBe("one\ntwo\\x1b[2J\nthree");
  });

  it("makes a title one plain line with no control or format characters", () => {
    expect(plain(`  Evil ${ESC}[31m${RLO}title\nsecond${ZWSP}  line  `)).toBe(
      "Evil [31mtitle second line",
    );
  });
});

describe("what a review prints about paths, models and errors", () => {
  const makeDir = tempDirs();
  const NAME = `my contract (v2) ${ESC}[31mRED${ESC}]0;pwned${BEL}${RLO}fdp.docx`;

  function expectTame(...texts: string[]): void {
    for (const text of texts) expect(text).not.toMatch(DANGEROUS);
  }

  async function reviewNamed(name: string, extra: string[] = []) {
    const dir = await makeDir();
    const input = join(dir, name);
    await copyFile(fixturePath("nda-balanced.docx"), input);
    const generator = createOracleGenerator(compliantScript());
    const harness = makeIo({ generator });
    const code = await run(["review", input, "--playbook", PLAYBOOK, ...extra], harness.io);
    return { dir, input, code, ...harness };
  }

  it("shows the written paths of a contract with escape sequences in its name harmlessly", async () => {
    const { code, stdout, stderr } = await reviewNamed(NAME);

    expect(code).toBe(0);
    expectTame(stdout(), stderr());
    expect(stdout()).toContain(
      "my contract (v2) \\x1b[31mRED\\x1b]0;pwned\\x07\\u{202e}fdp.redlined.docx",
    );
    expect(stdout()).toContain("Reviewed my contract (v2) [31mRED ]0;pwned fdp.docx against");
  });

  it("shows the list of files it refuses to replace harmlessly", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    const odd = join(dir, `taken${ESC}[2J.json`);
    await writeFile(odd, "x");
    const { io, stderr } = makeIo({ generator: createOracleGenerator(compliantScript()) });

    const code = await run(["review", input, "--playbook", PLAYBOOK, "--report", odd], io);

    expect(code).toBe(1);
    expectTame(stderr());
    expect(stderr()).toContain("taken\\x1b[2J.json");
  });

  it("shows a missing contract's name harmlessly", async () => {
    const dir = await makeDir();
    const { io, stderr } = makeIo();

    await run(["review", join(dir, `gone${ESC}[31m.docx`), "--playbook", PLAYBOOK], io);

    expectTame(stderr());
    expect(stderr()).toContain("gone\\x1b[31m.docx");
  });

  it("shows a playbook's name harmlessly in playbook check", async () => {
    const dir = await makeDir();
    const odd = join(dir, `book${ESC}[31m.yaml`);
    await writeFile(
      odd,
      [
        "name: N",
        "contractTypes: [nda]",
        "perspective: P",
        "rules:",
        "  - {id: a, title: T, severity: low, standard: s}",
      ].join("\n"),
    );
    const { io, stdout } = makeIo();

    expect(await run(["playbook", "check", odd], io)).toBe(0);

    expectTame(stdout());
    expect(stdout()).toContain("book\\x1b[31m.yaml is a valid playbook.");
  });

  it("shows an error message that carries escape sequences harmlessly", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    const inner = createOracleGenerator(compliantScript());
    const generator: ObjectGenerator = {
      provider: inner.provider,
      model: `evil${ESC}[2Jmodel${BEL}`,
      disclosure: `a server${ESC}[31m at a${RLO} place`,
      generate: () => Promise.reject(new ModelRequestError(`${ESC}[31mrejected`, 401, true)),
    };
    const { io, stderr } = makeIo({ generator });

    const code = await run(["review", input, "--playbook", PLAYBOOK], io);

    expect(code).toBe(1);
    expectTame(stderr());
    expect(stderr()).toContain("Error: ");
    expect(await listing(dir)).toEqual(["nda-balanced.docx"]);
  });

  it("shows the output folder it cannot find harmlessly", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    await mkdir(join(dir, "ok"));
    const { io, stderr } = makeIo({ generator: createOracleGenerator(compliantScript()) });

    await run(
      ["review", input, "--playbook", PLAYBOOK, "--out", join(dir, `no${ESC}[31m`, "x.docx")],
      io,
    );

    expectTame(stderr());
    expect(stderr()).toContain("no\\x1b[31m");
  });
});
