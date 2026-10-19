import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { CliError } from "./errors.js";

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

/** The file's stats, or undefined when nothing is there. */
export async function statIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new CliError(`Cannot access ${path}: ${fsReason(error)}.`);
  }
}

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
    `Refusing to overwrite the input file: ${target.path} would be written as the ${target.label}. ` +
      "Choose another path.",
  );
}

/**
 * Settles, before any money is spent and again before anything is written, whether the outputs
 * can be written. Returns the paths that already hold a file, so a failed write can tell what it
 * created from what it replaced.
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
        `The ${twin.label} and the ${target.label} would both be written to ${target.path}. ` +
          "Choose different paths.",
      );
    }
    claimed.set(path, target);

    const folder = await statIfPresent(dirname(path));
    if (folder === undefined || !folder.isDirectory()) {
      throw new CliError(
        `The folder for the ${target.label} does not exist: ${dirname(target.path)}`,
      );
    }
    const current = await statIfPresent(path);
    if (current === undefined) continue;
    // Some file systems report 0 for every inode, which would make every file look like the input.
    const sameFile =
      input.stats.ino !== 0 && current.dev === input.stats.dev && current.ino === input.stats.ino;
    if (sameFile) throw refuseInput(target);
    if (!current.isFile()) {
      throw new CliError(`Cannot write the ${target.label}: ${target.path} is not a regular file.`);
    }
    present.add(path);
    if (!force) blocked.push(target.path);
  }

  if (blocked.length > 0) {
    const many = blocked.length > 1;
    throw new CliError(
      `Refusing to overwrite ${many ? "existing files" : "an existing file"}:\n` +
        `${blocked.map((path) => `  ${path}`).join("\n")}\n` +
        `Use --force to replace ${many ? "them" : "it"}, or choose other paths with ` +
        "--out, --report and --summary.",
    );
  }
  return present;
}
