import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runAuditVerify } from "../../src/audit-verify.js";
import {
  CliUsageError,
  DATABASE_FILE,
  NO_DATABASE,
  describeCommandFailure,
} from "../../src/cli-common.js";
import { ConfigError, parseEnv } from "../../src/main.js";
import { runRetain } from "../../src/retain.js";
import { SeedError, describeSeedFailure, parseSeedArgs, runSeed } from "../../src/seed.js";
import { MigrationError, StoreError, ValidationError } from "../../src/store/index.js";

/**
 * When `pnpm parol:seed`, `pnpm parol:retain` or `pnpm parol:audit-verify` cannot run, the line the
 * operator reads says what to do, and it quotes no secret, no path and no line of a file or a
 * document. What these tests can show: the sentence for each kind of failure, that an error nobody
 * wrote a sentence for is told from its class and a code of a fixed shape and never from its message,
 * and that each of the three commands prints exactly that. What they cannot show: that an operator
 * who reads the sentence does what it asks.
 */

const NO_DASH = /[\u2013\u2014]/;
/** Words that start an instruction: a sentence that says what to do has one of them. */
const SAYS_WHAT_TO_DO =
  /\b(?:Set|Stop|Make|Free|Close|Install|Check|Restore|Run|Get|Fix|Use|Choose|Start|Move)\b/;
const MARKER = "MARKER_cmd_5b21";

const system = (code: string, message = `${code}: failed, open '/home/${MARKER}/data'`): Error =>
  Object.assign(new Error(message), { code });
const sqlite = (errcode: number): Error =>
  Object.assign(new Error(`a message with ${MARKER}`), {
    code: "ERR_SQLITE_ERROR",
    errcode,
    errstr: `a string with ${MARKER}`,
  });

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
const newFolder = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "parol-cmd-"));
  folders.push(folder);
  return folder;
};

describe("the line a command prints when it cannot run", () => {
  const say = (error: unknown, written: readonly (new (...args: never[]) => Error)[] = []) =>
    describeCommandFailure("Parol test", error, written);

  it("shows the sentence of an error that was written to be read, after the words 'cannot run'", () => {
    expect(say(new CliUsageError("an option is not known. usage: x"), [CliUsageError])).toBe(
      "Parol test cannot run: an option is not known. usage: x",
    );
    // As it was written: a usage line does not end in a full stop, and none is added.
    expect(say(new SeedError("a thing is wrong"), [SeedError])).toBe(
      "Parol test cannot run: a thing is wrong",
    );
  });

  it("does not show the message of an error whose class was not named as written", () => {
    const said = say(new SeedError(`this holds ${MARKER}`));
    expect(said).not.toContain(MARKER);
    expect(said).toContain("an unexpected SeedError stopped it");
  });

  /** Every operating system code the table knows, with the thing it must tell the operator to touch. */
  const CODES: [string, RegExp][] = [
    ["EACCES", /may not read or write the data folder/],
    ["EPERM", /may not read or write the data folder/],
    ["ENOENT", /PAROL_DATA_DIR/],
    ["ENOTDIR", /PAROL_DATA_DIR/],
    ["EISDIR", /PAROL_DATA_DIR/],
    ["EEXIST", /PAROL_DATA_DIR/],
    ["ENOSPC", /disk is full/],
    ["EDQUOT", /disk is full/],
    ["EROFS", /cannot be written to/],
    ["EMFILE", /too many files/],
    ["ENFILE", /too many files/],
    ["ERR_MODULE_NOT_FOUND", /pnpm install/],
    ["MODULE_NOT_FOUND", /pnpm install/],
  ];

  it.each(CODES)(
    "says what to do about %s, names the code, and quotes nothing of the message",
    (code, names) => {
      const said = say(system(code));
      expect(said.startsWith("Parol test cannot run: ")).toBe(true);
      expect(said).toMatch(names);
      expect(said).toMatch(SAYS_WHAT_TO_DO);
      expect(said.endsWith(`[${code}]`)).toBe(true);
      expect(said).not.toContain(MARKER);
      expect(said).not.toContain("/home/");
      expect(said).not.toMatch(NO_DASH);
    },
  );

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
      const said = say(sqlite(errcode));
      expect(said).toMatch(words);
      expect(said).toMatch(SAYS_WHAT_TO_DO);
      expect(said.endsWith(`[SQLite result ${errcode}]`)).toBe(true);
      expect(said).not.toContain(MARKER);
    },
  );

  it("reads the primary result of an extended SQLite code", () => {
    // 267 is SQLITE_CORRUPT with a sub-code: the low byte is 11.
    const said = say(sqlite(267));
    expect(said).toMatch(/damaged/);
    expect(said.endsWith("[SQLite result 11]")).toBe(true);
  });

  it.each([
    ["no_database", /there is no database in the data folder/],
    ["not_a_parol_database", /is not a Parol database/],
    ["migration_changed", /do not agree on the migrations/],
    ["migration_unknown", /do not agree on the migrations/],
    ["migration_gap", /do not agree on the migrations/],
  ])("tells the store's refusal %s from its code and not its message", (code, words) => {
    const said = say(new StoreError(code, `a message with ${MARKER}`));
    expect(said).toMatch(words);
    expect(said).toMatch(SAYS_WHAT_TO_DO);
    expect(said.endsWith(`[StoreError, code ${code}]`)).toBe(true);
    expect(said).not.toContain(MARKER);
  });

  it("tells a migration that changed from the class and the code", () => {
    const said = say(new MigrationError("migration_changed", `migration 3 (${MARKER}) changed`));
    expect(said.endsWith("[MigrationError, code migration_changed]")).toBe(true);
    expect(said).not.toContain(MARKER);
  });

  it("gives a store error with a code it does not know the general sentence, with the code", () => {
    const said = say(new ValidationError("bad_thing", `a message with ${MARKER}`));
    expect(said).toMatch(/a check of the stored data failed/);
    expect(said).toMatch(SAYS_WHAT_TO_DO);
    expect(said.endsWith("[ValidationError, code bad_thing]")).toBe(true);
    expect(said).not.toContain(MARKER);
  });

  it("tells an error nobody wrote a sentence for from its class and, if it has one, its code", () => {
    const plain = say(new TypeError(`this holds ${MARKER}`));
    expect(plain).toContain("an unexpected TypeError stopped it");
    expect(plain).toMatch(SAYS_WHAT_TO_DO);
    expect(plain).not.toContain(MARKER);
    const coded = say(system("EWHATEVER"));
    expect(coded).toContain("the code EWHATEVER");
    expect(coded).not.toContain(MARKER);
    // Something that is not an error at all.
    expect(say("a string")).toContain("something that is not an error stopped it");
    expect(say(undefined)).toContain("something that is not an error stopped it");
    // A name or a code that could be used to put text on the terminal is not printed.
    const hostile = Object.assign(new Error("x"), { name: `Bad\nName ${MARKER}`, code: "x y\nz" });
    const said = say(hostile);
    expect(said).not.toContain(MARKER);
    expect(said).not.toContain("\n");
    expect(said).toContain("an unexpected Error stopped it");
  });

  it("holds no dash in any sentence it can print", () => {
    const sentences = [
      ...CODES.map(([code]) => say(system(code))),
      ...[14, 26, 5, 13, 8, 10, 1].map((errcode) => say(sqlite(errcode))),
      ...["no_database", "not_a_parol_database", "migration_gap", "other_code"].map((code) =>
        say(new StoreError(code, "x")),
      ),
      say(new TypeError("x")),
      NO_DATABASE,
    ];
    for (const text of sentences) expect(text).not.toMatch(NO_DASH);
  });
});

describe("pnpm parol:audit-verify", () => {
  const verify = async (dataDir: string, argv: string[] = []) => {
    const err: string[] = [];
    const code = await runAuditVerify(
      { PAROL_DATA_DIR: dataDir },
      argv,
      () => {},
      (line) => err.push(line),
    );
    return { code, text: err.join("\n") };
  };

  it("says there is no database and what to set, and makes nothing", async () => {
    const parent = newFolder();
    const { code, text } = await verify(join(parent, "nowhere"));
    expect(code).toBe(2);
    expect(text).toBe(`Parol audit check cannot run: ${NO_DATABASE}`);
    expect(text).toMatch(SAYS_WHAT_TO_DO);
  });

  it("says that a file which is not a database is not one, and what to set, without echoing it", async () => {
    const parent = newFolder();
    writeFileSync(join(parent, DATABASE_FILE), `${MARKER} this is not an SQLite file at all`);
    const { code, text } = await verify(parent);
    expect(code).toBe(2);
    expect(text).toMatch(
      /^Parol audit check cannot run: the file parol\.sqlite in the data folder is not a Parol database\. Set PAROL_DATA_DIR to the folder the server uses\. \[StoreError, code not_a_parol_database\]$/,
    );
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(parent);
  });

  it("names the option and the usage for a command used wrongly, never the value", async () => {
    const parent = newFolder();
    const { code, text } = await verify(parent, ["--expect-head", MARKER]);
    expect(code).toBe(2);
    expect(text).toMatch(/^Parol audit check cannot run: --expect-head needs /);
    expect(text).toContain("usage: pnpm parol:audit-verify");
    expect(text).not.toContain(MARKER);
  });
});

describe("pnpm parol:retain", () => {
  const retain = async (dataDir: string, argv: string[] = []) => {
    const err: string[] = [];
    const code = await runRetain(
      { PAROL_DATA_DIR: dataDir },
      argv,
      () => {},
      (line) => err.push(line),
      () => new Date("2026-11-10T00:00:00.000Z"),
    );
    return { code, text: err.join("\n") };
  };

  it("says there is no database and what to set", async () => {
    const parent = newFolder();
    for (const argv of [[], ["--apply"]]) {
      const { code, text } = await retain(join(parent, "nowhere"), argv);
      expect(code).toBe(2);
      expect(text).toBe(`Parol retention cannot run: ${NO_DATABASE}`);
    }
  });

  it("says what is wrong with a file that is not a database, in a dry run and in a run that deletes", async () => {
    const parent = newFolder();
    writeFileSync(join(parent, DATABASE_FILE), `${MARKER} this is not an SQLite file at all`);
    const dry = await retain(parent);
    expect(dry.code).toBe(2);
    expect(dry.text).toMatch(
      /^Parol retention cannot run: the file parol\.sqlite in the data folder is not a Parol database\. Set PAROL_DATA_DIR to the folder the server uses\. \[StoreError, code not_a_parol_database\]$/,
    );
    const apply = await retain(parent, ["--apply"]);
    expect(apply.code).toBe(2);
    // The database opened to write is read as SQLite reads it: damaged, or not a Parol database.
    expect(apply.text).toMatch(/^Parol retention cannot run: .+ \[SQLite result 26\]$/);
    expect(apply.text).toMatch(/damaged, or is not a Parol database\. Restore it from a copy/);
    for (const text of [dry.text, apply.text]) {
      expect(text).not.toContain(MARKER);
      expect(text).not.toContain(parent);
      expect(text).toMatch(SAYS_WHAT_TO_DO);
    }
  });

  it("names the option and the usage for a command used wrongly, never the value", async () => {
    const parent = newFolder();
    const { code, text } = await retain(parent, ["--max-matters", MARKER]);
    expect(code).toBe(2);
    expect(text).toMatch(
      /^Parol retention cannot run: --max-matters needs a whole number from 1 to /,
    );
    expect(text).toContain("usage: pnpm parol:retain");
    expect(text).not.toContain(MARKER);
  });
});

describe("pnpm parol:seed", () => {
  it("shows a setting that is wrong as it was written, naming the variable and no value", () => {
    let thrown: unknown;
    try {
      parseEnv({ PAROL_PORT: MARKER });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const said = describeSeedFailure(thrown);
    expect(said.startsWith("Parol seed cannot run: PAROL_PORT")).toBe(true);
    expect(said).toMatch(SAYS_WHAT_TO_DO);
    expect(said).not.toContain(MARKER);
  });

  it("says what to set when the demo identity is off, and prints the usage for an option it does not know", async () => {
    const parent = newFolder();
    let thrown: unknown;
    try {
      await runSeed({ PAROL_DATA_DIR: join(parent, "data") }, []);
    } catch (error) {
      thrown = error;
    }
    expect(describeSeedFailure(thrown)).toBe(
      "Parol seed cannot run: the demonstration data is only for the demo identity. Set PAROL_DEMO_IDENTITY=1 to seed it",
    );
    let option: unknown;
    try {
      parseSeedArgs(["--foo"]);
    } catch (error) {
      option = error;
    }
    expect(describeSeedFailure(option)).toContain("usage: pnpm parol:seed");
    expect(describeSeedFailure(option)).not.toContain("--foo");
    // Nothing was made for the refusal.
    expect(existsSync(join(parent, "data"))).toBe(false);
  });

  it("tells a data folder that is a file from the real operating system error, with no path", async () => {
    const parent = newFolder();
    const file = join(parent, `${MARKER}-a-file`);
    writeFileSync(file, "x");
    let thrown: unknown;
    try {
      await runSeed({ PAROL_DEMO_IDENTITY: "1", PAROL_DATA_DIR: file }, [], () => {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(MARKER);
    const said = describeSeedFailure(thrown);
    expect(said.startsWith("Parol seed cannot run: ")).toBe(true);
    expect(said).toContain("PAROL_DATA_DIR");
    expect(said).toMatch(SAYS_WHAT_TO_DO);
    expect(said).not.toContain(MARKER);
    expect(said).not.toContain(parent);
    expect(said).not.toMatch(NO_DASH);
  });

  it("gives every refusal the seed makes itself a sentence that says what to do", () => {
    const source = readFileSync(join(import.meta.dirname, "../../src/seed.ts"), "utf8");
    const messages: string[] = [];
    for (const start of source.matchAll(/new SeedError\(/g)) {
      // The arguments of the call, to the parenthesis that closes it.
      let depth = 1;
      let end = start.index + start[0].length;
      for (; depth > 0 && end < source.length; end += 1) {
        if (source[end] === "(") depth += 1;
        else if (source[end] === ")") depth -= 1;
      }
      messages.push(source.slice(start.index + start[0].length, end - 1));
    }
    expect(messages.length).toBeGreaterThan(6);
    for (const message of messages) {
      // An instruction, or the usage line, which is one; the conversion of the pilot demonstration's
      // refusals adds its own.
      expect(
        /\b(?:Set|Run|Use|restore|get|seed again)\b|\$\{USAGE\}|error\.message/.test(message),
        message,
      ).toBe(true);
    }
  });
});
