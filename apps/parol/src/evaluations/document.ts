import { z } from "zod";
import { hashOf } from "../canonical.js";
import {
  DOC_LABELS,
  ESCALATION_CODES,
  EVIDENCE_ROLES,
  STATUSES,
  type BundleSpanReason,
} from "../contracts.js";

/**
 * The page document: the contract between the evaluation command, which writes it, and the
 * application, which only reads it (docs/parol W2.5 section 3.3). One comparison of two results
 * files, rendered into a self-contained JSON file in `<data folder>/evaluations/`. The contract is
 * owned here, by the reader, so a file that does not fit is refused by the code that would show it.
 *
 * Every object is strict, every string and list is bounded, and every list that has a closed set of
 * values (statuses, roles, gate ids, failure kinds) is checked against that set. The fingerprint
 * (`sha256`) is the hash of everything but itself and the id, and the id is its first 16 digits, so
 * an accidental edit to a file is found. It is not authentication: whoever can write the folder can
 * write a valid file, and the page says so.
 *
 * A document holds counts, ids, hashes, codes and the synthetic case text of `fixtures/parol`. It
 * never holds a model answer, a quotation a model wrote, a prompt or text from a matter.
 */

export const PAGE_FORMAT = 1 as const;
export const PAGE_KIND = "parol-comparison-page" as const;
/** The largest file the builder writes and the reader opens. */
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// The closed lists. Two of them are copies of constants that live in `evals/` (the application
// imports nothing from there); `test/evaluations/pins.test.ts` fails when either side changes.
// ---------------------------------------------------------------------------------------------

export const RUN_MODES = ["selftest", "simulated", "live", "replay"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const GATE_IDS = [
  "G1",
  "G2",
  "G3",
  "G4",
  "G5",
  "G6",
  "G7",
  "G8",
  "G9",
  "G10",
  "G11",
  "G12",
  "G13",
  "G14",
] as const;
export type GateId = (typeof GATE_IDS)[number];

export const GATE_OUTCOMES = ["pass", "fail", "not_evaluated"] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];

export const DECISION_OUTCOMES = ["promote", "promote_with_conditions", "do_not_promote"] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

/** The kinds of failure a scored slot can have (`FAILURE_FACTORS` of the evaluation's score.ts). */
export const FAILURE_KINDS = [
  "silent_miss",
  "verified_unsupported",
  "determined_where_undetermined_required",
  "required_escalation_missing",
  "false_alarm",
  "wrong_flag",
  "evidence_failed",
  "wrong_status",
  "undetermined_where_determinable",
  "unnecessary_escalation",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** Declared as a record so that the compiler checks the list against `BundleSpanReason`. */
const BUNDLE_REASONS: Record<BundleSpanReason, true> = {
  located: true,
  definition: true,
  cross_reference: true,
  hint: true,
  full_document: true,
};
export const BUNDLE_SPAN_REASONS = Object.keys(BUNDLE_REASONS) as [
  BundleSpanReason,
  ...BundleSpanReason[],
];

export const QUOTE_CHECKS = ["verified", "not_found", "ambiguous"] as const;
export const CHANGE_KINDS = ["regression", "improvement", "changed"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export const SPLIT_NAMES = ["dev", "heldout"] as const;
export type SplitName = (typeof SPLIT_NAMES)[number];

/** Why a file in the folder is not a usable page, as fixed codes. */
export type PageProblem =
  | "too_large"
  | "unreadable"
  | "not_json"
  | "not_a_comparison"
  | "fingerprint_mismatch"
  | "name_mismatch";

// ---------------------------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------------------------

const MAX_TEXT = 2000;
const MAX_PASSAGE_TEXT = 8000;
export const MAX_CHANGES = 500;
export const MAX_CASES = 40;
const MAX_PASSAGES = 60;
const MAX_NOTES = 40;
const MAX_ROWS = 40;
const MAX_EVIDENCE = 40;

const text = (max: number = MAX_TEXT) => z.string().max(max);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().min(0).max(1_000_000_000);
const measure = z.number().min(-1e12).max(1e12);
const paragraph = z.number().int().min(0).max(100_000);
const offset = z.number().int().min(0).max(10_000_000);
const caseKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/);
/**
 * A playbook rule key, in the alphabet the application stores it in (`RULE_KEY_PATTERN` of
 * `store/schemas.ts`). It is copied and not imported, because this folder imports nothing from the
 * store; `test/evaluations/pins.test.ts` fails when the two differ. A narrower alphabet would make
 * a comparison of a playbook that the application accepts impossible to publish.
 */
export const PAGE_RULE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ruleKey = z.string().regex(PAGE_RULE_KEY);
const checkId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
/** A file's base name: no path. */
const baseName = z.string().regex(/^[^/\\]{1,200}$/);

const status = z.enum(STATUSES);
const docLabel = z.enum(DOC_LABELS);
const severity = z.enum(["high", "medium", "low"]);

// ---------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------

const sideFacts = z.strictObject({
  mode: z.enum(RUN_MODES),
  workflow: z.strictObject({
    label: text(100),
    sha256: sha,
    retrieval: text(100),
    checks: z.array(text(100)).max(40),
    prompts: z.strictObject({
      extract: text(200),
      analyze: text(200),
      support: text(200).nullable(),
    }),
  }),
  model: z.strictObject({
    provider: text(200),
    requested: text(200),
    endpoint: text(300).nullable(),
    reported: z.array(text(200)).max(20).nullable(),
    reportedNote: text(),
  }),
  code: z.strictObject({ commit: text(100).nullable(), dirty: z.boolean().nullable() }),
  startedAt: text(100),
  finishedAt: text(100),
  repeats: count,
  health: z.strictObject({ clean: z.boolean(), problems: z.array(text()).max(MAX_NOTES) }),
  contamination: text().nullable(),
  trailsRecorded: z.boolean(),
});

const sectionSide = z.strictObject({
  cases: count,
  casesInSplit: count,
  fullSplit: z.boolean(),
  completedRepeats: count,
});

const gateEvidence = z.strictObject({
  repeat: count.nullable(),
  measure: text(),
  numerator: measure.nullable(),
  denominator: measure.nullable(),
  value: measure.nullable(),
  passed: z.boolean().nullable(),
  context: z.literal(true).optional(),
});

const gateView = z.strictObject({
  id: z.enum(GATE_IDS),
  title: text(300),
  threshold: text(),
  scope: text(100),
  outcome: z.enum(GATE_OUTCOMES),
  detail: text(),
  evidence: z.array(gateEvidence).max(MAX_EVIDENCE),
  slots: z.array(z.strictObject({ caseKey, ruleKey })).max(MAX_CHANGES).optional(),
});

/** Exactly G1 to G14, once each and in order. */
const gateList = z
  .array(gateView)
  .length(GATE_IDS.length)
  .refine((gates) => gates.every((gate, index) => gate.id === GATE_IDS[index]));

const sideCount = z
  .strictObject({
    modal: status,
    histogram: text(300),
    correct: count,
    repeats: count,
    failures: z.array(z.enum(FAILURE_KINDS)).max(FAILURE_KINDS.length),
  })
  .refine((side) => side.correct <= side.repeats);

const shown = z.strictObject({
  sent: z.boolean(),
  full: z.boolean(),
  spans: z
    .array(z.strictObject({ doc: docLabel, paragraph, why: z.enum(BUNDLE_SPAN_REASONS) }))
    .max(400),
});

const cited = z.strictObject({
  doc: docLabel,
  paragraph,
  role: z.enum(EVIDENCE_ROLES),
  quoteCheck: z.enum(QUOTE_CHECKS),
  start: offset.nullable(),
  end: offset.nullable(),
});

const trailChecks = z.strictObject({
  pass: z.array(checkId).max(40),
  fail: z.array(checkId).max(40),
  notApplicable: z.array(checkId).max(40),
});

const trailRepeat = z.strictObject({
  repeat: count,
  observed: status,
  correct: z.boolean(),
  failure: z.enum(FAILURE_KINDS).nullable(),
  silentMiss: z.boolean(),
  verifiedQuotes: count,
  verificationState: z.enum(["verified", "escalated_by_system"]).nullable(),
  escalations: z.array(z.enum(ESCALATION_CODES)).max(ESCALATION_CODES.length),
  shown: shown.nullable(),
  cited: z.array(cited).max(40),
  checks: trailChecks.nullable(),
});

const sideTrail = z.strictObject({
  recorded: z.boolean(),
  whyNot: z.enum(["not_recorded", "case_changed"]).nullable(),
  repeats: z.array(trailRepeat).max(100),
});

const slotTrail = z.strictObject({
  key: z.strictObject({
    basis: text(),
    note: text(),
    escalation: z.strictObject({ mode: text(100), codes: z.array(text(100)).max(20) }),
    anchors: z
      .array(
        z.strictObject({
          role: z.enum(["governing", "superseded", "relevant"]),
          doc: docLabel,
          clause: text(100).nullable(),
          paragraph,
          anchor: text(),
        }),
      )
      .max(40),
  }),
  baseline: sideTrail,
  candidate: sideTrail,
});

const changeView = z.strictObject({
  caseKey,
  ruleKey,
  ruleTitle: text(300),
  severity,
  expected: status,
  acceptable: z.array(status).max(STATUSES.length),
  kind: z.enum(CHANGE_KINDS),
  baseline: sideCount,
  candidate: sideCount,
  trail: z.union([z.strictObject({ sealed: z.literal(true) }), slotTrail]),
});

const decision = z.strictObject({
  outcome: z.enum(DECISION_OUTCOMES),
  reasons: z.array(text()).max(MAX_NOTES),
  conditions: z.array(text()).max(MAX_NOTES),
  unchecked: z.array(text()).max(MAX_NOTES),
});

const sectionView = z.strictObject({
  split: z.enum(SPLIT_NAMES),
  repeats: text(100),
  sides: z.strictObject({ baseline: sectionSide, candidate: sectionSide }),
  rows: z
    .array(
      z.strictObject({
        metric: text(300),
        baseline: text(),
        candidate: text(),
        change: text(),
        gate: text(),
        pass: text(),
      }),
    )
    .max(MAX_ROWS),
  gates: z.strictObject({ baseline: gateList.nullable(), candidate: gateList.nullable() }),
  paired: count,
  unpaired: count,
  changes: z.array(changeView).max(MAX_CHANGES),
  decision: decision.nullable(),
  decisionNote: text().nullable(),
  notes: z.array(text()).max(MAX_NOTES),
});

const caseView = z.strictObject({
  documents: z
    .array(
      z.strictObject({
        label: docLabel,
        title: text(300),
        versionNo: count,
        statedDate: text(100).nullable(),
      }),
    )
    .max(DOC_LABELS.length),
  passages: z
    .array(
      z.strictObject({
        doc: docLabel,
        paragraph,
        clauseNumber: text(100).nullable(),
        heading: text(300).nullable(),
        text: text(MAX_PASSAGE_TEXT),
      }),
    )
    .max(MAX_PASSAGES),
});

const comparisonPageSchema = z
  .strictObject({
    format: z.literal(PAGE_FORMAT),
    kind: z.literal(PAGE_KIND),
    id: z.string().regex(/^cmp_[0-9a-f]{16}$/),
    sha256: sha,
    files: z.strictObject({ baseline: baseName, candidate: baseName }),
    sides: z.strictObject({ baseline: sideFacts, candidate: sideFacts }),
    dataset: z.strictObject({ label: text(200), answerKeysSha256: sha, splitsFileSha256: sha }),
    playbook: z.strictObject({ slug: text(200), version: text(100), sha256: sha }),
    evaluation: z.strictObject({ label: text(100), sha256: sha }),
    differences: z
      .array(
        z.strictObject({
          name: text(100),
          field: text(100),
          baseline: text(300),
          candidate: text(300),
          status: z.enum(["declared", "allowed"]),
        }),
      )
      .max(200),
    notes: z.array(text()).max(MAX_NOTES),
    heldoutTrailsOpened: z.boolean(),
    sections: z.array(sectionView).min(1).max(SPLIT_NAMES.length),
    cases: z.record(caseKey, caseView).refine((cases) => Object.keys(cases).length <= MAX_CASES),
  })
  .refine(
    (page) => new Set(page.sections.map((section) => section.split)).size === page.sections.length,
  );

export type ComparisonPage = z.infer<typeof comparisonPageSchema>;
export type SideFacts = ComparisonPage["sides"]["baseline"];
export type SectionView = ComparisonPage["sections"][number];
export type GateView = NonNullable<SectionView["gates"]["baseline"]>[number];
export type ChangeView = SectionView["changes"][number];
export type SideCount = ChangeView["baseline"];
export type SlotTrailView = Exclude<ChangeView["trail"], { sealed: true }>;
export type SideTrailView = SlotTrailView["baseline"];
export type CaseView = ComparisonPage["cases"][string];
export type PassageView = CaseView["passages"][number];

/** What a document is before it is sealed: everything but the fingerprint and the id. */
export type ComparisonBody = Omit<ComparisonPage, "id" | "sha256">;

/** The id a fingerprint gives: `cmp_` and its first 16 hex digits. */
export const pageIdOf = (sha256: string): string => `cmp_${sha256.slice(0, 16)}`;

/** The file name of a page: its id and `.json`. */
export const pageFileName = (id: string): string => `${id}.json`;

/** Whether a string is shaped like a page id. Nothing else is looked up on the disk. */
export const isPageId = (value: unknown): value is string =>
  typeof value === "string" && /^cmp_[0-9a-f]{16}$/.test(value);

/** A body with its fingerprint and id. The same body always gives the same page. */
export function sealComparisonPage(body: ComparisonBody): ComparisonPage {
  const sha256 = hashOf(body);
  return { ...body, id: pageIdOf(sha256), sha256 };
}

export type ParsedPage = { ok: true; page: ComparisonPage } | { ok: false; problem: PageProblem };

/**
 * Reads a page document. The checks run in this order and the first to fail names the problem: the
 * size, that it is JSON, that it fits the strict schema, that the fingerprint matches the content,
 * that the id is the fingerprint's, and that the file is named for its id. The answer is a fixed
 * code and never repeats a character of the file.
 */
export function parseComparisonPage(text: string, fileName: string): ParsedPage {
  if (Buffer.byteLength(text, "utf8") > MAX_PAGE_BYTES) return { ok: false, problem: "too_large" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: "not_json" };
  }
  const parsed = comparisonPageSchema.safeParse(json);
  if (!parsed.success) return { ok: false, problem: "not_a_comparison" };
  const page = parsed.data;
  const { id, sha256, ...body } = page;
  if (hashOf(body) !== sha256) return { ok: false, problem: "fingerprint_mismatch" };
  if (id !== pageIdOf(sha256) || fileName !== pageFileName(id))
    return { ok: false, problem: "name_mismatch" };
  return { ok: true, page };
}
