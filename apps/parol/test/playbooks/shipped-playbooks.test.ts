import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PlaybookError, parsePlaybook } from "@clausewise/playbook";
import { describe, expect, it } from "vitest";
import { CATEGORY_IDS } from "../../src/contracts.js";
import { loadPlaybook } from "../../src/playbooks/load.js";
import { playbookErrorOf } from "./support.js";

// The playbooks Clausewise ships use the base format only. They are valid there and must stay
// valid, but Parol pins a version and files every rule under a category, so it must refuse them
// instead of guessing either.
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const SHIPPED = ["nda-mutual.yaml", "saas-customer.yaml"] as const;
const text = (file: string): string => readFileSync(join(repoRoot, "playbooks", file), "utf8");

describe.each(SHIPPED)("the shipped Clausewise playbook %s", (file) => {
  it("validates with the base parser, with no version and no category on any rule", () => {
    const base = parsePlaybook(text(file), file);
    expect(base.rules.length).toBeGreaterThan(0);
    expect(base.version).toBeUndefined();
    for (const rule of base.rules) expect(rule.category, rule.id).toBeUndefined();
  });

  it("is rejected by loadPlaybook for lacking a version", () => {
    const err = playbookErrorOf(() => loadPlaybook({ yaml: text(file), slug: "shipped", source: file }));
    expect(err.problems.filter((p) => p.startsWith("version:"))).toHaveLength(1);
    expect(err.message).toContain(`${file} is not a valid Parol playbook`);
  });

  it("is rejected by loadPlaybook for lacking a category on every rule, naming each rule", () => {
    const base = parsePlaybook(text(file), file);
    const err = playbookErrorOf(() => loadPlaybook({ yaml: text(file), slug: "shipped" }));
    const categoryProblems = err.problems.filter((p) => /^rules\[\d+\]\.category:/.test(p));
    expect(categoryProblems).toHaveLength(base.rules.length);
    base.rules.forEach((rule, i) => {
      expect(categoryProblems[i], rule.id).toContain(`rules[${i}].category: rule "${rule.id}" has no category`);
    });
    // With no category anywhere, none of the seven is covered.
    for (const category of CATEGORY_IDS) {
      expect(err.problems).toContain(
        `rules: no rule covers the category "${category}"; every category needs one`,
      );
    }
  });

  it("is still rejected when only the version is added, because the categories are missing", () => {
    const err = playbookErrorOf(() =>
      loadPlaybook({ yaml: `version: 1.0.0\n${text(file)}`, slug: "shipped" }),
    );
    expect(err.problems.some((p) => p.startsWith("version:"))).toBe(false);
    expect(err.problems.some((p) => /\.category:/.test(p))).toBe(true);
  });
});

describe("the two shipped playbooks together", () => {
  it("are both present, so a rename or removal is noticed here", () => {
    for (const file of SHIPPED) expect(text(file).length, file).toBeGreaterThan(100);
  });

  it("raise the same error type that callers catch for any other bad playbook", () => {
    for (const file of SHIPPED) {
      expect(() => loadPlaybook({ yaml: text(file), slug: "shipped" }), file).toThrow(PlaybookError);
    }
  });
});
