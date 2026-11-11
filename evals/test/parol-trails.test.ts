import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ModelRequestError } from "@clausewise/llm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  CheckResult,
  ContextBundle,
  SourceSpan,
  VerifiedEvidence,
  VerifiedFinding,
} from "../../apps/parol/src/contracts.js";
import { documentTextSha256 } from "../../apps/parol/src/ingest/text-hash.js";
import { workflowFor } from "../../apps/parol/src/prompts/workflows.js";
import { CHECK_IDS } from "../../apps/parol/src/server/views/labels.js";
import { loadDataset, selectCases, type Dataset } from "../src/parol/dataset.js";
import { createKeyOracle } from "../src/parol/oracle.js";
import {
  assembleResults,
  parseResults,
  serialiseResults,
  type ObservedRun,
  type ResultsFile,
} from "../src/parol/results.js";
import { RECORDING_SUFFIX } from "../src/parol/replay.js";
import {
  observeRun,
  prepareCase,
  readCaseDocuments,
  runStages,
  runnableCases,
  type ParsedFiles,
} from "../src/parol/runner.js";
import {
  MAX_CHECK_IDS,
  MAX_CITED,
  MAX_SHOWN_SPANS,
  MAX_TRAIL_ITEMS,
  TRAILS_DISAGREE_NOTE,
  TRAILS_TOO_MANY_NOTE,
  TRAILS_UNDATED_NOTE,
  TrailError,
  buildTrailRecord,
  textDigestOf,
  trailOf,
  trailRecordOf,
  trailRecordSchema,
  type SlotTrail,
} from "../src/parol/trails.js";
import {
  REPO_ROOT,
  containsDocumentText,
  documentWindows,
  makeTempDir,
  oracleFactory,
  readResults,
  removeDir,
  run,
} from "../src/parol/testing-run.js";
import { loadWorld, readCase, simulatedRun } from "./parol-page-support.js";

/**
 * The evidence trails of an evaluation run: what retrieval showed, what each finding cited, which
 * checks passed and failed, in the results file and read back from it. Every run here is scripted:
 * the demo's simulated reader, the key oracle, or a scripted stand-in for a live provider. Nothing
 * is sent anywhere, no key is read, and a number from a stand-in says nothing about any model.
 * Findings and bundles built by hand in this file are FABRICATED FOR A TEST where they are made.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let dir = "";
let n = 0;
let world: Awaited<ReturnType<typeof loadWorld>>;
let v1: ResultsFile;
let v2: ResultsFile;
let v2Text = "";

beforeAll(async () => {
  dir = await makeTempDir();
  world = await loadWorld();
  const first = await simulatedRun(dir, "sim-v1.json", "v1");
  const second = await simulatedRun(dir, "sim-v2.json", "v2");
  v1 = await readResults(first);
  v2 = await readResults(second);
  v2Text = await readFile(second, "utf8");
});
afterAll(async () => {
  await removeDir(dir);
});

const fresh = async (): Promise<string> => {
  const path = join(dir, `res-${++n}`);
  await mkdir(path, { recursive: true });
  return path;
};

/** Runs the stages over one runnable case with the key oracle and observes the run, as the command does. */
async function observeCase(args: {
  dataset: Dataset;
  split: "dev" | "heldout";
  runnable: ReturnType<typeof runnableCases>[number];
  workflow: ReturnType<typeof workflowFor>;
  parsed: ParsedFiles;
  repeat?: number;
}): Promise<{ run: ObservedRun; bundles: ContextBundle[]; findings: VerifiedFinding[] }> {
  const { runnable, workflow } = args;
  const prepared = await prepareCase({
    dataset: args.dataset,
    runnable,
    repeat: args.repeat ?? 1,
    playbook: world.playbook,
    workflow,
    parsed: args.parsed,
  });
  const generator = createKeyOracle({
    caseKey: runnable.caseKey,
    expect: runnable.expect,
    spans: prepared.ingest.spans,
    rules: world.playbook.rules,
  });
  const stages = await runStages({
    prepared,
    playbook: world.playbook,
    workflow,
    generator,
    signal: new AbortController().signal,
  });
  const seen = observeRun(prepared, stages);
  expect(seen.trails.map((t) => t.ruleKey)).toEqual(stages.findings.map((f) => f.ruleKey));
  return {
    run: {
      split: args.split,
      caseKey: runnable.caseKey,
      repeat: args.repeat ?? 1,
      slots: seen.slots,
      extraction: seen.extraction,
      spans: prepared.ingest.spans,
      trails: seen.trails,
      textDigest: seen.textDigest,
    },
    bundles: stages.bundles,
    findings: stages.findings,
  };
}

const trailOfRule = (file: ResultsFile, ruleKey: string, repeat = 1): SlotTrail => {
  const found = file.trails?.items.find((i) => i.ruleKey === ruleKey && i.repeat === repeat);
  if (found === undefined) throw new Error(`no trail for ${ruleKey}`);
  return found;
};
const places = (trail: SlotTrail): string[] =>
  trail.shown.spans.map((span) => `${span.doc}-p${span.paragraph}`);

// ---------------------------------------------------------------------------------------------
// What a real run records
// ---------------------------------------------------------------------------------------------

describe("the trails of a SIMULATED run of the worked example (PAROL-D05)", () => {
  it("show the retrieval gap of the worked example: v1 was not shown the amendment's paragraph and v2 was", async () => {
    const base = trailOfRule(v1, "dur-1");
    const cand = trailOfRule(v2, "dur-1");
    // The baseline looked at the NDA only. The paragraph of the amendment that deletes the term was
    // not among the text it was shown, so it could not cite it.
    expect(places(base)).toContain("D1-p19");
    expect(places(base)).not.toContain("D2-p3");
    expect(base.cited.map((c) => [c.doc, c.paragraph, c.role, c.quoteCheck])).toEqual([
      ["D1", 19, "governing", "verified"],
    ]);
    // The candidate's retrieval added it (a cross reference to a clause in the bundle) and cites it
    // as the governing passage, with the NDA's own clause as the one it supersedes.
    expect(cand.shown.spans.find((s) => s.doc === "D2" && s.paragraph === 3)?.why).toBe(
      "cross_reference",
    );
    expect(cand.cited.map((c) => [c.doc, c.paragraph, c.role])).toEqual([
      ["D2", 3, "governing"],
      ["D1", 19, "superseded"],
      ["D1", 29, "supporting"],
    ]);
    for (const trail of [base, cand]) {
      expect(trail).toMatchObject({
        split: "dev",
        caseKey: "PAROL-D05",
        repeat: 1,
        verificationState: "verified",
        escalations: [],
        shown: { sent: true, full: false },
      });
      expect(trail.checks.fail).toEqual([]);
      expect(trail.checks.pass).toContain("quote_exists");
    }
  });

  it("put the offsets of a verified quote inside the paragraph it names, where the quoted words are", async () => {
    const { spans } = await readCase(world.dataset, "PAROL-D05");
    const text = (doc: string, paragraph: number): string =>
      spans.find((s) => s.docLabel === doc && s.paragraphIndex === paragraph)!.text;
    const cited = trailOfRule(v2, "dur-1").cited;
    for (const item of cited) {
      expect(item.start).not.toBeNull();
      expect(item.end).not.toBeNull();
      const paragraph = text(item.doc, item.paragraph);
      expect(item.start!).toBeLessThan(item.end!);
      expect(item.end!).toBeLessThanOrEqual(paragraph.length);
    }
    expect(text("D2", 3).slice(cited[0]!.start!, cited[0]!.end!)).toContain(
      "Section 6.1 of the Agreement is deleted",
    );
    expect(text("D1", 19).slice(cited[1]!.start!, cited[1]!.end!)).toContain(
      "two (2) years from the date of each disclosure",
    );
  });

  it("hold one trail for each rule slot of the run, in order, each case with the digest of its text", async () => {
    for (const file of [v1, v2]) {
      const record = file.trails!;
      const rules = Object.keys(world.dataset.keys.playbook.rules).sort();
      expect(record.format).toBe(1);
      expect(record.items.map((i) => i.ruleKey)).toEqual(rules);
      // The digest is the one anyone who reads the case files the way the run does arrives at.
      const [runnable] = runnableCases({
        cases: [world.dataset.keys.cases.find((c) => c.case === "PAROL-D05")!],
        twins: [],
      });
      const documents = await readCaseDocuments({
        dataset: world.dataset,
        runnable: runnable!,
        repeat: 1,
        parsed: new Map(),
      });
      expect(record.cases).toEqual({
        "PAROL-D05": textDigestOf(
          documents.map((d) => ({ label: d.label, textSha256: documentTextSha256(d.paragraphs) })),
        ),
      });
    }
  });

  it("say that a rule that needs the whole document was shown the whole document, without listing it", () => {
    // "Missing" is a judgment about the documents, so the passage-bearing rules of the NDA are read
    // whole (pds-1 and pds-2 share a category).
    for (const rule of ["pds-1", "pds-2"]) {
      expect(trailOfRule(v1, rule).shown).toEqual({ sent: true, full: true, spans: [] });
    }
    expect(trailOfRule(v1, "dur-1").shown.full).toBe(false);
  });

  it("hold no text: short codes, labels and keys only, and none of the paragraphs of the case", async () => {
    const { spans } = await readCase(world.dataset, "PAROL-D05");
    const windows = documentWindows(spans);
    for (const file of [v1, v2]) {
      const serialised = JSON.stringify(file.trails);
      expect(containsDocumentText(serialised, windows)).toBe(false);
      const walk = (value: unknown): void => {
        if (typeof value === "string") {
          expect(value.length, value).toBeLessThanOrEqual(64);
        } else if (value !== null && typeof value === "object") {
          Object.values(value).forEach(walk);
        }
      };
      walk(file.trails);
    }
    // The control: the same window search does find text in the case, so it can fail.
    expect(containsDocumentText(spans[0]!.text, windows)).toBe(true);
  });

  it("are read back whole by the reader of results files, which writes them as it read them", () => {
    for (const file of [v1, v2]) {
      expect(trailRecordSchema.safeParse(file.trails).success).toBe(true);
      expect(parseResults(serialiseResults(file)).trails).toEqual(file.trails);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Every case of the dataset, every workflow
// ---------------------------------------------------------------------------------------------

describe("the trails of every run of the committed dataset under the key oracle", () => {
  it("fit the schema of a results file, stay far under its caps, and match the findings they describe", async () => {
    const loaded = await loadDataset(REPO_ROOT);
    if (!loaded.ok) throw new Error("the committed dataset does not load");
    const dataset: Dataset = loaded.dataset;
    let mostShown = 0;
    let mostCited = 0;
    let slots = 0;
    for (const label of ["v1", "v2", "v3"]) {
      const workflow = workflowFor(label);
      for (const split of ["dev", "heldout"] as const) {
        const observed: ObservedRun[] = [];
        const [group] = selectCases(dataset, split, []);
        const parsed: ParsedFiles = new Map();
        for (const runnable of runnableCases(group!)) {
          const seen = await observeCase({ dataset, split, runnable, workflow, parsed });
          // The bundles are the ones the findings were made from, rule by rule.
          expect(seen.bundles.map((b) => b.ruleKey)).toEqual(seen.findings.map((f) => f.ruleKey));
          seen.findings.forEach((finding, index) => {
            const trail = seen.run.trails![index]!;
            expect(trail.verificationState).toBe(finding.verificationState);
            expect(trail.cited.length).toBe(finding.evidence.length);
            slots += 1;
            mostShown = Math.max(mostShown, trail.shown.spans.length);
            mostCited = Math.max(mostCited, trail.cited.length);
          });
          observed.push(seen.run);
        }
        const made = trailRecordOf(observed);
        expect(made.note, `${label} ${split}`).toBeNull();
        const parsedBack = trailRecordSchema.safeParse(JSON.parse(JSON.stringify(made.record)));
        expect(parsedBack.success, `${label} ${split}`).toBe(true);
      }
    }
    // Both splits, both twins and cases, three workflows: the slots are those of the dataset.
    expect(slots).toBeGreaterThan(500);
    // Far below what a results file holds, so the cap is never what stops a real run.
    expect(mostShown).toBeLessThan(MAX_SHOWN_SPANS / 2);
    expect(mostCited).toBeLessThan(MAX_CITED);
  });
});

// ---------------------------------------------------------------------------------------------
// One trail, by hand
// ---------------------------------------------------------------------------------------------

/** FABRICATED FOR A TEST: a span, labelled the way the application labels one. */
const span = (
  doc: "D1" | "D2" | "D3",
  paragraph: number,
  text = "words of a paragraph",
): SourceSpan =>
  ({
    id: `dv_${doc}:p${paragraph}`,
    label: `${doc}-p${paragraph}`,
    modelLabel: `c${paragraph}`,
    documentVersionId: `dv_${doc}`,
    docLabel: doc,
    paragraphIndex: paragraph,
    clauseId: `c${paragraph}`,
    clauseNumber: null,
    heading: null,
    text,
    textSha256: "0".repeat(64),
  }) as SourceSpan;

const SPANS = [span("D1", 1), span("D1", 2), span("D2", 3)];

/** FABRICATED FOR A TEST: a finding with only the fields a trail reads filled in with meaning. */
function finding(over: Partial<VerifiedFinding> = {}): VerifiedFinding {
  return {
    ruleKey: "dur-1",
    category: "duration",
    severity: "high",
    status: "deviation",
    evidence: [],
    discrepancy: "A SENTENCE THE MODEL WROTE ABOUT A DISCREPANCY",
    explanation: "A SENTENCE THE MODEL WROTE TO EXPLAIN",
    fallbackLanguage: null,
    fallbackBasis: "none",
    conflict: null,
    abstainReason: null,
    checks: [],
    escalations: [],
    verificationState: "verified",
    contentSha256: "0".repeat(64),
    ...over,
  } as VerifiedFinding;
}

const item = (over: Partial<VerifiedEvidence>): VerifiedEvidence => ({
  spanId: "dv_D1:p1",
  quote: "A QUOTATION THE MODEL WROTE",
  role: "governing",
  quoteCheck: "verified",
  offsets: { start: 2, end: 9 },
  supportCheck: "not_run",
  ...over,
});

const check = (id: string, outcome: CheckResult["outcome"]): CheckResult => ({
  id,
  kind: "deterministic",
  outcome,
  detail: "A DETAIL THAT NAMES SOMETHING OF THE DOCUMENT",
});

/** FABRICATED FOR A TEST: a bundle with the fields a trail reads. */
function bundle(over: Partial<ContextBundle> = {}): ContextBundle {
  return {
    ruleKey: "dur-1",
    category: "duration",
    rule: {} as ContextBundle["rule"],
    spans: [
      { spanId: "dv_D1:p2", why: "located" },
      { spanId: "dv_D2:p3", why: "cross_reference" },
    ],
    fullDocument: false,
    estimatedTokens: 10,
    budgetTokens: 100,
    overBudget: false,
    ...over,
  } as ContextBundle;
}

const make = (f: VerifiedFinding, b: ContextBundle | undefined): SlotTrail =>
  trailOf({ split: "dev", caseKey: "PAROL-D05", repeat: 2, finding: f, bundle: b, spans: SPANS });

describe("trailOf", () => {
  it("names the finding's paragraphs by label and index, in the order it cited them, with the offsets of what verified", () => {
    const trail = make(
      finding({
        evidence: [
          item({ spanId: "dv_D2:p3", role: "governing", offsets: { start: 3, end: 58 } }),
          item({ spanId: "dv_D1:p1", role: "supporting", quoteCheck: "ambiguous", offsets: null }),
          item({ spanId: "dv_D1:p2", role: "conflicting", quoteCheck: "not_found", offsets: null }),
        ],
      }),
      bundle(),
    );
    expect(trail.cited).toEqual([
      { doc: "D2", paragraph: 3, role: "governing", quoteCheck: "verified", start: 3, end: 58 },
      {
        doc: "D1",
        paragraph: 1,
        role: "supporting",
        quoteCheck: "ambiguous",
        start: null,
        end: null,
      },
      {
        doc: "D1",
        paragraph: 2,
        role: "conflicting",
        quoteCheck: "not_found",
        start: null,
        end: null,
      },
    ]);
    expect(trail).toMatchObject({
      split: "dev",
      caseKey: "PAROL-D05",
      ruleKey: "dur-1",
      repeat: 2,
    });
  });

  it("records no offsets for a quote that did not verify, whatever the finding carries", () => {
    const trail = make(
      finding({
        evidence: [item({ quoteCheck: "not_found", offsets: { start: 1, end: 4 } })],
      }),
      bundle(),
    );
    expect(trail.cited[0]).toMatchObject({ quoteCheck: "not_found", start: null, end: null });
  });

  it("drops a cited span the run does not have, and counts it nowhere", () => {
    const trail = make(
      finding({ evidence: [item({ spanId: "dv_elsewhere:p9" }), item({ spanId: "dv_D1:p2" })] }),
      bundle(),
    );
    expect(trail.cited.map((c) => [c.doc, c.paragraph])).toEqual([["D1", 2]]);
  });

  it("lists the paragraphs retrieval showed with the reason for each, and drops one the run does not have", () => {
    const trail = make(
      finding(),
      bundle({
        spans: [
          { spanId: "dv_D1:p2", why: "located" },
          { spanId: "dv_gone:p1", why: "hint" },
          { spanId: "dv_D2:p3", why: "definition" },
        ],
      }),
    );
    expect(trail.shown).toEqual({
      sent: true,
      full: false,
      spans: [
        { doc: "D1", paragraph: 2, why: "located" },
        { doc: "D2", paragraph: 3, why: "definition" },
      ],
    });
  });

  it("says the whole document was shown, and lists nothing, when retrieval gave the whole document", () => {
    const trail = make(finding(), bundle({ fullDocument: true }));
    expect(trail.shown).toEqual({ sent: true, full: true, spans: [] });
  });

  it("says nothing was sent, and lists nothing, for a bundle over the budget or no bundle", () => {
    expect(make(finding(), bundle({ overBudget: true })).shown).toEqual({
      sent: false,
      full: false,
      spans: [],
    });
    expect(make(finding(), bundle({ overBudget: true, fullDocument: true })).shown).toEqual({
      sent: false,
      full: true,
      spans: [],
    });
    expect(make(finding(), undefined).shown).toEqual({ sent: false, full: false, spans: [] });
  });

  it("sorts the checks by outcome in suite order and lists each id once, with its escalations once", () => {
    const trail = make(
      finding({
        checks: [
          check("quote_exists", "pass"),
          check("span_in_bundle", "fail"),
          check("parties", "not_applicable"),
          check("quote_exists", "pass"),
          check("support", "fail"),
        ],
        escalations: [
          { code: "quote_not_verified", detail: "first, with a detail" },
          { code: "superseded_evidence", detail: "x" },
          { code: "quote_not_verified", detail: "another, with another detail" },
        ],
        verificationState: "escalated_by_system",
      }),
      bundle(),
    );
    expect(trail.checks).toEqual({
      pass: ["quote_exists"],
      fail: ["span_in_bundle", "support"],
      notApplicable: ["parties"],
    });
    expect(trail.escalations).toEqual(["quote_not_verified", "superseded_evidence"]);
    expect(trail.verificationState).toBe("escalated_by_system");
  });

  it("copies no text of the finding: not a quotation, not a sentence the model wrote, not a check detail", () => {
    const trail = make(
      finding({
        evidence: [item({}), item({ spanId: "dv_D2:p3", quoteCheck: "not_found", offsets: null })],
        checks: [check("quote_exists", "fail")],
        escalations: [{ code: "quote_not_verified", detail: "A DETAIL OF AN ESCALATION" }],
      }),
      bundle(),
    );
    const text = JSON.stringify(trail);
    for (const word of ["QUOTATION", "SENTENCE", "DETAIL", "words of a paragraph"]) {
      expect(text).not.toContain(word);
    }
  });

  it("refuses a slot with more paragraphs than a trail holds, and names none of them", () => {
    const many = Array.from({ length: MAX_SHOWN_SPANS + 1 }, (_, i) => span("D1", i));
    const spans = [...many];
    const big = bundle({ spans: many.map((s) => ({ spanId: s.id, why: "hint" as const })) });
    let message = "";
    try {
      trailOf({
        split: "dev",
        caseKey: "PAROL-D05",
        repeat: 1,
        finding: finding(),
        bundle: big,
        spans,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(TrailError);
      message = (error as Error).message;
    }
    expect(message).toContain("more paragraphs than a trail holds");
    // One fewer fits.
    const ok = trailOf({
      split: "dev",
      caseKey: "PAROL-D05",
      repeat: 1,
      finding: finding(),
      bundle: { ...big, spans: big.spans.slice(1) },
      spans,
    });
    expect(ok.shown.spans).toHaveLength(MAX_SHOWN_SPANS);
  });

  it("uses only check ids that the schema accepts: every id the verify stage can record", () => {
    for (const id of CHECK_IDS) {
      const trail = make(finding({ checks: [check(id, "pass")] }), bundle());
      expect(
        trailRecordSchema.safeParse({
          format: 1,
          cases: { "PAROL-D05": "a".repeat(64) },
          items: [trail],
        }).success,
        id,
      ).toBe(true);
    }
  });
});

describe("textDigestOf", () => {
  const docs = [
    { label: "D1" as const, textSha256: "1".repeat(64) },
    { label: "D2" as const, textSha256: "2".repeat(64) },
  ];
  it("changes with the text of a document, with its label and with the order of the documents", () => {
    const base = textDigestOf(docs);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(textDigestOf(docs)).toBe(base);
    expect(textDigestOf([docs[0]!, { ...docs[1]!, textSha256: "3".repeat(64) }])).not.toBe(base);
    expect(textDigestOf([docs[0]!, { ...docs[1]!, label: "D3" }])).not.toBe(base);
    expect(textDigestOf([docs[1]!, docs[0]!])).not.toBe(base);
    expect(textDigestOf([docs[0]!])).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------------------------
// The record of a run
// ---------------------------------------------------------------------------------------------

/** FABRICATED FOR A TEST: an observed run with the trails of the rules given. */
function observedRun(args: {
  caseKey?: string;
  split?: "dev" | "heldout";
  repeat: number;
  rules: string[];
  digest?: string | null;
}): ObservedRun {
  const caseKey = args.caseKey ?? "PAROL-D05";
  const split = args.split ?? "dev";
  return {
    split,
    caseKey,
    repeat: args.repeat,
    slots: [],
    extraction: { caseKey, repeat: args.repeat, categories: {}, degraded: false },
    spans: [],
    trails: args.rules.map((ruleKey) =>
      trailOf({
        split,
        caseKey,
        repeat: args.repeat,
        finding: finding({ ruleKey }),
        bundle: bundle({ ruleKey }),
        spans: SPANS,
      }),
    ),
    ...(args.digest === null ? {} : { textDigest: args.digest ?? "d".repeat(64) }),
  };
}

describe("the record of the observed runs", () => {
  it("is sorted by split, case, rule and repeat whatever order the runs came in, with each case's digest", () => {
    const record = buildTrailRecord([
      observedRun({
        repeat: 2,
        rules: ["ret-1", "dur-1"],
        split: "heldout",
        caseKey: "PAROL-H01",
        digest: "e".repeat(64),
      }),
      observedRun({ repeat: 2, rules: ["ret-1", "dur-1"] }),
      observedRun({ repeat: 1, rules: ["ret-1", "dur-1"] }),
    ])!;
    expect(record.items.map((i) => [i.split, i.caseKey, i.ruleKey, i.repeat])).toEqual([
      ["dev", "PAROL-D05", "dur-1", 1],
      ["dev", "PAROL-D05", "dur-1", 2],
      ["dev", "PAROL-D05", "ret-1", 1],
      ["dev", "PAROL-D05", "ret-1", 2],
      ["heldout", "PAROL-H01", "dur-1", 2],
      ["heldout", "PAROL-H01", "ret-1", 2],
    ]);
    expect(record.cases).toEqual({ "PAROL-D05": "d".repeat(64), "PAROL-H01": "e".repeat(64) });
    expect(trailRecordSchema.safeParse(record).success).toBe(true);
  });

  it("is none, and says nothing, when no run carries a trail", () => {
    expect(trailRecordOf([])).toEqual({ record: undefined, note: null });
    const bare = { ...observedRun({ repeat: 1, rules: [] }) };
    delete (bare as { trails?: unknown }).trails;
    expect(trailRecordOf([bare])).toEqual({ record: undefined, note: null });
    expect(buildTrailRecord([])).toBeUndefined();
  });

  it("is left out, with a note, when the repeats of a case read different text", () => {
    const made = trailRecordOf([
      observedRun({ repeat: 1, rules: ["dur-1"], digest: "a".repeat(64) }),
      observedRun({ repeat: 2, rules: ["dur-1"], digest: "b".repeat(64) }),
    ]);
    expect(made).toEqual({ record: undefined, note: TRAILS_DISAGREE_NOTE });
  });

  it("is left out, with a note, when a run carries trails and not the text it read", () => {
    const made = trailRecordOf([observedRun({ repeat: 1, rules: ["dur-1"], digest: null })]);
    expect(made).toEqual({ record: undefined, note: TRAILS_UNDATED_NOTE });
  });

  it("is left out, with a note, when a run has more trails than a file holds, and a file with that many is refused", () => {
    const one = observedRun({ repeat: 1, rules: ["dur-1"] }).trails![0]!;
    const many = (count: number): ObservedRun => ({
      ...observedRun({ repeat: 1, rules: [] }),
      trails: Array.from({ length: count }, (_, i) => ({ ...one, repeat: i + 1 })),
    });
    expect(trailRecordOf([many(MAX_TRAIL_ITEMS + 1)])).toEqual({
      record: undefined,
      note: TRAILS_TOO_MANY_NOTE,
    });
    const full = trailRecordOf([many(MAX_TRAIL_ITEMS)]);
    expect(full.note).toBeNull();
    expect(full.record!.items).toHaveLength(MAX_TRAIL_ITEMS);
    expect(trailRecordSchema.safeParse(full.record).success).toBe(true);
    // The schema holds the same limit as the builder: one more is refused on read.
    const over = {
      ...full.record!,
      items: [...full.record!.items, { ...one, repeat: MAX_TRAIL_ITEMS + 1 }],
    };
    expect(trailRecordSchema.safeParse(over).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Assembling a file, with trails and without
// ---------------------------------------------------------------------------------------------

describe("assembleResults", () => {
  /** What the assembly of a run is made from, in the shape the command hands it over. */
  async function inputOf(observed: readonly ObservedRun[]) {
    const groups = selectCases(world.dataset, "dev", ["PAROL-D05"]);
    return {
      mode: v2.mode,
      startedAt: new Date(v2.startedAt),
      finishedAt: new Date(v2.finishedAt),
      complete: true,
      stoppedBecause: null,
      pins: v2.pins,
      options: v2.options,
      integrity: [],
      groups,
      rules: world.dataset.keys.playbook.rules,
      observed,
      runs: [],
      usage: v2.usage,
      priced: false,
      contamination: null,
      notes: ["a note of the run"],
    };
  }
  const realRun = async (): Promise<ObservedRun> => {
    const [group] = selectCases(world.dataset, "dev", ["PAROL-D05"]);
    const runnable = runnableCases(group!).find((r) => r.caseKey === "PAROL-D05")!;
    return (
      await observeCase({
        dataset: world.dataset,
        split: "dev",
        runnable,
        workflow: workflowFor("v2"),
        parsed: new Map(),
      })
    ).run;
  };

  it("yields no trails, and no note, for a run that observed nothing (the scoring-failure path)", async () => {
    const file = assembleResults(await inputOf([]));
    expect(file.trails).toBeUndefined();
    expect(Object.hasOwn(file, "trails")).toBe(false);
    expect(file.notes).toEqual(["a note of the run"]);
  });

  it("records the trails of the observed runs last, and adds a note only when it had to leave them out", async () => {
    const observed = await realRun();
    const file = assembleResults(await inputOf([observed]));
    expect(file.trails!.items).toHaveLength(8);
    expect(file.notes).toEqual(["a note of the run"]);
    expect(Object.keys(file).at(-1)).toBe("trails");
    const left = assembleResults(
      await inputOf([
        { ...observed, textDigest: "a".repeat(64) },
        { ...observed, repeat: 2, textDigest: "b".repeat(64) },
      ]),
    );
    expect(left.trails).toBeUndefined();
    expect(left.notes).toEqual(["a note of the run", TRAILS_DISAGREE_NOTE]);
  });

  it("changes nothing but the trails: the pins, the scored sections, the gates and the runs are the same with and without", async () => {
    const observed = await realRun();
    const without = { ...observed };
    delete without.trails;
    delete without.textDigest;
    const a = assembleResults(await inputOf([observed]));
    const b = assembleResults(await inputOf([without]));
    expect(a.trails).toBeDefined();
    expect(b.trails).toBeUndefined();
    // The scored section, with its metrics and its gates, is really there to be compared.
    expect(a.sections[0]!.metrics).not.toBeNull();
    expect(a.sections[0]!.gates).not.toBeNull();
    const { trails: _recorded, ...rest } = a;
    expect(rest).toEqual(b);
  });
});

// ---------------------------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------------------------

describe("parseResults", () => {
  type Loose = Record<string, any>;
  const edit = (change: (trails: Loose) => void, base: string = v2Text): string => {
    const file = JSON.parse(base) as Loose;
    change(file.trails);
    return JSON.stringify(file);
  };
  /** The path the reader names, and the check that it holds nothing of the edit. */
  const refused = (source: string, planted?: string): string => {
    let message = "";
    try {
      parseResults(source);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message, "the file was accepted").not.toBe("");
    expect(message).toContain("is not a Parol results file this version can read");
    if (planted !== undefined) expect(message).not.toContain(planted);
    return message;
  };

  it("accepts a file written before trails existed, and reads no trails from it", () => {
    const old = JSON.parse(v2Text) as Loose;
    delete old.trails;
    const parsed = parseResults(JSON.stringify(old));
    expect(parsed.trails).toBeUndefined();
    expect(parsed.sections).toEqual(v2.sections);
    expect(parsed.pins).toEqual(v2.pins);
    expect(Object.hasOwn(parsed, "trails")).toBe(false);
  });

  it("accepts the file a run wrote, trails and all", () => {
    expect(parseResults(v2Text).trails).toEqual(v2.trails);
  });

  it.each(["Non_solicit.2", "Dur-1", `A${"x".repeat(63)}`])(
    "accepts a rule key as the application stores a playbook's keys: %s",
    (key) => {
      const parsed = parseResults(
        edit((t) => {
          t.items[0].ruleKey = key;
        }),
      );
      expect(parsed.trails?.items[0]?.ruleKey).toBe(key);
    },
  );

  it.each([
    ["an unknown role", (t: Loose) => (t.items[0].cited[0].role = "decisive")],
    ["an unknown document label", (t: Loose) => (t.items[0].cited[0].doc = "D9")],
    ["an unknown quote check", (t: Loose) => (t.items[0].cited[0].quoteCheck = "maybe")],
    [
      "an unknown reason for a paragraph shown",
      (t: Loose) => (t.items[1].shown.spans[0].why = "because"),
    ],
    ["an unknown escalation code", (t: Loose) => (t.items[0].escalations = ["panic"])],
    ["an unknown verification state", (t: Loose) => (t.items[0].verificationState = "unsure")],
    ["a negative offset", (t: Loose) => (t.items[1].cited[0].start = -1)],
    ["a fractional offset", (t: Loose) => (t.items[1].cited[0].end = 3.5)],
    [
      "a paragraph index that is not a whole number",
      (t: Loose) => (t.items[1].cited[0].paragraph = 1.5),
    ],
    [
      "an end that is not after the start",
      (t: Loose) => (t.items[1].cited[0].end = t.items[1].cited[0].start),
    ],
    [
      "an offset on a quote that did not verify",
      (t: Loose) => (t.items[1].cited[0].quoteCheck = "not_found"),
    ],
    ["a start without an end", (t: Loose) => (t.items[1].cited[0].end = null)],
    ["a check id with a space in it", (t: Loose) => (t.items[0].checks.pass[0] = "quote exists")],
    ["a check id in capitals", (t: Loose) => (t.items[0].checks.fail = ["QUOTE_EXISTS"])],
    [
      "a check id that is a sentence",
      (t: Loose) => (t.items[0].checks.notApplicable = ["a".repeat(65)]),
    ],
    ["a case key that is not a key", (t: Loose) => (t.items[0].caseKey = "PAROL D05")],
    [
      "a rule key that is not a key",
      (t: Loose) => (t.items[0].ruleKey = "Duration of confidentiality"),
    ],
    ["a repeat of zero", (t: Loose) => (t.items[0].repeat = 0)],
    ["a field this version does not know on a trail", (t: Loose) => (t.items[0].quote = "x")],
    [
      "a field this version does not know on a cited paragraph",
      (t: Loose) => (t.items[1].cited[0].text = "x"),
    ],
    ["a field this version does not know on the record", (t: Loose) => (t.note = "x")],
    ["a format this version does not know", (t: Loose) => (t.format = 2)],
    ["a digest that is not a hash", (t: Loose) => (t.cases["PAROL-D05"] = "not a digest")],
    ["a case with no digest", (t: Loose) => (t.cases = {})],
    [
      "a listing of paragraphs for a whole-document read",
      (t: Loose) => {
        const whole = t.items.find((i: Loose) => i.shown.full);
        whole.shown.spans = [{ doc: "D1", paragraph: 1, why: "located" }];
      },
    ],
    [
      "a listing of paragraphs for text that was not sent",
      (t: Loose) => {
        t.items[1].shown.sent = false;
      },
    ],
    ["two trails for one slot", (t: Loose) => t.items.splice(1, 0, structuredClone(t.items[0]))],
    ["trails out of order", (t: Loose) => t.items.reverse()],
    ["a record that is not an object", (t: Loose) => t.items.push(null)],
  ])("refuses %s, and names where without repeating anything", (_name, change) => {
    const message = refused(edit(change));
    expect(message).toMatch(/at "trails/);
  });

  it("refuses a trail that carries text, and does not repeat it", () => {
    const planted = "A SENTENCE A MODEL WROTE ABOUT THE DISCREPANCY";
    const source = edit((t) => {
      t.items[0].cited[0].role = planted;
    });
    refused(source, planted);
    // A field that would hold it is not known, so it cannot be added.
    refused(
      edit((t) => {
        t.items[0].checks.fail = [planted];
      }),
      planted,
    );
    refused(
      edit((t) => {
        t.items[0].explanation = planted;
      }),
      planted,
    );
  });

  it("refuses more than the caps: paragraphs shown, passages cited, check ids and trails", () => {
    refused(
      edit((t) => {
        t.items[1].shown.spans = Array.from({ length: MAX_SHOWN_SPANS + 1 }, (_, i) => ({
          doc: "D1",
          paragraph: i,
          why: "hint",
        }));
      }),
    );
    // At the cap it is accepted: the cap is the boundary and not an off-by-one.
    expect(
      parseResults(
        edit((t) => {
          t.items[1].shown.spans = Array.from({ length: MAX_SHOWN_SPANS }, (_, i) => ({
            doc: "D1",
            paragraph: i,
            why: "hint",
          }));
        }),
      ).trails!.items[1]!.shown.spans,
    ).toHaveLength(MAX_SHOWN_SPANS);
    const cited = (count: number) => (t: Loose) => {
      t.items[1].cited = Array.from({ length: count }, () => ({
        doc: "D1",
        paragraph: 1,
        role: "supporting",
        quoteCheck: "not_found",
        start: null,
        end: null,
      }));
    };
    refused(edit(cited(MAX_CITED + 1)));
    expect(parseResults(edit(cited(MAX_CITED))).trails!.items[1]!.cited).toHaveLength(MAX_CITED);
    const ids = (count: number) => (t: Loose) => {
      t.items[0].checks.pass = Array.from({ length: count }, (_, i) => `check_${i}`);
    };
    refused(edit(ids(MAX_CHECK_IDS + 1)));
    expect(parseResults(edit(ids(MAX_CHECK_IDS))).trails!.items[0]!.checks.pass).toHaveLength(
      MAX_CHECK_IDS,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The command: trails of a run that stopped, of a replay and of a selftest
// ---------------------------------------------------------------------------------------------

describe("the command", () => {
  const live = (resultsDir: string, extra: string[] = [], stand = oracleFactory({})) =>
    run(["--yes", ...extra], { resultsDir, generatorFactory: stand.factory });
  const fileIn = async (folder: string): Promise<ResultsFile> => {
    const names = (await readdir(folder)).filter((name) => name.endsWith(".json"));
    expect(names).toHaveLength(1);
    return readResults(join(folder, names[0]!));
  };

  it("records the trails of a selftest, whose oracle reads the key, and of a simulated run", async () => {
    const resultsDir = await fresh();
    const out = await run(["--selftest", "--case", "PAROL-D05"], { resultsDir });
    expect(out.code, out.stderr).toBe(0);
    const file = await fileIn(resultsDir);
    expect(file.mode).toBe("selftest");
    expect(file.trails!.items).toHaveLength(8);
    // The oracle cites what the key names: the amendment's paragraph, as the governing passage.
    expect(
      trailOfRule(file, "dur-1").cited.some((c) => c.doc === "D2" && c.role === "governing"),
    ).toBe(true);
    expect(v1.mode).toBe("simulated");
    expect(v1.trails!.items).toHaveLength(8);
  });

  it("keeps the trails of the runs that finished when a later run is stopped, and none of the one that was not", async () => {
    const resultsDir = await fresh();
    // The first case takes nine calls; the first call of the next one is refused for good.
    const stand = oracleFactory({
      failFrom: { call: 10, error: new ModelRequestError("a rejected key", 401) },
    });
    const out = await live(
      resultsDir,
      ["--case", "PAROL-D01", "--case", "PAROL-D02", "--no-record"],
      stand,
    );
    expect(out.code, out.stderr).toBe(1);
    const file = await fileIn(resultsDir);
    expect(file.complete).toBe(false);
    expect(file.trails).toBeDefined();
    expect([...new Set(file.trails!.items.map((i) => i.caseKey))]).toEqual(["PAROL-D01"]);
    expect(Object.keys(file.trails!.cases)).toEqual(["PAROL-D01"]);
    expect(file.trails!.items).toHaveLength(8);
  });

  it("gives a replay of a recording the trails of the run it replays, item for item", async () => {
    const resultsDir = await fresh();
    const stand = oracleFactory({
      usage: () => ({
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    });
    const done = await live(resultsDir, ["--case", "PAROL-D05"], stand);
    expect(done.code, done.stderr).toBe(0);
    const recorded = await fileIn(resultsDir);
    expect(recorded.mode).toBe("live");
    const recording = (await readdir(resultsDir)).find((name) => name.endsWith(RECORDING_SUFFIX))!;

    const replayDir = await fresh();
    const replayed = await run(["--replay", join(resultsDir, recording), "--case", "PAROL-D05"], {
      resultsDir: replayDir,
      env: {},
    });
    expect(replayed.code, replayed.stderr).toBe(0);
    const again = await fileIn(replayDir);
    expect(again.mode).toBe("replay");
    expect(again.trails!.items).toHaveLength(8);
    expect(again.trails).toEqual(recorded.trails);
  });
});
