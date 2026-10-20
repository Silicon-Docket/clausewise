import { mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./log.js";

/** Another Clausewise has the data folder. The message says which folder and what to do. */
export class DataFolderInUseError extends Error {
  override name = "DataFolderInUseError";
}

export interface DataLock {
  /** Removes the lock file. Safe to call twice. */
  release(): Promise<void>;
}

export const LOCK_FILE_NAME = "clausewise.lock";

/** The lock files this process holds, by real path. */
const held = new Set<string>();

const PID = /^[0-9]{1,10}$/;
const ATTEMPTS = 3;
// A lock file is created and then written. A process that starts in between sees it empty.
const EMPTY_RETRIES = 5;
const EMPTY_WAIT_MS = 40;

/** Whether a process with this id exists. A process we may not signal still exists. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

const isExists = (error: unknown): boolean => (error as { code?: string }).code === "EEXIST";
const isMissing = (error: unknown): boolean => (error as { code?: string }).code === "ENOENT";
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function readLock(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** What the lock file says, waiting a moment for a file that is still being written. */
async function readHolder(path: string): Promise<{ content: string | undefined; pid?: number }> {
  let content = await readLock(path);
  for (let retry = 0; retry < EMPTY_RETRIES && content === ""; retry += 1) {
    await pause(EMPTY_WAIT_MS);
    content = await readLock(path);
  }
  return content !== undefined && PID.test(content)
    ? { content, pid: Number(content) }
    : { content };
}

function inUse(folder: string, lockPath: string, pid: number | undefined): DataFolderInUseError {
  const holder =
    pid === undefined
      ? "a lock file is there"
      : pid === process.pid
        ? "this same program has it open"
        : `the process with id ${pid} holds its lock`;
  return new DataFolderInUseError(
    `Another Clausewise may be using the data folder ${folder} (${holder}). Two servers on one folder would damage the database and the stored contracts, so this one did not start. Stop the other one, or give this one its own folder with CLAUSEWISE_DATA_DIR. If you are sure no other Clausewise is running, delete the file ${lockPath} and start again.`,
  );
}

/** The work of `lockDataFolder`, for one caller at a time. */
async function acquire(
  dir: string,
  log: Logger,
  running: (pid: number) => boolean,
): Promise<DataLock> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const folder = await realpath(dir);
  const path = join(folder, LOCK_FILE_NAME);
  const mine = String(process.pid);

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${mine}\n`);
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(path, { force: true });
        throw error;
      }
      await handle.close();
    } catch (error) {
      if (!isExists(error)) throw error;
      const holder = await readHolder(path);
      if (holder.content === undefined) continue; // removed since: try again
      const live =
        held.has(path) ||
        (holder.pid !== undefined && holder.pid !== process.pid && running(holder.pid));
      if (live) throw inUse(folder, path, holder.pid);
      // The same file still, so what is removed is the lock that was judged.
      if ((await readLock(path)) === holder.content) {
        log.warn("took over the data folder from a Clausewise that did not shut down cleanly", {
          lockedBy: holder.pid ?? "unknown",
        });
        await rm(path, { force: true });
      }
      continue;
    }

    held.add(path);
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        try {
          // Only a lock that still names this process: anything else is not ours to remove.
          if ((await readLock(path).catch(() => undefined)) === mine) {
            await rm(path, { force: true });
          }
        } finally {
          // After the file is gone, so that no start in this process reads a lock that is about
          // to be removed as one left over by a crash.
          held.delete(path);
        }
      },
    };
  }
  throw inUse(folder, path, undefined);
}

// Two servers started in one process (a test does, a script could) take their locks one after the
// other, so that "is this lock ours?" is never asked between another's create and its note of it.
let turn: Promise<unknown> = Promise.resolve();

/**
 * Takes the data folder for this server. The embedded database and the stored contracts live in
 * it, and a second server on the same files would corrupt both (and delete the temporary files of
 * the first when it tidies its folder), so the lock is taken in every mode, also when the
 * database is a Postgres server: the stored files are still in the folder.
 *
 * The lock is a file made with O_EXCL (so exactly one process can make it) that holds the id of
 * the process. A lock whose process is gone is left over from a crash: it is taken over, with a
 * line in the log. A lock whose process runs stops the start with a message that names the folder.
 * A lock with this process's own id that this process did not take is also left over: in a
 * container the server is always process 1, so after a restart the old lock carries the id of the
 * new server.
 *
 * Not covered: a folder shared by processes that cannot see each other, such as two containers
 * on one volume, because a process id means nothing across them. Taking over a stale lock is two
 * steps (remove, then create), so two servers that start in the same instant on a stale lock can
 * both succeed; the window is the time between a read and a remove.
 *
 * `running` says whether a process id is alive; the default asks the system, and a test gives its own.
 */
export function lockDataFolder(
  dir: string,
  log: Logger,
  running: (pid: number) => boolean = isProcessRunning,
): Promise<DataLock> {
  const taken = turn.then(() => acquire(dir, log, running));
  turn = taken.catch(() => {});
  return taken;
}
