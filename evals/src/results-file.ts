import { access, constants, link, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EvalError } from "./errors.js";

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? "an error";

/**
 * Fails before any model is called when the results could not be written afterwards, because a
 * run that has been paid for and cannot be saved is the worst way to find out. Nothing is created:
 * the nearest directory that exists must be one a file can be added to.
 */
export async function assertWritable(path: string): Promise<void> {
  let dir = dirname(path);
  for (;;) {
    try {
      if (!(await stat(dir)).isDirectory()) {
        throw new EvalError(
          `${dir} is not a directory, so results cannot be written to ${path}. Choose another file with --out.`,
        );
      }
      await access(dir, constants.W_OK);
      return;
    } catch (error) {
      if (error instanceof EvalError) throw error;
      const parent = dirname(dir);
      if (codeOf(error) === "ENOENT" && parent !== dir) {
        dir = parent;
        continue;
      }
      throw new EvalError(
        `Results cannot be written to ${path} (${codeOf(error)}). Choose another file with --out.`,
      );
    }
  }
}

/**
 * Writes the file whole or not at all: the text goes to a temporary file next to it, which is then
 * linked into place. A link fails when the file already exists, so a file that appeared during
 * the run is never replaced, and a run cut off in the middle of the write leaves no half file that
 * would later be refused as existing or fail to parse. `replace` renames over the target instead,
 * for the checkpoint, which is meant to be overwritten.
 */
export async function writeFileAtomically(
  path: string,
  text: string,
  options: { replace: boolean },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, text, { flag: "wx" });
  try {
    if (options.replace) {
      await rename(temp, path);
      return;
    }
    try {
      await link(temp, path);
    } catch (error) {
      if (codeOf(error) === "EEXIST") throw error;
      // A filesystem without hard links. The file is checked once more before it is moved.
      const exists = await stat(path).then(
        () => true,
        () => false,
      );
      if (exists) throw error;
      await rename(temp, path);
    }
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
