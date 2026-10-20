import { parseDocx } from "../packages/docx/src/index.js";
import {
  ModelRequestError,
  type GenerateObjectRequest,
  type ObjectGenerator,
} from "../packages/llm/src/index.js";
import { createScriptedGenerator } from "../packages/llm/src/testing.js";
import { createOracleGenerator, type OracleRule } from "../packages/review/src/testing.js";
import { loadFixtures, type Fixture } from "../evals/src/fixtures.js";
import { oracleScripts } from "../evals/src/selftest.js";
import { REPO_ROOT } from "./paths.js";

/**
 * Put this in the "Who are you acting for?" field and the oracle takes a moment over every rule,
 * so that a test can watch a review while it runs. The oracle reads it from the prompt, which is
 * how a client reaches a model; nothing else about the server changes.
 */
export const SLOW_CLIENT_MARKER = "e2e-slow";

/** How long the oracle takes over each rule when the marker is present. */
export const SLOW_RULE_MS = 900;

/**
 * Put this in the client field and the oracle quotes words for one rule that are not in the
 * contract, the way a model that misquotes does. The review cannot place that edit, so it keeps
 * the suggestion as a comment: the one kind of finding the oracle's own scripts never produce.
 */
export const UNANCHORED_CLIENT_MARKER = "e2e-unanchored";

/** The NDA rule whose edit is misquoted when the marker is present. */
export const UNANCHORED_RULE_ID = "return-or-destroy";

/** The words the oracle misquotes in place of the real ones; the contract says five days. */
export const MISQUOTED_WORDS = "Within seven (7) days of any request";

/** Paragraphs shorter than this say too little to tell one contract from another. */
const MIN_IDENTIFYING_CHARS = 40;

/**
 * The harness's scripts give a rule only its status and edit, which leaves every explanation and
 * comment empty. A screen and a Word comment with nothing in them prove little, so each rule here
 * gets a sentence of its own that a test can look for.
 */
function withWords(ruleId: string, rule: OracleRule): OracleRule {
  const finding = rule.status === "deviation" || rule.status === "missing";
  return {
    ...rule,
    explanation: `Oracle explanation for ${ruleId}.`,
    comment: finding ? `Oracle comment for ${ruleId}.` : "",
    ...(rule.status === "missing"
      ? { suggestedClause: `Oracle suggested clause for ${ruleId}.` }
      : {}),
  };
}

interface Candidate {
  fixture: Fixture;
  generator: ObjectGenerator;
  /** Whole paragraphs of the contract, as the prompt renders them. */
  paragraphs: string[];
}

const contractPart = (prompt: string): string => {
  const close = prompt.lastIndexOf("</contract>");
  return close === -1 ? prompt : prompt.slice(0, close);
};

// Only what follows the contract is read for a marker, because the contract can hold any text.
const afterContract = (prompt: string): string => {
  const close = prompt.lastIndexOf("</contract>");
  return close === -1 ? "" : prompt.slice(close);
};

const clientHas = (prompt: string, marker: string): boolean =>
  new RegExp(`^Our client: .*${marker}`, "m").test(afterContract(prompt));

const ruleIdOf = (prompt: string): string | undefined =>
  /^Rule ID: (.+)$/m.exec(afterContract(prompt))?.[1];

const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** What the oracle says about the model, so that a test can look for it on the screen. */
export const ORACLE_INFO = {
  provider: "oracle",
  model: "oracle",
  disclosure: "a scripted test oracle (nothing is sent anywhere)",
} as const;

/**
 * The scripted oracle of the evaluation harness, for every fixture at once. The harness builds one
 * oracle per contract, keyed by rule id, but a server reviews whichever contract is uploaded, and
 * two fixtures share rule ids (governing-law is in both playbooks). So the oracle that answers is
 * the one whose contract the prompt holds: the fixture with the most of its paragraphs in the
 * contract block. A contract that matches none is an error, because answering for the wrong
 * contract would make a test pass for the wrong reason.
 */
export async function createFixtureOracle(): Promise<ObjectGenerator> {
  const fixtures = await loadFixtures(REPO_ROOT, []);
  const candidates: Candidate[] = [];
  for (const fixture of fixtures) {
    const parsed = await parseDocx(fixture.docx);
    candidates.push({
      fixture,
      generator: createOracleGenerator(
        Object.fromEntries(
          Object.entries(oracleScripts(fixture)).map(([id, rule]) => [id, withWords(id, rule)]),
        ),
      ),
      paragraphs: parsed.paragraphs
        .map((paragraph) => paragraph.text)
        .filter((text) => text.length >= MIN_IDENTIFYING_CHARS && !/[\r\n]/.test(text)),
    });
  }

  const choose = (prompt: string): Candidate => {
    const contract = contractPart(prompt);
    let best: Candidate | undefined;
    let bestScore = 0;
    for (const candidate of candidates) {
      const score = candidate.paragraphs.filter((text) => contract.includes(text)).length;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best === undefined) throw new Error("The e2e oracle does not recognise this contract.");
    return best;
  };

  return {
    ...ORACLE_INFO,
    cachesSharedPrefix: false,
    async generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      if (clientHas(request.prompt, SLOW_CLIENT_MARKER)) await sleep(SLOW_RULE_MS, request.signal);
      const answer = await choose(request.prompt).generator.generate(request);
      if (
        clientHas(request.prompt, UNANCHORED_CLIENT_MARKER) &&
        ruleIdOf(request.prompt) === UNANCHORED_RULE_ID
      ) {
        const check = answer as { edit?: { quote: string } | null };
        if (check.edit !== null && check.edit !== undefined) {
          return { ...check, edit: { ...check.edit, quote: MISQUOTED_WORDS } } as T;
        }
      }
      return answer;
    },
  };
}

/**
 * A model whose provider rejects the key on every call. The review pipeline recognises the 401 as
 * one that every other call would meet too, stops at once, and words the advice for the lawyer.
 */
export function createRejectedKeyGenerator(): ObjectGenerator {
  return createScriptedGenerator(
    () => {
      throw new ModelRequestError("invalid x-api-key", 401);
    },
    { ...ORACLE_INFO },
  );
}

/** The wording the review gives for a rejected key, for a test to look for. */
export const REJECTED_KEY_MESSAGE =
  /The model provider answered HTTP 401, so no rule can be checked\. Check the API key/;

/**
 * The edit the oracle proposes for a rule of a fixture: the words it quotes and the words it puts
 * in their place. A test looks at what the screen and the downloaded file hold against this, so
 * the expected words are not typed a second time.
 */
export async function scriptedEdit(
  fixtureName: string,
  ruleId: string,
): Promise<{ clauseNumber: string; quote: string; replacement: string }> {
  const [fixture] = await loadFixtures(REPO_ROOT, [fixtureName]);
  const edit = fixture === undefined ? undefined : oracleScripts(fixture)[ruleId]?.edit;
  if (edit === undefined || edit === null) {
    throw new Error(`The oracle proposes no edit for ${ruleId} in ${fixtureName}.`);
  }
  return edit;
}
