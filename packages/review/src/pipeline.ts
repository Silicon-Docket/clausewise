import {
  applyRedline,
  inspectDocx,
  parseDocx,
  type Comment,
  type DocxInspection,
  type Edit,
} from "@clausewise/docx";
import {
  ModelOutputError,
  ModelRefusalError,
  ModelRequestError,
  type ObjectGenerator,
} from "@clausewise/llm";
import type { Playbook, Rule, Severity } from "@clausewise/playbook";
import { anchorEdit, type AnchorResult } from "./anchor.js";
import { createLimiter } from "./concurrency.js";
import { ReviewError } from "./errors.js";
import {
  buildRulePrompt,
  estimateTokens,
  mergeWindowChecks,
  renderClauses,
  windowClauses,
} from "./prompt.js";
import { segment } from "./segment.js";
import {
  RuleCheckSchema,
  type Clause,
  type EditOutcome,
  type ProposedEdit,
  type ReviewOptions,
  type ReviewReport,
  type RuleCheck,
  type RuleResult,
  type RuleStatus,
} from "./types.js";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_AUTHOR = "Clausewise";
const WINDOW_OVERLAP = 1;
// The window budget has to leave room for the model's answer as well as for the prompt.
const OUTPUT_SLACK_TOKENS = 2000;
// A context limit this close to the fixed part of the prompt leaves room for a clause or two per
// call, which means one call per clause and a bill nobody asked for.
const MIN_CLAUSE_BUDGET_TOKENS = 1000;
const MAX_MODEL_CALLS = 2000;
// A prompt this large fits few models, and it is paid for again with every rule.
const LARGE_PROMPT_TOKENS = 500_000;
// Below this much clause text a review would report every required rule as missing.
const MIN_REVIEWABLE_CHARS = 200;
const SCAN_MAX_CHARS = 2000;
const SCAN_MIN_IMAGES = 3;
// Shorter than this, a paragraph is more likely a title, a stamp or a date than a clause.
const MIN_ANCHOR_CHARS = 40;
const UNSAFE_EDIT = "the document could not be edited safely";
// Only used to size the room the window note takes, so the digits are the widest a plan can need.
const WIDEST_WINDOW = { index: MAX_MODEL_CALLS - 1, total: MAX_MODEL_CALLS };

// ---------------------------------------------------------------------------------------------
// What one model call can come to
// ---------------------------------------------------------------------------------------------

// A failure keeps only what is safe to show. Provider and SDK messages can quote the prompt or
// the model's reply, and both hold contract text.
type Failure =
  | { kind: "refusal"; category: string | undefined }
  | { kind: "output"; truncated: boolean }
  | { kind: "uncited" }
  | { kind: "request"; status: number | undefined }
  | { kind: "other"; name: string };

type CallOutcome = { ok: true; check: RuleCheck } | { ok: false; failure: Failure };

// The category and the error name come from outside, so only short plain labels are repeated.
const SAFE_LABEL = /^[\w .:-]{1,64}$/;

function safeLabel(value: string | undefined): string | undefined {
  const label = value?.trim();
  return label !== undefined && SAFE_LABEL.test(label) ? label : undefined;
}

function classify(error: unknown): Failure {
  if (error instanceof ModelRefusalError) {
    return { kind: "refusal", category: safeLabel(error.category) };
  }
  if (error instanceof ModelOutputError)
    return { kind: "output", truncated: error.truncated === true };
  if (error instanceof ModelRequestError) return { kind: "request", status: error.statusCode };
  const name = error instanceof Error ? safeLabel(error.name) : undefined;
  return { kind: "other", name: name ?? "Error" };
}

function describeFailure(failure: Failure): string {
  switch (failure.kind) {
    case "refusal":
      return failure.category === undefined
        ? "The model declined to check this rule."
        : `The model declined to check this rule (refusal category: ${failure.category}).`;
    case "output":
      return failure.truncated
        ? "The model's answer was cut off before it was complete, so this rule was not checked. Raise CLAUSEWISE_MAX_OUTPUT_TOKENS and run the review again."
        : "The model did not return an answer in the expected format for this rule.";
    case "uncited":
      return "The model reported this rule as met without pointing at a clause, so it could not be checked.";
    case "request":
      return failure.status === undefined
        ? "The request to the model failed."
        : `The request to the model failed (HTTP ${failure.status}).`;
    case "other":
      return `The check failed unexpectedly (${failure.name}).`;
  }
}

function describeFailures(failures: Failure[], windowCount: number): string {
  const first = failures[0];
  if (first === undefined) return "The rule was not checked.";
  const reason = describeFailure(first);
  if (windowCount === 1) return reason;
  const rest = failures.length === windowCount ? "" : ", and none of the others showed a deviation";
  return `${failures.length} of ${windowCount} parts of the contract could not be checked${rest}. ${reason}`;
}

// What a request error stands for when it carries no kind of its own.
function kindOf(error: ModelRequestError): string | undefined {
  if (typeof error.kind === "string") return error.kind;
  switch (error.statusCode) {
    case 401:
      return "auth";
    case 402:
      return "billing";
    case 403:
      return "permission";
    case 404:
      return "not_found";
    default:
      return undefined;
  }
}

/**
 * The error that stops a review, when the provider's answer means every other call would fail the
 * same way. The provider decides what is fatal; this only words what the user should check, and
 * never repeats the provider's own text, which can quote the prompt.
 */
function fatalError(error: unknown, model: string): ReviewError | undefined {
  if (!(error instanceof ModelRequestError) || error.fatal !== true) return undefined;
  const shown = safeLabel(model) ?? "the configured model";
  const lead =
    error.statusCode === undefined
      ? "The model provider answered with an error, so no rule can be checked."
      : `The model provider answered HTTP ${error.statusCode}, so no rule can be checked.`;
  switch (kindOf(error)) {
    case "auth":
      return new ReviewError(
        `${lead} Check the API key: the provider rejected it, so it may be wrong, expired or revoked (model: ${shown}).`,
      );
    case "permission":
      return new ReviewError(
        `${lead} Check the API key's permissions and that the account has access to the model (${shown}).`,
      );
    case "not_found":
      return new ReviewError(
        `${lead} Check the model name (${shown}) and, for a local server, the base URL: the provider could not find the model.`,
      );
    case "billing":
      return new ReviewError(
        `${lead} Check the account behind the API key (model: ${shown}): its credit balance, its payment details and any spend limit set for the organisation or workspace.`,
      );
    default:
      return new ReviewError(
        `${lead} Check the API key, its permissions and the model name (${shown}).`,
      );
  }
}

// ---------------------------------------------------------------------------------------------
// From the model's answers to a finding
// ---------------------------------------------------------------------------------------------

/** One rule's answer after the model's claims have been checked against the document. */
interface Finding {
  status: Exclude<RuleStatus, "error">;
  clauseIds: string[];
  clauseNumbers: string[];
  explanation: string;
  comment: string;
  suggestedClause: string | null;
  /** Only a deviation can carry an edit. */
  proposed: ProposedEdit | null;
}

type Verdict = { kind: "finding"; finding: Finding } | { kind: "error"; message: string };

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const unique = <T>(values: T[]): T[] => [...new Set(values)];

/** The clauses of the document, found by what a model is likely to call them. */
interface ClauseIndex {
  byId: Map<string, Clause>;
  /** Clauses by their number as written, so that "2.1." and "Clause 2.1" meet "2.1". */
  byNumber: Map<string, Clause[]>;
  /** Where a comment goes when the finding names no clause that exists. */
  anchor: Clause;
}

// The prompt shows a clause as "[c12] 3.1", so a model copies the brackets, changes the case or
// ends the id with a full stop. Only the shapes of an id are accepted, never other text around it,
// and a number with a leading zero is not an id.
const ID_REF = /^[\s[(<"'`*]*(?:clause\s+)?c([1-9]\d{0,5})[\s\])>"'`*.,;:]*$/i;
const NUMBER_PREFIX = /^(?:clause|section|article|sec\.?|cl\.?|\u00a7)\s*/i;
const LEADING_BRACKETS = /^[\s([]+/;
const TRAILING_PUNCTUATION = /[\s.,;:)\]]+$/;
// No id or clause number is this long. The cap also keeps the patterns above cheap on any reply.
const MAX_REF_CHARS = 64;

function numberKey(text: string): string {
  return text
    .trim()
    .replace(LEADING_BRACKETS, "")
    .replace(NUMBER_PREFIX, "")
    .replace(TRAILING_PUNCTUATION, "")
    .toLowerCase();
}

/**
 * The id of the clause a model's reference means, or undefined when it means none or more than
 * one. A clause number is taken only when exactly one clause carries it, because numbers repeat
 * and some clauses have none.
 */
function resolveClauseRef(raw: string, index: ClauseIndex): string | undefined {
  if (raw.length > MAX_REF_CHARS) return undefined;
  const digits = ID_REF.exec(raw)?.[1];
  if (digits !== undefined) {
    const id = `c${digits}`;
    return index.byId.has(id) ? id : undefined;
  }
  const key = numberKey(raw);
  if (key === "") return undefined;
  const matches = index.byNumber.get(key);
  return matches?.length === 1 ? matches[0]?.id : undefined;
}

function resolveClauseRefs(raw: string[], index: ClauseIndex): string[] {
  return unique(
    raw.flatMap((ref) => {
      const id = resolveClauseRef(ref, index);
      return id === undefined ? [] : [id];
    }),
  );
}

function indexClauses(clauses: Clause[], anchor: Clause): ClauseIndex {
  const byNumber = new Map<string, Clause[]>();
  for (const clause of clauses) {
    const key = clause.number === undefined ? "" : numberKey(clause.number);
    if (key === "") continue;
    byNumber.set(key, [...(byNumber.get(key) ?? []), clause]);
  }
  return { byId: new Map(clauses.map((clause) => [clause.id, clause])), byNumber, anchor };
}

/**
 * Where a comment goes when it has no clause of its own, which is the case for every missing
 * clause. The first paragraph of a contract is often a title, a stamp or a date, so the comment
 * goes on the first clause that has a number, else on the first that is real text.
 */
function pickAnchor(first: Clause, clauses: Clause[], labels: ReadonlyMap<string, string>): Clause {
  const numbered = (clause: Clause): boolean => {
    if (clause.number !== undefined && clause.number.trim() !== "") return true;
    const opening = clause.paragraphs[0];
    return opening !== undefined && (labels.get(opening.id)?.trim() ?? "") !== "";
  };
  return (
    clauses.find(numbered) ??
    clauses.find((clause) => clause.text.trim().length >= MIN_ANCHOR_CHARS) ??
    first
  );
}

// A finding that asks the lawyer to act must say why, whatever the model wrote.
function fallbackExplanation(rule: Rule, status: Finding["status"]): string {
  const title = oneLine(rule.title);
  if (status === "deviation") {
    return `The contract does not meet the playbook standard for "${title}".`;
  }
  if (status === "missing") {
    return `The contract has no clause on "${title}", which the playbook requires.`;
  }
  return "";
}

// The playbook, not the model, decides whether a clause that is absent matters. For a rule that
// forbids something, a contract without it is what the playbook wants, whatever the model called
// that and whether or not the rule is marked required.
function settledStatus(rule: Rule, status: RuleCheck["status"]): Finding["status"] {
  if (rule.kind === "absence") {
    return status === "missing" || status === "not_applicable" ? "compliant" : status;
  }
  if (status === "missing" && !rule.required) return "not_applicable";
  if (status === "not_applicable" && rule.required) return "missing";
  return status;
}

// Meeting a standard that asks for a clause is a claim about a clause, so it has to name one.
const needsCitation = (rule: Rule): boolean => rule.kind !== "absence";

function normalize(rule: Rule, check: RuleCheck, index: ClauseIndex): Finding {
  const status = settledStatus(rule, check.status);
  const clauseIds = resolveClauseRefs(check.clauseIds, index);
  const clauseNumbers = unique(
    clauseIds.flatMap((id) => {
      const number = index.byId.get(id)?.number;
      return number === undefined ? [] : [number];
    }),
  );

  const explanation = check.explanation.trim();
  const suggested = status === "missing" ? (check.suggestedClause?.trim() ?? "") : "";
  const flagged = status === "deviation" || status === "missing";
  const edit = check.edit;
  return {
    status,
    clauseIds,
    clauseNumbers,
    explanation: explanation === "" ? fallbackExplanation(rule, status) : explanation,
    comment: flagged ? check.comment.trim() : "",
    suggestedClause: suggested === "" ? null : suggested,
    // An id that resolves to no clause is left as written, so that the edit is refused for it.
    proposed:
      status === "deviation" && edit !== null
        ? { ...edit, clauseId: resolveClauseRef(edit.clauseId, index) ?? edit.clauseId }
        : null,
  };
}

function judge(
  rule: Rule,
  outcomes: (CallOutcome | undefined)[],
  windowCount: number,
  index: ClauseIndex,
): Verdict {
  const checks: RuleCheck[] = [];
  const failures: Failure[] = [];
  for (const outcome of outcomes) {
    if (outcome === undefined) continue;
    if (!outcome.ok) {
      failures.push(outcome.failure);
    } else if (
      outcome.check.status === "compliant" &&
      needsCitation(rule) &&
      resolveClauseRefs(outcome.check.clauseIds, index).length === 0
    ) {
      // Left out of the merge, where it would outrank the other windows' honest "missing".
      failures.push({ kind: "uncited" });
    } else {
      checks.push(outcome.check);
    }
  }

  const [only] = checks;
  if (only === undefined) {
    return { kind: "error", message: describeFailures(failures, windowCount) };
  }
  const merged = checks.length === 1 ? only : mergeWindowChecks(rule, checks);
  // A window that failed might have held the problem. Only a deviation that was seen stands.
  if (failures.length > 0 && merged.status !== "deviation") {
    return { kind: "error", message: describeFailures(failures, windowCount) };
  }
  const finding = normalize(rule, merged, index);
  if (finding.status === "compliant" && needsCitation(rule) && finding.clauseIds.length === 0) {
    return { kind: "error", message: describeFailure({ kind: "uncited" }) };
  }
  return { kind: "finding", finding };
}

// ---------------------------------------------------------------------------------------------
// Windows and model calls
// ---------------------------------------------------------------------------------------------

// What every call spends before the first clause: the instructions and the largest rule. With no
// clauses the prompt is the playbook preamble and the rule block.
function promptOverhead(playbook: Playbook, client: string | undefined): number {
  const empty = playbook.rules.map((rule) =>
    buildRulePrompt({
      playbook,
      rule,
      clauses: [],
      ...(client === undefined ? {} : { client }),
      window: WIDEST_WINDOW,
    }),
  );
  const system = empty[0]?.system ?? "";
  return estimateTokens(system) + Math.max(...empty.map((built) => estimateTokens(built.prompt)));
}

/** The estimated tokens of each call that contract text cannot use: the prompt and the answer. */
export function windowReserve(playbook: Playbook, client?: string): number {
  return promptOverhead(playbook, client) + OUTPUT_SLACK_TOKENS;
}

/** A context limit has to be larger than this, or a call has no room for a clause or two. */
export function contextFloor(playbook: Playbook, client?: string): number {
  return windowReserve(playbook, client) + MIN_CLAUSE_BUDGET_TOKENS;
}

function planWindows(
  playbook: Playbook,
  clauses: Clause[],
  maxContextTokens: number | undefined,
  client: string | undefined,
): { windows: Clause[][]; warnings: string[] } {
  const overhead = promptOverhead(playbook, client);
  if (maxContextTokens === undefined) {
    const estimated = overhead + estimateTokens(renderClauses(clauses));
    const warnings =
      estimated > LARGE_PROMPT_TOKENS
        ? [
            `The contract is about ${estimated} tokens (estimated) and goes to the model whole with every rule, which is more than most models accept. Set CLAUSEWISE_MAX_CONTEXT_TOKENS to review it in parts.`,
          ]
        : [];
    return { windows: [clauses], warnings };
  }

  const reserved = overhead + OUTPUT_SLACK_TOKENS;
  const floor = reserved + MIN_CLAUSE_BUDGET_TOKENS;
  if (maxContextTokens <= floor) {
    throw new ReviewError(
      `The context limit of ${maxContextTokens} tokens is too small. The instructions, the playbook rule and room for the answer take about ${reserved} tokens of every call, so the limit (CLAUSEWISE_MAX_CONTEXT_TOKENS) must be above ${floor}, and well above that for a long contract.`,
    );
  }
  const windows = windowClauses(clauses, {
    maxTokens: maxContextTokens,
    reservedTokens: reserved,
    overlap: WINDOW_OVERLAP,
  });
  const calls = windows.length * playbook.rules.length;
  if (calls > MAX_MODEL_CALLS) {
    throw new ReviewError(
      `The context limit of ${maxContextTokens} tokens is too small for this contract: it would be reviewed in ${windows.length} parts, which is ${calls} model calls for ${playbook.rules.length} rules, and the most a review makes is ${MAX_MODEL_CALLS}. Raise CLAUSEWISE_MAX_CONTEXT_TOKENS to the largest your model accepts.`,
    );
  }
  return { windows, warnings: [] };
}

interface RuleRun {
  rule: Rule;
  /** One slot per window, filled as that window's call settles. */
  outcomes: (CallOutcome | undefined)[];
  remaining: number;
  verdict: Verdict | undefined;
}

function readAnswer(answer: unknown): CallOutcome {
  // The generator is meant to return a parsed answer already. A stand-in or a wrapper that does
  // not is caught here rather than crashing the code that reads it.
  const parsed = RuleCheckSchema.safeParse(answer);
  return parsed.success
    ? { ok: true, check: parsed.data }
    : { ok: false, failure: { kind: "output", truncated: false } };
}

function watchAbort(
  signal: AbortSignal | undefined,
  onAbort: () => void,
): { aborted: Promise<never>; dispose: () => void } {
  if (signal === undefined) return { aborted: new Promise<never>(() => {}), dispose: () => {} };
  let listener = (): void => {};
  const aborted = new Promise<never>((_, reject) => {
    listener = () => {
      onAbort();
      reject(signal.reason);
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  return { aborted, dispose: () => signal.removeEventListener("abort", listener) };
}

async function runChecks(args: {
  playbook: Playbook;
  windows: Clause[][];
  index: ClauseIndex;
  generator: ObjectGenerator;
  options: ReviewOptions;
  client: string | undefined;
  concurrency: number;
}): Promise<Verdict[]> {
  const { playbook, windows, index, generator, options, client } = args;
  const { signal } = options;
  signal?.throwIfAborted();

  const limit = createLimiter(args.concurrency);
  const runs: RuleRun[] = playbook.rules.map((rule) => ({
    rule,
    outcomes: windows.map(() => undefined),
    remaining: windows.length,
    verdict: undefined,
  }));
  // Once stopped, no call is launched. Calls already in flight are left to settle.
  const state: { stopped: boolean; halted: { error: unknown } | undefined; finished: number } = {
    stopped: false,
    halted: undefined,
    finished: 0,
  };
  const halt = (error: unknown): void => {
    state.stopped = true;
    state.halted ??= { error };
  };

  // Every rule's call in one window gets the same client and the same part number, which is what
  // keeps the start of the prompt identical across them.
  const promptFor = (rule: Rule, w: number) =>
    buildRulePrompt({
      playbook,
      rule,
      clauses: windows[w] ?? [],
      ...(client === undefined ? {} : { client }),
      ...(windows.length > 1 ? { window: { index: w, total: windows.length } } : {}),
    });

  const settle = (run: RuleRun, w: number, outcome: CallOutcome): void => {
    run.outcomes[w] = outcome;
    run.remaining -= 1;
    if (run.remaining > 0 || state.stopped) return;
    const verdict = judge(run.rule, run.outcomes, windows.length, index);
    run.verdict = verdict;
    state.finished += 1;
    options.onProgress?.({
      type: "rule",
      ruleId: run.rule.id,
      status: verdict.kind === "error" ? "error" : verdict.finding.status,
      done: state.finished,
      total: runs.length,
    });
  };

  const attempt = async (run: RuleRun, w: number): Promise<void> => {
    if (state.stopped || windows[w] === undefined) return;
    const { system, prompt, sharedPrefix } = promptFor(run.rule, w);
    let outcome: CallOutcome;
    try {
      const answer = await generator.generate({
        system,
        prompt,
        sharedPrefix,
        schema: RuleCheckSchema,
        schemaName: "rule_check",
        ...(signal === undefined ? {} : { signal }),
      });
      outcome = readAnswer(answer);
    } catch (error) {
      const fatal = fatalError(error, generator.model);
      if (fatal !== undefined) {
        halt(fatal);
        return;
      }
      outcome = { ok: false, failure: classify(error) };
    }
    settle(run, w, outcome);
  };

  // Nothing here may reject: a job that did would end the wait while other calls are in flight.
  const check = async (run: RuleRun, w: number): Promise<void> => {
    try {
      await attempt(run, w);
    } catch (error) {
      halt(error);
    }
  };

  const watch = watchAbort(signal, () => {
    state.stopped = true;
  });

  const [first, ...rest] = runs;
  // A cache entry can be read only once the first response has started, so the first rule's call
  // of a window goes alone. A prefix shorter than the provider's minimum is never cached, and
  // waiting for it would only make the window slower.
  const cacheFloor = generator.minCacheableChars ?? 0;
  const firstGoesAlone = windows.map(
    (_, w) =>
      generator.cachesSharedPrefix === true &&
      first !== undefined &&
      promptFor(first.rule, w).sharedPrefix.length >= cacheFloor,
  );

  const jobs: Promise<void>[] = [];
  // Only individual calls take a slot, never the code that waits for one, so this cannot hold
  // every slot while it waits for another.
  windows.forEach((_, w) => {
    if (first === undefined || firstGoesAlone[w] !== true) return;
    jobs.push(
      (async () => {
        await limit(() => check(first, w));
        await Promise.all(rest.map((run) => limit(() => check(run, w))));
      })(),
    );
  });
  for (const run of runs) {
    windows.forEach((_, w) => {
      if (firstGoesAlone[w] !== true) jobs.push(limit(() => check(run, w)));
    });
  }

  try {
    // An abort rejects at once instead of waiting for a generator that ignores its signal.
    await Promise.race([Promise.all(jobs), watch.aborted]);
  } finally {
    watch.dispose();
  }
  if (signal?.aborted) throw signal.reason;
  if (state.halted !== undefined) throw state.halted.error;

  return runs.map((run) => {
    if (run.verdict === undefined) throw new ReviewError("A rule check did not finish.");
    return run.verdict;
  });
}

// ---------------------------------------------------------------------------------------------
// Edits and comments
// ---------------------------------------------------------------------------------------------

type AnchoredEdit = Extract<AnchorResult, { ok: true }>;

interface Draft {
  rule: Rule;
  finding: Finding | undefined;
  /** Why the rule could not be checked, when it could not. */
  error: string | undefined;
  /** The proposed edit, once it has been matched to one span of the document. */
  anchor: AnchoredEdit | undefined;
  /** Why a proposed edit is not a tracked change: it did not anchor, or the redline refused it. */
  blocked: string | undefined;
}

type Flagged = Draft & { finding: Finding };

const isFlagged = (draft: Draft): draft is Flagged =>
  draft.finding !== undefined &&
  (draft.finding.status === "deviation" || draft.finding.status === "missing");

function commentText(draft: Flagged): string {
  const { rule, finding } = draft;
  const body = finding.comment === "" ? finding.explanation : finding.comment;
  let text = `[${rule.severity.toUpperCase()}] ${oneLine(rule.title)}\n${body}`;
  if (finding.status === "missing" && finding.suggestedClause !== null) {
    text += `\n\nSuggested clause:\n${finding.suggestedClause}`;
  }
  const wording = draft.blocked === undefined ? "" : (finding.proposed?.replacement.trim() ?? "");
  if (wording !== "") {
    text += `\n\nSuggested wording (could not be applied automatically): ${wording}`;
  }
  return text;
}

function toComment(draft: Flagged, index: ClauseIndex): Comment {
  const text = commentText(draft);
  const { anchor } = draft;
  if (anchor !== undefined && draft.blocked === undefined) {
    return { paragraphId: anchor.paragraphId, start: anchor.start, end: anchor.end, text };
  }
  const named = draft.finding.clauseIds
    .map((id) => index.byId.get(id))
    .find((c) => c !== undefined);
  const paragraphId = (named ?? index.anchor).paragraphs[0]?.id;
  if (paragraphId === undefined) {
    throw new ReviewError("The document has no paragraph to comment on.");
  }
  return { paragraphId, text };
}

const errorLabel = (error: unknown): string => {
  const label = error instanceof Error ? safeLabel(error.name) : undefined;
  return label === undefined ? "" : ` (${label})`;
};

/**
 * Writes every edit and comment in one call. Only the redline engine knows which edits it
 * refuses, and a refused edit changes its comment: the comment moves to the clause and gains the
 * wording the lawyer would otherwise have to retype. So when an edit is refused the call is
 * repeated from the original bytes without it, until none is. Each repeat drops at least one edit,
 * so it ends, and in practice a refusal costs one more call.
 *
 * The review is paid for by now, so a writer that throws must not lose it. The edits are given up
 * first and the comments written alone; if even that throws, the original bytes go back unchanged.
 * Either way every finding is still in the report, and a warning says what the file lacks.
 */
async function writeRedline(args: {
  docx: Uint8Array;
  drafts: Draft[];
  index: ClauseIndex;
  options: ReviewOptions;
}): Promise<{ buffer: Uint8Array; warning: string | undefined }> {
  const { docx, drafts, index, options } = args;
  const flagged = drafts.filter(isFlagged);
  const redlineOptions = {
    author: options.author ?? DEFAULT_AUTHOR,
    ...(options.date === undefined ? {} : { date: options.date }),
  };

  const pass = async (): Promise<{ buffer: Uint8Array; refused: boolean }> => {
    const live = drafts.flatMap((draft) =>
      draft.anchor !== undefined && draft.blocked === undefined
        ? [{ draft, anchor: draft.anchor }]
        : [],
    );
    const edits: Edit[] = live.map(({ anchor }) => ({
      paragraphId: anchor.paragraphId,
      start: anchor.start,
      end: anchor.end,
      replacement: anchor.replacement,
    }));
    const comments = flagged.map((draft) => toComment(draft, index));
    const result = await applyRedline(docx, { edits, comments }, redlineOptions);

    let refused = false;
    live.forEach(({ draft }, i) => {
      const outcome = result.edits[i];
      if (outcome !== undefined && !outcome.applied) {
        draft.blocked = outcome.reason;
        refused = true;
      }
    });
    const touched = [...result.edits, ...result.comments].some((outcome) => outcome.applied);
    return { buffer: touched ? result.buffer : docx, refused };
  };

  const settled = async (): Promise<Uint8Array> => {
    for (;;) {
      const { buffer, refused } = await pass();
      if (!refused) return buffer;
    }
  };

  const giveUpEdits = (): void => {
    for (const draft of drafts) {
      if (draft.anchor !== undefined && draft.blocked === undefined) draft.blocked = UNSAFE_EDIT;
    }
  };

  try {
    return { buffer: await settled(), warning: undefined };
  } catch (failure) {
    giveUpEdits();
    try {
      return {
        buffer: await settled(),
        warning: `The Word file could not be edited with tracked changes${errorLabel(failure)}, so the suggested edits are written as comments and no text of the contract was changed.`,
      };
    } catch (second) {
      return {
        buffer: docx,
        warning: `The Word file could not be edited safely${errorLabel(second)}, so the redlined file is a copy of the original with no tracked changes and no comments. Every finding is in the report.`,
      };
    }
  }
}

function editOutcome(draft: Draft): EditOutcome {
  const proposed = draft.finding?.proposed ?? null;
  if (proposed === null) return { kind: "none" };
  const { anchor, blocked } = draft;
  if (anchor === undefined || blocked !== undefined) {
    return {
      kind: "comment-only",
      proposed: { ...proposed },
      reason: blocked ?? "the edit could not be matched to the document",
    };
  }
  return {
    kind: "applied",
    paragraphId: anchor.paragraphId,
    start: anchor.start,
    end: anchor.end,
    original: anchor.original,
    replacement: anchor.replacement,
  };
}

function toResult(draft: Draft): RuleResult {
  const { rule, finding } = draft;
  const base = {
    ruleId: rule.id,
    title: rule.title,
    severity: rule.severity,
    required: rule.required,
  };
  if (finding === undefined) {
    return {
      ...base,
      status: "error",
      clauseIds: [],
      clauseNumbers: [],
      explanation: "",
      comment: "",
      suggestedClause: null,
      edit: { kind: "none" },
      error: draft.error ?? "The rule was not checked.",
    };
  }
  return {
    ...base,
    status: finding.status,
    clauseIds: finding.clauseIds,
    clauseNumbers: finding.clauseNumbers,
    explanation: finding.explanation,
    comment: finding.comment,
    suggestedClause: finding.suggestedClause,
    edit: editOutcome(draft),
  };
}

// ---------------------------------------------------------------------------------------------
// What the file holds that the review did not show
// ---------------------------------------------------------------------------------------------

const count = (n: number, singular: string, plural = `${singular}s`): string =>
  `${n} ${n === 1 ? singular : plural}`;

// Only counts, never text: a warning is shown and logged like any other part of the report.
function notShownWarnings(seen: DocxInspection): string[] {
  const warnings: string[] = [];
  const tracked = seen.trackedInsertions + seen.trackedDeletions;
  if (tracked > 0) {
    warnings.push(
      `The document has ${count(tracked, "tracked change")} (${count(seen.trackedInsertions, "insertion")}, ${count(seen.trackedDeletions, "deletion")}). The review saw the document with all of them accepted, so deleted text was not shown to the model and inserted text was treated as agreed.`,
    );
  }
  if (seen.comments > 0) {
    warnings.push(
      `The document has ${count(seen.comments, "existing comment")}, which the model did not see.`,
    );
  }
  if (seen.footnotes > 0) {
    warnings.push(
      `The document has ${count(seen.footnotes, "footnote")}, which the model did not see.`,
    );
  }
  if (seen.endnotes > 0) {
    warnings.push(
      `The document has ${count(seen.endnotes, "endnote")}, which the model did not see.`,
    );
  }
  if (seen.headerFooterParts > 0) {
    warnings.push(
      `The document has ${count(seen.headerFooterParts, "header or footer part")} with text, which the model did not see.`,
    );
  }
  if (seen.hiddenRuns > 0) {
    warnings.push(
      `The document has ${count(seen.hiddenRuns, "run")} of hidden text that was not shown to the model.`,
    );
  }
  return warnings;
}

async function inspect(docx: Uint8Array): Promise<DocxInspection | undefined> {
  try {
    return await inspectDocx(docx);
  } catch {
    // What the file holds besides its text is a courtesy to the lawyer. The review can go on.
    return undefined;
  }
}

const reviewableChars = (clauses: Clause[]): number =>
  clauses.reduce(
    (sum, clause) => sum + clause.paragraphs.reduce((n, p) => n + p.text.trim().length, 0),
    0,
  );

// A scan has pictures where the text should be, and a review of the few words OCR left would call
// every required clause missing. Better to say what the file is than to report that.
function noTextError(chars: number, images: number): ReviewError {
  const scan =
    images > 0
      ? ` It holds ${count(images, "picture")}, so it may be a scan. Run OCR (text recognition) on it first and review the result.`
      : "";
  return new ReviewError(
    chars === 0
      ? `The document has no reviewable clauses: it has almost no text, none outside headings and signature lines.${scan}`
      : `The document has almost no text to review: only ${count(chars, "character")} outside headings and signature lines.${scan}`,
  );
}

// ---------------------------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------------------------

export async function reviewContract(
  input: { docx: Uint8Array; playbook: Playbook; fileName?: string },
  generator: ObjectGenerator,
  options: ReviewOptions = {},
): Promise<{ report: ReviewReport; redlined: Uint8Array }> {
  const { docx, playbook } = input;
  options.signal?.throwIfAborted();

  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new ReviewError("The concurrency option must be a whole number of at least 1.");
  }
  const { maxContextTokens } = options;
  if (maxContextTokens !== undefined && !(maxContextTokens > 0)) {
    throw new ReviewError("The maxContextTokens option must be a number above 0.");
  }
  if (playbook.rules.length === 0) throw new ReviewError("The playbook has no rules to check.");

  const parsed = await parseDocx(docx);
  const clauses = segment(parsed.paragraphs);
  const inspection = await inspect(docx);
  const images = inspection?.images ?? 0;
  const chars = reviewableChars(clauses);
  const [first] = clauses;
  if (first === undefined || chars < MIN_REVIEWABLE_CHARS) throw noTextError(chars, images);

  const warnings: string[] = [];
  if (images >= SCAN_MIN_IMAGES && chars < SCAN_MAX_CHARS) {
    warnings.push(
      `The document holds ${count(images, "picture")} and only ${count(chars, "character")} of reviewable text, so it may be a scan or may keep terms in pictures. Only the text was reviewed.`,
    );
  }

  const trimmedClient = options.client?.trim();
  const client = trimmedClient === "" ? undefined : trimmedClient;
  const plan = planWindows(playbook, clauses, maxContextTokens, client);
  const { windows } = plan;
  warnings.push(...plan.warnings);
  if (inspection !== undefined) warnings.push(...notShownWarnings(inspection));

  const labels = new Map(
    parsed.paragraphs.flatMap((p) => (p.label === undefined ? [] : [[p.id, p.label] as const])),
  );
  const index = indexClauses(clauses, pickAnchor(first, clauses, labels));

  options.onProgress?.({
    type: "start",
    rules: playbook.rules.length,
    clauses: clauses.length,
    windows: windows.length,
  });
  const verdicts = await runChecks({
    playbook,
    windows,
    index,
    generator,
    options,
    client,
    concurrency,
  });

  const drafts: Draft[] = playbook.rules.map((rule, i) => {
    const verdict = verdicts[i];
    return {
      rule,
      finding: verdict?.kind === "finding" ? verdict.finding : undefined,
      error: verdict?.kind === "error" ? verdict.message : undefined,
      anchor: undefined,
      blocked: undefined,
    };
  });

  // Anchored against every clause, not just the window the model saw: the edit names its clause
  // by id, and the guard that decides whether text may change must see the whole document.
  for (const draft of drafts) {
    const proposed = draft.finding?.proposed;
    if (proposed === undefined || proposed === null) continue;
    const anchored = anchorEdit(clauses, proposed);
    if (anchored.ok) draft.anchor = anchored;
    else draft.blocked = anchored.reason;
  }

  const written = await writeRedline({ docx, drafts, index, options });
  if (written.warning !== undefined) warnings.push(written.warning);
  const results = drafts.map(toResult);

  const counts: Record<RuleStatus, number> = {
    compliant: 0,
    deviation: 0,
    missing: 0,
    not_applicable: 0,
    error: 0,
  };
  const open: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  let editsApplied = 0;
  for (const result of results) {
    counts[result.status] += 1;
    if (result.status === "deviation" || result.status === "missing") open[result.severity] += 1;
    if (result.edit.kind === "applied") editsApplied += 1;
  }

  const report: ReviewReport = {
    document: input.fileName,
    playbook: { name: playbook.name, contractTypes: [...playbook.contractTypes] },
    model: {
      provider: generator.provider,
      model: generator.model,
      disclosure: generator.disclosure,
    },
    counts,
    open,
    results,
    ...(warnings.length === 0 ? {} : { warnings }),
    ...(inspection === undefined
      ? {}
      : {
          notShown: {
            trackedInsertions: inspection.trackedInsertions,
            trackedDeletions: inspection.trackedDeletions,
            comments: inspection.comments,
            footnotes: inspection.footnotes,
            endnotes: inspection.endnotes,
            headerFooterParts: inspection.headerFooterParts,
            hiddenRuns: inspection.hiddenRuns,
            images: inspection.images,
          },
        }),
    stats: {
      paragraphs: parsed.paragraphs.length,
      clauses: clauses.length,
      windows: windows.length,
      editsApplied,
    },
  };
  return { report, redlined: written.buffer };
}
