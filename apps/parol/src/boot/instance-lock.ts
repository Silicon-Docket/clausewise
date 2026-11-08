import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The file the lock lives in, inside the data folder. It holds no data. */
export const INSTANCE_LOCK_FILE = "parol.lock";

export interface InstanceLock {
  /** Gives the data folder up. Safe to call more than once. */
  release(): void;
}

/** SQLite's result codes for a lock another connection holds. The low byte is the primary code. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/**
 * Takes the data folder for this process, or returns `null` when another process already has it.
 *
 * Starting marks every run still in flight as interrupted (`markInterruptedRuns`), which is right
 * after a crash and wrong while another server is alive and working on those very runs: that
 * server's results would be dropped and a resume would collide with its still-running job. Nothing
 * that opens the data folder for a server may happen before this has succeeded.
 *
 * The lock is an exclusive SQLite lock held on a file of its own, for the life of the process. The
 * operating system drops it when the process ends, however it ends (a crash, `kill -9`), so there is
 * no stale lock to clean up and no process id to compare, which would be wrong across containers
 * that share a volume. It does not use the database file itself: that one is meant to be opened
 * by `pnpm parol:seed` and read by tools while the server runs.
 */
export function acquireInstanceLock(dataDir: string): InstanceLock | null {
  const path = join(dataDir, INSTANCE_LOCK_FILE);
  // No wait: the answer is needed now, and a server that is up does not let go.
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    const code = (error as { errcode?: unknown }).errcode;
    if (typeof code === "number" && [SQLITE_BUSY, SQLITE_LOCKED].includes(code & 0xff)) return null;
    throw error;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Some platforms ignore modes. The folder's own mode is the control that matters.
  }
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      db.close();
    },
  };
}
