import JSZip from "jszip";
import {
  DEFAULT_LIMITS,
  DocxError,
  W_STRICT_NS,
  assertXmlChars,
  childElements,
  hasInvalidXmlChars,
  limitError,
  parseXml,
  resolveLimits,
  serializeXml,
  strictFormatError,
  xmlSafe,
  type DocxLimits,
} from "./ooxml.js";

export const DOCUMENT_PART = "word/document.xml";
const DOCUMENT_RELS_PART = "word/_rels/document.xml.rels";

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0];

interface PackageState {
  limits: DocxLimits;
  /** Uncompressed bytes handed out so far, which bounds what a stream of tiny reads can add up to. */
  bytesRead: number;
}

const states = new WeakMap<JSZip, PackageState>();

export function packageLimits(zip: JSZip): DocxLimits {
  return states.get(zip)?.limits ?? DEFAULT_LIMITS;
}

/** The size the zip's central directory declares for an entry, which JSZip keeps but does not type. */
function declaredSize(file: JSZip.JSZipObject): number | undefined {
  const size = (file as unknown as { _data?: { uncompressedSize?: unknown } })._data
    ?.uncompressedSize;
  return typeof size === "number" ? size : undefined;
}

export async function openPackage(buf: Uint8Array, limits?: Partial<DocxLimits>): Promise<JSZip> {
  const resolved = resolveLimits(limits);
  if (buf.length > resolved.maxInputBytes) {
    throw limitError("The file", "maxInputBytes", resolved);
  }
  if (OLE_SIGNATURE.every((byte, i) => buf[i] === byte)) {
    throw new DocxError(
      "This file is not a .docx: it is an old-format Word document or it is password protected " +
        "(encrypted). Open it in Word, remove the password or save it as a normal .docx, and try again.",
    );
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new DocxError("Not a .docx file: its contents are not a readable zip archive");
  }
  const entries = Object.values(zip.files);
  if (entries.length > resolved.maxZipEntries) {
    throw limitError("The file", "maxZipEntries", resolved);
  }
  let declared = 0;
  for (const entry of entries) declared += declaredSize(entry) ?? 0;
  if (declared > resolved.maxUncompressedBytes) {
    throw limitError("The file", "maxUncompressedBytes", resolved);
  }
  states.set(zip, { limits: resolved, bytesRead: 0 });
  return zip;
}

/** Inflates an entry while counting, so a header that understates its size cannot slip a bomb through. */
function readBounded(
  file: JSZip.JSZipObject,
  cap: number,
  fail: () => DocxError,
  state: PackageState,
): Promise<Uint8Array> {
  const declared = declaredSize(file);
  if (declared !== undefined && declared > cap) return Promise.reject(fail());
  return new Promise((resolve, reject) => {
    interface Stream {
      on(event: string, handler: (arg: never) => void): Stream;
      pause(): void;
      resume(): void;
    }
    const stream = (file as unknown as { internalStream(type: string): Stream }).internalStream(
      "uint8array",
    );
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const finish = (error: DocxError | undefined, bytes?: Uint8Array): void => {
      if (settled) return;
      settled = true;
      if (error) {
        stream.pause();
        reject(error);
      } else resolve(bytes ?? new Uint8Array());
    };
    stream
      .on("data", ((chunk: Uint8Array) => {
        if (settled) return;
        total += chunk.length;
        state.bytesRead += chunk.length;
        if (total > cap) return finish(fail());
        if (state.bytesRead > state.limits.maxUncompressedBytes) {
          return finish(limitError("The file", "maxUncompressedBytes", state.limits));
        }
        chunks.push(chunk.slice());
      }) as never)
      .on("error", (() => {
        finish(new DocxError("Not a .docx file: a part of it is damaged and cannot be read"));
      }) as never)
      .on("end", (() => {
        const out = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
          out.set(chunk, at);
          at += chunk.length;
        }
        finish(undefined, out);
      }) as never)
      .resume();
  });
}

function startsWith(bytes: Uint8Array, ...prefix: number[]): boolean {
  return prefix.every((byte, i) => bytes[i] === byte);
}

function declaredEncoding(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  return /^<\?xml[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1]?.toLowerCase();
}

/**
 * Turns the bytes of an XML part into text. A byte order mark wins, then the look of UTF-16
 * without one, then the encoding the XML declaration names. Characters XML cannot carry are
 * dropped, because Word could not open the part either and the writer must never copy them.
 */
export function decodeXml(bytes: Uint8Array, part: string): string {
  let label = "utf-8";
  if (startsWith(bytes, 0xef, 0xbb, 0xbf)) label = "utf-8";
  else if (startsWith(bytes, 0xff, 0xfe) || startsWith(bytes, 0x3c, 0x00)) label = "utf-16le";
  else if (startsWith(bytes, 0xfe, 0xff) || startsWith(bytes, 0x00, 0x3c)) label = "utf-16be";
  else {
    const declared = declaredEncoding(bytes);
    if (declared !== undefined && !/^utf-?8$/.test(declared) && !declared.startsWith("utf-16")) {
      label = declared;
    }
  }
  let text: string;
  try {
    text = new TextDecoder(label).decode(bytes);
  } catch {
    throw new DocxError(`${part} uses a text encoding that is not supported`);
  }
  return hasInvalidXmlChars(text) ? xmlSafe(text) : text;
}

function findEntry(zip: JSZip, path: string): JSZip.JSZipObject | undefined {
  const exact = zip.file(path);
  if (exact) return exact;
  // Part names are case-insensitive in OPC, zip entry names are not.
  const lower = path.toLowerCase();
  const found = Object.keys(zip.files).find((name) => name.toLowerCase() === lower);
  return found === undefined ? undefined : (zip.file(found) ?? undefined);
}

/** The name the zip really uses for a part, whatever case the reference spells it in. */
export function entryName(zip: JSZip, path: string): string | undefined {
  return findEntry(zip, path)?.name;
}

export async function readPart(zip: JSZip, path: string): Promise<string | undefined> {
  const file = findEntry(zip, path);
  if (!file) return undefined;
  const state = states.get(zip) ?? { limits: DEFAULT_LIMITS, bytesRead: 0 };
  const isDocument = path === DOCUMENT_PART;
  const name = isDocument ? "maxDocumentXmlBytes" : "maxPartBytes";
  const bytes = await readBounded(
    file,
    state.limits[name],
    () => limitError(path, name, state.limits),
    state,
  );
  return decodeXml(bytes, path);
}

function assertTransitional(xml: string): void {
  if (xml.slice(0, 20_000).includes(W_STRICT_NS)) throw strictFormatError();
}

export async function readDocumentXml(zip: JSZip): Promise<string> {
  const xml = await readPart(zip, DOCUMENT_PART);
  if (xml === undefined) throw new DocxError(`Not a .docx file: ${DOCUMENT_PART} is missing`);
  assertTransitional(xml);
  return xml;
}

/** Serialises a part, checks that it is readable XML and puts it in the package. */
export function writeXmlPart(zip: JSZip, path: string, doc: Document): void {
  const xml = serializeXml(doc);
  assertXmlChars(xml, path);
  zip.file(path, xml);
}

export function writePackage(zip: JSZip): Promise<Uint8Array> {
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export interface Relationship {
  id: string;
  type: string;
  /** Resolved against the source part: a part path without a leading slash, or undefined if unusable. */
  path: string | undefined;
}

/** Joins a relationship target onto the folder of the part that owns it, refusing paths that leave the package. */
export function resolveTarget(baseFolder: string, target: string): string | undefined {
  let raw = target;
  try {
    raw = decodeURIComponent(target);
  } catch {
    return undefined;
  }
  if (raw.includes("\\") || raw.includes("\0")) return undefined;
  const segments = raw.startsWith("/") ? [] : baseFolder.split("/").filter(Boolean);
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : undefined;
}

/** The internal relationships of word/document.xml; external ones never name a part. */
export async function documentRelationships(zip: JSZip): Promise<Relationship[]> {
  const xml = await readPart(zip, DOCUMENT_RELS_PART);
  if (xml === undefined) return [];
  const doc = parseXml(xml, DOCUMENT_RELS_PART, packageLimits(zip));
  const out: Relationship[] = [];
  for (const rel of childElements(doc.documentElement)) {
    if (rel.localName !== "Relationship") continue;
    const external = rel.getAttribute("TargetMode")?.toLowerCase() === "external";
    const target = rel.getAttribute("Target");
    out.push({
      id: rel.getAttribute("Id") ?? "",
      type: rel.getAttribute("Type") ?? "",
      path: external || target === null ? undefined : resolveTarget("word", target),
    });
  }
  return out;
}

const NEVER_A_SIDE_PART = new Set([
  "word/document.xml",
  "word/styles.xml",
  "word/settings.xml",
  "word/numbering.xml",
  "word/fonttable.xml",
  "word/websettings.xml",
]);

/** A relationship may only be followed to a plain XML part under word/ that is not core machinery. */
export function isUsableSidePart(path: string | undefined): path is string {
  if (path === undefined) return false;
  const lower = path.toLowerCase();
  return (
    lower.startsWith("word/") &&
    lower.endsWith(".xml") &&
    !lower.includes("/_rels/") &&
    !NEVER_A_SIDE_PART.has(lower)
  );
}
