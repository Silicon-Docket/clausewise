import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { acquireInstanceLock } from "../../src/boot/instance-lock.js";
import { DEFAULT_DATA_DIR, start, type RunningServer } from "../../src/main.js";
import { DATABASE_FILE, dataFolder } from "../../src/cli-common.js";
import {
  describeRetention,
  exitCodeOf,
  parseAsOf,
  parseRetainArgs,
  runRetain,
} from "../../src/retain.js";
import { runRetention } from "../../src/retention/job.js";
import {
  DEFAULT_MIGRATIONS_DIR,
  createRepository,
  loadMigrationFiles,
  openDatabase,
} from "../../src/store/index.js";
import { ROOT } from "../integration/pipeline.js";
import { cleanup, makeWorld, uploadCase, type World } from "../services/support.js";

/**
 * `pnpm parol:retain` as a command: its options, its exit codes, what it prints, and that it does
 * not run beside the server. The job itself is in job.test.ts.
 */

afterAll(cleanup);

const NAME_MARK = "QZNAME-31c8";
const CLIENT_MARK = "QZCLIENT-62ab";
const LATER = new Date("2026-11-10T00:00:00.000Z");

const running: RunningServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
});

interface Folder {
  w: World;
  dataDir: string;
  ids: string[];
}

/** A data folder with `days.length` matters, due in those days, and no connection to it left open. */
async function folderWith(days: number[]): Promise<Folder> {
  const w = makeWorld({ onDisk: true });
  const ids: string[] = [];
  for (const [index, due] of days.entries()) {
    const created = w.services.matters.create(w.associate, {
      name: `Matter ${index} ${NAME_MARK}`,
      clientLegalName: `Client ${index} ${CLIENT_MARK}, Inc.`,
      playbookVersionId: w.playbookVersionId,
      reviewerUserId: w.reviewer.userId,
    });
    await uploadCase(w, created.id);
    w.repo.setRetention(created.id, due, { actorId: w.associate.userId });
    ids.push(created.id);
  }
  w.repo.db.close();
  return { w, dataDir: w.root, ids };
}

/** Runs the command in this process and collects what it printed. */
async function retain(
  dataDir: string,
  argv: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runRetain(
    { PAROL_DATA_DIR: dataDir, ...env },
    argv,
    (line) => out.push(line),
    (line) => err.push(line),
    () => LATER,
  );
  return { code, out, err };
}

/** The matters left in the database, read with a connection of the test's own. */
function mattersLeft(dataDir: string): string[] {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    return createRepository(db).listMatterIds();
  } finally {
    db.close();
  }
}

const sha = (dataDir: string): string =>
  createHash("sha256")
    .update(readFileSync(join(dataDir, DATABASE_FILE)))
    .digest("hex");

describe("the options", () => {
  it("reads --apply, --max-matters, --as-of and --json, in both spellings, and skips the lone --", () => {
    expect(parseRetainArgs([])).toEqual({ apply: false, maxMatters: 25, json: false });
    expect(parseRetainArgs(["--", "--apply", "--max-matters", "3", "--json"])).toEqual({
      apply: true,
      maxMatters: 3,
      json: true,
    });
    expect(parseRetainArgs(["--max-matters=1000"]).maxMatters).toBe(1000);
    expect(parseRetainArgs(["--as-of=2026-12-01"]).asOf?.toISOString()).toBe(
      "2026-12-01T00:00:00.000Z",
    );
    expect(parseRetainArgs(["--as-of", "2026-12-01T09:30:00+02:00"]).asOf?.toISOString()).toBe(
      "2026-12-01T07:30:00.000Z",
    );
  });

  it("refuses anything else with a message that names the option and never repeats its value", () => {
    const SECRET = "SECRETVALUE-9f";
    const refused = [
      ["--max-matters", "0"],
      ["--max-matters", "1001"],
      ["--max-matters", SECRET],
      ["--max-matters", "2.5"],
      ["--max-matters"],
      ["--as-of", SECRET],
      ["--as-of", "2026-02-31"],
      ["--as-of", "2026-13-01"],
      ["--as-of", "2026-12-01T25:00:00Z"],
      ["--as-of", "2026-12-01T10:00:00"],
      ["--as-of"],
      ["--apply", "--as-of", "2026-12-01"],
      ["--as-of", "2026-12-01", "--apply"],
      [`--${SECRET}`],
      [SECRET],
    ];
    for (const argv of refused) {
      let message = "";
      try {
        parseRetainArgs(argv);
      } catch (error) {
        message = (error as Error).message;
        expect((error as Error).name).toBe("CliUsageError");
      }
      expect(message, argv.join(" ")).not.toBe("");
      expect(message, argv.join(" ")).not.toContain(SECRET);
      expect(message, argv.join(" ")).toContain("usage: pnpm parol:retain");
    }
  });

  it("reads a date as midnight UTC and refuses one that is not a day on the calendar", () => {
    expect(parseAsOf("2026-02-28")?.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(parseAsOf("2028-02-29")?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(parseAsOf("2026-02-29")).toBeNull();
    expect(parseAsOf("2026-04-31")).toBeNull();
    expect(parseAsOf("2026-12-01T09:00:00Z")?.toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(parseAsOf("2026-12-01T09:00Z")?.toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(parseAsOf("2026-02-30T09:00:00Z")).toBeNull();
    expect(parseAsOf("yesterday")).toBeNull();
  });
});

describe("the data folder", () => {
  it("is PAROL_DATA_DIR, or the server's default, and nothing else is read", () => {
    expect(dataFolder({ PAROL_DATA_DIR: "/tmp/somewhere" }).dataDir).toBe("/tmp/somewhere");
    expect(dataFolder({ PAROL_DATA_DIR: "  " }).dataDir).toBe(dataFolder({}).dataDir);
    expect(dataFolder({}).dataDir.endsWith(DEFAULT_DATA_DIR.replace("./", "/"))).toBe(true);
    expect(dataFolder({ PAROL_DATA_DIR: "/x" }).databasePath).toBe("/x/parol.sqlite");
  });
});

describe("a dry run", () => {
  it("lists the matters past their date with a count and its denominator, prints no name, and exits 0", async () => {
    const { dataDir, ids } = await folderWith([1, 90, 2]);
    const before = sha(dataDir);

    const { code, out, err } = await retain(dataDir, []);

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toBe("Parol retention (dry run: nothing is changed)");
    expect(out).toContain(`Data folder: ${dataDir}`);
    expect(out).toContain(`Judged at: ${LATER.toISOString()}`);
    expect(out).toContain("Matters past their retention date: 2 of 3");
    // The two due matters, in the order of their dates, with their status, date and creator.
    const listed = out.filter((line) => line.startsWith("  mat_"));
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatch(
      new RegExp(
        `^  ${ids[0]}  ready  kept until 2026-11-0\\dT\\S+Z  created by usr_demo_associate$`,
      ),
    );
    expect(listed[1]).toContain(ids[2]!);
    expect(out.some((line) => line.includes(ids[1]!))).toBe(false);
    expect(out).toContain("Matter folders that no matter names: 0");
    expect(out.find((line) => line.startsWith("Audit log: intact,"))).toMatch(
      /intact, \d+ events$/,
    );
    expect(out).toContain("To delete these, stop the server and run: pnpm parol:retain --apply");
    expect(out.at(-1)).toBe("Names are not printed. Look a matter up by its id.");
    const text = out.join("\n");
    expect(text).not.toContain(NAME_MARK);
    expect(text).not.toContain(CLIENT_MARK);

    // Nothing was changed: the matters are all there and the database file is as it was.
    expect(mattersLeft(dataDir).sort()).toEqual([...ids].sort());
    expect(sha(dataDir)).toBe(before);
  });

  it("works with --as-of, says what --apply would refuse, and still exits 0", async () => {
    const { dataDir } = await folderWith([90, 90, 90]);
    const none = await retain(dataDir, []);
    expect(none.out).toContain("Matters past their retention date: 0 of 3");
    expect(none.out.join("\n")).not.toContain("To delete these");

    const asOf = await retain(dataDir, ["--as-of", "2027-06-01", "--max-matters", "2"]);
    expect(asOf.code).toBe(0);
    expect(asOf.out).toContain("Judged at: 2027-06-01T00:00:00.000Z");
    expect(asOf.out).toContain("Matters past their retention date: 3 of 3");
    expect(asOf.out).toContain(
      "--apply would refuse: more than 2 matters are past their date (--max-matters).",
    );
    expect(mattersLeft(dataDir)).toHaveLength(3);
  });

  it("applies no migration to a database that is one migration behind, and reads it as it is", async () => {
    const parent = mkdtempSync(join(tmpdir(), "parol-retain-behind-"));
    try {
      const files = loadMigrationFiles();
      const old = join(parent, "migrations");
      mkdirSync(old);
      for (const file of files.slice(0, files.length - 1)) {
        const name = `${String(file.version).padStart(3, "0")}_${file.name}.sql`;
        copyFileSync(join(DEFAULT_MIGRATIONS_DIR, name), join(old, name));
      }
      const dataDir = join(parent, "data");
      mkdirSync(dataDir);
      const db = openDatabase(join(dataDir, DATABASE_FILE), { migrationsDir: old });
      createRepository(db).seedDemoUsers();
      db.close();
      const before = sha(dataDir);

      const { code, out, err } = await retain(dataDir, []);

      expect(err).toEqual([]);
      expect(code).toBe(0);
      expect(out).toContain("Matters past their retention date: 0 of 0");
      expect(sha(dataDir)).toBe(before);
      const reader = openDatabase(join(dataDir, DATABASE_FILE), { migrationsDir: old });
      expect(
        (reader.prepare("SELECT version FROM schema_migrations").all() as { version: number }[])
          .length,
      ).toBe(files.length - 1);
      reader.close();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not create the folder of the files when the data folder has none, and reads it as holding no matter", async () => {
    const { dataDir, ids } = await folderWith([1]);
    rmSync(join(dataDir, "matters"), { recursive: true });
    expect(existsSync(join(dataDir, "matters"))).toBe(false);

    const { code, out } = await retain(dataDir, []);

    expect(code).toBe(0);
    expect(out).toContain("Matters past their retention date: 1 of 1");
    expect(out).toContain("Matter folders that no matter names: 0");
    expect(out.some((line) => line.includes(ids[0]!))).toBe(true);
    expect(existsSync(join(dataDir, "matters"))).toBe(false);
  });

  it("prints one JSON object and nothing else with --json", async () => {
    const { dataDir, ids } = await folderWith([1]);
    const { code, out } = await retain(dataDir, ["--json"]);
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      dataFolder: dataDir,
      mode: "dry_run",
      totalMatters: 1,
      expired: 1,
      refusedByLimit: false,
      chain: { ok: true },
    });
    expect((parsed["lines"] as { matterId: string }[]).map((l) => l.matterId)).toEqual(ids);
    expect(out[0]).not.toContain(NAME_MARK);
  });

  it("runs while a server holds the data folder", async () => {
    const { w, dataDir, ids } = await folderWith([1]);
    const server = await start(
      {
        PAROL_DEMO_IDENTITY: "1",
        PAROL_SCRIPTED: "1",
        PAROL_PORT: "0",
        PAROL_DATA_DIR: dataDir,
        PAROL_COOKIE_SECRET: "retention-cli-secret-retention-cli-01",
      },
      { log: () => {}, notice: () => {} },
    );
    running.push(server);
    const { code, out } = await retain(dataDir, []);
    expect(code).toBe(0);
    expect(out).toContain("Matters past their retention date: 1 of 1");
    expect(out.some((line) => line.includes(ids[0]!))).toBe(true);
    expect(server.repo.listMatterIds()).toEqual(ids);
    void w;
  });
});

describe("apply", () => {
  it("deletes what is due, prints what it did without a name, and exits 0", async () => {
    const { dataDir, ids } = await folderWith([1, 90, 2]);

    const { code, out, err } = await retain(dataDir, ["--apply"]);

    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out[0]).toBe("Parol retention (apply)");
    const deleted = out.filter((line) => line.startsWith("  deleted "));
    expect(deleted).toHaveLength(2);
    expect(deleted[0]).toMatch(new RegExp(`^  deleted ${ids[0]}: \\d+ rows, 2 files$`));
    expect(deleted[1]).toMatch(new RegExp(`^  deleted ${ids[2]}: \\d+ rows, 2 files$`));
    expect(out).toContain(
      "Deleted 2, skipped 0, failed 0, of 2 past their date (3 matters in the database).",
    );
    expect(out).toContain("Folders with no matter removed: 0");
    expect(out).toContain("Database compacted: yes");
    expect(out.find((line) => line.startsWith("Audit log: intact,"))).toBeDefined();
    const text = out.join("\n");
    expect(text).not.toContain(NAME_MARK);
    expect(text).not.toContain(CLIENT_MARK);
    expect(mattersLeft(dataDir)).toEqual([ids[1]]);
    expect(readdirSync(join(dataDir, "matters"))).toEqual([ids[1]]);
  });

  it("exits 2 and deletes nothing while a server has the data folder, and works once it is stopped", async () => {
    const { dataDir, ids } = await folderWith([1]);
    const server = await start(
      {
        PAROL_DEMO_IDENTITY: "1",
        PAROL_SCRIPTED: "1",
        PAROL_PORT: "0",
        PAROL_DATA_DIR: dataDir,
        PAROL_COOKIE_SECRET: "retention-cli-secret-retention-cli-02",
      },
      { log: () => {}, notice: () => {} },
    );
    running.push(server);

    const refused = await retain(dataDir, ["--apply"]);
    expect(refused.code).toBe(2);
    expect(refused.out).toEqual([]);
    expect(refused.err.join("\n")).toContain("another Parol process is using this data folder");
    expect(refused.err.join("\n")).toContain("Stop the server and run this again.");
    expect(server.repo.listMatterIds()).toEqual(ids);

    await server.close();
    running.length = 0;
    const done = await retain(dataDir, ["--apply"]);
    expect(done.code).toBe(0);
    expect(mattersLeft(dataDir)).toEqual([]);
  });

  it("exits 2 while another process holds the lock, and 0 for a dry run beside it", async () => {
    const { dataDir, ids } = await folderWith([1]);
    const lock = acquireInstanceLock(dataDir);
    expect(lock).not.toBeNull();
    try {
      expect((await retain(dataDir, ["--apply"])).code).toBe(2);
      expect((await retain(dataDir, [])).code).toBe(0);
    } finally {
      lock!.release();
    }
    expect(mattersLeft(dataDir)).toEqual(ids);
  });

  it("exits 3 and deletes nothing when more matters are due than --max-matters", async () => {
    const { dataDir, ids } = await folderWith([1, 1, 1]);
    const { code, out } = await retain(dataDir, ["--apply", "--max-matters", "2"]);
    expect(code).toBe(3);
    expect(out.join("\n")).toContain(
      "Refused: 3 matters are past their date and --max-matters is 2. Nothing was deleted.",
    );
    expect(out.filter((line) => line.startsWith("  mat_"))).toHaveLength(3);
    expect(out).toContain("Database compacted: no, nothing was deleted");
    expect(mattersLeft(dataDir).sort()).toEqual([...ids].sort());
  });

  it("exits 1 when a matter could not be deleted, after deleting the others", async () => {
    const { dataDir, ids } = await folderWith([1, 1]);
    // A table the deletion was not taught about makes the store roll one matter back.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    db.exec("CREATE TABLE zz_extra (matter_id TEXT)");
    db.prepare("INSERT INTO zz_extra (matter_id) VALUES (?)").run(ids[0]!);
    db.close();

    const { code, out } = await retain(dataDir, ["--apply"]);

    expect(code).toBe(1);
    expect(out).toContain(`  FAILED ${ids[0]}: store_refused`);
    expect(out).toContain(
      "Deleted 1, skipped 0, failed 1, of 2 past their date (2 matters in the database).",
    );
    expect(mattersLeft(dataDir)).toEqual([ids[0]]);
  });

  it("exits 1 when the audit chain does not verify, and has deleted what was due all the same", async () => {
    const { dataDir, ids } = await folderWith([1]);
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    db.exec("DROP TRIGGER audit_events_no_update");
    db.prepare("UPDATE audit_events SET actor_id = 'usr_demo_admin' WHERE seq = 2").run();
    db.close();

    const { code, out } = await retain(dataDir, ["--apply"]);

    expect(code).toBe(1);
    expect(mattersLeft(dataDir)).toEqual([]);
    const line = out.find((l) => l.startsWith("Audit log: BROKEN"))!;
    expect(line).toContain("BROKEN at event 2");
    expect(line).toContain("this event's content does not match its hash");
    expect(ids).toHaveLength(1);
  });

  it("is not stopped by a bad PAROL_COOKIE_SECRET: it reads the data folder and nothing else", async () => {
    const { dataDir } = await folderWith([1]);
    const { code } = await retain(dataDir, ["--apply"], {
      PAROL_COOKIE_SECRET: "short",
      PAROL_PORT: "not a port",
    });
    expect(code).toBe(0);
    expect(mattersLeft(dataDir)).toEqual([]);
  });
});

describe("what it cannot run on", () => {
  it("exits 2 for a usage error, with a message and nothing deleted", async () => {
    const { dataDir, ids } = await folderWith([1]);
    for (const argv of [
      ["--apply", "--as-of", "2026-12-01"],
      ["--surprise"],
      ["--max-matters", "0"],
      ["--max-matters", "SECRETVALUE"],
    ]) {
      const { code, out, err } = await retain(dataDir, argv);
      expect(code, argv.join(" ")).toBe(2);
      expect(out).toEqual([]);
      expect(err.join("\n")).toContain("Parol retention cannot run:");
      expect(err.join("\n")).not.toContain("SECRETVALUE");
    }
    expect(mattersLeft(dataDir)).toEqual(ids);
  });

  it("exits 2 for a data folder with no database, and creates nothing: not the folder, not the lock file", async () => {
    const parent = mkdtempSync(join(tmpdir(), "parol-retain-none-"));
    try {
      const missing = join(parent, "nowhere");
      for (const argv of [[], ["--apply"]]) {
        const { code, err } = await retain(missing, argv);
        expect(code).toBe(2);
        expect(err.join("\n")).toContain("there is no database in the data folder");
        expect(existsSync(missing)).toBe(false);
      }
      // A folder that exists and holds no database is left as it is.
      const empty = join(parent, "empty");
      mkdirSync(empty);
      expect((await retain(empty, ["--apply"])).code).toBe(2);
      expect(readdirSync(empty)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("exits 2 for a file that is not a Parol database, without echoing anything from it", async () => {
    const parent = mkdtempSync(join(tmpdir(), "parol-retain-notdb-"));
    try {
      writeFileSync(join(parent, DATABASE_FILE), "SECRETVALUE this is not an SQLite file at all");
      const { code, err } = await retain(parent, []);
      expect(code).toBe(2);
      expect(err.join("\n")).toContain("Parol retention cannot run:");
      expect(err.join("\n")).not.toContain("SECRETVALUE");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("the exit code of a finished run", () => {
  it("is 1 for a failed matter, a folder that stayed, a failed compaction or a broken chain, and 3 only for a refusal that is otherwise clean", async () => {
    const w = makeWorld({ onDisk: true });
    const clean = runRetention(
      { repo: w.repo, files: w.files, now: () => LATER },
      { apply: true, maxMatters: 5 },
    );
    expect(exitCodeOf(clean)).toBe(0);
    const base = { ...clean, orphansFailed: 0 };
    expect(exitCodeOf({ ...base, failed: 1 })).toBe(1);
    expect(exitCodeOf({ ...base, orphansFailed: 1 })).toBe(1);
    expect(exitCodeOf({ ...base, compaction: "failed" })).toBe(1);
    expect(
      exitCodeOf({
        ...base,
        chain: { ok: false, firstBrokenSeq: 1, reason: "hash_mismatch", events: 0 },
      }),
    ).toBe(1);
    expect(exitCodeOf({ ...base, refusedByLimit: true })).toBe(3);
    // A broken chain is never hidden behind a refusal.
    expect(
      exitCodeOf({
        ...base,
        refusedByLimit: true,
        chain: { ok: false, firstBrokenSeq: 1, reason: "hash_mismatch", events: 0 },
      }),
    ).toBe(1);
    expect(
      describeRetention(clean, { dataDir: "/d", args: { apply: true, maxMatters: 5 } })[0],
    ).toBe("Parol retention (apply)");
    w.close();
  });
});

describe("pnpm parol:retain, as a process", () => {
  const tsx = join(ROOT, "node_modules", ".bin", "tsx");
  const script = join(ROOT, "apps", "parol", "src", "retain.ts");
  const tsconfig = join(ROOT, "apps", "parol", "tsconfig.json");
  const run = (dataDir: string, args: string[] = []) =>
    spawnSync(tsx, ["--tsconfig", tsconfig, script, ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PAROL_DATA_DIR: dataDir },
      encoding: "utf8",
    });

  it("lists, then deletes, with the exit codes it documents and no stack trace", async () => {
    const { dataDir, ids } = await folderWith([90, 90]);
    // Real time is the command's clock here. The first matter's date is moved to a day long gone and
    // the second's to a day far off, so the outcome does not depend on the day the test runs.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    db.prepare("UPDATE matters SET retain_until = '2026-11-03T10:00:00.000Z' WHERE id = ?").run(
      ids[0]!,
    );
    db.prepare("UPDATE matters SET retain_until = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(
      ids[1]!,
    );
    db.close();

    const dry = run(dataDir);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("Matters past their retention date: 1 of 2");
    expect(dry.stdout).toContain(ids[0]!);
    expect(dry.stdout).not.toContain(ids[1]!);
    expect(dry.stdout).not.toContain(NAME_MARK);
    expect(mattersLeft(dataDir).sort()).toEqual([...ids].sort());

    const applied = run(dataDir, ["--apply"]);
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toContain("Parol retention (apply)");
    expect(applied.stdout).toContain(
      "Deleted 1, skipped 0, failed 0, of 1 past their date (2 matters in the database).",
    );
    expect(mattersLeft(dataDir)).toEqual([ids[1]]);

    const missing = run(join(dataDir, "nowhere"));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("there is no database in the data folder");
    expect(missing.stderr).not.toMatch(/\n\s+at /);

    const usage = run(dataDir, ["--surprise"]);
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("usage: pnpm parol:retain");
  }, 60_000);
});
