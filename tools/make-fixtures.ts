import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { type Contract, contracts } from "../fixtures/contracts.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function clause(text: string): Paragraph {
  const m = /^(\d+\.\d+)\s+(.*)$/s.exec(text);
  if (!m) return new Paragraph({ children: [new TextRun(text)], spacing: { after: 160 } });
  return new Paragraph({
    spacing: { after: 160 },
    children: [new TextRun({ text: `${m[1]} `, bold: true }), new TextRun(m[2] ?? "")],
  });
}

function signatures(parties: [string, string]): Table {
  const cell = (name: string) =>
    new TableCell({
      width: { size: 50, type: WidthType.PERCENTAGE },
      children: [
        new Paragraph({ children: [new TextRun({ text: name, bold: true })] }),
        new Paragraph("By: ______________________"),
        new Paragraph("Name:"),
        new Paragraph("Title:"),
      ],
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: parties.map(cell) })],
  });
}

async function build(c: Contract): Promise<Uint8Array> {
  const doc = new Document({
    creator: "Clausewise fixtures",
    title: c.title,
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: c.title, bold: true })],
            spacing: { after: 240 },
          }),
          ...c.intro.map(
            (t) => new Paragraph({ children: [new TextRun(t)], spacing: { after: 160 } }),
          ),
          ...c.sections.flatMap((s) => [
            new Paragraph({
              heading: HeadingLevel.HEADING_1,
              children: [new TextRun({ text: s.heading, bold: true })],
              spacing: { before: 240, after: 120 },
            }),
            ...s.clauses.map(clause),
          ]),
          new Paragraph({ text: "", spacing: { before: 240 } }),
          signatures(c.parties),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

await mkdir(join(root, "fixtures"), { recursive: true });
const expected: Record<string, { playbook: string; rules: Contract["expected"] }> = {};
for (const c of contracts) {
  await writeFile(join(root, "fixtures", c.file), await build(c));
  expected[c.file] = { playbook: c.playbook, rules: c.expected };
  console.log(`wrote fixtures/${c.file}`);
}
await writeFile(join(root, "fixtures", "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
console.log("wrote fixtures/expected.json");
