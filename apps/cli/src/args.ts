import { parseArgs } from "node:util";
import { UsageError } from "./errors.js";

export type OptionKind = "string" | "boolean";

export interface ParsedArgs {
  positionals: string[];
  strings: ReadonlyMap<string, string>;
  flags: ReadonlySet<string>;
  /** True when -h or --help was given anywhere. Nothing else is checked then. */
  help: boolean;
}

/**
 * Splits the arguments of one command. The parser runs in its lenient mode and the tokens are
 * checked here, because its own errors say less than a person needs: they do not tell a missing
 * value from a value that is the next option, and they cannot name the option in plain words.
 */
export function parseCommandArgs(
  args: readonly string[],
  spec: Readonly<Record<string, OptionKind>>,
): ParsedArgs {
  const options: Record<string, { type: OptionKind; short?: string }> = {
    help: { type: "boolean", short: "h" },
  };
  for (const [name, type] of Object.entries(spec)) options[name] = { type };

  const { tokens = [] } = parseArgs({
    args: [...args],
    options,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  const positionals: string[] = [];
  const strings = new Map<string, string>();
  const flags = new Set<string>();

  if (tokens.some((token) => token.kind === "option" && token.name === "help")) {
    return { positionals, strings, flags, help: true };
  }

  for (const token of tokens) {
    if (token.kind === "positional") {
      positionals.push(token.value);
      continue;
    }
    if (token.kind !== "option") continue;

    const kind = Object.hasOwn(spec, token.name) ? spec[token.name] : undefined;
    if (kind === undefined) throw new UsageError(`Unknown option: ${token.rawName}`);
    const flag = `--${token.name}`;

    if (kind === "boolean") {
      if (token.value !== undefined) throw new UsageError(`Option ${flag} does not take a value.`);
      flags.add(token.name);
      continue;
    }

    const { value } = token;
    // The parser takes the next argument as the value even when it is another option, which
    // would swallow that option without a word. A value that starts with a dash has to be written
    // as --name=value.
    const swallowed = token.inlineValue !== true && value?.startsWith("-") === true;
    if (value === undefined || value === "" || swallowed) {
      throw new UsageError(`Option ${flag} needs a value.`);
    }
    if (strings.has(token.name)) throw new UsageError(`Option ${flag} was given more than once.`);
    strings.set(token.name, value);
  }
  return { positionals, strings, flags, help: false };
}
