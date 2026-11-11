import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConflictError } from "../store/errors.js";
import { T01 } from "./t01.js";

/** `apps/parol/training`, found from this file so it works from `src` and from tests alike. */
export const DEFAULT_TRAINING_DIR = fileURLToPath(new URL("../../training/", import.meta.url));

/**
 * The bytes of one of T01's committed files. The name must be one of the documents of `T01`: it
 * comes from there and never from a request, and a name that is not one of them is refused before
 * any path is made. A file that is missing is a conflict with a fixed message that names no path.
 */
export function readTrainingFile(name: string, dir: string = DEFAULT_TRAINING_DIR): Uint8Array {
  if (!T01.documents.some((document) => document.fileName === name))
    throw new TypeError("a training file is one of the documents of the training matter");
  try {
    return readFileSync(join(dir, name));
  } catch {
    throw new ConflictError(
      "training_files_missing",
      "the documents of the training matter are missing from this installation",
    );
  }
}
