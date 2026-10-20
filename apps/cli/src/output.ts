import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { link, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CliError } from "./errors.js";
import { errorCode, fsReason, lstatIfPresent, refuseLink, type OutputTarget } from "./files.js";
import type { CliIo } from "./io.js";
import { visible } from "./text.js";

export interface OutputFile {
  target: OutputTarget;
  data: Uint8Array | string;
}

/**
 * The permission bits for the outputs: the input's, without write for group and other, so a
 * contract that only its owner can read gives outputs that only its owner can read. The process
 * umask can still take bits away, never add them.
 */
export const outputMode = (input: Stats): number => input.mode & 0o755;

/** Creates a file that must not exist yet, so a name that is already taken is never written into. */
export async function createFile(
  path: string,
  data: Uint8Array | string,
  mode = 0o600,
): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(data);
    // Without this a crash right after the rename can leave a renamed file with no content.
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const suffix = (): string => randomBytes(6).toString("hex");

/** A hidden name in the target's own folder, so the rename that follows never crosses a device. */
const tempPathFor = (target: OutputTarget): string =>
  join(dirname(target.path), `.${basename(target.path).slice(0, 100)}.${suffix()}.tmp`);

/**
 * Settles, before the first model call, that every output folder accepts a new file, by creating
 * one and removing it again. Looking at the folder's permissions would miss a read-only mount or
 * a locked folder, and learning that after the whole review was paid for loses the result.
 */
export async function probeFolders(
  io: Pick<CliIo, "writeFile">,
  targets: readonly OutputTarget[],
  mode: number,
): Promise<void> {
  const create = io.writeFile ?? createFile;
  const probed = new Set<string>();
  for (const target of targets) {
    const folder = dirname(resolve(target.path));
    if (probed.has(folder)) continue;
    probed.add(folder);
    const probe = join(folder, `.clausewise-probe-${suffix()}.tmp`);
    try {
      await create(probe, "", mode);
    } catch (error) {
      throw new CliError(
        `Cannot write to the folder for the ${target.label}: ${visible(dirname(target.path))} ` +
          `(${fsReason(error)}). Nothing was sent to the model.`,
      );
    } finally {
      await rm(probe, { force: true }).catch(() => undefined);
    }
  }
}

const saved = (target: OutputTarget, problem: string): CliError =>
  new CliError(
    `Could not write the ${target.label} to ${visible(target.path)}: ${problem} ` +
      "The review finished, but its results were not saved.",
  );

// Filesystems without hard links answer with one of these, and then the rename has to do.
const NO_HARD_LINKS = new Set(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EMLINK"]);

/**
 * Gives the file that is about to be replaced a second name, so that it can be put back if a later
 * move fails: the rename that replaces the first name leaves the file itself alone. A file system
 * without hard links goes without, and then the replaced file cannot be put back.
 */
async function keepOld(target: OutputTarget, keep: (backup: string) => void): Promise<void> {
  const backup = join(
    dirname(target.path),
    `.${basename(target.path).slice(0, 100)}.${suffix()}.bak`,
  );
  try {
    await link(target.path, backup);
    keep(backup);
  } catch {
    // Best effort, as said above.
  }
}

/**
 * Puts a finished temporary file at its final name. A name that is taken is never replaced without
 * --force, and a link is never followed: linking fails when the name exists in any form, a
 * dangling symbolic link included, and a rename replaces what is at the name instead of writing
 * through it.
 */
async function publish(
  temp: string,
  target: OutputTarget,
  force: boolean,
  keep: (backup: string) => void,
): Promise<void> {
  const taken = (): CliError =>
    saved(
      target,
      "a file appeared there while the review was running. Use --force to replace it, or " +
        "choose another path.",
    );
  const existing = await lstatIfPresent(target.path);
  if (existing?.isSymbolicLink() === true) {
    throw new CliError(
      `${refuseLink(target).message} The review finished, but its results were not saved.`,
    );
  }
  if (existing !== undefined && !existing.isFile()) {
    throw saved(target, "it is not a regular file.");
  }
  if (force) {
    if (existing !== undefined) await keepOld(target, keep);
    await rename(temp, target.path);
    return;
  }
  if (existing !== undefined) throw taken();
  try {
    await link(temp, target.path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") throw taken();
    if (code === undefined || !NO_HARD_LINKS.has(code)) throw error;
    if ((await lstatIfPresent(target.path)) !== undefined) throw taken();
    await rename(temp, target.path);
    return;
  }
  // The file is in place under its final name, so a temporary name that cannot be removed is a
  // leftover and no reason to take the result back.
  await rm(temp, { force: true }).catch(() => undefined);
}

const discard = (paths: readonly string[]): Promise<unknown> =>
  Promise.all(paths.map((path) => rm(path, { force: true }).catch(() => undefined)));

/**
 * Writes every output so that the folder holds either all of them or none of what this run made.
 * Each file is first written whole under a temporary name next to its final one, and only when
 * all of them are written are they moved into place, so a full disk or a crash never leaves half
 * a file or a new report beside an old redline. If a move fails after others went through, the
 * files this run created are removed again and the ones it replaced under --force are put back.
 */
export async function writeOutputs(
  io: Pick<CliIo, "writeFile">,
  files: readonly OutputFile[],
  options: { mode: number; force: boolean; present: ReadonlySet<string> },
): Promise<void> {
  const create = io.writeFile ?? createFile;
  const staged: { file: OutputFile; temp: string }[] = [];
  const created: string[] = [];
  const replaced: { path: string; backup: string }[] = [];
  try {
    for (const file of files) {
      const temp = tempPathFor(file.target);
      // Noted first, so a file that was only half written is removed too.
      staged.push({ file, temp });
      try {
        await create(temp, file.data, options.mode);
      } catch (error) {
        throw saved(file.target, `${fsReason(error)}.`);
      }
    }
    for (const { file, temp } of staged) {
      try {
        await publish(temp, file.target, options.force, (backup) =>
          replaced.push({ path: file.target.path, backup }),
        );
      } catch (error) {
        throw error instanceof CliError ? error : saved(file.target, `${fsReason(error)}.`);
      }
      if (!options.present.has(resolve(file.target.path))) created.push(file.target.path);
    }
  } catch (error) {
    await Promise.all(
      replaced.map(({ path, backup }) => rename(backup, path).catch(() => undefined)),
    );
    await discard([
      ...staged.map(({ temp }) => temp),
      ...created,
      ...replaced.map((r) => r.backup),
    ]);
    throw error;
  }
  await discard(replaced.map(({ backup }) => backup));
}
