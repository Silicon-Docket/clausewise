import type { Playbook, Rule } from "@clausewise/playbook";
import { describe, expect, it } from "vitest";
import { buildRulePrompt } from "../src/prompt.js";
import type { Clause } from "../src/types.js";

const playbook: Playbook = {
  name: "Test playbook",
  contractTypes: ["nda"],
  perspective: "We receive most of the information, so we want narrow duties.",
  rules: [],
};

const presence: Rule = {
  id: "term",
  title: "Duration of confidentiality obligations",
  severity: "high",
  required: true,
  standard: "Obligations end no more than three years after disclosure.",
  fallback: "Up to five years from the end of the agreement.",
};

const absence: Rule = {
  id: "restrictive-covenants",
  title: "No restrictive covenants",
  severity: "high",
  kind: "absence",
  required: false,
  standard: "The agreement contains no non-solicitation or non-compete term.",
};

const clauses: Clause[] = [
  {
    id: "c1",
    number: "1.1",
    heading: "1. Confidentiality",
    paragraphs: [{ id: "p:1", text: "1.1 Recipient shall keep the information confidential." }],
    text: "1.1 Recipient shall keep the information confidential.",
  },
];

const CLIENT = "Fabrikam Labs LLC, the Recipient";

describe("the client line", () => {
  it("follows the perspective, in the shared prefix", () => {
    const { prompt, sharedPrefix } = buildRulePrompt({
      playbook,
      rule: presence,
      clauses,
      client: CLIENT,
    });
    expect(sharedPrefix).toContain(`Our client: ${CLIENT}\n`);
    const lines = sharedPrefix.split("\n");
    const perspective = lines.findIndex((line) => line.startsWith("Perspective: "));
    expect(perspective).toBeGreaterThan(0);
    expect(lines[perspective + 1]).toBe(`Our client: ${CLIENT}`);
    expect(prompt.startsWith(sharedPrefix)).toBe(true);
    expect(prompt.slice(sharedPrefix.length)).not.toContain("Our client");
  });

  it("comes after the contract and before the rule", () => {
    const { prompt } = buildRulePrompt({ playbook, rule: presence, clauses, client: CLIENT });
    const close = prompt.indexOf("</contract>");
    expect(prompt.indexOf("Our client:")).toBeGreaterThan(close);
    expect(prompt.indexOf("Our client:")).toBeLessThan(prompt.indexOf("Rule ID:"));
  });

  it("is the same for every rule of one review", () => {
    const a = buildRulePrompt({ playbook, rule: presence, clauses, client: CLIENT });
    const b = buildRulePrompt({ playbook, rule: absence, clauses, client: CLIENT });
    expect(a.sharedPrefix).toBe(b.sharedPrefix);
    expect(a.prompt).not.toBe(b.prompt);
  });

  it("changes the shared prefix, so a cached prefix is not reused for another client", () => {
    const a = buildRulePrompt({ playbook, rule: presence, clauses, client: "Fabrikam Labs LLC" });
    const b = buildRulePrompt({ playbook, rule: presence, clauses, client: "Contoso, Inc." });
    expect(a.sharedPrefix).not.toBe(b.sharedPrefix);
  });

  it("is left out when it was not given, or is blank", () => {
    for (const client of [undefined, "", "   ", "\n\t "]) {
      const { prompt } = buildRulePrompt({
        playbook,
        rule: presence,
        clauses,
        ...(client === undefined ? {} : { client }),
      });
      expect(prompt).not.toContain("Our client");
      expect(prompt).not.toMatch(/client/i);
    }
  });

  it("is trimmed and kept on one line, so it cannot add lines of its own", () => {
    const { sharedPrefix } = buildRulePrompt({
      playbook,
      rule: presence,
      clauses,
      client: "  Fabrikam Labs LLC,\n\nthe Recipient\n  ",
    });
    expect(sharedPrefix).toContain("\nOur client: Fabrikam Labs LLC, the Recipient\n");
  });

  it("does not change the system prompt", () => {
    const a = buildRulePrompt({ playbook, rule: presence, clauses }).system;
    const b = buildRulePrompt({ playbook, rule: presence, clauses, client: CLIENT }).system;
    expect(a).toBe(b);
    expect(b).not.toContain("Fabrikam");
  });
});

describe("the part line", () => {
  const window = (index: number, total: number) => ({ index, total });

  it("says which part of how many this is, counting from one", () => {
    const first = buildRulePrompt({ playbook, rule: presence, clauses, window: window(0, 3) });
    const last = buildRulePrompt({ playbook, rule: presence, clauses, window: window(2, 3) });
    expect(first.sharedPrefix).toContain("This is part 1 of 3 of the contract.");
    expect(last.sharedPrefix).toContain("This is part 3 of 3 of the contract.");
  });

  it("says that other clauses are not shown and that absence here proves nothing", () => {
    const { sharedPrefix } = buildRulePrompt({
      playbook,
      rule: presence,
      clauses,
      window: window(1, 4),
    });
    expect(sharedPrefix).toMatch(/Clauses outside this part are not shown/);
    expect(sharedPrefix).toMatch(/absence in this part is not proof of absence in the contract/);
  });

  it("is in the shared prefix, after the perspective and the client, before the rule", () => {
    const { prompt, sharedPrefix } = buildRulePrompt({
      playbook,
      rule: presence,
      clauses,
      client: CLIENT,
      window: window(1, 2),
    });
    const at = (text: string): number => sharedPrefix.indexOf(text);
    expect(at("</contract>")).toBeLessThan(at("Playbook:"));
    expect(at("Perspective:")).toBeLessThan(at("Our client:"));
    expect(at("Our client:")).toBeLessThan(at("This is part 2 of 2"));
    expect(prompt.startsWith(sharedPrefix)).toBe(true);
    expect(prompt.slice(sharedPrefix.length).startsWith("Rule ID: term")).toBe(true);
    expect(prompt.slice(sharedPrefix.length)).not.toContain("This is part");
  });

  it("is the same for every rule of one window, and differs between windows", () => {
    const a = buildRulePrompt({ playbook, rule: presence, clauses, window: window(1, 3) });
    const b = buildRulePrompt({ playbook, rule: absence, clauses, window: window(1, 3) });
    const c = buildRulePrompt({ playbook, rule: presence, clauses, window: window(2, 3) });
    expect(a.sharedPrefix).toBe(b.sharedPrefix);
    expect(a.sharedPrefix).not.toBe(c.sharedPrefix);
  });

  it("is left out for a contract that goes in one piece", () => {
    for (const w of [undefined, window(0, 1), window(0, 0)]) {
      const { prompt } = buildRulePrompt({
        playbook,
        rule: presence,
        clauses,
        ...(w === undefined ? {} : { window: w }),
      });
      expect(prompt).not.toMatch(/This is part/);
      expect(prompt).not.toMatch(/not shown/);
    }
  });

  it("keeps the part number within the parts there are", () => {
    const out = buildRulePrompt({ playbook, rule: presence, clauses, window: window(9, 3) });
    expect(out.sharedPrefix).toContain("This is part 3 of 3");
    const negative = buildRulePrompt({ playbook, rule: presence, clauses, window: window(-2, 3) });
    expect(negative.sharedPrefix).toContain("This is part 1 of 3");
  });

  it("does not change the system prompt", () => {
    const a = buildRulePrompt({ playbook, rule: presence, clauses }).system;
    const b = buildRulePrompt({ playbook, rule: presence, clauses, window: window(1, 3) }).system;
    expect(a).toBe(b);
  });
});

describe("the kind of a rule in the rule block", () => {
  const ruleBlock = (rule: Rule): string => {
    const { prompt, sharedPrefix } = buildRulePrompt({ playbook, rule, clauses });
    return prompt.slice(sharedPrefix.length);
  };

  it("shows an absence rule as absence", () => {
    const block = ruleBlock(absence);
    expect(block.split("\n")).toContain("Kind: absence");
    expect(block).not.toContain("Kind: presence");
  });

  it("shows a rule without a kind as presence", () => {
    const block = ruleBlock(presence);
    expect(block.split("\n")).toContain("Kind: presence");
    expect(block).not.toContain("Kind: absence");
  });

  it("shows an explicit presence rule as presence", () => {
    expect(ruleBlock({ ...presence, kind: "presence" })).toContain("Kind: presence");
  });

  it("keeps the kind with the rest of the rule and out of the shared prefix", () => {
    const { prompt, sharedPrefix } = buildRulePrompt({ playbook, rule: absence, clauses });
    expect(sharedPrefix).not.toContain("Kind:");
    expect(prompt.indexOf("Kind: absence")).toBeGreaterThan(prompt.indexOf("Rule ID:"));
    expect(prompt.indexOf("Kind: absence")).toBeLessThan(prompt.indexOf("Standard:"));
  });

  it("asks for Required only of a presence rule", () => {
    expect(ruleBlock(presence)).toContain("Required: yes");
    expect(ruleBlock({ ...presence, required: false })).toContain("Required: no");
    expect(ruleBlock(absence)).not.toContain("Required");
  });

  it("is the same shared prefix for a presence and an absence rule", () => {
    const a = buildRulePrompt({ playbook, rule: presence, clauses });
    const b = buildRulePrompt({ playbook, rule: absence, clauses });
    expect(a.sharedPrefix).toBe(b.sharedPrefix);
    expect(a.system).toBe(b.system);
  });

  it("keeps the other fields of an absence rule", () => {
    const block = ruleBlock({
      ...absence,
      unacceptable: "Any exclusivity.",
      guidance: "Delete it.",
    });
    expect(block).toContain("Title: No restrictive covenants");
    expect(block).toContain("Severity: high");
    expect(block).toContain(`Standard: ${absence.standard}`);
    expect(block).toContain("Unacceptable: Any exclusivity.");
    expect(block).toContain("Guidance: Delete it.");
    expect(block.trimEnd().split("\n").at(-1)).toContain('rule with ID "restrictive-covenants"');
  });
});
