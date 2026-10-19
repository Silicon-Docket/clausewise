import { parse as parseYaml } from "yaml";
import { PlaybookSchema, type Playbook } from "./schema.js";

export { PlaybookSchema, RuleSchema, SEVERITIES } from "./schema.js";
export type { Playbook, Rule, Severity } from "./schema.js";

export class PlaybookError extends Error {
  override name = "PlaybookError";
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
  }
}

/** Parses and validates a playbook from YAML text. Throws PlaybookError listing every problem. */
export function parsePlaybook(yamlText: string, source = "playbook"): Playbook {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PlaybookError(`${source} is not valid YAML: ${detail}`, [detail]);
  }
  const result = PlaybookSchema.safeParse(raw);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    const path = issue.path
      .map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`))
      .join("");
    return `${path.replace(/^\./, "") || "(root)"}: ${issue.message}`;
  });
  throw new PlaybookError(`${source} is invalid:\n  ${problems.join("\n  ")}`, problems);
}
