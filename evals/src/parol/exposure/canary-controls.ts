/**
 * The real-data controls of the canary scan.
 *
 * A scan for a leak over a channel that holds nothing reports zero, and so does a scan over a
 * channel that was emptied by a fault of the harness (a fetch that returns nothing, a memo that is a
 * stub, a prompt that lost its clauses). The scanner's own control (scan.ts, `runControl`) proves
 * that the scanner can find a token it is given. These controls prove the other half: that each
 * channel the scan reads holds the case's own data, so that a leak into it could have been seen.
 *
 * Every control throws `ExposureControlFailure` (exit code 2) when it fails. Every message names a
 * case, a route template, a table or a count. None holds document text, a prompt, a model answer, a
 * canary string or an id.
 */
import { EvalError } from "../../errors.js";
import { ExposureControlFailure } from "./errors.js";
import { docxParts, isZip, plainTextOf, textViewsOf, type Scanner, type TokenSet } from "./scan.js";

/** Lower case, with every run of white space made one space. */
export const squash = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/** How much of a clause is looked for: enough to tell it from any other text. */
const NEEDLE_LENGTH = 30;

/**
 * The beginnings of the texts that are long enough to be told from other text, squashed. A page, a
 * prompt or a memo that holds one of them holds text of the case.
 */
export function needlesOf(texts: readonly string[]): string[] {
  return texts
    .map((text) => squash(text))
    .filter((text) => text.length >= NEEDLE_LENGTH)
    .map((text) => text.slice(0, NEEDLE_LENGTH).trim());
}

/** Whether any view of `text` holds any of `needles` (which are squashed). */
export function holdsAny(text: string, needles: readonly string[]): boolean {
  return textViewsOf(text).some((view) => {
    const squashed = squash(view);
    return needles.some((needle) => squashed.includes(needle));
  });
}

const holdsAll = (text: string, needles: readonly string[]): boolean =>
  needles.every((needle) => holdsAny(text, [needle]));

const utf8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");

// ---------------------------------------------------------------------------------------------
// The model boundary
// ---------------------------------------------------------------------------------------------

/**
 * Every prompt holds text of the case, and a prompt for one rule names a rule of the playbook. A
 * prompt that lost its clauses cannot show a retrieval leak, whatever the scan finds in it.
 */
export function checkPrompts(args: {
  caseKey: string;
  requests: readonly { text: string; schemaName: string | undefined }[];
  needles: readonly string[];
  ruleKeys: readonly string[];
}): void {
  const { caseKey, requests, needles } = args;
  if (needles.length === 0)
    throw new EvalError(`${caseKey}: the case has no clause long enough to check a prompt for.`);
  const rules = new Set(args.ruleKeys.map((key) => key.toLowerCase()));
  const empty = requests.filter((request) => !holdsAny(request.text, needles)).length;
  const unnamed = requests.filter((request) => {
    if (request.schemaName !== "analyze_rule") return false;
    const rule = /^rule id: (\S+)$/m.exec(request.text.toLowerCase())?.[1];
    return rule === undefined || !rules.has(rule);
  }).length;
  if (empty > 0 || unnamed > 0)
    throw new ExposureControlFailure(
      `${caseKey}: ${empty} of ${requests.length} prompts held none of the case's own clause text and ${unnamed} named no rule of the playbook, so a scan of the prompts could not have seen a leak. No count can be trusted.`,
    );
}

/** Every request got an answer (or failed), and every answer is a non-empty JSON object. */
export function checkAnswers(args: {
  caseKey: string;
  requests: number;
  responses: readonly unknown[];
  failures: number;
}): void {
  const { caseKey, responses } = args;
  const unreadable = responses.filter((response) => {
    if (typeof response !== "string" || response.length === 0) return true;
    try {
      const value: unknown = JSON.parse(response);
      return typeof value !== "object" || value === null || Object.keys(value).length === 0;
    } catch {
      return true;
    }
  }).length;
  if (responses.length + args.failures !== args.requests || unreadable > 0)
    throw new ExposureControlFailure(
      `${caseKey}: ${args.requests} requests were recorded with ${responses.length} answers and ${args.failures} failures, and ${unreadable} answers were empty or did not parse, so a scan of the answers could not have seen a leak. No count can be trusted.`,
    );
}

/** The services' log holds something. */
export function checkLog(caseKey: string, lines: readonly string[]): void {
  if (lines.join("").trim().length === 0)
    throw new ExposureControlFailure(
      `${caseKey}: the services' log is empty, so a scan of it could not have seen a leak. No count can be trusted.`,
    );
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

/**
 * A page that a member of the case matter can read and that loaded: its body is not empty, a JSON
 * body parses, and a Word download starts as a package. `label` is a route template.
 */
export function checkBody(args: { label: string; contentType: string; bytes: Uint8Array }): void {
  const { label, contentType, bytes } = args;
  if (bytes.length === 0)
    throw new ExposureControlFailure(
      `A page that loaded had an empty body (${label}), so a scan of it could not have seen a leak. No count can be trusted.`,
    );
  if (/json/i.test(contentType)) {
    try {
      JSON.parse(utf8(bytes));
    } catch {
      throw new ExposureControlFailure(
        `A JSON route answered with a body that does not parse (${label}), so a scan of it could not have seen a leak. No count can be trusted.`,
      );
    }
  }
  if (/officedocument|zip/i.test(contentType) && !isZip(bytes))
    throw new ExposureControlFailure(
      `A route that serves a Word file answered with something that is not a package (${label}). No count can be trusted.`,
    );
}

/** The pages that must hold the case's matter name and its client, and those that must hold its clauses. */
const NAME_PAGES = ["GET /matters/:matterId", "GET /api/matters/:matterId"] as const;
const CLAUSE_PAGES = [
  "GET /matters/:matterId/findings/:findingId",
  "GET /api/matters/:matterId/findings/:findingId",
] as const;

/**
 * What a member's own pages must hold. The names pages must hold the matter's name and its client
 * in every body; at least one finding page of each kind must hold text of the case. Collected as the
 * pages are read, and required when the member has read them all.
 */
export interface OwnPages {
  note(label: string, body: string): void;
  require(who: string): void;
}

export function ownPages(args: {
  caseKey: string;
  names: readonly string[];
  needles: readonly string[];
}): OwnPages {
  const names = args.names.map((name) => squash(name));
  const seen = new Map<string, { bodies: number; holding: number }>();
  const state = (label: string): { bodies: number; holding: number } => {
    let found = seen.get(label);
    if (found === undefined) {
      found = { bodies: 0, holding: 0 };
      seen.set(label, found);
    }
    return found;
  };
  return {
    note(label, body) {
      const isName = (NAME_PAGES as readonly string[]).includes(label);
      const isClause = (CLAUSE_PAGES as readonly string[]).includes(label);
      if (!isName && !isClause) return;
      const entry = state(label);
      entry.bodies += 1;
      if (isName ? holdsAll(body, names) : holdsAny(body, args.needles)) entry.holding += 1;
    },
    require(who) {
      const wrong: string[] = [];
      for (const label of NAME_PAGES) {
        const entry = seen.get(label);
        if (entry === undefined || entry.bodies === 0 || entry.holding !== entry.bodies)
          wrong.push(label);
      }
      for (const label of CLAUSE_PAGES) {
        const entry = seen.get(label);
        if (entry === undefined || entry.holding === 0) wrong.push(label);
      }
      if (wrong.length > 0)
        throw new ExposureControlFailure(
          `${args.caseKey}: the pages that ${who} read for the case matter did not hold the case's own names or clause text (${wrong.join(", ")}), so a scan of them could not have seen a leak. No count can be trusted.`,
        );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The memo
// ---------------------------------------------------------------------------------------------

/**
 * The exported memo opens as a Word package whose document part is not empty and holds what the
 * memo says of the case: its matter name, its client and, when the key names any, at least one of
 * the passages it quotes. (The memo holds the quotations of the findings, the names and the
 * discrepancy and explanation text, not the clauses in full.)
 */
export async function checkMemo(args: {
  caseKey: string;
  bytes: Uint8Array;
  names: readonly string[];
  quotes: readonly string[];
}): Promise<void> {
  const parts = await docxParts(args.bytes, `${args.caseKey}: the exported memo`);
  const document = parts.find((part) => part.name === "word/document.xml");
  const fail = (what: string): ExposureControlFailure =>
    new ExposureControlFailure(
      `${args.caseKey}: the exported memo ${what}, so a scan of it could not have seen a leak. No count can be trusted.`,
    );
  if (document === undefined) throw fail("is not a Word package with a document part");
  if (squash(plainTextOf(document.text)).length === 0) throw fail("has an empty document part");
  const names = args.names.map((name) => squash(name));
  if (!holdsAll(document.text, names))
    throw fail("does not hold the case's matter name and client");
  const quotes = needlesOf(args.quotes);
  if (quotes.length > 0 && !holdsAny(document.text, quotes))
    throw fail("quotes none of the passages the key names");
}

// ---------------------------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------------------------

/**
 * The rows of a matter hold every token that is scanned for in them, one by one: each canary string
 * and each id. (A full-set scan reports an id that is a part of a longer id once, as the longer one,
 * so it cannot tell whether the shorter one is there at all.) A token that the matter's own rows do
 * not hold is a token the scan could not have found anywhere.
 */
export async function requireTokensIn(args: {
  scanner: Scanner;
  what: string;
  content: string;
  tokens: TokenSet;
}): Promise<void> {
  const { scanner, content, tokens } = args;
  let missing = 0;
  const total = tokens.canary.length + tokens.ids.length;
  for (const value of tokens.canary) {
    const hits = await scanner.scan({
      kind: "store_rows",
      label: "own rows",
      content,
      forbid: { canary: [value], ids: [] },
    });
    if (hits.length !== 1) missing += 1;
  }
  for (const value of tokens.ids) {
    const hits = await scanner.scan({
      kind: "store_rows",
      label: "own rows",
      content,
      forbid: { canary: [], ids: [value] },
    });
    if (hits.length !== 1) missing += 1;
  }
  if (missing > 0)
    throw new ExposureControlFailure(
      `${args.what} do not hold ${missing} of the ${total} canary strings and ids that are scanned for in them, so a scan for them could not see a leak. No count can be trusted.`,
    );
}
