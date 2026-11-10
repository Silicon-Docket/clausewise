import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  analyzeCases,
  buildDataset,
  formatTotals,
  readPlaybookFacts,
} from "../../../fixtures/parol/build.js";
import { CASES, PLAYBOOK_FILE, PLAYBOOK_SLUG } from "../../../fixtures/parol/cases.js";
import type { CaseDefinition } from "../../../fixtures/parol/types.js";
import { buildIngest } from "../../../apps/parol/src/ingest/ingest.js";
import { parseDocument } from "../../../apps/parol/src/ingest/parse.js";
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
 * anchors resolved, which is what a reviewer of the case wants to read.
 *
 * Unless `--no-ingest`, each candidate's files are also read the way an upload is read (the real
 * parser and ingest), and the check fails when an anchor does not resolve exactly once in the
 * real spans, when it resolves at another paragraph than the key says, or when the warnings the
 * ingest raises are not the warnings the case expects. `--docs` prints the text of each
 * candidate's operative documents with paragraph numbers and no expectations, which is what a
 * blind reader of the case sees.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const args = process.argv.slice(2);
const files = args.filter((arg) => !arg.startsWith("--"));
const summary = args.includes("--summary");
const noRender = args.includes("--no-render");
const noIngest = args.includes("--no-ingest");
const showDocs = args.includes("--docs");

if (files.length === 0) {
  console.error(
    "usage: pnpm fixtures:parol:case <case file> [...] [--summary] [--docs] [--no-render] [--no-ingest]",
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

if (summary) {
  for (const analyzed of analysis.cases) {
    if (!keys.has(analyzed.definition.case)) continue;
    console.log(`\n${analyzed.definition.case} (${analyzed.definition.split})`);
    console.log(`  ${analyzed.definition.phenomenon}`);
    for (const doc of analyzed.documents) {
      console.log(`  ${doc.definition.label} ${doc.definition.file}`);
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
  }
}

const problems: string[] = [];
if (!noRender) {
  const dataset = await buildDataset({ cases: all, playbookYaml, playbookSlug: PLAYBOOK_SLUG });
  console.log(`\n${formatTotals(dataset.totals)}`);

  if (!noIngest || showDocs) {
    const bytesOf = new Map(dataset.files.map((file) => [file.name, file.bytes]));
    for (const analyzed of analysis.cases) {
      const definition = analyzed.definition;
      if (!keys.has(definition.case)) continue;
      const scope = definition.case;
      const documents = [];
      for (const doc of definition.documents) {
        if (doc.operative === false) continue;
        const bytes = bytesOf.get(doc.file);
        if (bytes === undefined) {
          problems.push(`${scope}: ${doc.file} was not built`);
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
        if (showDocs) {
          console.log(`\n=== ${scope} ${doc.label} ${doc.title} (${doc.file}) ===`);
          parsed.paragraphs.forEach((paragraph, index) => {
            console.log(`p${index}\t${paragraph.text}`);
          });
        }
      }
      if (noIngest) continue;
      const ingest = buildIngest({ documents });
      const raised = new Set(ingest.warnings.map((warning) => warning.code));
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
