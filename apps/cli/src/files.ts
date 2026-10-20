import type { Stats } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { CliError } from "./errors.js";
import { visible } from "./text.js";

export interface OutputTarget {
  /** What the file is, as a phrase for messages: "redlined contract". */
  label: string;
  path: string;
}

const REASONS = new Map([
  ["ENOENT", "no such file or directory"],
  ["ENOTDIR", "a folder in the path is a file"],
  ["ELOOP", "too many levels of symbolic links"],
  ["EACCES", "permission denied"],
  ["EPERM", "operation not permitted"],
  ["EISDIR", "it is a directory"],
  ["ENOSPC", "no space left on the device"],
  ["EROFS", "the file system is read-only"],
  ["EMFILE", "too many open files"],
]);

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** Why a file operation failed, in words. Never the error's own message. */
export function fsReason(error: unknown): string {
  const code = errorCode(error);
  if (code === undefined) return "unknown error";
  return REASONS.get(code) ?? `error ${code}`;
}

async function statOrAbsent(
  look: (path: string) => Promise<Stats>,
  path: string,
): Promise<Stats | undefined> {
  try {
    return await look(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new CliError(`Cannot access ${visible(path)}: ${fsReason(error)}.`);
  }
}

/** The file's stats, following a symbolic link, or undefined when nothing is there. */
export const statIfPresent = (path: string): Promise<Stats | undefined> => statOrAbsent(stat, path);

/** The stats of the path itself, so a symbolic link is seen as a link. A dangling one is present. */
export const lstatIfPresent = (path: string): Promise<Stats | undefined> =>
  statOrAbsent(lstat, path);

/** `contracts/nda.docx` gives `contracts/nda.redlined.docx` and its two siblings. */
export function defaultOutputPaths(input: string): {
  redlined: string;
  report: string;
  summary: string;
} {
  const { dir, name } = parse(input);
  const base = join(dir, name);
  return {
    redlined: `${base}.redlined.docx`,
    report: `${base}.report.json`,
    summary: `${base}.summary.md`,
  };
}

function refuseInput(target: OutputTarget): CliError {
  return new CliError(
    `Refusing to overwrite the input file: ${visible(target.path)} would be written as the ` +
      `${target.label}. Choose another path.`,
  );
}

/**
 * A link at an output path is never written through, with or without --force: its target can be
 * anywhere, and a folder unpacked from someone else's archive can hold links that were put there
 * for exactly this.
 */
export function refuseLink(target: OutputTarget): CliError {
  return new CliError(
    `Refusing to write the ${target.label} to ${visible(target.path)}: it is a symbolic link. ` +
      "Remove the link, or choose another path with --out, --report and --summary.",
  );
}

/**
 * Settles, before any money is spent and again before anything is written, whether the output
 * paths can be used: that none is the input, two of them, a link or a folder, that the folders
 * exist, and that nothing is replaced without --force. Whether a folder accepts a new file is
 * probed separately. Returns the paths that already hold a file, so a failed write can tell what
 * it created from what it replaced.
 */
export async function checkOutputs(
  input: { path: string; stats: Stats },
  targets: readonly OutputTarget[],
  force: boolean,
): Promise<Set<string>> {
  const inputPath = resolve(input.path);
  const claimed = new Map<string, OutputTarget>();
  const present = new Set<string>();
  const blocked: string[] = [];

  for (const target of targets) {
    const path = resolve(target.path);
    // The input is refused even with --force, whether it is named directly or through a link.
    if (path === inputPath) throw refuseInput(target);
    const twin = claimed.get(path);
    if (twin !== undefined) {
      throw new CliError(
        `The ${twin.label} and the ${target.label} would both be written to ` +
          `${visible(target.path)}. Choose different paths.`,
      );
    }
    claimed.set(path, target);

    const folder = await statIfPresent(dirname(path));
    if (folder === undefined || !folder.isDirectory()) {
      throw new CliError(
        `The folder for the ${target.label} does not exist: ${visible(dirname(target.path))}`,
      );
    }
    // The link itself is looked at first: a dangling link is nothing to stat but is not free.
    const here = await lstatIfPresent(path);
    if (here === undefined) continue;
    const current = here.isSymbolicLink() ? await statIfPresent(path) : here;
    // Some file systems report 0 for every inode, which would make every file look like the input.
    const sameFile =
      current !== undefined &&
      input.stats.ino !== 0 &&
      current.dev === input.stats.dev &&
      current.ino === input.stats.ino;
    if (sameFile) throw refuseInput(target);
    if (here.isSymbolicLink()) throw refuseLink(target);
    if (!here.isFile()) {
      throw new CliError(
        `Cannot write the ${target.label}: ${visible(target.path)} is not a regular file.`,
      );
    }
    present.add(path);
    if (!force) blocked.push(target.path);
  }

  if (blocked.length > 0) {
    const many = blocked.length > 1;
    throw new CliError(
      `Refusing to overwrite ${many ? "existing files" : "an existing file"}:\n` +
        `${blocked.map((path) => `  ${visible(path)}`).join("\n")}\n` +
        `Use --force to replace ${many ? "them" : "it"}, or choose other paths with ` +
        "--out, --report and --summary.",
    );
  }
  return present;
}
