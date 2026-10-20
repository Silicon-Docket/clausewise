import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AlignmentType, Document, LevelFormat, Packer, Paragraph } from "docx";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDocx, type DocxParagraph } from "../src/index.js";

const exec = promisify(execFile);
const hasSoffice = spawnSync("soffice", ["--version"]).status === 0;

/**
 * The labels are compared with what LibreOffice itself prints in front of each paragraph when it
 * converts the document to text. Two things LibreOffice does not model are deliberately left out
 * of these documents (w:lvlRestart, and the link from a numbering level back to a style), as are
 * tracked paragraph marks; the hand-written expectations in numbering.test.ts cover them.
 */

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const lvl = (ilvl: number, numFmt: string, text: string, extra = "", start = 1): string =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="${start}"/><w:numFmt w:val="${numFmt}"/>${extra}<w:lvlText w:val="${text}"/></w:lvl>`;
const abs = (id: number, levels: string[], extra = ""): string =>
  `<w:abstractNum w:abstractNumId="${id}">${extra}${levels.join("")}</w:abstractNum>`;
const num = (id: number, abstractId: number, extra = ""): string =>
  `<w:num w:numId="${id}"><w:abstractNumId w:val="${abstractId}"/>${extra}</w:num>`;
const style = (id: string, name: string, pPr = "", basedOn = "Normal"): string =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="${basedOn}"/><w:pPr>${pPr}</w:pPr></w:style>`;
const NORMAL = `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>`;
const numPr = (numId: number, ilvl?: number): string =>
  `<w:numPr>${ilvl === undefined ? "" : `<w:ilvl w:val="${ilvl}"/>`}<w:numId w:val="${numId}"/></w:numPr>`;

let serial = 0;
const p = (pPr = "", text?: string): string =>
  `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}<w:r><w:t>${text ?? `Text ${String(++serial).padStart(3, "0")}`}</w:t></w:r></w:p>`;
const item = (numId: number, ilvl: number): string => p(numPr(numId, ilvl));
const styled = (styleId: string): string => p(`<w:pStyle w:val="${styleId}"/>`);
const items = (numId: number, count: number, ilvl = 0): string =>
  Array.from({ length: count }, () => item(numId, ilvl)).join("");
const levels = (numId: number, ...ilvls: number[]): string =>
  ilvls.map((l) => item(numId, l)).join("");

interface Doc {
  name: string;
  body: string;
  numbering?: string;
  styles?: string;
}

const DOCS: Doc[] = [
  {
    name: "articles-clauses-items",
    numbering:
      abs(1, [
        lvl(0, "upperRoman", "ARTICLE %1"),
        lvl(1, "decimal", "Section %1.%2", "<w:isLgl/>"),
        lvl(2, "lowerLetter", "(%3)"),
        lvl(3, "lowerRoman", "(%4)"),
      ]) + num(1, 1),
    body:
      p("", "Agreement") + levels(1, 0, 1, 2, 2, 3, 3, 1, 2, 0, 1, 2, 3, 2, 1, 0) + p("", "Signed"),
  },
  {
    name: "number-formats",
    numbering:
      abs(1, [lvl(0, "upperRoman", "%1.")]) +
      num(1, 1) +
      abs(2, [lvl(0, "lowerRoman", "(%1)")]) +
      num(2, 2) +
      abs(3, [lvl(0, "upperLetter", "%1)")]) +
      num(3, 3) +
      abs(4, [lvl(0, "lowerLetter", "(%1)")]) +
      num(4, 4) +
      abs(5, [lvl(0, "decimalZero", "%1")]) +
      num(5, 5) +
      abs(6, [lvl(0, "ordinal", "%1")]) +
      num(6, 6) +
      abs(7, [lvl(0, "ordinalText", "%1")]) +
      num(7, 7) +
      abs(8, [lvl(0, "cardinalText", "%1")]) +
      num(8, 8) +
      abs(9, [lvl(0, "decimal", "Clause %1", "", 5), lvl(1, "decimal", "Clause %1.%2")]) +
      num(9, 9) +
      num(10, 9, '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="20"/></w:lvlOverride>'),
    body:
      items(1, 14) +
      items(2, 5) +
      items(3, 3) +
      items(4, 28) +
      items(5, 11) +
      items(6, 13) +
      items(7, 3) +
      items(8, 3) +
      levels(9, 0, 1, 0) +
      levels(10, 0, 1, 1),
  },
  {
    name: "two-nums-one-abstractNum",
    numbering:
      abs(1, [lvl(0, "decimal", "%1."), lvl(1, "lowerLetter", "(%2)")]) + num(1, 1) + num(2, 1),
    body: levels(1, 0, 1, 0) + levels(2, 0, 1, 1) + levels(1, 0, 1),
  },
  {
    name: "levels-skipped-and-interrupted",
    numbering:
      abs(1, [
        lvl(0, "decimal", "%1."),
        lvl(1, "decimal", "%1.%2"),
        lvl(2, "lowerLetter", "(%3)"),
      ]) + num(1, 1),
    body:
      levels(1, 0, 2, 2, 1, 2) +
      p("", "Not numbered") +
      levels(1, 1, 0, 2, 1) +
      p("", "Not numbered either") +
      levels(1, 2, 0),
  },
  {
    name: "numbering-from-styles",
    numbering:
      abs(1, [
        lvl(0, "decimal", "%1.", '<w:pStyle w:val="Heading1"/>'),
        lvl(1, "decimal", "%1.%2", '<w:pStyle w:val="Heading2"/>'),
        lvl(2, "lowerLetter", "(%3)", '<w:pStyle w:val="Level3"/>'),
      ]) + num(1, 1),
    styles:
      NORMAL +
      style("Heading1", "heading 1", `${numPr(1)}<w:outlineLvl w:val="0"/>`) +
      style("Heading2", "heading 2", `${numPr(1, 1)}<w:outlineLvl w:val="1"/>`) +
      style("Level3", "Level 3", numPr(1, 2), "Heading2") +
      style("BodyIndent", "Body Indent", "", "Heading2"),
    body:
      styled("Heading1") +
      styled("Heading2") +
      styled("Level3") +
      styled("Level3") +
      styled("BodyIndent") +
      styled("Heading1") +
      styled("Heading2") +
      p(`<w:pStyle w:val="Heading2"/>${numPr(0, 0)}`) +
      styled("BodyIndent") +
      p("", "Plain"),
  },
  {
    name: "localised-style-ids",
    numbering:
      abs(1, [
        lvl(0, "decimal", "%1.", '<w:pStyle w:val="Titre1"/>'),
        lvl(1, "decimal", "%1.%2", '<w:pStyle w:val="Titre2"/>'),
      ]) + num(1, 1),
    styles:
      NORMAL +
      style("Titre1", "heading 1", `${numPr(1, 0)}<w:outlineLvl w:val="0"/>`) +
      style("Titre2", "heading 2", `${numPr(1, 1)}<w:outlineLvl w:val="1"/>`),
    body:
      styled("Titre1") + styled("Titre2") + styled("Titre2") + styled("Titre1") + styled("Titre2"),
  },
  {
    name: "numStyleLink",
    numbering:
      abs(
        10,
        [lvl(0, "decimal", "%1."), lvl(1, "decimal", "%1.%2"), lvl(2, "lowerLetter", "(%3)")],
        '<w:styleLink w:val="ArticleList"/>',
      ) +
      '<w:abstractNum w:abstractNumId="11"><w:numStyleLink w:val="ArticleList"/></w:abstractNum>' +
      num(4, 10) +
      num(5, 11),
    styles:
      NORMAL +
      `<w:style w:type="numbering" w:styleId="ArticleList"><w:name w:val="Article List"/><w:pPr>${numPr(4)}</w:pPr></w:style>`,
    body: levels(5, 0, 1, 2, 2, 1, 0, 1),
  },
  {
    name: "python-docx-list-styles",
    numbering:
      abs(3, [lvl(0, "decimal", "%1.", '<w:pStyle w:val="ListNumber"/>')]) +
      abs(4, [lvl(0, "decimal", "%1.", '<w:pStyle w:val="ListNumber2"/>')]) +
      abs(5, [lvl(0, "bullet", "o", '<w:pStyle w:val="ListBullet"/>')]) +
      num(5, 3) +
      num(6, 4) +
      num(8, 5),
    styles:
      NORMAL +
      style("ListNumber", "List Number", numPr(5)) +
      style("ListNumber2", "List Number 2", numPr(6)) +
      style("ListBullet", "List Bullet", numPr(8)),
    body:
      styled("ListNumber") +
      styled("ListNumber") +
      styled("ListNumber2") +
      styled("ListNumber2") +
      styled("ListNumber") +
      styled("ListNumber2") +
      styled("ListBullet"),
  },
  {
    name: "numbers-in-table-cells",
    numbering: abs(1, [lvl(0, "decimal", "%1."), lvl(1, "decimal", "%1.%2")]) + num(1, 1),
    body:
      `<w:tbl>` +
      [0, 1, 1, 0, 1]
        .map(
          (l) =>
            `<w:tr><w:tc><w:p><w:pPr>${numPr(1, l)}</w:pPr></w:p></w:tc><w:tc>${p("", `Cell text ${++serial}`)}</w:tc></w:tr>`,
        )
        .join("") +
      `</w:tbl>` +
      levels(1, 1, 0),
  },
  {
    name: "bullets-none-and-numId-0",
    numbering:
      abs(1, [lvl(0, "decimal", "%1."), lvl(1, "none", ""), lvl(2, "bullet", "-")]) + num(1, 1),
    body:
      levels(1, 0, 1, 2, 0) +
      p(numPr(0, 1)) +
      p("", "1.1 A typed number stays in the text") +
      p("", "(a) so does this one") +
      levels(1, 0),
  },
];

/** A small seeded generator, so the random documents are the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const RANDOM_FORMATS = [
  "decimal",
  "decimal",
  "lowerLetter",
  "upperLetter",
  "lowerRoman",
  "upperRoman",
  "decimalZero",
  "ordinal",
];

/**
 * A multilevel list with random formats, separators, start values, legal numbering and level
 * sequences. Every level may show the counters of the levels above it, which is where a
 * hand-written case is most likely to be too tidy. Two nums share the list in half of them.
 */
function randomListDoc(seed: number): Doc {
  const random = seeded(seed);
  const between = (low: number, high: number): number =>
    low + Math.floor(random() * (high - low + 1));
  const levelCount = between(2, 5);
  const levelDefs: string[] = [];
  for (let ilvl = 0; ilvl < levelCount; ilvl++) {
    const shown = Array.from({ length: ilvl + 1 }, (_, j) => `%${j + 1}`);
    const parts = ilvl > 0 && random() < 0.5 ? shown : [`%${ilvl + 1}`];
    const text =
      random() < 0.3
        ? `(${parts.join(".")})`
        : `Sec ${parts.join(".")}${random() < 0.5 ? "." : ""}`;
    levelDefs.push(
      lvl(
        ilvl,
        RANDOM_FORMATS[between(0, RANDOM_FORMATS.length - 1)]!,
        text,
        ilvl > 0 && random() < 0.2 ? "<w:isLgl/>" : "",
        random() < 0.25 ? between(2, 4) : 1,
      ),
    );
  }
  const shared = random() < 0.5;
  const body: string[] = [];
  for (let n = 0; n < 24; n++) {
    if (random() < 0.12) body.push(p("", `Plain ${n}`));
    else
      body.push(
        item(shared && random() < 0.4 ? 2 : 1, between(0, random() < 0.6 ? 1 : levelCount - 1)),
      );
  }
  return {
    name: `random-list-${seed}`,
    numbering: abs(1, levelDefs) + num(1, 1) + (shared ? num(2, 1) : ""),
    body: body.join(""),
  };
}

const RANDOM_DOCS = Array.from({ length: 14 }, (_, i) => randomListDoc(i + 1));

/** What docx-js writes for a multilevel numbering config, the way the shipped fixtures are made. */
async function docxJsMultilevel(): Promise<Uint8Array> {
  const level = (
    n: number,
    format: (typeof LevelFormat)[keyof typeof LevelFormat],
    text: string,
  ) => ({
    level: n,
    format,
    text,
    alignment: AlignmentType.START,
  });
  const at = (reference: string, level: number, text: string) =>
    new Paragraph({ text, numbering: { reference, level } });
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "legal",
          levels: [
            level(0, LevelFormat.DECIMAL, "%1."),
            level(1, LevelFormat.DECIMAL, "%1.%2"),
            level(2, LevelFormat.LOWER_LETTER, "(%3)"),
            level(3, LevelFormat.LOWER_ROMAN, "(%4)"),
          ],
        },
        { reference: "recitals", levels: [level(0, LevelFormat.UPPER_LETTER, "(%1)")] },
        { reference: "dots", levels: [level(0, LevelFormat.BULLET, "o")] },
      ],
    },
    sections: [
      {
        children: [
          new Paragraph({ text: "Master Services Agreement" }),
          at("recitals", 0, "Provider provides consulting services."),
          at("recitals", 0, "Client wishes to engage Provider."),
          at("legal", 0, "Definitions"),
          at("legal", 1, "In this Agreement:"),
          at("legal", 2, "Affiliate means a related company;"),
          at("legal", 2, "Business Day means a weekday;"),
          at("legal", 3, "including a public holiday;"),
          at("legal", 3, "but not a Sunday."),
          at("legal", 1, "Headings do not affect meaning."),
          at("legal", 0, "Fees"),
          at("legal", 1, "Fees are payable monthly."),
          at("dots", 0, "an option"),
          at("legal", 1, "Late sums bear interest."),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

/** Nested ordered lists as LibreOffice itself writes them when it converts HTML to Word. */
const HTML_NESTED_LISTS =
  "<html><body><h2>Agreement</h2><ol><li>Definitions<ol type='a'><li>Affiliate means a related company." +
  "<ol type='i'><li>a nested item</li><li>another nested item</li></ol></li><li>Business Day means a weekday.</li></ol></li>" +
  "<li>Term<ol type='a'><li>The term is five years.</li></ol></li></ol><p>A plain paragraph.</p>" +
  "<ol start='5'><li>Starts at five</li><li>And six</li></ol><ul><li>a bullet</li></ul></body></html>";

async function pack(doc: Doc): Promise<Uint8Array> {
  const zip = new JSZip();
  const parts = [
    "/word/document.xml",
    ...(doc.styles ? ["/word/styles.xml"] : []),
    ...(doc.numbering ? ["/word/numbering.xml"] : []),
  ];
  const kinds: Record<string, string> = {
    "/word/document.xml": "document.main",
    "/word/styles.xml": "styles",
    "/word/numbering.xml": "numbering",
  };
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${parts
      .map(
        (part) =>
          `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kinds[part]}+xml"/>`,
      )
      .join("")}</Types>`,
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const rel = (id: string, type: string, target: string): string =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      doc.styles ? rel("rId1", "styles", "styles.xml") : ""
    }${doc.numbering ? rel("rId2", "numbering", "numbering.xml") : ""}</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${doc.body}</w:body></w:document>`,
  );
  if (doc.styles) {
    zip.file(
      "word/styles.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}>${doc.styles}</w:styles>`,
    );
  }
  if (doc.numbering) {
    zip.file(
      "word/numbering.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NS}>${doc.numbering}</w:numbering>`,
    );
  }
  return zip.generateAsync({ type: "uint8array" });
}

const GENERATED = [{ name: "docx-js-multilevel", build: docxJsMultilevel }];
const FROM_HTML = [{ name: "libreoffice-from-html", html: HTML_NESTED_LISTS }];
const NAMES = [...DOCS, ...RANDOM_DOCS, ...GENERATED, ...FROM_HTML].map((d) => d.name);

async function soffice(dir: string, args: string[]): Promise<void> {
  // A private profile, so a running LibreOffice or a locked user profile cannot interfere.
  await exec(
    "soffice",
    [`-env:UserInstallation=file://${join(dir, "profile")}`, "--headless", ...args],
    {
      timeout: 110_000,
    },
  );
}

describe.skipIf(!hasSoffice)("list labels agree with what LibreOffice prints", () => {
  let dir = "";
  const rendered = new Map<string, { paragraphs: DocxParagraph[]; lines: string[] }>();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clausewise-numbering-"));
    for (const doc of [...DOCS, ...RANDOM_DOCS]) {
      await writeFile(join(dir, `${doc.name}.docx`), await pack(doc));
    }
    for (const doc of GENERATED) await writeFile(join(dir, `${doc.name}.docx`), await doc.build());
    const htmlFiles: string[] = [];
    for (const doc of FROM_HTML) {
      const file = join(dir, `${doc.name}.html`);
      await writeFile(file, doc.html);
      htmlFiles.push(file);
    }
    await soffice(dir, ["--convert-to", "docx:MS Word 2007 XML", "--outdir", dir, ...htmlFiles]);
    await soffice(dir, [
      "--convert-to",
      "txt:Text (encoded):UTF8",
      "--outdir",
      join(dir, "out"),
      ...NAMES.map((name) => join(dir, `${name}.docx`)),
    ]);
    for (const name of NAMES) {
      const paragraphs = (
        await parseDocx(new Uint8Array(await readFile(join(dir, `${name}.docx`))))
      ).paragraphs;
      let text = await readFile(join(dir, "out", `${name}.txt`), "utf8");
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      rendered.set(name, { paragraphs, lines: text.replace(/\n$/, "").split("\n") });
    }
  }, 120_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it.each(NAMES)("%s", (name) => {
    const { paragraphs, lines } = rendered.get(name)!;
    // One line per paragraph, a table cell's paragraph included.
    expect(lines).toHaveLength(paragraphs.length);
    const ours = paragraphs.map((para) => para.label ?? "");
    const theirs = paragraphs.map((para, i) => {
      const line = lines[i]!;
      expect(line.endsWith(para.text), `paragraph ${i} line ${JSON.stringify(line)}`).toBe(true);
      return line.slice(0, line.length - para.text.length).trim();
    });
    paragraphs.forEach((para, i) => {
      // LibreOffice prints a bullet glyph, which a label never is.
      if (para.isBullet) expect(theirs[i], `bullet ${i}`).not.toBe("");
      else expect(ours[i], `paragraph ${i}`).toBe(theirs[i]);
    });
    // The comparison must have had something to compare.
    expect(ours.some((label) => label !== "")).toBe(true);
  });
});
