import type {
  CheckResult,
  DocLabel,
  DocumentKind,
  Escalation,
  IngestOutput,
  RunManifest,
  SourceSpan,
  SpanId,
} from "../../contracts.js";
import { fold } from "./text.js";

/** What one check hands back: its row for the trail and the escalations it raised. */
export interface CheckOutput {
  result: CheckResult;
  escalations: Escalation[];
}

export interface DocInfo {
  label: DocLabel;
  kind: DocumentKind;
  /** As entered at intake. Never read from the document text. */
  statedDate: string | null;
}

/** A cross-reference that changes a clause, found in an amendment. */
export interface Operation {
  spanId: SpanId;
  /** The bare number the amendment writes, such as `6.1` or `4`. */
  target: string;
  verb: "deletes" | "replaces" | "amends";
}

/**
 * The run's spans and annotations arranged for lookup, built once per verified finding. Verify
 * trusts only this: the run's own ingest output and the intake manifest, never the model.
 */
export interface RunIndex {
  spansById: ReadonlyMap<SpanId, SourceSpan>;
  docs: ReadonlyMap<string, DocInfo>;
  /** In the order of the ingest annotations, so every scan over them is deterministic. */
  operations: readonly Operation[];
  operationsBySpan: ReadonlyMap<SpanId, readonly Operation[]>;
  /** Every term some span of the run defines, folded. */
  definedTerms: readonly string[];
}

const CHANGING: ReadonlySet<string> = new Set(["deletes", "replaces", "amends"]);

export function buildRunIndex(ingest: IngestOutput, manifest: RunManifest): RunIndex {
  const spansById = new Map<SpanId, SourceSpan>();
  for (const span of ingest.spans) spansById.set(span.id, span);

  const docs = new Map<string, DocInfo>();
  for (const document of manifest.documents) {
    docs.set(document.label, {
      label: document.label,
      kind: document.kind,
      statedDate: document.statedDate,
    });
  }
  // A document the manifest does not list (a hand-built test run) is read the way ingest reads a
  // run: D1 is the NDA and every other document amends it.
  for (const span of ingest.spans) {
    if (!docs.has(span.docLabel)) {
      docs.set(span.docLabel, {
        label: span.docLabel,
        kind: span.docLabel === "D1" ? "nda" : "amendment",
        statedDate: null,
      });
    }
  }

  const operations: Operation[] = [];
  const operationsBySpan = new Map<SpanId, Operation[]>();
  const definedTerms: string[] = [];
  const seenTerms = new Set<string>();
  for (const annotation of ingest.annotations) {
    if (annotation.kind === "defines_term") {
      const term = fold(annotation.term);
      if (term !== "" && !seenTerms.has(term)) {
        seenTerms.add(term);
        definedTerms.push(term);
      }
      continue;
    }
    if (annotation.kind !== "cross_reference" || !CHANGING.has(annotation.verb)) continue;
    const span = spansById.get(annotation.spanId);
    // Only an amendment operates on a clause. Ingest already reports "refers" for an NDA, and
    // an annotation on a span the run does not have is dropped, as retrieval drops it.
    if (span === undefined || docs.get(span.docLabel)?.kind !== "amendment") continue;
    const operation: Operation = {
      spanId: annotation.spanId,
      target: annotation.target,
      verb: annotation.verb as Operation["verb"],
    };
    operations.push(operation);
    const own = operationsBySpan.get(operation.spanId);
    if (own === undefined) operationsBySpan.set(operation.spanId, [operation]);
    else own.push(operation);
  }

  return { spansById, docs, operations, operationsBySpan, definedTerms };
}

export const docOf = (index: RunIndex, span: SourceSpan): DocInfo =>
  index.docs.get(span.docLabel) ?? {
    label: span.docLabel,
    kind: span.docLabel === "D1" ? "nda" : "amendment",
    statedDate: null,
  };
