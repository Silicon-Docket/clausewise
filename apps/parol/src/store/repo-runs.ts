import type { CallRecord, RunManifest, RunStatus } from "../contracts.js";
import { canonicalJson, hashOf, sha256Hex } from "../canonical.js";
import { newId } from "../ids.js";
import { assertShortCode, assertSha256, parseWith, type Ctx } from "./context.js";
import {
  ActiveRunError,
  ConflictError,
  InputsIncompleteError,
  InvalidTransitionError,
  NotFoundError,
  StaleRunError,
  ValidationError,
} from "./errors.js";
import { inputsDigestOf, type MattersApi } from "./repo-matters.js";
import type { PlaybooksApi } from "./repo-playbooks.js";
import { CallRecordSchema, RunManifestSchema } from "./schemas.js";
import { canRunTransition, isTerminalRunStatus } from "./states.js";
import type { ModelCallRow, RunRow, RunStageRow } from "./types.js";

interface RawRun {
  id: string;
  matter_id: string;
  workflow_version_id: string;
  playbook_version_id: string;
  model_provider: string;
  model_requested: string;
  model_reported: string | null;
  input_manifest_json: string;
  input_manifest_sha256: string;
  inputs_sha256: string;
  purpose: "matter" | "eval";
  status: RunStatus;
  error_kind: string | null;
  started_by: string;
  started_at: string;
  finished_at: string | null;
}
interface RawStage {
  run_id: string;
  stage: string;
  unit: string;
  attempt: number;
  status: RunStageRow["status"];
  input_sha256: string;
  output_json: string | null;
  output_sha256: string | null;
  error_kind: string | null;
  started_at: string;
  finished_at: string | null;
}
interface RawModelCall {
  id: string;
  run_id: string;
  stage: string;
  rule_key: string | null;
  prompt_version_id: string;
  request_sha256: string;
  attempt: number;
  outcome: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  latency_ms: number;
  cost_usd_estimate: number | null;
  price_table_sha256: string | null;
}

const toRun = (r: RawRun): RunRow => ({
  id: r.id,
  matterId: r.matter_id,
  workflowVersionId: r.workflow_version_id,
  playbookVersionId: r.playbook_version_id,
  modelProvider: r.model_provider,
  modelRequested: r.model_requested,
  modelReported: r.model_reported,
  manifest: JSON.parse(r.input_manifest_json) as RunManifest,
  inputManifestJson: r.input_manifest_json,
  inputManifestSha256: r.input_manifest_sha256,
  inputsSha256: r.inputs_sha256,
  purpose: r.purpose,
  status: r.status,
  errorKind: r.error_kind,
  startedBy: r.started_by,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

const toStage = (r: RawStage): RunStageRow => ({
  runId: r.run_id,
  stage: r.stage,
  unit: r.unit,
  attempt: r.attempt,
  status: r.status,
  inputSha256: r.input_sha256,
  output: r.output_json === null ? null : (JSON.parse(r.output_json) as unknown),
  outputSha256: r.output_sha256,
  errorKind: r.error_kind,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

const toModelCall = (r: RawModelCall): ModelCallRow => ({
  id: r.id,
  runId: r.run_id,
  stage: r.stage,
  ruleKey: r.rule_key,
  promptVersionId: r.prompt_version_id,
  requestSha256: r.request_sha256,
  attempt: r.attempt,
  outcome: r.outcome,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  cacheReadTokens: r.cache_read_tokens,
  cacheWriteTokens: r.cache_write_tokens,
  latencyMs: r.latency_ms,
  costUsdEstimate: r.cost_usd_estimate,
  priceTableSha256: r.price_table_sha256,
});

const STAGE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const UNIT = /^(\*|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

export function createRunsApi(ctx: Ctx, matters: MattersApi, playbooks: PlaybooksApi) {
  const { get, all, run, tx } = ctx;
  const { requireMatter, requireUser, transitionMatter } = matters.internal;

  // --- reading ------------------------------------------------------------------------------

  const getRun = (matterId: string, runId: string): RunRow | undefined => {
    const row = get<RawRun>("SELECT * FROM runs WHERE id = ? AND matter_id = ?", runId, matterId);
    return row ? toRun(row) : undefined;
  };
  const requireRun = (matterId: string, runId: string): RunRow => {
    const found = getRun(matterId, runId);
    if (!found) throw new NotFoundError("run", runId);
    return found;
  };
  /** Newest first. */
  const listRunsForMatter = (matterId: string): RunRow[] =>
    all<RawRun>("SELECT * FROM runs WHERE matter_id = ? ORDER BY started_at DESC, rowid DESC", matterId).map(
      toRun,
    );
  const getActiveRun = (matterId: string): RunRow | undefined => {
    const row = get<RawRun>(
      `SELECT * FROM runs
       WHERE matter_id = ? AND status IN ('queued','ingesting','extracting','retrieving','analyzing','verifying')`,
      matterId,
    );
    return row ? toRun(row) : undefined;
  };
  /** The newest succeeded run whose inputs are still the matter's. Undefined when none is. */
  const getCurrentRun = (matterId: string): RunRow | undefined => {
    const digest = matters.computeInputsDigest(matterId);
    if (digest === null) return undefined;
    const row = get<RawRun>(
      `SELECT * FROM runs
       WHERE matter_id = ? AND status = 'succeeded' AND inputs_sha256 = ?
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      matterId,
      digest,
    );
    return row ? toRun(row) : undefined;
  };

  // --- manifest and creation ----------------------------------------------------------------

  /**
   * Builds the manifest for a run from what the database holds now: the matter's client name, the
   * operative version of every document in ordinal order, the pinned playbook and the chosen
   * workflow and model. The runner passes it to `createRun` unchanged, so a manifest is never
   * assembled from request data.
   */
  function buildRunManifest(
    matterId: string,
    opts: { workflowVersionId: string; modelProvider: string; model: string },
  ): RunManifest {
    const matter = requireMatter(matterId);
    if (matters.computeInputsDigest(matterId) === null || matter.playbookVersionId === null)
      throw new InputsIncompleteError(matterId);
    const playbook = playbooks.getPlaybookVersion(matter.playbookVersionId);
    if (!playbook) throw new NotFoundError("playbook version", matter.playbookVersionId);
    const workflow = playbooks.getWorkflowVersion(opts.workflowVersionId);
    if (!workflow) throw new NotFoundError("workflow version", opts.workflowVersionId);
    return {
      matterId,
      clientLegalName: matter.clientLegalName,
      documents: matters.listOperativeDocuments(matterId).map(({ document, version }) => ({
        documentVersionId: version.id,
        label: document.label,
        kind: document.kind,
        title: document.title,
        versionNo: version.versionNo,
        statedDate: version.statedDate,
        textSha256: version.textSha256,
      })),
      playbook: {
        versionId: playbook.id,
        slug: playbook.slug,
        version: playbook.version,
        sha256: playbook.sha256,
      },
      workflow: { versionId: workflow.id, label: workflow.label, sha256: workflow.sha256 },
      model: { provider: opts.modelProvider, model: opts.model },
    };
  }

  /**
   * Starts a run: records the manifest, its hash and the inputs digest it was built on, and moves
   * the matter to `running`. Refused when the inputs are incomplete (`InputsIncompleteError`), when
   * the manifest was built on inputs that have since changed (`StaleRunError`), when the matter is
   * not `ready` or `stale`, and when a run is already in flight (`ActiveRunError`).
   */
  function createRun(
    matterId: string,
    input: {
      manifest: RunManifest;
      startedBy: string;
      purpose?: "matter" | "eval";
      /** Optional: checked against the hash of the manifest, never trusted in its place. */
      manifestSha256?: string;
      /** Optional: checked against the matter's current digest. */
      inputsSha256?: string;
    },
  ): RunRow {
    const manifest = parseWith(RunManifestSchema, input.manifest, "run manifest");
    const manifestSha256 = hashOf(manifest);
    if (input.manifestSha256 !== undefined && input.manifestSha256 !== manifestSha256)
      throw new ValidationError("manifest_hash_mismatch", "manifest sha256 is not the hash of the manifest");
    if (input.inputsSha256 !== undefined) assertSha256("inputsSha256", input.inputsSha256);
    const purpose = input.purpose ?? "matter";
    if (purpose !== "matter" && purpose !== "eval")
      throw new ValidationError("bad_purpose", "purpose must be matter or eval");

    return tx(() => {
      const matter = requireMatter(matterId);
      requireUser(input.startedBy);
      if (manifest.matterId !== matterId)
        throw new ValidationError("manifest_matter", "manifest was built for a different matter");

      const digest = matters.computeInputsDigest(matterId);
      if (digest === null || matter.playbookVersionId === null)
        throw new InputsIncompleteError(matterId);
      const active = getActiveRun(matterId);
      if (active) throw new ActiveRunError(active.id);
      if (matter.status !== "ready" && matter.status !== "stale")
        throw new ConflictError(
          "matter_not_runnable",
          `matter ${matterId} is ${matter.status}; a run starts from ready or stale`,
        );

      // The manifest must describe the inputs the matter has now. Its own digest is compared first
      // so that a manifest built before an edit is reported as stale and not as malformed.
      const manifestDigest = inputsDigestOf({
        clientLegalName: manifest.clientLegalName,
        playbookSha256: manifest.playbook.sha256,
        documents: [...manifest.documents]
          .sort((a, b) => a.label.localeCompare(b.label))
          .map((d) => ({
            versionId: d.documentVersionId,
            textSha256: d.textSha256,
            statedDate: d.statedDate,
            kind: d.kind,
          })),
      });
      if (manifestDigest !== digest || (input.inputsSha256 !== undefined && input.inputsSha256 !== digest))
        throw new StaleRunError(null, "inputs_changed");

      const playbook = playbooks.getPlaybookVersion(matter.playbookVersionId);
      if (!playbook || playbook.status !== "approved")
        throw new ConflictError("playbook_not_approved", "the matter's playbook version is not approved");
      const workflow = playbooks.getWorkflowVersion(manifest.workflow.versionId);
      if (!workflow) throw new NotFoundError("workflow version", manifest.workflow.versionId);
      if (workflow.status === "retired")
        throw new ConflictError("workflow_retired", `workflow version ${workflow.id} is retired`);
      const expected = buildRunManifest(matterId, {
        workflowVersionId: workflow.id,
        modelProvider: manifest.model.provider,
        model: manifest.model.model,
      });
      if (hashOf(expected) !== manifestSha256)
        throw new ValidationError("manifest_mismatch", "manifest does not match the matter's inputs");

      const id = newId("run");
      run(
        `INSERT INTO runs
           (id, matter_id, workflow_version_id, playbook_version_id, model_provider, model_requested,
            model_reported, input_manifest_json, input_manifest_sha256, inputs_sha256, purpose, status,
            error_kind, started_by, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'queued', NULL, ?, ?, NULL)`,
        id,
        matterId,
        workflow.id,
        playbook.id,
        manifest.model.provider,
        manifest.model.model,
        canonicalJson(manifest),
        manifestSha256,
        digest,
        purpose,
        input.startedBy,
        ctx.now(),
      );
      transitionMatter(matterId, "running");
      ctx.audit({
        actorId: input.startedBy,
        matterId,
        action: "run.create",
        targetType: "run",
        targetId: id,
        detail: {
          workflowVersionId: workflow.id,
          playbookVersionId: playbook.id,
          manifestSha256,
          inputsSha256: digest,
          purpose,
        },
      });
      return requireRun(matterId, id);
    });
  }

  // --- status -------------------------------------------------------------------------------

  /**
   * Moves a run along its state machine and keeps the matter's status in step: `succeeded` takes a
   * running matter to `in_review`, `failed` or `cancelled` take it back to `ready`, and resuming a
   * failed run (`failed` to `queued`) takes it to `running` again.
   *
   * A superseded run throws `StaleRunError`: the inputs changed, so whoever is working on it must
   * stop. `superseded` itself is set only by `applyInputChange`.
   */
  function updateRunStatus(
    matterId: string,
    runId: string,
    to: RunStatus,
    opts: { errorKind?: string | null; modelReported?: string | null; actorId?: string | null } = {},
  ): RunRow {
    if (opts.errorKind !== undefined && opts.errorKind !== null)
      assertShortCode("errorKind", opts.errorKind);
    return tx(() => {
      const current = requireRun(matterId, runId);
      if (current.status === "superseded") throw new StaleRunError(runId, "superseded");
      if (to === "superseded") throw new InvalidTransitionError("run", current.status, to);
      if (!canRunTransition(current.status, to))
        throw new InvalidTransitionError("run", current.status, to);

      if (to === "queued") {
        // Resuming: only on the inputs the run was started on, and only if nothing else is running.
        const digest = matters.computeInputsDigest(matterId);
        if (digest === null || digest !== current.inputsSha256)
          throw new StaleRunError(runId, "inputs_changed");
        const active = getActiveRun(matterId);
        if (active) throw new ActiveRunError(active.id);
      }

      const now = ctx.now();
      const terminal = isTerminalRunStatus(to);
      const modelReported =
        opts.modelReported === undefined ? current.modelReported : opts.modelReported;
      run(
        `UPDATE runs SET status = ?, error_kind = ?, model_reported = ?, finished_at = ? WHERE id = ?`,
        to,
        to === "failed" ? (opts.errorKind ?? null) : null,
        modelReported,
        terminal ? now : null,
        runId,
      );
      if (to === "queued") {
        // The stage that failed gets a fresh attempt; the history of the failure stays on its row.
        const matter = requireMatter(matterId);
        if (matter.status !== "running") transitionMatter(matterId, "running");
      } else if (to === "succeeded") {
        if (requireMatter(matterId).status === "running") transitionMatter(matterId, "in_review");
      } else if (to === "failed" || to === "cancelled") {
        run(
          `UPDATE run_stages SET status = 'failed', error_kind = COALESCE(?, 'interrupted'), finished_at = ?
           WHERE run_id = ? AND status = 'running'`,
          to === "cancelled" ? "cancelled" : (opts.errorKind ?? null),
          now,
          runId,
        );
        if (requireMatter(matterId).status === "running") transitionMatter(matterId, "ready");
      }
      ctx.audit({
        actorId: opts.actorId ?? null,
        matterId,
        action: "run.status",
        targetType: "run",
        targetId: runId,
        detail: { from: current.status, to, errorKind: to === "failed" ? (opts.errorKind ?? null) : null },
      });
      return requireRun(matterId, runId);
    });
  }

  /**
   * Called once at boot, before the server accepts requests. Every run left in flight by the last
   * process becomes `failed` with `interrupted`, its matter returns to `ready`, and resume picks
   * it up by input hash. This is the one method that is not scoped to a matter: at boot there is no
   * request and no matter, only whatever a crash left behind.
   */
  function markInterruptedOnBoot(): { matterId: string; runId: string }[] {
    return tx(() => {
      const stuck = all<{ id: string; matter_id: string; status: RunStatus }>(
        `SELECT id, matter_id, status FROM runs
         WHERE status IN ('queued','ingesting','extracting','retrieving','analyzing','verifying')
         ORDER BY started_at, id`,
      );
      const now = ctx.now();
      for (const r of stuck) {
        run(
          "UPDATE runs SET status = 'failed', error_kind = 'interrupted', finished_at = ? WHERE id = ?",
          now,
          r.id,
        );
        run(
          `UPDATE run_stages SET status = 'failed', error_kind = 'interrupted', finished_at = ?
           WHERE run_id = ? AND status = 'running'`,
          now,
          r.id,
        );
        if (requireMatter(r.matter_id).status === "running") transitionMatter(r.matter_id, "ready");
        ctx.audit({
          actorId: null,
          matterId: r.matter_id,
          action: "run.status",
          targetType: "run",
          targetId: r.id,
          detail: { from: r.status, to: "failed", errorKind: "interrupted" },
        });
      }
      return stuck.map((r) => ({ matterId: r.matter_id, runId: r.id }));
    });
  }

  // --- stages -------------------------------------------------------------------------------

  /** A write for a run whose inputs have moved on must fail, so the stage stops spending money. */
  function requireWritableRun(matterId: string, runId: string): RunRow {
    const current = requireRun(matterId, runId);
    if (current.status === "superseded") throw new StaleRunError(runId, "superseded");
    return current;
  }

  function recordStageStart(
    matterId: string,
    runId: string,
    input: { stage: string; unit?: string; inputSha256: string },
  ): RunStageRow {
    const unit = input.unit ?? "*";
    if (!STAGE_NAME.test(input.stage))
      throw new ValidationError("bad_stage", "stage must be a short lower-case name");
    if (!UNIT.test(unit)) throw new ValidationError("bad_unit", "unit must be * or a short key");
    assertSha256("inputSha256", input.inputSha256);
    return tx(() => {
      requireWritableRun(matterId, runId);
      const last = get<{ n: number | null }>(
        "SELECT MAX(attempt) AS n FROM run_stages WHERE run_id = ? AND stage = ? AND unit = ?",
        runId,
        input.stage,
        unit,
      );
      const attempt = (last?.n ?? 0) + 1;
      run(
        `INSERT INTO run_stages
           (run_id, stage, unit, attempt, status, input_sha256, output_json, output_sha256, error_kind, started_at, finished_at)
         VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL, NULL, ?, NULL)`,
        runId,
        input.stage,
        unit,
        attempt,
        input.inputSha256,
        ctx.now(),
      );
      return getStage(matterId, runId, input.stage, unit, attempt) as RunStageRow;
    });
  }

  function getStage(
    matterId: string,
    runId: string,
    stage: string,
    unit: string,
    attempt: number,
  ): RunStageRow | undefined {
    const row = get<RawStage>(
      `SELECT s.* FROM run_stages s JOIN runs r ON r.id = s.run_id
       WHERE r.matter_id = ? AND s.run_id = ? AND s.stage = ? AND s.unit = ? AND s.attempt = ?`,
      matterId,
      runId,
      stage,
      unit,
      attempt,
    );
    return row ? toStage(row) : undefined;
  }

  /**
   * Closes a stage attempt. `output` is stored as canonical JSON with its hash, which is what
   * `findReusableStage` checks before handing it back, so an output edited after the fact is not
   * reused.
   */
  function recordStageResult(
    matterId: string,
    runId: string,
    input: {
      stage: string;
      unit?: string;
      attempt: number;
      status: "succeeded" | "failed";
      output?: unknown;
      errorKind?: string | null;
    },
  ): RunStageRow {
    const unit = input.unit ?? "*";
    if (input.status !== "succeeded" && input.status !== "failed")
      throw new ValidationError("bad_status", "stage result must be succeeded or failed");
    if (input.errorKind !== undefined && input.errorKind !== null)
      assertShortCode("errorKind", input.errorKind);
    const outputJson = input.output === undefined ? null : canonicalJson(input.output);
    return tx(() => {
      requireWritableRun(matterId, runId);
      const stage = getStage(matterId, runId, input.stage, unit, input.attempt);
      if (!stage) throw new NotFoundError("run stage", `${runId}/${input.stage}/${unit}/${input.attempt}`);
      if (stage.status !== "running")
        throw new ConflictError("stage_closed", "this stage attempt already has a result");
      run(
        `UPDATE run_stages
         SET status = ?, output_json = ?, output_sha256 = ?, error_kind = ?, finished_at = ?
         WHERE run_id = ? AND stage = ? AND unit = ? AND attempt = ?`,
        input.status,
        outputJson,
        outputJson === null ? null : sha256Hex(outputJson),
        input.status === "failed" ? (input.errorKind ?? null) : null,
        ctx.now(),
        runId,
        input.stage,
        unit,
        input.attempt,
      );
      return getStage(matterId, runId, input.stage, unit, input.attempt) as RunStageRow;
    });
  }

  /**
   * The newest succeeded attempt of this stage and unit whose input hash matches, with an output
   * that still hashes to what was recorded. This is how a resumed run skips work it already did.
   */
  function findReusableStage(
    matterId: string,
    runId: string,
    stage: string,
    unit: string,
    inputSha256: string,
  ): RunStageRow | undefined {
    const row = get<RawStage>(
      `SELECT s.* FROM run_stages s JOIN runs r ON r.id = s.run_id
       WHERE r.matter_id = ? AND s.run_id = ? AND s.stage = ? AND s.unit = ?
         AND s.status = 'succeeded' AND s.input_sha256 = ?
       ORDER BY s.attempt DESC LIMIT 1`,
      matterId,
      runId,
      stage,
      unit,
      inputSha256,
    );
    if (!row || row.output_json === null || row.output_sha256 !== sha256Hex(row.output_json))
      return undefined;
    return toStage(row);
  }

  const listStages = (matterId: string, runId: string): RunStageRow[] =>
    all<RawStage>(
      `SELECT s.* FROM run_stages s JOIN runs r ON r.id = s.run_id
       WHERE r.matter_id = ? AND s.run_id = ? ORDER BY s.started_at, s.rowid`,
      matterId,
      runId,
    ).map(toStage);

  // --- model calls --------------------------------------------------------------------------

  type NewModelCall = CallRecord & {
    costUsdEstimate?: number | null;
    priceTableSha256?: string | null;
  };

  /**
   * Records calls the runner made. A call row holds hashes, counts and timings and never the
   * prompt or the answer: only the fields of `CallRecord` are read from each object, so a caller
   * that attaches text to one cannot get it into the table.
   */
  function insertModelCalls(
    matterId: string,
    runId: string,
    calls: readonly NewModelCall[],
  ): ModelCallRow[] {
    const parsed = calls.map((call) => parseWith(CallRecordSchema, call, "model call"));
    return tx(() => {
      requireRun(matterId, runId);
      const ids: string[] = [];
      for (const call of parsed) {
        if (!get<{ n: number }>("SELECT 1 AS n FROM prompt_versions WHERE id = ?", call.promptVersionId))
          throw new NotFoundError("prompt version", call.promptVersionId);
        const id = newId("mcl");
        ids.push(id);
        run(
          `INSERT INTO model_calls
             (id, run_id, stage, rule_key, prompt_version_id, request_sha256, attempt, outcome,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms,
              cost_usd_estimate, price_table_sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          runId,
          call.stage,
          call.ruleKey,
          call.promptVersionId,
          call.requestSha256,
          call.attempt,
          call.outcome,
          call.inputTokens,
          call.outputTokens,
          call.cacheReadTokens,
          call.cacheWriteTokens,
          Math.round(call.latencyMs),
          call.costUsdEstimate ?? null,
          call.priceTableSha256 ?? null,
        );
      }
      return ids.map(
        (id) =>
          toModelCall(
            get<RawModelCall>("SELECT * FROM model_calls WHERE id = ?", id) as RawModelCall,
          ),
      );
    });
  }

  const listModelCalls = (matterId: string, runId: string): ModelCallRow[] =>
    all<RawModelCall>(
      `SELECT c.* FROM model_calls c JOIN runs r ON r.id = c.run_id
       WHERE r.matter_id = ? AND c.run_id = ? ORDER BY c.rowid`,
      matterId,
      runId,
    ).map(toModelCall);

  return {
    buildRunManifest,
    createRun,
    getRun,
    listRunsForMatter,
    getActiveRun,
    getCurrentRun,
    updateRunStatus,
    markInterruptedOnBoot,
    recordStageStart,
    recordStageResult,
    findReusableStage,
    listStages,
    insertModelCalls,
    listModelCalls,
    internal: { requireRun, requireWritableRun },
  };
}

export type RunsApi = ReturnType<typeof createRunsApi>;
