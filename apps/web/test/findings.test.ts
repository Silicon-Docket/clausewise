// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  applyBulk,
  countBySeverity,
  countDecisions,
  describeNotShown,
  editRequestFor,
  effectiveReplacement,
  groupBySeverity,
  resetRequestFor,
} from "../src/lib/findings.js";
import {
  disclosureSentence,
  formatBytes,
  plural,
  redlineFileName,
  startDisclosure,
} from "../src/lib/format.js";
import { appliedFinding, commentOnlyFinding, missingFinding } from "./fixtures.js";

describe("effectiveReplacement", () => {
  it("is the model's wording until the lawyer has written their own", () => {
    expect(effectiveReplacement(appliedFinding())).toBe("three (3) years");
    expect(effectiveReplacement(appliedFinding({ editedReplacement: "two (2) years" }))).toBe(
      "two (2) years",
    );
  });

  it("keeps an empty wording, which means the words are deleted", () => {
    expect(effectiveReplacement(appliedFinding({ editedReplacement: "" }))).toBe("");
  });

  it("is null when there is no edit to word", () => {
    expect(effectiveReplacement(commentOnlyFinding())).toBeNull();
    expect(effectiveReplacement(missingFinding())).toBeNull();
  });
});

describe("editRequestFor", () => {
  it("sends the new wording", () => {
    expect(editRequestFor(appliedFinding(), "two (2) years", false)).toEqual({
      editedReplacement: "two (2) years",
    });
  });

  it("adds the decision when the finding is to be accepted too", () => {
    expect(editRequestFor(appliedFinding(), "two (2) years", true)).toEqual({
      editedReplacement: "two (2) years",
      decision: "accepted",
    });
  });

  it("does not repeat a decision the finding already has", () => {
    expect(editRequestFor(appliedFinding({ decision: "accepted" }), "two (2) years", true)).toEqual(
      {
        editedReplacement: "two (2) years",
      },
    );
  });

  it("sends null, not a copy, when the text is the model's own wording again", () => {
    expect(
      editRequestFor(
        appliedFinding({ editedReplacement: "two (2) years" }),
        "three (3) years",
        false,
      ),
    ).toEqual({
      editedReplacement: null,
    });
  });

  it("sends nothing when nothing differs from what is stored", () => {
    expect(editRequestFor(appliedFinding(), "three (3) years", false)).toBeNull();
    expect(
      editRequestFor(
        appliedFinding({ editedReplacement: "two (2) years" }),
        "two (2) years",
        false,
      ),
    ).toBeNull();
    expect(
      editRequestFor(appliedFinding({ decision: "accepted" }), "three (3) years", true),
    ).toBeNull();
  });

  it("sends the accept alone when only that differs", () => {
    expect(editRequestFor(appliedFinding(), "three (3) years", true)).toEqual({
      decision: "accepted",
    });
  });

  it("sends an empty wording as an empty string", () => {
    expect(editRequestFor(appliedFinding(), "", false)).toEqual({ editedReplacement: "" });
  });

  it("sends nothing for a finding that has no edit, which the server would refuse", () => {
    expect(editRequestFor(commentOnlyFinding(), "anything", true)).toBeNull();
    expect(editRequestFor(missingFinding(), "anything", true)).toBeNull();
  });
});

describe("resetRequestFor", () => {
  it("clears the decision and the wording of an applied edit", () => {
    expect(resetRequestFor(appliedFinding())).toEqual({
      decision: "pending",
      editedReplacement: null,
    });
  });

  it("clears only the decision elsewhere, because the server refuses a wording there", () => {
    expect(resetRequestFor(commentOnlyFinding())).toEqual({ decision: "pending" });
    expect(resetRequestFor(missingFinding())).toEqual({ decision: "pending" });
  });
});

describe("grouping and counting", () => {
  const findings = [
    missingFinding(),
    appliedFinding({ ruleId: "a", decision: "accepted" }),
    appliedFinding({ ruleId: "b", severity: "low", decision: "rejected" }),
    commentOnlyFinding(),
  ];

  it("groups by severity, high first, and leaves out an empty group", () => {
    expect(
      groupBySeverity(findings).map((g) => [g.severity, g.findings.map((f) => f.ruleId)]),
    ).toEqual([
      ["high", ["a"]],
      ["medium", ["governing-law"]],
      ["low", ["return-of-information", "b"]],
    ]);
    expect(groupBySeverity([appliedFinding()]).map((g) => g.severity)).toEqual(["high"]);
    expect(groupBySeverity([])).toEqual([]);
  });

  it("counts decisions and severities", () => {
    expect(countDecisions(findings)).toEqual({ pending: 2, accepted: 1, rejected: 1 });
    expect(countBySeverity(findings)).toEqual({ high: 1, medium: 1, low: 2 });
  });

  it("applies a bulk decision to everything, or only to the severities named", () => {
    expect(applyBulk(findings, "accepted", undefined).map((f) => f.decision)).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "accepted",
    ]);
    expect(applyBulk(findings, "rejected", ["low"]).map((f) => f.decision)).toEqual([
      "rejected",
      "accepted",
      "rejected",
      "pending",
    ]);
    expect(applyBulk(findings, "pending", ["high", "medium"]).map((f) => f.decision)).toEqual([
      "pending",
      "pending",
      "rejected",
      "pending",
    ]);
  });

  it("does not change the findings it was given", () => {
    const before = JSON.stringify(findings);
    applyBulk(findings, "accepted", undefined);
    expect(JSON.stringify(findings)).toBe(before);
  });
});

describe("describeNotShown", () => {
  const none = {
    trackedInsertions: 0,
    trackedDeletions: 0,
    comments: 0,
    footnotes: 0,
    endnotes: 0,
    headerFooterParts: 0,
    hiddenRuns: 0,
    images: 0,
  };

  it("lists only what is there, in words, with the right plural", () => {
    expect(describeNotShown(null)).toEqual([]);
    expect(describeNotShown(none)).toEqual([]);
    expect(
      describeNotShown({
        ...none,
        comments: 1,
        images: 2,
        hiddenRuns: 1,
        footnotes: 3,
        headerFooterParts: 1,
      }),
    ).toEqual([
      "1 comment",
      "3 footnotes",
      "1 header or footer",
      "1 piece of hidden text",
      "2 images",
    ]);
  });
});

describe("text helpers", () => {
  it("plural", () => {
    expect(plural(1, "rule")).toBe("1 rule");
    expect(plural(0, "rule")).toBe("0 rules");
    expect(plural(2, "box", "boxes")).toBe("2 boxes");
  });

  it("formatBytes", () => {
    expect(formatBytes(17)).toBe("17 bytes");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB");
  });

  it("builds the disclosure sentences, and leaves a full sentence alone", () => {
    expect(disclosureSentence("Anthropic API (api.anthropic.com)")).toBe(
      "Reviews are sent to Anthropic API (api.anthropic.com).",
    );
    expect(disclosureSentence("Nothing leaves this machine.")).toBe("Nothing leaves this machine.");
    expect(startDisclosure("Anthropic API (api.anthropic.com)")).toBe(
      "Pressing Start sends the text of this contract to Anthropic API (api.anthropic.com).",
    );
    expect(startDisclosure("Nothing leaves this machine.")).toBe("Nothing leaves this machine.");
  });

  it("names a redline after the document", () => {
    expect(redlineFileName("Acme NDA.docx")).toBe("Acme NDA (redline).docx");
    expect(redlineFileName("notes.DOCX")).toBe("notes (redline).docx");
    expect(redlineFileName(".docx")).toBe("contract (redline).docx");
  });
});
