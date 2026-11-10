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

  it("registers exactly v1, v2 and v3", () => {
    expect(Object.keys(WORKFLOWS).sort()).toEqual(["v1", "v2", "v3"]);
  });

  it("did not change the hash of v1 or v2 by adding v3", () => {
    // Results files and recordings pin these. They were taken before v3 existed.
    expect(WORKFLOWS.v1!.sha256).toBe(
      "27c18b062bce86e5141352e94bf3ecab1b9bdb831217759a9530d40121bfd0eb",
    );
    expect(WORKFLOWS.v2!.sha256).toBe(
      "272aaf6a51b7d1d79d51952175e43ff971dfc182943234daf49f7a4f3690dd49",
    );
  });

  it("v3 is v2 with the support check and check set C2 switched on, and nothing else", () => {
    const { label: l2, prompts: p2, checks: c2, ...rest2 } = WORKFLOWS.v2!.manifest;
    const { label: l3, prompts: p3, checks: c3, ...rest3 } = WORKFLOWS.v3!.manifest;
    expect([l2, l3]).toEqual(["v2", "v3"]);
    expect(rest3).toEqual(rest2);
    expect(p2).toEqual({ extract: "extract.p1", analyze: "analyze.p1", support: null });
    expect(p3).toEqual({ extract: "extract.p1", analyze: "analyze.p1", support: "support.p1" });
    expect(c2).toEqual(["C1"]);
    expect(c3).toEqual(["C1", "C2"]);
    expect(WORKFLOWS.v3!.sha256).toBe(
      "28469ff62d95503368d022786252bb41ad7896577c6604e1f7b58d8d808ca704",
    );
  });

  it("v3 pins a prompt that exists, and is not shipped with the application", async () => {
    expect(getPrompt("support.p1").definition.stage).toBe("support");
    const { WORKFLOW_LABELS } = await import("../../src/boot/register.js");
    expect([...WORKFLOW_LABELS]).toEqual(["v1", "v2"]);
  });

  it("hashes the manifest, and the two versions hash differently", () => {
    for (const workflow of Object.values(WORKFLOWS)) {
      expect(workflow.sha256).toBe(hashOf(workflow.manifest));
      expect(workflow.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(WORKFLOWS.v1!.sha256).not.toBe(WORKFLOWS.v2!.sha256);
    expect(new Set(Object.values(WORKFLOWS).map((w) => w.sha256)).size).toBe(3);
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
    for (const label of ["v1", "v2", "v3"]) {
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
      if (workflow.manifest.label === "v3") {
        expect(getPrompt(support as string).definition.stage).toBe("support");
      } else {
        expect(support).toBeNull();
      }
    }
  });

  it("looks a version up by label and refuses an unknown or inherited one", () => {
    expect(workflowFor("v2")).toBe(WORKFLOWS.v2);
    expect(workflowFor("v3")).toBe(WORKFLOWS.v3);
    expect(() => workflowFor("v4")).toThrow('unknown workflow version "v4"');
    expect(() => workflowFor("constructor")).toThrow("unknown workflow version");
    expect(() => workflowFor("__proto__")).toThrow("unknown workflow version");
  });
});
