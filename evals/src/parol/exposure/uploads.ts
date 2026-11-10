/**
 * The upload-step replay (cases PAROL-D09 and PAROL-H08).
 *
 * A case with an `uploads` block says what a person does (add a document, add a version, an identical
 * copy, a re-save) and what the application should do about each file. The builder checks the key
 * against its own model of the rules (fixtures/parol/build.ts). This plays the same steps through
 * the application's real upload service (`MatterService.addDocument` and `addVersion`) in a
 * temporary store, and compares what the application did with what the key says: whether a file was
 * stored, which document and version the answer names, whether that version governs, the warnings it
 * carries, and at the end which version of each document governs.
 *
 * A mismatch is not an exposure and is not counted in gate G1. The replay cannot be trusted, so it
 * stops the run with an `UploadReplayMismatch` (exit code 2). Its message names the case, the step
 * and the fields, with values that are codes, numbers and labels. It never holds document text.
 */
import { createScriptedGenerator } from "@clausewise/llm/testing";
import type { DocLabel, WarningCode } from "../../../../apps/parol/src/contracts.js";
import type { LoadedPlaybook } from "../../../../apps/parol/src/module-contracts.js";
import { DEMO_USER_IDS } from "../../../../apps/parol/src/store/index.js";
import type { DocumentRow, DocumentVersionRow } from "../../../../apps/parol/src/store/types.js";
import type {
  AnswerKeyCase,
  Split,
  UploadExpectation,
  UploadStep,
} from "../../../../fixtures/parol/types.js";
import { EvalError } from "../../errors.js";
import type { Dataset } from "../dataset.js";
import { ExposureSuiteUnavailable, UploadReplayMismatch } from "./errors.js";
import { fileBytes } from "./files.js";
import { createExposureSite, type ExposureSite } from "./site.js";

export interface UploadReplayArgs {
  dataset: Dataset;
  root: string;
  playbook: LoadedPlaybook;
  signal: AbortSignal;
  /** The splits whose cases are replayed. Default: development only. */
  splits?: readonly Split[];
}

export interface UploadReplayResult {
  cases: string[];
  steps: number;
  sentence: string;
}

/** A model that is never called: the replay uses the upload service only. */
const inertModel = createScriptedGenerator(
  () => {
    throw new Error("the upload replay calls no model");
  },
  { disclosure: "a scripted generator that is never called: the upload replay uses no model" },
);

/** A value as a message may show it: numbers, booleans, and words that are codes or labels. */
function show(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(show).join(", ")}]`;
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,40}$/.test(value)) return `"${value}"`;
  return "(not shown)";
}

interface Difference {
  field: string;
  expected: unknown;
  got: unknown;
}

const codeOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z_]{1,40}$/.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && /^\w{1,40}$/.test(name)) return name;
  }
  return "unknown";
};

function mismatch(caseKey: string, where: string, differences: Difference[]): UploadReplayMismatch {
  const list = differences
    .map((d) => `${d.field} (expected ${show(d.expected)}, got ${show(d.got)})`)
    .join("; ");
  return new UploadReplayMismatch(
    `Upload replay mismatch: ${caseKey} ${where}, ${differences.length === 1 ? "field" : "fields"} ${list}. ` +
      "The application did not do what the answer key says. This is not an exposure; the replay cannot be trusted.",
  );
}

export async function runUploadReplay(args: UploadReplayArgs): Promise<UploadReplayResult> {
  const splits = args.splits ?? (["dev"] as const);
  const cases = args.dataset.keys.cases.filter(
    (entry) => splits.includes(entry.split) && entry.uploads !== undefined,
  );
  if (cases.length === 0)
    throw new ExposureSuiteUnavailable(
      `No case of the selected split (${splits.join(", ")}) has upload steps. Nothing was replayed.`,
    );
  let steps = 0;
  for (const key of cases) {
    args.signal.throwIfAborted();
    steps += await replayCase(args, key);
  }
  return {
    cases: cases.map((entry) => entry.case),
    steps,
    sentence:
      `Upload replay: played the ${steps} upload steps of ${cases.length} ${cases.length === 1 ? "case" : "cases"} ` +
      `(${cases.map((entry) => entry.case).join(", ")}) through the application's upload service in a temporary store, ` +
      "and every step did what the answer key says (whether a file was stored, the version the answer names, " +
      "whether it governs, its warnings), as did the version that governs each document at the end.",
  };
}

async function replayCase(args: UploadReplayArgs, key: AnswerKeyCase): Promise<number> {
  const uploads = key.uploads!;
  // Every file a step can name: the case's documents and its extra files, each against its hash.
  const bytes = new Map<string, Uint8Array>();
  for (const doc of key.documents)
    bytes.set(doc.file, await fileBytes(args.dataset, args.root, doc.file, doc.sha256));
  for (const extra of uploads.files)
    bytes.set(extra.file, await fileBytes(args.dataset, args.root, extra.file, extra.sha256));

  const site = createExposureSite({ playbook: args.playbook, generator: inertModel });
  try {
    const associate = DEMO_USER_IDS.associate;
    const summary = site.services.matters.create(site.principal(associate), {
      name: `${key.case} upload replay`,
      clientLegalName: key.intake.clientLegalName,
      playbookVersionId: site.playbookVersionId,
      reviewerUserId: DEMO_USER_IDS.reviewer,
    });
    const matterId = summary.id;

    for (const [index, step] of uploads.steps.entries()) {
      args.signal.throwIfAborted();
      const content = bytes.get(step.file);
      if (content === undefined)
        throw new EvalError(
          `${key.case} step ${index + 1}: the step names a file the key does not hold.`,
        );
      const differences = await playStep({ site, matterId, associate, step, content });
      if (differences.length > 0)
        throw mismatch(key.case, `step ${index + 1} (${step.action})`, differences);
    }

    const differences = finalDifferences(site, matterId, key);
    if (differences.length > 0) throw mismatch(key.case, "after the last step", differences);
    return uploads.steps.length;
  } finally {
    site.close();
  }
}

/** Plays one step and returns the fields in which the application differs from the step's expectation. */
async function playStep(args: {
  site: ExposureSite;
  matterId: string;
  associate: string;
  step: UploadStep;
  content: Uint8Array;
}): Promise<Difference[]> {
  const { site, matterId, step } = args;
  const am = site.authorize(args.associate, matterId, "document.write");
  const documentsBefore = site.repo.listDocuments(matterId);
  const versionsBefore = site.repo.listVersions(matterId);

  let answer: { versionId: string; warnings: { code: WarningCode }[] } | undefined;
  let thrown: unknown;
  try {
    if (step.action === "addDocument") {
      answer = await site.services.matters.addDocument(am, {
        title: step.title,
        kind: step.kind,
        fileName: step.file,
        bytes: args.content,
        statedDate: step.statedDate,
      });
    } else {
      const document = documentsBefore.find((candidate) => candidate.label === step.label);
      if (document === undefined) return [{ field: "document", expected: step.label, got: "none" }];
      answer = await site.services.matters.addVersion(am, document.id, {
        fileName: step.file,
        bytes: args.content,
        statedDate: step.statedDate,
      });
    }
  } catch (error) {
    thrown = error;
  }

  const documentsAfter = site.repo.listDocuments(matterId);
  const versionsAfter = site.repo.listVersions(matterId);
  const expect: UploadExpectation = step.expect;
  const out: Difference[] = [];

  if (expect.effect === "refused") {
    if (thrown === undefined) out.push({ field: "code", expected: expect.code, got: "no_refusal" });
    else if (codeOf(thrown) !== expect.code)
      out.push({ field: "code", expected: expect.code, got: codeOf(thrown) });
    if (documentsAfter.length !== documentsBefore.length)
      out.push({
        field: "storedDocuments",
        expected: 0,
        got: documentsAfter.length - documentsBefore.length,
      });
    if (versionsAfter.length !== versionsBefore.length)
      out.push({
        field: "storedVersions",
        expected: 0,
        got: versionsAfter.length - versionsBefore.length,
      });
    return out;
  }

  if (thrown !== undefined || answer === undefined)
    return [{ field: "answer", expected: expect.effect, got: `refused_${codeOf(thrown)}` }];

  const named = versionsAfter.find((version) => version.id === answer.versionId);
  if (named === undefined) return [{ field: "version", expected: "a stored version", got: "none" }];
  const namedDocument = documentsAfter.find((document) => document.id === named.documentId);
  const observed: UploadExpectation["effect"] =
    documentsAfter.length > documentsBefore.length
      ? "new_document"
      : versionsAfter.length > versionsBefore.length
        ? named.operative
          ? "new_version"
          : "same_text"
        : "identical_file";
  if (observed !== expect.effect)
    out.push({ field: "effect", expected: expect.effect, got: observed });
  if (namedDocument?.label !== expect.label)
    out.push({ field: "label", expected: expect.label, got: namedDocument?.label ?? "none" });
  if (
    expect.effect === "new_document" &&
    namedDocument?.label !== (step as { label: DocLabel }).label
  )
    out.push({
      field: "label",
      expected: (step as { label: DocLabel }).label,
      got: namedDocument?.label ?? "none",
    });
  if (named.versionNo !== expect.versionNo)
    out.push({ field: "versionNo", expected: expect.versionNo, got: named.versionNo });
  if (named.operative !== expect.operative)
    out.push({ field: "operative", expected: expect.operative, got: named.operative });
  if (observed !== "identical_file" && named.statedDate !== step.statedDate)
    out.push({ field: "statedDate", expected: step.statedDate, got: named.statedDate });
  const operativeInDocument = versionsAfter.filter(
    (version) => version.documentId === named.documentId && version.operative,
  ).length;
  if (operativeInDocument !== 1)
    out.push({ field: "operativeVersions", expected: 1, got: operativeInDocument });

  const warnings = answer.warnings.map((warning) => warning.code).sort();
  const wanted = [...expect.warnings].sort();
  if (JSON.stringify(warnings) !== JSON.stringify(wanted))
    out.push({ field: "warnings", expected: wanted, got: warnings });

  if (expect.effect === "same_text" || observed === "same_text") {
    const twin = versionsAfter.find(
      (version) => version.id !== named.id && version.textSha256 === named.textSha256,
    );
    const twinDocument = documentsAfter.find((document) => document.id === twin?.documentId);
    const got = twin === undefined ? null : `${twinDocument?.label ?? "none"}.v${twin.versionNo}`;
    const wantedTwin =
      expect.sameTextAs === undefined
        ? null
        : `${expect.sameTextAs.label}.v${expect.sameTextAs.versionNo}`;
    if (got !== wantedTwin) out.push({ field: "sameTextAs", expected: wantedTwin, got });
  }
  return out;
}

/** After the last step: the documents, and which version of each governs, against the key. */
function finalDifferences(site: ExposureSite, matterId: string, key: AnswerKeyCase): Difference[] {
  const documents: DocumentRow[] = site.repo.listDocuments(matterId);
  const versions: DocumentVersionRow[] = site.repo.listVersions(matterId);
  const out: Difference[] = [];
  const labels = [...new Set(key.documents.map((doc) => doc.label))].sort();
  const stored = documents.map((document) => document.label).sort();
  if (JSON.stringify(labels) !== JSON.stringify(stored))
    out.push({ field: "documents", expected: labels, got: stored });

  for (const doc of key.documents) {
    const document = documents.find((candidate) => candidate.label === doc.label);
    const version = versions.find(
      (candidate) => candidate.documentId === document?.id && candidate.fileSha256 === doc.sha256,
    );
    const where = `final.${doc.label}.v${doc.versionNo}`;
    if (version === undefined) {
      out.push({ field: `${where}.stored`, expected: true, got: false });
      continue;
    }
    if (version.versionNo !== doc.versionNo)
      out.push({ field: `${where}.versionNo`, expected: doc.versionNo, got: version.versionNo });
    if (version.operative !== (doc.operative !== false))
      out.push({
        field: `${where}.operative`,
        expected: doc.operative !== false,
        got: version.operative,
      });
    if (version.statedDate !== doc.statedDate)
      out.push({ field: `${where}.statedDate`, expected: doc.statedDate, got: version.statedDate });
  }
  for (const document of documents) {
    const governing = versions.filter(
      (version) => version.documentId === document.id && version.operative,
    ).length;
    if (governing !== 1)
      out.push({ field: `final.${document.label}.operativeVersions`, expected: 1, got: governing });
  }
  return out;
}
