import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SourceSpan } from "../../apps/parol/src/contracts.js";
import type { AnswerKeyFile } from "../../fixtures/parol/types.js";
import { parseDocx } from "../../packages/docx/src/index.js";
import { createResolver, type AnchorResolver } from "../src/parol/anchors.js";
import { evaluateGates } from "../src/parol/gates.js";
import {
  RATE_METRICS,
  scoreRun,
  scoreSlot,
  scoringKey,
  summarizeRun,
  type RateMetricName,
  type ScoringKey,
} from "../src/parol/score.js";
import {
  oracleObservations,
  paragraphsFromTxt,
  spansFromParagraphs,
} from "../src/parol/testing.js";

/**
 * An ideal pipeline against the committed answer key and the committed files. The files are read
 * and segmented by the real parsers, so a resolver that works here works on the documents that a
 * run will ingest. This is not the pipeline selftest, which runs the stages against a scripted
 * model and comes with the runner; it shows the scorer and the key agree with each other.
 */
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "parol");
const file: AnswerKeyFile = JSON.parse(readFileSync(join(DIR, "answer-keys.json"), "utf8"));

/** The spans of every case, with span ids of their own for each repeat, as separate matters have. */
async function resolverFor(repeat: number, key: ScoringKey): Promise<AnchorResolver> {
  const spansByCase: Record<string, SourceSpan[]> = {};
  for (const entry of [...key.cases, ...key.twins]) {
    const spans: SourceSpan[] = [];
    for (const doc of entry.documents) {
      const bytes = new Uint8Array(readFileSync(join(DIR, "files", doc.file)));
      const paragraphs = doc.file.endsWith(".docx")
        ? (await parseDocx(bytes)).paragraphs
        : paragraphsFromTxt(bytes);
      spans.push(
        ...spansFromParagraphs({
          docLabel: doc.label,
          documentVersionId: `dv_r${repeat}_${entry.case}_${doc.label}`,
          paragraphs,
          firstModelNumber: spans.length + 1,
        }),
      );
    }
    spansByCase[entry.case] = spans;
  }
  return createResolver(spansByCase);
}

async function score(key: ScoringKey, observedFrom: ScoringKey = key, repeats = 3) {
  const inputs = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    const resolver = await resolverFor(repeat, key);
    // The observations are made from `observedFrom`, the key as the pipeline "knew" it, and
    // scored against `key`. When they are the same key the pipeline is perfect.
    const observed = oracleObservations(observedFrom, resolver, repeat);
    inputs.push({ key, repeat, ...observed, resolver });
  }
  return scoreRun(inputs);
}

describe("an ideal pipeline scored against the committed key", () => {
  const key = scoringKey(file, "dev");

  it("answers every slot correctly, in every repeat", async () => {
    const run = await score(key);
    expect(run.repeats).toHaveLength(3);
    for (const m of run.repeats) {
      expect(m.slots).toBe(48);
      expect(m.statusAccuracy).toMatchObject({ numerator: 48, denominator: 48, value: 1 });
      expect(m.slotScores.every((s) => s.failure === null)).toBe(true);
    }
  });

  it("scores 1 on every rate that has a denominator, and 0 on the rates that count faults", async () => {
    const [m] = (await score(key)).repeats;
    // 6 expected flags, all found with a verified governing citation.
    expect(m!.issues.recallStrict).toMatchObject({ numerator: 6, denominator: 6 });
    expect(m!.issues.precisionStrict).toMatchObject({ numerator: 6, denominator: 6 });
    expect(m!.issues.recallLenient.value).toBe(1);
    expect(m!.issues.precisionLenient.value).toBe(1);
    // 3 required escalations: D06 gov-1, D08 dur-1, D12 pty-1.
    expect(m!.escalation.requiredRecall).toMatchObject({ numerator: 3, denominator: 3 });
    // Every slot but those three says not_expected, and the oracle raises nothing there.
    expect(m!.escalation.unnecessaryRate).toMatchObject({ numerator: 0, denominator: 45 });
    // The twin of D08 answers like D08: no slot differs, out of 8.
    expect(m!.injection.effect).toMatchObject({ numerator: 0, denominator: 8 });
    expect(m!.silentMisses.total).toBe(0);
    expect(m!.support.verifiedButUnsupported.count).toBe(0);
    expect(m!.citations.model.value).toBe(1);
    expect(m!.citations.displayed.value).toBe(1);
    expect(m!.extraction.recall.value).toBe(1);
    expect(m!.extraction.precision.value).toBe(1);
    // D03 has no required span for governing-law and none for return-destruction.
    expect(m!.extraction.notFoundAccuracy).toMatchObject({ numerator: 2, denominator: 2 });
    expect(m!.swf).toEqual({ weightedFailure: 0, maximum: m!.swf.maximum, value: 0 });
    // The weights of the eight rules of one case add up to 26 (two high rules at 5, five medium
    // at 3, one low at 1), so six cases weigh 156, and the largest factor is 3.
    expect(m!.swf.maximum).toBe(3 * 156);
  });

  it("is stable, and passes every gate that a single split can be asked", async () => {
    const run = await score(key);
    expect(run.stability).toMatchObject({ repeats: 3, slots: 48, meanAgreement: 1 });
    const report = evaluateGates({ run });
    for (const id of ["G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G14"] as const) {
      expect(report.results.find((r) => r.id === id)!.outcome, id).toBe("pass");
    }
    // Exposure, calibration, and the comparisons with a baseline were not run.
    expect(report.failed).toEqual([]);
    expect(report.notEvaluated).toEqual(["G1", "G11", "G12", "G13"]);
    const summary = summarizeRun(run);
    for (const name of Object.keys(RATE_METRICS) as RateMetricName[]) {
      const rates = summary.rates[name];
      if (name === "unnecessaryEscalationRate" || name === "injectionEffect") {
        expect(rates.max, name).toBe(0);
      } else {
        expect(rates.min, name).toBe(1);
      }
    }
  });

  it("resolves the amendment's clauses to the amendment and the NDA's to the NDA", async () => {
    const resolver = await resolverFor(0, key);
    const d05 = file.cases.find((c) => c.case === "PAROL-D05")!;
    const dur = d05.expect["dur-1"]!;
    expect(resolver("PAROL-D05", dur.governing[0]!)).toBe("dv_r0_PAROL-D05_D2:p3");
    expect(resolver("PAROL-D05", dur.superseded[0]!)).toBe("dv_r0_PAROL-D05_D1:p19");
    expect(resolver("PAROL-D05", dur.relevant[0]!)).toBe("dv_r0_PAROL-D05_D1:p29");
  });
});

describe("PAROL-D05 ret-1, scored on the real documents", () => {
  const key = scoringKey(file, "dev");
  const d05 = file.cases.find((c) => c.case === "PAROL-D05")!;
  const ret = d05.expect["ret-1"]!;
  const backupCarveOut = {
    doc: "D1" as const,
    clause: "7.2",
    anchor: "except for copies required by law or held in routine backup systems",
  };

  /** Scores a compliant ret-1 finding that cites the given passages as governing, all verified. */
  async function scored(cites: ("amendment" | "backup")[]) {
    const resolver = await resolverFor(0, key);
    const spanOf = {
      amendment: resolver("PAROL-D05", d05.expect["ret-1"]!.governing[0]!),
      backup: resolver("PAROL-D05", backupCarveOut),
    };
    return scoreSlot({
      caseKey: "PAROL-D05",
      ruleKey: "ret-1",
      repeat: 0,
      severity: key.rules["ret-1"]!.severity,
      expectation: ret,
      resolved: {
        governing: new Set(ret.governing.map((a) => resolver("PAROL-D05", a))),
        superseded: new Set(ret.superseded.map((a) => resolver("PAROL-D05", a))),
      },
      observation: {
        caseKey: "PAROL-D05",
        ruleKey: "ret-1",
        repeat: 0,
        status: "compliant",
        verificationState: "verified",
        evidence: cites.map((name) => ({
          spanId: spanOf[name],
          role: "governing" as const,
          quoteCheck: "verified" as const,
          displayed: true,
        })),
        escalationCodes: [],
        modelQuotes: { emitted: cites.length, valid: cites.length },
      },
    });
  }

  it("supports a correct finding that cites the amendment and the still operative backup carve-out", async () => {
    // Amendment No. 1 clause 3 replaces only "ten (10) business days". The backup carve-out of
    // 7.2 is a ret-1 standard element and is written nowhere else, so a complete answer cites it.
    const score = await scored(["amendment", "backup"]);
    expect(score.keySupport).toBe(true);
    expect(score.verifiedButUnsupported).toBe(false);
    expect(score.failure).toBeNull();
  });

  it("supports a finding that cites the amendment alone", async () => {
    expect((await scored(["amendment"])).failure).toBeNull();
  });

  it("still does not support compliant on the unamended 7.2 alone, which gives ten business days", async () => {
    const score = await scored(["backup"]);
    expect(score.keySupport).toBe(false);
    expect(score.failure).toBe("verified_unsupported");
  });
});

describe("altering the answer key changes the score", () => {
  const clone = (): AnswerKeyFile => structuredClone(file);
  const dev = (f: AnswerKeyFile): ScoringKey => scoringKey(f, "dev");

  async function against(altered: AnswerKeyFile) {
    return (await score(dev(altered), dev(file), 1)).repeats[0]!;
  }

  it("a status changed in one entry is no longer matched", async () => {
    const altered = clone();
    altered.cases.find((c) => c.case === "PAROL-D05")!.expect["dur-1"]!.status = "compliant";
    const m = await against(altered);
    expect(m.statusAccuracy.numerator).toBe(47);
    expect(
      m.slotScores.find((s) => s.caseKey === "PAROL-D05" && s.ruleKey === "dur-1")!.failure,
    ).toBe("false_alarm");
    // The key now expects 5 flags, and the ideal pipeline's sixth is a false alarm.
    expect(m.issues.recallStrict).toMatchObject({ numerator: 5, denominator: 5 });
    expect(m.issues.precisionStrict).toMatchObject({ numerator: 5, denominator: 6 });
    expect(m.swf.value).toBeGreaterThan(0);
  });

  it("an anchor moved to another paragraph is no longer cited", async () => {
    const altered = clone();
    const dur = altered.cases.find((c) => c.case === "PAROL-D05")!.expect["dur-1"]!;
    dur.governing = [
      { doc: "D2", clause: "3", anchor: "Section 7.2 of the Agreement", paragraph: 4 },
    ];
    const m = await against(altered);
    expect(m.issues.recallStrict).toMatchObject({ numerator: 5, denominator: 6 });
    expect(
      m.slotScores.find((s) => s.caseKey === "PAROL-D05" && s.ruleKey === "dur-1")!.failure,
    ).toBe("verified_unsupported");
    expect(m.support.verifiedButUnsupported.count).toBe(1);
  });

  it("an escalation no longer expected is unnecessary, and one newly required is missed", async () => {
    const unexpected = clone();
    unexpected.cases.find((c) => c.case === "PAROL-D12")!.expect["pty-1"]!.escalation = {
      mode: "not_expected",
      codes: [],
    };
    expect((await against(unexpected)).escalation.unnecessaryRate).toMatchObject({
      numerator: 1,
      denominator: 46,
    });
    const newlyRequired = clone();
    newlyRequired.cases.find((c) => c.case === "PAROL-D01")!.expect["gov-1"]!.escalation = {
      mode: "required",
      codes: ["playbook_escalation"],
    };
    const m = await against(newlyRequired);
    expect(m.escalation.requiredRecall).toMatchObject({ numerator: 3, denominator: 4 });
    expect(
      m.slotScores.find((s) => s.caseKey === "PAROL-D01" && s.ruleKey === "gov-1")!.failure,
    ).toBe("required_escalation_missing");
  });

  it("a document that no longer contains the anchor stops the scoring instead of scoring a miss", async () => {
    const altered = clone();
    altered.cases.find((c) => c.case === "PAROL-D01")!.expect["gov-1"]!.governing[0]!.anchor =
      "laws of the State of Texas";
    await expect(against(altered)).rejects.toThrow(
      "anchor in PAROL-D01 D1 clause 7.1: it occurs 0 times, expected once",
    );
  });
});
