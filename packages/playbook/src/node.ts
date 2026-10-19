import { readFile } from "node:fs/promises";
import { parsePlaybook, type Playbook } from "./index.js";

export async function loadPlaybookFile(path: string): Promise<Playbook> {
  return parsePlaybook(await readFile(path, "utf8"), path);
}
