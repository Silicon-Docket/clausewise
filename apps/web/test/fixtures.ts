import type {
  ConfigResponse,
  Finding,
  PlaybookDetail,
  ResultRow,
  ReviewDetail,
} from "@clausewise/api";

/** Synthetic contract text for the tests. It is not taken from any real contract. */

export const PARAGRAPH =
  "The Recipient shall keep the Confidential Information secret for a period of ten (10) years after the date of disclosure.";
export const ORIGINAL = "ten (10) years";
export const REPLACEMENT = "three (3) years";

export const CONFIG: ConfigResponse = {
  version: "0.0.0",
  authRequired: false,
  maxUploadBytes: 25 * 1024 * 1024,
  model: {
    configured: true,
    provider: "anthropic",
    model: "claude-test-model",
    disclosure: "Anthropic API (api.anthropic.com)",
  },
};

export function appliedFinding(overrides: Partial<Finding> = {}): Finding {
  const start = PARAGRAPH.indexOf(ORIGINAL);
  return {
    ruleId: "term",
    title: "Duration of confidentiality obligations",
    severity: "high",
    required: true,
    status: "deviation",
    explanation: "The obligations last ten years, and the playbook allows three.",
    comment: "Ten years is longer than our standard of three. Shorten it.",
    suggestedClause: null,
    clauses: [
      {
        id: "c4",
        number: "4.1",
        heading: "Term",
        text: PARAGRAPH,
      },
    ],
    edit: {
      kind: "applied",
      original: ORIGINAL,
      replacement: REPLACEMENT,
      paragraphText: PARAGRAPH,
      start,
      end: start + ORIGINAL.length,
    },
    decision: "pending",
    editedReplacement: null,
    ...overrides,
  };
}

export function commentOnlyFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "governing-law",
    title: "Governing law",
    severity: "medium",
    required: true,
    status: "deviation",
    explanation: "The contract is governed by the law of a place the playbook does not allow.",
    comment: "Ask for the law of England and Wales.",
    suggestedClause: null,
    clauses: [
      {
        id: "c9",
        number: "9",
        heading: "Governing law",
        text: "This Agreement is governed by the laws of a distant place.",
      },
    ],
    edit: {
      kind: "comment-only",
      proposed: {
        quote: "a distant place",
        replacement: "England and Wales",
      },
      reason: "The words to replace occur twice in the clause, so no single change could be made.",
    },
    decision: "pending",
    editedReplacement: null,
    ...overrides,
  };
}

export function missingFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "return-of-information",
    title: "Return or destruction of information",
    severity: "low",
    required: true,
    status: "missing",
    explanation: "Nothing in the contract says what happens to the information at the end.",
    comment: "Add a clause on return or destruction.",
    suggestedClause:
      "On request, the Recipient shall return or destroy the Confidential Information.",
    clauses: [],
    edit: { kind: "none" },
    decision: "pending",
    editedReplacement: null,
    ...overrides,
  };
}

export const COMPLIANT_ROW: ResultRow = {
  ruleId: "exclusions",
  title: "Standard exclusions",
  severity: "high",
  status: "compliant",
  clauseNumbers: ["3", "3.1"],
  explanation: "All four exclusions are present.",
  error: null,
};

export const NOT_APPLICABLE_ROW: ResultRow = {
  ruleId: "non-solicit",
  title: "No hidden restrictive covenants",
  severity: "medium",
  status: "not_applicable",
  clauseNumbers: [],
  explanation: "The contract has no such term.",
  error: null,
};

export const ERROR_ROW: ResultRow = {
  ruleId: "residuals",
  title: "Residual knowledge",
  severity: "medium",
  status: "error",
  clauseNumbers: [],
  explanation: "",
  error: "The model did not answer for this rule. Check it by hand.",
};

export function reviewDetail(overrides: Partial<ReviewDetail> = {}): ReviewDetail {
  return {
    id: "rev-1",
    status: "done",
    documentId: "doc-1",
    documentName: "Acme NDA.docx",
    playbookName: "Mutual NDA (receiving party)",
    client: null,
    progress: { done: 20, total: 20 },
    error: null,
    open: { high: 1, medium: 1, low: 1 },
    createdAt: "2026-10-20T09:00:00.000Z",
    startedAt: "2026-10-20T09:00:01.000Z",
    finishedAt: "2026-10-20T09:01:00.000Z",
    model: {
      provider: "anthropic",
      model: "claude-test-model",
      disclosure: "Anthropic API (api.anthropic.com)",
    },
    warnings: [],
    notShown: null,
    stats: { paragraphs: 40, clauses: 12, windows: 1, editsApplied: 1 },
    counts: { compliant: 1, deviation: 2, missing: 1, not_applicable: 1, error: 0 },
    findings: [appliedFinding(), commentOnlyFinding(), missingFinding()],
    results: [COMPLIANT_ROW, NOT_APPLICABLE_ROW],
    ...overrides,
  };
}

export function playbookDetail(overrides: Partial<PlaybookDetail> = {}): PlaybookDetail {
  return {
    id: "builtin:nda-mutual",
    source: "builtin",
    name: "Mutual NDA (receiving party)",
    contractTypes: ["nda"],
    ruleCount: 10,
    updatedAt: null,
    yaml: "name: Mutual NDA (receiving party)\ncontractTypes: [nda]\nrules: []\n",
    editable: false,
    ...overrides,
  };
}
