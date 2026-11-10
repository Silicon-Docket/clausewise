import { describe, expect, it, vi } from "vitest";
import {
  DECISION_LABEL,
  FAILURE_LABEL,
  MODE_LABEL,
  MODE_WORDS,
  NOT_A_RECOMMENDATION,
  NOT_CLEAN,
  PROBLEM_ACTION,
  WHY_NOT_LABEL,
  draftPromotionRecord,
  type ComparisonSource,
} from "../../src/evaluations/index.js";
import { ForbiddenError } from "../../src/services/errors.js";
import { createEvaluationService } from "../../src/services/evaluations.js";
import { NotFoundError } from "../../src/store/errors.js";
import {
  CASE_KEY,
  PRINCIPALS,
  comparisonBody,
  comparisonPage,
  devSection,
  gateViews,
  heldoutBody,
  liveBody,
  sideFacts,
} from "./fixtures.js";
import { memorySource } from "./render.js";

/**
 * The evaluation service: what it refuses before it reads anything, what it counts, what it
 * selects from a query, and the words it carries to the page.
 */

const simulated = comparisonPage();
const withHeldout = comparisonPage(heldoutBody(), "heldout");

/** A source that counts how often it is asked anything. */
function counting(inner: ComparisonSource): ComparisonSource & { asked: () => number } {
  const list = vi.fn(inner.list);
  const get = vi.fn(inner.get);
  return { list, get, asked: () => list.mock.calls.length + get.mock.calls.length };
}

describe("the global role", () => {
  for (const who of ["engineer", "admin"] as const)
    it(`is enough for the ${who}: both functions answer`, () => {
      const service = createEvaluationService(memorySource([simulated]));
      expect(service.list(PRINCIPALS[who]).entries).toHaveLength(1);
      expect(service.comparison(PRINCIPALS[who], { id: simulated.id }).page.id).toBe(simulated.id);
    });

  it("is checked first: a member is refused before the source is asked anything", () => {
    const source = counting(memorySource([simulated]));
    const service = createEvaluationService(source);
    expect(() => service.list(PRINCIPALS.member)).toThrow(ForbiddenError);
    expect(() => service.comparison(PRINCIPALS.member, { id: simulated.id })).toThrow(
      ForbiddenError,
    );
    expect(() => service.comparison(PRINCIPALS.member, { id: "not an id" })).toThrow(
      ForbiddenError,
    );
    expect(source.asked()).toBe(0);
  });

  it("is read from the principal given, and names the global action in the refusal", () => {
    const service = createEvaluationService(memorySource([]));
    try {
      service.list(PRINCIPALS.member);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).action).toBe("evaluation.read");
    }
  });
});

describe("the list", () => {
  it("has an entry for each published page, with its workflows, modes, warnings and gate counts", () => {
    const live = comparisonPage(liveBody(), "live");
    const view = createEvaluationService(memorySource([simulated, live])).list(PRINCIPALS.engineer);
    expect(view.truncated).toBe(false);
    const [first, second] = view.entries;
    expect(first).toEqual({
      ok: true,
      id: simulated.id,
      publishedAt: "2026-11-05T09:30:00.000Z",
      baseline: { workflowLabel: "v1", mode: "simulated" },
      candidate: { workflowLabel: "v2", mode: "simulated" },
      warnings: [{ mode: "simulated", text: MODE_WORDS.simulated }],
      sections: [{ split: "dev", candidateGates: { pass: 8, fail: 1, notEvaluated: 5 } }],
    });
    expect(second).toMatchObject({ ok: true, warnings: [] });
  });

  it("counts a side's fourteen gates by outcome, so that the three counts add up to fourteen", () => {
    const body = comparisonBody({
      sections: [
        devSection({
          gates: {
            baseline: null,
            candidate: gateViews({
              G1: { outcome: "pass", detail: "ok" },
              G6: { outcome: "pass", detail: "ok" },
              G11: { outcome: "fail", detail: "no" },
            }),
          },
        }),
        devSection({ split: "heldout", gates: { baseline: null, candidate: null } }),
      ],
    });
    const page = comparisonPage(body, "counts");
    const entry = createEvaluationService(memorySource([page])).list(PRINCIPALS.admin).entries[0];
    if (entry === undefined || !entry.ok) throw new Error("fixture");
    const [dev, heldout] = entry.sections;
    expect(dev?.candidateGates).toEqual({ pass: 10, fail: 1, notEvaluated: 3 });
    const counts = dev?.candidateGates;
    expect((counts?.pass ?? 0) + (counts?.fail ?? 0) + (counts?.notEvaluated ?? 0)).toBe(14);
    expect(heldout?.candidateGates).toBeNull();
  });

  it("orders the warnings selftest, simulated, replay, once each, whichever side has which", () => {
    const page = comparisonPage(
      {
        sides: {
          baseline: sideFacts("v1", { mode: "replay" }),
          candidate: sideFacts("v2", { mode: "selftest" }),
        },
      },
      "order",
    );
    const entry = createEvaluationService(memorySource([page])).list(PRINCIPALS.admin).entries[0];
    expect(entry).toMatchObject({
      warnings: [
        { mode: "selftest", text: MODE_WORDS.selftest },
        { mode: "replay", text: MODE_WORDS.replay },
      ],
    });
  });

  it("gives a file that cannot be used its problem and what to do about it", () => {
    const source = memorySource([], [{ name: "cmp_aaaaaaaaaaaaaaaa.json", problem: "too_large" }]);
    const view = createEvaluationService(source).list(PRINCIPALS.admin);
    expect(view.entries).toEqual([
      {
        ok: false,
        name: "cmp_aaaaaaaaaaaaaaaa.json",
        problem: "too_large",
        action: PROBLEM_ACTION.too_large,
      },
    ]);
  });

  it("passes on whether the source left files out", () => {
    const inner = memorySource([simulated]);
    const source: ComparisonSource = {
      ...inner,
      list: () => ({ ...inner.list(), truncated: true }),
    };
    expect(createEvaluationService(source).list(PRINCIPALS.admin).truncated).toBe(true);
  });

  it("carries the words the page may not import, copied so that the page cannot change the originals", () => {
    const { labels } = createEvaluationService(memorySource([])).list(PRINCIPALS.admin);
    expect(labels.mode).toEqual(MODE_LABEL);
    expect(labels.decision).toEqual(DECISION_LABEL);
    expect(labels.failure).toEqual(FAILURE_LABEL);
    expect(labels.whyNot).toEqual(WHY_NOT_LABEL);
    expect(labels.notARecommendation).toBe(NOT_A_RECOMMENDATION);
    expect(labels.notClean).toBe(NOT_CLEAN);
    expect(labels.mode).not.toBe(MODE_LABEL);
    labels.mode.live = "changed";
    expect(MODE_LABEL.live).toBe("Live");
  });
});

describe("a comparison", () => {
  const service = createEvaluationService(memorySource([simulated, withHeldout]));
  const engineer = PRINCIPALS.engineer;

  it("is found by its id, with the time it was published, its warnings, its draft and the words", () => {
    const view = service.comparison(engineer, { id: simulated.id });
    expect(view.page).toEqual(simulated);
    expect(view.publishedAt).toBe("2026-11-05T09:30:00.000Z");
    expect(view.warnings).toEqual([{ mode: "simulated", text: MODE_WORDS.simulated }]);
    expect(view.split).toBe("dev");
    expect(view.section).toBe(simulated.sections[0]);
    expect(view.selected).toBeNull();
    expect(view.draft).toBe(draftPromotionRecord(simulated, "dev"));
    expect(view.labels.decision).toEqual(DECISION_LABEL);
  });

  it("is not found when its id is malformed, unknown, or the file cannot be read", () => {
    for (const id of [
      "",
      "../x",
      "cmp_0000000000000000",
      "CMP_0123456789abcdef",
      simulated.id + "0",
    ])
      expect(() => service.comparison(engineer, { id }), id).toThrow(NotFoundError);
    const unreadable = createEvaluationService(
      memorySource([], [{ name: `${simulated.id}.json`, problem: "fingerprint_mismatch" }]),
    );
    expect(() => unreadable.comparison(engineer, { id: simulated.id })).toThrow(NotFoundError);
    try {
      service.comparison(engineer, { id: "cmp_0000000000000000" });
      expect.unreachable();
    } catch (error) {
      expect((error as NotFoundError).entity).toBe("evaluation comparison");
      expect((error as Error).message).not.toContain("cmp_0000000000000000");
    }
  });

  it("selects the section asked for, and the first for a split the document does not hold", () => {
    expect(service.comparison(engineer, { id: withHeldout.id, split: "heldout" }).split).toBe(
      "heldout",
    );
    expect(service.comparison(engineer, { id: withHeldout.id, split: "dev" }).split).toBe("dev");
    for (const split of ["other", "", "DEV", "heldout "])
      expect(service.comparison(engineer, { id: withHeldout.id, split }).split, split).toBe("dev");
    expect(service.comparison(engineer, { id: simulated.id, split: "heldout" }).split).toBe("dev");
    const view = service.comparison(engineer, { id: withHeldout.id, split: "heldout" });
    expect(view.draft).toBe(draftPromotionRecord(withHeldout, "heldout"));
    expect(view.section.split).toBe("heldout");
  });

  it("selects a changed slot with the case's passages keyed by document and paragraph", () => {
    const view = service.comparison(engineer, {
      id: simulated.id,
      caseKey: CASE_KEY,
      ruleKey: "dur-1",
    });
    const selected = view.selected;
    if (selected === null || "missing" in selected) throw new Error("selected");
    expect(selected.change.ruleKey).toBe("dur-1");
    expect([...selected.passages.keys()].sort()).toEqual([
      "D1:19",
      "D1:21",
      "D2:3",
      "D2:4",
      "D2:5",
    ]);
    expect(selected.passages.get("D2:3")?.clauseNumber).toBe("2");
    expect(selected.documents.map((d) => d.label)).toEqual(["D1", "D2"]);
  });

  it("says a slot is missing when it is not a change of the shown section, or half a slot is given", () => {
    for (const query of [
      { caseKey: CASE_KEY, ruleKey: "gov-1" },
      { caseKey: "PAROL-D99", ruleKey: "dur-1" },
      { caseKey: CASE_KEY },
      { ruleKey: "dur-1" },
      { caseKey: "", ruleKey: "" },
    ])
      expect(
        service.comparison(engineer, { id: simulated.id, ...query }).selected,
        JSON.stringify(query),
      ).toEqual({
        missing: true,
      });
    // A slot of the dev section is not found in the held-out section, and the reverse.
    expect(
      service.comparison(engineer, {
        id: withHeldout.id,
        split: "heldout",
        caseKey: CASE_KEY,
        ruleKey: "dur-1",
      }).selected,
    ).toEqual({ missing: true });
  });

  it("selects a sealed slot without its passages", () => {
    const view = service.comparison(engineer, {
      id: withHeldout.id,
      split: "heldout",
      caseKey: "PAROL-H02",
      ruleKey: "dur-1",
    });
    const selected = view.selected;
    if (selected === null || "missing" in selected) throw new Error("selected");
    expect("sealed" in selected.change.trail).toBe(true);
    expect(selected.passages.size).toBe(0);
    expect(selected.documents).toEqual([]);
  });

  it("gives no passage for a sealed slot even when the document carries the text of its case", () => {
    // The seal is the builder's work. A document that holds the case of a sealed slot anyway
    // (a mistake, or a file made by hand) does not get it shown through this slot.
    const body = heldoutBody();
    body.cases["PAROL-H02"] = body.cases[CASE_KEY]!;
    const leaky = comparisonPage(body, "leaky");
    const view = createEvaluationService(memorySource([leaky])).comparison(engineer, {
      id: leaky.id,
      split: "heldout",
      caseKey: "PAROL-H02",
      ruleKey: "dur-1",
    });
    const selected = view.selected;
    if (selected === null || "missing" in selected) throw new Error("selected");
    expect(selected.passages.size).toBe(0);
    expect(selected.documents).toEqual([]);
  });

  it("keeps nothing of the query in the view beyond the choice it made", () => {
    const hostile = { id: simulated.id, caseKey: "<script>", ruleKey: "x\u202e" };
    const view = service.comparison(engineer, hostile);
    expect(
      JSON.stringify({ ...view, page: undefined, draft: undefined, section: undefined }),
    ).not.toContain("<script>");
    expect(view.selected).toEqual({ missing: true });
  });
});
