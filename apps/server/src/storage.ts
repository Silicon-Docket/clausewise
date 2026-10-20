import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

/** Where the uploaded .docx files live. The key is random; the user's file name is never part of it. */
export interface DocumentStorage {
  /** Writes the whole file or nothing: a reader never sees half of it. */
  write(key: string, bytes: Uint8Array): Promise<void>;
  /** The file, or undefined when there is none under this key. */
  read(key: string): Promise<Uint8Array<ArrayBuffer> | undefined>;
  /** Removes the file. A file that is already gone is not an error. */
  remove(key: string): Promise<void>;
}

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEMPORARY = ".tmp";

function checkKey(key: string): void {
  // The key comes from our own database, but the check keeps a bad row from reaching outside the
  // folder.
  if (!KEY.test(key)) throw new Error("Invalid storage key.");
}

const isMissing = (error: unknown): boolean => (error as { code?: string }).code === "ENOENT";

/**
 * Files on disk under `<dir>`, folder mode 0700 and file mode 0600. A write goes to a temporary
 * name in the same folder and is renamed into place, which is atomic on one file system, so a
 * crash leaves either no file or a whole one. Temporary files left by a crash are removed at start.
 */
export async function createFileStorage(dir: string): Promise<DocumentStorage> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing folder as it is, and the umask can narrow the mode but not widen it.
  await chmod(dir, 0o700);
  for (const name of await readdir(dir)) {
    if (name.endsWith(TEMPORARY)) await rm(join(dir, name), { force: true });
  }

  return {
    async write(key, bytes) {
      checkKey(key);
      const temporary = join(dir, `${key}.${randomBytes(6).toString("hex")}${TEMPORARY}`);
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, join(dir, key));
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },

    async read(key) {
      checkKey(key);
      try {
        return new Uint8Array(await readFile(join(dir, key)));
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },

    async remove(key) {
      checkKey(key);
      await rm(join(dir, key), { force: true });
    },
  };
}

/** Storage in memory, for tests that do not look at the disk. */
export function createMemoryStorage(): DocumentStorage & {
  readonly files: Map<string, Uint8Array<ArrayBuffer>>;
} {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  return {
    files,
    write: async (key, bytes) => {
      checkKey(key);
      files.set(key, new Uint8Array(bytes));
    },
    read: async (key) => {
      checkKey(key);
      return files.get(key);
    },
    remove: async (key) => {
      checkKey(key);
      files.delete(key);
    },
  };
}
