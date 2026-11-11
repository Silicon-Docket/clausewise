import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmConfigError } from "@clausewise/llm";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, StartupError, describeStartFailure, parseEnv } from "../../src/main.js";
import { MigrationError, StoreError, ValidationError } from "../../src/store/index.js";
import { ROOT } from "../integration/pipeline.js";

/**
 * When the server cannot start, the sentence the operator reads says what to do, and it quotes no
 * secret, no path and no line of a file. What these tests can show: the sentence for each kind of
 * failure, that an error nobody wrote a sentence for is told from its class and a code of a fixed
 * shape and never from its message, and that the entry point prints exactly that sentence. What
 * they cannot show: that an operator who reads it does what it asks.
 */

const NO_DASH = /[\u2013\u2014]/;
/** Words that start an instruction: a sentence that says what to do has one of them. */
const SAYS_WHAT_TO_DO = /\b(?:Set|Stop|Make|Free|Close|Install|Check|Restore|Start|Get|Fix|Use)\b/;

const MARKER = "MARKER_start_7f3a";

const system = (code: string, message = `${code}: failed, open '/home/${MARKER}/data'`): Error =>
  Object.assign(new Error(message), { code });

describe("a failure of the settings or of the start", () => {
  it("shows the sentence of a setting that is wrong as it was written, after the words 'Parol cannot start'", () => {
    const error = new ConfigError(
      "PAROL_PORT must be a whole number from 0 to 65535. Fix the value, or unset it.",
    );
    expect(describeStartFailure(error)).toBe(
      "Parol cannot start: PAROL_PORT must be a whole number from 0 to 65535. Fix the value, or unset it.",
    );
  });

  it("gives a settings message from the real parser, which names the variable and never a value", () => {
    let thrown: unknown;
    try {
      parseEnv({ PAROL_PORT: MARKER });
    } catch (error) {
      thrown = error;
    }
    const said = describeStartFailure(thrown);
    expect(said).toContain("PAROL_PORT");
    expect(said).not.toContain(MARKER);
    expect(said).toMatch(SAYS_WHAT_TO_DO);
  });

  it("shows a second server on the folder as it was written", () => {
    const error = new StartupError(
      "another Parol server is already using this data folder. Stop it first, or give this one a folder of its own with PAROL_DATA_DIR.",
    );
    expect(describeStartFailure(error)).toBe(`Parol cannot start: ${error.message}`);
  });

  it("does not say 'Parol cannot start' twice, and says what to do about a module that is missing", () => {
    const error = new StartupError("Parol cannot start: the module services/index is missing.");
    const said = describeStartFailure(error);
    expect(said.startsWith("Parol cannot start: the module services/index is missing.")).toBe(true);
    expect(said.match(/Parol cannot start/g)).toHaveLength(1);
    expect(said).toContain("pnpm install");
    expect(said).toMatch(SAYS_WHAT_TO_DO);
  });

  it("ends a message that has no full stop with one", () => {
    expect(describeStartFailure(new ConfigError("PAROL_X is wrong"))).toBe(
      "Parol cannot start: PAROL_X is wrong.",
    );
  });
});

describe("a model setting that is wrong", () => {
  const error = new LlmConfigError(
    "ANTHROPIC_API_KEY is required when CLAUSEWISE_PROVIDER is anthropic. Set it to your Anthropic API key.",
  );

  it("keeps the sentence of the model layer and adds the one way to look at Parol without a model", () => {
    const said = describeStartFailure(error);
    expect(said.startsWith(`Parol cannot start: ${error.message} `)).toBe(true);
    expect(said).toContain("PAROL_SCRIPTED=1");
    expect(said).toContain("PAROL_DEMO_IDENTITY=1 PAROL_SCRIPTED=1 pnpm parol");
  });

  it("labels the reader that setting switches on: a scripted stand-in, not a language model", () => {
    const said = describeStartFailure(error);
    expect(said).toContain("scripted stand-in");
    expect(said).toContain("not a language model");
    expect(said).toContain("demonstration documents");
  });
});

describe("an error nobody wrote a sentence for", () => {
  /** Every operating system code the table knows, with the thing it must tell the operator to touch. */
  const CODES: [string, RegExp][] = [
    ["EADDRINUSE", /PAROL_PORT/],
    ["EACCES", /PAROL_DATA_DIR/],
    ["EPERM", /PAROL_DATA_DIR/],
    ["EADDRNOTAVAIL", /PAROL_HOST/],
    ["ENOTFOUND", /PAROL_HOST/],
    ["EAI_AGAIN", /PAROL_HOST/],
    ["ENOENT", /PAROL_DATA_DIR/],
    ["ENOTDIR", /PAROL_DATA_DIR/],
    ["EISDIR", /PAROL_DATA_DIR/],
    ["EEXIST", /PAROL_DATA_DIR/],
    ["ENOSPC", /disk is full/],
    ["EDQUOT", /disk is full/],
    ["EROFS", /PAROL_DATA_DIR/],
    ["EMFILE", /too many files/],
    ["ENFILE", /too many files/],
    ["ERR_MODULE_NOT_FOUND", /pnpm install/],
    ["MODULE_NOT_FOUND", /pnpm install/],
  ];

  it.each(CODES)(
    "says what to do about %s, names the code, and quotes nothing of the message",
    (code, names) => {
      const said = describeStartFailure(system(code));
      expect(said.startsWith("Parol cannot start: ")).toBe(true);
      expect(said).toMatch(names);
      expect(said).toMatch(SAYS_WHAT_TO_DO);
      expect(said.endsWith(`[${code}]`)).toBe(true);
      expect(said).not.toContain(MARKER);
      expect(said).not.toContain("/home/");
      expect(said).not.toMatch(NO_DASH);
    },
  );

  it("tells a data folder that is a file from the real operating system error, with no path", () => {
    const root = mkdtempSync(join(tmpdir(), "parol-start-"));
    try {
      const file = join(root, `${MARKER}-a-file`);
      writeFileSync(file, "x");
      let thrown: unknown;
      try {
        // The very call that start() makes for the data folder.
        mkdirSync(join(file, "sub"), { recursive: true, mode: 0o700 });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(MARKER);
      const said = describeStartFailure(thrown);
      expect(said).toContain("PAROL_DATA_DIR");
      expect(said).not.toContain(MARKER);
      expect(said).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const sqlite = (errcode: number): Error =>
    Object.assign(new Error(`a message with ${MARKER}`), {
      code: "ERR_SQLITE_ERROR",
      errcode,
      errstr: `a string with ${MARKER}`,
    });

  it.each([
    [14, /cannot be opened/],
    [26, /damaged, or is not a Parol database/],
    [11, /damaged, or is not a Parol database/],
    [5, /in use by another program/],
    [6, /in use by another program/],
    [13, /disk is full/],
    [8, /cannot be written to/],
    [10, /reported an error/],
    [1, /could not be opened or updated/],
  ])(
    "says what to do about SQLite result %i, with the result and not the message",
    (errcode, words) => {
      const said = describeStartFailure(sqlite(errcode));
      expect(said).toMatch(words);
      expect(said).toMatch(SAYS_WHAT_TO_DO);
      expect(said.endsWith(`[SQLite result ${errcode}]`)).toBe(true);
      expect(said).not.toContain(MARKER);
    },
  );

  it("reads the primary result of an extended SQLite code", () => {
    // 267 is SQLITE_CORRUPT with a sub-code: the low byte is 11.
    const said = describeStartFailure(sqlite(267));
    expect(said).toMatch(/damaged/);
    expect(said.endsWith("[SQLite result 11]")).toBe(true);
  });

  it.each(["migration_changed", "migration_unknown", "migration_gap", "bad_migration_name"])(
    "tells a database and a build that disagree on the migrations (%s) from the code and not the message",
    (code) => {
      const said = describeStartFailure(
        new MigrationError(code, `migration 3 (${MARKER}) changed`),
      );
      expect(said).toContain("do not agree on the migrations");
      expect(said).toMatch(SAYS_WHAT_TO_DO);
      expect(said.endsWith(`[MigrationError, code ${code}]`)).toBe(true);
      expect(said).not.toContain(MARKER);
    },
  );

  it("gives any other fault of the store a general sentence with its code, and not its message", () => {
    const said = describeStartFailure(
      new ValidationError("playbook_hash_mismatch", `text ${MARKER}`),
    );
    expect(said).toContain("A check of the stored data failed");
    expect(said).toContain("PAROL_DATA_DIR");
    expect(said.endsWith("[ValidationError, code playbook_hash_mismatch]")).toBe(true);
    expect(said).not.toContain(MARKER);
    const plain = describeStartFailure(new StoreError("no_database", `text ${MARKER}`));
    expect(plain.endsWith("[StoreError, code no_database]")).toBe(true);
    expect(plain).not.toContain(MARKER);
  });

  it("names a defect by its class, says its message is not shown, and says what to do", () => {
    const said = describeStartFailure(new TypeError(`cannot read ${MARKER} of undefined`));
    expect(said).toBe(
      "Parol cannot start: an unexpected TypeError stopped the start. Start again; if it happens again, " +
        "report it with the name given here. Its message is not shown, because it could hold a path or a setting.",
    );
  });

  it("prints a code of a fixed shape, and nothing else of an unknown code", () => {
    const known = describeStartFailure(system("EWHATEVER"));
    expect(known).toContain("and the code EWHATEVER");
    expect(known).not.toContain(MARKER);
    for (const code of [`E ${MARKER}`, `${MARKER}/../etc`, "x".repeat(200), "", "1ABC"]) {
      const said = describeStartFailure(system(code));
      expect(said).not.toContain(MARKER);
      expect(said).not.toContain("xxxxxxxx");
      expect(said).not.toContain("and the code");
    }
  });

  it("prints a class name of a fixed shape, and falls back to 'Error' for any other", () => {
    class Odd extends Error {
      override name = `Odd ${MARKER}\nname`;
    }
    const said = describeStartFailure(new Odd("x"));
    expect(said).toContain("an unexpected Error stopped the start");
    expect(said).not.toContain(MARKER);
  });

  it.each([
    ["a string", `a string with ${MARKER}`],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", { message: MARKER, code: "EACCES2" }],
  ])("does not quote %s that is thrown in place of an error", (_name, value) => {
    const said = describeStartFailure(value);
    expect(said).toContain("something that is not an error");
    expect(said).toContain("Start again");
    expect(said).not.toContain(MARKER);
  });

  it("holds no dash in any sentence it can print", () => {
    const all: string[] = [];
    for (const [code] of CODES) all.push(describeStartFailure(system(code)));
    for (const errcode of [1, 5, 8, 10, 11, 13, 14, 26])
      all.push(describeStartFailure(sqlite(errcode)));
    all.push(describeStartFailure(new MigrationError("migration_gap", "x")));
    all.push(describeStartFailure(new LlmConfigError("x")));
    all.push(describeStartFailure(new TypeError("x")));
    all.push(describeStartFailure(null));
    for (const said of all) expect(said).not.toMatch(NO_DASH);
  });
});

// ---------------------------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------------------------

const tsx = join(ROOT, "node_modules", ".bin", "tsx");
const main = join(ROOT, "apps", "parol", "src", "main.ts");
const tsconfig = join(ROOT, "apps", "parol", "tsconfig.json");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** `pnpm parol` as a process, with only the variables it is given. */
function start(env: Record<string, string>) {
  return spawnSync(tsx, ["--tsconfig", tsconfig, main], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    encoding: "utf8",
    timeout: 90_000,
  });
}

describe("pnpm parol, as a process", () => {
  it("prints the sentence for a model setting that is wrong, with no key and no password in it, and exits 1", () => {
    const root = mkdtempSync(join(tmpdir(), "parol-start-"));
    roots.push(root);
    const key = `sk-${MARKER}-key`;
    const result = start({
      PAROL_DEMO_IDENTITY: "1",
      PAROL_DATA_DIR: join(root, "data"),
      ANTHROPIC_API_KEY: key,
      CLAUSEWISE_BASE_URL: `ftp://someone:${MARKER}-password@host.example/x`,
    });
    expect(result.status).toBe(1);
    const lines = result.stderr.split("\n").filter((line) => line.startsWith("Parol cannot start"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("CLAUSEWISE_BASE_URL is not usable");
    expect(lines[0]).toContain("PAROL_SCRIPTED=1");
    // The sentence of the model layer comes first, and the one way to look without a model last,
    // word for word the same as the function gives.
    const hint = describeStartFailure(new LlmConfigError("x")).slice(
      "Parol cannot start: x. ".length,
    );
    expect(hint).toContain("PAROL_SCRIPTED=1");
    expect(lines[0]!.endsWith(` ${hint}`)).toBe(true);
    expect(result.stderr).not.toContain(MARKER);
    expect(result.stdout).not.toContain(MARKER);
  }, 120_000);

  it("prints the sentence for a data folder that cannot be made, with no path in it, and exits 1", () => {
    const root = mkdtempSync(join(tmpdir(), "parol-start-"));
    roots.push(root);
    const file = join(root, `${MARKER}-a-file`);
    writeFileSync(file, "x");
    const result = start({
      PAROL_DEMO_IDENTITY: "1",
      PAROL_SCRIPTED: "1",
      PAROL_DATA_DIR: join(file, "sub"),
    });
    expect(result.status).toBe(1);
    const lines = result.stderr.split("\n").filter((line) => line.startsWith("Parol cannot start"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("PAROL_DATA_DIR");
    expect(lines[0]!.endsWith("[ENOTDIR]")).toBe(true);
    expect(result.stderr).not.toContain(MARKER);
    expect(result.stderr).not.toContain(root);
  }, 120_000);
});
