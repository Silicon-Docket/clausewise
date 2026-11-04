import type { DocxInspection, DocxParagraph } from "@clausewise/docx";
import {
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  Document,
  Footer,
  FootnoteReferenceRun,
  Header,
  ImageRun,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import JSZip from "jszip";
import {
  DOC_LABELS,
  type DocLabel,
  type IngestDocumentInput,
  type IngestOutput,
  type SourceSpan,
  type SpanAnnotation,
} from "../../src/contracts.js";
import { buildIngest } from "../../src/ingest/ingest.js";
import { parseTxt } from "../../src/ingest/txt.js";

export const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A 1x1 PNG, so that a Word file can hold a picture without a fixture file. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export interface DocxExtras {
  footnote?: boolean;
  header?: string;
  footer?: string;
  comment?: boolean;
  /** Text formatted as hidden. */
  hidden?: string;
  image?: boolean;
}

/**
 * A Word file with one plain paragraph per string, built with the docx library so the tests read
 * what a real producer writes and not what the test author imagined.
 */
export async function docxBytes(
  paragraphs: (string | { text: string; style: string })[],
  extras: DocxExtras = {},
): Promise<Uint8Array> {
  const children: Paragraph[] = paragraphs.map((entry, index) => {
    const text = typeof entry === "string" ? entry : entry.text;
    const runs: (
      TextRun | FootnoteReferenceRun | ImageRun | CommentRangeStart | CommentRangeEnd
    )[] = [];
    if (index === 0 && extras.comment === true) runs.push(new CommentRangeStart(0));
    runs.push(new TextRun(text));
    if (index === 0 && extras.comment === true) {
      runs.push(new CommentRangeEnd(0), new TextRun({ children: [new CommentReference(0)] }));
    }
    if (index === 0 && extras.footnote === true) runs.push(new FootnoteReferenceRun(1));
    if (index === 0 && extras.hidden !== undefined) {
      runs.push(new TextRun({ text: extras.hidden, vanish: true }));
    }
    if (index === 0 && extras.image === true) {
      runs.push(new ImageRun({ type: "png", data: PNG, transformation: { width: 8, height: 8 } }));
    }
    return new Paragraph({
      ...(typeof entry === "string" ? {} : { style: entry.style }),
      children: runs,
    });
  });
  const document = new Document({
    ...(extras.comment === true
      ? {
          comments: {
            children: [
              { id: 0, author: "A. Writer", date: new Date(0), children: [new Paragraph("note")] },
            ],
          },
        }
      : {}),
    ...(extras.footnote === true
      ? { footnotes: { 1: { children: [new Paragraph("a footnote")] } } }
      : {}),
    sections: [
      {
        ...(extras.header !== undefined || extras.footer !== undefined
          ? {
              headers:
                extras.header !== undefined
                  ? { default: new Header({ children: [new Paragraph(extras.header)] }) }
                  : {},
              footers:
                extras.footer !== undefined
                  ? { default: new Footer({ children: [new Paragraph(extras.footer)] }) }
                  : {},
            }
          : {}),
        children,
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

/** A Word file whose body declares the Strict Open XML namespace, which the engine refuses. */
export async function strictDocxBytes(paragraphs: string[]): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await docxBytes(paragraphs));
  const xml = await zip.file("word/document.xml")!.async("string");
  zip.file(
    "word/document.xml",
    xml.replace(
      "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
      "http://purl.oclc.org/ooxml/wordprocessingml/main",
    ),
  );
  return zip.generateAsync({ type: "uint8array" });
}

/** A Word file whose body is not well-formed XML and holds `secret` where the text would be. */
export async function brokenDocxBytes(secret: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await docxBytes(["Placeholder paragraph for the file."]));
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${secret}</w:t></w:r></w:p>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

export const NO_INSPECTION: DocxInspection = {
  trackedInsertions: 0,
  trackedDeletions: 0,
  comments: 0,
  footnotes: 0,
  endnotes: 0,
  headerFooterParts: 0,
  hiddenRuns: 0,
  images: 0,
};

/** A paragraph as parseDocx would hand it over, for tests that need exact control. */
export function paragraph(
  index: number,
  text: string,
  overrides: Partial<DocxParagraph> = {},
): DocxParagraph {
  return {
    id: `p:${index}`,
    index,
    text,
    style: undefined,
    numbering: undefined,
    inTable: false,
    tableRow: undefined,
    label: undefined,
    level: undefined,
    isBullet: false,
    styleName: undefined,
    outlineLevel: undefined,
    isTocEntry: false,
    ...overrides,
  };
}

export const paragraphsOf = (text: string): DocxParagraph[] => parseTxt(encode(text));

export const kindOf = (label: DocLabel): "nda" | "amendment" =>
  label === "D1" ? "nda" : "amendment";

export const versionIdOf = (label: DocLabel): string => `dv_${label.toLowerCase()}`;

/** An ingest input read from plain text. D1 is the NDA and the others are amendments. */
export function documentFrom(
  label: DocLabel,
  text: string | DocxParagraph[],
  overrides: Partial<IngestDocumentInput> = {},
): IngestDocumentInput {
  return {
    documentVersionId: versionIdOf(label),
    label,
    kind: kindOf(label),
    title: label === "D1" ? "Mutual NDA" : `Amendment ${label}`,
    versionNo: 1,
    statedDate: null,
    paragraphs: typeof text === "string" ? paragraphsOf(text) : text,
    inspection: null,
    ...overrides,
  };
}

/** Runs ingest over texts given as D1, D2, D3 in order. */
export function ingestTexts(...texts: string[]): IngestOutput {
  return buildIngest({
    documents: texts.map((text, i) => documentFrom(DOC_LABELS[i]!, text)),
  });
}

export function spanByLabel(output: IngestOutput, label: string): SourceSpan {
  const span = output.spans.find((s) => s.label === label);
  if (span === undefined) throw new Error(`no span ${label}`);
  return span;
}

export function annotationsOn(
  output: IngestOutput,
  label: string,
  kind?: SpanAnnotation["kind"],
): SpanAnnotation[] {
  const id = spanByLabel(output, label).id;
  return output.annotations.filter(
    (a) => a.spanId === id && (kind === undefined || a.kind === kind),
  );
}

/** The worked example of docs/parol/04-worked-example.md, D2, as plain text. */
export const AMENDMENT_NO_1 = `AMENDMENT NO. 1 TO MUTUAL NONDISCLOSURE AGREEMENT

This Amendment No. 1 (the "Amendment") is made as of 15 September 2026 between Lanternfish Software, Inc. and Corvane Data Systems LLC, and amends the Mutual Nondisclosure Agreement between them dated 2 February 2026 (the "Agreement").

1. Capitalized terms used but not defined in this Amendment have the meanings given in the Agreement.

2. Section 6.1 of the Agreement is deleted in its entirety.

3. Section 7.2 of the Agreement is amended by replacing "ten (10) business days" with "thirty (30) days".

4. Except as amended by this Amendment, the Agreement remains in full force and effect.
`;

/** A short synthetic NDA in the shape of the worked example's D1. */
export const SHORT_NDA = `MUTUAL NONDISCLOSURE AGREEMENT

This Mutual Nondisclosure Agreement (the "Agreement") is made on 2 February 2026 between Lanternfish Software, Inc. and Corvane Data Systems LLC.

1. DEFINITIONS

1.2 "Confidential Information" means non-public information disclosed by a Party (the "Disclosing Party") to the other Party (the "Receiving Party") that is marked or identified as confidential at the time of disclosure.

4. OBLIGATIONS

4.1 The Receiving Party shall use Confidential Information only to evaluate a possible commercial relationship between the Parties.

6. TERM

6.1 The obligations of each Receiving Party under Section 4 shall continue for two (2) years from the date of each disclosure of Confidential Information.

6.2 Either Party may terminate this Agreement on thirty (30) days' written notice.

7. GENERAL

7.2 Within ten (10) business days after the Disclosing Party's written request, the Receiving Party shall return or destroy the Disclosing Party's Confidential Information, except for copies required by law or held in routine backup systems, which remain subject to this Agreement.

9.3 Sections 4, 5 and 8 survive any termination or expiration of this Agreement.
`;
