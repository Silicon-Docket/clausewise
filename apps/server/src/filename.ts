import { LIMITS } from "@clausewise/api";

export const DEFAULT_FILE_NAME = "contract.docx";
export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Characters that change how text is laid out or ordered without being seen: the bidirectional
// marks, embeddings, overrides and isolates. A name containing them can read as a different name
// ("evilcod.docx" displayed for "evilxcod.docx" reversed), and the person downloading it is a
// lawyer who trusts the name.
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
// Control characters, the C1 range and the line and paragraph separators.
const CONTROL = /[\p{Cc}\u2028\u2029]/gu;
const MAX_EXTENSION_CHARS = 12;
// A client chooses how long its file name is, up to the whole upload. A name longer than this is
// cut before anything is done to it, to its start and its end, which is where the part that is
// kept and the extension are. Looking at every character of a 25 MB name takes hundreds of MB.
const SCAN_HEAD_UNITS = 1024;
const SCAN_TAIL_UNITS = 64;

function truncate(name: string, limit: number): string {
  const characters = [...name];
  if (characters.length <= limit) return name;
  // Keep the extension, which tells the person what kind of file it is, and cut the stem.
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? [...name.slice(dot)] : [];
  if (extension.length > 1 && extension.length <= MAX_EXTENSION_CHARS) {
    const stem = [...name.slice(0, dot)].slice(0, limit - extension.length).join("");
    return `${stem}${extension.join("")}`;
  }
  return characters.slice(0, limit).join("");
}

/**
 * The name to show for an uploaded file: the base name only (what a browser sends is whatever the
 * user's system has, and a hostile client can send anything), without control characters, path
 * separators or bidirectional overrides, at most 200 characters. A name over about a thousand
 * units long is cut to its start and its end before it is cleaned. A name with nothing left becomes
 * `contract.docx`. The result is for display and for the Content-Disposition header, never for a
 * path: the file on disk is named by a random key.
 */
export function cleanFileName(raw: string): string {
  const cut = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  let base = cut === -1 ? raw : raw.slice(cut + 1);
  if (base.length > SCAN_HEAD_UNITS + SCAN_TAIL_UNITS) {
    base = base.slice(0, SCAN_HEAD_UNITS) + base.slice(-SCAN_TAIL_UNITS);
  }
  const trimmed = base.replace(BIDI, "").replace(CONTROL, "").trim();
  // "." and ".." name folders, and a name of only dots and spaces shows as nothing.
  if (trimmed === "" || /^[.\s]+$/.test(trimmed)) return DEFAULT_FILE_NAME;
  return truncate(trimmed, LIMITS.maxFileNameChars);
}

// RFC 5987 attr-char: what may appear unescaped in a filename* value.
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function asciiFallback(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7e]|["\\%]/g, "_")
    .trim();
  return ascii === "" || /^[._\s]+$/.test(ascii) ? DEFAULT_FILE_NAME : ascii;
}

/**
 * A Content-Disposition value that makes the browser save the file under `name`, which must
 * already be cleaned. Older clients read the ASCII `filename`; current ones prefer `filename*`.
 */
export function attachmentDisposition(name: string): string {
  return `attachment; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

/** The name without its last extension, for building the name of a file made from it. */
export function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem === "" ? "contract" : stem;
}

/**
 * The name of a file made from an uploaded one, such as `nda.redlined.docx` from `nda.docx`: the
 * name without its extension, then `suffix`. A name can be as long as the limit allows, so the stem
 * is cut to leave room for the suffix, which is what tells the person which file it is.
 */
export function derivedFileName(name: string, suffix: string): string {
  const room = Math.max(1, LIMITS.maxFileNameChars - [...suffix].length);
  return cleanFileName(`${[...stemOf(name)].slice(0, room).join("")}${suffix}`);
}
