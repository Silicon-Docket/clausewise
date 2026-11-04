import { createRequire } from "node:module";
import JSZip from "jszip";
import { findingContentSha256, sha256Hex } from "../../src/canonical.js";
import type {
  CategoryId,
  EvidenceRole,
  Escalation,
  FallbackBasis,
  QuoteCheck,
  Status,
  VerifiedEvidence,
  VerifiedFinding,
} from "../../src/contracts.js";
import { formatLocation } from "../../src/location.js";
import type { MemoFinding, MemoInput } from "../../src/module-contracts.js";
import type { Severity } from "@clausewise/playbook";

/** Everything here is invented for the tests. No party, clause or playbook comes from a real one. */

// ---------------------------------------------------------------------------------------------
// Reading the Word file back
// ---------------------------------------------------------------------------------------------

interface XmlNode {
  nodeType: number;
  nodeName: string;
  localName?: string | null;
  textContent: string | null;
  childNodes: ArrayLike<XmlNode>;
  getAttribute?: (name: string) => string;
}
interface XmlDocument extends XmlNode {
  documentElement: XmlNode;
  getElementsByTagName: (name: string) => ArrayLike<XmlNode>;
}
interface XmlParserModule {
  DOMParser: new (options: { onError: (level: string, message: string) => void }) => {
    parseFromString: (xml: string, type: string) => XmlDocument;
  };
}

// @xmldom/xmldom is a dependency of @clausewise/docx and not of this package. Resolving it from
// that package reaches the copy the workspace already has without adding a dependency.
const fromDocx = createRequire(new URL("../../../../packages/docx/package.json", import.meta.url));
const { DOMParser } = fromDocx("@xmldom/xmldom") as XmlParserModule;

/** Parses with every warning, error and fatal error thrown, so a document that is not well formed fails. */
export function parseStrict(xml: string): XmlDocument {
  return new DOMParser({
    onError: (level, message) => {
      throw new Error(`XML ${level}: ${message}`);
    },
  }).parseFromString(xml, "text/xml");
}

/**
 * The XML 1.0 Char production, written out. xmldom accepts some characters the specification
 * forbids, so well formedness is checked by this as well.
 */
export function firstInvalidXmlChar(xml: string): { index: number; code: number } | null {
  for (let i = 0; i < xml.length;) {
    const code = xml.codePointAt(i)!;
    const ok =
      code === 0x9 ||
      code === 0xa ||
      code === 0xd ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff);
    if (!ok) return { index: i, code };
    i += code > 0xffff ? 2 : 1;
  }
  return null;
}

export interface ReadMemo {
  zip: JSZip;
  documentXml: string;
  dom: XmlDocument;
  /** Text of every body paragraph, in order, with line breaks written as "\n". */
  paragraphs: string[];
  /** Heading paragraphs as [level, text]. Level 0 is the title. */
  headings: [number, string][];
}

function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return Array.from(node.childNodes).filter((child) => child.nodeName === name);
}

function paragraphText(paragraph: XmlNode): string {
  let out = "";
  for (const run of childrenNamed(paragraph, "w:r")) {
    for (const part of Array.from(run.childNodes)) {
      if (part.nodeName === "w:t") out += part.textContent ?? "";
      else if (part.nodeName === "w:br") out += "\n";
    }
  }
  return out;
}

function styleOf(paragraph: XmlNode): string | null {
  const props = childrenNamed(paragraph, "w:pPr")[0];
  const style = props === undefined ? undefined : childrenNamed(props, "w:pStyle")[0];
  return style?.getAttribute?.("w:val") ?? null;
}

export async function readMemo(bytes: Uint8Array): Promise<ReadMemo> {
  const zip = await JSZip.loadAsync(bytes);
  const documentXml = await zip.file("word/document.xml")!.async("string");
  const dom = parseStrict(documentXml);
  const body = childrenNamed(dom.documentElement, "w:body")[0]!;
  const paragraphs: string[] = [];
  const headings: [number, string][] = [];
  const visit = (node: XmlNode): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeName === "w:p") {
        const text = paragraphText(child);
        paragraphs.push(text);
        const style = styleOf(child);
        if (style === "Title") headings.push([0, text]);
        const level = style === null ? null : /^Heading([1-6])$/.exec(style)?.[1];
        if (level !== null && level !== undefined) headings.push([Number(level), text]);
      } else if (["w:tbl", "w:tr", "w:tc"].includes(child.nodeName)) {
        visit(child);
      }
    }
  };
  visit(body);
  return { zip, documentXml, dom, paragraphs, headings };
}

/** The rows of every table in the body, each row as the text of its cells. */
export function tableRows(read: ReadMemo): string[][][] {
  const body = childrenNamed(read.dom.documentElement, "w:body")[0]!;
  return childrenNamed(body, "w:tbl").map((table) =>
    childrenNamed(table, "w:tr").map((row) =>
      childrenNamed(row, "w:tc").map((cell) =>
        childrenNamed(cell, "w:p").map(paragraphText).join("\n"),
      ),
    ),
  );
}

/** The paragraphs of one finding section, found after the Findings heading so open items cannot match. */
export function sectionOf(read: ReadMemo, number: number): string[] {
  const findings = read.paragraphs.indexOf("Findings");
  const starts = read.paragraphs
    .map((line, at) => (at > findings && line.startsWith(`${number}. `) ? at : -1))
    .filter((at) => at >= 0);
  const start = starts[0]!;
  const next = read.paragraphs.findIndex(
    (line, at) => at > start && (/^\d+\. /.test(line) || line.startsWith("Appendix A.")),
  );
  return read.paragraphs.slice(start, next);
}

/** All visible text of the body, paragraphs joined by a line feed. */
export const bodyText = (read: ReadMemo): string => read.paragraphs.join("\n");

// ---------------------------------------------------------------------------------------------
// The worked example matter
// ---------------------------------------------------------------------------------------------

export const SPAN = {
  d1Parties: "dv_d1v1:p1",
  d1Definition: "dv_d1v1:p6",
  d1Exclusions: "dv_d1v1:p8",
  d1Advisers: "dv_d1v1:p13",
  d1Duration: "dv_d1v1:p19",
  d1Return: "dv_d1v1:p23",
  d1Survival: "dv_d1v1:p29",
  d1Law: "dv_d1v1:p31",
  d2Deletes: "dv_d2v1:p3",
  d2Amends: "dv_d2v1:p4",
} as const;

export const SPAN_TEXTS: Record<string, string> = {
  [SPAN.d1Parties]:
    "This Mutual Nondisclosure Agreement is made as of 2 February 2026 between Lanternfish Software, Inc., a Delaware corporation, and Corvane Data Systems LLC, a Texas limited liability company.",
  [SPAN.d1Definition]:
    '"Confidential Information" means non-public information disclosed by a Party (the "Disclosing Party") to the other Party (the "Receiving Party") that is marked or identified as confidential at the time of disclosure, or that a reasonable person would understand to be confidential given its nature and the circumstances of disclosure.',
  [SPAN.d1Exclusions]:
    "Confidential Information does not include information that (a) is or becomes public through no fault of the Receiving Party, (b) the Receiving Party already knew without a duty of confidence, (c) the Receiving Party develops independently without using the Disclosing Party's information, or (d) the Receiving Party receives from a third party without a duty of confidence.",
  [SPAN.d1Advisers]:
    "The Receiving Party may share Confidential Information with its employees and its professional advisers who need to know it for the Purpose and who are bound by duties of confidentiality no less protective than this Agreement.",
  [SPAN.d1Duration]:
    "The obligations of each Receiving Party under Section 4 shall continue for two (2) years from the date of each disclosure of Confidential Information.",
  [SPAN.d1Return]:
    "Within ten (10) business days after the Disclosing Party's written request, the Receiving Party shall return or destroy the Disclosing Party's Confidential Information, except for copies required by law or held in routine backup systems, which remain subject to this Agreement.",
  [SPAN.d1Survival]: "Sections 4, 5 and 8 survive any termination or expiration of this Agreement.",
  [SPAN.d1Law]:
    "This Agreement is governed by the laws of the State of Texas, and the parties submit to the exclusive jurisdiction of the courts located in Travis County, Texas.",
  [SPAN.d2Deletes]: "Section 6.1 of the Agreement is deleted in its entirety.",
  [SPAN.d2Amends]:
    'Section 7.2 of the Agreement is amended by replacing "ten (10) business days" with "thirty (30) days".',
};

const SPAN_WHERE: Record<string, Parameters<typeof formatLocation>[0]> = {
  [SPAN.d1Parties]: {
    documentTitle: "Mutual NDA",
    versionNo: 1,
    clauseNumber: null,
    paragraphIndex: 1,
  },
  [SPAN.d1Definition]: {
    documentTitle: "Mutual NDA",
    versionNo: 1,
    clauseNumber: "1.2",
    paragraphIndex: 6,
  },
  [SPAN.d1Exclusions]: {
    documentTitle: "Mutual NDA",
    versionNo: 1,
    clauseNumber: "3.1",
    paragraphIndex: 8,
  },
  [SPAN.d1Advisers]: {
    documentTitle: "Mutual NDA",
    versionNo: 1,
    clauseNumber: "4.3",
    paragraphIndex: 13,
  },
  [SPAN.d1Duration]: {
    documentTitle: "Mutual NDA",
    versionNo: 1,
    clauseNumber: "6.1",
    paragraphIndex: 19,
  },
  [SPAN.d1Return]: {
    documentTitle: "Mutual NDA",
    versionNo: 1,
    clauseNumber: "7.2",
    paragraphIndex: 23,
  },
  [SPAN.d1Survival]: {
    documentTitle: "Mutual NDA",
    versionNo: 1,
    clauseNumber: "9.3",
    paragraphIndex: 29,
  },
  [SPAN.d1Law]: {
    documentTitle: "Mutual NDA",
    versionNo: 1,
    clauseNumber: "9.5",
    paragraphIndex: 31,
  },
  [SPAN.d2Deletes]: {
    documentTitle: "Amendment No. 1",
    versionNo: 1,
    clauseNumber: "2",
    paragraphIndex: 3,
  },
  [SPAN.d2Amends]: {
    documentTitle: "Amendment No. 1",
    versionNo: 1,
    clauseNumber: "3",
    paragraphIndex: 4,
  },
};

export const locationOf = (spanId: string): string => formatLocation(SPAN_WHERE[spanId]!);

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

export function passage(
  spanId: string,
  quote: string,
  role: EvidenceRole = "governing",
  quoteCheck: QuoteCheck = "verified",
): VerifiedEvidence {
  return {
    spanId,
    quote,
    role,
    quoteCheck,
    offsets: quoteCheck === "verified" ? { start: 0, end: quote.length } : null,
    supportCheck: "supported",
  };
}

export interface FindingSeed {
  ruleKey: string;
  category: CategoryId;
  severity: Severity;
  status: Status;
  evidence?: VerifiedEvidence[];
  discrepancy?: string;
  explanation?: string;
  fallbackLanguage?: string | null;
  fallbackBasis?: FallbackBasis;
  conflict?: string | null;
  abstainReason?: string | null;
  escalations?: Escalation[];
}

export function verifiedFinding(seed: FindingSeed): VerifiedFinding {
  const evidence = seed.evidence ?? [];
  const escalations = seed.escalations ?? [];
  const base = {
    ruleKey: seed.ruleKey,
    status: seed.status,
    discrepancy: seed.discrepancy ?? "",
    explanation: seed.explanation ?? "",
    fallbackLanguage: seed.fallbackLanguage ?? null,
    fallbackBasis: seed.fallbackBasis ?? ("none" as FallbackBasis),
    conflict: seed.conflict ?? null,
    evidence,
    escalations,
  };
  return {
    ruleKey: seed.ruleKey,
    category: seed.category,
    severity: seed.severity,
    status: seed.status,
    evidence,
    discrepancy: base.discrepancy,
    explanation: base.explanation,
    fallbackLanguage: base.fallbackLanguage,
    fallbackBasis: base.fallbackBasis,
    conflict: base.conflict,
    abstainReason: seed.abstainReason ?? null,
    checks: [],
    escalations,
    verificationState: escalations.length > 0 ? "escalated_by_system" : "verified",
    contentSha256: findingContentSha256(base),
  };
}

type Review = NonNullable<MemoFinding["review"]>;

export function review(
  decision: Review["decision"],
  extra: Partial<Omit<Review, "decision">> = {},
): Review {
  return {
    decision,
    reviewerName: "D. Whitfield",
    decidedAt: "2026-11-03T09:30:00.000Z",
    reason: null,
    edits: null,
    ...extra,
  };
}

export function memoFinding(finding: VerifiedFinding, decision: Review | null): MemoFinding {
  return {
    finding,
    locations: finding.evidence.map((e) => locationOf(e.spanId)),
    review: decision,
  };
}

const DUR_FALLBACK =
  "The obligations of each Receiving Party under this Agreement shall continue for three (3) years from the date of each disclosure of Confidential Information, except that obligations with respect to any trade secret shall continue for so long as it remains a trade secret under applicable law.";

export const DUR_EDITED_FALLBACK =
  "6.1 The obligations of each Receiving Party under Section 4 shall continue for two (2) years from the date of each disclosure of Confidential Information, except that obligations with respect to any trade secret shall continue for so long as it remains a trade secret under applicable law.";

export const DUR_QUOTES = {
  governing: "Section 6.1 of the Agreement is deleted in its entirety",
  superseded: "shall continue for two (2) years from the date of each disclosure",
  supporting: "Sections 4, 5 and 8 survive any termination or expiration of this Agreement",
} as const;

export const RULE_TITLES: Record<string, string> = {
  "pty-1": "Parties correctly identified",
  "def-1": "Scope of Confidential Information",
  "exc-1": "Four standard exclusions",
  "pds-1": "Disclosure to representatives",
  "pds-2": "Disclosure required by law",
  "dur-1": "Duration of confidentiality obligations",
  "ret-1": "Return or destruction of information",
  "gov-1": "Governing law and forum",
};

const SEVERITIES: Record<string, Severity> = {
  "pty-1": "medium",
  "def-1": "medium",
  "exc-1": "high",
  "pds-1": "medium",
  "pds-2": "medium",
  "dur-1": "high",
  "ret-1": "low",
  "gov-1": "medium",
};

/** The eight findings of docs/parol/04, decided: accepted 5, edited 2, escalated 1. */
export function workedFindings(): MemoFinding[] {
  const sev = (key: string): Severity => SEVERITIES[key]!;
  return [
    memoFinding(
      verifiedFinding({
        ruleKey: "pty-1",
        category: "parties",
        severity: sev("pty-1"),
        status: "compliant",
        evidence: [
          passage(
            SPAN.d1Parties,
            "between Lanternfish Software, Inc., a Delaware corporation, and Corvane Data Systems LLC",
          ),
        ],
        explanation:
          "Both parties are named with their entity types and the client matches intake.",
      }),
      review("accept"),
    ),
    memoFinding(
      verifiedFinding({
        ruleKey: "def-1",
        category: "ci-definition",
        severity: sev("def-1"),
        status: "compliant",
        evidence: [
          passage(
            SPAN.d1Definition,
            "marked or identified as confidential at the time of disclosure, or that a reasonable person would understand to be confidential",
          ),
        ],
        explanation: "The definition tracks the playbook standard.",
      }),
      review("accept"),
    ),
    memoFinding(
      verifiedFinding({
        ruleKey: "exc-1",
        category: "exclusions",
        severity: sev("exc-1"),
        status: "compliant",
        evidence: [
          passage(
            SPAN.d1Exclusions,
            "(d) the Receiving Party receives from a third party without a duty of confidence",
          ),
        ],
        explanation: "All four standard exclusions are present.",
      }),
      review("accept"),
    ),
    memoFinding(
      verifiedFinding({
        ruleKey: "pds-1",
        category: "permitted-disclosures",
        severity: sev("pds-1"),
        status: "compliant",
        evidence: [
          passage(
            SPAN.d1Advisers,
            "may share Confidential Information with its employees and its professional advisers",
          ),
        ],
        explanation: "Employees and advisers may receive the information.",
      }),
      review("edit", {
        reason: "Affiliates are not covered, which the playbook expects.",
        edits: {
          status: "deviation",
          discrepancy:
            "The clause does not let the Receiving Party share information with its affiliates.",
          fallbackLanguage:
            "The Receiving Party may disclose Confidential Information to its and its affiliates' employees, officers, contractors and professional advisers who need to know it for the Purpose.",
        },
      }),
    ),
    memoFinding(
      verifiedFinding({
        ruleKey: "pds-2",
        category: "permitted-disclosures",
        severity: sev("pds-2"),
        status: "missing",
        discrepancy: "No clause lets the Receiving Party disclose what the law requires.",
        explanation: "The documents hold no compelled-disclosure clause.",
        fallbackLanguage:
          "The Receiving Party may disclose Confidential Information to the extent required by law, provided that it gives prompt notice where legally permitted.",
        fallbackBasis: "approved_adapted",
        escalations: [
          { code: "missing_not_confirmed", detail: "keyword hints on c14 were not explained" },
        ],
      }),
      review("accept"),
    ),
    memoFinding(
      verifiedFinding({
        ruleKey: "dur-1",
        category: "duration",
        severity: sev("dur-1"),
        status: "deviation",
        evidence: [
          passage(SPAN.d2Deletes, DUR_QUOTES.governing, "governing"),
          passage(SPAN.d1Duration, DUR_QUOTES.superseded, "superseded"),
          passage(SPAN.d1Survival, DUR_QUOTES.supporting, "supporting"),
        ],
        discrepancy:
          "Amendment No. 1 deletes Section 6.1, the only time limit on the obligations in Section 4, and Section 9.3 keeps Section 4 in force after termination. As amended, the obligations have no stated end for information that is not a trade secret, which the playbook lists as unacceptable.",
        explanation:
          "The original two-year term in Section 6.1 no longer applies. Nothing else in the Agreement or the Amendment limits how long the Section 4 obligations last.",
        fallbackLanguage: DUR_FALLBACK,
        fallbackBasis: "approved_adapted",
      }),
      review("edit", {
        reason:
          "The parties agreed two years in February. Propose reinstating it; three years from disclosure is the playbook's outer limit if Corvane resists.",
        edits: { fallbackLanguage: DUR_EDITED_FALLBACK },
      }),
    ),
    memoFinding(
      verifiedFinding({
        ruleKey: "ret-1",
        category: "return-destruction",
        severity: sev("ret-1"),
        status: "compliant",
        evidence: [
          passage(
            SPAN.d2Amends,
            'replacing "ten (10) business days" with "thirty (30) days"',
            "governing",
          ),
          passage(SPAN.d1Return, "Within ten (10) business days", "superseded"),
        ],
        explanation: "As amended the deadline is thirty days, which meets the playbook.",
      }),
      review("accept"),
    ),
    memoFinding(
      verifiedFinding({
        ruleKey: "gov-1",
        category: "governing-law",
        severity: sev("gov-1"),
        status: "deviation",
        evidence: [
          passage(
            SPAN.d1Law,
            "exclusive jurisdiction of the courts located in Travis County, Texas",
          ),
        ],
        discrepancy: "The exclusive forum is outside the approved list.",
        explanation: "The playbook approves Delaware, New York, or England and Wales.",
        fallbackLanguage:
          "This Agreement is governed by the laws of the State of Delaware, and the parties submit to the exclusive jurisdiction of the state and federal courts located in Delaware.",
        fallbackBasis: "approved_verbatim",
        escalations: [{ code: "playbook_escalation", detail: "escalateWhen forum-outside-list" }],
      }),
      review("escalate", {
        reason: "Forum outside the approved list. Send to the supervising partner.",
      }),
    ),
  ];
}

export function workedExample(): MemoInput {
  const findings = workedFindings();
  return {
    matter: {
      id: "mat_0142",
      name: "Lanternfish / Corvane NDA",
      clientLegalName: "Lanternfish Software, Inc.",
    },
    playbook: {
      name: "Parol NDA (Recipient)",
      slug: "parol-nda-recipient",
      version: "1.0.0",
      sha256: sha256Hex("playbook"),
    },
    run: {
      id: "run_0142",
      workflowLabel: "v2",
      workflowSha256: sha256Hex("workflow"),
      modelProvider: "anthropic",
      modelRequested: "claude-test-model",
      modelReported: "claude-test-model-20260101",
      manifestSha256: sha256Hex("manifest"),
      startedAt: "2026-11-02T16:00:00.000Z",
    },
    documents: [
      {
        label: "D1",
        title: "Mutual NDA",
        versionNo: 1,
        statedDate: "2026-02-02",
        fileSha256: sha256Hex("d1"),
      },
      {
        label: "D2",
        title: "Amendment No. 1",
        versionNo: 1,
        statedDate: "2026-09-15",
        fileSha256: sha256Hex("d2"),
      },
    ],
    spanTexts: { ...SPAN_TEXTS },
    findings,
    ruleSeverities: { ...SEVERITIES },
    ruleTitles: { ...RULE_TITLES },
    exportedBy: "D. Whitfield",
    exportedAt: "2026-11-03T14:05:00.000Z",
    segregationRelaxed: false,
  };
}

/** A copy of the example with one finding replaced, found by rule key. */
export function replaceFinding(
  input: MemoInput,
  ruleKey: string,
  change: (item: MemoFinding) => MemoFinding,
): MemoInput {
  return {
    ...input,
    findings: input.findings.map((item) =>
      item.finding.ruleKey === ruleKey ? change(item) : item,
    ),
  };
}

export const withReview = (input: MemoInput, ruleKey: string, next: Review | null): MemoInput =>
  replaceFinding(input, ruleKey, (item) => ({ ...item, review: next }));

// ---------------------------------------------------------------------------------------------
// Bidirectional formatting, as the Unicode Bidirectional Algorithm (UAX #9) tracks it
// ---------------------------------------------------------------------------------------------

/** The depth limit of UAX #9 (BD2). */
const BIDI_MAX_DEPTH = 125;

export interface BidiState {
  /** Entries on the directional status stack, less the paragraph's own base entry. */
  open: number;
  overflowIsolates: number;
  overflowEmbeddings: number;
  validIsolates: number;
}

/**
 * Rules X1 to X8 of UAX #9 as far as they decide what is still open at the end of a paragraph:
 * the directional status stack with its depth limit, the overflow counts, and the rule that a PDF
 * is ignored while an isolate is on top of the stack. A paragraph whose state is all zeros has no
 * override, embedding or isolate left running, so nothing after it can be reordered by it. First
 * strong isolates are taken as left-to-right isolates, which opens and closes the same way.
 */
export function bidiStateAfter(text: string): BidiState {
  const stack: { level: number; isolate: boolean }[] = [{ level: 0, isolate: false }];
  let overflowIsolates = 0;
  let overflowEmbeddings = 0;
  let validIsolates = 0;
  const nextLevel = (rtl: boolean): number => {
    const top = stack[stack.length - 1]!.level;
    return rtl ? (top % 2 === 1 ? top + 2 : top + 1) : top % 2 === 0 ? top + 2 : top + 1;
  };
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const embedding = code === 0x202a || code === 0x202b || code === 0x202d || code === 0x202e;
    const isolate = code === 0x2066 || code === 0x2067 || code === 0x2068;
    if (embedding || isolate) {
      const level = nextLevel(code === 0x202b || code === 0x202e || code === 0x2067);
      const fits = level <= BIDI_MAX_DEPTH && overflowIsolates === 0 && overflowEmbeddings === 0;
      if (fits) {
        if (isolate) validIsolates += 1;
        stack.push({ level, isolate });
      } else if (isolate) overflowIsolates += 1;
      else if (overflowIsolates === 0) overflowEmbeddings += 1;
    } else if (code === 0x2069) {
      if (overflowIsolates > 0) overflowIsolates -= 1;
      else if (validIsolates > 0) {
        overflowEmbeddings = 0;
        while (!stack[stack.length - 1]!.isolate) stack.pop();
        stack.pop();
        validIsolates -= 1;
      }
    } else if (code === 0x202c) {
      if (overflowIsolates > 0) continue;
      if (overflowEmbeddings > 0) overflowEmbeddings -= 1;
      else if (!stack[stack.length - 1]!.isolate && stack.length >= 2) stack.pop();
    }
  }
  return { open: stack.length - 1, overflowIsolates, overflowEmbeddings, validIsolates };
}

export const BIDI_CLOSED: BidiState = {
  open: 0,
  overflowIsolates: 0,
  overflowEmbeddings: 0,
  validIsolates: 0,
};
