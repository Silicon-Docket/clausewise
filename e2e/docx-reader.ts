import JSZip from "jszip";

// An independent reader of a .docx, for the tests that check what a download holds. It shares no
// code with the library that writes the file: it opens the zip with JSZip and reads the XML with
// regular expressions, which is enough for the few element names a redline uses. If the writer and
// this reader ever agreed on a mistake, they would have to make it independently.

const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
};

function decode(text: string): string {
  return text
    .replace(/&(?:lt|gt|amp|quot|apos);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)));
}

// An element that holds content: not the self-closing form, such as the mark of a paragraph that
// was inserted, which has nothing to remove.
const INSERTION = /<w:ins\b[^>]*[^/]>[\s\S]*?<\/w:ins>/g;
const DELETION = /<w:del\b[^>]*[^/]>[\s\S]*?<\/w:del>/g;
const PARAGRAPH = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const TEXT = /<w:(t|delText)\b[^>]*>([\s\S]*?)<\/w:\1>|<w:tab\s*\/>/g;

/** The text of some paragraph XML: its text runs, in order, and a tab for each tab. */
function textOf(xml: string, tags: ReadonlySet<string>): string {
  let text = "";
  for (const match of xml.matchAll(TEXT)) {
    if (match[1] === undefined) text += "\t";
    else if (tags.has(match[1])) text += decode(match[2] ?? "");
  }
  return text;
}

export interface TrackedChange {
  author: string;
  /** The `w:date` attribute as written. */
  date: string;
  /** The words inside it. */
  text: string;
}

export interface WordComment {
  id: string;
  author: string;
  /** Its paragraphs, joined by a newline. */
  text: string;
}

export interface DocxView {
  deletions: TrackedChange[];
  insertions: TrackedChange[];
  comments: WordComment[];
  /** How many range starts, range ends and references the comments have in the main document. */
  commentRanges: { starts: number; ends: number; references: number };
  /** Each paragraph's text with every tracked change accepted: deletions dropped, insertions kept. */
  accepted: string[];
  /** And with every change rejected: insertions dropped, deletions kept. */
  rejected: string[];
}

const attribute = (attributes: string, name: string): string =>
  decode(new RegExp(`${name}="([^"]*)"`).exec(attributes)?.[1] ?? "");

function changes(document: string, pattern: RegExp, tags: ReadonlySet<string>): TrackedChange[] {
  return (document.match(pattern) ?? []).map((xml) => {
    const opening = /^<w:(?:ins|del)\b([^>]*)>/.exec(xml)?.[1] ?? "";
    return {
      author: attribute(opening, "w:author"),
      date: attribute(opening, "w:date"),
      text: textOf(xml, tags),
    };
  });
}

const count = (xml: string, pattern: RegExp): number => xml.match(pattern)?.length ?? 0;

/** What a Word file holds, as far as a redline is concerned. */
export async function readDocx(bytes: Uint8Array): Promise<DocxView> {
  const zip = await JSZip.loadAsync(bytes);
  const document = (await zip.file("word/document.xml")?.async("string")) ?? "";
  if (document === "") throw new Error("The file has no word/document.xml.");
  const commentsXml = (await zip.file("word/comments.xml")?.async("string")) ?? "";

  const rejectedTags = new Set(["t", "delText"]);
  const acceptedTags = new Set(["t"]);
  const paragraphs = document.match(PARAGRAPH) ?? [];

  const comments: WordComment[] = [];
  for (const match of commentsXml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const attributes = match[1] ?? "";
    comments.push({
      id: attribute(attributes, "w:id"),
      author: attribute(attributes, "w:author"),
      text: (match[2]?.match(PARAGRAPH) ?? []).map((xml) => textOf(xml, acceptedTags)).join("\n"),
    });
  }

  return {
    deletions: changes(document, DELETION, rejectedTags),
    insertions: changes(document, INSERTION, acceptedTags),
    comments,
    commentRanges: {
      starts: count(document, /<w:commentRangeStart\b/g),
      ends: count(document, /<w:commentRangeEnd\b/g),
      references: count(document, /<w:commentReference\b/g),
    },
    accepted: paragraphs.map((xml) => textOf(xml.replace(DELETION, ""), acceptedTags)),
    rejected: paragraphs.map((xml) => textOf(xml.replace(INSERTION, ""), rejectedTags)),
  };
}

/** The index of the paragraphs where the two lists of paragraph text differ. */
export function differingParagraphs(a: readonly string[], b: readonly string[]): number[] {
  if (a.length !== b.length) {
    throw new Error(
      `The files have ${a.length} and ${b.length} paragraphs, so none can be compared.`,
    );
  }
  return a.flatMap((text, index) => (text === b[index] ? [] : [index]));
}
