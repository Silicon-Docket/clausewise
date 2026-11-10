/**
 * The scripted model of the exposure suite and the generator that records what crosses the model
 * boundary.
 *
 * Nothing here is a language model and nothing is sent anywhere. The answers come from the key
 * oracle of the evaluation (oracle.ts), which answers from the answer key of the case; it is a
 * scripted stand-in and says so in its own disclosure. The capturing generator wraps whatever
 * generator it is given, keeps a copy of every request it receives (before the request goes on)
 * and of every answer it returns, and changes nothing. The copies stay in memory for the scan and
 * are never printed.
 */
import type { GenerateObjectRequest, ObjectGenerator } from "@clausewise/llm";
import type { LoadedPlaybook } from "../../../../apps/parol/src/module-contracts.js";
import type { IngestDocumentInput } from "../../../../apps/parol/src/contracts.js";
import { buildIngest } from "../../../../apps/parol/src/ingest/ingest.js";
import { parseDocument } from "../../../../apps/parol/src/ingest/parse.js";
import type { AnswerKeyCase } from "../../../../fixtures/parol/types.js";
import { createKeyOracle } from "../oracle.js";

export interface CapturedRequest {
  /** Everything the request would send as text: the system prompt, any shared prefix, the prompt. */
  text: string;
  schemaName: string | undefined;
}

export interface Captured {
  requests: CapturedRequest[];
  /** Each answer the model gave, as JSON text. A call that failed leaves no entry. */
  responses: string[];
  /** Calls that ended in an error. Counted, never kept. */
  failures: number;
}

export type CapturingGenerator = ObjectGenerator & { readonly captured: Captured };

/**
 * Records every request before it is passed on and every answer on its way back. The request is
 * copied at the moment it arrives, so whatever the caller does to its own object afterwards does
 * not change the record.
 */
export function createCapturingGenerator(inner: ObjectGenerator): CapturingGenerator {
  const captured: Captured = { requests: [], responses: [], failures: 0 };
  return {
    provider: inner.provider,
    model: inner.model,
    disclosure: inner.disclosure,
    ...(inner.cachesSharedPrefix === undefined
      ? {}
      : { cachesSharedPrefix: inner.cachesSharedPrefix }),
    ...(inner.minCacheableChars === undefined
      ? {}
      : { minCacheableChars: inner.minCacheableChars }),
    captured,
    async generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      captured.requests.push({
        text: [request.system, request.sharedPrefix ?? "", request.prompt].join("\n"),
        schemaName: request.schemaName,
      });
      try {
        const answer = await inner.generate(request);
        captured.responses.push(JSON.stringify(answer));
        return answer;
      } catch (error) {
        captured.failures += 1;
        throw error;
      }
    },
  };
}

/**
 * The key oracle for a case, built from the case's own documents. The spans it is given are the
 * ones `buildIngest` makes of the operative documents, whose model labels are the ones the
 * application's run will show (the store numbers the same spans in the same order), and every
 * anchor of the key is resolved now, so a key that no longer matches its documents stops the suite
 * here and not in the middle of a review.
 */
export async function createCaseOracle(args: {
  key: AnswerKeyCase;
  files: (name: string) => Uint8Array;
  playbook: LoadedPlaybook;
}): Promise<ObjectGenerator & { readonly calls: GenerateObjectRequest<unknown>[] }> {
  const documents: IngestDocumentInput[] = [];
  for (const doc of args.key.documents) {
    // An earlier version that a later one replaces is not part of a run.
    if (doc.operative === false) continue;
    const parsed = await parseDocument({
      bytes: args.files(doc.file),
      mediaType: doc.file.endsWith(".docx") ? "docx" : "txt",
    });
    documents.push({
      documentVersionId: `dv_oracle_${doc.label.toLowerCase()}`,
      label: doc.label,
      kind: doc.kind,
      title: doc.title,
      versionNo: doc.versionNo,
      statedDate: doc.statedDate,
      paragraphs: parsed.paragraphs,
      inspection: parsed.inspection,
    });
  }
  const ingest = buildIngest({ documents });
  return createKeyOracle({
    caseKey: args.key.case,
    expect: args.key.expect,
    spans: ingest.spans,
    rules: args.playbook.rules,
  });
}
