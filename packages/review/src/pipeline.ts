import { applyRedline, parseDocx, type Comment, type Edit } from "@clausewise/docx";
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
import { buildRulePrompt, estimateTokens, mergeWindowChecks, windowClauses } from "./prompt.js";
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
// These statuses mean the key, its permissions or the model name is wrong, so every other call
// would fail the same way and there is no point in sending them.
const FATAL_STATUSES = new Set([401, 403, 404]);

// ---------------------------------------------------------------------------------------------
// What one model call can come to
// ---------------------------------------------------------------------------------------------

// A failure keeps only what is safe to show. Provider and SDK messages can quote the prompt or
// the model's reply, and both hold contract text.
type Failure =
  | { kind: "refusal"; category: string | undefined }
  | { kind: "output" }
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
  if (error instanceof ModelOutputError) return { kind: "output" };
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
      return "The model did not return an answer in the expected format for this rule.";
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

function fatalStatus(error: unknown): number | undefined {
  if (!(error instanceof ModelRequestError)) return undefined;
  const status = error.statusCode;
  return status !== undefined && FATAL_STATUSES.has(status) ? status : undefined;
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

// The playbook, not the model, decides whether a clause that is absent matters.
function settledStatus(rule: Rule, status: RuleCheck["status"]): Finding["status"] {
  if (status === "missing" && !rule.required) return "not_applicable";
  if (status === "not_applicable" && rule.required) return "missing";
  return status;
}

function normalize(rule: Rule, check: RuleCheck, byId: Map<string, Clause>): Finding {
  const status = settledStatus(rule, check.status);
  const clauseIds = unique(check.clauseIds.filter((id) => byId.has(id)));
  const clauseNumbers = unique(
    clauseIds.flatMap((id) => {
      const number = byId.get(id)?.number;
      return number === undefined ? [] : [number];
    }),
  );

  const explanation = check.explanation.trim();
  const suggested = status === "missing" ? (check.suggestedClause?.trim() ?? "") : "";
  const flagged = status === "deviation" || status === "missing";
  return {
    status,
    clauseIds,
    clauseNumbers,
    explanation: explanation === "" ? fallbackExplanation(rule, status) : explanation,
    comment: flagged ? check.comment.trim() : "",
    suggestedClause: suggested === "" ? null : suggested,
    proposed: status === "deviation" && check.edit !== null ? { ...check.edit } : null,
  };
}

function judge(
  rule: Rule,
  outcomes: (CallOutcome | undefined)[],
  windowCount: number,
  byId: Map<string, Clause>,
): Verdict {
  const checks: RuleCheck[] = [];
  const failures: Failure[] = [];
  for (const outcome of outcomes) {
    if (outcome === undefined) continue;
    if (outcome.ok) checks.push(outcome.check);
    else failures.push(outcome.failure);
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
  return { kind: "finding", finding: normalize(rule, merged, byId) };
}

// ---------------------------------------------------------------------------------------------
// Windows and model calls
// ---------------------------------------------------------------------------------------------

function planWindows(
  playbook: Playbook,
  clauses: Clause[],
  maxContextTokens: number | undefined,
): Clause[][] {
  if (maxContextTokens === undefined) return [clauses];
  // With no clauses the prompt is the playbook preamble and the rule block, which is what every
  // window has to carry on top of its clauses.
  const empty = playbook.rules.map((rule) => buildRulePrompt({ playbook, rule, clauses: [] }));
  const system = empty[0]?.system ?? "";
  const largestRule = Math.max(...empty.map((built) => estimateTokens(built.prompt)));
  return windowClauses(clauses, {
    maxTokens: maxContextTokens,
    reservedTokens: estimateTokens(system) + largestRule + OUTPUT_SLACK_TOKENS,
    overlap: WINDOW_OVERLAP,
  });
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
    : { ok: false, failure: { kind: "output" } };
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
  byId: Map<string, Clause>;
  generator: ObjectGenerator;
  options: ReviewOptions;
  concurrency: number;
}): Promise<Verdict[]> {
  const { playbook, windows, byId, generator, options } = args;
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

  const settle = (run: RuleRun, w: number, outcome: CallOutcome): void => {
    run.outcomes[w] = outcome;
    run.remaining -= 1;
    if (run.remaining > 0 || state.stopped) return;
    const verdict = judge(run.rule, run.outcomes, windows.length, byId);
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
    const window = windows[w];
    if (state.stopped || window === undefined) return;
    const { system, prompt, sharedPrefix } = buildRulePrompt({
      playbook,
      rule: run.rule,
      clauses: window,
    });
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
      const status = fatalStatus(error);
      if (status !== undefined) {
        halt(
          new ReviewError(
            `The model provider answered HTTP ${status}, so no rule can be checked. ` +
              `Check the API key, its permissions and the model name (${generator.model}).`,
          ),
        );
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

  const jobs: Promise<void>[] = [];
  if (generator.cachesSharedPrefix === true) {
    // A cache entry can be read only once the first response has started, so the first rule's
    // call goes alone. Only individual calls take a slot, never the code that waits for one, so
    // this cannot hold every slot while it waits for another.
    const [first, ...rest] = runs;
    windows.forEach((_, w) => {
      jobs.push(
        (async () => {
          if (first === undefined) return;
          await limit(() => check(first, w));
          await Promise.all(rest.map((run) => limit(() => check(run, w))));
        })(),
      );
    });
  } else {
    for (const run of runs) {
      windows.forEach((_, w) => jobs.push(limit(() => check(run, w))));
    }
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

function toComment(draft: Flagged, clauses: Clause[], byId: Map<string, Clause>): Comment {
  const text = commentText(draft);
  const { anchor } = draft;
  if (anchor !== undefined && draft.blocked === undefined) {
    return { paragraphId: anchor.paragraphId, start: anchor.start, end: anchor.end, text };
  }
  const named = draft.finding.clauseIds.map((id) => byId.get(id)).find((c) => c !== undefined);
  const paragraphId = (named ?? clauses[0])?.paragraphs[0]?.id;
  if (paragraphId === undefined) {
    throw new ReviewError("The document has no paragraph to comment on.");
  }
  return { paragraphId, text };
}

/**
 * Writes every edit and comment in one call. Only the redline engine knows which edits it
 * refuses, and a refused edit changes its comment: the comment moves to the clause and gains the
 * wording the lawyer would otherwise have to retype. So when an edit is refused the call is
 * repeated from the original bytes without it, until none is. Each repeat drops at least one edit,
 * so it ends, and in practice a refusal costs one more call.
 */
async function writeRedline(args: {
  docx: Uint8Array;
  drafts: Draft[];
  clauses: Clause[];
  byId: Map<string, Clause>;
  options: ReviewOptions;
}): Promise<Uint8Array> {
  const { docx, drafts, clauses, byId, options } = args;
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
    const comments = flagged.map((draft) => toComment(draft, clauses, byId));
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

  for (;;) {
    const { buffer, refused } = await pass();
    if (!refused) return buffer;
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
  if (clauses.length === 0) {
    throw new ReviewError(
      "The document has no reviewable clauses: it has no paragraphs of text other than headings and signature lines.",
    );
  }
  const byId = new Map(clauses.map((clause) => [clause.id, clause]));
  const windows = planWindows(playbook, clauses, maxContextTokens);

  options.onProgress?.({
    type: "start",
    rules: playbook.rules.length,
    clauses: clauses.length,
    windows: windows.length,
  });
  const verdicts = await runChecks({ playbook, windows, byId, generator, options, concurrency });

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

  const redlined = await writeRedline({ docx, drafts, clauses, byId, options });
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
    stats: {
      paragraphs: parsed.paragraphs.length,
      clauses: clauses.length,
      windows: windows.length,
      editsApplied,
    },
  };
  return { report, redlined };
}
