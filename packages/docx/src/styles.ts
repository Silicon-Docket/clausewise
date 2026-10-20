import { childElements, getW, isW, wChild } from "./ooxml.js";

/** A style from word/styles.xml, reduced to what classifying a paragraph needs. */
export interface StyleDef {
  id: string;
  /** `paragraph`, `character`, `table` or `numbering`; Word omits it for paragraph styles. */
  type: string;
  /**
   * The w:name value. Word stores the English built-in name ("heading 1", "toc 1") whatever the
   * interface language, while the style id is derived from the localised name.
   */
  name: string | undefined;
  basedOn: string | undefined;
  numId: string | undefined;
  ilvl: number | undefined;
  outlineLvl: number | undefined;
}

const MAX_CHAIN = 32;
const TOC_STYLE_NAME = /^(toc\s*[1-9]|toc heading)$/i;
const TOC_STYLE_ID = /^(toc\s*[1-9]|tocheading)$/i;
const NO_STYLES: readonly StyleDef[] = [];

/** A non-negative integer in a w: attribute value; anything else is malformed and yields undefined. */
export function parseCount(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || !/^\s*\d{1,9}\s*$/.test(raw)) return undefined;
  return Number(raw);
}

/** The integer in the `w:val` of an element, or undefined when the element or the value is missing. */
export function valueCount(el: Element | undefined): number | undefined {
  return el ? parseCount(getW(el, "val")) : undefined;
}

export class StyleSheet {
  private readonly byId = new Map<string, StyleDef>();
  private readonly chains = new Map<string, readonly StyleDef[]>();
  private readonly defaultParagraphId: string | undefined;

  /** A missing or unreadable styles part is an empty sheet: every lookup then finds nothing. */
  constructor(doc?: Document) {
    let defaultParagraph: string | undefined;
    const root = doc?.documentElement;
    for (const el of root ? childElements(root) : []) {
      if (!isW(el, "style")) continue;
      const id = getW(el, "styleId");
      if (!id || this.byId.has(id)) continue;
      const type = getW(el, "type") || "paragraph";
      const pPr = wChild(el, "pPr");
      const numPr = pPr && wChild(pPr, "numPr");
      const numId = numPr && wChild(numPr, "numId");
      this.byId.set(id, {
        id,
        type,
        name: nonEmpty(valueOf(wChild(el, "name"))),
        basedOn: nonEmpty(valueOf(wChild(el, "basedOn"))),
        numId: numId ? (getW(numId, "val") ?? "") : undefined,
        ilvl: valueCount(numPr && wChild(numPr, "ilvl")),
        outlineLvl: valueCount(pPr && wChild(pPr, "outlineLvl")),
      });
      const isDefault = getW(el, "default");
      if (
        defaultParagraph === undefined &&
        type === "paragraph" &&
        (isDefault === "1" || isDefault === "true" || isDefault === "on")
      ) {
        defaultParagraph = id;
      }
    }
    this.defaultParagraphId = defaultParagraph;
  }

  get(id: string | undefined): StyleDef | undefined {
    return id === undefined ? undefined : this.byId.get(id);
  }

  /**
   * The style a paragraph really has: its own, else the document's default paragraph style.
   * An id that styles.xml does not define stays as it is, since Word would not name it either.
   */
  effectiveStyleId(pStyle: string | undefined): string | undefined {
    return pStyle ?? this.defaultParagraphId;
  }

  /** The style followed by its `basedOn` ancestors, most derived first; cycles end the chain. */
  chain(id: string | undefined): readonly StyleDef[] {
    if (id === undefined) return NO_STYLES;
    const cached = this.chains.get(id);
    if (cached) return cached;
    const out: StyleDef[] = [];
    const seen = new Set<string>();
    for (
      let s = this.byId.get(id);
      s && !seen.has(s.id) && out.length < MAX_CHAIN;
      s = s.basedOn === undefined ? undefined : this.byId.get(s.basedOn)
    ) {
      seen.add(s.id);
      out.push(s);
    }
    this.chains.set(id, out);
    return out;
  }

  /** The numId a numbering style (w:type="numbering") stands for. */
  numberingStyleNumId(id: string): string | undefined {
    const s = this.byId.get(id);
    return s && s.type === "numbering" ? s.numId : undefined;
  }

  /**
   * True when the style or any style it is based on is named "toc N" or "TOC Heading". A style
   * styles.xml does not define falls back to its id, which is all a hand-made file offers.
   */
  isTocStyle(id: string | undefined): boolean {
    if (id === undefined) return false;
    const chain = this.chain(id);
    if (chain.length === 0) return TOC_STYLE_ID.test(id.trim());
    return chain.some((s) => s.name !== undefined && TOC_STYLE_NAME.test(s.name.trim()));
  }
}

/**
 * The outline level Word would report, 0 to 8: a level on the paragraph beats the style chain,
 * and level 9 ("body text") is an explicit "no level" that also beats the chain.
 */
export function effectiveOutlineLevel(
  pPr: Element | undefined,
  chain: readonly StyleDef[],
): number | undefined {
  const direct = valueCount(pPr && wChild(pPr, "outlineLvl"));
  const level = direct ?? chain.find((s) => s.outlineLvl !== undefined)?.outlineLvl;
  return level !== undefined && level <= 8 ? level : undefined;
}

function valueOf(el: Element | undefined): string | undefined {
  return el ? (getW(el, "val") ?? undefined) : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
