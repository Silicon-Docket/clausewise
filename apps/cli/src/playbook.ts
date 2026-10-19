import { PlaybookError, type Playbook } from "@clausewise/playbook";
import { loadPlaybookFile } from "@clausewise/playbook/node";
import { parseCommandArgs } from "./args.js";
import { CliError, UsageError } from "./errors.js";
import { fsReason } from "./files.js";
import type { CliIo } from "./io.js";
import { aligned, plain } from "./text.js";
import { USAGE } from "./usage.js";

/** A PlaybookError already lists every problem, so it is passed on as it is. */
export async function loadPlaybook(path: string): Promise<Playbook> {
  try {
    return await loadPlaybookFile(path);
  } catch (error) {
    if (error instanceof PlaybookError) throw error;
    throw new CliError(`Cannot read the playbook ${path}: ${fsReason(error)}.`);
  }
}

export async function playbookCheck(args: string[], io: CliIo): Promise<number> {
  const parsed = parseCommandArgs(args, {});
  if (parsed.help) {
    io.stdout(USAGE);
    return 0;
  }
  const [path, ...extra] = parsed.positionals;
  if (path === undefined) throw new UsageError("playbook check needs a playbook file.");
  if (extra.length > 0) {
    throw new UsageError(
      `playbook check takes one file, but ${parsed.positionals.length} were given.`,
    );
  }

  const playbook = await loadPlaybook(path);
  io.stdout(
    [
      `${path} is a valid playbook.`,
      "",
      `Name: ${plain(playbook.name)}`,
      `Contract types: ${playbook.contractTypes.map(plain).join(", ")}`,
      `Rules (${playbook.rules.length}):`,
      ...aligned(
        playbook.rules.map((rule) => [
          rule.id,
          `${rule.severity}${rule.required ? ", required" : ""}`,
        ]),
      ),
      "",
    ].join("\n"),
  );
  return 0;
}
