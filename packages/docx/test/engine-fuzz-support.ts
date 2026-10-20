import type { Comment, Edit } from "../src/index.js";
import { Rng } from "./engine-support.js";
import { parseXmlForTest } from "./helpers.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const MATH = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const MC_DECL = `xmlns:mc="${MC}"`;
const M_DECL = `xmlns:m="${MATH}"`;
const REVISION = 'w:author="Other" w:date="2026-01-01T00:00:00Z"';
export const OUR_AUTHOR = "Clausewise";

/** A stretch of paragraph text and whether an edit may reach into it. */
export interface Granule {
  text: string;
  editable: boolean;
}

export interface GenPara {
  xml: string;
  granules: Granule[];
  /** Offsets in the paragraph text at which something sits that a range edit must not cross. */
  barriers: number[];
  nested: GenPara[];
  inTextBox: boolean;
}

export interface GenDoc {
  bodyXml: string;
  /** Every paragraph the review lists, in document order. */
  paragraphs: GenPara[];
}

const textOf = (p: GenPara): string => p.granules.map((g) => g.text).join("");
export { textOf as genText };

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const WORDS = [
  "Alpha",
  "beta",
  "gamma,",
  "delta.",
  "12",
  "(3)",
  "A&B",
  "x<y",
  "\u{1F600}",
  "\u{1D49C}z",
  "\u00E9t\u00E9",
  "\u6F22\u5B57",
  "-",
  "Section 4.2",
];

interface Ctx {
  nextId: number;
  /** Fields still open in the story being generated. */
  fieldOpen: number;
}

class Builder {
  xml = "";
  granules: Granule[] = [];
  barriers: number[] = [];
  nested: GenPara[] = [];
  length = 0;

  text(text: string, editable: boolean): void {
    if (text === "") return;
    this.granules.push({ text, editable });
    this.length += text.length;
  }

  barrier(): void {
    this.barriers.push(this.length);
  }
}

function phrase(rng: Rng): string {
  const n = rng.range(1, 4);
  let out = "";
  for (let i = 0; i < n; i++) {
    out += rng.pick(WORDS);
    if (i < n - 1) out += rng.pick([" ", " ", " ", "  ", "\u00A0"]);
  }
  if (rng.chance(0.15)) out = ` ${out}`;
  if (rng.chance(0.15)) out = `${out} `;
  if (rng.chance(0.04)) out = "";
  return out;
}

function runProps(rng: Rng, ctx: Ctx): string {
  switch (rng.int(7)) {
    case 0:
      return "<w:b/>";
    case 1:
      return '<w:i/><w:color w:val="FF0000"/>';
    case 2:
      return '<w:rStyle w:val="Strong"/>';
    case 3:
      return '<w:vanish w:val="0"/>';
    case 4:
      return `<w:b/><w:rPrChange w:id="${ctx.nextId++}" ${REVISION}><w:rPr/></w:rPrChange>`;
    default:
      return "";
  }
}

function plainRun(rng: Rng, ctx: Ctx, b: Builder, text = phrase(rng)): string {
  const props = runProps(rng, ctx);
  const space = rng.chance(0.75) ? ' xml:space="preserve"' : "";
  b.text(text, ctx.fieldOpen === 0);
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t${space}>${esc(text)}</w:t></w:r>`;
}

/** Runs that are not direct children of the paragraph, so they are visible but never editable. */
function wrappedRuns(rng: Rng, ctx: Ctx, b: Builder): string {
  const n = rng.range(1, 2);
  const texts: string[] = [];
  let xml = "";
  for (let i = 0; i < n; i++) {
    const text = phrase(rng);
    texts.push(text);
    xml += `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
  }
  b.text(texts.join(""), false);
  void ctx;
  return xml;
}

function multiRun(rng: Rng, ctx: Ctx, b: Builder): string {
  const props = runProps(rng, ctx);
  let xml = `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}`;
  const n = rng.range(2, 5);
  for (let i = 0; i < n; i++) {
    switch (rng.int(6)) {
      case 0:
        xml += "<w:tab/>";
        b.text("\t", ctx.fieldOpen === 0);
        break;
      case 1:
        xml += "<w:br/>";
        b.text("\n", ctx.fieldOpen === 0);
        break;
      case 2:
        xml += "<w:noBreakHyphen/>";
        b.text("-", ctx.fieldOpen === 0);
        break;
      case 3:
        xml += '<w:footnoteReference w:id="1"/>';
        break;
      case 4:
        xml += "<w:cr/>";
        b.text("\n", ctx.fieldOpen === 0);
        break;
      default: {
        const text = phrase(rng);
        xml += `<w:t xml:space="preserve">${esc(text)}</w:t>`;
        b.text(text, ctx.fieldOpen === 0);
      }
    }
  }
  return `${xml}</w:r>`;
}

const fieldRun = (type: string): string => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;

function fieldResult(rng: Rng, ctx: Ctx, b: Builder): string {
  const open = ctx.fieldOpen;
  ctx.fieldOpen = Math.max(ctx.fieldOpen, 1);
  let xml = "";
  for (let i = 0; i < rng.range(1, 2); i++) xml += plainRun(rng, ctx, b);
  ctx.fieldOpen = open;
  return xml;
}

function genNestedBox(rng: Rng, ctx: Ctx, depth: number): GenPara[] {
  const out: GenPara[] = [];
  const inner: Ctx = { nextId: ctx.nextId, fieldOpen: 0 };
  for (let i = 0; i < rng.range(1, 2); i++) {
    out.push(genParagraph(rng, inner, depth + 1, true, i === 0));
  }
  ctx.nextId = inner.nextId;
  return out;
}

function unit(rng: Rng, ctx: Ctx, b: Builder, depth: number, inBox: boolean): void {
  const kind = rng.int(34);
  if (ctx.fieldOpen > 0 && rng.chance(0.4)) {
    b.xml += `${fieldResult(rng, ctx, b)}${fieldRun("end")}`;
    ctx.fieldOpen--;
    return;
  }
  switch (kind) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
      b.xml += plainRun(rng, ctx, b);
      return;
    case 7:
    case 8:
      b.xml += multiRun(rng, ctx, b);
      return;
    case 9:
      b.xml += `<w:hyperlink r:id="rId9">${wrappedRuns(rng, ctx, b)}</w:hyperlink>`;
      return;
    case 10: {
      const start = b.length;
      void start;
      b.xml += `${fieldRun("begin")}<w:r><w:instrText xml:space="preserve"> REF a </w:instrText></w:r>${fieldRun("separate")}`;
      b.xml += fieldResult(rng, ctx, b);
      if (rng.chance(0.3) && depth === 0 && !inBox) {
        ctx.fieldOpen++;
        return;
      }
      b.xml += fieldRun("end");
      return;
    }
    case 11:
      b.xml += `<w:fldSimple w:instr=" DATE ">${wrappedRuns(rng, ctx, b)}</w:fldSimple>`;
      return;
    case 12:
      b.xml += `<w:sdt><w:sdtPr/><w:sdtContent>${wrappedRuns(rng, ctx, b)}</w:sdtContent></w:sdt>`;
      return;
    case 13:
      b.xml += `<w:smartTag w:uri="u" w:element="place">${wrappedRuns(rng, ctx, b)}</w:smartTag>`;
      return;
    case 14:
      b.xml += `<w:customXml w:element="c">${wrappedRuns(rng, ctx, b)}</w:customXml>`;
      return;
    case 15:
      b.xml += `<w:bdo w:val="rtl">${wrappedRuns(rng, ctx, b)}</w:bdo>`;
      return;
    case 16:
      b.xml += `<w:dir w:val="rtl">${wrappedRuns(rng, ctx, b)}</w:dir>`;
      return;
    case 17:
      b.xml += `<w:ins w:id="${ctx.nextId++}" ${REVISION}>${wrappedRuns(rng, ctx, b)}</w:ins>`;
      return;
    case 18:
      b.xml += `<w:del w:id="${ctx.nextId++}" ${REVISION}><w:r><w:delText xml:space="preserve">${esc(phrase(rng))}</w:delText></w:r></w:del>`;
      return;
    case 19:
      b.xml += `<w:moveFrom w:id="${ctx.nextId++}" ${REVISION}><w:r><w:t>moved away</w:t></w:r></w:moveFrom>`;
      return;
    case 20:
      b.xml += `<w:moveTo w:id="${ctx.nextId++}" ${REVISION}>${wrappedRuns(rng, ctx, b)}</w:moveTo>`;
      return;
    case 21: {
      const id = ctx.nextId++;
      b.xml += rng.pick([
        `<w:bookmarkStart w:id="${id}" w:name="b${id}"/>`,
        `<w:bookmarkEnd w:id="${id}"/>`,
        '<w:proofErr w:type="spellStart"/>',
        `<w:commentRangeStart w:id="${id}"/>`,
        `<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`,
        "<w:r><w:lastRenderedPageBreak/></w:r>",
        "<w:r><w:drawing/></w:r>",
      ]);
      return;
    }
    case 22:
      b.barrier();
      b.xml += `<m:oMath ${M_DECL}><m:r><m:t>x+y</m:t></m:r></m:oMath>`;
      return;
    case 23:
      b.barrier();
      b.xml += `<m:oMathPara ${M_DECL}><m:oMath><m:r><m:t>z</m:t></m:r></m:oMath></m:oMathPara>`;
      return;
    case 24:
      b.barrier();
      b.xml +=
        "<w:r><w:ruby><w:rt><w:r><w:t>rt</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>base</w:t></w:r></w:rubyBase></w:ruby></w:r>";
      return;
    case 25:
      b.barrier();
      b.xml += '<w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>';
      return;
    case 26:
      b.barrier();
      b.xml += '<w:r><w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/></w:r>';
      return;
    case 27:
    case 28:
      b.barrier();
      b.xml += `<w:r><w:rPr>${rng.pick(["<w:vanish/>", "<w:specVanish/>", '<w:vanish w:val="true"/>'])}</w:rPr><w:t xml:space="preserve">${esc(phrase(rng) || "h")} </w:t>${rng.chance(0.4) ? "<w:tab/>" : ""}</w:r>`;
      return;
    case 29:
      if (depth < 2) {
        const nested = genNestedBox(rng, ctx, depth);
        b.nested.push(...nested);
        b.xml += `<w:r><w:drawing><w:txbxContent>${nested.map((n) => n.xml).join("")}</w:txbxContent></w:drawing></w:r>`;
      } else {
        b.xml += plainRun(rng, ctx, b);
      }
      return;
    case 30:
      if (depth < 2) {
        const nested = genNestedBox(rng, ctx, depth);
        b.nested.push(...nested);
        const fallback = nested.map((n) => n.xml).join("");
        b.xml += `<w:r><mc:AlternateContent ${MC_DECL}><mc:Choice Requires="wps"><w:drawing><w:txbxContent>${nested.map((n) => n.xml).join("")}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${fallback}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;
      } else {
        b.xml += plainRun(rng, ctx, b);
      }
      return;
    case 31: {
      const choice = new Builder();
      const inner: Ctx = { nextId: ctx.nextId, fieldOpen: 0 };
      choice.xml = wrappedRuns(rng, inner, choice);
      ctx.nextId = inner.nextId;
      b.text(choice.granules.map((g) => g.text).join(""), false);
      b.xml += `<mc:AlternateContent ${MC_DECL}><mc:Choice Requires="x">${choice.xml}</mc:Choice><mc:Fallback><w:r><w:t>fallback copy</w:t></w:r></mc:Fallback></mc:AlternateContent>`;
      return;
    }
    default:
      b.xml += plainRun(rng, ctx, b);
  }
}

function genParagraph(
  rng: Rng,
  ctx: Ctx,
  depth: number,
  inTextBox: boolean,
  first: boolean,
): GenPara {
  const b = new Builder();
  const count = rng.chance(0.08) ? 0 : rng.range(1, 9);
  for (let i = 0; i < count; i++) unit(rng, ctx, b, depth, inTextBox);
  void first;
  const props = rng.chance(0.2)
    ? `<w:pPr><w:pStyle w:val="Body"/>${rng.chance(0.3) ? `<w:rPr><w:ins w:id="${ctx.nextId++}" ${REVISION}/></w:rPr>` : ""}</w:pPr>`
    : "";
  return {
    xml: `<w:p>${props}${b.xml}</w:p>`,
    granules: b.granules,
    barriers: b.barriers,
    nested: b.nested,
    inTextBox,
  };
}

function flatten(p: GenPara, out: GenPara[]): void {
  out.push(p);
  for (const n of p.nested) flatten(n, out);
}

export function genDoc(rng: Rng): GenDoc {
  const ctx: Ctx = { nextId: 100, fieldOpen: 0 };
  const top: GenPara[] = [];
  const count = rng.range(1, 4);
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    const p = genParagraph(rng, ctx, 0, false, i === 0);
    if (last && ctx.fieldOpen > 0) {
      // A field still open at the end of the story is closed in the last paragraph.
      while (ctx.fieldOpen > 0) {
        p.xml = p.xml.replace(/<\/w:p>$/, `${fieldRun("end")}</w:p>`);
        ctx.fieldOpen--;
      }
    }
    top.push(p);
  }
  const paragraphs: GenPara[] = [];
  for (const p of top) flatten(p, paragraphs);
  return { bodyXml: top.map((p) => p.xml).join(""), paragraphs };
}

export interface GenOps {
  edits: Edit[];
  comments: Array<Comment & { token: string }>;
}

const REPLACEMENTS = [
  "X",
  "Y Z",
  " ",
  "new\nline",
  "tab\there",
  "\u03B1\u03B2\u03B3",
  "\u{1F600}",
  "(4)",
  "",
  "",
  "A&B",
];

export function genOps(rng: Rng, paragraphs: GenPara[], caseId: number): GenOps {
  const edits: Edit[] = [];
  const comments: GenOps["comments"] = [];
  paragraphs.forEach((p, index) => {
    const text = textOf(p);
    const pool = new Set<number>([0, text.length]);
    let at = 0;
    for (const g of p.granules) {
      at += g.text.length;
      pool.add(at);
      pool.add(Math.max(0, at - 1));
      pool.add(Math.min(text.length, at + 1));
    }
    for (let i = 0; i < 3; i++) pool.add(rng.int(text.length + 1));
    const positions = [...pool];
    const pick = (): number => rng.pick(positions);
    const edgeCases = rng.chance(0.06);
    const editCount = rng.chance(0.3) ? 0 : rng.range(1, 6);
    for (let i = 0; i < editCount; i++) {
      let start = pick();
      let end = pick();
      const kind = rng.int(10);
      if (kind < 3) end = start;
      if (start > end) [start, end] = [end, start];
      if (edgeCases && i === 0) end = text.length + rng.range(1, 3);
      edits.push({ paragraphId: `p:${index}`, start, end, replacement: rng.pick(REPLACEMENTS) });
    }
    const commentCount = rng.chance(0.5) ? 0 : rng.range(1, 3);
    for (let i = 0; i < commentCount; i++) {
      const token = `c${caseId}-${index}-${i}`;
      const body = `${token} note${rng.chance(0.3) ? "\nsecond line" : ""}`;
      if (rng.chance(0.4)) {
        comments.push({ paragraphId: `p:${index}`, text: body, token });
      } else {
        let start = pick();
        let end = pick();
        if (start > end) [start, end] = [end, start];
        comments.push({ paragraphId: `p:${index}`, start, end, text: body, token });
      }
    }
  });
  if (rng.chance(0.05)) {
    edits.push({ paragraphId: "p:99", start: 0, end: 0, replacement: "x" });
  }
  // Mix the inputs so order of arrival never matters.
  for (let i = edits.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [edits[i], edits[j]] = [edits[j]!, edits[i]!];
  }
  return { edits, comments };
}

// ---------------------------------------------------------------------------------------------
// Reference planner: the rules, restated over the generator's own knowledge of the paragraph.
// ---------------------------------------------------------------------------------------------

function midSurrogate(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return false;
  const a = text.charCodeAt(i - 1);
  const b = text.charCodeAt(i);
  return a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff;
}

interface Placed {
  start: number;
  end: number;
}

export interface ReferenceEdit {
  applied: boolean;
  start: number;
  end: number;
  replacement: string;
}

export function referenceEdits(
  paragraphs: GenPara[],
  edits: Edit[],
  trim:
    | ((removed: string, inserted: string) => { offset: number; removed: string; inserted: string })
    | undefined,
): ReferenceEdit[] {
  const placed = new Map<string, Placed[]>();
  return edits.map((edit) => {
    const none = {
      applied: false,
      start: edit.start,
      end: edit.end,
      replacement: edit.replacement,
    };
    const m = /^p:(\d+)$/.exec(edit.paragraphId);
    const p = m ? paragraphs[Number(m[1])] : undefined;
    if (!p) return none;
    const text = textOf(p);
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end)) return none;
    if (edit.start < 0 || edit.start > edit.end || edit.end > text.length) return none;
    let start = edit.start;
    let end = edit.end;
    let removed = text.slice(start, end);
    let inserted = edit.replacement;
    if (trim) {
      const t = trim(removed, inserted);
      start = edit.start + t.offset;
      end = start + t.removed.length;
      removed = t.removed;
      inserted = t.inserted;
    }
    if (removed === inserted) return none;
    if (midSurrogate(text, start) || midSurrogate(text, end)) return none;

    const granules: Array<Granule & { start: number; end: number }> = [];
    let at = 0;
    for (const g of p.granules) {
      granules.push({ ...g, start: at, end: at + g.text.length });
      at += g.text.length;
    }
    if (start < end) {
      if (p.barriers.some((b) => b > start && b < end)) return none;
      const hit = granules.filter((g) => g.start < end && g.end > start);
      if (hit.length === 0 || hit.some((g) => !g.editable)) return none;
    } else {
      const straddled = granules.find((g) => g.start < start && start < g.end);
      if (straddled) {
        if (!straddled.editable) return none;
      } else {
        const prev = granules.filter((g) => g.end <= start).at(-1);
        const next = granules.find((g) => g.start >= start);
        if (!prev?.editable && !next?.editable) return none;
      }
    }
    const list = placed.get(edit.paragraphId) ?? [];
    for (const o of list) {
      if (start < o.end && o.start < end) return none;
      if (start === end && o.start === o.end && start === o.start) return none;
    }
    list.push({ start, end });
    placed.set(edit.paragraphId, list);
    return { applied: true, start, end, replacement: inserted };
  });
}

export function referenceComments(paragraphs: GenPara[], comments: GenOps["comments"]): boolean[] {
  return comments.map((c) => {
    const m = /^p:(\d+)$/.exec(c.paragraphId);
    const p = m ? paragraphs[Number(m[1])] : undefined;
    if (!p || p.inTextBox) return false;
    const text = textOf(p);
    const start = c.start ?? 0;
    const end = c.end ?? text.length;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (start < 0 || end > text.length || start > end) return false;
    if (start === end && text.length > 0) return false;
    return !(midSurrogate(text, start) || midSurrogate(text, end));
  });
}

/** The text after the applied edits: insertions sort ahead of a replacement that starts where they do. */
export function applyReference(text: string, edits: ReferenceEdit[]): string {
  const applied = edits
    .filter((e) => e.applied)
    .sort(
      (a, b) => a.start - b.start || (a.end === a.start ? -1 : 0) - (b.end === b.start ? -1 : 0),
    );
  let out = "";
  let pos = 0;
  for (const e of applied) {
    out += text.slice(pos, e.start) + e.replacement;
    pos = e.end;
  }
  return out + text.slice(pos);
}

/** Where a comment on [start, end) should land once boundaries inside whole objects are widened. */
export function expectedCommentText(p: GenPara, start: number, end: number): string {
  const text = textOf(p);
  let at = 0;
  let s = start;
  let e = end;
  for (const g of p.granules) {
    const gs = at;
    const ge = at + g.text.length;
    at = ge;
    if (g.editable) continue;
    if (gs < start && start < ge) s = gs;
    if (gs < end && end < ge) e = ge;
  }
  return text.slice(s, e);
}

// ---------------------------------------------------------------------------------------------
// Oracle: reads the written XML directly, with its own idea of what Word shows.
// ---------------------------------------------------------------------------------------------

type Mode = "accepted" | "rejected";

function kids(node: Node): Element[] {
  const out: Element[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c as Element);
  return out;
}

const is = (el: Element, ns: string, name: string): boolean =>
  el.namespaceURI === ns && el.localName === name;

function hiddenRun(run: Element): boolean {
  const rPr = kids(run).find((k) => is(k, W, "rPr"));
  if (!rPr) return false;
  return kids(rPr).some((k) => {
    if (!is(k, W, "vanish") && !is(k, W, "specVanish")) return false;
    const val = k.getAttributeNS(W, "val");
    return !(val === "0" || val === "false" || val === "off");
  });
}

const XML_SPACE_NS = "http://www.w3.org/XML/1998/namespace";

/** What Word shows of a w:t: whitespace at its edges is ignored unless xml:space says to keep it. */
function shown(el: Element, render: boolean): string {
  const raw = el.textContent ?? "";
  if (!render || el.getAttributeNS(XML_SPACE_NS, "space") === "preserve") return raw;
  return raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

function runText(run: Element, countT: boolean, countDel: boolean, render: boolean): string {
  if (hiddenRun(run)) return "";
  let out = "";
  for (const c of kids(run)) {
    if (c.namespaceURI !== W) continue;
    if (c.localName === "t" && countT) out += shown(c, render);
    else if (c.localName === "delText" && countDel) out += shown(c, render);
    else if (c.localName === "tab") out += "\t";
    else if (c.localName === "br" || c.localName === "cr") out += "\n";
    else if (c.localName === "noBreakHyphen") out += "-";
  }
  return out;
}

/**
 * The text of a node's subtree as Word shows it with every one of our changes accepted or
 * rejected. With `render`, whitespace that Word ignores at the edges of a w:t is left out, which
 * is how the text actually looks; without it the text is the one the review reads.
 */
export function viewText(node: Element, mode: Mode, ours = OUR_AUTHOR, render = false): string {
  let out = "";
  for (const c of kids(node)) {
    if (c.namespaceURI === MC) {
      if (c.localName === "AlternateContent") {
        const choice = kids(c).find((k) => is(k, MC, "Choice"));
        if (choice) out += viewText(choice, mode, ours, render);
      }
      continue;
    }
    if (c.namespaceURI !== W) continue;
    const mine = c.getAttributeNS(W, "author") === ours;
    switch (c.localName) {
      case "r":
        out += runText(c, true, false, render);
        break;
      case "ins":
      case "moveTo":
        if (c.localName === "ins" && mine && mode === "rejected") break;
        out += viewText(c, mode, ours, render);
        break;
      case "del":
        if (mine && mode === "rejected") {
          for (const r of kids(c)) if (is(r, W, "r")) out += runText(r, true, true, render);
        }
        break;
      case "hyperlink":
      case "fldSimple":
      case "smartTag":
      case "customXml":
      case "bdo":
      case "dir":
        out += viewText(c, mode, ours, render);
        break;
      case "sdt": {
        const content = kids(c).find((k) => is(k, W, "sdtContent"));
        if (content) out += viewText(content, mode, ours, render);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export function paragraphsOf(doc: Document): Element[] {
  const out: Element[] = [];
  const walk = (el: Element): void => {
    for (const c of kids(el)) {
      if (is(c, MC, "Fallback")) continue;
      if (is(c, W, "p")) out.push(c);
      walk(c);
    }
  };
  const body = Array.from(doc.getElementsByTagNameNS(W, "body"))[0];
  if (body) walk(body);
  return out;
}

export const parseDom = (xml: string): Document => parseXmlForTest(xml);

/** The text between a comment's range markers in the paragraph, as it reads with our changes rejected. */
export function commentCoverage(p: Element, id: string): string | undefined {
  let inside = false;
  let seenStart = false;
  let seenEnd = false;
  let out = "";
  for (const c of kids(p)) {
    if (is(c, W, "commentRangeStart") && c.getAttributeNS(W, "id") === id) {
      inside = true;
      seenStart = true;
      continue;
    }
    if (is(c, W, "commentRangeEnd") && c.getAttributeNS(W, "id") === id) {
      inside = false;
      seenEnd = true;
      continue;
    }
    if (!inside) continue;
    const holder = p.ownerDocument!.createElementNS(W, "w:p");
    holder.appendChild(c.cloneNode(true));
    out += viewText(holder, "rejected");
  }
  return seenStart && seenEnd ? out : undefined;
}
