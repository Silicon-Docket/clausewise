/**
 * View-model builders for the pages, built from the worked example in docs/parol/04. Page tests
 * use them directly and the route tests of the next phase can reuse them, so every value here is
 * synthetic and shaped exactly as the services return it (src/services/views.ts).
 *
 * Each builder takes overrides and returns a new object, so a test changes one thing and keeps the
 * rest realistic.
 */
import type { CategoryId, MatterRole, Status } from "../../src/contracts.js";
import type {
  DocumentView,
  EvidenceView,
  FindingView,
  IssueRow,
  MatterSummary,
  MatterView,
  MemoSummary,
  PlaybookOption,
  ReviewHistoryItem,
  RunSummary,
  UploadWarningView,
  UserOption,
} from "../../src/services/views.js";
import type { Chrome } from "../../src/server/pages/layout.js";

export const IDS = {
  matter: "m_lanternfish01",
  run: "r_0142",
  staleRun: "r_0141",
  finding: "f_0917",
  memo: "memo_0001",
  nda: "doc_d1",
  amendment: "doc_d2",
  ndaV1: "dv_d1v1",
  amendmentV1: "dv_d2v1",
  playbookVersion: "pbv_parol_nda_1_0_0",
  csrf: "csrf-token-for-tests-0123456789abcdef",
} as const;

/** A 64-character hex digest that starts with `prefix`. */
export const sha = (prefix: string): string => (prefix + "0123456789abcdef".repeat(4)).slice(0, 64);

export const SHAS = {
  nda: sha("3f2a91"),
  amendment: sha("9c04e1"),
  finding: sha("51be0c4f9a21d8e3b7"),
  memo: sha("d41d8cd9"),
} as const;

export function buildChrome(overrides: Partial<Chrome> = {}): Chrome {
  return { userName: "A. Ruiz", csrfToken: IDS.csrf, notice: null, ...overrides };
}

// ---------------------------------------------------------------------------------------------
// People and playbooks
// ---------------------------------------------------------------------------------------------

export function buildUsers(): UserOption[] {
  return [
    { userId: "u_ruiz", displayName: "A. Ruiz", globalRole: "member" },
    { userId: "u_whitfield", displayName: "D. Whitfield", globalRole: "member" },
    { userId: "u_okafor", displayName: "P. Okafor", globalRole: "legal_engineer" },
    { userId: "u_lindqvist", displayName: "S. Lindqvist", globalRole: "admin" },
  ];
}

export function buildPlaybooks(): PlaybookOption[] {
  return [
    {
      versionId: IDS.playbookVersion,
      slug: "parol-nda-recipient",
      name: "Parol NDA (Recipient)",
      version: "1.0.0",
      approvedAt: "2026-10-28T09:00:00Z",
      ruleCount: 8,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Matters
// ---------------------------------------------------------------------------------------------

export function buildMatterSummary(overrides: Partial<MatterSummary> = {}): MatterSummary {
  return {
    id: IDS.matter,
    name: "Lanternfish / Corvane NDA",
    clientLegalName: "Lanternfish Software, Inc.",
    status: "in_review",
    role: "associate",
    createdAt: "2026-10-30T10:15:00Z",
    retainUntil: "2026-11-29",
    playbook: { slug: "parol-nda-recipient", version: "1.0.0" },
    synthetic: true,
    ...overrides,
  };
}

export function buildDocuments(): DocumentView[] {
  return [
    {
      documentId: IDS.nda,
      label: "D1",
      kind: "nda",
      title: "Mutual NDA",
      versions: [
        {
          versionId: IDS.ndaV1,
          versionNo: 1,
          mediaType: "docx",
          byteSize: 14_200,
          fileSha256: SHAS.nda,
          statedDate: "2026-02-02",
          operative: true,
          uploadedAt: "2026-10-30T10:20:00Z",
          uploadedByName: "A. Ruiz",
        },
      ],
    },
    {
      documentId: IDS.amendment,
      label: "D2",
      kind: "amendment",
      title: "Amendment No. 1",
      versions: [
        {
          versionId: IDS.amendmentV1,
          versionNo: 1,
          mediaType: "txt",
          byteSize: 2_100,
          fileSha256: SHAS.amendment,
          statedDate: "2026-09-15",
          operative: true,
          uploadedAt: "2026-10-30T10:24:00Z",
          uploadedByName: "A. Ruiz",
        },
      ],
    },
  ];
}

export function buildWarnings(): UploadWarningView[] {
  return [
    {
      code: "instruction_like_text",
      documentLabel: "D1",
      spanLabel: "D1-p22",
      detail: "matched imperative-addressed-to-reviewer in dv_d1v1:p22",
    },
  ];
}

export function buildRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: IDS.run,
    status: "succeeded",
    workflowLabel: "v2",
    playbook: { slug: "parol-nda-recipient", version: "1.0.0" },
    model: { provider: "scripted", requested: "test-model", reported: "test-model-2026-10" },
    startedAt: "2026-10-30T11:00:00Z",
    finishedAt: "2026-10-30T11:03:12Z",
    startedByName: "A. Ruiz",
    errorKind: null,
    current: true,
    progress: null,
    findingCount: 8,
    ...overrides,
  };
}

export function buildMemo(overrides: Partial<MemoSummary> = {}): MemoSummary {
  return {
    memoId: IDS.memo,
    runId: IDS.run,
    fileName: "lanternfish-corvane-nda-review-memo.docx",
    fileSha256: SHAS.memo,
    status: "current",
    exportedAt: "2026-11-03T16:40:00Z",
    exportedByName: "D. Whitfield",
    ...overrides,
  };
}

export function buildMatterView(overrides: Partial<MatterView> = {}): MatterView {
  const run = buildRunSummary();
  return {
    matter: buildMatterSummary(),
    members: [
      { userId: "u_ruiz", displayName: "A. Ruiz", role: "associate" },
      { userId: "u_whitfield", displayName: "D. Whitfield", role: "reviewer" },
    ],
    documents: buildDocuments(),
    warnings: buildWarnings(),
    playbooks: buildPlaybooks(),
    start: { ready: true, reasons: [] },
    activeRun: null,
    currentRun: run,
    runs: [run],
    staleReason: null,
    destination: "Text will be sent to: Anthropic API (api.anthropic.com).",
    memos: [],
    segregationRelaxed: false,
    ...overrides,
  };
}

/** The matter as a given role sees it. */
export function buildMatterViewFor(
  role: MatterRole,
  overrides: Partial<MatterView> = {},
): MatterView {
  const base = buildMatterView(overrides);
  return { ...base, matter: { ...base.matter, role } };
}

/** A matter whose documents changed after the run: stale, with a reason and a ready re-run. */
export function buildStaleMatterView(): MatterView {
  const stale = buildRunSummary({ current: false });
  return buildMatterView({
    matter: buildMatterSummary({ status: "stale" }),
    staleReason: "Amendment No. 1 has a new version that the last review did not read.",
    currentRun: null,
    runs: [stale],
  });
}

/** A matter with a review in flight. */
export function buildRunningMatterView(): MatterView {
  const active = buildRunSummary({
    status: "analyzing",
    finishedAt: null,
    progress: { stage: "analyze", done: 3, total: 8 },
    findingCount: 0,
  });
  return buildMatterView({
    matter: buildMatterSummary({ status: "running" }),
    activeRun: active,
    currentRun: null,
    runs: [active],
    start: { ready: true, reasons: [] },
  });
}

/** A new matter that cannot start yet, for the disabled button and its reasons. */
export function buildNotReadyMatterView(): MatterView {
  return buildMatterView({
    matter: buildMatterSummary({ status: "draft", playbook: null }),
    documents: [],
    warnings: [],
    currentRun: null,
    runs: [],
    start: {
      ready: false,
      reasons: [
        "Add the NDA",
        "Choose which version of the NDA is operative",
        "Choose an approved playbook",
      ],
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

interface RuleSeed {
  key: string;
  title: string;
  category: CategoryId;
  severity: "high" | "medium" | "low";
  status: Status;
}

const RULES: RuleSeed[] = [
  {
    key: "pty-1",
    title: "Parties correctly identified",
    category: "parties",
    severity: "medium",
    status: "compliant",
  },
  {
    key: "def-1",
    title: "Scope of Confidential Information",
    category: "ci-definition",
    severity: "medium",
    status: "deviation",
  },
  {
    key: "exc-1",
    title: "Four standard exclusions",
    category: "exclusions",
    severity: "high",
    status: "compliant",
  },
  {
    key: "pds-1",
    title: "Disclosure to representatives",
    category: "permitted-disclosures",
    severity: "medium",
    status: "compliant",
  },
  {
    key: "pds-2",
    title: "Disclosure required by law",
    category: "permitted-disclosures",
    severity: "medium",
    status: "missing",
  },
  {
    key: "dur-1",
    title: "Duration of confidentiality obligations",
    category: "duration",
    severity: "high",
    status: "deviation",
  },
  {
    key: "ret-1",
    title: "Return or destruction of information",
    category: "return-destruction",
    severity: "low",
    status: "not_applicable",
  },
  {
    key: "gov-1",
    title: "Governing law and forum",
    category: "governing-law",
    severity: "medium",
    status: "undetermined",
  },
];

/** The eight rows of the demo playbook. Not sorted, so a test can see the page sort them. */
export function buildIssueRows(): IssueRow[] {
  return RULES.map((rule, index): IssueRow => {
    const findingId = rule.key === "dur-1" ? IDS.finding : `f_090${index}`;
    const row: IssueRow = {
      findingId,
      ruleKey: rule.key,
      ruleTitle: rule.title,
      category: rule.category,
      severity: rule.severity,
      status: rule.status,
      validity: "current",
      verificationState: "verified",
      escalations: [],
      evidenceCount: rule.status === "missing" || rule.status === "not_applicable" ? 0 : 2,
      review: null,
    };
    if (rule.key === "exc-1") {
      row.review = {
        decision: "accept",
        reviewerName: "D. Whitfield",
        at: "2026-11-03T15:10:00Z",
        validity: "current",
      };
    }
    if (rule.key === "def-1") {
      row.review = {
        decision: "edit",
        reviewerName: "D. Whitfield",
        at: "2026-11-03T15:20:00Z",
        validity: "current",
      };
    }
    if (rule.key === "gov-1") {
      row.verificationState = "escalated_by_system";
      row.escalations = [
        { code: "conflicting_sources", detail: "dv_d1v1:p31 and dv_d2v1:p4 name different courts" },
        { code: "playbook_escalation", detail: "forum-outside-list" },
      ];
    }
    return row;
  });
}

const D1_P19 =
  "The obligations of each Receiving Party under Section 4 shall continue for two (2) years from the date of each disclosure of Confidential Information.";
const D1_P29 = "Sections 4, 5 and 8 survive any termination or expiration of this Agreement.";
const D2_P3 = "Section 6.1 of the Agreement is deleted in its entirety.";

/** Evidence whose offsets are computed from the text, so they are right by construction. */
export function buildEvidence(
  seed: {
    id: string;
    spanId: string;
    location: string;
    quote: string;
    role: EvidenceView["role"];
    spanText: string;
  } & Partial<EvidenceView>,
): EvidenceView {
  const at = seed.spanText.indexOf(seed.quote);
  return {
    evidenceId: seed.id,
    spanId: seed.spanId,
    location: seed.location,
    quote: seed.quote,
    role: seed.role,
    quoteCheck: "verified",
    supportCheck: "supported",
    offsets: at === -1 ? null : { start: at, end: at + seed.quote.length },
    spanText: seed.spanText,
    ...(seed.quoteCheck === undefined ? {} : { quoteCheck: seed.quoteCheck }),
    ...(seed.supportCheck === undefined ? {} : { supportCheck: seed.supportCheck }),
    ...(seed.offsets === undefined ? {} : { offsets: seed.offsets }),
  };
}

export function buildEvidenceList(): EvidenceView[] {
  return [
    buildEvidence({
      id: "ev_dur1_a",
      spanId: "dv_d2v1:p3",
      location: "Amendment No. 1 (v1), Section 2, paragraph 3",
      quote: "Section 6.1 of the Agreement is deleted in its entirety",
      role: "governing",
      spanText: D2_P3,
    }),
    buildEvidence({
      id: "ev_dur1_b",
      spanId: "dv_d1v1:p19",
      location: "Mutual NDA (v1), Section 6.1, paragraph 19",
      quote: "shall continue for two (2) years from the date of each disclosure",
      role: "superseded",
      spanText: D1_P19,
    }),
    buildEvidence({
      id: "ev_dur1_c",
      spanId: "dv_d1v1:p29",
      location: "Mutual NDA (v1), Section 9.3, paragraph 29",
      quote: "Sections 4, 5 and 8 survive any termination or expiration of this Agreement",
      role: "supporting",
      spanText: D1_P29,
    }),
  ];
}

const APPROVED_DUR_1 =
  "The obligations of each Receiving Party under this Agreement shall continue for three (3) years from the date of each disclosure of Confidential Information, except that obligations with respect to any trade secret shall continue for so long as it remains a trade secret under applicable law.";

/** DUR-1, as the worked example shows it: a verified deviation, awaiting review. */
export function buildFindingView(overrides: Partial<FindingView> = {}): FindingView {
  const row = buildIssueRows().find((r) => r.ruleKey === "dur-1") as IssueRow;
  return {
    issue: { ...row, evidenceCount: 3 },
    rule: {
      standard:
        "Obligations end three years or less after each disclosure. Continued protection of trade secrets for as long as they remain trade secrets is acceptable.",
      fallback: "Obligations end five years or less after the agreement ends.",
      unacceptable:
        "Obligations that are perpetual or have no stated end, for information that is not a trade secret.",
      fallbackLanguage: APPROVED_DUR_1,
      playbook: { slug: "parol-nda-recipient", version: "1.0.0" },
    },
    discrepancy:
      "Amendment No. 1 deletes Section 6.1, the only time limit on the obligations in Section 4, and Section 9.3 keeps Section 4 in force after termination. As amended, the obligations have no stated end for information that is not a trade secret, which the playbook lists as unacceptable.",
    explanation:
      "The original two-year term in Section 6.1 no longer applies. Nothing else in the Agreement or the Amendment limits how long the Section 4 obligations last.",
    fallbackLanguage:
      "6.1 The obligations of each Receiving Party under Section 4 shall continue for three (3) years from the date of each disclosure of Confidential Information, except that obligations with respect to any trade secret shall continue for so long as it remains a trade secret under applicable law.",
    fallbackBasis: "approved_adapted",
    conflict: null,
    abstainReason: null,
    evidence: buildEvidenceList(),
    checks: [
      {
        id: "quote_exists",
        kind: "deterministic",
        outcome: "pass",
        detail: "3 quotes found once each",
      },
      {
        id: "span_in_bundle",
        kind: "deterministic",
        outcome: "pass",
        detail: "3 cited paragraphs were in the bundle",
      },
      {
        id: "citation_shape",
        kind: "deterministic",
        outcome: "pass",
        detail: "status deviation is cited as it requires",
      },
      {
        id: "precedence_labels",
        kind: "deterministic",
        outcome: "pass",
        detail: "dv_d2v1:p3 deletes 6.1; dv_d1v1:p19 is labelled superseded",
      },
      {
        id: "numeric_consistency",
        kind: "deterministic",
        outcome: "not_applicable",
        detail: "the discrepancy states no number",
      },
      { id: "support", kind: "model", outcome: "pass", detail: "supported" },
      {
        id: "fallback_basis",
        kind: "deterministic",
        outcome: "pass",
        detail: "approved text adapted",
      },
    ],
    reviews: [],
    contentSha256: SHAS.finding,
    canDecide: { allowed: true, reason: null },
    ...overrides,
  };
}

/** A finding the reviewer may not decide: a viewer, say. */
export function buildUndecidableFinding(
  reason = "Only the reviewing attorney can decide findings.",
): FindingView {
  return buildFindingView({ canDecide: { allowed: false, reason } });
}

/** A finding whose inputs changed since the run: stale, with a stale decision in its history. */
export function buildStaleFinding(): FindingView {
  const finding = buildFindingView();
  const history: ReviewHistoryItem = {
    decision: "edit",
    reviewerName: "D. Whitfield",
    at: "2026-11-03T15:30:00Z",
    reason: "The parties agreed two years in February. Propose reinstating it.",
    validity: "stale",
    edits: {
      fallbackLanguage:
        "6.1 The obligations of each Receiving Party under Section 4 shall continue for two (2) years from the date of each disclosure of Confidential Information.",
    },
  };
  return {
    ...finding,
    issue: {
      ...finding.issue,
      validity: "stale",
      review: { decision: "edit", reviewerName: "D. Whitfield", at: history.at, validity: "stale" },
    },
    reviews: [history],
    canDecide: { allowed: false, reason: "This finding is out of date." },
  };
}

/** A decided finding, with the decision of the worked example in its history. */
export function buildDecidedFinding(): FindingView {
  const finding = buildFindingView();
  const history: ReviewHistoryItem = {
    decision: "edit",
    reviewerName: "D. Whitfield",
    at: "2026-11-03T15:30:00Z",
    reason:
      "The parties agreed two years in February. Propose reinstating it; three years from disclosure is the playbook's outer limit if Corvane resists.",
    validity: "current",
    edits: {
      fallbackLanguage:
        "6.1 The obligations of each Receiving Party under Section 4 shall continue for two (2) years from the date of each disclosure of Confidential Information, except that obligations with respect to any trade secret shall continue for so long as it remains a trade secret under applicable law.",
      evidenceRoles: [{ evidenceId: "ev_dur1_c", role: "governing" }],
    },
  };
  return {
    ...finding,
    issue: {
      ...finding.issue,
      review: {
        decision: "edit",
        reviewerName: "D. Whitfield",
        at: history.at,
        validity: "current",
      },
    },
    reviews: [history],
  };
}

const GOV_A = "This Agreement is governed by the laws of the State of Delaware.";
const GOV_B = "Any dispute shall be heard exclusively by the courts of Singapore.";

/** GOV-1: two operative passages that disagree, and an escalation for each. */
export function buildConflictFinding(): FindingView {
  const row = buildIssueRows().find((r) => r.ruleKey === "gov-1") as IssueRow;
  return buildFindingView({
    issue: { ...row, evidenceCount: 2 },
    rule: {
      standard:
        "The agreement is governed by the law of Delaware, New York, or England and Wales, and any exclusive forum is in one of those places.",
      fallback: null,
      unacceptable: "A governing law or an exclusive forum outside the approved list.",
      fallbackLanguage:
        "This Agreement is governed by the laws of the State of Delaware, and the parties submit to the exclusive jurisdiction of the state and federal courts located in Delaware.",
      playbook: { slug: "parol-nda-recipient", version: "1.0.0" },
    },
    discrepancy: "",
    explanation: "The governing law is Delaware, but the exclusive forum is in Singapore.",
    fallbackLanguage: null,
    fallbackBasis: "none",
    conflict: "Section 11.1 names Delaware law and Section 11.2 sends disputes to Singapore.",
    abstainReason: null,
    evidence: [
      buildEvidence({
        id: "ev_gov1_a",
        spanId: "dv_d1v1:p31",
        location: "Mutual NDA (v1), Section 11.1, paragraph 31",
        quote: "governed by the laws of the State of Delaware",
        role: "conflicting",
        spanText: GOV_A,
      }),
      buildEvidence({
        id: "ev_gov1_b",
        spanId: "dv_d1v1:p32",
        location: "Mutual NDA (v1), Section 11.2, paragraph 32",
        quote: "heard exclusively by the courts of Singapore",
        role: "conflicting",
        spanText: GOV_B,
        supportCheck: "insufficient",
      }),
    ],
    checks: [
      {
        id: "quote_exists",
        kind: "deterministic",
        outcome: "pass",
        detail: "2 quotes found once each",
      },
      {
        id: "playbook_escalation",
        kind: "deterministic",
        outcome: "pass",
        detail: "raised forum-outside-list",
      },
      {
        id: "status_forced",
        kind: "deterministic",
        outcome: "fail",
        detail: "status deviation was changed to undetermined because of conflicting_sources",
      },
    ],
  });
}

/** A finding whose second quote is not in the paragraph it names. */
export function buildUnverifiedFinding(): FindingView {
  const finding = buildFindingView();
  const bad = buildEvidence({
    id: "ev_dur1_x",
    spanId: "dv_d1v1:p19",
    location: "Mutual NDA (v1), Section 6.1, paragraph 19",
    quote: "shall continue for five (5) years after termination",
    role: "supporting",
    spanText: D1_P19,
    quoteCheck: "not_found",
    supportCheck: "not_run",
    offsets: null,
  });
  return {
    ...finding,
    issue: {
      ...finding.issue,
      verificationState: "escalated_by_system",
      escalations: [
        { code: "quote_not_verified", detail: "1 of 4 quotes was not found in its paragraph" },
      ],
    },
    evidence: [...finding.evidence, bad],
    checks: [
      {
        id: "quote_exists",
        kind: "deterministic",
        outcome: "fail",
        detail: "1 of 4 quotes not found",
      },
      ...finding.checks.slice(1),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Hostile text
// ---------------------------------------------------------------------------------------------

/**
 * Text a hostile document or a misbehaving model could contain. Each one would do harm if a page
 * wrote it into markup instead of text.
 */
export const HOSTILE: Record<string, string> = {
  script: "<script>window.pwned = 1</script>",
  img: '<img src=x onerror="window.pwned=1">',
  attributeBreak: '"><b id="pwned">bold</b><x y="',
  singleQuoteBreak: "'><svg onload=alert(1)>",
  javascriptUrl: "javascript:alert(document.cookie)",
  styleBreak: "</style><style>body{display:none}</style>",
  textareaBreak: "</textarea><script>1</script>",
  entity: "&lt;script&gt;&amp;#60;",
  comment: "<!-- --><script>1</script>",
  bidi: "pay \u202e1000\u202c now \u2066x\u2069",
  zeroWidth: "con\u200bfi\u200ddential\ufeff",
};

/**
 * A finding that cites every kind of passage there is: one of each role, a quote found more than
 * once, a quote that is not there, and a paragraph long enough to need its own scroll box. For
 * sweeps that must reach every branch of the inspector.
 */
export function buildAllKindsFinding(): FindingView {
  const long = `${"The Receiving Party shall keep the information confidential. ".repeat(40)}Final sentence.`;
  const roles = ["governing", "supporting", "definition", "superseded", "conflicting"] as const;
  const evidence = roles.map((role, index) =>
    buildEvidence({
      id: `ev_all_${role}`,
      spanId: `dv_d1v1:p${index + 1}`,
      location: `Mutual NDA (v1), Section ${index + 1}, paragraph ${index + 1}`,
      quote: "shall keep the information confidential",
      role,
      spanText: index === 0 ? long : "The Receiving Party shall keep the information confidential.",
    }),
  );
  evidence.push(
    buildEvidence({
      id: "ev_all_ambiguous",
      spanId: "dv_d1v1:p8",
      location: "Mutual NDA (v1), Section 8, paragraph 8",
      quote: "the Receiving Party",
      role: "supporting",
      spanText: "the Receiving Party and the Receiving Party",
      quoteCheck: "ambiguous",
      offsets: null,
    }),
    buildEvidence({
      id: "ev_all_missing_quote",
      spanId: "dv_d1v1:p9",
      location: "Mutual NDA (v1), Section 9, paragraph 9",
      quote: "for ever and a day",
      role: "supporting",
      spanText: "The obligations continue for two years.",
      quoteCheck: "not_found",
      supportCheck: "not_supported",
      offsets: null,
    }),
  );
  return buildFindingView({ evidence });
}
