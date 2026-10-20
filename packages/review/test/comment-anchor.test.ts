import { createScriptedGenerator } from "@clausewise/llm/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { reviewContract } from "../src/pipeline.js";
import { renderMarkdown } from "../src/report.js";
import type { ReviewReport, RuleCheck } from "../src/types.js";
import {
  compliantAnswer,
  loadPlaybook,
  onlyRules,
  ruleIdOf,
  viewDocx,
} from "./pipeline-support.js";
import {
  LAW,
  NOTICE,
  TERM,
  buildDocument,
  buildScenario,
  resultOf,
  type Scenario,
} from "./redline-support.js";

// docs/m3-design.md section 2.1: every deviation and missing result says where its comment was
// written, so that a redline can be rebuilt later without the model.

let scenario: Scenario;

beforeAll(async () => {
  scenario = await buildScenario();
});

describe("commentAnchor on a review's results", () => {
  it("is the span of the tracked change for a finding that has one", () => {
    const spans: [string, string, string, string][] = [
      ["term", "p:1", TERM, "three years"],
      ["permitted-use", "p:2", NOTICE, "thirty days"],
      ["governing-law", "p:3", LAW, "Singapore"],
    ];
    for (const [ruleId, paragraphId, text, words] of spans) {
      const start = text.indexOf(words);
      const result = resultOf(scenario.report, ruleId);
      expect(result.commentAnchor, ruleId).toStrictEqual({
        paragraphId,
        start,
        end: start + words.length,
      });
      // It is the very span the edit holds.
      expect(result.edit, ruleId).toMatchObject({ kind: "applied", paragraphId, start });
    }
  });

  it("is the whole paragraph, with no start and no end, when the finding has no tracked change", () => {
    // A change the engine refused sits across a hyperlink, and a missing clause has none to make.
    expect(resultOf(scenario.report, "remedies").commentAnchor).toStrictEqual({
      paragraphId: "p:4",
    });
    // A missing clause goes on the first clause that has a number.
    expect(resultOf(scenario.report, "compelled-disclosure").commentAnchor).toStrictEqual({
      paragraphId: "p:1",
    });
  });

  it("is absent from a result that is not a deviation or a missing clause", () => {
    const compliant = resultOf(scenario.report, "exclusions");
    expect(compliant.status).toBe("compliant");
    expect("commentAnchor" in compliant).toBe(false);
  });

  it("is absent from a rule that did not apply and from one that could not be checked", async () => {
    const docx = await buildDocument();
    const playbook = onlyRules(loadPlaybook(), "return-or-destroy", "term", "exclusions");
    const { report } = await reviewContract(
      { docx, playbook },
      createScriptedGenerator((request): RuleCheck => {
        const ruleId = ruleIdOf(request);
        if (ruleId === "term") throw new Error("the model is down");
        if (ruleId === "return-or-destroy") {
          return compliantAnswer({ status: "not_applicable", clauseIds: [] });
        }
        return compliantAnswer();
      }),
    );
    expect(report.results.map((r) => r.status)).toEqual(["not_applicable", "error", "compliant"]);
    for (const result of report.results) {
      expect("commentAnchor" in result, result.ruleId).toBe(false);
    }
  });

  it("is where the comment is in the file the review returned", async () => {
    const view = await viewDocx(scenario.redlined);
    expect(view.comments).toHaveLength(5);
    for (const result of scenario.report.results) {
      const anchor = result.commentAnchor;
      if (anchor === undefined) continue;
      const index = Number(anchor.paragraphId.slice(2));
      const heading = `${result.severity.toUpperCase()}] ${result.title}\n`;
      const comment = view.comments.find((c) => c.text.includes(heading));
      expect(comment?.paragraph, result.ruleId).toBe(index);
      const text = view.paragraphs[index]?.rejected ?? "";
      const expected =
        anchor.start === undefined ? text : text.slice(anchor.start, anchor.end ?? text.length);
      expect(comment?.anchored, result.ruleId).toBe(expected);
    }
  });

  it("survives JSON, which is how a server keeps a report", () => {
    const stored = JSON.parse(JSON.stringify(scenario.report)) as ReviewReport;
    expect(stored).toEqual(scenario.report);
    expect(resultOf(stored, "term").commentAnchor).toEqual(
      resultOf(scenario.report, "term").commentAnchor,
    );
  });
});

describe("renderMarkdown with commentAnchor", () => {
  it("ignores it: the report reads the same with it as without", () => {
    const stripped = JSON.parse(JSON.stringify(scenario.report)) as ReviewReport;
    for (const result of stripped.results) delete result.commentAnchor;
    expect(stripped.results.some((r) => "commentAnchor" in r)).toBe(false);
    expect(renderMarkdown(scenario.report)).toBe(renderMarkdown(stripped));
  });

  it("does not print a paragraph id", () => {
    expect(renderMarkdown(scenario.report)).not.toMatch(/\bp:\d+\b/);
  });
});
