import { describe, expect, it } from "vitest";
import type { IngestOutput } from "../../src/contracts.js";
import { orderOf, parseStatedDate, targetsClause } from "../../src/stages/checks/precedence.js";
import {
  D1_TERM,
  QUOTE_DELETE,
  QUOTE_SURVIVAL,
  QUOTE_TERM,
  check,
  cite,
  codes,
  define,
  draft,
  idOf,
  ingestOf,
  manifest,
  reference,
  verify,
  workedExample,
} from "./support-verify.js";

const ingest = workedExample();
const bundleAll = ["D1-p19", "D1-p6", "D1-p29", "D2-p3"];

const withVerb = (
  base: IngestOutput,
  label: { doc: "D1" | "D2"; paragraph: number },
  verb: "replaces" | "amends" | "deletes" | "refers",
  target?: string,
): IngestOutput => ({
  ...base,
  annotations: base.annotations.map((a) =>
    a.kind === "cross_reference" && a.spanId === idOf(label.doc, label.paragraph)
      ? { ...a, verb, ...(target === undefined ? {} : { target }) }
      : a,
  ),
});

const superseded = (extra: Partial<ReturnType<typeof draft>> = {}) =>
  draft({
    status: "deviation",
    evidence: [
      cite(ingest, "D2-p3", QUOTE_DELETE, "governing"),
      cite(ingest, "D1-p19", QUOTE_TERM, "superseded"),
      cite(ingest, "D1-p29", QUOTE_SURVIVAL, "supporting"),
    ],
    ...extra,
  });

describe("precedence_labels: a span labelled superseded", () => {
  it("passes when a cited amendment span deletes its clause, and raises nothing under C1 or C2", async () => {
    for (const enabledChecks of [["C1"], ["C1", "C2"]]) {
      const { finding } = await verify(superseded(), { bundleLabels: bundleAll, enabledChecks });
      expect(check(finding, "precedence_labels").outcome).toBe("pass");
      expect(codes(finding)).toEqual([]);
    }
  });

  it("fails when no amendment span is cited", async () => {
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [
          cite(ingest, "D1-p19", QUOTE_TERM, "superseded"),
          cite(ingest, "D1-p29", QUOTE_SURVIVAL, "supporting"),
        ],
      }),
    );
    expect(check(finding, "precedence_labels").outcome).toBe("fail");
    expect(finding.escalations).toEqual([
      {
        code: "superseded_evidence",
        detail:
          "evidence 1 (D1-p19) is labelled superseded but no cited amendment span amends, replaces or deletes clause 6.1",
      },
    ]);
    expect(finding.status).toBe("deviation");
  });

  it("fails when the cited amendment changes a different clause", async () => {
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [
          cite(ingest, "D2-p3", QUOTE_DELETE, "governing"),
          cite(ingest, "D1-p29", QUOTE_SURVIVAL, "superseded"),
        ],
      }),
      { bundleLabels: bundleAll },
    );
    expect(finding.escalations.map((e) => e.detail)).toEqual([
      "evidence 2 (D1-p29) is labelled superseded but no cited amendment span amends, replaces or deletes clause 9.3",
    ]);
  });

  it("fails when the amendment only refers to the clause", async () => {
    const referring = withVerb(ingest, { doc: "D2", paragraph: 3 }, "refers");
    const { finding } = await verify(superseded(), {
      ingest: referring,
      bundleLabels: bundleAll,
    });
    expect(codes(finding)).toEqual(["superseded_evidence"]);
  });

  it.each(["deletes", "replaces", "amends"] as const)(
    "accepts an amendment that %s",
    async (verb) => {
      const changed = withVerb(ingest, { doc: "D2", paragraph: 3 }, verb);
      const { finding } = await verify(superseded(), { ingest: changed, bundleLabels: bundleAll });
      expect(codes(finding)).toEqual([]);
    },
  );

  it("fails a superseded label on a span with no clause number", async () => {
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [
          cite(ingest, "D2-p3", QUOTE_DELETE, "governing"),
          cite(ingest, "D1-p19", QUOTE_TERM, "supporting"),
          cite(ingest, "D2-p1", "made as of 15 September 2026 between", "superseded"),
        ],
      }),
      { bundleLabels: [...bundleAll, "D2-p1"] },
    );
    expect(finding.escalations.map((e) => e.detail)).toContain(
      "evidence 3 (D2-p1) is labelled superseded but has no clause number for an amendment to change",
    );
  });

  describe("clause numbers", () => {
    it("lets a reference to a parent clause reach its children", async () => {
      const parent = withVerb(ingest, { doc: "D2", paragraph: 3 }, "deletes", "6");
      const { finding } = await verify(superseded(), { ingest: parent, bundleLabels: bundleAll });
      expect(codes(finding)).toEqual([]);
    });

    it("does not let a reference to a child reach its parent, or a longer number reach a shorter", async () => {
      for (const target of ["6.1.1", "6.10", "61", "7"]) {
        const other = withVerb(ingest, { doc: "D2", paragraph: 3 }, "deletes", target);
        const { finding } = await verify(superseded(), { ingest: other, bundleLabels: bundleAll });
        expect(codes(finding), target).toEqual(["superseded_evidence"]);
      }
    });
  });

  describe("stated dates", () => {
    const run = (dates: Parameters<typeof manifest>[0]) =>
      verify(superseded(), { bundleLabels: bundleAll, manifest: manifest(dates) });

    it("passes an amendment dated later and one dated the same day", async () => {
      expect(codes((await run({})).finding)).toEqual([]);
      const same = await run({ dates: { D1: "2026-09-15", D2: "2026-09-15" } });
      expect(codes(same.finding)).toEqual([]);
    });

    it("fails an amendment dated before the NDA", async () => {
      const { finding } = await run({ dates: { D2: "2026-01-31" } });
      expect(finding.escalations).toEqual([
        {
          code: "superseded_evidence",
          detail:
            "evidence 2 (D1-p19) is labelled superseded but the amendment that changes it is dated before D1",
        },
      ]);
    });

    // The analysis prompt (rule 4a) says that when either date is not given the rule cannot be
    // applied and the passages conflict. The check used to take such an amendment as later and
    // print "Passed", which told the reviewer the opposite of what the model had been told.
    it.each([
      ["the amendment", { D2: null }],
      ["the NDA", { D1: null }],
      ["an amendment date nobody can read", { D2: "15 September 2026" }],
      ["an impossible date", { D2: "2026-13-45" }],
    ])(
      "raises conflicting_sources, and so forces undetermined, when the date of %s is missing",
      async (_, dates) => {
        const { finding } = await run({ dates });
        expect(finding.escalations).toEqual([
          {
            code: "conflicting_sources",
            detail:
              "evidence 2 (D1-p19) is labelled superseded by an amendment, but a stated date is missing for D1 or D2, so the documents do not say which governs",
          },
        ]);
        expect(check(finding, "precedence_labels").outcome).toBe("fail");
        expect(finding.status).toBe("undetermined");
        expect(finding.verificationState).toBe("escalated_by_system");
      },
    );
  });
});

describe("precedence_labels: two governing spans", () => {
  it("fails a governing NDA span cited with a governing amendment span that changes its clause", async () => {
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [
          cite(ingest, "D1-p19", QUOTE_TERM, "governing"),
          cite(ingest, "D2-p3", QUOTE_DELETE, "governing"),
        ],
      }),
      { bundleLabels: bundleAll },
    );
    expect(finding.escalations).toEqual([
      {
        code: "superseded_evidence",
        detail:
          "evidence 1 (D1-p19) and evidence 2 (D2-p3) are both labelled governing, but the second changes clause 6.1; the first should be labelled superseded",
      },
    ]);
    expect(finding.status).toBe("deviation");
  });

  // The amendment that changes the clause is what supersedes it, whatever label the model gave the
  // amendment. A model that cites the deleting amendment as "supporting" or "definition" and keeps
  // the deleted clause "governing" has not recognised the amendment as governing.
  it.each(["supporting", "definition", "conflicting"] as const)(
    "fails a governing NDA span cited with an amendment span labelled %s that changes its clause",
    async (role) => {
      for (const enabledChecks of [["C1"], ["C1", "C2"]]) {
        const { finding } = await verify(
          draft({
            status: "compliant",
            evidence: [
              cite(ingest, "D1-p19", QUOTE_TERM, "governing"),
              cite(ingest, "D2-p3", QUOTE_DELETE, role),
            ],
            explanation: "The term is within the three-year standard.",
          }),
          { bundleLabels: bundleAll, enabledChecks },
        );
        expect(finding.verificationState, role).toBe("escalated_by_system");
        expect(finding.escalations.map((e) => e.detail)).toContain(
          `evidence 1 (D1-p19) is labelled governing, but evidence 2 (D2-p3), labelled ${role}, changes clause 6.1; the first should be labelled superseded`,
        );
        expect(check(finding, "precedence_labels").outcome).toBe("fail");
      }
    },
  );

  it("leaves an amendment span labelled superseded to the label check, so one mistake is one escalation", async () => {
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [
          cite(ingest, "D1-p19", QUOTE_TERM, "governing"),
          cite(ingest, "D2-p3", QUOTE_DELETE, "superseded"),
        ],
      }),
      { bundleLabels: bundleAll },
    );
    expect(finding.escalations.map((e) => e.detail)).toEqual([
      "evidence 2 (D2-p3) is labelled superseded but no cited amendment span amends, replaces or deletes clause 2",
    ]);
  });

  it("accepts a governing NDA span when the amendment that deleted its clause is itself deleted by a later one", async () => {
    // D2 deletes Section 6.1 and D3 deletes Section 2 of Amendment No. 1, which is D2's deletion.
    const undone = ingestOf(
      [
        {
          doc: "D1",
          paragraph: 5,
          text: "6.1 The obligations continue for two (2) years.",
          clause: "6.1",
        },
        {
          doc: "D2",
          paragraph: 3,
          text: "2. Section 6.1 of the Agreement is deleted in its entirety.",
          clause: "2",
        },
        {
          doc: "D3",
          paragraph: 3,
          text: "1. Section 2 of Amendment No. 1 is deleted in its entirety.",
          clause: "1",
        },
      ],
      [
        define("D1", 5, "Agreement"),
        reference("D2", 3, "6.1", "deletes"),
        reference("D3", 3, "2", "deletes"),
      ],
    );
    const { finding } = await verify(
      draft({
        status: "compliant",
        evidence: [
          cite(undone, "D1-p5", "continue for two (2) years", "governing"),
          cite(undone, "D2-p3", "Section 6.1 of the Agreement is deleted", "superseded"),
          cite(undone, "D3-p3", "Section 2 of Amendment No. 1 is deleted", "governing"),
        ],
      }),
      { ingest: undone, bundleLabels: ["D1-p5", "D2-p3", "D3-p3"], enabledChecks: ["C1", "C2"] },
    );
    expect(codes(finding)).toEqual([]);
  });

  it("does not fail a governing NDA span beside an amendment span in another role that changes a different clause", async () => {
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [
          cite(ingest, "D1-p19", QUOTE_TERM, "governing"),
          cite(ingest, "D2-p4", "Section 7.2 of the Agreement is amended", "supporting"),
        ],
      }),
      { bundleLabels: [...bundleAll, "D2-p4"] },
    );
    expect(check(finding, "precedence_labels").outcome).toBe("pass");
    expect(codes(finding)).toEqual([]);
  });

  it("does not fail an NDA span beside an amendment span that is dated before the NDA and only refers to it", async () => {
    const referring = withVerb(ingest, { doc: "D2", paragraph: 3 }, "refers");
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [
          cite(ingest, "D1-p19", QUOTE_TERM, "governing"),
          cite(ingest, "D2-p3", QUOTE_DELETE, "supporting"),
        ],
      }),
      { ingest: referring, bundleLabels: bundleAll },
    );
    expect(check(finding, "precedence_labels").outcome).toBe("pass");
  });

  it("does not fail an NDA span labelled supporting beside the amendment that changes it", async () => {
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [
          cite(ingest, "D1-p19", QUOTE_TERM, "supporting"),
          cite(ingest, "D2-p3", QUOTE_DELETE, "governing"),
        ],
      }),
      { bundleLabels: bundleAll },
    );
    expect(codes(finding)).toEqual([]);
  });

  it("does not fail two governing spans in the NDA, or an amendment span that changes another clause", async () => {
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [
          cite(ingest, "D1-p19", QUOTE_TERM, "governing"),
          cite(ingest, "D1-p29", QUOTE_SURVIVAL, "governing"),
        ],
      }),
    );
    expect(check(finding, "precedence_labels").outcome).toBe("pass");
  });
});

describe("precedence_labels: amendments against amendments", () => {
  // D2 replaces Section 6.1 and D3 deletes it. Both are amendments of the same NDA.
  const run3 = ingestOf(
    [
      {
        doc: "D1",
        paragraph: 5,
        text: "6.1 The obligations continue for two (2) years.",
        clause: "6.1",
      },
      {
        doc: "D2",
        paragraph: 3,
        text: "2. Section 6.1 is replaced by a new Section 6.1 with a longer term.",
        clause: "2",
      },
      {
        doc: "D3",
        paragraph: 3,
        text: "1. Section 6.1 of the Agreement is deleted in its entirety.",
        clause: "1",
      },
    ],
    [
      define("D1", 5, "Agreement"),
      reference("D2", 3, "6.1", "replaces"),
      reference("D3", 3, "6.1", "deletes"),
    ],
  );
  const QUOTE_D2 = "Section 6.1 is replaced by a new Section 6.1";
  const QUOTE_D3 = "Section 6.1 of the Agreement is deleted in its entirety";
  const dates = (d2: string | null, d3: string | null) => manifest({ dates: { D2: d2, D3: d3 } });
  const run = (
    roles: ["governing" | "superseded", "governing" | "superseded"],
    d2: string | null,
    d3: string | null,
  ) =>
    verify(
      draft({
        status: "deviation",
        evidence: [
          cite(run3, "D2-p3", QUOTE_D2, roles[0]),
          cite(run3, "D3-p3", QUOTE_D3, roles[1]),
          cite(run3, "D1-p5", "continue for two (2) years", "supporting"),
        ],
      }),
      { ingest: run3, bundleLabels: ["D1-p5", "D2-p3", "D3-p3"], manifest: dates(d2, d3) },
    );

  it("lets the later amendment govern and the earlier be superseded", async () => {
    const { finding } = await run(["superseded", "governing"], "2026-05-01", "2026-09-01");
    expect(codes(finding)).toEqual([]);
    expect(check(finding, "precedence_labels").outcome).toBe("pass");
  });

  it("fails the earlier amendment labelled governing beside a later one that changes the same clause", async () => {
    const { finding } = await run(["governing", "governing"], "2026-05-01", "2026-09-01");
    expect(codes(finding)).toEqual(["superseded_evidence"]);
    expect(finding.escalations[0]!.detail).toContain(
      "the first is superseded by the later amendment",
    );
  });

  it("names the second when the second is the earlier amendment", async () => {
    const { finding } = await run(["governing", "governing"], "2026-09-01", "2026-05-01");
    expect(codes(finding)).toEqual(["superseded_evidence"]);
    expect(finding.escalations[0]!.detail).toContain(
      "the second is superseded by the later amendment",
    );
  });

  it.each([
    ["equal dates", "2026-05-01", "2026-05-01"],
    ["a missing date", "2026-05-01", null],
    ["two missing dates", null, null],
  ])("raises conflicting_sources for %s, and so forces undetermined", async (_, d2, d3) => {
    const { finding } = await run(["governing", "governing"], d2, d3);
    expect(codes(finding)).toEqual(["conflicting_sources"]);
    expect(finding.escalations[0]!.detail).toContain("their stated dates do not say which governs");
    expect(finding.status).toBe("undetermined");
  });

  describe("a governing amendment span and a later amendment span in another role", () => {
    const withRole = (role: "supporting" | "definition") =>
      verify(
        draft({
          status: "deviation",
          evidence: [
            cite(run3, "D2-p3", QUOTE_D2, "governing"),
            cite(run3, "D3-p3", QUOTE_D3, role),
            cite(run3, "D1-p5", "continue for two (2) years", "supporting"),
          ],
        }),
        {
          ingest: run3,
          bundleLabels: ["D1-p5", "D2-p3", "D3-p3"],
          manifest: dates("2026-05-01", "2026-09-01"),
        },
      );

    it.each(["supporting", "definition"] as const)(
      "fails the earlier amendment labelled governing when the later one is labelled %s",
      async (role) => {
        const { finding } = await withRole(role);
        expect(finding.escalations).toEqual([
          {
            code: "superseded_evidence",
            detail: `evidence 1 (D2-p3) is labelled governing, but evidence 2 (D3-p3), labelled ${role}, changes the same clause; the first should be labelled superseded`,
          },
        ]);
      },
    );

    it("does not fail when the later amendment span changes a different clause", async () => {
      const elsewhere = ingestOf(
        [
          {
            doc: "D1",
            paragraph: 5,
            text: "6.1 The obligations continue for two (2) years.",
            clause: "6.1",
          },
          {
            doc: "D2",
            paragraph: 3,
            text: "2. Section 6.1 is replaced by a term of five (5) years.",
            clause: "2",
          },
          {
            doc: "D3",
            paragraph: 3,
            text: "1. Section 7.2 is deleted in its entirety.",
            clause: "1",
          },
        ],
        [reference("D2", 3, "6.1", "replaces"), reference("D3", 3, "7.2", "deletes")],
      );
      const { finding } = await verify(
        draft({
          status: "deviation",
          evidence: [
            cite(
              elsewhere,
              "D2-p3",
              "Section 6.1 is replaced by a term of five (5) years",
              "governing",
            ),
            cite(elsewhere, "D3-p3", "Section 7.2 is deleted in its entirety", "supporting"),
          ],
        }),
        {
          ingest: elsewhere,
          bundleLabels: ["D1-p5", "D2-p3", "D3-p3"],
          manifest: dates("2026-05-01", "2026-09-01"),
        },
      );
      expect(codes(finding)).toEqual([]);
    });
  });

  it("does not accept a superseded label when the two amendments cannot be ordered", async () => {
    const { finding } = await run(["superseded", "governing"], "2026-05-01", "2026-05-01");
    expect(codes(finding)).toEqual(["conflicting_sources"]);
    expect(finding.escalations[0]!.detail).toContain("does not put it after D2");
  });

  it("does not accept a superseded label when the other amendment is the earlier one", async () => {
    const { finding } = await run(["superseded", "governing"], "2026-09-01", "2026-05-01");
    expect(codes(finding)).toEqual(["superseded_evidence"]);
    expect(finding.escalations[0]!.detail).toContain("is dated before D2");
  });
});

describe("precedence_labels: a conflict the analysis reports", () => {
  it("raises conflicting_sources for a conflicting role, naming the passage and not quoting it", async () => {
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [
          cite(ingest, "D1-p19", QUOTE_TERM, "conflicting"),
          cite(ingest, "D1-p29", QUOTE_SURVIVAL, "conflicting"),
          cite(ingest, "D1-p6", "means non-public information disclosed by a Party", "supporting"),
        ],
      }),
    );
    expect(finding.escalations).toEqual([
      {
        code: "conflicting_sources",
        detail: "labelled conflicting: evidence 1 (D1-p19) and evidence 2 (D1-p29)",
      },
    ]);
    expect(finding.status).toBe("undetermined");
  });

  it("raises it for a conflict the analysis described, without copying the description", async () => {
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [cite(ingest, "D1-p19", QUOTE_TERM, "governing")],
        conflict: "Section 6.1 says two years while the schedule says five.",
      }),
    );
    expect(finding.escalations).toEqual([
      {
        code: "conflicting_sources",
        detail: "the analysis described a conflict between passages",
      },
    ]);
    expect(finding.conflict).toBe("Section 6.1 says two years while the schedule says five.");
  });

  it("raises one escalation when both are present", async () => {
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [
          cite(ingest, "D1-p19", QUOTE_TERM, "conflicting"),
          cite(ingest, "D1-p29", QUOTE_SURVIVAL, "supporting"),
        ],
        conflict: "They disagree.",
      }),
    );
    expect(finding.escalations).toEqual([
      {
        code: "conflicting_sources",
        detail:
          "labelled conflicting: evidence 1 (D1-p19); the analysis described a conflict between passages",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------------------------

describe("C2: superseded_evidence", () => {
  const c2 = ["C2"];
  const baseline = (role: "governing" | "supporting" | "superseded" | "definition" = "governing") =>
    draft({
      status: "deviation",
      evidence: [
        cite(ingest, "D1-p19", QUOTE_TERM, role),
        cite(ingest, "D1-p29", QUOTE_SURVIVAL, "supporting"),
      ],
    });

  it("flags governing and supporting evidence that an uncited later amendment deletes", async () => {
    for (const role of ["governing", "supporting"] as const) {
      const { finding } = await verify(baseline(role), { enabledChecks: c2 });
      expect(finding.escalations, role).toEqual([
        {
          code: "superseded_evidence",
          detail:
            "evidence 1 (D1-p19), clause 6.1, is changed by D2-p3 (deletes), which the finding does not cite",
        },
      ]);
      expect(check(finding, "superseded_evidence").outcome).toBe("fail");
    }
  });

  it("flags it whether or not the amendment was in the bundle", async () => {
    for (const bundleLabels of [["D1-p19", "D1-p29"], bundleAll]) {
      const { finding } = await verify(baseline(), { enabledChecks: c2, bundleLabels });
      expect(codes(finding)).toEqual(["superseded_evidence"]);
    }
  });

  it("passes when the finding cites the amendment span", async () => {
    const { finding } = await verify(superseded(), {
      enabledChecks: c2,
      bundleLabels: bundleAll,
    });
    expect(check(finding, "superseded_evidence").outcome).toBe("pass");
    expect(codes(finding)).toEqual([]);
  });

  it("passes when the amendment span is cited in any role", async () => {
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [
          cite(ingest, "D1-p19", QUOTE_TERM, "governing"),
          cite(ingest, "D2-p3", QUOTE_DELETE, "supporting"),
        ],
      }),
      { enabledChecks: c2, bundleLabels: bundleAll },
    );
    expect(codes(finding)).toEqual([]);
  });

  it("does not flag evidence labelled superseded or definition, which is already treated as such", async () => {
    for (const role of ["superseded", "definition"] as const) {
      const { finding } = await verify(baseline(role), { enabledChecks: c2 });
      expect(codes(finding), role).toEqual([]);
    }
  });

  it("flags an amendment that amends a clause, as well as one that deletes or replaces it", async () => {
    const withReturn = ingest;
    const ret = await verify(
      draft({
        status: "deviation",
        evidence: [
          cite(
            withReturn,
            "D1-p23",
            "Within ten (10) business days after the Disclosing Party's written request",
            "governing",
          ),
        ],
      }),
      { enabledChecks: c2, bundleLabels: ["D1-p23"] },
    );
    expect(ret.finding.escalations[0]!.detail).toBe(
      "evidence 1 (D1-p23), clause 7.2, is changed by D2-p4 (amends), which the finding does not cite",
    );
    const replaced = withVerb(ingest, { doc: "D2", paragraph: 3 }, "replaces");
    const rep = await verify(baseline(), { enabledChecks: c2, ingest: replaced });
    expect(rep.finding.escalations[0]!.detail).toContain("D2-p3 (replaces)");
  });

  it("does not flag a clause that an amendment merely refers to", async () => {
    const referring = withVerb(ingest, { doc: "D2", paragraph: 3 }, "refers");
    const { finding } = await verify(baseline(), { enabledChecks: c2, ingest: referring });
    expect(codes(finding)).toEqual([]);
  });

  it("reaches a child clause through a reference to its parent, and not the reverse", async () => {
    const parent = withVerb(ingest, { doc: "D2", paragraph: 3 }, "deletes", "6");
    expect(
      codes((await verify(baseline(), { enabledChecks: c2, ingest: parent })).finding),
    ).toEqual(["superseded_evidence"]);
    const child = withVerb(ingest, { doc: "D2", paragraph: 3 }, "deletes", "6.1.1");
    expect(codes((await verify(baseline(), { enabledChecks: c2, ingest: child })).finding)).toEqual(
      [],
    );
  });

  it("ignores an amendment dated before the document it would change, and not one with no date", async () => {
    const early = await verify(baseline(), {
      enabledChecks: c2,
      manifest: manifest({ dates: { D2: "2026-01-01" } }),
    });
    expect(codes(early.finding)).toEqual([]);
    const undated = await verify(baseline(), {
      enabledChecks: c2,
      manifest: manifest({ dates: { D2: null } }),
    });
    expect(codes(undated.finding)).toEqual(["superseded_evidence"]);
  });

  it("flags an amendment of a clause of an earlier amendment", async () => {
    const stacked = ingestOf(
      [
        {
          doc: "D1",
          paragraph: 5,
          text: "6.1 The obligations continue for two (2) years.",
          clause: "6.1",
        },
        {
          doc: "D2",
          paragraph: 3,
          text: "2. Section 6.1 is replaced by a term of five (5) years.",
          clause: "2",
        },
        {
          doc: "D3",
          paragraph: 3,
          text: "1. Section 2 of Amendment No. 1 is deleted in its entirety.",
          clause: "1",
        },
      ],
      [reference("D2", 3, "6.1", "replaces"), reference("D3", 3, "2", "deletes")],
    );
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [cite(stacked, "D2-p3", "replaced by a term of five (5) years", "governing")],
      }),
      { enabledChecks: c2, ingest: stacked, bundleLabels: ["D2-p3"] },
    );
    expect(finding.escalations[0]!.detail).toBe(
      "evidence 1 (D2-p3), clause 2, is changed by D3-p3 (deletes), which the finding does not cite",
    );
  });

  describe("a cited amendment span and an amendment that changes the NDA clause it acts on", () => {
    // D2 deletes Section 6.1 and D3 restates it. D2 numbers its own clauses 1, 2 and 3 and D3 its
    // own 1, 2 and 3; a reference in either to "Section 6.1" is to the NDA, and the number of the
    // amendment's own clause has nothing to do with it.
    const stacked = (
      d3: string,
      op: Parameters<typeof reference>[3] = "replaces",
      target = "6.1",
    ) =>
      ingestOf(
        [
          {
            doc: "D1",
            paragraph: 5,
            text: "6.1 The obligations continue for two (2) years.",
            clause: "6.1",
          },
          {
            doc: "D2",
            paragraph: 3,
            text: "2. Section 6.1 of the Agreement is deleted in its entirety.",
            clause: "2",
          },
          { doc: "D3", paragraph: 3, text: d3, clause: "1" },
        ],
        [
          define("D1", 5, "Agreement"),
          reference("D2", 3, "6.1", "deletes"),
          reference("D3", 3, target, op),
        ],
      );
    const D3_RESTATES =
      "1. Section 6.1 of the Agreement is restated to read: the obligations continue for five (5) years.";
    const finding = (
      run: IngestOutput,
      enabledChecks: string[],
      dates: Parameters<typeof manifest>[0] = {},
    ) =>
      verify(
        draft({
          status: "deviation",
          evidence: [
            cite(
              run,
              "D2-p3",
              "Section 6.1 of the Agreement is deleted in its entirety",
              "governing",
            ),
            cite(run, "D1-p5", "continue for two (2) years", "superseded"),
          ],
          discrepancy: "The obligations have no stated end.",
        }),
        { ingest: run, bundleLabels: ["D1-p5", "D2-p3"], enabledChecks, manifest: manifest(dates) },
      ).then((r) => r.finding);

    it("flags the cited amendment span when a later uncited amendment restates the same NDA clause", async () => {
      const run = stacked(D3_RESTATES);
      const c1 = await finding(run, ["C1"]);
      expect(codes(c1)).toEqual([]);
      const both = await finding(run, ["C1", "C2"]);
      expect(both.escalations).toEqual([
        {
          code: "superseded_evidence",
          detail:
            "evidence 1 (D2-p3), which acts on clause 6.1, is changed by D3-p3 (replaces), which the finding does not cite",
        },
      ]);
      expect(check(both, "superseded_evidence").outcome).toBe("fail");
    });

    it("reaches it through a parent clause, and ignores an amendment dated before the cited one", async () => {
      const parent = stacked("1. Section 6 of the Agreement is restated.", "replaces", "6");
      expect(codes(await finding(parent, ["C2"]))).toEqual(["superseded_evidence"]);
      expect(
        codes(await finding(stacked(D3_RESTATES), ["C2"], { dates: { D3: "2026-01-01" } })),
      ).toEqual([]);
    });

    it("does not flag it when the later amendment changes another clause of the NDA", async () => {
      const other = stacked("1. Section 7.2 of the Agreement is restated.", "replaces", "7.2");
      expect(codes(await finding(other, ["C2"]))).toEqual([]);
    });

    it("does not flag it when the later amendment only refers to the clause", async () => {
      const refers = stacked("1. Section 6.1 of the Agreement is noted.", "refers");
      expect(codes(await finding(refers, ["C2"]))).toEqual([]);
    });

    it("names the amendment span and the NDA clause, and holds no text of either", async () => {
      const both = await finding(stacked(D3_RESTATES), ["C2"]);
      expect(JSON.stringify([both.checks, both.escalations])).not.toContain("restated");
    });
  });

  it("ignores an operation inside the span's own document, and an operation in the NDA", async () => {
    const own = ingestOf(
      [
        {
          doc: "D1",
          paragraph: 5,
          text: "6.1 The obligations continue for two (2) years.",
          clause: "6.1",
        },
        {
          doc: "D1",
          paragraph: 6,
          text: "6.2 Section 6.1 is deleted when the term ends early.",
          clause: "6.2",
        },
        {
          doc: "D2",
          paragraph: 3,
          text: "2. The parties meet in March to review the term.",
          clause: "2",
        },
        {
          doc: "D2",
          paragraph: 4,
          text: "3. Section 2 of this Amendment is amended as agreed.",
          clause: "3",
        },
      ],
      [reference("D1", 6, "6.1", "deletes"), reference("D2", 4, "2", "amends")],
    );
    const nda = await verify(
      draft({
        status: "deviation",
        evidence: [cite(own, "D1-p5", "continue for two (2) years", "governing")],
      }),
      { enabledChecks: c2, ingest: own, bundleLabels: ["D1-p5"] },
    );
    expect(codes(nda.finding)).toEqual([]);
    const sameDocument = await verify(
      draft({
        status: "deviation",
        evidence: [cite(own, "D2-p3", "meet in March to review the term", "governing")],
      }),
      { enabledChecks: c2, ingest: own, bundleLabels: ["D2-p3"] },
    );
    expect(codes(sameDocument.finding)).toEqual([]);
  });

  it("is not applicable when no cited governing or supporting span has a clause number", async () => {
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [cite(ingest, "D1-p0", "MUTUAL NONDISCLOSURE AGREEMENT", "governing")],
      }),
      { enabledChecks: c2, bundleLabels: ["D1-p0"] },
    );
    expect(check(finding, "superseded_evidence")).toMatchObject({
      outcome: "not_applicable",
      detail: "no cited governing or supporting span has a clause number",
    });
  });

  it("names a few amendment spans and counts the rest", async () => {
    const many = ingestOf(
      [
        {
          doc: "D1",
          paragraph: 5,
          text: "6.1 The obligations continue for two (2) years.",
          clause: "6.1",
        },
        ...Array.from({ length: 8 }, (_, i) => ({
          doc: "D2" as const,
          paragraph: i + 1,
          text: `${i + 1}. Section 6.1 is amended in respect ${i + 1}.`,
          clause: String(i + 1),
        })),
      ],
      Array.from({ length: 8 }, (_, i) => reference("D2", i + 1, "6.1", "amends")),
    );
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [cite(many, "D1-p5", "continue for two (2) years", "governing")],
      }),
      { enabledChecks: c2, ingest: many, bundleLabels: ["D1-p5"] },
    );
    expect(finding.escalations).toHaveLength(1);
    expect(finding.escalations[0]!.detail).toBe(
      "evidence 1 (D1-p5), clause 6.1, is changed by D2-p1 (amends), D2-p2 (amends), D2-p3 (amends), D2-p4 (amends), D2-p5 (amends) and 3 more, which the finding does not cite",
    );
  });

  it("holds no document text in its details", async () => {
    const { finding } = await verify(baseline(), { enabledChecks: c2 });
    const text = JSON.stringify([finding.checks, finding.escalations]);
    expect(text).not.toContain(D1_TERM.slice(4, 40));
    expect(text).not.toContain("deleted in its entirety");
  });
});

describe("clause numbers, dates and the order of documents", () => {
  it("reaches a clause and everything under it, and nothing that only shares its digits", () => {
    expect(targetsClause("6.1", "6.1")).toBe(true);
    expect(targetsClause("6", "6.1")).toBe(true);
    expect(targetsClause("6", "6.10")).toBe(true);
    expect(targetsClause("6.1", "6.1.2")).toBe(true);
    expect(targetsClause("1", "10")).toBe(false);
    expect(targetsClause("1", "1A")).toBe(false);
    expect(targetsClause("6.1", "6.10")).toBe(false);
    expect(targetsClause("6.1", "6")).toBe(false);
    expect(targetsClause("", "6.1")).toBe(false);
    expect(targetsClause("II", "ii.3")).toBe(true);
    expect(targetsClause(" 4 ", "4.1")).toBe(true);
  });

  it("reads a date as intake enters it, and nothing else as a date", () => {
    expect(parseStatedDate("2026-02-02")).toBe(20260202);
    expect(parseStatedDate("2026-02-02T09:30:00Z")).toBe(20260202);
    expect(parseStatedDate(" 2026-02-02 ")).toBe(20260202);
    for (const bad of [
      null,
      "",
      "2 February 2026",
      "2026-2-2",
      "2026-00-10",
      "2026-13-01",
      "2026-01-32",
    ]) {
      expect(parseStatedDate(bad), String(bad)).toBeNull();
    }
  });

  it("orders two documents only when both have a date", () => {
    const doc = (statedDate: string | null) => ({
      label: "D1" as const,
      kind: "nda" as const,
      statedDate,
    });
    expect(orderOf(doc("2026-02-02"), doc("2026-09-15"))).toBe("later");
    expect(orderOf(doc("2026-09-15"), doc("2026-02-02"))).toBe("earlier");
    expect(orderOf(doc("2026-02-02"), doc("2026-02-02"))).toBe("equal");
    expect(orderOf(doc(null), doc("2026-02-02"))).toBe("unknown");
    expect(orderOf(doc("2026-02-02"), doc("soon"))).toBe("unknown");
  });

  it("does not take an operation recorded on an NDA span for an amendment, even when no date rules it out", async () => {
    // Ingest reports "refers" for an NDA, so this annotation is hand-built. If it were believed, a
    // clause of the amendment would look deleted by the NDA.
    const odd = ingestOf(
      [
        {
          doc: "D1",
          paragraph: 5,
          text: "6.2 Section 2 of any amendment is deleted if it is late.",
          clause: "6.2",
        },
        {
          doc: "D2",
          paragraph: 3,
          text: "2. The parties meet in March to review the term.",
          clause: "2",
        },
      ],
      [reference("D1", 5, "2", "deletes")],
    );
    const { finding } = await verify(
      draft({
        status: "deviation",
        evidence: [cite(odd, "D2-p3", "meet in March to review the term", "governing")],
      }),
      {
        ingest: odd,
        bundleLabels: ["D2-p3"],
        enabledChecks: ["C2"],
        manifest: manifest({ dates: { D1: null } }),
      },
    );
    expect(codes(finding)).toEqual([]);
  });
});
