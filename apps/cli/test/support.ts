import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateObjectRequest, ObjectGenerator } from "@clausewise/llm";
import { createOracleGenerator, type OracleRule } from "@clausewise/review/testing";
import JSZip from "jszip";
import { afterEach } from "vitest";
import type { CliIo } from "../src/index.js";

export const root = join(import.meta.dirname, "..", "..", "..");
export const fixturePath = (name: string): string => join(root, "fixtures", name);
export const playbookPath = (name: string): string => join(root, "playbooks", name);

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export const makeTempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "clausewise-cli-"));

export const removeDir = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });

/** Call once in a test file. Returns a function that makes a temp directory removed after the test. */
export function tempDirs(): () => Promise<string> {
  const made: string[] = [];
  afterEach(async () => {
    await Promise.all(made.splice(0).map(removeDir));
  });
  return async () => {
    const dir = await makeTempDir();
    made.push(dir);
    return dir;
  };
}

/** Copies a fixture into `dir` under the same name and returns the new path. */
export async function stage(dir: string, fixture: string): Promise<string> {
  const path = join(dir, fixture);
  await copyFile(fixturePath(fixture), path);
  return path;
}

export const listing = async (dir: string): Promise<string[]> => (await readdir(dir)).sort();

export async function bytesOf(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

export const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(a, b) === 0;

// ---------------------------------------------------------------------------------------------
// Driving run()
// ---------------------------------------------------------------------------------------------

export interface Harness {
  io: CliIo;
  stdout: () => string;
  stderr: () => string;
}

/** Everything the CLI prints, kept apart, and optionally in order in one shared log. */
export function makeIo(
  options: {
    env?: Record<string, string | undefined>;
    generator?: ObjectGenerator;
    signal?: AbortSignal;
    log?: string[];
  } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const { generator, signal, log } = options;
  const io: CliIo = {
    stdout: (text) => {
      out.push(text);
      log?.push(`stdout: ${text}`);
    },
    stderr: (text) => {
      err.push(text);
      log?.push(`stderr: ${text}`);
    },
    env: options.env ?? {},
    ...(generator === undefined ? {} : { generatorFactory: () => generator }),
    ...(signal === undefined ? {} : { signal }),
  };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

/** Passes calls through to `inner` and notes each one in `log` before it is answered. */
export function tracing(inner: ObjectGenerator, log: string[]): ObjectGenerator {
  return {
    provider: inner.provider,
    model: inner.model,
    disclosure: inner.disclosure,
    cachesSharedPrefix: inner.cachesSharedPrefix === true,
    generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      log.push("generate");
      return inner.generate(request);
    },
  };
}

/** A model whose every call fails with `error`. */
export function failingGenerator(error: () => unknown): ObjectGenerator {
  return {
    provider: "failing",
    model: "failing-model",
    disclosure: "a failing test generator (nothing is sent anywhere)",
    generate: () => Promise.reject(error()),
  };
}

// ---------------------------------------------------------------------------------------------
// Scripted answers
// ---------------------------------------------------------------------------------------------

type Verdict = "compliant" | "deviation" | "missing" | "n/a";
const expectations = JSON.parse(readFileSync(fixturePath("expected.json"), "utf8")) as Record<
  string,
  { playbook: string; rules: Record<string, Verdict> }
>;

export function ruleIds(file: string): string[] {
  return Object.keys(expectations[file]?.rules ?? {});
}

/** The statuses fixtures/expected.json gives a correct review of `file`, with overrides on top. */
export function expectedScript(
  file: string,
  overrides: Record<string, Partial<OracleRule>> = {},
): Record<string, OracleRule> {
  const entry = expectations[file];
  if (entry === undefined) throw new Error(`no expectations for ${file}`);
  return Object.fromEntries(
    Object.entries(entry.rules).map(([id, verdict]) => [
      id,
      {
        status: verdict === "n/a" ? "not_applicable" : verdict,
        explanation: `Scripted ${verdict} answer for ${id}.`,
        ...overrides[id],
      } satisfies OracleRule,
    ]),
  );
}

/** Every rule of the NDA playbook compliant, except those given. */
export function compliantScript(
  overrides: Record<string, Partial<OracleRule>> = {},
): Record<string, OracleRule> {
  return Object.fromEntries(
    ruleIds("nda-aggressive.docx").map((id) => [
      id,
      {
        status: "compliant",
        explanation: "Meets the standard.",
        ...overrides[id],
      } satisfies OracleRule,
    ]),
  );
}

/** Where the model would point in nda-aggressive.docx, by the numbers printed in the contract. */
export const AGGRESSIVE_CLAUSES: Record<string, string[]> = {
  mutuality: ["1.1", "2.1"],
  definition: ["1.1"],
  exclusions: ["1.2"],
  term: ["3.1"],
  "permitted-use": ["2.2"],
  "compelled-disclosure": [],
  "return-or-destroy": ["4.1"],
  remedies: ["5.1", "5.2", "5.3"],
  "restrictive-covenants": ["6.1"],
  "governing-law": ["7.1"],
};

export const TERM_EDIT = {
  clauseNumber: "3.1",
  quote: "perpetual and shall continue indefinitely",
  replacement: "end three (3) years after the date of disclosure",
};

// The contract says fifty thousand dollars, so this quote is one a model made up.
export const HALLUCINATED_EDIT = {
  clauseNumber: "5.2",
  quote: "liquidated damages of one hundred thousand dollars",
  replacement: "damages as provided by law",
};

/** The oracle for the aggressive NDA: the expected statuses, one valid edit, one invented quote. */
export function aggressiveOracle(): ReturnType<typeof createOracleGenerator> {
  const overrides: Record<string, Partial<OracleRule>> = {};
  for (const [id, clauseNumbers] of Object.entries(AGGRESSIVE_CLAUSES)) {
    overrides[id] = { clauseNumbers, comment: `Please fix ${id}.` };
  }
  overrides["term"] = { ...overrides["term"], edit: TERM_EDIT };
  overrides["remedies"] = { ...overrides["remedies"], edit: HALLUCINATED_EDIT };
  overrides["compelled-disclosure"] = {
    ...overrides["compelled-disclosure"],
    suggestedClause: "Recipient may disclose what the law requires, giving notice where permitted.",
  };
  return createOracleGenerator(expectedScript("nda-aggressive.docx", overrides));
}

// ---------------------------------------------------------------------------------------------
// Building files
// ---------------------------------------------------------------------------------------------

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** A valid .docx whose paragraphs are the given plain texts. */
export async function buildDocx(paragraphs: string[]): Promise<Uint8Array> {
  const escape = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = paragraphs
    .map((text) =>
      text === ""
        ? "<w:p/>"
        : `<w:p><w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`,
    )
    .join("");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

// ---------------------------------------------------------------------------------------------
// Reading a .docx the way Word shows it, independent of the code under test
// ---------------------------------------------------------------------------------------------

export interface ParagraphView {
  /** The paragraph with every tracked change accepted. */
  accepted: string;
  /** The paragraph with every tracked change rejected. */
  rejected: string;
  tracked: boolean;
}

export interface DocxView {
  paragraphs: ParagraphView[];
  comments: { author: string; text: string }[];
}

const decode = (text: string): string =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const PARAGRAPH = /<w:p(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:p>)/g;
const TEXT = /<w:(t|delText)(?:\s[^>]*)?>([^<]*)<\/w:\1>/g;

function textOf(xml: string): string {
  return [...xml.matchAll(TEXT)].map((match) => decode(match[2] ?? "")).join("");
}

export async function viewDocx(bytes: Uint8Array): Promise<DocxView> {
  const zip = await JSZip.loadAsync(bytes);
  const document = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const paragraphs = [...document.matchAll(PARAGRAPH)].map(([xml = ""]) => ({
    accepted: textOf(xml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, "")),
    rejected: textOf(xml.replace(/<w:ins\b[\s\S]*?<\/w:ins>/g, "")),
    tracked: /<w:(?:ins|del)\b/.test(xml),
  }));

  const part = (await zip.file("word/comments.xml")?.async("string")) ?? "";
  const comments = [...part.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)].map(
    ([, attributes = "", body = ""]) => ({
      author: decode(/w:author="([^"]*)"/.exec(attributes)?.[1] ?? ""),
      text: body
        .split("</w:p>")
        .slice(0, -1)
        .map((paragraph) => textOf(paragraph))
        .join("\n"),
    }),
  );
  return { paragraphs, comments };
}
