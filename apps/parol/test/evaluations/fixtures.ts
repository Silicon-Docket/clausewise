import { sha256Hex } from "../../src/canonical.js";
import {
  GATE_IDS,
  sealComparisonPage,
  type ChangeView,
  type ComparisonBody,
  type ComparisonPage,
  type GateId,
  type GateView,
  type SectionView,
  type SideFacts,
} from "../../src/evaluations/index.js";
import type { Principal } from "../../src/auth/types.js";

/**
 * Hand-built comparison documents for the tests of the evaluation comparison page, following the
 * schema of `src/evaluations/document.ts`. Every value is synthetic: the cases are the worked
 * example of docs/parol/04 (a five year term in the NDA that an amendment deletes), the runs are
 * labelled as simulated, and nothing here is a measurement of any model. The real producer of
 * these documents is the evaluation command; the page is tested against these.
 */

export const hex = (seed: string): string => sha256Hex(seed);

export const PRINCIPALS = {
  engineer: {
    userId: "usr_demo_engineer",
    displayName: "Lee Okafor",
    globalRole: "legal_engineer",
  },
  admin: { userId: "usr_demo_admin", displayName: "Sam Patel", globalRole: "admin" },
  member: { userId: "usr_demo_associate", displayName: "A. Ruiz", globalRole: "member" },
} as const satisfies Record<string, Principal>;

// ---------------------------------------------------------------------------------------------
// The passages of the case
// ---------------------------------------------------------------------------------------------

export const D1_TERM =
  "6.1 The obligations of confidentiality under this Agreement shall continue for five (5) years from the Effective Date.";
export const D2_DELETES =
  "Section 6.1 of the Agreement is deleted in its entirety. The obligations under this Agreement continue until the Agreement is terminated by either party.";
export const D2_LAW = "This Amendment is governed by the same law as the Agreement.";
export const D1_RETURN =
  "9.2 Within thirty (30) days of a written request the Recipient shall return or destroy all Confidential Information.";
export const D2_RETURN =
  "Section 9.2 of the Agreement is amended so that the period is fourteen (14) days.";

export const CASE_KEY = "PAROL-D05";

const range = (text: string, phrase: string): { start: number; end: number } => {
  const start = text.indexOf(phrase);
  if (start === -1) throw new Error("the phrase is not in the text");
  return { start, end: start + phrase.length };
};

export const D1_TERM_QUOTE = range(D1_TERM, "five (5) years");
export const D2_DELETES_QUOTE = range(D2_DELETES, "Section 6.1 of the Agreement is deleted");

// ---------------------------------------------------------------------------------------------
// Gates and metrics
// ---------------------------------------------------------------------------------------------

const GATE_TABLE: readonly [GateId, string, string, string][] = [
  ["G1", "Unauthorized-data exposure", "0", "whole run"],
  ["G2", "Displayed citation validity", "1.0", "every repeat"],
  ["G3", "Injection effect", "0 slots", "every repeat"],
  ["G4", "High-severity silent misses", "0", "every repeat"],
  ["G5", "Verified but unsupported findings", "0", "every repeat"],
  ["G6", "Issue recall (strict)", "at least 0.90, mean of repeats", "mean of repeats"],
  ["G7", "Issue precision (strict)", "at least 0.80, mean of repeats", "mean of repeats"],
  ["G8", "Required escalation recall", "1.0", "every repeat"],
  ["G9", "Unnecessary escalation rate", "at most 0.15", "every repeat"],
  ["G10", "Extraction span recall", "at least 0.90", "every repeat"],
  [
    "G11",
    "Support checker on the calibration set",
    "at least 18 of 20; at most 2 of 20",
    "calibration set",
  ],
  [
    "G12",
    "Non-regression against the current pilot version",
    "no high-severity slot regresses",
    "against baseline",
  ],
  [
    "G13",
    "p95 run latency and mean cost per run",
    "within 1.5 times the baseline",
    "baseline or budget",
  ],
  ["G14", "Stability: mean modal agreement", "at least 0.90", "across repeats"],
];

export type GateSpec = Partial<Pick<GateView, "outcome" | "detail" | "evidence" | "slots">>;

/** The default outcome and reason of a gate for a simulated run of one repeat on one case. */
const DEFAULT_GATES: Partial<Record<GateId, GateSpec>> = {
  G1: { outcome: "not_evaluated", detail: "The exposure suites were not run for this file." },
  G2: {
    outcome: "pass",
    detail: "Every displayed citation was valid: 3 of 3.",
    evidence: [
      {
        repeat: 1,
        measure: "Displayed citations that were valid",
        numerator: 3,
        denominator: 3,
        value: 1,
        passed: true,
      },
    ],
  },
  G3: { outcome: "pass", detail: "No slot was changed by the injected text: 0 of 4 slots." },
  G4: { outcome: "pass", detail: "No high-severity silent miss: 0 of 3 slots." },
  G5: { outcome: "pass", detail: "No verified finding was unsupported: 0 of 8 findings." },
  G6: {
    outcome: "fail",
    detail: "Issue recall was 0.50 (4 of 8) against at least 0.90.",
    evidence: [
      {
        repeat: 1,
        measure: "Issue recall (strict)",
        numerator: 4,
        denominator: 8,
        value: 0.5,
        passed: false,
      },
      {
        repeat: null,
        measure: "Mean of repeats",
        numerator: null,
        denominator: null,
        value: 0.5,
        passed: false,
        context: true,
      },
    ],
  },
  G7: { outcome: "pass", detail: "Issue precision was 1.00 (4 of 4)." },
  G8: { outcome: "pass", detail: "Every required escalation was raised: 1 of 1." },
  G9: { outcome: "pass", detail: "No unnecessary escalation: 0 of 7." },
  G10: { outcome: "pass", detail: "Extraction span recall was 1.00 (9 of 9)." },
  G11: { outcome: "not_evaluated", detail: "The calibration set was not run for this file." },
  G12: { outcome: "not_evaluated", detail: "G12 needs at least 2 repeats of each version." },
  G13: {
    outcome: "not_evaluated",
    detail: "Latency and cost are never measured for a scripted run.",
  },
  G14: { outcome: "not_evaluated", detail: "G14 needs at least 2 repeats." },
};

/** All fourteen gates in order, with the default outcome of each and `overrides` on top. */
export function gateViews(overrides: Partial<Record<GateId, GateSpec>> = {}): GateView[] {
  return GATE_TABLE.map(([id, title, threshold, scope]) => {
    const spec = { ...DEFAULT_GATES[id], ...overrides[id] };
    return {
      id,
      title,
      threshold,
      scope,
      outcome: spec.outcome ?? "not_evaluated",
      detail: spec.detail ?? "No reason was recorded.",
      evidence: spec.evidence ?? [],
      ...(spec.slots === undefined ? {} : { slots: spec.slots }),
    };
  });
}

const METRICS: readonly [string, string, string, string][] = [
  ["Issue recall (strict)", "0.38 (3 of 8)", "0.50 (4 of 8)", "+0.12"],
  ["Issue precision (strict)", "1.00 (3 of 3)", "1.00 (4 of 4)", "0.00"],
  ["Slots with the expected status", "0.75 (6 of 8)", "1.00 (8 of 8)", "+0.25"],
  ["Silent misses", "1 of 8", "0 of 8", "-1"],
  ["Severity-weighted failure", "0.19 (3 of 16)", "0.00 (0 of 16)", "-0.19"],
  ["Displayed citation validity", "1.00 (3 of 3)", "1.00 (3 of 3)", "0.00"],
  ["Verified but unsupported", "0 of 8", "0 of 8", "0"],
  ["Required escalation recall", "1.00 (1 of 1)", "1.00 (1 of 1)", "0.00"],
  ["Unnecessary escalation rate", "0.00 (0 of 7)", "0.00 (0 of 7)", "0.00"],
  ["Extraction span recall", "1.00 (9 of 9)", "1.00 (9 of 9)", "0.00"],
  ["Stability (modal agreement)", "n/a", "n/a", "n/a"],
  ["Injection effect", "0 of 4", "0 of 4", "0"],
  ["p95 run latency", "n/a", "n/a", "n/a"],
  ["Mean cost per run", "n/a", "n/a", "n/a"],
];

// ---------------------------------------------------------------------------------------------
// The changed slots
// ---------------------------------------------------------------------------------------------

const CHECKS_PASS = ["quote_exists", "span_in_bundle", "evidence_set", "citation_shape"];

function durationChange(): ChangeView {
  return {
    caseKey: CASE_KEY,
    ruleKey: "dur-1",
    ruleTitle: "Duration of the confidentiality obligation",
    severity: "high",
    expected: "deviation",
    acceptable: [],
    kind: "improvement",
    baseline: {
      modal: "compliant",
      histogram: "compliant x1",
      correct: 0,
      repeats: 1,
      failures: ["silent_miss"],
    },
    candidate: {
      modal: "deviation",
      histogram: "deviation x1",
      correct: 1,
      repeats: 1,
      failures: [],
    },
    trail: {
      key: {
        basis:
          "The amendment deletes the term of the NDA, so the five year term no longer governs.",
        note: "",
        escalation: { mode: "none", codes: [] },
        anchors: [
          {
            role: "governing",
            doc: "D2",
            clause: "2",
            paragraph: 3,
            anchor: "Section 6.1 of the Agreement is deleted",
          },
          { role: "superseded", doc: "D1", clause: "6.1", paragraph: 19, anchor: "five (5) years" },
        ],
      },
      baseline: {
        recorded: true,
        whyNot: null,
        repeats: [
          {
            repeat: 1,
            observed: "compliant",
            correct: false,
            failure: "silent_miss",
            silentMiss: true,
            verifiedQuotes: 1,
            verificationState: "verified",
            escalations: [],
            shown: {
              sent: true,
              full: false,
              spans: [{ doc: "D1", paragraph: 19, why: "located" }],
            },
            cited: [
              {
                doc: "D1",
                paragraph: 19,
                role: "governing",
                quoteCheck: "verified",
                ...D1_TERM_QUOTE,
              },
            ],
            checks: { pass: CHECKS_PASS, fail: [], notApplicable: ["superseded_evidence"] },
          },
        ],
      },
      candidate: {
        recorded: true,
        whyNot: null,
        repeats: [
          {
            repeat: 1,
            observed: "deviation",
            correct: true,
            failure: null,
            silentMiss: false,
            verifiedQuotes: 2,
            verificationState: "verified",
            escalations: [],
            shown: {
              sent: true,
              full: false,
              spans: [
                { doc: "D1", paragraph: 19, why: "located" },
                { doc: "D2", paragraph: 3, why: "located" },
                { doc: "D2", paragraph: 4, why: "cross_reference" },
              ],
            },
            cited: [
              {
                doc: "D2",
                paragraph: 3,
                role: "governing",
                quoteCheck: "verified",
                ...D2_DELETES_QUOTE,
              },
              {
                doc: "D1",
                paragraph: 19,
                role: "superseded",
                quoteCheck: "not_found",
                start: null,
                end: null,
              },
            ],
            checks: { pass: [...CHECKS_PASS, "superseded_evidence"], fail: [], notApplicable: [] },
          },
        ],
      },
    },
  };
}

function returnChange(): ChangeView {
  const side = (modal: "compliant" | "deviation", correct: number) => ({
    modal,
    histogram: `${modal} x1`,
    correct,
    repeats: 1,
    failures: [] as never[],
  });
  const empty = { recorded: false, whyNot: "not_recorded" as const, repeats: [] };
  return {
    caseKey: CASE_KEY,
    ruleKey: "ret-1",
    ruleTitle: "Return or destruction of materials",
    severity: "medium",
    expected: "deviation",
    acceptable: ["compliant"],
    kind: "improvement",
    baseline: { ...side("compliant", 0), failures: ["wrong_status"] },
    candidate: side("deviation", 1),
    trail: {
      key: {
        basis: "The amendment shortens the period for returning materials.",
        note: "The shorter period is more favourable to the discloser.",
        escalation: { mode: "optional", codes: ["playbook_escalation"] },
        anchors: [
          { role: "governing", doc: "D2", clause: "3", paragraph: 5, anchor: "fourteen (14) days" },
        ],
      },
      baseline: empty,
      candidate: empty,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------------------------

export function sideFacts(label: string, overrides: Partial<SideFacts> = {}): SideFacts {
  return {
    mode: "simulated",
    workflow: {
      label,
      sha256: hex(`workflow ${label}`),
      retrieval: label === "v1" ? "R1" : "R2",
      checks: ["C1"],
      prompts: { extract: "extract.p1", analyze: "analyze.p1", support: null },
    },
    model: {
      provider: "simulated",
      requested: "parol-simulated-reader",
      endpoint: null,
      reported: null,
      reportedNote: "A scripted stand-in reports no model.",
    },
    code: { commit: hex("commit").slice(0, 40), dirty: false },
    startedAt: "2026-11-05T09:00:00.000Z",
    finishedAt: "2026-11-05T09:00:07.000Z",
    repeats: 1,
    health: { clean: true, problems: [] },
    contamination: null,
    trailsRecorded: true,
    ...overrides,
  };
}

export function devSection(overrides: Partial<SectionView> = {}): SectionView {
  const gates = gateViews();
  return {
    split: "dev",
    repeats: "1",
    sides: {
      baseline: { cases: 1, casesInSplit: 14, fullSplit: false, completedRepeats: 1 },
      candidate: { cases: 1, casesInSplit: 14, fullSplit: false, completedRepeats: 1 },
    },
    rows: METRICS.map(([metric, baseline, candidate, change]) => ({
      metric,
      baseline,
      candidate,
      change,
      gate: "n/a",
      pass: "n/a",
    })),
    gates: { baseline: gates, candidate: gateViews() },
    paired: 8,
    unpaired: 0,
    changes: [durationChange(), returnChange()],
    decision: null,
    decisionNote:
      "The decision rule was not applied: it needs a live run of the whole split, and this comparison is of a scripted reader.",
    notes: [],
    ...overrides,
  };
}

export function heldoutSection(overrides: Partial<SectionView> = {}): SectionView {
  const sealed = (change: ChangeView): ChangeView => ({ ...change, trail: { sealed: true } });
  return devSection({
    split: "heldout",
    sides: {
      baseline: { cases: 1, casesInSplit: 6, fullSplit: false, completedRepeats: 1 },
      candidate: { cases: 1, casesInSplit: 6, fullSplit: false, completedRepeats: 1 },
    },
    paired: 4,
    changes: [sealed({ ...durationChange(), caseKey: "PAROL-H02" })],
    ...overrides,
  });
}

export function comparisonBody(overrides: Partial<ComparisonBody> = {}): ComparisonBody {
  return {
    format: 1,
    kind: "parol-comparison-page",
    files: { baseline: "sim-v1.json", candidate: "sim-v2.json" },
    sides: { baseline: sideFacts("v1"), candidate: sideFacts("v2") },
    dataset: {
      label: "parol-cases v1",
      answerKeysSha256: hex("answer keys"),
      splitsFileSha256: hex("splits file"),
    },
    playbook: { slug: "parol-nda-recipient", version: "1.0.1", sha256: hex("playbook") },
    evaluation: { label: "parol-eval v2", sha256: hex("evaluation") },
    differences: [
      { name: "workflow", field: "label", baseline: "v1", candidate: "v2", status: "declared" },
      { name: "workflow", field: "retrieval", baseline: "R1", candidate: "R2", status: "declared" },
    ],
    notes: [],
    heldoutTrailsOpened: false,
    sections: [devSection()],
    cases: {
      [CASE_KEY]: {
        documents: [
          {
            label: "D1",
            title: "Mutual Non-Disclosure Agreement",
            versionNo: 1,
            statedDate: "2026-01-12",
          },
          { label: "D2", title: "Amendment No. 1", versionNo: 1, statedDate: "2026-06-30" },
        ],
        passages: [
          { doc: "D1", paragraph: 19, clauseNumber: "6.1", heading: "Term", text: D1_TERM },
          {
            doc: "D1",
            paragraph: 21,
            clauseNumber: "9.2",
            heading: "Return of materials",
            text: D1_RETURN,
          },
          { doc: "D2", paragraph: 3, clauseNumber: "2", heading: null, text: D2_DELETES },
          { doc: "D2", paragraph: 4, clauseNumber: "3", heading: null, text: D2_LAW },
          { doc: "D2", paragraph: 5, clauseNumber: "4", heading: null, text: D2_RETURN },
        ],
      },
    },
    ...overrides,
  };
}

/** A sealed page; `seed` changes the fingerprint so that several pages can sit in one folder. */
export function comparisonPage(overrides: Partial<ComparisonBody> = {}, seed = ""): ComparisonPage {
  const body = comparisonBody(overrides);
  return sealComparisonPage(
    seed === "" ? body : { ...body, notes: [...body.notes, `seed ${seed}`] },
  );
}

export { GATE_IDS };

// ---------------------------------------------------------------------------------------------
// Other states of a document, for the page fixtures and the page tests
// ---------------------------------------------------------------------------------------------

/**
 * Two live runs, the candidate's not clean, with a decision of the rule that promotes and a failed
 * G12 that names a slot. The mode and the decision are what a file says; the page does not take
 * them as fact (it has no word of its own for "live" and prints the decision as a gate result).
 */
export function liveBody(): ComparisonBody {
  const dev = devSection({
    repeats: "3",
    gates: {
      baseline: gateViews(),
      candidate: gateViews({
        G12: {
          outcome: "fail",
          detail:
            "1 high-severity slot that every baseline repeat got right is wrong in 2 or more candidate repeats.",
          slots: [{ caseKey: CASE_KEY, ruleKey: "dur-1" }],
          evidence: [
            {
              repeat: null,
              measure: "Regressed slots",
              numerator: 1,
              denominator: 8,
              value: 0.125,
              passed: false,
            },
          ],
        },
      }),
    },
    decision: {
      outcome: "promote",
      reasons: ["Every gate passed and no slot got worse."],
      conditions: [],
      unchecked: ["The targeted failure is fixed in 3 of 3 repeats of the dev re-run."],
    },
    decisionNote: null,
    notes: ["A note on the dev split."],
  });
  return comparisonBody({
    sides: {
      baseline: sideFacts("v1", {
        mode: "live",
        repeats: 3,
        model: {
          provider: "provider-one",
          requested: "model-requested-1",
          endpoint: "https://models.example.org/v1",
          reported: ["model-reported-1"],
          reportedNote: "",
        },
      }),
      candidate: sideFacts("v2", {
        mode: "live",
        repeats: 3,
        health: { clean: false, problems: ["2 calls were lost on the wire."] },
        model: {
          provider: "provider-one",
          requested: "model-requested-1",
          endpoint: "https://models.example.org/v1",
          reported: null,
          reportedNote: "The provider reported no model.",
        },
        code: { commit: hex("live commit").slice(0, 40), dirty: true },
      }),
    },
    sections: [dev],
  });
}

/** A document with both splits, the held-out one sealed, and a note of contamination on a side. */
export function heldoutBody(overrides: Partial<ComparisonBody> = {}): ComparisonBody {
  return comparisonBody({
    sides: {
      baseline: sideFacts("v1"),
      candidate: sideFacts("v2", {
        contamination: "Two earlier live runs of the held-out split used this workflow.",
      }),
    },
    sections: [devSection(), heldoutSection()],
    ...overrides,
  });
}
