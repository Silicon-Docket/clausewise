import type { ReviewReport } from "@clausewise/review";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { EvalError } from "./errors.js";

/**
 * An independent check of a redlined file. It shares no code with packages/docx: it reads
 * word/document.xml from the zip itself and has its own idea of what a tracked change is, so a bug
 * in the redline engine's traversal cannot hide behind the same bug in the check. Both parse the
 * XML with xmldom, which is a parser and not logic about tracked changes.
 *
 * Five things must hold. Rejecting every tracked change must give back the original text of every
 * paragraph, because the tool promises that nothing is changed except by a change the lawyer can
 * reject. The tracked changes in the file must be as many as the report lists, paragraph by
 * paragraph. Accepting them must give the original text with exactly the reported edits applied,
 * which is what catches an edit that was written without its replacement. Rejecting them must
 * also give back the original formatting and paragraph properties, because clause numbers and
 * styles are not text, and every other part of the package must be untouched. Last, the comments
 * must be the ones the report lists, and text with edge spaces must say that the spaces are
 * meant, since Word drops them otherwise.
 */

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const DOCUMENT_PART = "word/document.xml";
const COMMENTS_PART = "word/comments.xml";
// The parts the pipeline is allowed to change. Everything else must come back byte for byte. The
// relationships and content types may only gain entries, for the comments part.
const REWRITTEN_PARTS = new Set([
  DOCUMENT_PART,
  COMMENTS_PART,
  "[Content_Types].xml",
  "word/_rels/document.xml.rels",
]);
// Revision marks inside properties, which never belong to the formatting itself.
const PROPERTY_REVISIONS = new Set(["ins", "del", "moveFrom", "moveTo", "rPrChange", "pPrChange"]);
const TEXT_PARTS = new Set(["t", "delText", "tab", "br", "cr", "noBreakHyphen"]);
const MAX_LISTED = 5;

// Revisions that are not text changes. The pipeline never writes them, so any difference from the
// original file means something other than the pipeline touched the document.
const FORMAT_REVISIONS = new Set([
  "rPrChange",
  "pPrChange",
  "sectPrChange",
  "tblPrChange",
  "tblGridChange",
  "tcPrChange",
  "trPrChange",
  "tblPrExChange",
  "numberingChange",
  "cellIns",
  "cellDel",
  "cellMerge",
]);
const DELETIONS = new Set(["del", "moveFrom"]);
const INSERTIONS = new Set(["ins", "moveTo"]);
// Markers that sit between the runs of a paragraph without being content.
const MARKERS = new Set([
  "commentRangeStart",
  "commentRangeEnd",
  "bookmarkStart",
  "bookmarkEnd",
  "proofErr",
  "permStart",
  "permEnd",
]);
// Elements whose runs are part of the paragraph's text, apart from the insertions and deletions
// that a view drops.
const TEXT_CONTAINERS = new Set([
  ...DELETIONS,
  ...INSERTIONS,
  "hyperlink",
  "smartTag",
  "fldSimple",
  "customXml",
]);

class UnreadableDocument extends Error {
  override name = "UnreadableDocument";
}

interface ParagraphView {
  /** The paragraph's text with every tracked change rejected. */
  rejected: string;
  /** The paragraph's text with every tracked change accepted. */
  accepted: string;
  /**
   * Tracked text changes in the paragraph that the original file does not have, an adjacent
   * deletion and insertion counting as one.
   */
  changes: number;
  /** The paragraph properties and the formatting of each stretch of text, rejected view. */
  format: string;
}

interface DocumentView {
  paragraphs: ParagraphView[];
  /** Revisions of paragraph marks, table rows and formatting. */
  otherRevisions: number;
  /** The ids of the tracked insertions and deletions, which tell old changes from new ones. */
  revisionIds: Set<string>;
  /** Text elements with edge spaces and no xml:space="preserve", which Word reads without them. */
  unprotectedSpaces: number;
  /** Comment anchors found in the body. */
  anchors: { start: number; end: number; reference: number; referenced: string[] };
  zip: JSZip;
}

export interface IntegrityResult {
  ok: boolean;
  /** What is wrong. It names paragraphs and counts, never their text. */
  problems: string[];
  paragraphs: number;
  /** Tracked changes the redlined file has beyond those of the original file. */
  trackedChanges: number;
  /** Tracked changes the report says were applied. */
  reportedChanges: number;
}

// ---------------------------------------------------------------------------------------------
// Reading the document
// ---------------------------------------------------------------------------------------------

function childElements(node: Node): Element[] {
  const out: Element[] = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === 1) out.push(child as Element);
  }
  return out;
}

/** The element's name when it is a WordprocessingML element, otherwise undefined. */
const wName = (el: Element): string | undefined =>
  el.namespaceURI === W_NS ? el.localName : undefined;

function runText(el: Element): string {
  switch (wName(el)) {
    case "t":
    case "delText":
      return el.textContent ?? "";
    case "tab":
      return "\t";
    case "br":
    case "cr":
      return "\n";
    case "noBreakHyphen":
      return "-";
    default:
      return "";
  }
}

type View = "rejected" | "accepted";

interface TextRun {
  /** The formatting of the run, written out so that two runs can be compared. */
  format: string;
  text: string;
  /**
   * What the run holds besides text: a footnote mark, a picture, a field mark. Losing one changes
   * the document without changing a character. The comment marks are the pipeline's own and are
   * checked on their own.
   */
  objects: string;
}

/**
 * A property element written out as a string, without revision marks and without the rsid
 * attributes Word adds to every edit, so that two equal properties read equal.
 */
function canonical(el: Element): string {
  const attributes = Array.from(el.attributes)
    .filter((attr) => !/^rsid/i.test(attr.localName) && !/^xmlns(:|$)/.test(attr.name))
    .map((attr) => `${attr.localName}=${attr.value}`)
    .sort()
    .join(",");
  const children = childElements(el)
    .filter((child) => !(child.namespaceURI === W_NS && PROPERTY_REVISIONS.has(child.localName)))
    .map(canonical)
    .join("");
  return `<${el.localName}${attributes === "" ? "" : ` ${attributes}`}>${children}</${el.localName}>`;
}

function propertiesOf(el: Element, name: string): string {
  const found = childElements(el).find((child) => wName(child) === name);
  return found === undefined ? "" : canonical(found);
}

// Rejecting keeps deleted text and drops inserted text, and accepting does the opposite. Content
// outside the WordprocessingML namespace, such as the alternate versions of a text box, is left
// out in the original and the redlined file alike.
function runsOf(paragraph: Element, view: View): TextRun[] {
  const dropped = view === "rejected" ? INSERTIONS : DELETIONS;
  const runs: TextRun[] = [];
  const visit = (container: Element): void => {
    for (const child of childElements(container)) {
      const name = wName(child);
      if (name === "r") {
        const parts = childElements(child).filter((part) => wName(part) !== "rPr");
        const text = parts.map(runText).join("");
        const objects = parts
          .filter((part) => {
            const kind = wName(part) ?? "";
            return !TEXT_PARTS.has(kind) && kind !== "commentReference" && kind !== "annotationRef";
          })
          .map(canonical)
          .join("");
        if (text !== "" || objects !== "") {
          runs.push({ format: propertiesOf(child, "rPr"), text, objects });
        }
      } else if (name === "sdt") {
        for (const content of childElements(child)) {
          if (wName(content) === "sdtContent") visit(content);
        }
      } else if (name !== undefined && !dropped.has(name) && TEXT_CONTAINERS.has(name)) {
        visit(child);
      }
    }
  };
  visit(paragraph);
  return runs;
}

/**
 * The paragraph properties, then the formatting of each stretch of text with runs of equal
 * formatting joined, and the objects between the stretches.
 */
function formatOf(paragraph: Element): string {
  const tokens: (string | { format: string; length: number })[] = [];
  let open: { format: string; length: number } | undefined;
  for (const run of runsOf(paragraph, "rejected")) {
    if (run.objects !== "") {
      tokens.push(`[${run.objects}]`);
      open = undefined;
    }
    if (run.text === "") continue;
    if (open !== undefined && open.format === run.format) {
      open.length += run.text.length;
    } else {
      open = { format: run.format, length: run.text.length };
      tokens.push(open);
    }
  }
  const body = tokens
    .map((token) => (typeof token === "string" ? token : `${token.format}:${token.length}`))
    .join("|");
  return `${propertiesOf(paragraph, "pPr")}|${body}`;
}

const isRevision = (name: string | undefined): name is string =>
  name !== undefined && (DELETIONS.has(name) || INSERTIONS.has(name));

const revisionId = (el: Element): string => el.getAttributeNS(W_NS, "id") ?? "";

function nestedRevisions(el: Element, known: ReadonlySet<string>): number {
  let count = 0;
  for (const child of childElements(el)) {
    const name = wName(child);
    if (isRevision(name)) count += known.has(revisionId(child)) ? 0 : 1;
    else if (name !== undefined && name !== "rPr") count += nestedRevisions(child, known);
  }
  return count;
}

/** A run with no text in it, such as a page break marker, a footnote mark or an empty run. */
const hasNoText = (el: Element): boolean =>
  wName(el) === "r" && !childElements(el).some((part) => TEXT_PARTS.has(wName(part) ?? ""));

/**
 * Counts the tracked text changes among a paragraph's direct children that are not in `known`.
 * One edit is a run of deletions followed by at most one insertion, with nothing but markers and
 * runs without text between them. Two edits that touch each other therefore read as one, which is
 * the most this check can tell from the file alone. A change the original already had is never
 * counted, and it ends the edit before it, so an edit next to an earlier reviewer's deletion is
 * still one edit.
 */
function countChanges(paragraph: Element, known: ReadonlySet<string>): number {
  let changes = 0;
  let open = false;
  for (const child of childElements(paragraph)) {
    const name = wName(child);
    if (name === "pPr") continue;
    if (isRevision(name) && known.has(revisionId(child))) {
      open = false;
    } else if (isRevision(name)) {
      if (!open) changes += 1;
      open = DELETIONS.has(name);
    } else if ((name !== undefined && MARKERS.has(name)) || hasNoText(child)) {
      continue;
    } else {
      changes += nestedRevisions(child, known);
      open = false;
    }
  }
  return changes;
}

function countOtherRevisions(body: Element): number {
  let count = 0;
  for (const el of Array.from(body.getElementsByTagNameNS(W_NS, "*"))) {
    const name = el.localName;
    if (FORMAT_REVISIONS.has(name)) {
      count += 1;
    } else if (DELETIONS.has(name) || INSERTIONS.has(name)) {
      // Inside run or row properties it marks a paragraph mark or a table row.
      const parent = el.parentNode as Element | null;
      if (
        parent !== null &&
        parent.namespaceURI === W_NS &&
        /^(rPr|trPr)$/.test(parent.localName)
      ) {
        count += 1;
      }
    }
  }
  return count;
}

// Word reads a text element without xml:space="preserve" with its edge spaces removed, so text
// that looks whole in the file can read differently on the page. Splitting a run at an edit puts
// spaces at the edge of the pieces, which is where a writer is most likely to forget.
function countUnprotectedSpaces(body: Element): number {
  let count = 0;
  for (const name of ["t", "delText"]) {
    for (const el of Array.from(body.getElementsByTagNameNS(W_NS, name))) {
      const text = el.textContent ?? "";
      if (text !== text.trim() && el.getAttributeNS(XML_NS, "space") !== "preserve") count += 1;
    }
  }
  return count;
}

function countAnchors(body: Element): DocumentView["anchors"] {
  const ids = (name: string): string[] =>
    Array.from(body.getElementsByTagNameNS(W_NS, name)).map(
      (el) => el.getAttributeNS(W_NS, "id") ?? "",
    );
  return {
    start: ids("commentRangeStart").length,
    end: ids("commentRangeEnd").length,
    reference: ids("commentReference").length,
    referenced: ids("commentReference"),
  };
}

async function readDocument(bytes: Uint8Array, known: ReadonlySet<string>): Promise<DocumentView> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new UnreadableDocument("it is not a valid zip archive");
  }
  const part = zip.file(DOCUMENT_PART);
  if (part === null) throw new UnreadableDocument(`${DOCUMENT_PART} is missing`);

  // The parser wraps whatever its error handler throws in an error of its own, so any failure to
  // parse is reported as the same plain problem.
  const parser = new DOMParser({
    onError(level) {
      if (level !== "warning") throw new Error("not well-formed");
    },
  });
  let doc: Document;
  try {
    doc = parser.parseFromString(await part.async("string"), "text/xml") as unknown as Document;
  } catch {
    throw new UnreadableDocument(`${DOCUMENT_PART} is not well-formed XML`);
  }
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
  if (body === undefined) throw new UnreadableDocument(`${DOCUMENT_PART} has no body`);

  const revisionIds = new Set<string>();
  for (const el of Array.from(body.getElementsByTagNameNS(W_NS, "*"))) {
    if (isRevision(el.localName)) revisionIds.add(revisionId(el));
  }
  return {
    paragraphs: Array.from(body.getElementsByTagNameNS(W_NS, "p")).map((paragraph) => ({
      rejected: runsOf(paragraph, "rejected")
        .map((run) => run.text)
        .join(""),
      accepted: runsOf(paragraph, "accepted")
        .map((run) => run.text)
        .join(""),
      changes: countChanges(paragraph, known),
      format: formatOf(paragraph),
    })),
    otherRevisions: countOtherRevisions(body),
    revisionIds,
    unprotectedSpaces: countUnprotectedSpaces(body),
    anchors: countAnchors(body),
    zip,
  };
}

// ---------------------------------------------------------------------------------------------
// Everything outside the text of document.xml
// ---------------------------------------------------------------------------------------------

async function commentIds(zip: JSZip): Promise<string[]> {
  const part = zip.file(COMMENTS_PART);
  if (part === null) return [];
  try {
    const doc = new DOMParser({
      onError(level) {
        if (level !== "warning") throw new Error("not well-formed");
      },
    }).parseFromString(await part.async("string"), "text/xml") as unknown as Document;
    return Array.from(doc.getElementsByTagNameNS(W_NS, "comment")).map(
      (el) => el.getAttributeNS(W_NS, "id") ?? "",
    );
  } catch {
    return [""];
  }
}

// The entries of a relationships or content types file, written out for comparison.
async function entriesOf(zip: JSZip, path: string): Promise<Set<string>> {
  const part = zip.file(path);
  if (part === null) return new Set();
  try {
    const doc = new DOMParser({
      onError(level) {
        if (level !== "warning") throw new Error("not well-formed");
      },
    }).parseFromString(await part.async("string"), "text/xml") as unknown as Document;
    return new Set(childElements(doc.documentElement).map(canonical));
  } catch {
    return new Set(["unreadable"]);
  }
}

async function comparePackages(
  original: JSZip,
  redlined: JSZip,
  problems: string[],
): Promise<void> {
  const names = (zip: JSZip): string[] =>
    Object.keys(zip.files).filter((name) => zip.files[name]?.dir !== true);
  const before = names(original);
  const after = new Set(names(redlined));
  const changed: string[] = [];
  for (const name of before) {
    if (REWRITTEN_PARTS.has(name)) continue;
    const then = await original.file(name)?.async("nodebuffer");
    const now = await redlined.file(name)?.async("nodebuffer");
    if (now === undefined) problems.push(`The redlined file lacks the part ${name}.`);
    else if (then === undefined || !then.equals(now)) changed.push(name);
  }
  if (changed.length > 0) {
    problems.push(
      ...listed(
        changed.map((name) => `The part ${name} is not the same in the redlined file.`),
        "parts",
      ),
    );
  }
  const known = new Set(before);
  for (const name of after) {
    if (!known.has(name) && name !== COMMENTS_PART) {
      problems.push(`The redlined file has a part the original lacks: ${name}.`);
    }
  }
  for (const name of ["[Content_Types].xml", "word/_rels/document.xml.rels"]) {
    const then = await entriesOf(original, name);
    const now = await entriesOf(redlined, name);
    if ([...then].some((entry) => !now.has(entry))) {
      problems.push(`The redlined file lost an entry of ${name}.`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

function firstDifference(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) if (a[i] !== b[i]) return i;
  return shared;
}

interface ReportedEdit {
  start: number;
  end: number;
  replacement: string;
}

/** The report names paragraphs as `p:<index>`, counting every paragraph of the body in order. */
function reportedByParagraph(
  report: ReviewReport,
  problems: string[],
): Map<number, ReportedEdit[]> {
  const edits = new Map<number, ReportedEdit[]>();
  for (const result of report.results) {
    if (result.edit.kind !== "applied") continue;
    const { paragraphId, start, end, replacement } = result.edit;
    const match = /^p:(\d+)$/.exec(paragraphId);
    if (match === null) {
      problems.push(`The report names a paragraph that does not exist: ${paragraphId}.`);
      continue;
    }
    const index = Number(match[1]);
    edits.set(index, [...(edits.get(index) ?? []), { start, end, replacement }]);
  }
  return edits;
}

// Edits never overlap, so applying them from the end keeps every earlier offset valid.
function withEdits(text: string, edits: readonly ReportedEdit[]): string {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (current, edit) => current.slice(0, edit.start) + edit.replacement + current.slice(edit.end),
      text,
    );
}

function listed(items: string[], noun: string): string[] {
  if (items.length <= MAX_LISTED) return items;
  return [...items.slice(0, MAX_LISTED), `And ${items.length - MAX_LISTED} more ${noun}.`];
}

// Every flagged rule gets exactly one comment, and a comment is three marks in the body and an
// entry in the comments part. A comment that was dropped, or marks without an entry, leaves the
// lawyer without the explanation the report says is there.
async function checkComments(
  original: DocumentView,
  redlined: DocumentView,
  report: ReviewReport,
  problems: string[],
): Promise<void> {
  const flagged = report.results.filter(
    (result) => result.status === "deviation" || result.status === "missing",
  ).length;
  const before = await commentIds(original.zip);
  const after = await commentIds(redlined.zip);
  const added = after.length - before.length;
  if (added !== flagged) {
    problems.push(`The redlined file has ${added} new comments and the report lists ${flagged}.`);
  }
  for (const [name, now, then] of [
    ["starts", redlined.anchors.start, original.anchors.start],
    ["ends", redlined.anchors.end, original.anchors.end],
    ["references", redlined.anchors.reference, original.anchors.reference],
  ] as const) {
    if (now - then !== flagged) {
      problems.push(
        `The body has ${now - then} new comment ${name} and the report lists ${flagged}.`,
      );
    }
  }
  const known = new Set(after);
  if (redlined.anchors.referenced.some((id) => !known.has(id))) {
    problems.push("A comment in the body refers to an entry that the comments part does not have.");
  }
  if (new Set(after).size !== after.length) {
    problems.push("The comments part has two comments with the same id.");
  }
}

export async function checkIntegrity(args: {
  original: Uint8Array;
  redlined: Uint8Array;
  report: ReviewReport;
}): Promise<IntegrityResult> {
  const { report } = args;
  let original: DocumentView;
  try {
    original = await readDocument(args.original, new Set());
  } catch (error) {
    if (!(error instanceof UnreadableDocument)) throw error;
    throw new EvalError(`The fixture cannot be read for the integrity check: ${error.message}.`);
  }

  const problems: string[] = [];
  const reported = reportedByParagraph(report, problems);
  const reportedChanges = [...reported.values()].reduce((sum, list) => sum + list.length, 0);
  if (reportedChanges !== report.stats.editsApplied) {
    problems.push(
      `The report lists ${reportedChanges} applied edits but says ${report.stats.editsApplied} ` +
        "were applied.",
    );
  }

  let redlined: DocumentView;
  try {
    redlined = await readDocument(args.redlined, original.revisionIds);
  } catch (error) {
    if (!(error instanceof UnreadableDocument)) throw error;
    problems.push(`The redlined file cannot be read: ${error.message}.`);
    return {
      ok: false,
      problems,
      paragraphs: original.paragraphs.length,
      trackedChanges: 0,
      reportedChanges,
    };
  }

  let trackedChanges = 0;
  if (redlined.paragraphs.length !== original.paragraphs.length) {
    problems.push(
      `The redlined file has ${redlined.paragraphs.length} paragraphs and the original has ` +
        `${original.paragraphs.length}.`,
    );
  } else {
    const wrongText: string[] = [];
    const wrongAccepted: string[] = [];
    const wrongCount: string[] = [];
    const wrongFormat: string[] = [];
    original.paragraphs.forEach((before, i) => {
      const after = redlined.paragraphs[i];
      if (after === undefined) return;
      // Where the text differs the stretches differ too, and that has been reported already.
      if (after.rejected === before.rejected && after.format !== before.format) {
        wrongFormat.push(
          `Paragraph p:${i} does not reject back to the original formatting or paragraph properties.`,
        );
      }
      if (after.rejected !== before.rejected) {
        wrongText.push(
          `Paragraph p:${i} does not reject back to the original text: it was ` +
            `${before.rejected.length} characters and is ${after.rejected.length}, and the first ` +
            `difference is at character ${firstDifference(before.rejected, after.rejected)}.`,
        );
      }
      const edits = reported.get(i) ?? [];
      const expectedAccepted = withEdits(before.accepted, edits);
      if (after.accepted !== expectedAccepted) {
        wrongAccepted.push(
          `Paragraph p:${i} does not accept to the original text with the reported edits ` +
            `applied: it should be ${expectedAccepted.length} characters and is ` +
            `${after.accepted.length}, and the first difference is at character ` +
            `${firstDifference(expectedAccepted, after.accepted)}.`,
        );
      }
      const added = after.changes;
      trackedChanges += added;
      const expected = edits.length;
      if (added !== expected) {
        wrongCount.push(
          `Paragraph p:${i} has ${added} tracked ${added === 1 ? "change" : "changes"} and the ` +
            `report lists ${expected}.`,
        );
      }
    });
    for (const index of reported.keys()) {
      if (index >= original.paragraphs.length) {
        wrongCount.push(
          `The report applied an edit in paragraph p:${index}, which does not exist.`,
        );
      }
    }
    problems.push(
      ...listed(wrongText, "paragraphs"),
      ...listed(wrongAccepted, "paragraphs"),
      ...listed(wrongCount, "paragraphs"),
      ...listed(wrongFormat, "paragraphs"),
    );
  }

  if (redlined.unprotectedSpaces > original.unprotectedSpaces) {
    problems.push(
      `The redlined file has ${redlined.unprotectedSpaces} text elements with a space at either end ` +
        `and no xml:space="preserve", which Word reads without the space, and the original has ` +
        `${original.unprotectedSpaces}.`,
    );
  }

  await comparePackages(original.zip, redlined.zip, problems);
  await checkComments(original, redlined, report, problems);

  if (redlined.otherRevisions !== original.otherRevisions) {
    problems.push(
      `The redlined file has ${redlined.otherRevisions} paragraph mark, table or formatting ` +
        `revisions and the original has ${original.otherRevisions}. The pipeline writes none.`,
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    paragraphs: original.paragraphs.length,
    trackedChanges,
    reportedChanges,
  };
}
