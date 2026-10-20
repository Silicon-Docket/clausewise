import { beforeAll, describe, expect, it } from "vitest";
import { reviewContract } from "../src/pipeline.js";
import { createOracleGenerator, type OracleRule } from "../src/testing.js";
import type { Clause, RuleResult } from "../src/types.js";
import {
  budgetFor,
  buildDocx,
  clausesOf,
  expectedWindows,
  fixture,
  loadPlaybook,
  onlyRules,
  padded,
} from "./pipeline-support.js";

const playbook = loadPlaybook();
const term = onlyRules(playbook, "term");

async function resultFor(
  docx: Uint8Array,
  script: Record<string, OracleRule>,
  maxContextTokens?: number,
): Promise<RuleResult> {
  const { report } = await reviewContract(
    { docx, playbook: term },
    createOracleGenerator(script),
    maxContextTokens === undefined ? {} : { maxContextTokens },
  );
  return report.results[0]!;
}

// A compliant answer is a claim about a clause, and the pipeline refuses one that names none. The
// oracle answers as a competent model would, so a script need not name a clause to be believed.
describe("the oracle's compliant answers", () => {
  const input = fixture("nda-aggressive.docx");

  it("point at the first numbered clause when the script names none", async () => {
    const result = await resultFor(input, { term: { status: "compliant" } });
    // c1 and c2 are the preamble, and c3 is the first clause with a number, 1.1.
    expect(result).toMatchObject({
      status: "compliant",
      clauseIds: ["c3"],
      clauseNumbers: ["1.1"],
    });
  });

  it("point where the script says when it names a clause", async () => {
    const result = await resultFor(input, {
      term: { status: "compliant", clauseNumbers: ["3.1"] },
    });
    expect(result).toMatchObject({
      status: "compliant",
      clauseIds: ["c7"],
      clauseNumbers: ["3.1"],
    });
  });

  it("are left alone in the other statuses", async () => {
    for (const status of ["deviation", "missing", "not_applicable"] as const) {
      const result = await resultFor(input, { term: { status, explanation: "x" } });
      expect(result.clauseIds).toEqual([]);
    }
  });

  it("point at the first clause of a contract that has no numbers", async () => {
    const docx = await buildDocx([
      { text: "The parties wish to explore a possible commercial relationship between them." },
      {
        text: "Either party may end this Agreement by giving the other thirty days written notice.",
      },
      { text: "Each party shall keep the information of the other secret for three years." },
    ]);
    const result = await resultFor(docx, { term: { status: "compliant" } });
    expect(result).toMatchObject({ status: "compliant", clauseIds: ["c1"], clauseNumbers: [] });
  });

  describe("in a review of several windows", () => {
    let docx: Uint8Array;
    let clauses: Clause[];
    let maxContextTokens: number;

    beforeAll(async () => {
      docx = await padded(input);
      clauses = await clausesOf(docx);
      maxContextTokens = budgetFor(term, clauses, 3);
    });

    it("are believed in every window, each citing a clause it can see", async () => {
      const windows = expectedWindows(term, clauses, maxContextTokens);
      expect(windows.length).toBeGreaterThan(2);
      const result = await resultFor(docx, { term: { status: "compliant" } }, maxContextTokens);
      const cited = windows.map(
        (window) => (window.find((c) => c.number !== undefined) ?? window[0])!.id,
      );
      expect(result.status).toBe("compliant");
      expect(result.clauseIds).toEqual([...new Set(cited)]);
    });
  });
});
