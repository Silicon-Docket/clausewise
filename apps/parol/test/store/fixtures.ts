import { hashOf, sha256Hex } from "../../src/canonical.js";
import { findingContentSha256 } from "../../src/canonical.js";
import type {
  PlaybookRuleRecord,
  SourceSpan,
  SpanAnnotation,
  VerifiedFinding,
  WorkflowManifest,
} from "../../src/contracts.js";
import {
  DEMO_USER_IDS,
  createRepository,
  openDatabase,
  type FindingRecord,
  type Repository,
  type ReviewRecord,
  type RunRow,
} from "../../src/store/index.js";

/** Everything here is invented for the tests: no party, clause or playbook is taken from a real one. */

export const ACTORS = DEMO_USER_IDS;

export const NDA_PARAGRAPHS = [
  "Mutual Confidentiality Agreement between Marlowe Analytics, Inc. and Quillfeather Partners LLC.",
  "1. Parties. Marlowe Analytics, Inc. and Quillfeather Partners LLC each disclose and receive Confidential Information under this Agreement.",
  "6.1 The obligations of each Receiving Party continue for two (2) years from the date of each disclosure.",
  "9.2 This Agreement is governed by the laws of the State of Delaware.",
];

export const AMENDMENT_PARAGRAPHS = [
  "Amendment No. 1 to the Mutual Confidentiality Agreement.",
  "2. Section 6.1 of the Agreement is deleted in its entirety.",
];

export const RULES: PlaybookRuleRecord[] = [
  {
    key: "pty-1",
    category: "parties",
    title: "Parties identified",
    severity: "medium",
    required: true,
    kind: "presence",
    standard: "Each party is named by its full legal name.",
    fallback: null,
    unacceptable: null,
    guidance: null,
    fallbackLanguage: null,
    escalateWhen: [],
  },
  {
    key: "dur-1",
    category: "duration",
    title: "Duration of obligations",
    severity: "high",
    required: true,
    kind: "presence",
    standard: "Obligations end three years or less after disclosure.",
    fallback: "Five years or less after the agreement ends.",
    unacceptable: "No stated end.",
    guidance: "Propose the shorter period.",
    fallbackLanguage: "The obligations continue for two (2) years from each disclosure.",
    escalateWhen: [{ id: "no-end", text: "The agreement states no end at all." }],
  },
  {
    key: "gov-1",
    category: "governing-law",
    title: "Governing law",
    severity: "medium",
    required: true,
    kind: "presence",
    standard: "The agreement is governed by the law of an approved state.",
    fallback: null,
    unacceptable: null,
    guidance: null,
    fallbackLanguage: null,
    escalateWhen: [],
  },
];

export const PLAYBOOK_YAML = "name: Test playbook\nversion: 1.0.0\nrules: [pty-1, dur-1, gov-1]\n";

export function makeClock(startIso = "2026-11-01T09:00:00.000Z") {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t),
    /** Moves the clock forward. Rows written without a tick share a timestamp, so ordering must not rely on it. */
    tick: (ms = 1000) => {
      t += ms;
    },
    set: (iso: string) => {
      t = Date.parse(iso);
    },
    iso: () => new Date(t).toISOString(),
  };
}

export const WORKFLOW_MANIFEST: WorkflowManifest = {
  label: "v1",
  prompts: { extract: "extract.p1", analyze: "analyze.p1", support: "support.p1" },
  retrieval: "R1",
  checks: ["C1"],
  budgetTokens: 12000,
  repairAttempts: 1,
};

export function seedPrompts(repo: Repository): void {
  for (const [id, stage] of [
    ["extract.p1", "extract"],
    ["analyze.p1", "analyze"],
    ["support.p1", "support"],
  ] as const) {
    const template = `template for ${id}`;
    repo.upsertPromptVersion({
      id,
      stage,
      template,
      schemaJson: "{}",
      sha256: sha256Hex(`${id}\n${template}`),
    });
  }
}

export function makeWorld(options: { file?: string } = {}) {
  const db = openDatabase(options.file ?? ":memory:");
  const clock = makeClock();
  const repo = createRepository(db, { now: clock.now });
  repo.seedDemoUsers();
  const playbook = repo.approvePlaybookVersion(
    repo.importPlaybookDraft(
      { slug: "test-playbook", version: "1.0.0", yaml: PLAYBOOK_YAML, sha256: sha256Hex(PLAYBOOK_YAML), rules: RULES },
      { actorId: ACTORS.legalEngineer },
    ).id,
    { actorId: ACTORS.admin },
  );
  seedPrompts(repo);
  const workflow = repo.upsertWorkflowVersion({
    manifest: WORKFLOW_MANIFEST,
    sha256: hashOf(WORKFLOW_MANIFEST),
  });
  return { db, repo, clock, playbook, workflow };
}
export type World = ReturnType<typeof makeWorld>;

let counter = 0;
const hex = (n: number): string => sha256Hex(`fixture-${counter++}`).slice(0, n);

/** A path that passes the store's "inside the matter's own folder" check. */
export const fakePath = (matterId: string): string => `${matterId}/f_${hex(32)}`;

export function buildSpans(
  versionId: string,
  docLabel: "D1" | "D2" | "D3",
  paragraphs: readonly string[],
  firstClause = 1,
): SourceSpan[] {
  return paragraphs.map((text, i) => ({
    id: `${versionId}:p${i}`,
    label: `${docLabel}-p${i}`,
    modelLabel: `c${firstClause + i}`,
    documentVersionId: versionId,
    docLabel,
    paragraphIndex: i,
    clauseId: `c${i + 1}`,
    clauseNumber: /^\d/.test(text) ? (text.split(" ")[0] ?? null) : null,
    heading: null,
    text,
    textSha256: sha256Hex(text),
  }));
}

export interface MatterFixture {
  id: string;
  nda: { documentId: string; versionId: string; spanIds: string[]; texts: string[] };
  amendment?: { documentId: string; versionId: string; spanIds: string[]; texts: string[] };
}

export function addMatter(
  w: World,
  opts: { amendment?: boolean; synthetic?: boolean; spans?: boolean; pinPlaybook?: boolean; name?: string } = {},
): MatterFixture {
  const { repo } = w;
  const matter = repo.createMatter({
    name: opts.name ?? "Marlowe / Quillfeather NDA",
    clientLegalName: "Marlowe Analytics, Inc.",
    createdBy: ACTORS.associate,
    ...(opts.synthetic === undefined ? {} : { synthetic: opts.synthetic }),
  });
  const withSpans = opts.spans ?? true;

  const add = (kind: "nda" | "amendment", title: string, paragraphs: string[], statedDate: string) => {
    const text = paragraphs.join("\n");
    const { document, version } = repo.addDocument(
      matter.id,
      {
        kind,
        title,
        version: {
          mediaType: "txt",
          fileSha256: sha256Hex(`file:${matter.id}:${title}`),
          textSha256: sha256Hex(text),
          byteSize: text.length,
          statedDate,
          storagePath: fakePath(matter.id),
          operative: true,
        },
      },
      { actorId: ACTORS.associate },
    );
    const spans = buildSpans(version.id, document.label, paragraphs);
    const annotations: SpanAnnotation[] =
      kind === "amendment"
        ? [{ kind: "cross_reference", spanId: spans[1]?.id as string, target: "6.1", verb: "deletes" }]
        : [{ kind: "defines_term", spanId: spans[1]?.id as string, term: "Confidential Information" }];
    if (withSpans) repo.insertSpans(matter.id, spans, annotations);
    return { documentId: document.id, versionId: version.id, spanIds: spans.map((s) => s.id), texts: paragraphs };
  };

  const nda = add("nda", "Mutual NDA", NDA_PARAGRAPHS, "2026-01-15");
  const amendment = opts.amendment ? add("amendment", "Amendment No. 1", AMENDMENT_PARAGRAPHS, "2026-02-20") : undefined;
  if (opts.pinPlaybook ?? true) repo.setPlaybookVersion(matter.id, w.playbook.id, { actorId: ACTORS.associate });
  return { id: matter.id, nda, ...(amendment ? { amendment } : {}) };
}

/** Starts a run and moves it to `analyzing`, where findings may be saved. */
export function startRun(w: World, m: MatterFixture, stage: "queued" | "analyzing" | "verifying" = "analyzing"): RunRow {
  const { repo } = w;
  const manifest = repo.buildRunManifest(m.id, {
    workflowVersionId: w.workflow.id,
    modelProvider: "scripted",
    model: "scripted-1",
  });
  const created = repo.createRun(m.id, { manifest, startedBy: ACTORS.associate });
  const path = ["ingesting", "extracting", "retrieving", "analyzing", "verifying"] as const;
  for (const status of path) {
    if (stage === "queued") break;
    repo.updateRunStatus(m.id, created.id, status);
    if (status === stage) break;
  }
  return repo.getRun(m.id, created.id) as RunRow;
}

export function findingFor(
  ruleKey: string,
  span: { id: string; text: string },
  overrides: Partial<VerifiedFinding> = {},
): VerifiedFinding {
  const rule = RULES.find((r) => r.key === ruleKey) as PlaybookRuleRecord;
  const quote = span.text.slice(0, 24);
  const base: Omit<VerifiedFinding, "contentSha256"> = {
    ruleKey,
    category: rule.category,
    severity: rule.severity,
    status: "compliant",
    evidence: [
      {
        spanId: span.id,
        quote,
        role: "governing",
        quoteCheck: "verified",
        offsets: { start: 0, end: quote.length },
        supportCheck: "supported",
      },
    ],
    discrepancy: "",
    explanation: `The text meets rule ${ruleKey}.`,
    fallbackLanguage: null,
    fallbackBasis: "none",
    conflict: null,
    abstainReason: null,
    checks: [{ id: "quote_exists", kind: "deterministic", outcome: "pass", detail: "1 of 1 found" }],
    escalations: [],
    verificationState: "verified",
    ...overrides,
  };
  return { ...base, contentSha256: findingContentSha256(base) };
}

/** Re-hashes after a test changes a finding's content. */
export function rehash(f: VerifiedFinding): VerifiedFinding {
  return { ...f, contentSha256: findingContentSha256(f) };
}

/** One finding per rule, each citing a paragraph of the NDA. */
export function allFindings(m: MatterFixture): VerifiedFinding[] {
  const spanFor = (i: number) => ({ id: m.nda.spanIds[i] as string, text: m.nda.texts[i] as string });
  return [
    findingFor("pty-1", spanFor(1)),
    findingFor("dur-1", spanFor(2)),
    findingFor("gov-1", spanFor(3)),
  ];
}

export function saveAll(w: World, m: MatterFixture, run: RunRow): FindingRecord[] {
  return w.repo.saveFindings(m.id, run.id, allFindings(m));
}

/** Verifies and succeeds a run that is analyzing. */
export function succeed(w: World, m: MatterFixture, run: RunRow): RunRow {
  if (run.status === "analyzing") w.repo.updateRunStatus(m.id, run.id, "verifying");
  return w.repo.updateRunStatus(m.id, run.id, "succeeded");
}

/** A matter with a succeeded run and its eight (here three) findings, undecided. */
export function reviewable(w: World, opts: Parameters<typeof addMatter>[1] = {}) {
  const m = addMatter(w, opts);
  const run = startRun(w, m);
  const findings = saveAll(w, m, run);
  const done = succeed(w, m, run);
  return { m, run: done, findings };
}

export function decideAll(w: World, matterId: string, findings: FindingRecord[]): ReviewRecord[] {
  return findings.map((f) =>
    w.repo.recordReview(matterId, f.id, {
      reviewerId: ACTORS.reviewer,
      decision: "accept",
      findingContentSha256: f.contentSha256,
    }),
  );
}

/** A matter taken all the way to an exported memo. */
export function exported(w: World, opts: Parameters<typeof addMatter>[1] = {}) {
  const r = reviewable(w, opts);
  const reviews = decideAll(w, r.m.id, r.findings);
  const memo = w.repo.recordMemo(r.m.id, {
    runId: r.run.id,
    reviewIds: reviews.map((x) => x.id),
    fileSha256: sha256Hex(`memo:${r.m.id}`),
    storagePath: fakePath(r.m.id),
    exportedBy: ACTORS.reviewer,
  });
  return { ...r, reviews, memo };
}
