import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DataFolderInUseError,
  LOCK_FILE_NAME,
  isProcessRunning,
  lockDataFolder,
} from "../src/lock.js";
import { silentLogger } from "../src/log.js";
import { createMemoryStorage } from "../src/storage.js";
import { startServer, type RunningServer, type StartOptions } from "../src/start.js";
import { captureLog, fakeClock, later, oracleFor, tempDir, testConfig } from "./support.js";

// A process that is certainly running, and the id of one that certainly is not.
async function runningProcess(): Promise<ChildProcess & { pid: number }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  later(async () => {
    child.kill();
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (child.pid === undefined) throw new Error("the child process has no id");
  return Object.assign(child, { pid: child.pid });
}

async function goneProcessId(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (pid === undefined) throw new Error("the child process has no id");
  return pid;
}

/** The error a call ends in. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("The call was expected to fail.");
}

const lockPath = (dir: string): string => join(dir, LOCK_FILE_NAME);
const readLock = (dir: string): Promise<string> => readFile(lockPath(dir), "utf8");
const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("the lock on the data folder", () => {
  describe("by itself", () => {
    it("is a file with the process id, private to the owner, and it is removed on release", async () => {
      const dir = await tempDir();
      const lock = await lockDataFolder(dir, silentLogger);
      expect(await readLock(dir)).toBe(`${process.pid}\n`);
      expect((await stat(lockPath(dir))).mode & 0o777).toBe(0o600);
      await lock.release();
      expect(await exists(lockPath(dir))).toBe(false);
      // Twice is the same as once, and the folder can be taken again.
      await lock.release();
      const again = await lockDataFolder(dir, silentLogger);
      await again.release();
    });

    it("makes the folder when it is not there yet", async () => {
      const dir = join(await tempDir(), "not", "yet");
      const lock = await lockDataFolder(dir, silentLogger);
      expect(await exists(lockPath(dir))).toBe(true);
      await lock.release();
    });

    it("lets exactly one of two that ask in the same instant have the folder", async () => {
      const dir = await tempDir();
      const results = await Promise.allSettled([
        lockDataFolder(dir, silentLogger),
        lockDataFolder(dir, silentLogger),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      for (const result of results) {
        if (result.status === "fulfilled") await result.value.release();
        else expect(result.reason).toBeInstanceOf(DataFolderInUseError);
      }
    });

    it("lets exactly one of two take over a stale lock in the same instant", async () => {
      const dir = await tempDir();
      await writeFile(lockPath(dir), `${await goneProcessId()}\n`);
      const results = await Promise.allSettled([
        lockDataFolder(dir, silentLogger),
        lockDataFolder(dir, silentLogger),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      for (const result of results) {
        if (result.status === "fulfilled") await result.value.release();
      }
    });

    it("does not remove a lock that no longer names this process", async () => {
      const dir = await tempDir();
      const lock = await lockDataFolder(dir, silentLogger);
      await writeFile(lockPath(dir), "99999999\n");
      await lock.release();
      expect(await readLock(dir)).toBe("99999999\n");
    });

    it("sees a process that runs, a process that is gone, and itself", async () => {
      const child = await runningProcess();
      expect(isProcessRunning(child.pid)).toBe(true);
      expect(isProcessRunning(process.pid)).toBe(true);
      expect(isProcessRunning(await goneProcessId())).toBe(false);
    });
  });

  describe("when another Clausewise has it", () => {
    it("stops the start, names the folder and the process, and leaves the other's lock alone", async () => {
      const dir = await tempDir();
      const child = await runningProcess();
      await writeFile(lockPath(dir), `${child.pid}\n`);

      const error = await failure(lockDataFolder(dir, silentLogger));
      expect(error).toBeInstanceOf(DataFolderInUseError);
      const message = error.message;
      expect(message).toContain("Another Clausewise may be using the data folder");
      expect(message).toContain(await realpath(dir));
      expect(message).toContain(`the process with id ${child.pid}`);
      expect(message).toContain("CLAUSEWISE_DATA_DIR");
      expect(message).toContain(lockPath(await realpath(dir)));
      expect(await readLock(dir)).toBe(`${child.pid}\n`);
    });

    it("also stops a lock taken by this very process, which is how two servers in one program meet", async () => {
      const dir = await tempDir();
      const first = await lockDataFolder(dir, silentLogger);
      const second = lockDataFolder(dir, silentLogger);
      await expect(second).rejects.toThrow("this same program has it open");
      // The refused one did not take the first one's lock with it.
      expect(await readLock(dir)).toBe(`${process.pid}\n`);
      await first.release();
    });

    it("sees the same folder through a link", async () => {
      const base = await tempDir();
      const real = join(base, "real");
      await mkdir(real);
      await symlink(real, join(base, "link"));
      const first = await lockDataFolder(real, silentLogger);
      await expect(lockDataFolder(join(base, "link"), silentLogger)).rejects.toBeInstanceOf(
        DataFolderInUseError,
      );
      await first.release();
    });
  });

  describe("when the Clausewise that had it is gone", () => {
    it("takes over, and says so in the log", async () => {
      const dir = await tempDir();
      const gone = await goneProcessId();
      await writeFile(lockPath(dir), `${gone}\n`);
      const { log, lines } = captureLog(fakeClock());

      const lock = await lockDataFolder(dir, log);
      expect(await readLock(dir)).toBe(`${process.pid}\n`);
      const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries).toEqual([
        expect.objectContaining({
          level: "warn",
          msg: "took over the data folder from a Clausewise that did not shut down cleanly",
          lockedBy: gone,
        }),
      ]);
      await lock.release();
      expect(await exists(lockPath(dir))).toBe(false);
    });

    it("takes over a lock that holds this process's id but that this process did not take", async () => {
      // A container's server is always process 1, so a lock left by the one before it says 1 too.
      const dir = await tempDir();
      await writeFile(lockPath(dir), `${process.pid}\n`);
      const { log, lines } = captureLog(fakeClock());
      const lock = await lockDataFolder(dir, log);
      expect(lines).toHaveLength(1);
      await lock.release();
    });

    it("takes over a lock file that holds no process id, such as one cut short by a crash", async () => {
      for (const content of ["", "\n", "not a number", "12 34", "-5", "99999999999999"]) {
        const dir = await tempDir();
        await writeFile(lockPath(dir), content);
        const { log, lines } = captureLog(fakeClock());
        const lock = await lockDataFolder(dir, log);
        expect([content, lines.length]).toEqual([content, 1]);
        expect(await readLock(dir)).toBe(`${process.pid}\n`);
        await lock.release();
      }
    });

    it("asks the system, through the function it is given, whether a process runs", async () => {
      const dir = await tempDir();
      await writeFile(lockPath(dir), "4242\n");
      const asked: number[] = [];
      await expect(
        lockDataFolder(dir, silentLogger, (pid) => {
          asked.push(pid);
          return true;
        }),
      ).rejects.toBeInstanceOf(DataFolderInUseError);
      expect(asked).toEqual([4242]);
      const lock = await lockDataFolder(dir, silentLogger, () => false);
      await lock.release();
    });
  });
});

describe("starting two servers on one folder", () => {
  async function start(
    dataDir: string,
    more: Partial<StartOptions> = {},
    config: Parameters<typeof testConfig>[1] = {},
  ): Promise<RunningServer> {
    const server = await startServer({
      config: testConfig(dataDir, config),
      generator: await oracleFor("nda-aggressive.docx"),
      log: silentLogger,
      ...more,
    });
    later(() => server.close());
    return server;
  }

  it("refuses the second with a message about the folder, keeps the first running, and lets a third start after the first stops", async () => {
    const dataDir = await tempDir();
    const first = await start(dataDir, { database: { kind: "memory" } });
    expect(await readLock(dataDir)).toBe(`${process.pid}\n`);

    const refused = await failure(
      startServer({
        config: testConfig(dataDir),
        generator: await oracleFor("nda-aggressive.docx"),
        log: silentLogger,
        database: { kind: "memory" },
      }),
    );
    expect(refused).toBeInstanceOf(DataFolderInUseError);
    const message = refused.message;
    expect(message).toContain(await realpath(dataDir));
    expect(message).toContain("Another Clausewise may be using the data folder");

    // The refusal did not disturb the first server or its lock.
    expect((await fetch(`${first.url}/healthz`)).status).toBe(200);
    expect(await readLock(dataDir)).toBe(`${process.pid}\n`);

    await first.close();
    expect(await exists(lockPath(dataDir))).toBe(false);
    const third = await start(dataDir, { database: { kind: "memory" } });
    expect((await fetch(`${third.url}/healthz`)).status).toBe(200);
  });

  it("locks the folder of the stored files when the database is somewhere else, as it is with Postgres", async () => {
    // A database that is not in the folder stands for Postgres here: either way the stored
    // contracts are in the folder, and two servers must not share them.
    const dataDir = await tempDir();
    await start(dataDir, { database: { kind: "memory" } });
    await expect(start(dataDir, { database: { kind: "memory" } })).rejects.toBeInstanceOf(
      DataFolderInUseError,
    );
    expect((await readdir(join(dataDir, "documents"))).filter((n) => n.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("takes the embedded database's folder before it opens it, so the first server's database is untouched", async () => {
    const dataDir = await tempDir();
    const first = await start(dataDir);
    expect(await exists(join(dataDir, "pglite"))).toBe(true);
    await expect(start(dataDir)).rejects.toBeInstanceOf(DataFolderInUseError);
    expect((await fetch(`${first.url}/api/documents`)).status).toBe(200);
    await first.close();
    // The folder opens again, and holds what the first server made.
    const again = await start(dataDir);
    expect((await fetch(`${again.url}/api/documents`)).status).toBe(200);
  });

  it("takes over the folder of a server that was killed", async () => {
    const dataDir = await tempDir();
    await mkdir(dataDir, { recursive: true });
    await writeFile(lockPath(dataDir), `${await goneProcessId()}\n`);
    const { log, lines } = captureLog(fakeClock());
    const server = await start(dataDir, { database: { kind: "memory" }, log });
    expect(lines.some((line) => line.includes("took over the data folder"))).toBe(true);
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
  });

  it("needs no lock when neither the files nor the database are in the folder", async () => {
    const dataDir = await tempDir();
    const options = { database: { kind: "memory" } as const, storage: createMemoryStorage() };
    const first = await start(dataDir, options);
    const second = await start(dataDir, { ...options, storage: createMemoryStorage() });
    expect(first.port).not.toBe(second.port);
    expect(await exists(lockPath(dataDir))).toBe(false);
  });

  it("lets the folder go when the start fails after the lock was taken", async () => {
    const dataDir = await tempDir();
    // The address is taken: the server cannot listen.
    const other = await start(await tempDir(), { database: { kind: "memory" } });
    await expect(
      start(dataDir, { database: { kind: "memory" } }, { port: other.port }),
    ).rejects.toThrow();
    expect(await exists(lockPath(dataDir))).toBe(false);

    // The database cannot be set up: the migration files are not where they should be.
    await expect(
      start(dataDir, { database: { kind: "memory" }, migrationsFolder: join(dataDir, "nowhere") }),
    ).rejects.toThrow();
    expect(await exists(lockPath(dataDir))).toBe(false);

    // And the folder can be used at once.
    await start(dataDir, { database: { kind: "memory" } });
  });
});
