/**
 * The scanner of the exposure suite: looks, in memory, for strings and ids that must not be where
 * they are found. It is given an artefact (a prompt before it is sent, a model answer, an HTTP
 * response body, an exported memo, the rows of a table) and the tokens that are forbidden in that
 * artefact, and answers which tokens it holds.
 *
 * Three rules keep it honest.
 *
 *  - It counts a token once per artefact, however often the token occurs there (and an id that is
 *    only a part of a longer id found in the same artefact, such as a version id inside a span
 *    id, as that longer id), and it reports
 *    where (the kind of artefact, a label such as a route template or a table name, and the index
 *    of the token). It never reports what was found: a hit names a place and a number only.
 *  - A Word file is read as a Word file: every part of the package is searched, both as written and
 *    with the markup taken out, so a string split across runs is found.
 *  - Before any count is reported the suite runs `runControl`: the scanner has to find a planted
 *    canary in a planted artefact (text, text in another case, a Word file whose runs split the
 *    string, and an id) and to find nothing in a clean one. A scanner that cannot do that would
 *    report zero for anything.
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

const isZip = (bytes: Uint8Array): boolean =>
  bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 4;

/** The texts an artefact can be read as. A Word file gives every part, as written and without markup. */
async function textsOf(content: string | Uint8Array): Promise<string[]> {
  if (typeof content === "string") return [content.toLowerCase()];
  if (!isZip(content)) return [Buffer.from(content).toString("utf8").toLowerCase()];
  try {
    const zip = await JSZip.loadAsync(content);
    const texts: string[] = [];
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const text = (await entry.async("string")).toLowerCase();
      texts.push(text);
      if (/\.(xml|rels)$/i.test(entry.name)) texts.push(stripTags(text));
    }
    return texts;
  } catch {
    // A package that cannot be opened is searched as the bytes it is.
    return [Buffer.from(content).toString("latin1").toLowerCase()];
  }
}

export function createScanner(): Scanner {
  return {
    async scan(target) {
      const texts = await textsOf(target.content);
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
        present(value) ? [{ value, index }] : [],
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

/** A Word package holding `paragraphs`, each split into runs of `split` characters. */
async function plantedDocx(paragraphs: string[], split: number): Promise<Uint8Array> {
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
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p>${runs(p)}</w:p>`).join("")}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

/**
 * The scanner's own control. It plants a canary string and an id of `forbid` in artefacts of
 * several shapes and requires the scanner to find each, and requires it to find nothing in an
 * artefact that holds none of them. Throws `ExposureControlFailure` if it does not. The message
 * names which control failed and never a token.
 */
export async function runControl(scanner: Scanner, forbid: TokenSet): Promise<void> {
  const canary = forbid.canary[0];
  const id = forbid.ids[0];
  if (canary === undefined || id === undefined)
    throw new EvalError(
      "The exposure suite has no canary string and no id to plant as the scanner's control.",
    );
  checkTokens(forbid, "control");

  const attempt = async (
    name: string,
    content: string | Uint8Array,
    kind: ArtefactKind,
    expected: { token: ScanHit["token"]; index: number } | null,
  ): Promise<void> => {
    const hits = await scanner.scan({ kind, label: `control ${name}`, content, forbid });
    const found =
      expected === null
        ? hits.length === 0
        : hits.some((hit) => hit.token === expected.token && hit.index === expected.index);
    if (!found)
      throw new ExposureControlFailure(
        expected === null
          ? `The exposure scanner reported a hit in a clean artefact (control "${name}"). No count can be trusted.`
          : `The exposure scanner did not find the ${expected.token} it was given in a planted artefact (control "${name}"). No count can be trusted.`,
      );
  };

  const clean = "A clean synthetic paragraph that holds nothing the scan is looking for.";
  await attempt("clean text", clean, "http_body", null);
  await attempt("canary in text", `${clean} Note ${canary.toUpperCase()} follows.`, "http_body", {
    token: "canary",
    index: 0,
  });
  await attempt("canary in other case", `${clean} ${canary.toLowerCase()}`, "model_response", {
    token: "canary",
    index: 0,
  });
  await attempt("id in text", `${clean} {"spanId":"${id}"}`, "http_body", {
    token: "id",
    index: 0,
  });
  await attempt(
    "canary split across runs of a Word file",
    await plantedDocx([clean, canary], 7),
    "memo",
    { token: "canary", index: 0 },
  );
  await attempt("clean Word file", await plantedDocx([clean], 7), "memo", null);
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
