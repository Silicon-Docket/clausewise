import { STATUSES } from "../contracts.js";
import { canonicalJson } from "../canonical.js";
import { newId } from "../ids.js";
import { assertCount, assertSha256, cleanLabel, type Ctx } from "./context.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import type { MattersApi } from "./repo-matters.js";
import type { PlaybooksApi } from "./repo-playbooks.js";
import type { RunsApi } from "./repo-runs.js";
import type { EvalDatasetRow, EvalRunRow, EvalSlotResultRow } from "./types.js";

interface RawDataset {
  id: string;
  label: string;
  dev_sha256: string;
  heldout_sha256: string;
  created_at: string;
}
interface RawEvalRun {
  id: string;
  dataset_id: string;
  split: EvalRunRow["split"];
  workflow_version_id: string;
  playbook_version_id: string;
  model: string;
  repeats: number;
  price_table_sha256: string;
  results_path: string;
  started_at: string;
  finished_at: string | null;
}
interface RawSlot {
  eval_run_id: string;
  case_key: string;
  rule_key: string;
  repeat: number;
  run_id: string;
  expected_status: string;
  got_status: string;
  scores_json: string;
}

const toDataset = (r: RawDataset): EvalDatasetRow => ({
  id: r.id,
  label: r.label,
  devSha256: r.dev_sha256,
  heldoutSha256: r.heldout_sha256,
  createdAt: r.created_at,
});
const toEvalRun = (r: RawEvalRun): EvalRunRow => ({
  id: r.id,
  datasetId: r.dataset_id,
  split: r.split,
  workflowVersionId: r.workflow_version_id,
  playbookVersionId: r.playbook_version_id,
  model: r.model,
  repeats: r.repeats,
  priceTableSha256: r.price_table_sha256,
  resultsPath: r.results_path,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});
const toSlot = (r: RawSlot): EvalSlotResultRow => ({
  evalRunId: r.eval_run_id,
  caseKey: r.case_key,
  ruleKey: r.rule_key,
  repeat: r.repeat,
  runId: r.run_id,
  expectedStatus: r.expected_status,
  gotStatus: r.got_status,
  scores: JSON.parse(r.scores_json) as Record<string, unknown>,
});

/**
 * The evaluation tables: datasets, runs and per-slot results. Results can only be recorded for a run
 * of a synthetic matter (docs/parol/06, "Evaluation results ... Any non-synthetic matter (the
 * runner refuses)"); a trigger in 002 refuses it at the database as well.
 */
export function createEvalApi(
  ctx: Ctx,
  matters: MattersApi,
  playbooks: PlaybooksApi,
  runs: RunsApi,
) {
  const { get, all, run, tx } = ctx;
  const { requireMatter } = matters.internal;

  const getEvalDataset = (id: string): EvalDatasetRow | undefined => {
    const row = get<RawDataset>("SELECT * FROM eval_datasets WHERE id = ?", id);
    return row ? toDataset(row) : undefined;
  };
  const listEvalDatasets = (): EvalDatasetRow[] =>
    all<RawDataset>("SELECT * FROM eval_datasets ORDER BY created_at, rowid").map(toDataset);

  function createEvalDataset(input: { label: string; devSha256: string; heldoutSha256: string }): EvalDatasetRow {
    const label = cleanLabel("dataset label", input.label, 100);
    assertSha256("devSha256", input.devSha256);
    assertSha256("heldoutSha256", input.heldoutSha256);
    return tx(() => {
      const id = newId("eds");
      run(
        "INSERT INTO eval_datasets (id, label, dev_sha256, heldout_sha256, created_at) VALUES (?, ?, ?, ?, ?)",
        id,
        label,
        input.devSha256,
        input.heldoutSha256,
        ctx.now(),
      );
      return getEvalDataset(id) as EvalDatasetRow;
    });
  }

  const getEvalRun = (id: string): EvalRunRow | undefined => {
    const row = get<RawEvalRun>("SELECT * FROM eval_runs WHERE id = ?", id);
    return row ? toEvalRun(row) : undefined;
  };
  const listEvalRuns = (datasetId?: string): EvalRunRow[] =>
    all<RawEvalRun>(
      "SELECT * FROM eval_runs WHERE (?1 IS NULL OR dataset_id = ?1) ORDER BY started_at, rowid",
      datasetId ?? null,
    ).map(toEvalRun);

  function createEvalRun(
    input: {
      datasetId: string;
      split: EvalRunRow["split"];
      workflowVersionId: string;
      playbookVersionId: string;
      model: string;
      repeats: number;
      priceTableSha256: string;
      resultsPath: string;
    },
    opts: { actorId: string | null },
  ): EvalRunRow {
    if (!["dev", "heldout", "calibration"].includes(input.split))
      throw new ValidationError("bad_split", "split must be dev, heldout or calibration");
    assertCount("repeats", input.repeats, 1);
    assertSha256("priceTableSha256", input.priceTableSha256);
    const model = cleanLabel("model", input.model, 200);
    const resultsPath = cleanLabel("results path", input.resultsPath, 200);
    return tx(() => {
      if (!getEvalDataset(input.datasetId)) throw new NotFoundError("eval dataset", input.datasetId);
      if (!playbooks.getWorkflowVersion(input.workflowVersionId))
        throw new NotFoundError("workflow version", input.workflowVersionId);
      if (!playbooks.getPlaybookVersion(input.playbookVersionId))
        throw new NotFoundError("playbook version", input.playbookVersionId);
      const id = newId("evr");
      run(
        `INSERT INTO eval_runs
           (id, dataset_id, split, workflow_version_id, playbook_version_id, model, repeats,
            price_table_sha256, results_path, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        id,
        input.datasetId,
        input.split,
        input.workflowVersionId,
        input.playbookVersionId,
        model,
        input.repeats,
        input.priceTableSha256,
        resultsPath,
        ctx.now(),
      );
      ctx.audit({
        actorId: opts.actorId,
        matterId: null,
        action: "eval.record",
        targetType: "eval_run",
        targetId: id,
        detail: {
          datasetId: input.datasetId,
          split: input.split,
          workflowVersionId: input.workflowVersionId,
          playbookVersionId: input.playbookVersionId,
          repeats: input.repeats,
        },
      });
      return getEvalRun(id) as EvalRunRow;
    });
  }

  function finishEvalRun(evalRunId: string, opts: { actorId: string | null }): EvalRunRow {
    return tx(() => {
      const existing = getEvalRun(evalRunId);
      if (!existing) throw new NotFoundError("eval run", evalRunId);
      if (existing.finishedAt !== null) return existing;
      run("UPDATE eval_runs SET finished_at = ? WHERE id = ?", ctx.now(), evalRunId);
      ctx.audit({
        actorId: opts.actorId,
        matterId: null,
        action: "eval.record",
        targetType: "eval_run",
        targetId: evalRunId,
        detail: { finished: true },
      });
      return getEvalRun(evalRunId) as EvalRunRow;
    });
  }

  /** `matterId` is the synthetic matter the run belongs to; a run of another matter is not found. */
  function recordEvalSlotResult(
    matterId: string,
    input: {
      evalRunId: string;
      caseKey: string;
      ruleKey: string;
      repeat: number;
      runId: string;
      expectedStatus: string;
      gotStatus: string;
      scores: Record<string, unknown>;
    },
    opts: { actorId: string | null },
  ): EvalSlotResultRow {
    const caseKey = cleanLabel("case key", input.caseKey, 64);
    const ruleKey = cleanLabel("rule key", input.ruleKey, 64);
    assertCount("repeat", input.repeat, 0);
    for (const status of [input.expectedStatus, input.gotStatus])
      if (!(STATUSES as readonly string[]).includes(status))
        throw new ValidationError("bad_status", "slot statuses must be finding statuses");
    let scoresJson: string;
    try {
      scoresJson = canonicalJson(input.scores);
    } catch {
      throw new ValidationError("bad_scores", "scores must be JSON");
    }
    return tx(() => {
      const matter = requireMatter(matterId);
      if (!matter.synthetic)
        throw new ValidationError("not_synthetic", "evaluation results are recorded for synthetic matters only");
      runs.internal.requireRun(matterId, input.runId);
      if (!getEvalRun(input.evalRunId)) throw new NotFoundError("eval run", input.evalRunId);
      if (
        get<{ n: number }>(
          "SELECT 1 AS n FROM eval_slot_results WHERE eval_run_id = ? AND case_key = ? AND rule_key = ? AND repeat = ?",
          input.evalRunId,
          caseKey,
          ruleKey,
          input.repeat,
        )
      )
        throw new ConflictError("slot_exists", `eval run ${input.evalRunId} already has a result for this slot`);
      run(
        `INSERT INTO eval_slot_results
           (eval_run_id, case_key, rule_key, repeat, run_id, expected_status, got_status, scores_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.evalRunId,
        caseKey,
        ruleKey,
        input.repeat,
        input.runId,
        input.expectedStatus,
        input.gotStatus,
        scoresJson,
      );
      ctx.audit({
        actorId: opts.actorId,
        matterId,
        action: "eval.record",
        targetType: "eval_run",
        targetId: input.evalRunId,
        detail: { caseKey, ruleKey, repeat: input.repeat, runId: input.runId, matched: input.expectedStatus === input.gotStatus },
      });
      return toSlot(
        get<RawSlot>(
          "SELECT * FROM eval_slot_results WHERE eval_run_id = ? AND case_key = ? AND rule_key = ? AND repeat = ?",
          input.evalRunId,
          caseKey,
          ruleKey,
          input.repeat,
        ) as RawSlot,
      );
    });
  }

  const listEvalSlotResults = (evalRunId: string): EvalSlotResultRow[] =>
    all<RawSlot>(
      "SELECT * FROM eval_slot_results WHERE eval_run_id = ? ORDER BY case_key, rule_key, repeat",
      evalRunId,
    ).map(toSlot);

  return {
    createEvalDataset,
    getEvalDataset,
    listEvalDatasets,
    createEvalRun,
    finishEvalRun,
    getEvalRun,
    listEvalRuns,
    recordEvalSlotResult,
    listEvalSlotResults,
  };
}

export type EvalApi = ReturnType<typeof createEvalApi>;
