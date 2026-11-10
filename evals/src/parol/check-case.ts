import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  TraceabilityError,
  analyzeCases,
  buildDataset,
  caseSlug,
  compareUploadStep,
  formatTotals,
  orderWarnings,
  readPlaybookFacts,
  simulateUploads,
  type UploadFileFacts,
} from "../../../fixtures/parol/build.js";
import { countOccurrences } from "../../../fixtures/parol/anchors.js";
import {
  SEPARABILITY_LIMITS,
  analyzeCalibration,
  calibrationCases,
  type CalibrationAnalysis,
} from "../../../fixtures/parol/calibration.js";
import { CALIBRATION_PAIRS } from "../../../fixtures/parol/calibration/pairs.js";
import { CASES, PLAYBOOK_FILE, PLAYBOOK_SLUG } from "../../../fixtures/parol/cases.js";
import { expandDocument } from "../../../fixtures/parol/render.js";
import type {
  CalibrationKeyPair,
  CalibrationPairSpec,
  CanaryMatter,
  CaseDefinition,
  UploadExpectation,
} from "../../../fixtures/parol/types.js";
import { sha256Hex } from "../../../apps/parol/src/canonical.js";
import type { IngestDocumentInput, WarningCode } from "../../../apps/parol/src/contracts.js";
import { buildIngest } from "../../../apps/parol/src/ingest/ingest.js";
import { parseDocument } from "../../../apps/parol/src/ingest/parse.js";
import { documentTextSha256 } from "../../../apps/parol/src/ingest/text-hash.js";
import type { ParsedDocument } from "../../../apps/parol/src/module-contracts.js";
import { parsePlaybook, type Rule } from "../../../packages/playbook/src/index.js";
import { findAnchor } from "./anchors.js";

/**
 * Checks one or more case files against the playbook and the traceability rules without writing
 * anything and without touching fixtures/parol/cases.ts, so several authors can work at once.
 *
 *   pnpm fixtures:parol:case fixtures/parol/cases/d02.ts [more files]
 *
 * Each file exports one or more `CaseDefinition`s. They are checked together with the cases that
 * are already registered (a candidate with the same key replaces the registered one). Exits 1 when
 * anything is wrong. `--summary` also prints what each rule is expected to conclude and where the
 * anchors resolved, which is what a reviewer of the case wants to read; for a case with uploads
 * or canary matters it prints those too.
 *
 * Unless `--no-ingest`, each candidate's files are also read the way an upload is read (the real
 * parser and ingest), and the check fails when an anchor does not resolve exactly once in the
 * real spans, when it resolves at another paragraph than the key says, or when the warnings the
 * ingest raises are not the warnings the case expects.
 *
 * For a case with `uploads` the same real reading covers more. The anchors and the warnings of
 * ingest are those of the documents that are operative at the end. The upload steps are then
 * played again by the application's rules on the real facts (the SHA-256 of each file and the
 * text hash the application computes from the real parser), so a re-save that the parser reads
 * differently from the builder is found here. The warnings of each stored version are those of
 * ingest with the documents that governed at that step, and the warnings of the case are every
 * code an upload returns together with those of the final ingest. For a case that names canary
 * matters, each matter's document is read the same way: its strings and its fact must occur once
 * in the real spans, nowhere in the files of the case, and ingest must raise nothing for it.
 *
 * `--docs` prints the text of each candidate's operative documents with paragraph numbers and no
 * expectations, which is what a blind reader of the case sees. For a case with uploads it prints
 * every document, the superseded versions too, and the steps a person takes, again without what
 * the application is expected to answer.
 *
 * `--calibration` checks the support calibration set instead of a case:
 *
 *   pnpm fixtures:parol:case --calibration [pairs file] [--no-ingest] [--summary] [--blind]
 *
 * It validates fixtures/parol/calibration/pairs.ts (or the pairs file given, which exports an array
 * of pairs and replaces the shipped set) the way the builder does (fixtures/parol/calibration.ts:
 * 40 pairs, 20 of each label, four unsupported pairs of each of five kinds, every quote once in the
 * clause it names in the operative document of a development case, nothing built from a held-out
 * case, and a surface that does not give the label away), prints the counts and what was measured
 * about the surface, and then reads each pair's documents with the real parser and ingest: every
 * quote must resolve exactly once, at the paragraph that calibration.json will record. Nothing is
 * written. Exit 0 when sound, 1 when not, 2 for a bad call.
 *
 * `--calibration --blind` prints the pairs a qualified reviewer labels: for each pair the rule, the
 * proposed status and discrepancy, the explanation, the cited paragraph and the quote, and the
 * command that prints the whole matter. It leaves out the label, the kind, the author's note and
 * every count that is about labels. The set is validated first; a set with problems prints none.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const args = process.argv.slice(2);
const files = args.filter((arg) => !arg.startsWith("--"));
const summary = args.includes("--summary");
const noRender = args.includes("--no-render");
const noIngest = args.includes("--no-ingest");
const showDocs = args.includes("--docs");
const calibrationMode = args.includes("--calibration");
const blind = args.includes("--blind");

if (blind && !calibrationMode) {
  console.error(
    "--blind is a mode of --calibration: pnpm fixtures:parol:case --calibration --blind",
  );
  process.exit(2);
}
if (calibrationMode) process.exit(await runCalibration());

if (files.length === 0) {
  console.error(
    "usage: pnpm fixtures:parol:case <case file> [...] [--summary] [--docs] [--no-render] [--no-ingest]\n" +
      "       pnpm fixtures:parol:case --calibration [pairs file] [--summary] [--blind] [--no-ingest]",
  );
  process.exit(2);
}

const isCase = (value: unknown): value is CaseDefinition =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { case?: unknown }).case === "string" &&
  Array.isArray((value as { documents?: unknown }).documents);

const candidates: CaseDefinition[] = [];
for (const file of files) {
  const module = (await import(pathToFileURL(resolve(file)).href)) as Record<string, unknown>;
  const found = Object.values(module).filter(isCase);
  if (found.length === 0) {
    console.error(`${file} exports no CaseDefinition`);
    process.exit(1);
  }
  candidates.push(...found);
}

const keys = new Set(candidates.map((candidate) => candidate.case));
const all = [...CASES.filter((registered) => !keys.has(registered.case)), ...candidates];
const playbookYaml = await readFile(join(root, PLAYBOOK_FILE), "utf8");
const facts = readPlaybookFacts(playbookYaml, PLAYBOOK_SLUG);
const analysis = analyzeCases(all, facts);

if (analysis.problems.length > 0) {
  console.error(`${analysis.problems.length} problem(s):\n  ${analysis.problems.join("\n  ")}`);
  process.exit(1);
}

const describeExpectation = (expect: UploadExpectation): string => {
  if (expect.effect === "refused") return `refused (${expect.code})`;
  const warnings = orderWarnings(expect.warnings);
  return (
    `${expect.effect} ${expect.label} v${expect.versionNo}, ` +
    `${expect.operative ? "operative" : "not operative"}` +
    (warnings.length === 0 ? "" : `, warnings ${warnings.join(" ")}`) +
    (expect.sameTextAs === undefined
      ? ""
      : `, same text as ${expect.sameTextAs.label} v${expect.sameTextAs.versionNo}`)
  );
};

if (summary) {
  for (const analyzed of analysis.cases) {
    if (!keys.has(analyzed.definition.case)) continue;
    console.log(`\n${analyzed.definition.case} (${analyzed.definition.split})`);
    console.log(`  ${analyzed.definition.phenomenon}`);
    for (const doc of analyzed.documents) {
      const version =
        analyzed.definition.uploads === undefined
          ? ""
          : ` (version ${doc.versionNo}, ${doc.operative ? "operative" : "not operative"})`;
      console.log(`  ${doc.definition.label} ${doc.definition.file}${version}`);
    }
    for (const [rule, expectation] of Object.entries(analyzed.expect)) {
      const anchors = expectation.governing
        .map((anchor) => `${anchor.doc}-p${anchor.paragraph}`)
        .join(", ");
      const escalation =
        expectation.escalation.mode === "not_expected"
          ? ""
          : ` ${expectation.escalation.mode}[${expectation.escalation.codes.join(",")}]`;
      console.log(`  ${rule.padEnd(6)} ${expectation.status.padEnd(14)} ${anchors}${escalation}`);
    }
    const uploads = analyzed.definition.uploads;
    if (uploads !== undefined) {
      const extra = uploads.files ?? [];
      console.log(
        `  uploads: ${uploads.steps.length} step${uploads.steps.length === 1 ? "" : "s"}, ${extra.length} extra file${extra.length === 1 ? "" : "s"}`,
      );
      for (const entry of extra) {
        console.log(
          `    file ${entry.file}: ${entry.kind === "identical_copy" ? "identical copy" : "re-save (same text, other bytes)"} of ${entry.of}`,
        );
      }
      uploads.steps.forEach((step, i) => {
        const what =
          step.action === "addDocument"
            ? `addDocument as ${step.label} "${step.title}" (${step.kind})`
            : `addVersion to ${step.label}`;
        console.log(
          `    step ${i + 1}: ${what}, ${step.file}, stated date ${step.statedDate ?? "none"}\n      expects ${describeExpectation(step.expect)}`,
        );
      });
      console.log(`  warnings the case lists: ${analyzed.definition.warnings.join(" ") || "none"}`);
    }
    if (analyzed.canaryMatters.length > 0) {
      console.log(`  canary matters in the same store: ${analyzed.canaryMatters.length}`);
      for (const matter of analyzed.canaryMatters) {
        console.log(
          `    ${matter.id} (${matter.split}): ${matter.document.file}, ${matter.strings.length} canary strings, client ${matter.clientLegalName}`,
        );
      }
    }
  }
}

const problems: string[] = [];

/** The sorted codes as text, for a message. */
const codesText = (codes: Iterable<WarningCode>): string => [...codes].sort().join(" ") || "none";

async function checkCanary(
  scope: string,
  matter: CanaryMatter,
  bytes: Uint8Array,
  caseTexts: readonly string[],
): Promise<void> {
  const parsed = await parseDocument({
    bytes,
    mediaType: matter.document.file.endsWith(".docx") ? "docx" : "txt",
  });
  const ingest = buildIngest({
    documents: [
      {
        documentVersionId: "dv_canary",
        label: matter.document.label,
        kind: matter.document.kind,
        title: matter.document.title,
        versionNo: 1,
        statedDate: matter.document.statedDate,
        paragraphs: parsed.paragraphs,
        inspection: parsed.inspection,
      },
    ],
  });
  const where = `${scope} canary matter ${matter.id}`;
  if (ingest.warnings.length > 0) {
    problems.push(
      `${where}: the real ingest raises ${codesText(ingest.warnings.map((w) => w.code))} for the matter's document`,
    );
  }
  const spanTexts = ingest.spans.map((span) => span.text);
  const probes = [
    ...matter.strings.map((text, i) => ({ what: `string ${i + 1}`, text })),
    { what: "the distinctive fact", text: matter.fact },
  ];
  for (const probe of probes) {
    const count = spanTexts.reduce((n, text) => n + countOccurrences(text, probe.text), 0);
    if (count !== 1) {
      problems.push(`${where}: ${probe.what} occurs ${count} times in the real spans, not once`);
    }
    if (caseTexts.some((text) => text.includes(probe.text))) {
      problems.push(
        `${where}: ${probe.what} occurs in a file of the case, as the real parser reads it`,
      );
    }
  }
}

if (!noRender) {
  let dataset: Awaited<ReturnType<typeof buildDataset>> | undefined;
  try {
    dataset = await buildDataset({ cases: all, playbookYaml, playbookSlug: PLAYBOOK_SLUG });
  } catch (error) {
    if (!(error instanceof TraceabilityError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
  console.log(`\n${formatTotals(dataset.totals)}`);

  if (!noIngest || showDocs) {
    const bytesOf = new Map(dataset.files.map((file) => [file.name, file.bytes]));
    for (const analyzed of analysis.cases) {
      const definition = analyzed.definition;
      if (!keys.has(definition.case)) continue;
      const scope = definition.case;
      const withUploads = definition.uploads !== undefined;

      // Every file of the case, as the real parser reads it.
      const parsedFiles = new Map<string, ParsedDocument>();
      const names = [
        ...definition.documents.map((doc) => doc.file),
        ...(definition.uploads?.files ?? []).map((extra) => extra.file),
      ];
      for (const name of names) {
        const bytes = bytesOf.get(name);
        if (bytes === undefined) {
          problems.push(`${scope}: ${name} was not built`);
          continue;
        }
        parsedFiles.set(
          name,
          await parseDocument({ bytes, mediaType: name.endsWith(".docx") ? "docx" : "txt" }),
        );
      }

      const documents: IngestDocumentInput[] = [];
      for (const doc of definition.documents) {
        const parsed = parsedFiles.get(doc.file);
        if (parsed === undefined) continue;
        const shown = withUploads || doc.operative !== false;
        if (showDocs && shown) {
          const version = withUploads
            ? `; version ${doc.versionNo ?? 1}, ${doc.operative === false ? "superseded" : "operative"}`
            : "";
          console.log(
            `\n=== ${scope} ${doc.label} ${doc.title} (${doc.file}; ${doc.kind}; stated date ${doc.statedDate ?? "none"}${version}; client entered at intake: ${definition.intake.clientLegalName}) ===`,
          );
          parsed.paragraphs.forEach((paragraph, index) => {
            console.log(`p${index}\t${paragraph.text}`);
          });
        }
        if (doc.operative === false) continue;
        documents.push({
          documentVersionId: `dv_${doc.label.toLowerCase()}`,
          label: doc.label,
          kind: doc.kind,
          title: doc.title,
          versionNo: doc.versionNo ?? 1,
          statedDate: doc.statedDate,
          paragraphs: parsed.paragraphs,
          inspection: parsed.inspection,
        });
      }
      if (showDocs && definition.uploads !== undefined) {
        console.log(`\n=== ${scope} what the person uploads, in order ===`);
        for (const extra of definition.uploads.files ?? []) {
          console.log(
            `file ${extra.file}: ${extra.kind === "identical_copy" ? "the bytes of" : "the text of"} ${extra.of}${extra.kind === "identical_copy" ? " under another name" : " saved again by another program"}`,
          );
        }
        definition.uploads.steps.forEach((step, i) => {
          console.log(
            `step ${i + 1}: ${
              step.action === "addDocument"
                ? `add a document "${step.title}" (${step.kind})`
                : `add a version to ${step.label}`
            } from ${step.file}, stated date ${step.statedDate ?? "none"}`,
          );
        });
      }
      if (noIngest) continue;

      const ingest = buildIngest({ documents });
      const raised = new Set<WarningCode>(ingest.warnings.map((warning) => warning.code));

      // The uploads, played again on what the real parser reads.
      if (definition.uploads !== undefined) {
        const real = new Map<string, UploadFileFacts>();
        for (const [name, parsed] of parsedFiles) {
          const bytes = bytesOf.get(name);
          if (bytes === undefined) continue;
          real.set(name, {
            bytesId: sha256Hex(bytes),
            textId: documentTextSha256(parsed.paragraphs),
          });
        }
        if (real.size === parsedFiles.size) {
          const played = simulateUploads(definition.uploads.steps, (name) => real.get(name));
          for (const message of played.problems) problems.push(`${scope}: ${message} (real files)`);
          definition.uploads.steps.forEach((step, i) => {
            const at = `${scope} upload step ${i + 1}`;
            const result = played.steps[i];
            if (result === undefined || result.effect === "invalid") return;
            for (const message of compareUploadStep(step, result)) {
              problems.push(`${at}: ${message} (as the real parser reads the files)`);
            }
            if (result.effect === "refused" || step.expect.effect === "refused") return;
            // What ingest says about the version stored: the documents that governed, the new
            // version in the place of its document.
            const codes = new Set<WarningCode>(result.warnings);
            if (result.ingest !== null) {
              const pending = result.ingest.find((slot) => slot.pending);
              const input: IngestDocumentInput[] = [];
              for (const slot of result.ingest) {
                const parsed = parsedFiles.get(slot.file);
                if (parsed === undefined) continue;
                input.push({
                  documentVersionId: `dv_${slot.label.toLowerCase()}_v${slot.versionNo}`,
                  label: slot.label,
                  kind: slot.kind,
                  title: slot.title,
                  versionNo: slot.versionNo,
                  statedDate: slot.statedDate,
                  paragraphs: parsed.paragraphs,
                  inspection: parsed.inspection,
                });
              }
              const pendingId =
                pending === undefined
                  ? undefined
                  : `dv_${pending.label.toLowerCase()}_v${pending.versionNo}`;
              for (const warning of buildIngest({ documents: input }).warnings) {
                if (warning.documentVersionId === pendingId) codes.add(warning.code);
              }
            }
            const declared = new Set<WarningCode>(step.expect.warnings);
            if (codesText(codes) !== codesText(declared)) {
              problems.push(
                `${at}: the answer carries ${codesText(codes)} by the real ingest and the step lists ${codesText(declared)}`,
              );
            }
            for (const code of codes) raised.add(code);
          });
        }
      }

      const expected = new Set(definition.warnings);
      for (const code of raised) {
        if (!expected.has(code))
          problems.push(`${scope}: the ingest raises ${code} and the case does not expect it`);
      }
      for (const code of expected) {
        if (!raised.has(code))
          problems.push(`${scope}: the case expects ${code} and the ingest does not raise it`);
      }
      for (const [rule, expectation] of Object.entries(analyzed.expect)) {
        for (const kind of ["governing", "superseded", "relevant"] as const) {
          for (const anchor of expectation[kind]) {
            const found = findAnchor(ingest.spans, anchor);
            const where = `${scope} ${rule} ${kind} ${anchor.doc} clause ${anchor.clause ?? "(none)"}`;
            if (!found.ok) {
              problems.push(
                `${where}: the real ingest finds the anchor ${found.occurrences} times (${found.reason})`,
              );
            } else if (found.span.paragraphIndex !== anchor.paragraph) {
              problems.push(
                `${where}: the key says paragraph ${anchor.paragraph}, the real ingest says ${found.span.paragraphIndex}`,
              );
            }
          }
        }
      }

      // The canary matters that sit in the store with the case.
      const caseTexts = [...parsedFiles.values()].flatMap((parsed) =>
        parsed.paragraphs.map((paragraph) => paragraph.text),
      );
      for (const matter of analyzed.canaryMatters) {
        const bytes = bytesOf.get(matter.document.file);
        if (bytes === undefined) {
          problems.push(`${scope}: ${matter.document.file} was not built`);
          continue;
        }
        await checkCanary(scope, matter, bytes, caseTexts);
      }
    }
  }
}
if (problems.length > 0) {
  console.error(
    `\n${problems.length} problem(s) with the real ingest:\n  ${problems.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(`\nok: ${candidates.map((candidate) => candidate.case).join(", ")}`);

// ---------------------------------------------------------------------------------------------
// --calibration: the support calibration set
// ---------------------------------------------------------------------------------------------

function isPair(value: unknown): value is CalibrationPairSpec {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { case?: unknown }).case === "string" &&
    typeof (value as { claim?: unknown }).claim === "object"
  );
}

async function loadCalibrationPairs(): Promise<CalibrationPairSpec[] | null> {
  if (files.length === 0) return [...CALIBRATION_PAIRS];
  const pairs: CalibrationPairSpec[] = [];
  for (const file of files) {
    const module = (await import(pathToFileURL(resolve(file)).href)) as Record<string, unknown>;
    const exported = Object.values(module).find(
      (value): value is CalibrationPairSpec[] => Array.isArray(value) && value.every(isPair),
    );
    if (exported === undefined) {
      console.error(`${file} exports no array of calibration pairs`);
      return null;
    }
    pairs.push(...exported);
  }
  return pairs;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function printCalibrationReport(analysis: CalibrationAnalysis, listPairs: boolean): void {
  const { counts, separability: s } = analysis;
  const limits = SEPARABILITY_LIMITS;
  console.log(
    `calibration set: ${counts.pairs} pairs, ${counts.supported} supported, ${counts.unsupported} unsupported`,
  );
  console.log(
    `  unsupported by kind: ${Object.entries(counts.byKind)
      .map(([kind, n]) => `${kind} ${n}`)
      .join(", ")}`,
  );
  const range = (stat: { min: number; median: number; max: number }): string =>
    `${stat.min} to ${stat.max}, median ${stat.median}`;
  console.log("what a reader of the surface could tell:");
  console.log(
    `  quote in words: supported ${range(s.quoteWords.supported)}; unsupported ${range(s.quoteWords.unsupported)}`,
  );
  console.log(
    `  best length threshold on the quote: ${pct(s.thresholdAccuracy.quoteWords)} by words, ${pct(s.thresholdAccuracy.quoteCharacters)} by characters (limit ${pct(limits.quoteThresholdAccuracy)})`,
  );
  console.log(
    `  best length threshold on the explanation: ${pct(s.thresholdAccuracy.explanationWords)} (limit ${pct(limits.explanationThresholdAccuracy)})`,
  );
  console.log(
    `  guessing from the rule alone: ${pct(s.majorityAccuracy.rule)} (limit ${pct(limits.ruleAccuracy)}); from the status alone: ${pct(s.majorityAccuracy.status)} (limit ${pct(limits.statusAccuracy)})`,
  );
  console.log(
    `  words in at least ${limits.cueMinPairs} quotes: ${s.quoteWordCounts.length}, outside the band ${pct(limits.cueBand[0])} to ${pct(limits.cueBand[1])} unsupported: ${s.cueWords.length}`,
  );
  console.log(
    `  longest run of one label in the order of the ids: ${s.longestLabelRun} (limit ${limits.longestLabelRun}); paragraphs cited by both labels: ${s.sharedParagraphs}`,
  );
  if (listPairs) {
    console.log("");
    for (const pair of analysis.pairs) {
      const quoteWords = pair.evidence.quote.split(/\s+/).length;
      console.log(
        `${pair.id} ${pair.case} ${pair.rule.padEnd(6)} ${pair.claim.status.padEnd(9)} ` +
          `${pair.label.padEnd(11)} ${(pair.kind ?? "").padEnd(22)} ${pair.evidence.doc} ` +
          `${pair.evidence.clause ?? "(none)"} p${pair.evidence.paragraph} (${quoteWords} words)`,
      );
    }
  }
}

/** What a blind reader is given for one pair: the rule, the claim, the paragraph and the quote. */
function printBlindPair(
  pair: CalibrationKeyPair,
  rule: Rule | undefined,
  definition: CaseDefinition | undefined,
): void {
  const doc = definition?.documents.find(
    (candidate) => candidate.label === pair.evidence.doc && candidate.operative !== false,
  );
  const paragraph =
    doc === undefined ? "" : (expandDocument(doc)[pair.evidence.paragraph]?.text ?? "");
  console.log(`=== ${pair.id} ===`);
  console.log(
    `Matter: ${pair.case} (all of it: pnpm fixtures:parol:case fixtures/parol/cases/${caseSlug(pair.case)}.ts --docs)`,
  );
  console.log(`Rule ${pair.rule}${rule === undefined ? "" : `: ${rule.title}`}`);
  if (rule !== undefined) {
    console.log(`  Severity: ${rule.severity}; required: ${rule.required ? "yes" : "no"}`);
    console.log(`  Standard: ${rule.standard.trim()}`);
    if (rule.fallback !== undefined) console.log(`  Fallback: ${rule.fallback.trim()}`);
    if (rule.unacceptable !== undefined) console.log(`  Unacceptable: ${rule.unacceptable.trim()}`);
    if (rule.guidance !== undefined) console.log(`  Guidance: ${rule.guidance.trim()}`);
  }
  console.log(`Proposed status: ${pair.claim.status}`);
  console.log(
    `Proposed discrepancy: ${pair.claim.discrepancy === "" ? "(none)" : pair.claim.discrepancy}`,
  );
  console.log(`Explanation (the checker is not shown it): ${pair.claim.explanation}`);
  console.log(
    `Cited paragraph (${pair.evidence.doc}, ${pair.evidence.clause === null ? "outside any numbered clause" : `clause ${pair.evidence.clause}`}, paragraph ${pair.evidence.paragraph}):`,
  );
  console.log(`  ${paragraph}`);
  console.log(`Quote: ${pair.evidence.quote}`);
  console.log("");
}

/** Runs the calibration mode and returns the exit code. */
async function runCalibration(): Promise<number> {
  const pairs = await loadCalibrationPairs();
  if (pairs === null) return 1;
  const playbookYaml = await readFile(join(root, PLAYBOOK_FILE), "utf8");
  const facts = readPlaybookFacts(playbookYaml, PLAYBOOK_SLUG);
  const cases = calibrationCases(CASES);
  const analysis = analyzeCalibration({ pairs, cases, facts });
  if (analysis.problems.length > 0) {
    console.error(`${analysis.problems.length} problem(s):\n  ${analysis.problems.join("\n  ")}`);
    return 1;
  }

  // The real parser and ingest: every quote resolves once, at the paragraph the key will record.
  const problems: string[] = [];
  if (!noIngest) {
    let dataset: Awaited<ReturnType<typeof buildDataset>>;
    try {
      dataset = await buildDataset({ cases, playbookYaml, playbookSlug: PLAYBOOK_SLUG });
    } catch (error) {
      if (!(error instanceof TraceabilityError)) throw error;
      console.error(error.message);
      return 1;
    }
    const bytesOf = new Map(dataset.files.map((file) => [file.name, file.bytes]));
    const caseKeys = [...new Set(analysis.pairs.map((pair) => pair.case))];
    for (const key of caseKeys) {
      const definition = cases.find((candidate) => candidate.case === key);
      if (definition === undefined) continue;
      const documents: IngestDocumentInput[] = [];
      for (const doc of definition.documents) {
        if (doc.operative === false) continue;
        const bytes = bytesOf.get(doc.file);
        if (bytes === undefined) {
          problems.push(`${key}: ${doc.file} was not built`);
          continue;
        }
        const parsed = await parseDocument({
          bytes,
          mediaType: doc.file.endsWith(".docx") ? "docx" : "txt",
        });
        documents.push({
          documentVersionId: `dv_${doc.label.toLowerCase()}`,
          label: doc.label,
          kind: doc.kind,
          title: doc.title,
          versionNo: doc.versionNo ?? 1,
          statedDate: doc.statedDate,
          paragraphs: parsed.paragraphs,
          inspection: parsed.inspection,
        });
      }
      const ingest = buildIngest({ documents });
      for (const pair of analysis.pairs.filter((candidate) => candidate.case === key)) {
        const found = findAnchor(ingest.spans, {
          doc: pair.evidence.doc,
          clause: pair.evidence.clause,
          anchor: pair.evidence.quote,
        });
        if (!found.ok) {
          problems.push(
            `${pair.id}: the real ingest finds the quote ${found.occurrences} times (${found.reason})`,
          );
        } else if (found.span.paragraphIndex !== pair.evidence.paragraph) {
          problems.push(
            `${pair.id}: the key says paragraph ${pair.evidence.paragraph}, the real ingest says ${found.span.paragraphIndex}`,
          );
        }
      }
    }
  }
  if (problems.length > 0) {
    console.error(
      `${problems.length} problem(s) with the real ingest:\n  ${problems.join("\n  ")}`,
    );
    return 1;
  }

  if (blind) {
    const playbook = parsePlaybook(playbookYaml, PLAYBOOK_SLUG);
    console.log(
      `Blind view of the support calibration set: ${analysis.pairs.length} pairs. The labels, the kinds and the author's notes are left out.`,
    );
    console.log(
      "For each pair, decide whether the proposed status and discrepancy follow from the rule and the cited paragraph, read as they stand.\n",
    );
    for (const pair of analysis.pairs) {
      printBlindPair(
        pair,
        playbook.rules.find((rule) => rule.id === pair.rule),
        cases.find((candidate) => candidate.case === pair.case),
      );
    }
    return 0;
  }

  printCalibrationReport(analysis, summary);
  console.log(
    noIngest
      ? "\nthe real ingest was not run (--no-ingest)"
      : `\nreal ingest: all ${analysis.pairs.length} quotes found once, at the paragraph the key records`,
  );
  console.log(`\nok: calibration (${analysis.pairs.length} pairs)`);
  return 0;
}
