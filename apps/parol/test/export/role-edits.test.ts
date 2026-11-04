import { describe, expect, it } from "vitest";
import { MemoGateError, buildMemo } from "../../src/export/memo.js";
import { planMemo } from "../../src/export/plan.js";
import type { MemoInput } from "../../src/module-contracts.js";
import { readMemo, sectionOf } from "./support.js";
import { replaceFinding, review, workedExample } from "./support.js";

/**
 * A reviewer may change how a cited passage is labelled (the store's `ReviewEdits.evidenceRoles`,
 * and docs/parol/03's review request). The memo is what the reviewer signs, so the label it prints
 * is the reviewer's, marked as such, and a role edit it cannot apply refuses the export instead of
 * printing the workflow's label under the reviewer's name.
 */

const IDS = ["ev_governing", "ev_superseded", "ev_supporting"];

function withRoleEdit(
  roles: { evidenceId: string; role: string }[] | null,
  options: { decision?: "edit" | "accept"; ids?: string[] | undefined } = {},
): MemoInput {
  return replaceFinding(workedExample(), "dur-1", (item) => ({
    ...item,
    ...(options.ids === undefined && "ids" in options ? {} : { evidenceIds: options.ids ?? IDS }),
    review: review(options.decision ?? "edit", {
      reason: "The survival clause defines how long Section 4 lasts.",
      edits: roles === null ? null : { evidenceRoles: roles },
    }),
  }));
}

const viewOf = (input: MemoInput) => planMemo(input).findings.find((f) => f.ruleKey === "dur-1")!;

describe("a role edit in the memo", () => {
  it("prints the reviewer's label, says what the workflow had, and counts the change", () => {
    const view = viewOf(withRoleEdit([{ evidenceId: "ev_supporting", role: "definition" }]));
    expect(view.rolesEdited).toBe(1);
    const edited = view.evidence.find((p) => p.roleLabel === "Definition")!;
    expect(edited.roleWorkflowLabel).toBe("Supporting");
    expect(view.evidence.filter((p) => p.roleWorkflowLabel !== null)).toHaveLength(1);
  });

  it("puts the passage where its new role belongs in the order of passages", () => {
    const plain = viewOf(withRoleEdit(null, { decision: "accept" })).evidence.map(
      (p) => p.roleLabel,
    );
    const edited = viewOf(
      withRoleEdit([{ evidenceId: "ev_superseded", role: "governing" }]),
    ).evidence.map((p) => p.roleLabel);
    expect(plain).toEqual(["Governing", "Supporting", "Superseded"]);
    expect(edited).toEqual(["Governing", "Governing", "Supporting"]);
  });

  it("is in the Word file, beside the passage it changed", async () => {
    const read = await readMemo(
      await buildMemo(withRoleEdit([{ evidenceId: "ev_supporting", role: "definition" }])),
    );
    const section = sectionOf(read, 6).join("\n");
    expect(section).toContain(
      "Definition. (role changed by the reviewer; the workflow labelled it Supporting)",
    );
  });

  it("does not mark a role the reviewer set to what it already was", () => {
    const view = viewOf(withRoleEdit([{ evidenceId: "ev_governing", role: "governing" }]));
    expect(view.rolesEdited).toBe(0);
    expect(view.evidence.every((p) => p.roleWorkflowLabel === null)).toBe(true);
  });

  it("reads an empty list or no list as no role edit", () => {
    expect(viewOf(withRoleEdit([])).rolesEdited).toBe(0);
    expect(viewOf(withRoleEdit(null)).rolesEdited).toBe(0);
  });
});

describe("a role edit the memo cannot apply", () => {
  async function gate(input: MemoInput): Promise<MemoGateError> {
    const error = await buildMemo(input).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MemoGateError);
    return error as MemoGateError;
  }

  it("names a passage the finding does not have", async () => {
    const error = await gate(withRoleEdit([{ evidenceId: "ev_other", role: "definition" }]));
    expect(error.gate).toBe("invalid_input");
    expect(error.ruleKeys).toEqual(["dur-1"]);
    expect(error.message).not.toContain("ev_other");
  });

  it("gives no ids for the passages, so it cannot tell which one is meant", async () => {
    const error = await gate(
      withRoleEdit([{ evidenceId: "ev_supporting", role: "definition" }], { ids: undefined }),
    );
    expect(error.gate).toBe("invalid_input");
  });

  it("gives a role that is not one", async () => {
    const error = await gate(withRoleEdit([{ evidenceId: "ev_supporting", role: "decisive" }]));
    expect(error.gate).toBe("invalid_input");
    expect(error.message).not.toContain("decisive");
  });

  it("belongs to a decision that is not an edit", async () => {
    const error = await gate(
      withRoleEdit([{ evidenceId: "ev_supporting", role: "definition" }], { decision: "accept" }),
    );
    expect(error.gate).toBe("invalid_input");
    expect(error.message).toContain("is not an edit but carries edits");
  });

  it("is not a list", async () => {
    const input = withRoleEdit(null);
    const item = input.findings.find((f) => f.finding.ruleKey === "dur-1")!;
    item.review = review("edit", { edits: { evidenceRoles: "definition" as never } });
    expect((await gate(input)).gate).toBe("invalid_input");
  });

  it("gives ids that do not match the passages in number", async () => {
    const error = await gate(
      withRoleEdit([{ evidenceId: "ev_supporting", role: "definition" }], { ids: IDS.slice(0, 2) }),
    );
    expect(error.gate).toBe("invalid_input");
  });
});
