/**
 * Helpers for tests of the Parol evaluation: spans built from parsed documents the way ingest
 * builds them, observations that an ideal pipeline would produce for a key, and metrics built
 * from counts. Nothing here is used by scoring itself, and nothing reads a file or calls a model.
 *
 * `oracleObservations` is not the pipeline selftest. That runs the real stages against a scripted
 * model and comes with the runner. This one only shows that the scorer gives an ideal set of
 * observations a perfect score.
 */
import { segment } from "@clausewise/review";
import { sha256Hex } from "../../../apps/parol/src/canonical.js";
import {
  spanIdOf,
  type DocLabel,
  type EscalationCode,
  type EvidenceRole,
  type QuoteCheck,
  type SourceSpan,
  type SpanId,
  type Status,
} from "../../../apps/parol/src/contracts.js";
import type {
  AnswerKeyCase,
  EscalationExpectation,
  ResolvedAnchor,
  RuleExpectation,
} from "../../../fixtures/parol/types.js";
import type { DocxParagraph } from "../../../packages/docx/src/index.js";
import { rate } from "./stats.js";
import type { AnchorResolver } from "./anchors.js";
import type { ExtractionObservation, RepeatMetrics, ScoringKey, SlotObservation } from "./score.js";

// Characters Word shows as nothing. A paragraph made only of them has no span, as in ingest.
const NO_VISIBLE_TEXT = /^[\s\u200b-\u200d\u2060\ufeff\u00ad]*$/;

/**
 * The spans of one document, with the clause numbers `segment` gives them: a paragraph that is in
 * a clause carries the clause's number (null for an unnumbered one), and a heading, a signature
 * line or a title, which `segment` leaves out of every clause, carries null. This follows
 * apps/parol/src/ingest/ingest.ts and is only for tests.
 */
export function spansFromParagraphs(args: {
  docLabel: DocLabel;
  documentVersionId: string;
  paragraphs: DocxParagraph[];
  /** The `c<n>` numbering continues across documents, so a second document starts higher. */
  firstModelNumber?: number;
}): SourceSpan[] {
  const clauses = segment(args.paragraphs);
  const owner = new Map<string, (typeof clauses)[number]>();
  for (const clause of clauses) {
    for (const part of clause.paragraphs) if (!owner.has(part.id)) owner.set(part.id, clause);
  }
  const spans: SourceSpan[] = [];
  let model = args.firstModelNumber ?? 1;
  for (const paragraph of args.paragraphs) {
    if (paragraph.isTocEntry === true || NO_VISIBLE_TEXT.test(paragraph.text)) continue;
    const clause = owner.get(paragraph.id);
    spans.push({
      id: spanIdOf(args.documentVersionId, paragraph.index),
      label: `${args.docLabel}-p${paragraph.index}`,
      modelLabel: `c${model++}`,
      documentVersionId: args.documentVersionId,
      docLabel: args.docLabel,
      paragraphIndex: paragraph.index,
      clauseId: clause?.id ?? "c0",
      clauseNumber: clause?.number ?? null,
      heading: clause?.heading ?? null,
      text: paragraph.text,
      textSha256: sha256Hex(paragraph.text),
    });
  }
  return spans;
}

/** Plain text in the shape of a parsed Word file: blank lines separate paragraphs. */
export function paragraphsFromTxt(bytes: Uint8Array): DocxParagraph[] {
  const text = new TextDecoder().decode(bytes).replace(/\r\n?/g, "\n");
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .map((block, index): DocxParagraph => ({
      id: `p:${index}`,
      index,
      text: block,
      style: undefined,
      numbering: undefined,
      inTable: false,
      tableRow: undefined,
      label: undefined,
      level: undefined,
      isBullet: false,
      styleName: undefined,
      outlineLevel: undefined,
      isTocEntry: false,
    }));
}

/**
 * What an ideal pipeline produces for the key: every slot has the expected status, cites its
 * governing passages as governing and its superseded passages as superseded, raises the first
 * required escalation code where the key requires one and none otherwise, and extract locates
 * exactly the key's passages. A twin gets the statuses of its original.
 */
export function oracleObservations(
  key: ScoringKey,
  resolver: AnchorResolver,
  repeat: number,
): { slots: SlotObservation[]; extractions: ExtractionObservation[] } {
  const slots: SlotObservation[] = [];
  const extractions: ExtractionObservation[] = [];
  const categories = [...new Set(Object.values(key.rules).map((rule) => rule.category))];
  for (const keyCase of key.cases) {
    const located = new Map<string, Set<SpanId>>(categories.map((c) => [c, new Set()]));
    for (const [ruleKey, expectation] of Object.entries(keyCase.expect)) {
      const evidence = [
        ...expectation.governing.map((a) => ({ a, role: "governing" as const })),
        ...expectation.superseded.map((a) => ({ a, role: "superseded" as const })),
      ].map(({ a, role }) => ({
        spanId: resolver(keyCase.case, a),
        role,
        quoteCheck: "verified" as const,
        displayed: true,
      }));
      for (const anchor of [
        ...expectation.governing,
        ...expectation.superseded,
        ...expectation.relevant,
      ]) {
        located.get(key.rules[ruleKey]!.category)!.add(resolver(keyCase.case, anchor));
      }
      const required = expectation.escalation.mode === "required";
      slots.push({
        caseKey: keyCase.case,
        ruleKey,
        repeat,
        status: expectation.status,
        verificationState: required ? "escalated_by_system" : "verified",
        evidence,
        escalationCodes: required ? [expectation.escalation.codes[0]!] : [],
        modelQuotes: { emitted: evidence.length, valid: evidence.length },
      });
    }
    extractions.push({
      caseKey: keyCase.case,
      repeat,
      categories: Object.fromEntries(
        categories.map((category) => {
          const ids = [...located.get(category)!];
          return [category, { located: ids, notFound: ids.length === 0 }];
        }),
      ),
    });
  }
  for (const twin of key.twins) {
    for (const original of slots.filter((s) => s.caseKey === twin.twinOf)) {
      slots.push({
        ...original,
        caseKey: twin.case,
        evidence: original.evidence.map((e) => ({ ...e })),
      });
    }
  }
  return { slots, extractions };
}

/**
 * Metrics built from counts, for tests of the gates that need an exact number such as 17 of 18
 * without writing out eighteen slots. Fields not given describe a repeat with nothing to count,
 * except the injection effect, which defaults to 0 differing of 8 slots, the slots of one injection
 * case (a full split has two injection cases and 16 slots).
 */
export function repeatMetrics(
  repeat: number,
  given: {
    strictRecall?: [number, number];
    strictPrecision?: [number, number];
    displayed?: [number, number];
    requiredRecall?: [number, number];
    unnecessary?: [number, number];
    extractionRecall?: [number, number];
    highSilentMisses?: number;
    verifiedButUnsupported?: number;
    injectionDiffering?: number;
    /** Slots in injection cases: 8 for each injection case, 16 per split in the full dataset (document 5). */
    injectionSlots?: number;
    swf?: number | null;
  } = {},
): RepeatMetrics {
  const r = (pair: [number, number] | undefined) => rate(pair?.[0] ?? 0, pair?.[1] ?? 0);
  const high = given.highSilentMisses ?? 0;
  const swf = given.swf === undefined ? 0 : given.swf;
  return {
    repeat,
    slots: 0,
    extraction: {
      recall: r(given.extractionRecall),
      precision: r(undefined),
      notFoundAccuracy: r(undefined),
      degradedCases: 0,
    },
    statusAccuracy: r(undefined),
    issues: {
      recallStrict: r(given.strictRecall),
      precisionStrict: r(given.strictPrecision),
      recallLenient: r(undefined),
      precisionLenient: r(undefined),
    },
    silentMisses: { total: high, bySeverity: { high, medium: 0, low: 0 }, slots: [] },
    citations: { model: r(undefined), displayed: r(given.displayed) },
    support: {
      substantive: r(undefined),
      verifiedButUnsupported: { count: given.verifiedButUnsupported ?? 0, slots: [] },
    },
    escalation: { requiredRecall: r(given.requiredRecall), unnecessaryRate: r(given.unnecessary) },
    injection: {
      effect: rate(given.injectionDiffering ?? 0, given.injectionSlots ?? 8),
      differing: Array.from({ length: given.injectionDiffering ?? 0 }, (_, i) => ({
        caseKey: "C",
        ruleKey: `r${i}`,
      })),
    },
    swf: { weightedFailure: 0, maximum: 0, value: swf },
    slotScores: [],
  };
}

// ---------------------------------------------------------------------------------------------
// A key small enough to score by hand
// ---------------------------------------------------------------------------------------------

const ANCHOR = (name: string): ResolvedAnchor => ({
  doc: "D1",
  clause: "1",
  anchor: name,
  paragraph: 0,
});

/** An expectation from a status and the names of the passages. The span id of `A1` in CASE-A is `CASE-A:A1`. */
export function expectation(
  status: Status,
  given: {
    governing?: string[];
    superseded?: string[];
    relevant?: string[];
    escalation?: EscalationExpectation;
    acceptable?: Status[];
  } = {},
): RuleExpectation {
  return {
    status,
    acceptable: given.acceptable ?? [],
    governing: (given.governing ?? []).map(ANCHOR),
    superseded: (given.superseded ?? []).map(ANCHOR),
    relevant: (given.relevant ?? []).map(ANCHOR),
    escalation: given.escalation ?? { mode: "not_expected", codes: [] },
    basis: "x.standard: a basis",
    note: "",
  };
}

export function keyCase(caseKey: string, expect: Record<string, RuleExpectation>): AnswerKeyCase {
  return {
    case: caseKey,
    split: "dev",
    phenomenon: "a case for a test",
    intake: { clientLegalName: "Test Client, Inc." },
    documents: [],
    expect,
    warnings: [],
  };
}

/** The anchor resolver of the tiny key: the span of anchor `A1` in `CASE-A` is `CASE-A:A1`. */
export const tinyResolver: AnchorResolver = (caseKey, ref) => `${caseKey}:${ref.anchor}`;

/**
 * Three cases and four rules, so that every metric can be worked out on paper.
 *
 *   rule   category               severity (weight)
 *   exc-1  exclusions             high (5)
 *   pds-1  permitted-disclosures  medium (3)
 *   pds-2  permitted-disclosures  medium (3)
 *   ret-1  return-destruction     low (1)
 *
 *   CASE-A  exc-1 compliant [A1]; pds-1 deviation [A2] superseded [A3]; pds-2 missing;
 *           ret-1 not_applicable
 *   CASE-B  exc-1 deviation [B1], escalation required (playbook_escalation);
 *           pds-1 compliant [B2]; pds-2 undetermined, relevant [B3, B4], escalation required
 *           (conflicting_sources); ret-1 compliant [B5]
 *   CASE-C  exc-1 compliant [C1]; pds-1 compliant [C2]; pds-2 deviation [C3]; ret-1 not_applicable
 *           CASE-C also has a twin, CASE-C-twin.
 */
export function tinyKey(): ScoringKey {
  return {
    rules: {
      "exc-1": { category: "exclusions", severity: "high", required: true },
      "pds-1": { category: "permitted-disclosures", severity: "medium", required: true },
      "pds-2": { category: "permitted-disclosures", severity: "medium", required: true },
      "ret-1": { category: "return-destruction", severity: "low", required: false },
    },
    cases: [
      keyCase("CASE-A", {
        "exc-1": expectation("compliant", { governing: ["A1"] }),
        "pds-1": expectation("deviation", { governing: ["A2"], superseded: ["A3"] }),
        "pds-2": expectation("missing"),
        "ret-1": expectation("not_applicable"),
      }),
      keyCase("CASE-B", {
        "exc-1": expectation("deviation", {
          governing: ["B1"],
          escalation: { mode: "required", codes: ["playbook_escalation"] },
        }),
        "pds-1": expectation("compliant", { governing: ["B2"] }),
        "pds-2": expectation("undetermined", {
          relevant: ["B3", "B4"],
          escalation: { mode: "required", codes: ["conflicting_sources"] },
        }),
        "ret-1": expectation("compliant", { governing: ["B5"] }),
      }),
      keyCase("CASE-C", {
        "exc-1": expectation("compliant", { governing: ["C1"] }),
        "pds-1": expectation("compliant", { governing: ["C2"] }),
        "pds-2": expectation("deviation", { governing: ["C3"] }),
        "ret-1": expectation("not_applicable"),
      }),
    ],
    twins: [
      {
        case: "CASE-C-twin",
        twinOf: "CASE-C",
        split: "dev",
        intake: { clientLegalName: "Test Client, Inc." },
        documents: [],
      },
    ],
  };
}

type EvidenceSpec = [spanName: string, role: EvidenceRole, check?: QuoteCheck, displayed?: boolean];

/** One observation, written compactly: the passage names are those of the key above. */
export function observation(
  caseKey: string,
  ruleKey: string,
  repeat: number,
  status: Status,
  given: {
    evidence?: EvidenceSpec[];
    escalation?: EscalationCode[];
    state?: "verified" | "escalated_by_system";
    quotes?: [emitted: number, valid: number];
  } = {},
): SlotObservation {
  const evidence = (given.evidence ?? []).map(([name, role, check, displayed]) => ({
    spanId: `${caseKey}:${name}`,
    role,
    quoteCheck: check ?? ("verified" as const),
    displayed: displayed ?? true,
  }));
  const [emitted, valid] = given.quotes ?? [evidence.length, evidence.length];
  return {
    caseKey,
    ruleKey,
    repeat,
    status,
    verificationState: given.state ?? "verified",
    evidence,
    escalationCodes: given.escalation ?? [],
    modelQuotes: { emitted, valid },
  };
}

/**
 * Observations of the tiny key.
 *
 * `base` is a run with a mix of faults, worked out slot by slot in parol-score.test.ts.
 * `fixed` is the same run with CASE-B exc-1 answered correctly. `worst` answers every slot
 * `compliant` with a verified citation of a passage the key does not name, and no escalation.
 */
export function tinyObservations(
  repeat: number,
  variant: "base" | "fixed" | "worst" = "base",
): { slots: SlotObservation[]; extractions: ExtractionObservation[] } {
  const o = (c: string, r: string, s: Status, g?: Parameters<typeof observation>[4]) =>
    observation(c, r, repeat, s, g);
  let slots: SlotObservation[];
  if (variant === "worst") {
    slots = ["CASE-A", "CASE-B", "CASE-C", "CASE-C-twin"].flatMap((c) =>
      ["exc-1", "pds-1", "pds-2", "ret-1"].map((r) =>
        o(c, r, "compliant", { evidence: [["BOGUS", "governing"]] }),
      ),
    );
  } else {
    slots = [
      // CASE-A
      o("CASE-A", "exc-1", "compliant", { evidence: [["A1", "governing"]] }),
      o("CASE-A", "pds-1", "deviation", {
        evidence: [
          ["A2", "governing"],
          ["A3", "superseded"],
        ],
      }),
      o("CASE-A", "pds-2", "missing"),
      o("CASE-A", "ret-1", "not_applicable"),
      // CASE-B
      variant === "fixed"
        ? o("CASE-B", "exc-1", "deviation", {
            evidence: [["B1", "governing"]],
            escalation: ["playbook_escalation"],
          })
        : o("CASE-B", "exc-1", "compliant", { evidence: [["B1", "governing"]] }),
      o("CASE-B", "pds-1", "deviation", { evidence: [["B2", "governing"]] }),
      o("CASE-B", "pds-2", "undetermined", {
        evidence: [
          ["B3", "conflicting"],
          ["B4", "conflicting", "not_found", false],
        ],
        escalation: ["conflicting_sources"],
        state: "escalated_by_system",
        quotes: [2, 1],
      }),
      o("CASE-B", "ret-1", "compliant", { evidence: [["X1", "governing"]] }),
      // CASE-C
      o("CASE-C", "exc-1", "compliant", {
        evidence: [["C1", "governing"]],
        escalation: ["support_not_confirmed"],
      }),
      o("CASE-C", "pds-1", "undetermined", {
        escalation: ["model_abstained"],
        state: "escalated_by_system",
      }),
      o("CASE-C", "pds-2", "deviation", {
        evidence: [["C3", "supporting"]],
        escalation: ["support_not_confirmed"],
        state: "escalated_by_system",
      }),
      o("CASE-C", "ret-1", "missing"),
      // The twin of CASE-C: pds-1 and ret-1 come out differently from CASE-C.
      o("CASE-C-twin", "exc-1", "compliant"),
      o("CASE-C-twin", "pds-1", "compliant"),
      o("CASE-C-twin", "pds-2", "deviation"),
      o("CASE-C-twin", "ret-1", "not_applicable"),
    ];
  }
  const found = (
    caseKey: string,
    located: Record<"exclusions" | "permitted-disclosures" | "return-destruction", string[]>,
    notFound: Record<"exclusions" | "permitted-disclosures" | "return-destruction", boolean>,
  ): ExtractionObservation => ({
    caseKey,
    repeat,
    categories: Object.fromEntries(
      Object.entries(located).map(([category, names]) => [
        category,
        {
          located: names.map((name) => `${caseKey}:${name}`),
          notFound: notFound[category as keyof typeof notFound],
        },
      ]),
    ),
  });
  const none = { exclusions: false, "permitted-disclosures": false, "return-destruction": false };
  const extractions = [
    found(
      "CASE-A",
      { exclusions: ["A1"], "permitted-disclosures": ["A2", "A9"], "return-destruction": [] },
      { ...none, "return-destruction": true },
    ),
    found(
      "CASE-B",
      {
        exclusions: ["B1"],
        "permitted-disclosures": ["B2", "B3"],
        "return-destruction": ["B5", "B9"],
      },
      none,
    ),
    found(
      "CASE-C",
      { exclusions: ["C1"], "permitted-disclosures": ["C2", "C3"], "return-destruction": ["C9"] },
      none,
    ),
  ];
  return { slots, extractions };
}
