import {
  LineCounter,
  Lexer,
  Parser,
  isAlias,
  isMap,
  isNode,
  isScalar,
  parseDocument,
  visit,
  type Document,
  type YAMLMap,
} from "yaml";
import { PlaybookSchema, type Playbook } from "./schema.js";

export { PlaybookSchema, RuleSchema, SEVERITIES, hasVisibleText } from "./schema.js";
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

// ---------------------------------------------------------------------------------------------
// Reading the YAML
// ---------------------------------------------------------------------------------------------

// A playbook is plain data that a person types into a file or a browser, and the server parses
// text from anyone who can reach it. YAML can say more than data, so every feature a playbook does
// not need is switched off here, one way or another:
//
//  - Aliases (`*name`) are refused outright. A small alias limit would still let a short document
//    expand into megabytes ("billion laughs": each level lists the one before it many times), or
//    into a chain deep enough to overflow the stack. A playbook can write a sentence twice.
//  - Merge keys (`<<`) are not read as merges, which are aliases by another name. A `%YAML 1.1`
//    line at the top of a document turns merge keys on unless the option below says otherwise.
//  - Tags (`!!binary`, `!!js/function`, `!custom`) are refused. The core schema would keep most
//    of them as text, with a warning nobody reads, and would turn others into a Buffer, a Set or
//    a Date, which are not text where text is needed.
//  - The schema is the YAML 1.2 core one, whatever version a directive asks for, so `yes` and `on`
//    stay text and `required: yes` is reported rather than read as true.
//  - A key that appears twice in one mapping is an error, not a silent last-one-wins. The library
//    can check this itself (`uniqueKeys: true`), but it compares each key with every key before it,
//    so a mapping of 30,000 keys, which fits in 300 KB, takes about fifteen seconds to read, with
//    the server unable to answer anything else meanwhile. `refuseUnsafeNodes` makes the same
//    check in one pass.
//  - Nesting is limited, see MAX_DEPTH.
const PARSE_OPTIONS = {
  version: "1.2",
  schema: "core",
  merge: false,
  uniqueKeys: false,
  strict: true,
} as const;

// Read as `maxAliasCount`: 0 refuses every alias, here as a second line of defence behind the
// check in `refuseUnsafeNodes`, which gives the better message.
const MAX_ALIAS_COUNT = 0;

// The deepest nesting accepted. A playbook is a mapping that holds a list of mappings, so about
// six levels; this allows far more than any person would write. It is not only for tidiness. The
// YAML library reads nested collections by recursion, and a document nested a thousand levels
// deep (about two kilobytes of brackets) overflows the stack. The library reports that as a
// parse error, but the overflow can leave the JavaScript engine unable to compile a regular
// expression afterwards, and the whole process then dies with an out of memory error the next
// time the library is used. So the depth is measured first, with the library's own
// tokenizer, which keeps the open collections on a list instead of on the stack.
const MAX_DEPTH = 64;

function nestedTooDeeply(yamlText: string): boolean {
  const lexer = new Lexer();
  const parser = new Parser();
  for (const lexeme of lexer.lex(yamlText)) {
    for (const _token of parser.next(lexeme)) {
      // The finished tokens are not needed, only the list of collections still open.
    }
    if (parser.stack.length > MAX_DEPTH) return true;
  }
  return false;
}

const TAG_PREFIX = "tag:yaml.org,2002:";
const MAX_SHOWN = 40;

const shortened = (text: string): string =>
  text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}...` : text;

/** How the tag was most likely written: `!!binary` for the standard ones, else as it is. */
const tagShown = (tag: string): string =>
  shortened(tag.startsWith(TAG_PREFIX) ? `!!${tag.slice(TAG_PREFIX.length)}` : tag);

/**
 * Refuses an alias, a tag or a repeated key anywhere in the document. Nodes are walked without
 * following aliases, and the depth is already limited, so this is linear and cannot overflow the
 * stack. It runs before anything is expanded.
 */
function refuseUnsafeNodes(doc: Document, lines: LineCounter, source: string): void {
  const refuse = (offset: number | undefined, what: string): never => {
    const place = offset === undefined ? "" : `line ${lines.linePos(offset).line}: `;
    const detail = `${place}${what}`;
    throw new PlaybookError(`${source} is not valid YAML: ${detail}`, [detail]);
  };

  // A key is compared as the text it becomes when the mapping is read, so 1 and "1" are one key.
  // A key that is not a single value cannot be compared this way, and no playbook has one.
  const refuseRepeatedKeys = (map: YAMLMap): void => {
    const seen = new Set<string>();
    for (const pair of map.items) {
      const { key } = pair;
      if (!isScalar(key)) continue;
      const name = String(key.value);
      if (seen.has(name)) {
        refuse(
          key.range?.[0],
          `the key "${shortened(name)}" is written twice in one mapping, and only one of them would be used. Remove one.`,
        );
      }
      seen.add(name);
    }
  };

  visit(doc, (_key, node) => {
    if (!isNode(node)) return;
    const at = node.range?.[0];
    if (isAlias(node)) {
      refuse(
        at,
        "an alias (*name) is not allowed in a playbook. Write the text out in full where it is needed.",
      );
    }
    if (node.tag !== undefined) {
      refuse(
        at,
        `the tag ${tagShown(node.tag)} is not allowed in a playbook, which holds only text, numbers, true or false, lists and mappings. Remove the tag, and put a value in quotation marks to keep it as text.`,
      );
    }
    if (isMap(node)) refuseRepeatedKeys(node);
  });
}

function readYaml(yamlText: string, source: string): unknown {
  const notValid = (detail: string): PlaybookError =>
    new PlaybookError(`${source} is not valid YAML: ${detail}`, [detail]);
  try {
    if (nestedTooDeeply(yamlText)) {
      throw notValid(
        `the document is nested more than ${MAX_DEPTH} levels deep, which no playbook needs. Check for a bracket or a dash that repeats.`,
      );
    }
    const lines = new LineCounter();
    const doc = parseDocument(yamlText, { ...PARSE_OPTIONS, lineCounter: lines });
    const [first] = doc.errors;
    if (first !== undefined) throw notValid(first.message);
    refuseUnsafeNodes(doc, lines, source);
    return doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (err) {
    if (err instanceof PlaybookError) throw err;
    throw notValid(err instanceof Error ? err.message : String(err));
  }
}

/** Parses and validates a playbook from YAML text. Throws PlaybookError listing every problem. */
export function parsePlaybook(yamlText: string, source = "playbook"): Playbook {
  const raw = readYaml(yamlText, source);
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
