import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { makeIo, root } from "./support.js";

const VARIABLES = [
  "CLAUSEWISE_PROVIDER",
  "CLAUSEWISE_MODEL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CLAUSEWISE_API_KEY",
  "CLAUSEWISE_BASE_URL",
  "CLAUSEWISE_MAX_OUTPUT_TOKENS",
  "CLAUSEWISE_EFFORT",
  "CLAUSEWISE_CONCURRENCY",
  "CLAUSEWISE_MAX_CONTEXT_TOKENS",
  "CLAUSEWISE_MAX_RETRIES",
];

async function help(args: string[]): Promise<string> {
  const { io, stdout, stderr } = makeIo();
  expect(await run(args, io)).toBe(0);
  expect(stderr()).toBe("");
  return stdout();
}

describe("--help", () => {
  it.each([
    ["--help"],
    ["-h"],
    ["review", "--help"],
    ["playbook", "-h"],
    ["playbook", "check", "-h"],
  ])("clausewise %s prints the usage and exits 0", async (...args) => {
    const text = await help(args);

    expect(text).toContain("Usage:");
    expect(text).toContain("clausewise review <contract.docx> --playbook <file.yaml> [options]");
    expect(text).toContain("clausewise playbook check <file.yaml>");
  });

  it("describes every review option", async () => {
    const text = await help(["--help"]);

    for (const option of [
      "--playbook <file>",
      "--out <file>",
      "--report <file>",
      "--summary <file>",
      "--author <name>",
      "--client <text>",
      "--fail-on <severity>",
      "--force",
      "--quiet",
    ]) {
      expect(text).toMatch(new RegExp(`^ {2}${option} +\\S`, "m"));
    }
    expect(text).toContain("<contract>.redlined.docx");
    expect(text).toContain("<contract>.report.json");
    expect(text).toContain("<contract>.summary.md");
  });

  it("explains the exit codes", async () => {
    const text = await help(["--help"]);

    for (const code of ["0", "1", "2", "130"]) {
      expect(text).toMatch(new RegExp(`^ {2}${code} {2,}\\S`, "m"));
    }
  });

  it("says what an incomplete or failed review means for the exit code and the files", async () => {
    const text = (await help(["--help"])).replace(/\s+/g, " ");

    expect(text).toContain("including a review in which no rule could be checked");
    expect(text).toContain("A rule that could not be checked counts as open at its own severity.");
    expect(text).toContain("or a rule that could not be checked.");
    expect(text).toContain(
      "A review that fails leaves no output files behind, and files that were there before stay as they were.",
    );
    expect(text).toContain("With --force each existing file is replaced atomically");
    expect(text).toContain(
      "Every output folder is checked for write access before the first model call",
    );
  });

  it("explains --client with an example", async () => {
    const text = (await help(["--help"])).replace(/\s+/g, " ");

    expect(text).toContain(
      'Which party you act for, in your words, such as "Fabrikam Labs LLC, the Recipient".',
    );
  });

  it("lists each environment variable with a line about it", async () => {
    const text = await help(["--help"]);

    for (const name of VARIABLES) {
      expect(text).toMatch(new RegExp(`^ {2}${name} {2,}\\S`, "m"));
    }
  });

  it("lists every variable the model configuration reads", async () => {
    const source = readFileSync(join(root, "packages", "llm", "src", "config.ts"), "utf8");
    const read = [...source.matchAll(/"((?:CLAUSEWISE|ANTHROPIC|OPENAI)_[A-Z_]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    const text = await help(["--help"]);

    expect(read.length).toBeGreaterThanOrEqual(VARIABLES.length);
    for (const name of read) expect(text).toContain(name);
  });

  it("says plainly that the contract goes to the configured provider and nowhere else", async () => {
    const text = (await help(["--help"])).replace(/\s+/g, " ");

    expect(text).toContain(
      "The contract text is sent to the model provider you configure below, and nowhere else.",
    );
    expect(text).toContain("There is no telemetry");
  });

  it("keeps lines short and uses no en or em dashes", async () => {
    const text = await help(["--help"]);

    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    expect(text).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
  });
});

describe("--version", () => {
  it("prints the version from the package", async () => {
    const manifest = JSON.parse(
      readFileSync(join(root, "apps", "cli", "package.json"), "utf8"),
    ) as { version: string };

    expect(await help(["--version"])).toBe(`${manifest.version}\n`);
  });
});

describe("no arguments", () => {
  it("prints the usage on stderr and exits 1", async () => {
    const { io, stdout, stderr } = makeIo();

    expect(await run([], io)).toBe(1);

    expect(stdout()).toBe("");
    expect(stderr()).toContain("Usage:");
    expect(stderr()).toContain("clausewise review");
  });
});
