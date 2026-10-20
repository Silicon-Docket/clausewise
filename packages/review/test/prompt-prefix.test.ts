import type { Playbook, Rule } from "@clausewise/playbook";
import { describe, expect, it } from "vitest";
import { buildRulePrompt } from "../src/prompt.js";
import type { Clause } from "../src/types.js";

const playbook: Playbook = {
  name: "Test playbook",
  contractTypes: ["nda"],
  perspective: "We receive information.",
  rules: [],
};

const rule = (id: string, title: string): Rule => ({
  id,
  title,
  severity: "high",
  required: true,
  standard: `standard for ${id}`,
});

const clause = (id: string, text: string): Clause => ({
  id,
  number: undefined,
  heading: undefined,
  paragraphs: [{ id: `p:${id}`, text }],
  text,
});

describe("buildRulePrompt sharedPrefix", () => {
  const clauses = [clause("c1", "First clause."), clause("c2", "Second clause.")];

  it("starts the prompt and ends just before the rule block", () => {
    const { prompt, sharedPrefix } = buildRulePrompt({
      playbook,
      rule: rule("term", "Term"),
      clauses,
    });
    expect(prompt.startsWith(sharedPrefix)).toBe(true);
    expect(prompt.slice(sharedPrefix.length).startsWith("Rule ID: term")).toBe(true);
  });

  it("is byte-identical for every rule checked against the same contract", () => {
    const a = buildRulePrompt({ playbook, rule: rule("term", "Term"), clauses });
    const b = buildRulePrompt({ playbook, rule: rule("law", "Governing law"), clauses });
    expect(a.sharedPrefix).toBe(b.sharedPrefix);
    expect(a.prompt).not.toBe(b.prompt);
  });

  it("holds the contract and playbook but nothing about the rule", () => {
    const { sharedPrefix } = buildRulePrompt({ playbook, rule: rule("term", "Term"), clauses });
    expect(sharedPrefix).toContain("First clause.");
    expect(sharedPrefix).toContain("Perspective: We receive information.");
    expect(sharedPrefix).not.toContain("Rule ID");
    expect(sharedPrefix).not.toContain("standard for term");
  });

  it("changes when the contract changes", () => {
    const a = buildRulePrompt({ playbook, rule: rule("term", "Term"), clauses });
    const b = buildRulePrompt({
      playbook,
      rule: rule("term", "Term"),
      clauses: [clause("c1", "A different clause.")],
    });
    expect(a.sharedPrefix).not.toBe(b.sharedPrefix);
  });
});

describe("buildRulePrompt sharedPrefix with a client and a window", () => {
  const clauses = [clause("c1", "First clause."), clause("c2", "Second clause.")];
  const absence: Rule = { ...rule("law", "No covenants"), kind: "absence", required: false };

  it("stays identical across the rules of one review and one window", () => {
    const options = { clauses, client: "Fabrikam Labs LLC", window: { index: 1, total: 3 } };
    const prefixes = [rule("term", "Term"), rule("law", "Governing law"), absence].map(
      (r) => buildRulePrompt({ playbook, rule: r, ...options }).sharedPrefix,
    );
    expect(new Set(prefixes).size).toBe(1);
    expect(prefixes[0]).toContain("Our client: Fabrikam Labs LLC");
    expect(prefixes[0]).toContain("This is part 2 of 3 of the contract.");
  });

  it("starts the prompt and ends just before the rule block", () => {
    const { prompt, sharedPrefix } = buildRulePrompt({
      playbook,
      rule: rule("term", "Term"),
      clauses,
      client: "Fabrikam Labs LLC",
      window: { index: 0, total: 2 },
    });
    expect(sharedPrefix).toContain("Our client: Fabrikam Labs LLC\n");
    expect(prompt.startsWith(sharedPrefix)).toBe(true);
    expect(sharedPrefix.endsWith("\n\n")).toBe(true);
    expect(prompt.slice(sharedPrefix.length).startsWith("Rule ID: term")).toBe(true);
  });

  it("holds the client and the part, and still nothing about the rule", () => {
    const { sharedPrefix } = buildRulePrompt({
      playbook,
      rule: rule("term", "Term"),
      clauses,
      client: "Fabrikam Labs LLC",
      window: { index: 0, total: 2 },
    });
    expect(sharedPrefix).toContain("Our client: Fabrikam Labs LLC");
    expect(sharedPrefix).toContain("This is part 1 of 2 of the contract.");
    expect(sharedPrefix).not.toContain("Rule ID");
    expect(sharedPrefix).not.toContain("Kind:");
    expect(sharedPrefix).not.toContain("standard for term");
  });

  it("differs from the prefix of a review without a client or of another part", () => {
    const base = { playbook, rule: rule("term", "Term"), clauses };
    const plain = buildRulePrompt(base).sharedPrefix;
    const client = buildRulePrompt({ ...base, client: "Fabrikam Labs LLC" }).sharedPrefix;
    const first = buildRulePrompt({ ...base, window: { index: 0, total: 2 } }).sharedPrefix;
    const second = buildRulePrompt({ ...base, window: { index: 1, total: 2 } }).sharedPrefix;
    expect(new Set([plain, client, first, second]).size).toBe(4);
  });

  it("is the old prefix when neither is given", () => {
    const { sharedPrefix } = buildRulePrompt({ playbook, rule: rule("term", "Term"), clauses });
    expect(sharedPrefix.endsWith("Perspective: We receive information.\n\n")).toBe(true);
  });
});
