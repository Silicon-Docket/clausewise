import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { FileStoreError } from "./errors.js";

/** `mat_` and 16 lower-case hex digits: what `newId("mat")` produces and nothing else. */
export const MATTER_ID_PATTERN = /^mat_[0-9a-f]{16}$/;
const FILE_NAME_PATTERN = /^f_[0-9a-f]{32}$/;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Stores uploaded files and memos under one root, one folder per matter, so deleting a matter is
 * deleting a folder.
 *
 * Names are generated, never taken from the upload: a file name is untrusted text, and a path built
 * from it is how traversal happens. The store accepts only a path that it could have generated,
 * and on top of that checks the real path on disk, so a symbolic link planted inside the root
 * cannot make a read or a delete leave it.
 *
 * Methods are synchronous. Files are small (the upload limit is a few megabytes), a transaction
 * cannot span an await, and a caller can then write the file and insert its row in order.
 */
export class FileStore {
  readonly root: string;

  constructor(root: string) {
    if (typeof root !== "string" || root.length === 0 || root.includes("\0"))
      throw new FileStoreError("bad_root", "file store root is not a path");
    mkdirSync(root, { recursive: true, mode: DIR_MODE });
    // Resolved once, through links, so every later comparison is against the real location.
    this.root = realpathSync(root);
  }

  /**
   * Writes `bytes` to a new file in the matter's folder and returns its storage path, relative to
   * the root (`mat_.../f_...`). The bytes go to a temporary file in the same folder and are renamed
   * into place, so a crash leaves either the whole file or no file, never half of one.
   */
  save(matterId: string, bytes: Uint8Array): string {
    const dir = this.matterDir(matterId, { create: true });
    const name = `f_${randomBytes(16).toString("hex")}`;
    const finalPath = join(dir, name);
    const tempPath = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);

    // `wx` fails if the name exists, and `O_NOFOLLOW` refuses a planted link at that name.
    const fd = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      FILE_MODE,
    );
    try {
      // The mode argument is masked by the umask, which can only remove bits; this sets it exactly.
      fchmodSync(fd, FILE_MODE);
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(fd, bytes, written, bytes.length - written);
      }
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      safeUnlink(tempPath);
      throw error;
    }
    closeSync(fd);
    try {
      renameSync(tempPath, finalPath);
    } catch (error) {
      safeUnlink(tempPath);
      throw error;
    }
    return `${matterId}/${name}`;
  }

  read(storagePath: string): Buffer {
    const path = this.resolveFile(storagePath);
    // Open without following a link, then read through the descriptor: there is no gap between the
    // check and the use for a link to be swapped into.
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  exists(storagePath: string): boolean {
    try {
      const path = this.resolveFile(storagePath);
      return lstatSync(path).isFile();
    } catch {
      return false;
    }
  }

  /** Removes one file, for a caller whose database insert failed after the file was saved. */
  remove(storagePath: string): void {
    const path = this.resolveFile(storagePath);
    unlinkSync(path);
  }

  /**
   * Removes the matter's folder and everything in it. If the folder is itself a link it removes the
   * link and leaves the target alone. Returns the number of files that were there.
   */
  deleteMatter(matterId: string): number {
    if (typeof matterId !== "string" || !MATTER_ID_PATTERN.test(matterId))
      throw new FileStoreError("bad_matter_id", "matter id is not in the form mat_ and 16 hex digits");
    const dir = join(this.root, matterId);
    this.assertInsideRoot(dir);
    let stat;
    try {
      stat = lstatSync(dir);
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      // Whatever sits at the matter's name is removed as itself; a link is never followed.
      unlinkSync(dir);
      return 0;
    }
    const count = readdirSync(dir).length;
    // `rm` never follows links inside the folder; it removes the link itself.
    rmSync(dir, { recursive: true, force: true });
    return count;
  }

  // -------------------------------------------------------------------------------------------

  private matterDir(matterId: string, opts: { create: true }): string;
  private matterDir(matterId: string, opts: { create: false }): string | null;
  private matterDir(matterId: string, opts: { create: boolean }): string | null {
    if (typeof matterId !== "string" || !MATTER_ID_PATTERN.test(matterId))
      throw new FileStoreError("bad_matter_id", "matter id is not in the form mat_ and 16 hex digits");
    const dir = join(this.root, matterId);
    this.assertInsideRoot(dir);

    let stat;
    try {
      stat = lstatSync(dir);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!opts.create) return null;
      mkdirSync(dir, { mode: DIR_MODE });
      return dir;
    }
    // A link (or anything that is not a folder) at the matter's name is never followed.
    if (!stat.isDirectory())
      throw new FileStoreError("not_a_folder", `the matter folder ${matterId} is not a plain folder`);
    return dir;
  }

  private resolveFile(storagePath: string): string {
    if (typeof storagePath !== "string" || storagePath.includes("\0"))
      throw new FileStoreError("bad_path", "storage path is not a path");
    const parts = storagePath.split("/");
    const [matterId, name] = parts;
    if (
      parts.length !== 2 ||
      matterId === undefined ||
      name === undefined ||
      !MATTER_ID_PATTERN.test(matterId) ||
      !FILE_NAME_PATTERN.test(name)
    )
      throw new FileStoreError("bad_path", "storage path is not one this store generated");
    const dir = this.matterDir(matterId, { create: false });
    if (dir === null) throw new FileStoreError("missing", "file not found");
    const path = join(dir, name);
    this.assertInsideRoot(path);
    // The file itself must not be a link either: lstat does not follow it.
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (isMissing(error)) throw new FileStoreError("missing", "file not found");
      throw error;
    }
    if (!stat.isFile()) throw new FileStoreError("not_a_file", "storage path is not a plain file");
    return path;
  }

  // Belt and braces after the pattern checks: the lexical path stays under the root, and the real
  // path of its folder does too, so a link in the middle cannot lead out.
  private assertInsideRoot(path: string): void {
    const resolved = resolve(path);
    if (resolved !== this.root && !resolved.startsWith(this.root + sep))
      throw new FileStoreError("outside_root", "path resolves outside the file store");
    let real: string;
    try {
      real = realpathSync(resolve(resolved, ".."));
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (real !== this.root && !real.startsWith(this.root + sep))
      throw new FileStoreError("outside_root", "path resolves outside the file store");
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Nothing to clean up, or nothing we can do about it; the original error matters more.
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}
