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

// An element that holds content: not the self-closing form, which has nothing to remove.
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

export interface ReadComment {
  id: string;
  author: string;
  /** Its paragraphs, joined by a newline. */
  text: string;
}

export interface ReadDocx {
  /** Elements that mark text as deleted or inserted by a tracked change, in the main document. */
  deletions: number;
  insertions: number;
  /** The words inside them, in order. */
  deletedTexts: string[];
  insertedTexts: string[];
  comments: ReadComment[];
  /** Where each comment is anchored: how many range starts, range ends and references. */
  commentRanges: { starts: number; ends: number; references: number };
  /**
   * Each paragraph's text as it reads with every change rejected: insertions dropped, deletions
   * kept. For a file with no tracked change this is just the text.
   */
  rejected: string[];
  /** And with every change accepted: deletions dropped, insertions kept. */
  accepted: string[];
}

const count = (xml: string, pattern: RegExp): number => xml.match(pattern)?.length ?? 0;

export async function readDocx(bytes: Uint8Array): Promise<ReadDocx> {
  const zip = await JSZip.loadAsync(bytes);
  const document = (await zip.file("word/document.xml")?.async("string")) ?? "";
  if (document === "") throw new Error("The file has no word/document.xml.");
  const commentsXml = (await zip.file("word/comments.xml")?.async("string")) ?? "";

  const paragraphs = document.match(PARAGRAPH) ?? [];
  const rejectedTags = new Set(["t", "delText"]);
  const acceptedTags = new Set(["t"]);
  const rejected = paragraphs.map((xml) => textOf(xml.replace(INSERTION, ""), rejectedTags));
  const accepted = paragraphs.map((xml) => textOf(xml.replace(DELETION, ""), acceptedTags));

  const inside = (pattern: RegExp, tags: ReadonlySet<string>): string[] =>
    (document.match(pattern) ?? []).map((xml) => textOf(xml, tags));

  const comments: ReadComment[] = [];
  for (const match of commentsXml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    comments.push({
      id: /w:id="([^"]*)"/.exec(attributes)?.[1] ?? "",
      author: decode(/w:author="([^"]*)"/.exec(attributes)?.[1] ?? ""),
      text: (body.match(PARAGRAPH) ?? []).map((xml) => textOf(xml, acceptedTags)).join("\n"),
    });
  }

  return {
    deletions: count(document, /<w:del\b/g),
    insertions: count(document, /<w:ins\b/g),
    deletedTexts: inside(DELETION, rejectedTags),
    insertedTexts: inside(INSERTION, acceptedTags),
    comments,
    commentRanges: {
      starts: count(document, /<w:commentRangeStart\b/g),
      ends: count(document, /<w:commentRangeEnd\b/g),
      references: count(document, /<w:commentReference\b/g),
    },
    rejected,
    accepted,
  };
}
