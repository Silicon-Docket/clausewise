import { readFile } from "node:fs/promises";
import { z } from "zod";
import { EvalError } from "./errors.js";
import type { EvalResult } from "./result.js";

// Only what a comparison reads is checked, so a file from a newer harness that adds fields still
// compares.
const PreviousSchema = z.object({
  schemaVersion: z.literal(1),
  selftest: z.boolean(),
  startedAt: z.string(),
  model: z.object({ provider: z.string(), model: z.string() }),
  score: z.object({
    accuracy: z.number().nullable(),
    flag: z.object({ f1: z.number().nullable() }),
    rules: z.array(
      z.object({
        fixture: z.string(),
        ruleId: z.string(),
        expected: z.string(),
        modal: z.string(),
        accuracy: z.number(),
      }),
    ),
  }),
});

export type Previous = z.infer<typeof PreviousSchema>;

export async function loadPrevious(path: string): Promise<Previous> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const why =
      error instanceof SyntaxError ? "it is not valid JSON" : (code ?? "it cannot be read");
    throw new EvalError(`Cannot compare with ${path}: ${why}.`);
  }
  const parsed = PreviousSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where =
      first === undefined
        ? ""
        : ` The first problem is at ${first.path.join(".") || "the top"}: ${first.message}`;
    throw new EvalError(
      `Cannot compare with ${path}: it is not a results file this harness wrote (schema version 1).${where}`,
    );
  }
  return parsed.data;
}

export interface RuleChange {
  fixture: string;
  ruleId: string;
  expected: string;
  before: { status: string; accuracy: number };
  after: { status: string; accuracy: number };
}

export interface Comparison {
  previous: { startedAt: string; provider: string; model: string; selftest: boolean };
  /** The earlier run's figures, as fractions. */
  before: { accuracy: number | null; f1: number | null };
  /** Percentage points as a fraction: 0.05 is five points. Null when either side has no figure. */
  accuracyDelta: number | null;
  f1Delta: number | null;
  /** Rules that are right less often than before. */
  regressions: RuleChange[];
  /** Rules that are right more often than before. */
  improvements: RuleChange[];
  /** Rules that are right as often as before but now give a different (equally wrong) status. */
  changed: RuleChange[];
  /** Rules whose expected status is not the one the earlier run was scored against. */
  relabelled: RuleChange[];
  unchanged: number;
  /** Rules this run scored that the earlier run did not, and the other way round. */
  onlyNow: number;
  onlyBefore: number;
}

const key = (fixture: string, ruleId: string): string => `${fixture}\u0000${ruleId}`;
const delta = (now: number | null, before: number | null): number | null =>
  now === null || before === null ? null : now - before;

/** Regressions come first because they are what a change to a prompt or a model can break. */
export function compareResults(previous: Previous, current: EvalResult): Comparison {
  const before = new Map(
    previous.score.rules.map((rule) => [key(rule.fixture, rule.ruleId), rule]),
  );
  const regressions: RuleChange[] = [];
  const improvements: RuleChange[] = [];
  const changed: RuleChange[] = [];
  const relabelled: RuleChange[] = [];
  let unchanged = 0;
  let onlyNow = 0;

  for (const rule of current.score.rules) {
    const old = before.get(key(rule.fixture, rule.ruleId));
    if (old === undefined) {
      onlyNow += 1;
      continue;
    }
    before.delete(key(rule.fixture, rule.ruleId));
    const change: RuleChange = {
      fixture: rule.fixture,
      ruleId: rule.ruleId,
      expected: rule.expected,
      before: { status: old.modal, accuracy: old.accuracy },
      after: { status: rule.modal, accuracy: rule.accuracy },
    };
    // Accuracy against a different answer key says nothing about the model or the prompt.
    if (old.expected !== rule.expected) relabelled.push(change);
    else if (rule.accuracy < old.accuracy) regressions.push(change);
    else if (rule.accuracy > old.accuracy) improvements.push(change);
    else if (rule.modal !== old.modal) changed.push(change);
    else unchanged += 1;
  }

  return {
    previous: {
      startedAt: previous.startedAt,
      provider: previous.model.provider,
      model: previous.model.model,
      selftest: previous.selftest,
    },
    before: { accuracy: previous.score.accuracy, f1: previous.score.flag.f1 },
    accuracyDelta: delta(current.score.accuracy, previous.score.accuracy),
    f1Delta: delta(current.score.flag.f1, previous.score.flag.f1),
    regressions,
    improvements,
    changed,
    relabelled,
    unchanged,
    onlyNow,
    onlyBefore: before.size,
  };
}
