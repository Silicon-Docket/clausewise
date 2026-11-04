import { PlaybookError } from "@clausewise/playbook";
import { expect } from "vitest";
import { CATEGORY_IDS } from "../../src/contracts.js";
import { loadPlaybook } from "../../src/playbooks/load.js";

/** Everything here is invented for the tests; no rule or party comes from a real playbook. */

export type Json = Record<string, unknown>;

/** JSON is a subset of YAML, so a test can build a playbook as a plain object. */
export const yamlOf = (value: unknown): string => JSON.stringify(value, null, 2);

/** The rule a test playbook has for a category. Pass `over` to change or (with undefined) drop fields. */
export function ruleFor(category: string, over: Json = {}): Json {
  return {
    id: `rule-${category}`,
    category,
    title: `Title for ${category}`,
    severity: "medium",
    required: true,
    standard: `Standard for ${category}.`,
    ...over,
  };
}

/** A playbook that passes every check: a version, and one rule in each of the seven categories. */
export function playbookOf(over: Json = {}): Json {
  return {
    name: "Invented test playbook",
    version: "1.0.0",
    contractTypes: ["nda"],
    perspective: "We act for the invented receiving party.",
    rules: CATEGORY_IDS.map((category) => ruleFor(category)),
    ...over,
  };
}

/** The valid rule list with the rule for one category replaced, or removed when `replacement` is null. */
export function rulesWith(category: string, replacement: Json | null): Json[] {
  const rules = CATEGORY_IDS.map((c) => ruleFor(c));
  const at = rules.findIndex((rule) => rule.category === category);
  if (replacement === null) rules.splice(at, 1);
  else rules[at] = replacement;
  return rules;
}

export const loadObject = (value: unknown, source?: string) =>
  loadPlaybook({
    yaml: yamlOf(value),
    slug: "test-playbook",
    ...(source === undefined ? {} : { source }),
  });

/** Runs `fn`, requires a PlaybookError and returns it. */
export function playbookErrorOf(fn: () => unknown): PlaybookError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected a PlaybookError").toBeInstanceOf(PlaybookError);
  return caught as PlaybookError;
}
