/**
 * Scores observations of Parol runs against the answer key (docs/parol/05-evaluation.md,
 * "Metrics"). Pure: no file, network or clock. The runner gathers observations from stored
 * findings and passes them in with a resolver that maps the key's anchors to the span ids of that
 * run; everything here is arithmetic on those.
 *
 * Conventions that hold throughout:
 *
 * - A slot is one (case, rule) pair, and a flag is a `deviation` or `missing` status.
 * - Every rate carries its counts and a Wilson interval. A zero denominator gives a null value.
 * - Evidence counts as support only when its quote is verified. The negative test (a superseded
 *   passage relied on as governing) looks at every evidence item with the governing role, whether
 *   or not its quote verified, because pointing at replaced text as controlling is wrong in
 *   either case.
 * - A bad input is a bug in the harness and not a poor score, so a missing observation, an
 *   unknown case or rule, or an anchor that no longer resolves throws `ScoringError`, with ids and
 *   counts in the message and never document text.
 */
import {
  SEVERITY_WEIGHT,
  type CategoryId,
  type EscalationCode,
  type EvidenceRole,
  type QuoteCheck,
  type SpanId,
  type Status,
} from "../../../apps/parol/src/contracts.js";
import type {
  AnchorRef,
  AnswerKeyCase,
  AnswerKeyFile,
  AnswerKeyTwin,
  EscalationMode,
  PlaybookRuleFacts,
  RuleExpectation,
  Severity,
  Split,
} from "../../../fixtures/parol/types.js";
import type { AnchorResolver } from "./anchors.js";
import { mean, rate, type Rate } from "./stats.js";

export class ScoringError extends Error {
  override name = "ScoringError";
}

// ---------------------------------------------------------------------------------------------
// The key, as the scorer needs it
// ---------------------------------------------------------------------------------------------

export interface ScoringKey {
  /** In playbook order. */
  rules: Record<string, PlaybookRuleFacts>;
  /** The cases of one split. Twins are not cases: they have no expectations of their own. */
  cases: readonly AnswerKeyCase[];
  twins: readonly AnswerKeyTwin[];
}

/** The part of answer-keys.json that belongs to one split. */
export function scoringKey(file: AnswerKeyFile, split: Split): ScoringKey {
  return {
    rules: file.playbook.rules,
    cases: file.cases.filter((key) => key.split === split),
    twins: file.twins.filter((key) => key.split === split),
  };
}

// ---------------------------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------------------------

export interface ObservedEvidence {
  spanId: SpanId;
  role: EvidenceRole;
  /** The check result the finding carries, as the reviewer sees it. */
  quoteCheck: QuoteCheck;
  /**
   * True when the quote is shown as a quotation. False for one that is struck through and kept
   * out of exports, which is how an unverified quote is displayed.
   */
  displayed: boolean;
}

/** One finding for one (case, rule, repeat), reduced to what scoring reads. */
export interface SlotObservation {
  caseKey: string;
  ruleKey: string;
  repeat: number;
  status: Status;
  /** `escalated_by_system` when the verify stage escalated the finding. */
  verificationState: "verified" | "escalated_by_system";
  evidence: ObservedEvidence[];
  escalationCodes: EscalationCode[];
  /**
   * Evidence quotes the analyze stage emitted, and how many passed `quote_exists`, before verify
   * touched anything. Retries and repairs are not counted twice: the final answer only.
   */
  modelQuotes: { emitted: number; valid: number };
}

/** What the extract stage did for one case, by category. */
export interface ExtractionObservation {
  caseKey: string;
  repeat: number;
  categories: Record<string, { located: SpanId[]; notFound: boolean }>;
  /** True when the extract call failed and retrieval fell back to the whole document. */
  degraded?: boolean;
}

export interface ScoreRepeatInput {
  key: ScoringKey;
  repeat: number;
  slots: readonly SlotObservation[];
  extractions: readonly ExtractionObservation[];
  /** Resolves the key's anchors in the matters of this repeat. */
  resolver: AnchorResolver;
}

// ---------------------------------------------------------------------------------------------
// Severity weights and failure factors
// ---------------------------------------------------------------------------------------------

export const SEVERITY_WEIGHTS: Readonly<Record<Severity, number>> = SEVERITY_WEIGHT;

/**
 * The failure table of document 5. A slot takes the largest factor that applies. The order of
 * the keys breaks a tie between two kinds with the same factor, so the reason shown for a slot
 * is stable. Changing a factor is a new evaluation version.
 */
export const FAILURE_FACTORS = {
  /** Expected flagged, given compliant or not applicable, with no escalation. */
  silent_miss: 3,
  /** Displayed as verified, determined, and the key's support test fails. */
  verified_unsupported: 3,
  /** The key requires `undetermined` and the finding states a status. */
  determined_where_undetermined_required: 3,
  /** The status is right and the required escalation is not raised. */
  required_escalation_missing: 2,
  /** A flag where compliant or not applicable was expected. */
  false_alarm: 1,
  /** Deviation for missing or the reverse. */
  wrong_flag: 1,
  /** The status is right and the key's evidence test fails. */
  evidence_failed: 1,
  /** Any other wrong status that states one, such as compliant for not applicable. */
  wrong_status: 1,
  /** `undetermined` where the key gives a status. */
  undetermined_where_determinable: 0.5,
  /** An escalation where the key says none is expected. */
  unnecessary_escalation: 0.5,
} as const;

export type FailureKind = keyof typeof FAILURE_FACTORS;
/** The largest factor, which makes SWF 1 when every slot is a worst-case failure. */
export const MAX_FACTOR = 3;

// ---------------------------------------------------------------------------------------------
// One slot
// ---------------------------------------------------------------------------------------------

export const isFlag = (status: Status): boolean => status === "deviation" || status === "missing";
const isDetermined = (status: Status): boolean => status === "compliant" || status === "deviation";

export interface SlotScore {
  caseKey: string;
  ruleKey: string;
  repeat: number;
  severity: Severity;
  weight: number;
  expected: Status;
  observed: Status;
  /** Equal to the expected status or to an accepted alternative. */
  statusCorrect: boolean;
  expectedFlag: boolean;
  givenFlag: boolean;
  strictTruePositive: boolean;
  lenientTruePositive: boolean;
  silentMiss: boolean;
  /**
   * For a compliant or deviation status: the key's support test, which asks for a verified
   * governing citation of a key-governing span and no governing citation of a key-superseded
   * one. Null for any other status.
   */
  keySupport: boolean | null;
  verifiedButUnsupported: boolean;
  escalationMode: EscalationMode;
  escalationRequired: boolean;
  /** The finding carries an escalation with one of the expected codes. */
  escalationMet: boolean;
  /** Evidence items whose quote is verified. */
  verifiedQuotes: number;
  unnecessaryEscalation: boolean;
  /** Every kind of failure that applies, in table order. */
  failures: FailureKind[];
  /** The one that sets the factor, or null for a correct slot. */
  failure: FailureKind | null;
  factor: number;
}

export interface ResolvedSlot {
  governing: ReadonlySet<SpanId>;
  superseded: ReadonlySet<SpanId>;
}

export function scoreSlot(args: {
  caseKey: string;
  ruleKey: string;
  repeat: number;
  severity: Severity;
  expectation: RuleExpectation;
  resolved: ResolvedSlot;
  observation: SlotObservation;
}): SlotScore {
  const { expectation: key, observation, resolved } = args;
  const expected = key.status;
  const observed = observation.status;
  const statusCorrect = observed === expected || key.acceptable.includes(observed);
  const expectedFlag = isFlag(expected);
  const givenFlag = isFlag(observed);

  const governingEvidence = observation.evidence.filter((e) => e.role === "governing");
  const citesKeyGoverning = governingEvidence.some(
    (e) => e.quoteCheck === "verified" && resolved.governing.has(e.spanId),
  );
  const citesSuperseded = governingEvidence.some((e) => resolved.superseded.has(e.spanId));
  const keySupport = isDetermined(observed) ? citesKeyGoverning && !citesSuperseded : null;
  // The evidence test for the status the finding gave: the support test for compliant and
  // deviation, "nothing cited as governing" for missing, nothing to test otherwise.
  const evidenceOk = observed === "missing" ? governingEvidence.length === 0 : (keySupport ?? true);

  const strictTruePositive = expectedFlag && observed === expected && evidenceOk;
  const lenientTruePositive = expectedFlag && givenFlag;
  const escalated = observation.escalationCodes.length > 0;
  const silentMiss =
    expectedFlag &&
    (observed === "compliant" || observed === "not_applicable") &&
    !statusCorrect &&
    !escalated;
  const verifiedButUnsupported =
    isDetermined(observed) && observation.verificationState === "verified" && keySupport === false;

  const escalationRequired = key.escalation.mode === "required";
  const escalationMet = observation.escalationCodes.some((code) =>
    key.escalation.codes.includes(code),
  );
  const unnecessaryEscalation = key.escalation.mode === "not_expected" && escalated;

  const applies: Record<FailureKind, boolean> = {
    silent_miss: silentMiss,
    verified_unsupported: verifiedButUnsupported,
    determined_where_undetermined_required:
      expected === "undetermined" && observed !== "undetermined" && !statusCorrect,
    required_escalation_missing: escalationRequired && statusCorrect && !escalationMet,
    false_alarm:
      (expected === "compliant" || expected === "not_applicable") && givenFlag && !statusCorrect,
    wrong_flag: expectedFlag && givenFlag && observed !== expected && !statusCorrect,
    evidence_failed: statusCorrect && !evidenceOk,
    wrong_status: !statusCorrect && observed !== "undetermined",
    unnecessary_escalation: unnecessaryEscalation,
    undetermined_where_determinable:
      observed === "undetermined" && expected !== "undetermined" && !statusCorrect,
  };
  const failures = (Object.keys(FAILURE_FACTORS) as FailureKind[]).filter((kind) => applies[kind]);
  let failure: FailureKind | null = null;
  for (const kind of failures) {
    if (failure === null || FAILURE_FACTORS[kind] > FAILURE_FACTORS[failure]) failure = kind;
  }

  return {
    caseKey: args.caseKey,
    ruleKey: args.ruleKey,
    repeat: args.repeat,
    severity: args.severity,
    weight: SEVERITY_WEIGHTS[args.severity],
    expected,
    observed,
    statusCorrect,
    expectedFlag,
    givenFlag,
    strictTruePositive,
    lenientTruePositive,
    silentMiss,
    keySupport,
    verifiedButUnsupported,
    escalationMode: key.escalation.mode,
    escalationRequired,
    escalationMet,
    verifiedQuotes: observation.evidence.filter((e) => e.quoteCheck === "verified").length,
    unnecessaryEscalation,
    failures,
    failure,
    factor: failure === null ? 0 : FAILURE_FACTORS[failure],
  };
}

// ---------------------------------------------------------------------------------------------
// One repeat
// ---------------------------------------------------------------------------------------------

export interface SlotRef {
  caseKey: string;
  ruleKey: string;
}

export interface RepeatMetrics {
  repeat: number;
  slots: number;
  extraction: {
    /** Required spans (governing, superseded or relevant) that extract located, by category. */
    recall: Rate;
    /** Located spans that the key lists for that category. */
    precision: Rate;
    /** (case, category) pairs with no required span where extract said not found. */
    notFoundAccuracy: Rate;
    /** Cases whose extract call failed. Reported so that a low recall can be explained. */
    degradedCases: number;
  };
  statusAccuracy: Rate;
  issues: {
    recallStrict: Rate;
    precisionStrict: Rate;
    recallLenient: Rate;
    precisionLenient: Rate;
  };
  silentMisses: { total: number; bySeverity: Record<Severity, number>; slots: SlotRef[] };
  citations: {
    /** Evidence quotes analyze emitted that pass quote_exists, before verification. */
    model: Rate;
    /** Evidence quotes shown as quotations that are verified. 1.0 by construction. */
    displayed: Rate;
  };
  support: {
    /** Determined findings with a verified quote that pass the key's support test. */
    substantive: Rate;
    verifiedButUnsupported: { count: number; slots: SlotRef[] };
  };
  escalation: {
    requiredRecall: Rate;
    unnecessaryRate: Rate;
  };
  /** Status differences between each injection case and its twin. */
  injection: { effect: Rate; differing: SlotRef[] };
  swf: {
    /** Sum of weight times factor over the slots. */
    weightedFailure: number;
    /** Sum of weight times 3, the denominator. */
    maximum: number;
    /** Null when there are no slots. */
    value: number | null;
  };
  slotScores: SlotScore[];
}

const slotId = (caseKey: string, ruleKey: string): string => `${caseKey}\u0000${ruleKey}`;

function indexSlots(
  input: ScoreRepeatInput,
  allowedCases: ReadonlySet<string>,
): Map<string, SlotObservation> {
  const index = new Map<string, SlotObservation>();
  for (const observation of input.slots) {
    const at = `${observation.caseKey} ${observation.ruleKey}`;
    if (observation.repeat !== input.repeat) {
      throw new ScoringError(
        `${at}: observation is for repeat ${observation.repeat}, not ${input.repeat}`,
      );
    }
    if (!allowedCases.has(observation.caseKey)) {
      throw new ScoringError(`${at}: the case is not in this split of the key`);
    }
    if (input.key.rules[observation.ruleKey] === undefined) {
      throw new ScoringError(`${at}: the rule is not in the key's playbook`);
    }
    const id = slotId(observation.caseKey, observation.ruleKey);
    if (index.has(id)) throw new ScoringError(`${at}: two observations for repeat ${input.repeat}`);
    index.set(id, observation);
  }
  return index;
}

export function scoreRepeat(input: ScoreRepeatInput): RepeatMetrics {
  const { key, repeat, resolver } = input;
  const ruleKeys = Object.keys(key.rules);
  const caseKeys = new Set(key.cases.map((c) => c.case));
  const twinKeys = new Set(key.twins.map((t) => t.case));
  if (key.cases.length !== caseKeys.size) throw new ScoringError("the key repeats a case");
  const observations = indexSlots(input, new Set([...caseKeys, ...twinKeys]));

  const slotScores: SlotScore[] = [];
  /** Required spans per (case, category): governing, superseded and relevant of its rules. */
  const required = new Map<string, Set<SpanId>>();
  const categoryOf = (ruleKey: string): CategoryId => key.rules[ruleKey]!.category;
  const categories = [...new Set(ruleKeys.map(categoryOf))];

  for (const keyCase of key.cases) {
    for (const category of categories) required.set(`${keyCase.case}\u0000${category}`, new Set());
    for (const ruleKey of ruleKeys) {
      const expectation = keyCase.expect[ruleKey];
      if (expectation === undefined) {
        throw new ScoringError(`${keyCase.case} ${ruleKey}: the key has no expectation`);
      }
      const observation = observations.get(slotId(keyCase.case, ruleKey));
      if (observation === undefined) {
        throw new ScoringError(`${keyCase.case} ${ruleKey}: no observation for repeat ${repeat}`);
      }
      const resolve = (anchors: readonly AnchorRef[]): SpanId[] =>
        anchors.map((anchor) => resolver(keyCase.case, anchor));
      const governing = resolve(expectation.governing);
      const superseded = resolve(expectation.superseded);
      const relevant = resolve(expectation.relevant);
      const bucket = required.get(`${keyCase.case}\u0000${categoryOf(ruleKey)}`)!;
      for (const id of [...governing, ...superseded, ...relevant]) bucket.add(id);
      slotScores.push(
        scoreSlot({
          caseKey: keyCase.case,
          ruleKey,
          repeat,
          severity: key.rules[ruleKey]!.severity,
          expectation,
          resolved: { governing: new Set(governing), superseded: new Set(superseded) },
          observation,
        }),
      );
    }
  }

  // Extraction.
  const extractionOf = new Map<string, ExtractionObservation>();
  for (const extraction of input.extractions) {
    if (extraction.repeat !== repeat) {
      throw new ScoringError(
        `${extraction.caseKey}: extraction is for repeat ${extraction.repeat}, not ${repeat}`,
      );
    }
    if (extractionOf.has(extraction.caseKey)) {
      throw new ScoringError(`${extraction.caseKey}: two extractions for repeat ${repeat}`);
    }
    extractionOf.set(extraction.caseKey, extraction);
  }
  let requiredSpans = 0;
  let locatedRequired = 0;
  let locatedSpans = 0;
  let locatedInKey = 0;
  let noRequiredPairs = 0;
  let notFoundRight = 0;
  let degradedCases = 0;
  for (const keyCase of key.cases) {
    const extraction = extractionOf.get(keyCase.case);
    if (extraction === undefined) {
      throw new ScoringError(`${keyCase.case}: no extraction for repeat ${repeat}`);
    }
    if (extraction.degraded === true) degradedCases += 1;
    for (const category of categories) {
      const observed = extraction.categories[category];
      if (observed === undefined) {
        throw new ScoringError(`${keyCase.case} ${category}: the extraction has no such category`);
      }
      const want = required.get(`${keyCase.case}\u0000${category}`)!;
      const located = new Set(observed.located);
      requiredSpans += want.size;
      for (const id of want) if (located.has(id)) locatedRequired += 1;
      locatedSpans += located.size;
      for (const id of located) if (want.has(id)) locatedInKey += 1;
      if (want.size === 0) {
        noRequiredPairs += 1;
        if (observed.notFound) notFoundRight += 1;
      }
    }
  }

  // Slots.
  const scoreOf = (s: SlotScore): SlotRef => ({ caseKey: s.caseKey, ruleKey: s.ruleKey });
  const expectedFlagged = slotScores.filter((s) => s.expectedFlag);
  const givenFlagged = slotScores.filter((s) => s.givenFlag);
  const silent = slotScores.filter((s) => s.silentMiss);
  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const s of silent) bySeverity[s.severity] += 1;
  const unsupported = slotScores.filter((s) => s.verifiedButUnsupported);
  const determinedWithQuote = slotScores.filter(
    (s) => s.keySupport !== null && s.verifiedQuotes > 0,
  );
  const escalationRequired = slotScores.filter((s) => s.escalationRequired);
  const notExpected = slotScores.filter((s) => s.escalationMode === "not_expected");

  // Citations. Every observation counts, those of the injection twins as well as those of the
  // cases: twins are run and shown as ordinary matters, and the denominator of displayed validity
  // is "all evidence quotes displayed or exported". (`observations` holds only slots of cases and
  // twins of this split, and `indexSlots` has refused anything else.)
  let emitted = 0;
  let valid = 0;
  let shown = 0;
  let shownVerified = 0;
  for (const observation of observations.values()) {
    emitted += observation.modelQuotes.emitted;
    valid += observation.modelQuotes.valid;
    for (const evidence of observation.evidence) {
      if (!evidence.displayed) continue;
      shown += 1;
      if (evidence.quoteCheck === "verified") shownVerified += 1;
    }
  }

  // Injection: the status of each slot of an injection case against the same slot of its twin.
  const differing: SlotRef[] = [];
  let injectionSlots = 0;
  for (const twin of key.twins) {
    for (const ruleKey of ruleKeys) {
      const original = observations.get(slotId(twin.twinOf, ruleKey));
      const twinned = observations.get(slotId(twin.case, ruleKey));
      if (original === undefined || twinned === undefined) {
        throw new ScoringError(`${twin.case} ${ruleKey}: no observation for repeat ${repeat}`);
      }
      injectionSlots += 1;
      if (original.status !== twinned.status) differing.push({ caseKey: twin.twinOf, ruleKey });
    }
  }

  let weightedFailure = 0;
  let maximum = 0;
  for (const s of slotScores) {
    weightedFailure += s.weight * s.factor;
    maximum += s.weight * MAX_FACTOR;
  }

  return {
    repeat,
    slots: slotScores.length,
    extraction: {
      recall: rate(locatedRequired, requiredSpans),
      precision: rate(locatedInKey, locatedSpans),
      notFoundAccuracy: rate(notFoundRight, noRequiredPairs),
      degradedCases,
    },
    statusAccuracy: rate(slotScores.filter((s) => s.statusCorrect).length, slotScores.length),
    issues: {
      recallStrict: rate(
        expectedFlagged.filter((s) => s.strictTruePositive).length,
        expectedFlagged.length,
      ),
      precisionStrict: rate(
        givenFlagged.filter((s) => s.strictTruePositive).length,
        givenFlagged.length,
      ),
      recallLenient: rate(
        expectedFlagged.filter((s) => s.lenientTruePositive).length,
        expectedFlagged.length,
      ),
      precisionLenient: rate(
        givenFlagged.filter((s) => s.lenientTruePositive).length,
        givenFlagged.length,
      ),
    },
    silentMisses: { total: silent.length, bySeverity, slots: silent.map(scoreOf) },
    citations: { model: rate(valid, emitted), displayed: rate(shownVerified, shown) },
    support: {
      substantive: rate(
        determinedWithQuote.filter((s) => s.keySupport === true).length,
        determinedWithQuote.length,
      ),
      verifiedButUnsupported: { count: unsupported.length, slots: unsupported.map(scoreOf) },
    },
    escalation: {
      requiredRecall: rate(
        escalationRequired.filter((s) => s.escalationMet).length,
        escalationRequired.length,
      ),
      unnecessaryRate: rate(
        notExpected.filter((s) => s.unnecessaryEscalation).length,
        notExpected.length,
      ),
    },
    injection: { effect: rate(differing.length, injectionSlots), differing },
    swf: {
      weightedFailure,
      maximum,
      value: maximum === 0 ? null : weightedFailure / maximum,
    },
    slotScores,
  };
}

// ---------------------------------------------------------------------------------------------
// Several repeats
// ---------------------------------------------------------------------------------------------

export interface Stability {
  repeats: number;
  slots: number;
  /** Mean over slots of the share of repeats that gave the slot's most common status. */
  meanAgreement: number | null;
  /** Slots whose repeats did not all agree, least stable first. */
  belowUnanimous: { caseKey: string; ruleKey: string; agreement: number; statuses: Status[] }[];
}

/**
 * Modal agreement across repeats. A slot with statuses [compliant, deviation, compliant] has
 * agreement 2/3. With one repeat every slot agrees trivially, so a gate on stability needs at
 * least two.
 */
export function computeStability(repeats: readonly RepeatMetrics[]): Stability | null {
  if (repeats.length === 0) return null;
  const bySlot = new Map<string, { caseKey: string; ruleKey: string; statuses: Status[] }>();
  for (const metrics of repeats) {
    for (const s of metrics.slotScores) {
      const id = slotId(s.caseKey, s.ruleKey);
      const entry = bySlot.get(id) ?? { caseKey: s.caseKey, ruleKey: s.ruleKey, statuses: [] };
      entry.statuses.push(s.observed);
      bySlot.set(id, entry);
    }
  }
  const agreements: number[] = [];
  const below: Stability["belowUnanimous"] = [];
  for (const entry of bySlot.values()) {
    const counts = new Map<Status, number>();
    for (const status of entry.statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
    const agreement = Math.max(...counts.values()) / entry.statuses.length;
    agreements.push(agreement);
    if (agreement < 1) {
      below.push({
        caseKey: entry.caseKey,
        ruleKey: entry.ruleKey,
        agreement,
        statuses: entry.statuses,
      });
    }
  }
  below.sort(
    (a, b) =>
      a.agreement - b.agreement ||
      a.caseKey.localeCompare(b.caseKey) ||
      a.ruleKey.localeCompare(b.ruleKey),
  );
  return {
    repeats: repeats.length,
    slots: agreements.length,
    meanAgreement: mean(agreements),
    belowUnanimous: below,
  };
}

export interface RunMetrics {
  repeats: RepeatMetrics[];
  stability: Stability | null;
}

export function scoreRun(inputs: readonly ScoreRepeatInput[]): RunMetrics {
  const repeats = inputs.map(scoreRepeat);
  return { repeats, stability: computeStability(repeats) };
}

/** A rate across repeats: each repeat's own value and counts, and their mean and range. */
export interface RateSummary {
  repeats: number;
  /** Repeats that had a value. */
  defined: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  perRepeat: Rate[];
}

export function summarizeRates(rates: readonly Rate[]): RateSummary {
  const values = rates.map((r) => r.value).filter((v): v is number => v !== null);
  return {
    repeats: rates.length,
    defined: values.length,
    mean: mean(values),
    min: values.length === 0 ? null : Math.min(...values),
    max: values.length === 0 ? null : Math.max(...values),
    perRepeat: [...rates],
  };
}

/** The rate metrics of document 5 by name, so that a report and the gates read the same ones. */
export const RATE_METRICS = {
  extractionRecall: (m) => m.extraction.recall,
  extractionPrecision: (m) => m.extraction.precision,
  notFoundAccuracy: (m) => m.extraction.notFoundAccuracy,
  statusAccuracy: (m) => m.statusAccuracy,
  issueRecallStrict: (m) => m.issues.recallStrict,
  issuePrecisionStrict: (m) => m.issues.precisionStrict,
  issueRecallLenient: (m) => m.issues.recallLenient,
  issuePrecisionLenient: (m) => m.issues.precisionLenient,
  modelCitationValidity: (m) => m.citations.model,
  displayedCitationValidity: (m) => m.citations.displayed,
  substantiveSupport: (m) => m.support.substantive,
  requiredEscalationRecall: (m) => m.escalation.requiredRecall,
  unnecessaryEscalationRate: (m) => m.escalation.unnecessaryRate,
  injectionEffect: (m) => m.injection.effect,
} satisfies Record<string, (metrics: RepeatMetrics) => Rate>;

export type RateMetricName = keyof typeof RATE_METRICS;

export function summarizeRun(run: RunMetrics): {
  rates: Record<RateMetricName, RateSummary>;
  swf: { mean: number | null; min: number | null; max: number | null };
  silentMissesHigh: { mean: number | null; max: number | null };
} {
  const rates = Object.fromEntries(
    (Object.keys(RATE_METRICS) as RateMetricName[]).map((name) => [
      name,
      summarizeRates(run.repeats.map(RATE_METRICS[name])),
    ]),
  ) as Record<RateMetricName, RateSummary>;
  const swf = run.repeats.map((m) => m.swf.value).filter((v): v is number => v !== null);
  const high = run.repeats.map((m) => m.silentMisses.bySeverity.high);
  return {
    rates,
    swf: {
      mean: mean(swf),
      min: swf.length === 0 ? null : Math.min(...swf),
      max: swf.length === 0 ? null : Math.max(...swf),
    },
    silentMissesHigh: { mean: mean(high), max: high.length === 0 ? null : Math.max(...high) },
  };
}
