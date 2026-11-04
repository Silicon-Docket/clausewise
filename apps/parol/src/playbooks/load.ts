import { PlaybookError, parsePlaybook, type Playbook } from "@clausewise/playbook";
import { sha256Hex } from "../canonical.js";
import { CATEGORY_IDS, type CategoryId, type PlaybookRuleRecord } from "../contracts.js";
import { HINT_TOPICS } from "../ingest/signals.js";
import type { LoadPlaybook, LoadedPlaybook } from "../module-contracts.js";

const CATEGORY_SET: ReadonlySet<string> = new Set(CATEGORY_IDS);
const isCategory = (value: string): value is CategoryId => CATEGORY_SET.has(value);

// A category value that is not on the list is echoed so the author can see the typo. The base
// schema already limits it to lowercase letters, digits and hyphens, and the cut keeps a very
// long value from filling the message.
const shown = (value: string): string => (value.length > 40 ? `${value.slice(0, 40)}...` : value);

// The limits of `importPlaybookDraft` in the store (repo-playbooks.ts: the YAML length, the version
// pattern; schemas.ts: the rule key pattern). A playbook over one of them would load and then be
// refused at import, so the loader refuses it first. store-import.test.ts imports a playbook at
// each limit and one step past it, so a change in the store that is not made here fails a test.
const MAX_YAML_LENGTH = 1_000_000;
const MAX_VERSION_LENGTH = 32;
const MAX_RULE_ID_LENGTH = 64;

const YAML_POSITION = /at line (\d+), column (\d+)/;

const parolError = (label: string, problems: string[]): PlaybookError =>
  new PlaybookError(
    `${label} is not a valid Parol playbook:\n  ${problems.join("\n  ")}`,
    problems,
  );

// What may be repeated of the file's own text in an error: a short run of letters, digits and the
// few marks an identifier has. A key or an id that is anything else (a line of a contract saved as
// .yaml, say) is left out, because the path of the problem already says where it is.
const PLAIN_KEY = '"[A-Za-z0-9][A-Za-z0-9_.-]{0,39}"';
const PLAIN_ID = '"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}"';
const UNKNOWN_KEYS_SAFE = new RegExp(`^Unrecognized keys?: ${PLAIN_KEY}(, ${PLAIN_KEY})*$`);
const DUPLICATE_RULE_SAFE = new RegExp(`^duplicate rule id ${PLAIN_ID}$`);
const DUPLICATE_ESCALATION_SAFE = new RegExp(
  `^duplicate escalateWhen id ${PLAIN_ID} in rule ${PLAIN_ID}$`,
);
const ABSENCE_TAIL =
  " is an absence rule, which passes when the clause is not there, so it cannot be required";
const ABSENCE_SAFE = new RegExp(`^rule ${PLAIN_ID}${ABSENCE_TAIL}$`);

/**
 * Takes the text of the file out of a problem the base format reports. Most base problems name a
 * field path and a fixed reason. Four put a name from the file in the message: an unrecognised
 * key (zod prints it), and the duplicate rule id, duplicate escalation id and required absence
 * rule problems (the format prints the id, and it prints it even when the id failed its own
 * pattern and so can be any text). Each is rewritten on its prefix, which comes before any text
 * of the file, and a name is kept only when it is a short plain word.
 */
function scrubProblem(problem: string): string {
  const at = problem.indexOf(": ");
  if (at < 0) return problem;
  const path = problem.slice(0, at);
  const message = problem.slice(at + 2);
  const hidden = (text: string): string => `${path}: ${text}`;
  if (message.startsWith("Unrecognized keys: ")) {
    return UNKNOWN_KEYS_SAFE.test(message)
      ? problem
      : hidden("Unrecognized keys, names not shown because they are not all short plain words");
  }
  if (message.startsWith("Unrecognized key: ")) {
    return UNKNOWN_KEYS_SAFE.test(message)
      ? problem
      : hidden("Unrecognized key, name not shown because it is not a short plain word");
  }
  if (message.startsWith("duplicate rule id ")) {
    return DUPLICATE_RULE_SAFE.test(message) ? problem : hidden("duplicate rule id (id not shown)");
  }
  if (message.startsWith("duplicate escalateWhen id ")) {
    return DUPLICATE_ESCALATION_SAFE.test(message)
      ? problem
      : hidden("duplicate escalateWhen id (ids not shown)");
  }
  if (message.startsWith('rule "') && message.endsWith(ABSENCE_TAIL)) {
    return ABSENCE_SAFE.test(message) ? problem : hidden(`rule (id not shown)${ABSENCE_TAIL}`);
  }
  return problem;
}

// The base parser stops at the first stage that fails, and the checks below need a playbook that
// parsed. The note tells the author that they have not run, so a clean-looking list is not read
// as a clean file.
const DEFERRED_NOTE =
  "The version, a category on every rule and the coverage of all seven categories are checked once these are fixed.";

/**
 * Parses with the base format and keeps the file's own text out of every error. The base parser's
 * message for a YAML syntax error carries a few lines of the source around the fault, and can name
 * a token such as an unresolved alias, so only the position is kept. The other base problems pass
 * through `scrubProblem`. A file uploaded by mistake (a contract saved as .yaml) would otherwise
 * put its own text into an error that is logged and returned. A misspelt key is still named,
 * because that is how an author spots a typo.
 */
function parseBase(yaml: string, label: string): Playbook {
  try {
    return parsePlaybook(yaml, label);
  } catch (err) {
    if (!(err instanceof PlaybookError)) throw err;
    if (err.message.startsWith(`${label} is not valid YAML`)) {
      const at = YAML_POSITION.exec(err.message);
      const where = at ? ` at line ${at[1]}, column ${at[2]}` : "";
      throw new PlaybookError(`${label} is not valid YAML${where}`, [
        `(root): not valid YAML${where}`,
      ]);
    }
    const problems = err.problems.map(scrubProblem);
    throw new PlaybookError(
      `${label} is invalid:\n  ${problems.join("\n  ")}\n  ${DEFERRED_NOTE}`,
      problems,
    );
  }
}

function toRecord(rule: Playbook["rules"][number], category: CategoryId): PlaybookRuleRecord {
  return {
    key: rule.id,
    category,
    title: rule.title,
    severity: rule.severity,
    // The base schema has already refused an absence rule that is required.
    required: rule.required,
    kind: rule.kind ?? "presence",
    standard: rule.standard,
    fallback: rule.fallback ?? null,
    unacceptable: rule.unacceptable ?? null,
    guidance: rule.guidance ?? null,
    fallbackLanguage: rule.fallbackLanguage ?? null,
    escalateWhen: (rule.escalateWhen ?? []).map(({ id, text }) => ({ id, text })),
    // An empty list means every topic of the category, so a rule without the field is unchanged.
    hintTopics: [...(rule.hintTopics ?? [])],
  };
}

/**
 * The topics of a category are fixed by the keyword lists in ingest, so a rule can only choose
 * among them. A topic nothing raises would never match a hint, and a rule that lists only such
 * topics would count no hint at all: the check that "missing" is not contradicted by a hint would
 * pass whatever the document says. The message names the position and the category, never the
 * topic the file wrote.
 */
function hintTopicProblems(
  rule: Playbook["rules"][number],
  category: CategoryId,
  i: number,
): string[] {
  const known = HINT_TOPICS[category];
  const listed = rule.hintTopics ?? [];
  if (listed.length === 0) return [];
  if (known.length === 0) {
    return [
      `rules[${i}].hintTopics: rule "${rule.id}" lists hint topics, and the category "${category}" has none`,
    ];
  }
  const problems: string[] = [];
  listed.forEach((topic, j) => {
    if (!known.includes(topic)) {
      problems.push(
        `rules[${i}].hintTopics[${j}]: rule "${rule.id}" lists a topic the category "${category}" does not have; use ${known.join(", ")}`,
      );
    }
  });
  return problems;
}

type ParolCheck =
  { ok: true; version: string; rules: PlaybookRuleRecord[] } | { ok: false; problems: string[] };

const hasLeadingZero = (version: string): boolean =>
  version.split(".").some((part) => part.length > 1 && part.startsWith("0"));

/**
 * Checks what Parol needs and the base playbook format leaves optional or open, collecting every
 * problem so that an author fixes a playbook in one pass. Messages carry rule ids, category ids and
 * counts only, never the text of a standard, so a playbook with a secret in a rule cannot leak it
 * through these checks (the base format's own messages are covered by `parseBase`).
 */
function checkParolFields(playbook: Playbook): ParolCheck {
  const problems: string[] = [];

  const { version } = playbook;
  if (version === undefined) {
    problems.push("version: required, such as 1.0.0, because a matter pins the exact version");
  } else {
    if (version.length > MAX_VERSION_LENGTH) {
      problems.push(`version: ${version.length} characters; the limit is ${MAX_VERSION_LENGTH}`);
    }
    // The base pattern allows 01.0.0 and 1.00.0, which would be three versions of one playbook in
    // the store and would defeat the rule that an approved version never changes.
    if (hasLeadingZero(version)) {
      problems.push(
        "version: write each number without a leading zero, such as 1.0.0 and not 01.0.0, so that one version has one spelling",
      );
    }
  }

  const rules: PlaybookRuleRecord[] = [];
  const covered = new Set<CategoryId>();
  playbook.rules.forEach((rule, i) => {
    if (rule.id.length > MAX_RULE_ID_LENGTH) {
      problems.push(
        `rules[${i}].id: ${rule.id.length} characters; the limit is ${MAX_RULE_ID_LENGTH}`,
      );
    }
    const { category } = rule;
    if (category === undefined) {
      problems.push(
        `rules[${i}].category: rule "${rule.id}" has no category; use one of ${CATEGORY_IDS.join(", ")}`,
      );
    } else if (!isCategory(category)) {
      problems.push(
        `rules[${i}].category: rule "${rule.id}" has the unknown category "${shown(category)}"; use one of ${CATEGORY_IDS.join(", ")}`,
      );
    } else {
      covered.add(category);
      problems.push(...hintTopicProblems(rule, category, i));
      rules.push(toRecord(rule, category));
    }
  });

  // Every category needs a rule because a run produces one finding per rule, and an uncovered
  // category would be silently absent from the review instead of reported as missing.
  for (const category of CATEGORY_IDS) {
    if (!covered.has(category)) {
      problems.push(`rules: no rule covers the category "${category}"; every category needs one`);
    }
  }

  if (problems.length > 0 || version === undefined) return { ok: false, problems };
  return { ok: true, version, rules };
}

/**
 * Parses a playbook with the base format, then holds it to what Parol needs on top: a version in
 * its one canonical spelling, a category on every rule, every category covered, and the lengths
 * the store accepts. Throws `PlaybookError`. The size of the YAML is checked first, before any
 * parsing. When the base format itself is violated the error lists those problems and says that
 * the Parol checks wait until they are fixed, because a playbook that does not parse has no rules
 * to check. No error repeats the text of a rule; a key or an id from the file is named only when
 * it is a short plain word (see `scrubProblem`).
 */
export const loadPlaybook: LoadPlaybook = ({ yaml, slug, source }) => {
  const label = source ?? slug;
  if (yaml.length > MAX_YAML_LENGTH) {
    throw parolError(label, [
      `(root): the YAML is ${yaml.length} characters; the limit is ${MAX_YAML_LENGTH}`,
    ]);
  }
  const playbook = parseBase(yaml, label);

  const checked = checkParolFields(playbook);
  if (!checked.ok) throw parolError(label, checked.problems);

  return {
    slug,
    name: playbook.name,
    version: checked.version,
    description: playbook.description ?? null,
    perspective: playbook.perspective,
    rules: checked.rules,
    yaml,
    // Over the text exactly as given, with no normalisation, because a stored version is
    // identified by this hash and a re-saved file with different line endings is a different file.
    sha256: sha256Hex(yaml),
  };
};

/** The rule with this key, or undefined. Keys are compared exactly. */
export function findRule(loaded: LoadedPlaybook, key: string): PlaybookRuleRecord | undefined {
  return loaded.rules.find((rule) => rule.key === key);
}
