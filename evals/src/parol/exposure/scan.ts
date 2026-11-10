/**
 * The scanner of the exposure suite: looks, in memory, for strings and ids that must not be where
 * they are found. It is given an artefact (a prompt before it is sent, a model answer, an HTTP
 * response body, an exported memo, the rows of a table) and the tokens that are forbidden in that
 * artefact, and answers which tokens it holds.
 *
 * Five rules keep it honest.
 *
 *  - It counts a token once per artefact, however often the token occurs there (and an id that is
 *    only a part of a longer id found in the same artefact, such as a version id inside a span
 *    id, as that longer id), and it reports
 *    where (the kind of artefact, a label such as a route template or a table name, and the index
 *    of the token). It never reports what was found: a hit names a place and a number only.
 *  - A Word file is read as a Word file: every part of the package is inflated and searched, both
 *    as written and with the markup taken out, so a string split across runs is found.
 *  - A text is searched in several views, and a token counts if any view holds it: as written; with
 *    the tags taken out (the application wraps a quoted passage in a mark element, which can cut a
 *    string in two); and with entities, percent escapes and JSON escapes decoded and the invisible
 *    characters (soft hyphen, zero width, bidi marks) removed. It does not normalise anything else.
 *  - A package that starts as a zip and cannot be read is not searched as the bytes it is: its
 *    content is compressed, so a search of the bytes would find nothing and call it clean. It stops
 *    the suite with an `ExposureControlFailure`.
 *  - Before any count is reported the suite runs `runControl`: the scanner has to find EVERY planted
 *    canary string and id (alone in text, cut by markup, encoded, and all together in a compressed
 *    Word file, in the body, in a header part and in the document properties) and to find nothing
 *    in a clean one. A scanner that cannot do that would report zero for anything.
 */
import JSZip from "jszip";
import { EvalError } from "../../errors.js";
import { ExposureControlFailure } from "./errors.js";

export type ArtefactKind =
  "prompt" | "model_response" | "http_body" | "memo" | "store_rows" | "log";

export const ARTEFACT_KINDS: readonly ArtefactKind[] = [
  "prompt",
  "model_response",
  "http_body",
  "memo",
  "store_rows",
  "log",
];

export interface TokenSet {
  /** Canary strings. Matched without regard to case. */
  canary: readonly string[];
  /** Ids of another matter: its span, document and document version ids, and its own id. */
  ids: readonly string[];
}

export interface ScanTarget {
  kind: ArtefactKind;
  /** For the report: a route template, a table name, a call number. Never content. */
  label: string;
  content: string | Uint8Array;
  forbid: TokenSet;
}

export interface ScanHit {
  kind: ArtefactKind;
  label: string;
  token: "canary" | "id";
  /** The position of the token in `forbid.canary` or `forbid.ids`. */
  index: number;
}

export interface Scanner {
  scan(target: ScanTarget): Promise<ScanHit[]>;
}

/** Shorter than this cannot be told from ordinary text, and would make every artefact a hit. */
const MIN_TOKEN_LENGTH = 8;

const stripTags = (xml: string): string => xml.replace(/<[^>]*>/g, "");

export const isZip = (bytes: Uint8Array): boolean =>
  bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 4;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  shy: "",
};

/** Characters that show nothing: soft hyphen, zero width, bidi marks and isolates, the byte order mark. */
const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;

const codePoint = (value: number, whole: string): string => {
  try {
    return String.fromCodePoint(value);
  } catch {
    return whole;
  }
};

const decodeEntities = (text: string): string =>
  text.replace(
    /&(?:#x([0-9a-f]{1,6})|#([0-9]{1,7})|([a-z]{2,8}));/gi,
    (whole, hex?: string, dec?: string, name?: string) => {
      if (hex !== undefined) return codePoint(Number.parseInt(hex, 16), whole);
      if (dec !== undefined) return codePoint(Number.parseInt(dec, 10), whole);
      return NAMED_ENTITIES[(name ?? "").toLowerCase()] ?? whole;
    },
  );

const unescapeJson = (text: string): string =>
  text
    .replace(/\\u([0-9a-f]{4})/gi, (_whole, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\([\\/"])/g, "$1");

const decodePercent = (text: string): string =>
  text.replace(/%([0-9a-f]{2})/gi, (_whole, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

/** The text without markup and decoded: JSON escapes, tags, entities, percent escapes, invisible characters. */
export const plainTextOf = (text: string): string =>
  decodePercent(decodeEntities(stripTags(unescapeJson(text)))).replace(INVISIBLE, "");

/**
 * The views a text is searched in, in lower case: as written; with the tags taken out; and plain
 * (see `plainTextOf`). A token counts if any view holds it. Views that equal an earlier one are
 * left out.
 */
export function textViewsOf(text: string): string[] {
  const views = [text];
  if (text.includes("<")) views.push(stripTags(text));
  views.push(plainTextOf(text));
  return [...new Set(views.map((view) => view.toLowerCase()))];
}

/**
 * Every part of a package that starts as a zip, inflated, as text. A package that cannot be opened,
 * or has a part that cannot be inflated or fails its checksum, stops the suite: its content is
 * compressed, so searching the bytes instead would find nothing in it and report it clean. `what`
 * names the artefact in the message (a kind and a label, never content).
 */
export async function docxParts(
  bytes: Uint8Array,
  what = "An artefact",
): Promise<{ name: string; text: string }[]> {
  try {
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const parts: { name: string; text: string }[] = [];
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      parts.push({ name: entry.name, text: await entry.async("string") });
    }
    return parts;
  } catch {
    throw new ExposureControlFailure(
      `${what} is a package that could not be read, so no count can be trusted.`,
    );
  }
}

/** The texts an artefact can be read as. A Word file gives every part, in every view. */
async function textsOf(target: ScanTarget): Promise<string[]> {
  const { content } = target;
  if (typeof content === "string") return textViewsOf(content);
  if (!isZip(content)) return textViewsOf(Buffer.from(content).toString("utf8"));
  const parts = await docxParts(content, `The ${target.kind} artefact ${target.label}`);
  return parts.flatMap((part) => textViewsOf(part.text));
}

/**
 * The positions of the ids that are not a part of a longer id of the same list. An artefact that
 * holds every id of the list gives a hit for exactly these.
 */
export function maximalIds(ids: readonly string[]): number[] {
  const lower = ids.map((id) => id.toLowerCase());
  return lower.flatMap((id, index) =>
    lower.some((other) => other.length > id.length && other.includes(id)) ? [] : [index],
  );
}

export function createScanner(): Scanner {
  return {
    async scan(target) {
      const texts = await textsOf(target);
      const present = (value: string): boolean => {
        if (value.length === 0) return false;
        const needle = value.toLowerCase();
        return texts.some((text) => text.includes(needle));
      };
      const hits: ScanHit[] = [];
      const hit = (token: ScanHit["token"], index: number): void => {
        hits.push({ kind: target.kind, label: target.label, token, index });
      };
      target.forbid.canary.forEach((value, index) => {
        if (present(value)) hit("canary", index);
      });
      // A span id holds the id of its document version, so a span id that is found would be found
      // twice. An id that is a part of another id found in the same artefact counts once, as the
      // longer one.
      const found = target.forbid.ids.flatMap((value, index) =>
        present(value) ? [{ value: value.toLowerCase(), index }] : [],
      );
      for (const { value, index } of found) {
        const inside = found.some(
          (other) => other.value.length > value.length && other.value.includes(value),
        );
        if (!inside) hit("id", index);
      }
      return hits;
    },
  };
}

/** The tokens, checked: none may be too short to mean anything. */
export function checkTokens(forbid: TokenSet, what: string): void {
  for (const token of [...forbid.canary, ...forbid.ids])
    if (token.length < MIN_TOKEN_LENGTH)
      throw new EvalError(
        `The exposure suite was given a ${what} token that is too short to scan for.`,
      );
}

/** What goes into a planted Word package. Text is escaped by the caller, if it needs to be. */
export interface PlantedParts {
  /** Paragraphs of word/document.xml, each cut into runs. */
  document?: readonly string[];
  /** Paragraphs of a header part, each cut into runs. */
  header?: readonly string[];
  /** The title of the document properties, whole. */
  properties?: string;
}

/**
 * A Word package like the one the application writes: DEFLATE compressed (export/package.ts), so
 * that a scanner has to inflate it to read it, with the text of `parts` cut into runs of `split`
 * characters and put in the document, in a header part and in the document properties.
 */
export async function plantedDocx(parts: PlantedParts, split = 7): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  const runs = (text: string): string => {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += split)
      out.push(`<w:r><w:t xml:space="preserve">${text.slice(i, i + split)}</w:t></w:r>`);
    return out.join("");
  };
  const paragraphs = (list: readonly string[]): string =>
    list.map((paragraph) => `<w:p>${runs(paragraph)}</w:p>`).join("");
  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document ${ns}><w:body>${paragraphs(parts.document ?? ["Nothing planted here."])}</w:body></w:document>`,
  );
  zip.file(
    "word/header1.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${ns}>${paragraphs(parts.header ?? ["Draft header."])}</w:hdr>`,
  );
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${parts.properties ?? "Synthetic title"}</dc:title></cp:coreProperties>`,
  );
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

/** The compression method of the first entry of a zip: 8 is DEFLATE, 0 is stored. */
export const zipMethod = (bytes: Uint8Array): number => (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8);

type Expected = { token: ScanHit["token"]; index: number };

/**
 * The scanner's own control. It plants every canary string and every id of `forbid`, each alone in
 * text, cut by markup or encoded, and all together in a DEFLATE compressed Word file (in the body,
 * in a header part and in the document properties), and requires the scanner to find every one. It
 * requires it to find nothing in a clean text and a clean Word file. Throws `ExposureControlFailure`
 * if it does not. The message names which control failed and never a token.
 */
export async function runControl(scanner: Scanner, forbid: TokenSet): Promise<void> {
  const first = forbid.canary[0];
  const firstId = forbid.ids[0];
  if (first === undefined || firstId === undefined)
    throw new EvalError(
      "The exposure suite has no canary string and no id to plant as the scanner's control.",
    );
  checkTokens(forbid, "control");

  const attempt = async (
    name: string,
    content: string | Uint8Array,
    kind: ArtefactKind,
    expected: Expected[] | null,
  ): Promise<void> => {
    const hits = await scanner.scan({ kind, label: `control ${name}`, content, forbid });
    if (expected === null) {
      if (hits.length > 0)
        throw new ExposureControlFailure(
          `The exposure scanner reported a hit in a clean artefact (control "${name}"). No count can be trusted.`,
        );
      return;
    }
    const missing = expected.filter(
      (want) => !hits.some((hit) => hit.token === want.token && hit.index === want.index),
    );
    if (missing.length > 0)
      throw new ExposureControlFailure(
        `The exposure scanner did not find the ${missing[0]!.token} it was given in a planted artefact (control "${name}"; ${missing.length} of ${expected.length} missed). No count can be trusted.`,
      );
  };

  const every: Expected[] = [
    ...forbid.canary.map((_value, index): Expected => ({ token: "canary", index })),
    ...maximalIds(forbid.ids).map((index): Expected => ({ token: "id", index })),
  ];
  const clean = "A clean synthetic paragraph that holds nothing the scan is looking for.";
  const half = (value: string): number => Math.floor(value.length / 2);

  await attempt("clean text", clean, "http_body", null);
  await attempt(
    "clean compressed Word file",
    await plantedDocx({ document: [clean] }),
    "memo",
    null,
  );

  // Each string and each id alone, so that none hides behind another.
  for (const [index, value] of forbid.canary.entries()) {
    await attempt(
      "canary string in text",
      `${clean} Note ${value.toUpperCase()} follows.`,
      "http_body",
      [{ token: "canary", index }],
    );
    await attempt(
      "canary string in other case",
      `${clean} ${value.toLowerCase()}`,
      "model_response",
      [{ token: "canary", index }],
    );
  }
  for (const [index, value] of forbid.ids.entries())
    await attempt("id in text", `${clean} {"spanId":"${value}"}`, "http_body", [
      { token: "id", index },
    ]);

  // The ways a mark element, an entity or an escape can hide a token from a search of the raw text.
  const entity = (value: string): string =>
    `&#x${(value.codePointAt(0) ?? 0).toString(16)};${value.slice(1)}`;
  await attempt(
    "canary string cut by a mark element",
    `<p>${clean} ${first.slice(0, half(first))}</span><mark class="quote">${first.slice(half(first))}</mark></p>`,
    "http_body",
    [{ token: "canary", index: 0 }],
  );
  await attempt(
    "canary string as an HTML entity",
    `<p>${clean} ${entity(first)}</p>`,
    "http_body",
    [{ token: "canary", index: 0 }],
  );
  await attempt(
    "canary string with a soft hyphen",
    `${clean} ${first.slice(0, half(first))}­${first.slice(half(first))}`,
    "http_body",
    [{ token: "canary", index: 0 }],
  );
  await attempt(
    "id percent encoded",
    `/matters?from=${encodeURIComponent(firstId).replace(/[_:]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    "http_body",
    [{ token: "id", index: 0 }],
  );
  await attempt(
    "id JSON escaped",
    `{"id":"\\u${(firstId.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}${firstId.slice(1)}"}`,
    "http_body",
    [{ token: "id", index: 0 }],
  );

  // Everything at once, in a package that is compressed as the application's memo is, once in each
  // part, so that a scanner that skips a part or never inflates one is caught.
  const planted = [...forbid.canary, ...forbid.ids];
  const bodies: [string, PlantedParts][] = [
    ["body", { document: [clean, ...planted] }],
    ["header part", { header: planted }],
    ["document properties", { properties: planted.join(" ") }],
  ];
  for (const [part, parts] of bodies) {
    const bytes = await plantedDocx(parts);
    if (!isZip(bytes) || zipMethod(bytes) !== 8)
      throw new EvalError("The exposure suite's planted Word file is not DEFLATE compressed.");
    await attempt(
      `every string and id in the ${part} of a compressed Word file`,
      bytes,
      "memo",
      every,
    );
  }
}

/** What the scan found, in counts and places. */
export interface Ledger {
  readonly scanned: number;
  readonly byKind: Readonly<Record<ArtefactKind, number>>;
  readonly canaryHits: number;
  readonly idHits: number;
  readonly hits: readonly ScanHit[];
  /** Artefacts that hold the distinctive fact of the other matter. An attempt, not a breach. */
  readonly factSightings: number;
  add(target: ScanTarget, facts?: readonly string[]): Promise<void>;
}

export function createLedger(scanner: Scanner): Ledger {
  const byKind = Object.fromEntries(ARTEFACT_KINDS.map((kind) => [kind, 0])) as Record<
    ArtefactKind,
    number
  >;
  const hits: ScanHit[] = [];
  const state = { scanned: 0, canaryHits: 0, idHits: 0, factSightings: 0 };
  return {
    get scanned() {
      return state.scanned;
    },
    byKind,
    get canaryHits() {
      return state.canaryHits;
    },
    get idHits() {
      return state.idHits;
    },
    hits,
    get factSightings() {
      return state.factSightings;
    },
    async add(target, facts = []) {
      checkTokens(target.forbid, "forbidden");
      state.scanned += 1;
      byKind[target.kind] += 1;
      for (const hit of await scanner.scan(target)) {
        hits.push(hit);
        if (hit.token === "canary") state.canaryHits += 1;
        else state.idHits += 1;
      }
      const wanted = facts.filter((fact) => fact.length >= MIN_TOKEN_LENGTH);
      if (wanted.length > 0) {
        const seen = await scanner.scan({ ...target, forbid: { canary: wanted, ids: [] } });
        if (seen.length > 0) state.factSightings += 1;
      }
    },
  };
}
