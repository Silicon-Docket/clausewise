import { PlaybookError, parsePlaybook, type Playbook } from "@clausewise/playbook";
import { sha256Hex } from "../canonical.js";
import { CATEGORY_IDS, type CategoryId, type PlaybookRuleRecord } from "../contracts.js";
import type { LoadPlaybook, LoadedPlaybook } from "../module-contracts.js";

const CATEGORY_SET: ReadonlySet<string> = new Set(CATEGORY_IDS);
const isCategory = (value: string): value is CategoryId => CATEGORY_SET.has(value);

// A category value that is not on the list is echoed so the author can see the typo. The base
// schema already limits it to lowercase letters, digits and hyphens, and the cut keeps a very
// long value from filling the message.
const shown = (value: string): string => (value.length > 40 ? `${value.slice(0, 40)}...` : value);

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
  };
}

type ParolCheck =
  { ok: true; version: string; rules: PlaybookRuleRecord[] } | { ok: false; problems: string[] };

/**
 * Checks what Parol needs and the base playbook format leaves optional, collecting every problem
 * so that an author fixes a playbook in one pass. Messages carry rule ids and category ids only,
 * never the text of a standard, so a playbook with a secret in a rule cannot leak it through an
 * error.
 */
function checkParolFields(playbook: Playbook): ParolCheck {
  const problems: string[] = [];

  const { version } = playbook;
  if (version === undefined) {
    problems.push("version: required, such as 1.0.0, because a matter pins the exact version");
  }

  const rules: PlaybookRuleRecord[] = [];
  const covered = new Set<CategoryId>();
  playbook.rules.forEach((rule, i) => {
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
 * Parses a playbook with the base format, then holds it to what Parol needs on top: a version, a
 * category on every rule, and every category covered. Throws `PlaybookError`. When the base format
 * itself is violated the error lists those problems and the Parol checks wait until they are
 * fixed, because a playbook that does not parse has no rules to check.
 */
export const loadPlaybook: LoadPlaybook = ({ yaml, slug, source }) => {
  const label = source ?? slug;
  const playbook = parsePlaybook(yaml, label);

  const checked = checkParolFields(playbook);
  if (!checked.ok) {
    throw new PlaybookError(
      `${label} is not a valid Parol playbook:\n  ${checked.problems.join("\n  ")}`,
      checked.problems,
    );
  }

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
