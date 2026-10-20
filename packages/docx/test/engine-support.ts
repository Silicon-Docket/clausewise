import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";
import JSZip from "jszip";

const execFileAsync = promisify(execFile);

/** Small seeded generator (mulberry32) so every failure can be replayed from its seed. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
}

/** True when XML 1.0 could not carry the code point. Written out by hand, not shared with the library. */
export function isForbiddenXmlCodePoint(cp: number): boolean {
  if (cp === 0x9 || cp === 0xa || cp === 0xd) return false;
  if (cp >= 0x20 && cp <= 0xd7ff) return false;
  if (cp >= 0xe000 && cp <= 0xfffd) return false;
  if (cp >= 0x10000 && cp <= 0x10ffff) return false;
  return true;
}

/** Every forbidden code point in a string, as hex, with lone surrogates included. */
export function forbiddenCodePoints(text: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    let cp = unit;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (isForbiddenXmlCodePoint(cp)) found.push(cp.toString(16));
  }
  return found;
}

export async function zipParts(buf: Uint8Array): Promise<Record<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(buf);
  const out: Record<string, Uint8Array> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) out[name] = await entry.async("uint8array");
  }
  return out;
}

const hasPython =
  spawnSync("python3", ["-I", "-c", "import lxml.etree"], { stdio: "ignore" }).status === 0;
export const hasStrictParser = hasPython;

const STRICT_SCRIPT = `
import sys, json, base64
from lxml import etree
data = json.load(sys.stdin)
parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False, huge_tree=True)
out = {}
for name, b64 in data.items():
    try:
        etree.fromstring(base64.b64decode(b64), parser)
        out[name] = None
    except Exception as e:
        out[name] = str(e)
json.dump(out, sys.stdout)
`;

/**
 * Parses each part with libxml2 in its strict mode, a parser that shares nothing with xmldom,
 * and returns the error for every part that is not well-formed (null for the ones that are).
 */
export function strictParse(parts: Record<string, Uint8Array>): Record<string, string | null> {
  const payload: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(parts)) {
    payload[name] = Buffer.from(bytes).toString("base64");
  }
  const run = spawnSync("python3", ["-I", "-c", STRICT_SCRIPT], {
    input: JSON.stringify(payload),
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`strict parser failed to run: ${String(run.stderr)}`);
  return JSON.parse(String(run.stdout)) as Record<string, string | null>;
}

/** The XML parts of a redlined package that the engine writes. */
export async function writtenXml(buf: Uint8Array): Promise<Record<string, Uint8Array>> {
  const parts = await zipParts(buf);
  const out: Record<string, Uint8Array> = {};
  for (const name of [
    "word/document.xml",
    "word/comments.xml",
    "word/_rels/document.xml.rels",
    "[Content_Types].xml",
  ]) {
    const part = parts[name];
    if (part) out[name] = part;
  }
  return out;
}

export const hasSoffice = spawnSync("soffice", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * Converts documents to text with LibreOffice in one run. A document it cannot load has no entry
 * in the result, which is how a corrupt file shows.
 */
export async function libreOfficeText(
  docs: Record<string, Uint8Array>,
): Promise<Record<string, string | undefined>> {
  const dir = await mkdtemp(join(tmpdir(), "clausewise-engine-lo-"));
  const names = Object.keys(docs);
  const inputs: string[] = [];
  for (const name of names) {
    const path = join(dir, `${name}.docx`);
    await writeFile(path, docs[name]!);
    inputs.push(path);
  }
  try {
    await execFileAsync(
      "soffice",
      [
        `-env:UserInstallation=file://${join(dir, "profile")}`,
        "--headless",
        "--convert-to",
        "txt:Text",
        "--outdir",
        dir,
        ...inputs,
      ],
      { timeout: 150_000 },
    );
  } catch {
    // A file LibreOffice refuses is reported through its missing output below.
  }
  const out: Record<string, string | undefined> = {};
  for (const name of names) {
    try {
      out[name] = await readFile(join(dir, `${name}.txt`), "utf8");
    } catch {
      out[name] = undefined;
    }
  }
  return out;
}

export interface CraftedEntry {
  name: string;
  data: Uint8Array;
  /** 0 stores, 8 deflates. */
  method?: 0 | 8;
  /** What the headers claim the uncompressed size is, when it should differ from the truth. */
  claimedSize?: number;
}

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/**
 * Writes a zip by hand so a test can state sizes in the headers that are not the real ones, which
 * JSZip never produces. Entries are written as-is.
 */
export function craftZip(entries: CraftedEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(entry.data, { level: 9 }) : entry.data;
    const size = entry.claimedSize ?? entry.data.length;
    const crc = crc32(entry.data);
    const local = Uint8Array.from([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0x21),
      ...u32(crc),
      ...u32(body.length),
      ...u32(size),
      ...u16(name.length),
      ...u16(0),
    ]);
    chunks.push(local, name, body);
    central.push(
      Uint8Array.from([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0),
        ...u16(method),
        ...u16(0),
        ...u16(0x21),
        ...u32(crc),
        ...u32(body.length),
        ...u32(size),
        ...u16(name.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
      ]),
      name,
    );
    offset += local.length + name.length + body.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = Uint8Array.from([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(centralSize),
    ...u32(offset),
    ...u16(0),
  ]);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
