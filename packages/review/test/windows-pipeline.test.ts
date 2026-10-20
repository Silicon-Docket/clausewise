import type { GenerateObjectRequest, ObjectGenerator } from "@clausewise/llm";
import { describe, expect, it } from "vitest";
import { reviewContract } from "../src/pipeline.js";
import type { Clause, RuleCheck } from "../src/types.js";
import {
  budgetFor,
  clausesOf,
  expectedWindows,
  hasClause,
  loadPlaybook,
  longContract,
  onlyRules,
  viewDocx,
  type Request,
} from "./pipeline-support.js";

const playbook = onlyRules(loadPlaybook(), "term");
const DATE = new Date("2026-03-02T09:30:00Z");

const absent: RuleCheck = {
  status: "missing",
  clauseIds: [],
  explanation: "Nothing on duration in this part.",
  comment: "",
  edit: null,
  suggestedClause: null,
};

/** A model that answers by which clauses its window holds, as a real one would. */
function modelWhere(
  answers: { clause: string; answer: RuleCheck }[],
): ObjectGenerator & { readonly calls: Request[] } {
  const calls: Request[] = [];
  return {
    provider: "windows-test",
    model: "windows-test",
    disclosure: "a scripted test model (nothing is sent anywhere)",
    calls,
    async generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      calls.push(request as Request);
      const hit = answers.find(({ clause }) => hasClause(request as Request, clause));
      return (hit?.answer ?? absent) as T;
    },
  };
}

describe("a rule that deviates in two windows", () => {
  // Twelve clauses of a few hundred tokens each, in windows of about four.
  async function setup(): Promise<{ docx: Uint8Array; clauses: Clause[]; limit: number }> {
    const docx = await longContract(12, 1200);
    const clauses = await clausesOf(docx);
    return { docx, clauses, limit: budgetFor(playbook, clauses, 4) };
  }

  const windowsHolding = (windows: Clause[][], id: string): number[] =>
    windows.flatMap((window, i) => (window.some((c) => c.id === id) ? [i] : []));

  it("writes the edit under the comment that goes with it", async () => {
    const { docx, clauses, limit } = await setup();
    const windows = expectedWindows(playbook, clauses, limit);
    const early = windowsHolding(windows, "c2");
    const late = windowsHolding(windows, "c9");
    expect(early).toHaveLength(1);
    expect(late).toHaveLength(1);
    expect(early[0]).not.toBe(late[0]);

    // The first window decides that no single edit does the job. A later one, which cannot see
    // clause 2.1, proposes an edit for its own clause.
    const model = modelWhere([
      {
        clause: "c2",
        answer: {
          status: "deviation",
          clauseIds: ["c2"],
          explanation:
            "Clause 2.1 sets a perpetual term and so do others, all of them must change.",
          comment: "Change every perpetual term together.",
          edit: null,
          suggestedClause: null,
        },
      },
      {
        clause: "c9",
        answer: {
          status: "deviation",
          clauseIds: ["c9"],
          explanation: "Clause 9.1 is perpetual.",
          comment: "Make clause 9.1 a fixed term.",
          edit: { clauseId: "c9", quote: "Clause number 9.", replacement: "Clause 9 (3 years)." },
          suggestedClause: null,
        },
      },
    ]);
    const { report, redlined } = await reviewContract({ docx, playbook }, model, {
      maxContextTokens: limit,
      date: DATE,
    });

    expect(report.stats.windows).toBe(windows.length);
    const [term] = report.results;
    expect(term).toMatchObject({
      status: "deviation",
      clauseIds: ["c2", "c9"],
      explanation: "Clause 9.1 is perpetual.",
      edit: { kind: "applied", paragraphId: "p:8" },
    });

    const { comments } = await viewDocx(redlined);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.paragraph).toBe(8);
    expect(comments[0]?.text).toContain("Make clause 9.1 a fixed term.");
    expect(comments[0]?.text).not.toContain("2.1");
  });

  it("keeps the first window's comment when no window proposes an edit", async () => {
    const { docx, limit } = await setup();
    const model = modelWhere([
      {
        clause: "c2",
        answer: {
          status: "deviation",
          clauseIds: ["c2"],
          explanation: "Clause 2.1 is perpetual.",
          comment: "Fix clause 2.1.",
          edit: null,
          suggestedClause: null,
        },
      },
      {
        clause: "c9",
        answer: {
          status: "deviation",
          clauseIds: ["c9"],
          explanation: "Clause 9.1 is perpetual.",
          comment: "Fix clause 9.1.",
          edit: null,
          suggestedClause: null,
        },
      },
    ]);
    const { report, redlined } = await reviewContract({ docx, playbook }, model, {
      maxContextTokens: limit,
      date: DATE,
    });
    expect(report.results[0]).toMatchObject({
      status: "deviation",
      clauseIds: ["c2", "c9"],
      explanation: "Clause 2.1 is perpetual.",
      edit: { kind: "none" },
    });
    const { comments } = await viewDocx(redlined);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.paragraph).toBe(1);
    expect(comments[0]?.text).toContain("Fix clause 2.1.");
  });
});
