import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocx } from "@clausewise/docx";
import type { GenerateObjectRequest, ObjectGenerator } from "@clausewise/llm";
import { parsePlaybook, type Playbook } from "@clausewise/playbook";
import JSZip from "jszip";
import { contextFloor, windowReserve } from "../src/pipeline.js";
import { estimateTokens, renderClauses, windowClauses } from "../src/prompt.js";
import { segment } from "../src/segment.js";
import type { OracleRule } from "../src/testing.js";
import type { Clause, RuleCheck } from "../src/types.js";

const root = join(import.meta.dirname, "..", "..", "..");

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(root, "fixtures", name)));
}

export function loadPlaybook(file = "nda-mutual.yaml"): Playbook {
  return parsePlaybook(readFileSync(join(root, "playbooks", file), "utf8"), file);
}

export async function clausesOf(docx: Uint8Array): Promise<Clause[]> {
  return segment((await parseDocx(docx)).paragraphs);
}

/** The clause id for a number as written, so tests do not hard-code the segmenter's numbering. */
export function idOf(clauses: Clause[], number: string): string {
  const clause = clauses.find((c) => c.number === number);
  if (clause === undefined) throw new Error(`no clause ${number}`);
  return clause.id;
}

/** A playbook with the rules of `playbook` that are named, in the order given. */
export function onlyRules(playbook: Playbook, ...ids: string[]): Playbook {
  return {
    ...playbook,
    rules: ids.map((id) => {
      const rule = playbook.rules.find((r) => r.id === id);
      if (rule === undefined) throw new Error(`no rule ${id}`);
      return rule;
    }),
  };
}

/**
 * The same playbook with some rules turned into absence rules, whose standard forbids something,
 * so a contract that lacks it passes without pointing at a clause.
 */
export function withAbsence(playbook: Playbook, ...ids: string[]): Playbook {
  return {
    ...playbook,
    rules: playbook.rules.map((rule) =>
      ids.includes(rule.id) ? { ...rule, kind: "absence" as const, required: false } : rule,
    ),
  };
}

/** A run of plain text, escaped. */
export const run = (text: string): string =>
  `<w:r><w:t xml:space="preserve">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</w:t></w:r>`;

/**
 * A .docx made of the given paragraphs, for documents the fixtures do not cover. A paragraph is
 * plain text with an optional style, or the raw runs inside a `w:p` for markup such as links.
 */
export async function buildDocx(
  paragraphs: ({ text: string; style?: string } | { xml: string })[],
  /** More parts of the package, such as word/footnotes.xml, by their path. */
  extraParts: Record<string, string> = {},
): Promise<Uint8Array> {
  const body = paragraphs
    .map((paragraph) => {
      if ("xml" in paragraph) return `<w:p>${paragraph.xml}</w:p>`;
      const { text, style } = paragraph;
      const pPr = style === undefined ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
      return `<w:p>${pPr}${text === "" ? "" : run(text)}</w:p>`;
    })
    .join("");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/_rels/document.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  for (const [path, xml] of Object.entries(extraParts)) zip.file(path, xml);
  return zip.generateAsync({ type: "uint8array" });
}

const FILLER =
  "The parties have agreed that nothing in this paragraph changes what the clause above provides. ";

/**
 * The same contract with every body paragraph padded to about `chars` characters of filler that
 * shares no word with the quotes the scripts use, so the clauses stay the same for the oracle and
 * the anchoring. The signature block is dropped, because it sits in a table that buildDocx cannot
 * make. A context limit has to leave room for a clause or two, so a contract must be long before
 * it splits into windows.
 */
export async function padded(docx: Uint8Array, chars = 3600): Promise<Uint8Array> {
  const { paragraphs } = await parseDocx(docx);
  const filler = FILLER.repeat(Math.ceil(chars / FILLER.length));
  const lastClause = paragraphs.findLastIndex((p) => /^\d+\.\d+ /.test(p.text));
  return buildDocx(
    paragraphs.slice(0, lastClause + 1).map((p) => {
      const heading = p.style !== undefined && /^(heading|title)/i.test(p.style);
      return {
        text: heading || p.text === "" ? p.text : `${p.text} ${filler}`,
        ...(p.style === undefined ? {} : { style: p.style }),
      };
    }),
  );
}

/**
 * A contract of `count` clauses, each padded to about `chars` characters, for tests of limits that
 * only a long contract reaches.
 */
export function longContract(count: number, chars = 3600): Promise<Uint8Array> {
  const filler = FILLER.repeat(Math.ceil(chars / FILLER.length));
  return buildDocx(
    Array.from({ length: count }, (_, i) => ({
      text: `${i + 1}.1 Clause number ${i + 1}. ${filler}`,
    })),
  );
}

// ---------------------------------------------------------------------------------------------
// Reading a .docx the way Word would show it, independent of the code under test
// ---------------------------------------------------------------------------------------------

export interface ParagraphView {
  /** The paragraph with every tracked change accepted. */
  accepted: string;
  /** The paragraph with every tracked change rejected. */
  rejected: string;
  /** True when the paragraph holds a tracked insertion or deletion. */
  tracked: boolean;
}

export interface CommentView {
  id: string;
  author: string;
  date: string;
  /** The comment's paragraphs joined with a newline. */
  text: string;
  /** The original text under the comment's range, with tracked changes rejected. */
  anchored: string;
  /** Index of the paragraph that holds the range. */
  paragraph: number;
}

export interface DocxView {
  paragraphs: ParagraphView[];
  comments: CommentView[];
}

const TOKEN = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
const ATTRIBUTE = /([\w:.-]+)="([^"]*)"/g;

function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

interface Tag {
  name: string;
  attrs: Record<string, string>;
}

type Token = ({ kind: "open" | "close" | "empty" } & Tag) | { kind: "text"; text: string };

function tokenize(xml: string): Token[] {
  const tokens: Token[] = [];
  const body = xml.replace(/<\?[\s\S]*?\?>/g, "");
  for (const match of body.matchAll(TOKEN)) {
    const [, closing, name, rawAttrs, selfClosing, text] = match;
    if (text !== undefined) {
      tokens.push({ kind: "text", text: decode(text) });
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attr of (rawAttrs ?? "").matchAll(ATTRIBUTE)) attrs[attr[1]!] = decode(attr[2]!);
    const kind = closing === "/" ? "close" : selfClosing === "/" ? "empty" : "open";
    tokens.push({ kind, name: name!, attrs });
  }
  return tokens;
}

async function readPart(zip: JSZip, path: string): Promise<string | undefined> {
  return zip.file(path)?.async("string");
}

export async function viewDocx(buf: Uint8Array): Promise<DocxView> {
  const zip = await JSZip.loadAsync(buf);
  const paragraphs: ParagraphView[] = [];
  const ranges = new Map<string, { paragraph: number; text: string; open: boolean }>();

  const document = (await readPart(zip, "word/document.xml")) ?? "";
  const stack: string[] = [];
  let current: ParagraphView | undefined;
  for (const token of tokenize(document)) {
    if (token.kind === "text") {
      const parent = stack.at(-1);
      if (current === undefined || (parent !== "w:t" && parent !== "w:delText")) continue;
      const inserted = stack.includes("w:ins");
      if (parent === "w:t") current.accepted += token.text;
      if (parent === "w:delText" || !inserted) {
        current.rejected += token.text;
        for (const range of ranges.values()) if (range.open) range.text += token.text;
      }
      continue;
    }
    if (token.name === "w:p") {
      if (token.kind === "open") current = { accepted: "", rejected: "", tracked: false };
      if (token.kind === "empty") paragraphs.push({ accepted: "", rejected: "", tracked: false });
      if (token.kind === "close" && current !== undefined) {
        paragraphs.push(current);
        current = undefined;
      }
    }
    if (token.kind === "open" && (token.name === "w:ins" || token.name === "w:del") && current) {
      current.tracked = true;
    }
    if (token.name === "w:commentRangeStart" && token.kind !== "close") {
      ranges.set(token.attrs["w:id"] ?? "", {
        paragraph: paragraphs.length,
        text: "",
        open: true,
      });
    }
    if (token.name === "w:commentRangeEnd" && token.kind !== "close") {
      const range = ranges.get(token.attrs["w:id"] ?? "");
      if (range !== undefined) range.open = false;
    }
    if (token.kind === "open") stack.push(token.name);
    if (token.kind === "close") stack.pop();
  }

  const comments: CommentView[] = [];
  const part = await readPart(zip, "word/comments.xml");
  if (part !== undefined) {
    const lines: string[] = [];
    let meta: Record<string, string> | undefined;
    let line: string | undefined;
    for (const token of tokenize(part)) {
      if (token.kind === "text") {
        if (line !== undefined) line += token.text;
        continue;
      }
      if (token.name === "w:comment" && token.kind === "open") {
        meta = token.attrs;
        lines.length = 0;
      }
      if (token.name === "w:p" && token.kind === "open") line = "";
      if (token.name === "w:p" && token.kind === "close" && line !== undefined) {
        lines.push(line);
        line = undefined;
      }
      if (token.name === "w:comment" && token.kind === "close" && meta !== undefined) {
        const id = meta["w:id"] ?? "";
        const range = ranges.get(id);
        comments.push({
          id,
          author: meta["w:author"] ?? "",
          date: meta["w:date"] ?? "",
          text: lines.join("\n"),
          anchored: range?.text ?? "",
          paragraph: range?.paragraph ?? -1,
        });
        meta = undefined;
      }
    }
  }
  return { paragraphs, comments };
}

// ---------------------------------------------------------------------------------------------
// Scripted answers for the fixtures
// ---------------------------------------------------------------------------------------------

/**
 * What a good reviewer would say about nda-aggressive.docx against the mutual NDA playbook,
 * with three edits that go wrong on purpose: the definition edit overlaps the mutuality edit, the
 * remedies quote is not in the contract, and the governing-law quote occurs twice.
 */
export function aggressiveScript(): Record<string, OracleRule> {
  return {
    mutuality: {
      status: "deviation",
      clauseNumbers: ["1.1", "2.1"],
      explanation: "The duties bind only Recipient, and Discloser owes nothing in return.",
      comment: "Make the duties mutual by defining both parties as discloser and recipient.",
      edit: {
        clauseNumber: "1.1",
        quote: "disclosed by or on behalf of Discloser to Recipient",
        replacement: "disclosed by or on behalf of either party to the other",
      },
    },
    definition: {
      status: "deviation",
      clauseNumbers: ["1.1"],
      explanation: "The definition covers all information whether or not marked.",
      comment: "Narrow the definition to marked or reasonably confidential information.",
      edit: {
        clauseNumber: "1.1",
        quote: "all information of any kind disclosed by or on behalf of Discloser",
        replacement:
          "non-public information disclosed by or on behalf of the Disclosing Party that is marked as confidential",
      },
    },
    exclusions: {
      status: "deviation",
      clauseNumbers: ["1.2"],
      explanation: "Only one of the four standard exclusions is present.",
      comment: "Add the three missing exclusions.",
      edit: null,
    },
    term: {
      status: "deviation",
      clauseNumbers: ["3.1"],
      explanation: "The obligations are perpetual, with no trade secret limit.",
      comment: "Replace the perpetual term with three years from disclosure.",
      edit: {
        clauseNumber: "3.1",
        quote: "are perpetual and shall continue indefinitely",
        replacement: "end three (3) years after the date of disclosure",
      },
    },
    "permitted-use": {
      status: "deviation",
      clauseNumbers: ["2.2"],
      explanation: "Every onward disclosure needs the discloser's written consent.",
      comment: "Allow need-to-know sharing with bound representatives instead.",
      edit: null,
    },
    "compelled-disclosure": {
      status: "missing",
      clauseNumbers: [],
      explanation: "Nothing lets Recipient disclose what the law requires.",
      comment: "Add a legal compulsion exception with notice where permitted.",
      edit: null,
      suggestedClause:
        "Recipient may disclose Confidential Information to the extent required by law, court order or a regulator, giving Discloser prompt notice where legally permitted.",
    },
    "return-or-destroy": {
      status: "deviation",
      clauseNumbers: ["4.1"],
      explanation: "Five days, backups included, with an officer's certificate.",
      comment: "Add the backup and legal hold carve-outs and a reasonable period.",
      edit: null,
    },
    remedies: {
      status: "deviation",
      clauseNumbers: ["5.1", "5.2", "5.3"],
      explanation: "Liquidated damages, a bond waiver and one-way fee shifting.",
      comment: "Delete the stipulated sum and the one-sided costs.",
      edit: {
        clauseNumber: "5.2",
        quote: "liquidated damages of one hundred thousand dollars",
        replacement: "damages as provided by law",
      },
    },
    "restrictive-covenants": {
      status: "deviation",
      clauseNumbers: ["6.1"],
      explanation: "A non-compete and a customer non-solicit do not belong in an NDA.",
      comment: "Delete the clause.",
      edit: null,
    },
    "governing-law": {
      status: "deviation",
      clauseNumbers: ["7.1"],
      explanation: "Exclusive jurisdiction in Singapore.",
      comment: "Treat the forum as a business decision.",
      edit: {
        clauseNumber: "7.1",
        quote: "Singapore",
        replacement: "the State of Delaware",
      },
    },
  };
}

/** Compliant on every rule except return-or-destroy, which the playbook does not require. */
export function balancedScript(): Record<string, OracleRule> {
  const compliant = (...clauseNumbers: string[]): OracleRule => ({
    status: "compliant",
    clauseNumbers,
    explanation: "The clause meets the playbook standard.",
  });
  return {
    mutuality: compliant("1.1"),
    definition: compliant("1.2"),
    exclusions: compliant("2.1"),
    term: compliant("5.1"),
    "permitted-use": compliant("3.1", "3.2"),
    "compelled-disclosure": compliant("4.1"),
    "return-or-destroy": { status: "not_applicable", explanation: "No clause covers it." },
    remedies: compliant("6.1", "6.2"),
    "restrictive-covenants": {
      status: "compliant",
      explanation: "The agreement has no restrictive covenants.",
    },
    "governing-law": compliant("7.2"),
  };
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

export type Request = GenerateObjectRequest<unknown>;

export function ruleIdOf(request: Request): string {
  const block = request.prompt.slice(request.prompt.lastIndexOf("</contract>"));
  const id = /^Rule ID: (.+)$/m.exec(block)?.[1];
  if (id === undefined) throw new Error("no rule id in the prompt");
  return id;
}

/** True when the prompt's contract block holds the clause with this id. */
export const hasClause = (request: Request, clauseId: string): boolean =>
  new RegExp(`^\\[${clauseId}\\]`, "m").test(request.prompt);

/** The id of the first clause in the prompt, which tells windows apart. */
export function firstClauseId(request: Request): string {
  const id = /^\[(c\d+)\]/m.exec(request.prompt)?.[1];
  if (id === undefined) throw new Error("no clause in the prompt");
  return id;
}

/** The calls grouped by the window they were for, which the first clause in the prompt tells. */
export function byWindow(calls: readonly Request[]): Map<string, Request[]> {
  const groups = new Map<string, Request[]>();
  for (const call of calls) {
    const id = firstClauseId(call);
    groups.set(id, [...(groups.get(id) ?? []), call]);
  }
  return groups;
}

/** Runs `before` ahead of each call to `inner`, which can delay it or make it fail. */
export function intercept(
  inner: ObjectGenerator,
  before: (request: Request) => void | Promise<void>,
): ObjectGenerator & { readonly calls: Request[] } {
  const calls: Request[] = [];
  return {
    provider: inner.provider,
    model: inner.model,
    disclosure: inner.disclosure,
    cachesSharedPrefix: inner.cachesSharedPrefix === true,
    ...(inner.minCacheableChars === undefined
      ? {}
      : { minCacheableChars: inner.minCacheableChars }),
    calls,
    async generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      calls.push(request as Request);
      await before(request as Request);
      return inner.generate(request);
    },
  };
}

export const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const compliantAnswer = (overrides: Partial<RuleCheck> = {}): RuleCheck => ({
  status: "compliant",
  clauseIds: ["c1"],
  explanation: "Fine.",
  comment: "",
  edit: null,
  suggestedClause: null,
  ...overrides,
});

// ---------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------

/**
 * A maxContextTokens that makes each window hold about `perWindow` clauses, worked out the same
 * way as the pipeline's reservation so the tests do not depend on a magic number. It never goes
 * below the smallest limit the pipeline accepts, so a contract of small clauses is not split.
 */
export function budgetFor(
  playbook: Playbook,
  clauses: Clause[],
  perWindow: number,
  client?: string,
): number {
  const dearest = Math.max(...clauses.map((c) => estimateTokens(renderClauses([c]))));
  return Math.max(
    contextFloor(playbook, client) + 1,
    windowReserve(playbook, client) + perWindow * dearest,
  );
}

export function expectedWindows(
  playbook: Playbook,
  clauses: Clause[],
  maxContextTokens: number,
  client?: string,
): Clause[][] {
  return windowClauses(clauses, {
    maxTokens: maxContextTokens,
    reservedTokens: windowReserve(playbook, client),
    overlap: 1,
  });
}

// ---------------------------------------------------------------------------------------------
// A generator the test settles by hand
// ---------------------------------------------------------------------------------------------

export interface GatedCall {
  request: Request;
  ruleId: string;
  /** The id of the first clause in the prompt, which says which window the call is for. */
  window: string;
  settled: boolean;
  resolve: (answer?: RuleCheck) => void;
  reject: (error: unknown) => void;
}

export interface Gate extends ObjectGenerator {
  /** Every call started so far, in the order it started. */
  readonly calls: GatedCall[];
  readonly inFlight: number;
  readonly maxInFlight: number;
}

/**
 * Each call waits until the test settles it, so a test can see exactly which calls have started
 * at any moment. With `honourSignal` a call also fails with the abort reason when its signal
 * aborts, as a real adapter does.
 */
export function gatedGenerator(
  options: {
    cachesSharedPrefix?: boolean;
    honourSignal?: boolean;
    minCacheableChars?: number;
  } = {},
): Gate {
  const calls: GatedCall[] = [];
  const counts = { inFlight: 0, maxInFlight: 0 };
  return {
    provider: "gate",
    model: "gate-model",
    disclosure: "a gated test generator (nothing is sent anywhere)",
    cachesSharedPrefix: options.cachesSharedPrefix === true,
    ...(options.minCacheableChars === undefined
      ? {}
      : { minCacheableChars: options.minCacheableChars }),
    calls,
    get inFlight() {
      return counts.inFlight;
    },
    get maxInFlight() {
      return counts.maxInFlight;
    },
    generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      counts.inFlight += 1;
      counts.maxInFlight = Math.max(counts.maxInFlight, counts.inFlight);
      return new Promise<T>((resolve, reject) => {
        const settle = (action: () => void): void => {
          if (call.settled) return;
          call.settled = true;
          counts.inFlight -= 1;
          action();
        };
        const call: GatedCall = {
          request: request as Request,
          ruleId: ruleIdOf(request as Request),
          window: firstClauseId(request as Request),
          settled: false,
          resolve: (answer = compliantAnswer()) => settle(() => resolve(answer as T)),
          reject: (error) => settle(() => reject(error)),
        };
        calls.push(call);
        const { signal } = request;
        if (options.honourSignal === true && signal !== undefined) {
          signal.addEventListener("abort", () => call.reject(signal.reason), { once: true });
        }
      });
    },
  };
}
