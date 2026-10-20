import { W_NS, childElements, getW, isW, wChild } from "./ooxml.js";
import { paragraphStyle } from "./paragraphs.js";
import { parseCount, valueCount, type StyleDef, type StyleSheet } from "./styles.js";

/**
 * What Word shows for list numbers, worked out from numbering.xml and the style chain.
 *
 * The rules follow ECMA-376 part 1, 17.9, and were checked against LibreOffice renderings. Two
 * points rest on the specification alone because LibreOffice ignores them: w:lvlRestart, and the
 * link from a numbering level back to a paragraph style (w:lvl/w:pStyle) that decides a styled
 * paragraph's level. Anything the data does not let us resolve leaves the label undefined.
 */

export interface ParagraphList {
  /** The effective numPr: direct, else from the style chain; undefined for no list or numId 0. */
  numbering: { id: string; level: number } | undefined;
  /** What Word prints before the paragraph, without the tab or space after it: "3.1", "(a)". */
  label: string | undefined;
  isBullet: boolean;
}

interface LevelDef {
  start: number;
  numFmt: string;
  text: string;
  pStyle: string | undefined;
  isLgl: boolean;
  /** 1-based number of the level whose use restarts this one; 0 means never; undefined means any higher level. */
  restart: number | undefined;
  /** False when a value Word would reject (a start that is not a number) makes the level unusable. */
  usable: boolean;
}

interface AbstractNum {
  levels: Map<number, LevelDef>;
  numStyleLink: string | undefined;
  styleLink: string | undefined;
}

interface NumDef {
  abstractId: string | undefined;
  startOverrides: Map<number, number>;
  levelOverrides: Map<number, LevelDef>;
}

interface Holder {
  abstractId: string;
  abs: AbstractNum;
}

type Counters = (number | undefined)[];

const LEVELS = 9;
const MAX_LINK_DEPTH = 5;
const MAX_LABEL_LENGTH = 255;
// A start of 999999999 would otherwise build a label of millions of letters before the length
// limit rejects it.
const MAX_LETTER_REPEAT = 100;

/** Formats that isLgl ("legal numbering") prints as Arabic numerals. decimalZero already is one. */
const LEGAL_CONVERTS = new Set([
  "upperRoman",
  "lowerRoman",
  "upperLetter",
  "lowerLetter",
  "ordinal",
  "cardinalText",
  "ordinalText",
]);

const CARDINAL = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
  "Twenty",
];
const ORDINAL = [
  "Zeroth",
  "First",
  "Second",
  "Third",
  "Fourth",
  "Fifth",
  "Sixth",
  "Seventh",
  "Eighth",
  "Ninth",
  "Tenth",
  "Eleventh",
  "Twelfth",
  "Thirteenth",
  "Fourteenth",
  "Fifteenth",
  "Sixteenth",
  "Seventeenth",
  "Eighteenth",
  "Nineteenth",
  "Twentieth",
];
const ROMAN: readonly (readonly [number, string])[] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

function roman(n: number): string | undefined {
  if (n < 1 || n >= 4000) return undefined;
  let out = "";
  for (const [value, symbol] of ROMAN) {
    while (n >= value) {
      out += symbol;
      n -= value;
    }
  }
  return out;
}

/** Word runs letters on as a, b, ..., z, aa, bb, ...: the letter is repeated, it is not base 26. */
function letters(n: number): string | undefined {
  if (n < 1) return undefined;
  const repeat = Math.floor((n - 1) / 26) + 1;
  if (repeat > MAX_LETTER_REPEAT) return undefined;
  return String.fromCharCode(97 + ((n - 1) % 26)).repeat(repeat);
}

function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : (["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10] ?? "th");
  return `${n}${suffix}`;
}

/** The counter as Word prints it, or undefined for a format this module does not model. */
function formatCounter(n: number, numFmt: string, legal: boolean): string | undefined {
  const fmt = legal && LEGAL_CONVERTS.has(numFmt) ? "decimal" : numFmt;
  switch (fmt) {
    case "decimal":
      return String(n);
    case "decimalZero":
      return n < 10 ? `0${n}` : String(n);
    case "upperRoman":
      return roman(n)?.toUpperCase();
    case "lowerRoman":
      return roman(n);
    case "upperLetter":
      return letters(n)?.toUpperCase();
    case "lowerLetter":
      return letters(n);
    case "ordinal":
      return ordinal(n);
    case "cardinalText":
      return CARDINAL[n];
    case "ordinalText":
      return ORDINAL[n];
    case "none":
      return "";
    default:
      return undefined;
  }
}

function flag(el: Element | undefined): boolean {
  if (!el) return false;
  const v = getW(el, "val");
  return v === null || !/^(0|false|off)$/i.test(v.trim());
}

function parseLevel(el: Element): LevelDef {
  const val = (name: string): string | undefined => {
    const child = wChild(el, name);
    return child ? (getW(child, "val") ?? undefined) : undefined;
  };
  const startEl = wChild(el, "start");
  const restartEl = wChild(el, "lvlRestart");
  // ECMA-376 makes an absent w:start 0. Word always writes it; other producers sometimes do not.
  const start = startEl ? valueCount(startEl) : 0;
  const restart = restartEl ? valueCount(restartEl) : undefined;
  return {
    start: start ?? 0,
    numFmt: val("numFmt") ?? "decimal",
    text: val("lvlText") ?? "",
    pStyle: val("pStyle"),
    isLgl: flag(wChild(el, "isLgl")),
    restart,
    usable: start !== undefined && (!restartEl || restart !== undefined),
  };
}

class Definitions {
  private readonly abstracts = new Map<string, AbstractNum>();
  private readonly nums = new Map<string, NumDef>();
  private readonly styleLinked = new Map<string, string>();
  private readonly holders = new Map<string, Holder | null>();

  constructor(
    doc: Document | undefined,
    private readonly styles: StyleSheet,
  ) {
    const root = doc?.documentElement;
    for (const el of root ? childElements(root) : []) {
      if (isW(el, "abstractNum")) this.addAbstract(el);
      else if (isW(el, "num")) this.addNum(el);
    }
  }

  private addAbstract(el: Element): void {
    const id = getW(el, "abstractNumId")?.trim();
    if (!id || this.abstracts.has(id)) return;
    const abs: AbstractNum = { levels: new Map(), numStyleLink: undefined, styleLink: undefined };
    for (const c of childElements(el)) {
      if (isW(c, "lvl")) {
        const ilvl = parseCount(getW(c, "ilvl"));
        if (ilvl !== undefined && ilvl < LEVELS && !abs.levels.has(ilvl)) {
          abs.levels.set(ilvl, parseLevel(c));
        }
      } else if (isW(c, "numStyleLink")) {
        abs.numStyleLink = getW(c, "val") || undefined;
      } else if (isW(c, "styleLink")) {
        abs.styleLink = getW(c, "val") || undefined;
      }
    }
    this.abstracts.set(id, abs);
    if (
      abs.styleLink !== undefined &&
      abs.levels.size > 0 &&
      !this.styleLinked.has(abs.styleLink)
    ) {
      this.styleLinked.set(abs.styleLink, id);
    }
  }

  private addNum(el: Element): void {
    const id = getW(el, "numId")?.trim();
    if (!id || this.nums.has(id)) return;
    const abstractRef = wChild(el, "abstractNumId");
    const num: NumDef = {
      abstractId: (abstractRef && getW(abstractRef, "val")?.trim()) || undefined,
      startOverrides: new Map(),
      levelOverrides: new Map(),
    };
    for (const o of childElements(el)) {
      if (!isW(o, "lvlOverride")) continue;
      const ilvl = parseCount(getW(o, "ilvl"));
      if (ilvl === undefined || ilvl >= LEVELS) continue;
      const start = valueCount(wChild(o, "startOverride"));
      if (start !== undefined) num.startOverrides.set(ilvl, start);
      const lvl = wChild(o, "lvl");
      if (lvl) num.levelOverrides.set(ilvl, parseLevel(lvl));
    }
    this.nums.set(id, num);
  }

  /** The abstractNum that really holds a num's levels, following numStyleLink to the linked list. */
  holder(numId: string): Holder | undefined {
    const cached = this.holders.get(numId);
    if (cached !== undefined) return cached ?? undefined;
    const found = this.findHolder(numId);
    this.holders.set(numId, found ?? null);
    return found;
  }

  private findHolder(numId: string): Holder | undefined {
    let num = this.nums.get(numId);
    for (let depth = 0; num && depth < MAX_LINK_DEPTH; depth++) {
      const abstractId = num.abstractId;
      const abs = abstractId === undefined ? undefined : this.abstracts.get(abstractId);
      if (abstractId === undefined || !abs) return undefined;
      if (abs.levels.size > 0 || abs.numStyleLink === undefined) return { abstractId, abs };
      const target = this.styles.numberingStyleNumId(abs.numStyleLink)?.trim();
      if (target === undefined) {
        // The numbering style is gone, but the list it named is still in the file.
        const linked = this.styleLinked.get(abs.numStyleLink);
        const linkedAbs = linked === undefined ? undefined : this.abstracts.get(linked);
        return linked !== undefined && linkedAbs
          ? { abstractId: linked, abs: linkedAbs }
          : undefined;
      }
      num = this.nums.get(target);
    }
    return undefined;
  }

  level(numId: string, ilvl: number): LevelDef | undefined {
    return (
      this.nums.get(numId)?.levelOverrides.get(ilvl) ?? this.holder(numId)?.abs.levels.get(ilvl)
    );
  }

  startOf(numId: string, ilvl: number): number {
    return this.nums.get(numId)?.startOverrides.get(ilvl) ?? this.level(numId, ilvl)?.start ?? 1;
  }

  /** The level whose w:pStyle names one of these styles, most derived style first. */
  levelLinkedTo(numId: string, chain: readonly StyleDef[]): number | undefined {
    const levels = this.holder(numId)?.abs.levels;
    if (!levels) return undefined;
    for (const style of chain) {
      for (const [ilvl, def] of levels) {
        if (def.pStyle === style.id) return ilvl;
      }
    }
    return undefined;
  }

  /** True when the num has settings of its own, which gives it counters of its own. */
  hasOverrides(numId: string): boolean {
    const num = this.nums.get(numId);
    return !!num && (num.startOverrides.size > 0 || num.levelOverrides.size > 0);
  }
}

function isNoList(numId: string): boolean {
  return /^\s*0*\s*$/.test(numId);
}

const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";

function insideElement(node: Node, ns: string, local: string): boolean {
  for (let n = node.parentNode; n; n = n.parentNode) {
    if (
      n.nodeType === 1 &&
      (n as Element).namespaceURI === ns &&
      (n as Element).localName === local
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Text boxes are separate stories with counters of their own, mc:Fallback repeats mc:Choice, and
 * a paragraph whose mark is a tracked deletion or move merges into the next one on Accept All.
 * None of them takes part in the numbering of the body.
 */
function takesPartInBodyNumbering(p: Element): boolean {
  if (insideElement(p, W_NS, "txbxContent") || insideElement(p, MC_NS, "Fallback")) return false;
  const pPr = wChild(p, "pPr");
  const rPr = pPr && wChild(pPr, "rPr");
  return !rPr || (!wChild(rPr, "del") && !wChild(rPr, "moveFrom"));
}

class ListResolver {
  private readonly defs: Definitions;
  private readonly instances = new Map<string, Counters>();

  constructor(
    numbering: Document | undefined,
    private readonly styles: StyleSheet,
  ) {
    this.defs = new Definitions(numbering, styles);
  }

  resolve(p: Element): ParagraphList {
    const styleId = this.styles.effectiveStyleId(paragraphStyle(p));
    const chain = this.styles.chain(styleId);
    const eff = this.effectiveNumPr(p, chain);
    if (!eff) return { numbering: undefined, label: undefined, isBullet: false };

    const numbering = { id: eff.numId, level: eff.ilvl };
    const def = this.defs.level(eff.numId, eff.ilvl);
    const isBullet = def?.numFmt === "bullet";
    if (!def || !def.usable || !takesPartInBodyNumbering(p)) {
      return { numbering, label: undefined, isBullet };
    }
    return { numbering, label: this.advance(eff, def), isBullet };
  }

  private effectiveNumPr(
    p: Element,
    chain: readonly StyleDef[],
  ): { numId: string; ilvl: number } | undefined {
    const pPr = wChild(p, "pPr");
    const numPr = pPr && wChild(pPr, "numPr");
    const idEl = numPr && wChild(numPr, "numId");
    // numId and ilvl are separate properties: each is taken from the paragraph, else the styles.
    const directId = idEl ? (getW(idEl, "val") ?? "").trim() : undefined;
    const directLevel = valueCount(numPr && wChild(numPr, "ilvl"));
    const numId = directId ?? chain.find((s) => s.numId !== undefined)?.numId?.trim();
    // numId 0, or an empty one, switches numbering off and beats whatever the style says.
    if (numId === undefined || isNoList(numId)) return undefined;

    let ilvl = directLevel;
    if (ilvl === undefined && directId === undefined) {
      // ECMA-376 17.9.23: a style-linked list takes the paragraph's level from the level that
      // names the style, not from the ilvl written in the style.
      ilvl = this.defs.levelLinkedTo(numId, chain);
    }
    ilvl ??= chain.find((s) => s.ilvl !== undefined)?.ilvl;
    return { numId, ilvl: Math.min(LEVELS - 1, ilvl ?? 0) };
  }

  /** Counts this paragraph into its list and returns the text of its label. */
  private advance(eff: { numId: string; ilvl: number }, def: LevelDef): string | undefined {
    const { defs } = this;
    const holder = defs.holder(eff.numId);
    if (!holder) return undefined;
    // Nums on one abstractNum continue each other unless one carries settings of its own.
    const key = defs.hasOverrides(eff.numId) ? `num:${eff.numId}` : `abs:${holder.abstractId}`;
    let counters = this.instances.get(key);
    if (!counters) {
      counters = Array<number | undefined>(LEVELS).fill(undefined);
      this.instances.set(key, counters);
    }

    const k = eff.ilvl;
    const isBullet = def.numFmt === "bullet";
    // A level that was skipped counts as used once, so a lone "(a)" under "1." is 1(a), and the
    // next clause is 1.2, not 1.1.
    for (let j = 0; j < k; j++) {
      if (counters[j] === undefined && defs.level(eff.numId, j)?.numFmt !== "bullet") {
        counters[j] = defs.startOf(eff.numId, j);
      }
    }
    if (!isBullet) {
      const current = counters[k];
      counters[k] = current === undefined ? defs.startOf(eff.numId, k) : current + 1;
    }
    for (let j = k + 1; j < LEVELS; j++) {
      const restart = defs.level(eff.numId, j)?.restart;
      if (restart === undefined || (restart > 0 && k < restart)) counters[j] = undefined;
    }
    if (isBullet) return undefined;

    let text = "";
    let last = 0;
    for (const match of def.text.matchAll(/%([1-9])/g)) {
      const j = Number(match[1]) - 1;
      const shown = formatCounter(
        counters[j] ?? defs.startOf(eff.numId, j),
        defs.level(eff.numId, j)?.numFmt ?? "decimal",
        def.isLgl,
      );
      if (shown === undefined) return undefined;
      text += def.text.slice(last, match.index) + shown;
      last = match.index + match[0].length;
    }
    text += def.text.slice(last);
    // Control characters cannot print, and a label sits inside prompts as one short token.
    const label = text.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim();
    return label === "" || label.length > MAX_LABEL_LENGTH ? undefined : label;
  }
}

/**
 * The list state of every paragraph, in the order given, which must be document order: counters
 * continue across the whole body, table cells included. Parts that are missing or unreadable
 * (pass undefined) leave the labels undefined and the numbering as far as the paragraphs state it.
 */
export function resolveNumbering(
  paragraphs: readonly Element[],
  styles: StyleSheet,
  numbering: Document | undefined,
): ParagraphList[] {
  const resolver = new ListResolver(numbering, styles);
  return paragraphs.map((p) => resolver.resolve(p));
}
