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
