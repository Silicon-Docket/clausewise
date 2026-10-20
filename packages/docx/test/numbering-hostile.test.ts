import { describe, expect, it } from "vitest";
import { parseDocx } from "../src/index.js";
import { buildDocx, para, run } from "./helpers.js";

/**
 * Numbering and styles come from whoever made the file. Whatever they contain, reading the
 * contract must go on, and the fields it yields must stay inside their documented ranges.
 */

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const FORMATS = ["decimal", "lowerLetter", "upperRoman", "ordinalText"];
const TEXTS = ["%1.", "(%2)", "%1.%2.%3", "%4"];

const level = (ilvl: number): string =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${FORMATS[ilvl]}"/>` +
  `<w:lvlRestart w:val="1"/><w:pStyle w:val="H${ilvl}"/><w:isLgl/><w:lvlText w:val="${TEXTS[ilvl]}"/></w:lvl>`;

const NUMBERING =
  `<w:numbering ${NS}><w:abstractNum w:abstractNumId="1"><w:styleLink w:val="L"/>` +
  `${[0, 1, 2, 3].map(level).join("")}</w:abstractNum>` +
  `<w:abstractNum w:abstractNumId="2"><w:numStyleLink w:val="L"/></w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"/>` +
  `<w:lvl w:ilvl="0"><w:start w:val="2"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl>` +
  `</w:lvlOverride></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num></w:numbering>`;

const heading = (ilvl: number): string =>
  `<w:style w:type="paragraph" w:styleId="H${ilvl}"><w:name w:val="heading ${ilvl + 1}"/>` +
  `<w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="2"/></w:numPr>` +
  `<w:outlineLvl w:val="${ilvl}"/></w:pPr></w:style>`;

const STYLES =
  `<w:styles ${NS}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  `${[0, 1, 2, 3].map(heading).join("")}` +
  `<w:style w:type="numbering" w:styleId="L"><w:name w:val="L"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style></w:styles>`;

const BODY =
  [0, 1, 2, 3, 1, 0, 2].map((i) => para(run(`Styled ${i}`), `<w:pStyle w:val="H${i}"/>`)).join("") +
  [0, 1, 2, 3, 9]
    .map((i) =>
      para(
        run(`Direct ${i}`),
        `<w:numPr><w:ilvl w:val="${i}"/><w:numId w:val="${(i % 2) + 1}"/></w:numPr>`,
      ),
    )
    .join("");

const GARBAGE = [
  "",
  "0",
  "-1",
  "abc",
  "99999999999999999999",
  "1e9",
  "9",
  "  ",
  "%1%2%3%4%5%6%7%8%9",
  "decimal",
  "bullet",
  "none",
  "-0",
  "1.5",
  "NaN",
];

const ATTRIBUTES = /w:(?:val|ilvl|numId|abstractNumId|styleId)="[^"]*"/g;
const ELEMENTS =
  /<w:[A-Za-z]+(?: [^>]*)?\/>|<w:(lvl|num|abstractNum|style|lvlOverride)\b[^>]*>[\s\S]*?<\/w:\1>/g;

/** Changes a few attribute values, removes a few elements and repeats a few others. */
function damage(xml: string, random: () => number): string {
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
  let out = xml;
  for (let step = 1 + Math.floor(random() * 4); step > 0; step--) {
    const attributes = [...out.matchAll(ATTRIBUTES)];
    const elements = [...out.matchAll(ELEMENTS)];
    const roll = random();
    if (roll < 0.5 && attributes.length > 0) {
      const hit = pick(attributes);
      const name = hit[0].slice(0, hit[0].indexOf("="));
      out = `${out.slice(0, hit.index)}${name}="${pick(GARBAGE)}"${out.slice(hit.index + hit[0].length)}`;
    } else if (elements.length > 0) {
      const hit = pick(elements);
      const kept = roll < 0.8 ? "" : hit[0] + hit[0];
      out = out.slice(0, hit.index) + kept + out.slice(hit.index + hit[0].length);
    }
  }
  return out;
}

describe("damaged numbering and styles", () => {
  it("never stop the contract being read, and every field stays in range", async () => {
    const random = seeded(2026);
    let labelled = 0;
    for (let round = 0; round < 400; round++) {
      const buf = await buildDocx(random() < 0.5 ? damage(BODY, random) : BODY, {
        "word/numbering.xml": random() < 0.8 ? damage(NUMBERING, random) : NUMBERING,
        "word/styles.xml": random() < 0.8 ? damage(STYLES, random) : STYLES,
      });
      for (const p of (await parseDocx(buf)).paragraphs) {
        if (p.label !== undefined) {
          labelled++;
          expect(p.label.length).toBeGreaterThan(0);
          expect(p.label.length).toBeLessThanOrEqual(255);
          expect(p.label).not.toMatch(/[\x00-\x1f]/);
        }
        if (p.level !== undefined) {
          expect(Number.isInteger(p.level)).toBe(true);
          expect(p.level).toBeGreaterThanOrEqual(0);
          expect(p.level).toBeLessThanOrEqual(8);
        }
        expect(p.numbering?.level).toBe(p.level);
        if (p.outlineLevel !== undefined) expect(p.outlineLevel).toBeLessThanOrEqual(8);
        if (p.isBullet) expect(p.label).toBeUndefined();
      }
    }
    // Most of the damaged files still carry numbers, so the loop above was not checking nothing.
    expect(labelled).toBeGreaterThan(1000);
  });
});
