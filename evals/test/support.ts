import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import {
  ModelOutputError,
  type GenerateObjectRequest,
  type ObjectGenerator,
} from "@clausewise/llm";
import { reviewContract, type ReviewReport, type RuleCheck } from "@clausewise/review";
import { createOracleGenerator, type OracleRule } from "@clausewise/review/testing";
import { loadFixtures, type Fixture } from "../src/fixtures.js";
import { runEvals, type EvalIo, type GeneratorRequest } from "../src/harness.js";
import { oracleScripts } from "../src/selftest.js";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** A key that exists only so that the configuration loads. Every test injects its own model. */
export const TEST_ENV = { ANTHROPIC_API_KEY: "sk-test-not-a-real-key" };

// The tests count these three by hand. A fixture added later is not part of those counts, so every
// run in the tests names these three unless it names fixtures of its own.
export const SHIPPED = ["nda-aggressive.docx", "nda-balanced.docx", "saas-vendor-friendly.docx"];

export const allFixtures = (): Promise<Fixture[]> => loadFixtures(ROOT, SHIPPED);

export async function oneFixture(name: string): Promise<Fixture> {
  const [fixture] = await loadFixtures(ROOT, [name]);
  if (fixture === undefined) throw new Error(`no fixture ${name}`);
  return fixture;
}

export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "clausewise-evals-"));
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function run(
  args: string[],
  io: Partial<EvalIo> & { dir: string },
): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const { dir, ...rest } = io;
  const names = args.includes("--fixture") || args.includes("--help") ? [] : SHIPPED;
  const code = await runEvals([...args, ...names.flatMap((name) => ["--fixture", name])], {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: TEST_ENV,
    resultsDir: dir,
    ...rest,
  });
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------------------------
// Stand-ins for the model
// ---------------------------------------------------------------------------------------------

const MARKERS: [string, string][] = [
  ["Northwind Holdings", "nda-aggressive.docx"],
  ["Contoso Software", "nda-balanced.docx"],
  ["Cloudhaven Systems", "saas-vendor-friendly.docx"],
];

export function fixtureOfPrompt(prompt: string): string {
  const found = MARKERS.find(([marker]) => prompt.includes(marker));
  if (found === undefined) throw new Error("the prompt is not of a known fixture");
  return found[1];
}

export function ruleIdOfPrompt(prompt: string): string {
  const id = /^Rule ID: (.+)$/m.exec(prompt.slice(prompt.lastIndexOf("</contract>")))?.[1];
  if (id === undefined) throw new Error("the prompt has no rule id");
  return id;
}

export interface CallInfo {
  /** 1-based over the whole run. */
  n: number;
  fixture: string;
  ruleId: string;
}

export type RoutedModel = ObjectGenerator & { readonly requests: GenerateObjectRequest<unknown>[] };

/**
 * One generator that answers every fixture, telling them apart by the contract in the prompt. It
 * stands in for a real model in the tests of a real run, which share one generator.
 */
export function routedModel(
  fixtures: readonly Fixture[],
  args: {
    scripts?: (fixture: Fixture) => Record<string, OracleRule>;
    /** Runs before each answer. Throw to fail the call. */
    before?: (call: CallInfo) => void;
    /** Changes an answer on its way out, for a model that is wrong on some calls. */
    answer?: (call: CallInfo, check: RuleCheck) => RuleCheck;
    provider?: string;
  } = {},
): RoutedModel {
  const oracles = new Map(
    fixtures.map((fixture) => [
      fixture.name,
      createOracleGenerator((args.scripts ?? oracleScripts)(fixture)),
    ]),
  );
  const requests: GenerateObjectRequest<unknown>[] = [];
  return {
    provider: args.provider ?? "anthropic",
    model: "claude-sonnet-5-5",
    disclosure: "a scripted test model (nothing is sent anywhere)",
    cachesSharedPrefix: true,
    requests,
    async generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      requests.push(request as GenerateObjectRequest<unknown>);
      const name = fixtureOfPrompt(request.prompt);
      const call = { n: requests.length, fixture: name, ruleId: ruleIdOfPrompt(request.prompt) };
      args.before?.(call);
      const oracle = oracles.get(name);
      if (oracle === undefined) throw new Error(`no oracle for ${name}`);
      const check = (await oracle.generate(request)) as RuleCheck;
      return (args.answer?.(call, check) ?? check) as T;
    },
  };
}

export type Factory = (request: GeneratorRequest) => ObjectGenerator;

/** A factory that must never be used, for the tests of a refusal. */
export function forbiddenFactory(): Factory & { readonly used: () => boolean } {
  let used = false;
  const factory: Factory = () => {
    used = true;
    throw new Error("the model was built, but nothing should have been sent");
  };
  return Object.assign(factory, { used: () => used });
}

// ---------------------------------------------------------------------------------------------
// A pipeline run to check
// ---------------------------------------------------------------------------------------------

export async function review(
  fixture: Fixture,
  scripts: Record<string, OracleRule> = oracleScripts(fixture),
): Promise<{ report: ReviewReport; redlined: Uint8Array }> {
  return reviewContract(
    { docx: fixture.docx, playbook: fixture.playbook, fileName: fixture.name },
    createOracleGenerator(scripts),
  );
}

/** Fails every call for the named rules, the way a model that cannot answer them would. */
export function failingRules(inner: ObjectGenerator, ruleIds: readonly string[]): ObjectGenerator {
  return {
    provider: inner.provider,
    model: inner.model,
    disclosure: inner.disclosure,
    generate: (request) => {
      if (ruleIds.includes(ruleIdOfPrompt(request.prompt))) {
        return Promise.reject(new ModelOutputError("the model gave no usable answer"));
      }
      return inner.generate(request);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Damaged files
// ---------------------------------------------------------------------------------------------

export async function readDocumentXml(bytes: Uint8Array): Promise<{ zip: JSZip; xml: string }> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (xml === undefined) throw new Error("no document.xml");
  return { zip, xml };
}

export async function withDocumentXml(
  bytes: Uint8Array,
  change: (xml: string) => string,
): Promise<Uint8Array> {
  const { zip, xml } = await readDocumentXml(bytes);
  const changed = change(xml);
  if (changed === xml) throw new Error("the change did not alter the document");
  zip.file("word/document.xml", changed);
  return zip.generateAsync({ type: "uint8array" });
}

/** Changes the text of a paragraph that no edit touches: the title of nda-aggressive.docx. */
export function corruptText(bytes: Uint8Array): Promise<Uint8Array> {
  return withDocumentXml(bytes, (xml) =>
    xml.replace("CONFIDENTIALITY AGREEMENT", "CONFIDENTIALITY AGREEMENTS"),
  );
}
