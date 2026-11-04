import type { PlaybookRuleRecord, WorkflowManifest } from "../contracts.js";
import { canonicalJson, hashOf, sha256Hex } from "../canonical.js";
import { newId } from "../ids.js";
import { assertSha256, cleanLabel, parseWith, type Ctx } from "./context.js";
import { ConflictError, InvalidTransitionError, NotFoundError, ValidationError } from "./errors.js";
import { PlaybookRuleRecordSchema, RuleJsonSchema, WorkflowManifestSchema } from "./schemas.js";
import type {
  PlaybookVersionRow,
  PromptVersionRow,
  StoredRule,
  WorkflowVersionRow,
} from "./types.js";

interface RawPlaybook {
  id: string;
  playbook_slug: string;
  version: string;
  yaml: string;
  sha256: string;
  status: PlaybookVersionRow["status"];
  approved_by: string | null;
  approved_at: string | null;
}
interface RawRule {
  id: string;
  playbook_version_id: string;
  rule_key: string;
  category: PlaybookRuleRecord["category"];
  severity: PlaybookRuleRecord["severity"];
  required: number;
  kind: PlaybookRuleRecord["kind"];
  rule_json: string;
  rule_sha256: string;
  ordinal: number;
}
interface RawPrompt {
  id: string;
  stage: PromptVersionRow["stage"];
  template: string;
  schema_json: string;
  sha256: string;
  created_at: string;
}
interface RawWorkflow {
  id: string;
  label: string;
  manifest_json: string;
  sha256: string;
  status: WorkflowVersionRow["status"];
  promoted_by: string | null;
  promoted_at: string | null;
  promotion_record: string | null;
}

const toPlaybook = (r: RawPlaybook): PlaybookVersionRow => ({
  id: r.id,
  slug: r.playbook_slug,
  version: r.version,
  yaml: r.yaml,
  sha256: r.sha256,
  status: r.status,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
});

export const toStoredRule = (r: RawRule): StoredRule => {
  const json = JSON.parse(r.rule_json) as ReturnType<typeof RuleJsonSchema.parse>;
  return {
    id: r.id,
    playbookVersionId: r.playbook_version_id,
    ordinal: r.ordinal,
    ruleSha256: r.rule_sha256,
    key: r.rule_key,
    category: r.category,
    severity: r.severity,
    required: r.required === 1,
    kind: r.kind,
    title: json.title,
    standard: json.standard,
    fallback: json.fallback,
    unacceptable: json.unacceptable,
    guidance: json.guidance,
    fallbackLanguage: json.fallbackLanguage,
    escalateWhen: json.escalateWhen,
  };
};

const toPrompt = (r: RawPrompt): PromptVersionRow => ({
  id: r.id,
  stage: r.stage,
  template: r.template,
  schemaJson: r.schema_json,
  sha256: r.sha256,
  createdAt: r.created_at,
});
const toWorkflow = (r: RawWorkflow): WorkflowVersionRow => ({
  id: r.id,
  label: r.label,
  manifest: JSON.parse(r.manifest_json) as WorkflowManifest,
  sha256: r.sha256,
  status: r.status,
  promotedBy: r.promoted_by,
  promotedAt: r.promoted_at,
  promotionRecord: r.promotion_record,
});

export interface PlaybookImport {
  slug: string;
  version: string;
  /** The YAML text exactly as given. */
  yaml: string;
  /** SHA-256 of `yaml`, as `loadPlaybook` computes it. Checked, not trusted. */
  sha256: string;
  rules: readonly PlaybookRuleRecord[];
}

const MAX_YAML_BYTES = 1_000_000;

export function createPlaybooksApi(ctx: Ctx, requireUser: (userId: string) => unknown) {
  const { get, all, run, tx } = ctx;

  // --- playbooks ----------------------------------------------------------------------------

  const getPlaybookVersion = (playbookVersionId: string): PlaybookVersionRow | undefined => {
    const row = get<RawPlaybook>("SELECT * FROM playbook_versions WHERE id = ?", playbookVersionId);
    return row ? toPlaybook(row) : undefined;
  };
  const findPlaybookVersion = (slug: string, version: string): PlaybookVersionRow | undefined => {
    const row = get<RawPlaybook>(
      "SELECT * FROM playbook_versions WHERE playbook_slug = ? AND version = ?",
      slug,
      version,
    );
    return row ? toPlaybook(row) : undefined;
  };
  const listPlaybookVersions = (slug?: string): PlaybookVersionRow[] =>
    all<RawPlaybook>(
      "SELECT * FROM playbook_versions WHERE (?1 IS NULL OR playbook_slug = ?1) ORDER BY playbook_slug, rowid",
      slug ?? null,
    ).map(toPlaybook);

  const listRules = (playbookVersionId: string): StoredRule[] =>
    all<RawRule>(
      "SELECT * FROM playbook_rules WHERE playbook_version_id = ? ORDER BY ordinal, rowid",
      playbookVersionId,
    ).map(toStoredRule);
  const getRuleByKey = (playbookVersionId: string, ruleKey: string): StoredRule | undefined => {
    const row = get<RawRule>(
      "SELECT * FROM playbook_rules WHERE playbook_version_id = ? AND rule_key = ?",
      playbookVersionId,
      ruleKey,
    );
    return row ? toStoredRule(row) : undefined;
  };

  function importPlaybookDraft(
    input: PlaybookImport,
    opts: { actorId: string },
  ): PlaybookVersionRow {
    const slug = input.slug;
    if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug))
      throw new ValidationError(
        "bad_slug",
        "playbook slug must be lower case letters, digits and hyphens",
      );
    if (
      typeof input.version !== "string" ||
      !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(input.version)
    )
      throw new ValidationError("bad_version", "playbook version is not a version string");
    if (
      typeof input.yaml !== "string" ||
      input.yaml.length === 0 ||
      input.yaml.length > MAX_YAML_BYTES
    )
      throw new ValidationError("bad_yaml", "playbook YAML is empty or too large");
    assertSha256("sha256", input.sha256);
    if (sha256Hex(input.yaml) !== input.sha256)
      throw new ValidationError(
        "playbook_hash_mismatch",
        "playbook sha256 is not the hash of its YAML",
      );
    if (!Array.isArray(input.rules) || input.rules.length === 0)
      throw new ValidationError("no_rules", "a playbook version needs at least one rule");
    const rules = input.rules.map((rule) =>
      parseWith(PlaybookRuleRecordSchema, rule, "playbook rule"),
    );
    if (new Set(rules.map((r) => r.key)).size !== rules.length)
      throw new ValidationError("duplicate_rule", "playbook rule keys must be unique");

    return tx(() => {
      requireUser(opts.actorId);
      const existing = findPlaybookVersion(slug, input.version);
      if (existing) {
        // Importing the same text again is how a boot-time seed behaves: it changes nothing.
        if (existing.sha256 === input.sha256) return existing;
        throw new ConflictError(
          "playbook_version_exists",
          "a playbook version with this slug and version already exists with different text",
        );
      }
      const id = newId("pbv");
      run(
        `INSERT INTO playbook_versions (id, playbook_slug, version, yaml, sha256, status, approved_by, approved_at)
         VALUES (?, ?, ?, ?, ?, 'draft', NULL, NULL)`,
        id,
        slug,
        input.version,
        input.yaml,
        input.sha256,
      );
      rules.forEach((rule, ordinal) => {
        const { key, category, severity, required, kind, ...rest } = rule;
        const json = parseWith(RuleJsonSchema, rest, "playbook rule body");
        run(
          `INSERT INTO playbook_rules
             (id, playbook_version_id, rule_key, category, severity, required, kind, rule_json, rule_sha256, ordinal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId("pbr"),
          id,
          key,
          category,
          severity,
          required ? 1 : 0,
          kind,
          canonicalJson(json),
          hashOf(rule),
          ordinal,
        );
      });
      ctx.audit({
        actorId: opts.actorId,
        matterId: null,
        action: "playbook.import",
        targetType: "playbook_version",
        targetId: id,
        detail: { slug, version: input.version, sha256: input.sha256, rules: rules.length },
      });
      return getPlaybookVersion(id) as PlaybookVersionRow;
    });
  }

  /** Approval freezes the version and its rules (triggers in 002). The approver is whoever the caller says; the role check is authorization's. */
  function approvePlaybookVersion(
    playbookVersionId: string,
    opts: { actorId: string },
  ): PlaybookVersionRow {
    return tx(() => {
      const playbook = getPlaybookVersion(playbookVersionId);
      if (!playbook) throw new NotFoundError("playbook version");
      requireUser(opts.actorId);
      if (playbook.status === "approved")
        throw new ConflictError("already_approved", "the playbook version is already approved");
      if (playbook.status !== "draft")
        throw new InvalidTransitionError("playbook", playbook.status, "approved");
      run(
        "UPDATE playbook_versions SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?",
        opts.actorId,
        ctx.now(),
        playbookVersionId,
      );
      ctx.audit({
        actorId: opts.actorId,
        matterId: null,
        action: "playbook.approve",
        targetType: "playbook_version",
        targetId: playbookVersionId,
        detail: { slug: playbook.slug, version: playbook.version, sha256: playbook.sha256 },
      });
      return getPlaybookVersion(playbookVersionId) as PlaybookVersionRow;
    });
  }

  // --- prompts ------------------------------------------------------------------------------

  const getPromptVersion = (promptVersionId: string): PromptVersionRow | undefined => {
    const row = get<RawPrompt>("SELECT * FROM prompt_versions WHERE id = ?", promptVersionId);
    return row ? toPrompt(row) : undefined;
  };
  const listPromptVersions = (): PromptVersionRow[] =>
    all<RawPrompt>("SELECT * FROM prompt_versions ORDER BY id").map(toPrompt);

  /**
   * Registers a prompt version. Idempotent by hash: the same prompt again returns the stored row. A
   * prompt id that is already taken by different text is refused, because an id names one text for
   * ever; changing a prompt means a new id. Registering one for the first time is audited; asking
   * again for one that is there writes nothing, so a boot-time seed leaves no trail after the first.
   */
  function upsertPromptVersion(
    input: {
      id: string;
      stage: "extract" | "analyze" | "support";
      template: string;
      schemaJson: string;
      sha256: string;
    },
    opts: { actorId?: string | null } = {},
  ): PromptVersionRow {
    if (typeof input.id !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(input.id))
      throw new ValidationError(
        "bad_prompt_id",
        "prompt id must be lower case, such as analyze.p1",
      );
    if (!["extract", "analyze", "support"].includes(input.stage))
      throw new ValidationError("bad_stage", "prompt stage must be extract, analyze or support");
    if (typeof input.template !== "string" || typeof input.schemaJson !== "string")
      throw new ValidationError("bad_prompt", "prompt template and schema must be strings");
    assertSha256("sha256", input.sha256);
    return tx(() => {
      const bySha = get<RawPrompt>("SELECT * FROM prompt_versions WHERE sha256 = ?", input.sha256);
      if (bySha) {
        if (bySha.id !== input.id)
          throw new ConflictError(
            "prompt_hash_taken",
            "this prompt text is already registered under another id",
          );
        return toPrompt(bySha);
      }
      if (getPromptVersion(input.id))
        throw new ConflictError(
          "prompt_id_taken",
          "this prompt id is registered with different text",
        );
      run(
        "INSERT INTO prompt_versions (id, stage, template, schema_json, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        input.id,
        input.stage,
        input.template,
        input.schemaJson,
        input.sha256,
        ctx.now(),
      );
      ctx.audit({
        actorId: opts.actorId ?? null,
        matterId: null,
        action: "prompt.register",
        targetType: "prompt_version",
        targetId: input.id,
        detail: { stage: input.stage, sha256: input.sha256 },
      });
      return getPromptVersion(input.id) as PromptVersionRow;
    });
  }

  // --- workflow versions --------------------------------------------------------------------

  const getWorkflowVersion = (workflowVersionId: string): WorkflowVersionRow | undefined => {
    const row = get<RawWorkflow>("SELECT * FROM workflow_versions WHERE id = ?", workflowVersionId);
    return row ? toWorkflow(row) : undefined;
  };
  const getWorkflowVersionByLabel = (label: string): WorkflowVersionRow | undefined => {
    const row = get<RawWorkflow>("SELECT * FROM workflow_versions WHERE label = ?", label);
    return row ? toWorkflow(row) : undefined;
  };
  const listWorkflowVersions = (): WorkflowVersionRow[] =>
    all<RawWorkflow>("SELECT * FROM workflow_versions ORDER BY rowid").map(toWorkflow);

  /**
   * Registers a workflow version: a manifest and its hash, which is its identity. Idempotent by
   * hash. A label that already names a different manifest is refused. The prompts it pins must be
   * registered first, so a workflow can never point at text the database does not hold. The first
   * registration is audited, as the prompt's is.
   */
  function upsertWorkflowVersion(
    input: {
      manifest: WorkflowManifest;
      sha256: string;
    },
    opts: { actorId?: string | null } = {},
  ): WorkflowVersionRow {
    const manifest = parseWith(WorkflowManifestSchema, input.manifest, "workflow manifest");
    assertSha256("sha256", input.sha256);
    if (hashOf(manifest) !== input.sha256)
      throw new ValidationError(
        "workflow_hash_mismatch",
        "workflow sha256 is not the hash of its manifest",
      );
    return tx(() => {
      const bySha = get<RawWorkflow>(
        "SELECT * FROM workflow_versions WHERE sha256 = ?",
        input.sha256,
      );
      if (bySha) return toWorkflow(bySha);
      if (getWorkflowVersionByLabel(manifest.label))
        throw new ConflictError(
          "workflow_label_taken",
          "this workflow label names a different manifest",
        );
      for (const promptId of [
        manifest.prompts.extract,
        manifest.prompts.analyze,
        manifest.prompts.support,
      ]) {
        if (promptId !== null && !getPromptVersion(promptId))
          throw new ValidationError(
            "unknown_prompt",
            "the workflow pins a prompt that is not registered",
          );
      }
      const id = `wfv_${input.sha256.slice(0, 16)}`;
      run(
        `INSERT INTO workflow_versions (id, label, manifest_json, sha256, status, promoted_by, promoted_at, promotion_record)
         VALUES (?, ?, ?, ?, 'candidate', NULL, NULL, NULL)`,
        id,
        manifest.label,
        canonicalJson(manifest),
        input.sha256,
      );
      ctx.audit({
        actorId: opts.actorId ?? null,
        matterId: null,
        action: "workflow.register",
        targetType: "workflow_version",
        targetId: id,
        detail: { label: manifest.label, sha256: input.sha256, retrieval: manifest.retrieval },
      });
      return getWorkflowVersion(id) as WorkflowVersionRow;
    });
  }

  /** Candidate to pilot, with the path of the signed-off comparison. Old runs keep their workflow version. */
  function promoteWorkflowVersion(
    workflowVersionId: string,
    opts: { actorId: string; promotionRecord: string },
  ): WorkflowVersionRow {
    const record = cleanLabel("promotion record", opts.promotionRecord, 200);
    return tx(() => {
      const workflow = getWorkflowVersion(workflowVersionId);
      if (!workflow) throw new NotFoundError("workflow version");
      requireUser(opts.actorId);
      if (workflow.status === "pilot")
        throw new ConflictError("already_promoted", "the workflow version is already a pilot");
      if (workflow.status !== "candidate")
        throw new InvalidTransitionError("workflow", workflow.status, "pilot");
      run(
        `UPDATE workflow_versions
         SET status = 'pilot', promoted_by = ?, promoted_at = ?, promotion_record = ? WHERE id = ?`,
        opts.actorId,
        ctx.now(),
        record,
        workflowVersionId,
      );
      ctx.audit({
        actorId: opts.actorId,
        matterId: null,
        action: "workflow.promote",
        targetType: "workflow_version",
        targetId: workflowVersionId,
        detail: { label: workflow.label, sha256: workflow.sha256, promotionRecord: record },
      });
      return getWorkflowVersion(workflowVersionId) as WorkflowVersionRow;
    });
  }

  return {
    importPlaybookDraft,
    approvePlaybookVersion,
    getPlaybookVersion,
    findPlaybookVersion,
    listPlaybookVersions,
    listRules,
    getRuleByKey,
    upsertPromptVersion,
    getPromptVersion,
    listPromptVersions,
    upsertWorkflowVersion,
    getWorkflowVersion,
    getWorkflowVersionByLabel,
    listWorkflowVersions,
    promoteWorkflowVersion,
  };
}

export type PlaybooksApi = ReturnType<typeof createPlaybooksApi>;
