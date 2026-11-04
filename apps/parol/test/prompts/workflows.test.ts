import { describe, expect, it } from "vitest";
import { hashOf } from "../../src/canonical.js";
import { getPrompt } from "../../src/prompts/registry.js";
import { WORKFLOWS, workflowFor } from "../../src/prompts/workflows.js";

describe("workflow versions", () => {
  it("v1 is prompts P1, retrieval R1, checks C1, a 12000 token budget and one repair", () => {
    expect(WORKFLOWS.v1!.manifest).toEqual({
      label: "v1",
      prompts: { extract: "extract.p1", analyze: "analyze.p1", support: null },
      retrieval: "R1",
      checks: ["C1"],
      budgetTokens: 12000,
      repairAttempts: 1,
    });
  });

  it("v2 is v1 with a different label and retrieval R2, and nothing else", () => {
    const { label: l1, retrieval: r1, ...rest1 } = WORKFLOWS.v1!.manifest;
    const { label: l2, retrieval: r2, ...rest2 } = WORKFLOWS.v2!.manifest;
    expect([l1, r1, l2, r2]).toEqual(["v1", "R1", "v2", "R2"]);
    expect(rest2).toEqual(rest1);
  });

  it("registers exactly v1 and v2", () => {
    expect(Object.keys(WORKFLOWS).sort()).toEqual(["v1", "v2"]);
  });

  it("hashes the manifest, and the two versions hash differently", () => {
    for (const workflow of Object.values(WORKFLOWS)) {
      expect(workflow.sha256).toBe(hashOf(workflow.manifest));
      expect(workflow.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(WORKFLOWS.v1!.sha256).not.toBe(WORKFLOWS.v2!.sha256);
  });

  it("is stable across reads", () => {
    expect(workflowFor("v1").sha256).toBe(workflowFor("v1").sha256);
    expect(workflowFor("v1").sha256).toBe(hashOf({ ...WORKFLOWS.v1!.manifest }));
  });

  it("changes hash when any pinned setting changes", () => {
    const base = WORKFLOWS.v1!;
    const variants = [
      { ...base.manifest, retrieval: "R2" as const },
      { ...base.manifest, budgetTokens: 12001 },
      { ...base.manifest, repairAttempts: 0 },
      { ...base.manifest, checks: ["C1", "C2"] },
      { ...base.manifest, prompts: { ...base.manifest.prompts, analyze: "analyze.p2" } },
      { ...base.manifest, prompts: { ...base.manifest.prompts, support: "support.p1" } },
    ];
    for (const manifest of variants) expect(hashOf(manifest)).not.toBe(base.sha256);
  });

  it("does not share mutable state between versions", () => {
    expect(WORKFLOWS.v1!.manifest.checks).not.toBe(WORKFLOWS.v2!.manifest.checks);
    expect(WORKFLOWS.v1!.manifest.prompts).not.toBe(WORKFLOWS.v2!.manifest.prompts);
  });

  it("hands out manifests that cannot be changed, so the recorded hash cannot go stale", () => {
    for (const label of ["v1", "v2"]) {
      const workflow = workflowFor(label);
      const before = hashOf(workflow.manifest);
      expect(before).toBe(workflow.sha256);
      expect(() => workflow.manifest.checks.push("C2")).toThrow(TypeError);
      expect(() => {
        workflow.manifest.prompts.analyze = "analyze.p2";
      }).toThrow(TypeError);
      expect(() => {
        workflow.manifest.retrieval = "R1";
      }).toThrow(TypeError);
      expect(() => {
        (workflow as { sha256: string }).sha256 = "0".repeat(64);
      }).toThrow(TypeError);
      expect(() => {
        (WORKFLOWS as Record<string, unknown>)[label] = workflow;
      }).toThrow(TypeError);
      expect(() => {
        (WORKFLOWS as Record<string, unknown>)["v9"] = workflow;
      }).toThrow(TypeError);
      expect(hashOf(workflowFor(label).manifest)).toBe(before);
    }
    expect(Object.isFrozen(WORKFLOWS.v1!.manifest.checks)).toBe(true);
    expect(Object.isFrozen(WORKFLOWS.v1!.manifest.prompts)).toBe(true);
  });

  it("pins prompts that exist in the registry", () => {
    for (const workflow of Object.values(WORKFLOWS)) {
      const { extract, analyze, support } = workflow.manifest.prompts;
      expect(getPrompt(extract).definition.stage).toBe("extract");
      expect(getPrompt(analyze).definition.stage).toBe("analyze");
      expect(support).toBeNull();
    }
  });

  it("looks a version up by label and refuses an unknown or inherited one", () => {
    expect(workflowFor("v2")).toBe(WORKFLOWS.v2);
    expect(() => workflowFor("v3")).toThrow('unknown workflow version "v3"');
    expect(() => workflowFor("constructor")).toThrow("unknown workflow version");
    expect(() => workflowFor("__proto__")).toThrow("unknown workflow version");
  });
});
