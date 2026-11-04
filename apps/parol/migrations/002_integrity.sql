-- Parol schema, version 2: integrity.
--
-- Three kinds of change, all additive to 001 so that its checksum stays valid:
--   1. columns that 001 left out (the inputs digest, finding conflict and abstain text, and the
--      orderings that a finding's content hash depends on);
--   2. unique indexes for rules that must hold whatever code writes the rows;
--   3. triggers that make evidence immutable and keep every row inside its own matter.
--
-- Messages start with "parol:" so that the store can tell a trigger from other constraint errors.
-- Every immutability trigger also has an insert guard, because INSERT OR REPLACE and an upsert
-- delete or rewrite the old row without an UPDATE ever being seen. The store opens connections
-- with recursive_triggers on as well, which covers the delete half of a replace.

-- 1. Columns ------------------------------------------------------------------------------------

-- The digest of the inputs a run would use: client name, playbook hash, and each document's
-- operative version. It leaves out workflow and model, which belong to input_manifest_sha256, so a
-- matter can say whether its results are current before anyone has chosen a workflow.
ALTER TABLE matters ADD COLUMN current_inputs_sha256 TEXT;
ALTER TABLE runs ADD COLUMN inputs_sha256 TEXT;

-- VerifiedFinding carries both, and findingContentSha256 hashes `conflict`, so a finding cannot be
-- rebuilt or re-hashed without them.
ALTER TABLE findings ADD COLUMN conflict TEXT;
ALTER TABLE findings ADD COLUMN abstain_reason TEXT;

-- The content hash covers evidence and escalations in order, so the order has to be stored.
ALTER TABLE finding_evidence ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE verification_results ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0;
-- Findings and the memo are listed in playbook order.
ALTER TABLE playbook_rules ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0;

-- 2. Indexes ------------------------------------------------------------------------------------

-- At most one run in flight per matter.
CREATE UNIQUE INDEX runs_one_active_per_matter ON runs (matter_id)
  WHERE status IN ('queued','ingesting','extracting','retrieving','analyzing','verifying');
-- At most one operative version per document.
CREATE UNIQUE INDEX document_versions_one_operative ON document_versions (document_id)
  WHERE operative = 1;
-- One NDA per matter; amendments are limited by a trigger below.
CREATE UNIQUE INDEX documents_one_nda_per_matter ON documents (matter_id) WHERE kind = 'nda';
-- A finding has at most one current decision, and a matter at most one current memo.
CREATE UNIQUE INDEX reviews_one_current_per_finding ON reviews (finding_id) WHERE validity = 'current';
CREATE UNIQUE INDEX memos_one_current_per_matter ON memos (matter_id) WHERE status = 'current';
-- A run has one finding per rule.
CREATE UNIQUE INDEX findings_one_per_rule ON findings (run_id, rule_key);

-- SQLite does not index the child side of a foreign key. Without these, deleting a matter scans
-- every child table once per cascaded row.
CREATE INDEX document_versions_by_document ON document_versions (document_id);
CREATE INDEX document_versions_by_matter ON document_versions (matter_id);
CREATE INDEX documents_by_matter ON documents (matter_id);
CREATE INDEX source_spans_by_version ON source_spans (document_version_id, paragraph_index);
CREATE INDEX source_spans_by_matter ON source_spans (matter_id);
CREATE INDEX span_annotations_by_span ON span_annotations (span_id);
CREATE INDEX runs_by_matter ON runs (matter_id, started_at);
CREATE INDEX model_calls_by_run ON model_calls (run_id);
CREATE INDEX findings_by_run ON findings (run_id);
CREATE INDEX findings_by_matter ON findings (matter_id);
CREATE INDEX finding_evidence_by_finding ON finding_evidence (finding_id, ordinal);
CREATE INDEX finding_evidence_by_span ON finding_evidence (span_id);
CREATE INDEX verification_results_by_finding ON verification_results (finding_id, ordinal);
CREATE INDEX reviews_by_finding ON reviews (finding_id);
CREATE INDEX reviews_by_matter ON reviews (matter_id);
CREATE INDEX memos_by_matter ON memos (matter_id);
CREATE INDEX feedback_by_matter ON feedback (matter_id);
CREATE INDEX playbook_rules_by_version ON playbook_rules (playbook_version_id, ordinal);
CREATE INDEX audit_events_by_matter ON audit_events (matter_id);
CREATE INDEX eval_slot_results_by_run ON eval_slot_results (run_id);

-- 3. Triggers -----------------------------------------------------------------------------------

-- Audit: append only, linked, and never touched by a matter's deletion. -------------------------
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'parol: audit_events is append-only'); END;

CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'parol: audit_events is append-only'); END;

CREATE TRIGGER audit_events_no_replace BEFORE INSERT ON audit_events
WHEN NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM audit_events WHERE seq = NEW.seq)
BEGIN SELECT RAISE(ABORT, 'parol: audit_events is append-only'); END;

-- The new row must extend the chain it claims to extend. The hash itself is checked by
-- verifyAuditChain, because SQLite cannot compute SHA-256.
CREATE TRIGGER audit_events_linked BEFORE INSERT ON audit_events
WHEN NEW.prev_hash IS NOT COALESCE(
  (SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1),
  '0000000000000000000000000000000000000000000000000000000000000000')
BEGIN SELECT RAISE(ABORT, 'parol: audit event does not extend the chain'); END;

-- Matters ---------------------------------------------------------------------------------------
CREATE TRIGGER matters_identity_immutable BEFORE UPDATE ON matters
WHEN NEW.id IS NOT OLD.id OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at OR NEW.synthetic IS NOT OLD.synthetic
BEGIN SELECT RAISE(ABORT, 'parol: matter identity is immutable'); END;

CREATE TRIGGER matters_pin_approved_playbook_insert BEFORE INSERT ON matters
WHEN NEW.playbook_version_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM playbook_versions WHERE id = NEW.playbook_version_id AND status = 'approved')
BEGIN SELECT RAISE(ABORT, 'parol: a matter can only pin an approved playbook version'); END;

CREATE TRIGGER matters_pin_approved_playbook_update BEFORE UPDATE OF playbook_version_id ON matters
WHEN NEW.playbook_version_id IS NOT NULL AND NEW.playbook_version_id IS NOT OLD.playbook_version_id
  AND NOT EXISTS (
    SELECT 1 FROM playbook_versions WHERE id = NEW.playbook_version_id AND status = 'approved')
BEGIN SELECT RAISE(ABORT, 'parol: a matter can only pin an approved playbook version'); END;

-- Documents: one NDA and at most two amendments, labelled D1 to D3. ----------------------------
CREATE TRIGGER documents_no_replace BEFORE INSERT ON documents
WHEN NEW.id IS NULL OR EXISTS (
  SELECT 1 FROM documents
  WHERE id = NEW.id
    OR (matter_id = NEW.matter_id AND ordinal = NEW.ordinal)
    OR (NEW.kind = 'nda' AND matter_id = NEW.matter_id AND kind = 'nda'))
BEGIN SELECT RAISE(ABORT, 'parol: documents are never replaced'); END;

CREATE TRIGGER documents_limits BEFORE INSERT ON documents
WHEN NEW.ordinal NOT BETWEEN 1 AND 3
  OR (NEW.kind = 'amendment'
      AND (SELECT count(*) FROM documents WHERE matter_id = NEW.matter_id AND kind = 'amendment') >= 2)
BEGIN SELECT RAISE(ABORT, 'parol: a matter holds one NDA and at most two amendments (D1 to D3)'); END;

CREATE TRIGGER documents_identity_immutable BEFORE UPDATE ON documents
WHEN NEW.id IS NOT OLD.id OR NEW.matter_id IS NOT OLD.matter_id
  OR NEW.kind IS NOT OLD.kind OR NEW.ordinal IS NOT OLD.ordinal
BEGIN SELECT RAISE(ABORT, 'parol: document identity is immutable'); END;

-- Document versions: content is immutable; only stated_date and operative may change. ----------
CREATE TRIGGER document_versions_no_replace BEFORE INSERT ON document_versions
WHEN NEW.id IS NULL OR EXISTS (
  SELECT 1 FROM document_versions
  WHERE id = NEW.id OR (document_id = NEW.document_id AND version_no = NEW.version_no))
BEGIN SELECT RAISE(ABORT, 'parol: document versions are never replaced'); END;

CREATE TRIGGER document_versions_same_matter BEFORE INSERT ON document_versions
WHEN NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND matter_id = NEW.matter_id)
BEGIN SELECT RAISE(ABORT, 'parol: document version must belong to the matter of its document'); END;

CREATE TRIGGER document_versions_own_storage BEFORE INSERT ON document_versions
WHEN substr(NEW.storage_path, 1, length(NEW.matter_id) + 1) IS NOT NEW.matter_id || '/'
BEGIN SELECT RAISE(ABORT, 'parol: stored file must sit in its own matter folder'); END;

CREATE TRIGGER document_versions_operative_flag_insert BEFORE INSERT ON document_versions
WHEN NEW.operative NOT IN (0, 1)
  OR (NEW.operative = 1 AND EXISTS (
    SELECT 1 FROM document_versions WHERE document_id = NEW.document_id AND operative = 1))
BEGIN SELECT RAISE(ABORT, 'parol: a document has at most one operative version'); END;

CREATE TRIGGER document_versions_operative_flag_update BEFORE UPDATE OF operative ON document_versions
WHEN NEW.operative NOT IN (0, 1)
  OR (NEW.operative = 1 AND OLD.operative IS NOT 1 AND EXISTS (
    SELECT 1 FROM document_versions
    WHERE document_id = NEW.document_id AND operative = 1 AND id IS NOT NEW.id))
BEGIN SELECT RAISE(ABORT, 'parol: a document has at most one operative version'); END;

CREATE TRIGGER document_versions_content_immutable BEFORE UPDATE ON document_versions
WHEN NEW.id IS NOT OLD.id OR NEW.document_id IS NOT OLD.document_id
  OR NEW.matter_id IS NOT OLD.matter_id OR NEW.version_no IS NOT OLD.version_no
  OR NEW.media_type IS NOT OLD.media_type OR NEW.file_sha256 IS NOT OLD.file_sha256
  OR NEW.text_sha256 IS NOT OLD.text_sha256 OR NEW.byte_size IS NOT OLD.byte_size
  OR NEW.storage_path IS NOT OLD.storage_path OR NEW.uploaded_by IS NOT OLD.uploaded_by
  OR NEW.uploaded_at IS NOT OLD.uploaded_at
BEGIN SELECT RAISE(ABORT, 'parol: document version content is immutable'); END;

-- Source spans and annotations: written once at ingest. ----------------------------------------
CREATE TRIGGER source_spans_no_replace BEFORE INSERT ON source_spans
WHEN NEW.id IS NULL OR EXISTS (
  SELECT 1 FROM source_spans
  WHERE id = NEW.id
    OR (document_version_id = NEW.document_version_id AND paragraph_index = NEW.paragraph_index))
BEGIN SELECT RAISE(ABORT, 'parol: source spans are never replaced'); END;

CREATE TRIGGER source_spans_same_matter BEFORE INSERT ON source_spans
WHEN NOT EXISTS (
  SELECT 1 FROM document_versions WHERE id = NEW.document_version_id AND matter_id = NEW.matter_id)
BEGIN SELECT RAISE(ABORT, 'parol: span must belong to the matter of its document version'); END;

CREATE TRIGGER source_spans_id_shape BEFORE INSERT ON source_spans
WHEN NEW.id IS NOT NEW.document_version_id || ':p' || NEW.paragraph_index
BEGIN SELECT RAISE(ABORT, 'parol: span id must be <documentVersionId>:p<paragraphIndex>'); END;

CREATE TRIGGER source_spans_immutable BEFORE UPDATE ON source_spans
BEGIN SELECT RAISE(ABORT, 'parol: source spans are immutable'); END;

CREATE TRIGGER span_annotations_immutable BEFORE UPDATE ON span_annotations
BEGIN SELECT RAISE(ABORT, 'parol: span annotations are immutable'); END;

-- Playbooks: draft until approved, then frozen together with their rules. ----------------------
CREATE TRIGGER playbook_versions_insert_as_draft BEFORE INSERT ON playbook_versions
WHEN NEW.id IS NULL OR NEW.status IS NOT 'draft' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'parol: a playbook version is created as a draft'); END;

CREATE TRIGGER playbook_versions_no_replace BEFORE INSERT ON playbook_versions
WHEN EXISTS (
  SELECT 1 FROM playbook_versions
  WHERE status = 'approved'
    AND (id = NEW.id OR (playbook_slug = NEW.playbook_slug AND version = NEW.version)))
BEGIN SELECT RAISE(ABORT, 'parol: an approved playbook version is immutable'); END;

CREATE TRIGGER playbook_versions_approved_immutable BEFORE UPDATE ON playbook_versions
WHEN OLD.status = 'approved'
  AND (NEW.id IS NOT OLD.id OR NEW.playbook_slug IS NOT OLD.playbook_slug
    OR NEW.version IS NOT OLD.version OR NEW.yaml IS NOT OLD.yaml OR NEW.sha256 IS NOT OLD.sha256
    OR NEW.approved_by IS NOT OLD.approved_by OR NEW.approved_at IS NOT OLD.approved_at
    OR NEW.status NOT IN ('approved', 'retired'))
BEGIN SELECT RAISE(ABORT, 'parol: an approved playbook version is immutable'); END;

CREATE TRIGGER playbook_versions_retired_final BEFORE UPDATE ON playbook_versions
WHEN OLD.status = 'retired' AND (NEW.status IS NOT 'retired' OR NEW.yaml IS NOT OLD.yaml OR NEW.sha256 IS NOT OLD.sha256)
BEGIN SELECT RAISE(ABORT, 'parol: a retired playbook version is final'); END;

CREATE TRIGGER playbook_versions_approval_needs_approver BEFORE UPDATE ON playbook_versions
WHEN NEW.status = 'approved' AND OLD.status IS NOT 'approved'
  AND (NEW.approved_by IS NULL OR NEW.approved_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'parol: approval records who approved and when'); END;

CREATE TRIGGER playbook_versions_no_delete_approved BEFORE DELETE ON playbook_versions
WHEN OLD.status IN ('approved', 'retired')
BEGIN SELECT RAISE(ABORT, 'parol: an approved playbook version is immutable'); END;

CREATE TRIGGER playbook_rules_frozen_insert BEFORE INSERT ON playbook_rules
WHEN EXISTS (
    SELECT 1 FROM playbook_versions WHERE id = NEW.playbook_version_id AND status <> 'draft')
  OR EXISTS (
    SELECT 1 FROM playbook_rules r JOIN playbook_versions v ON v.id = r.playbook_version_id
    WHERE v.status <> 'draft'
      AND (r.id = NEW.id OR (r.playbook_version_id = NEW.playbook_version_id AND r.rule_key = NEW.rule_key)))
BEGIN SELECT RAISE(ABORT, 'parol: the rules of an approved playbook version are immutable'); END;

CREATE TRIGGER playbook_rules_frozen_update BEFORE UPDATE ON playbook_rules
WHEN EXISTS (
    SELECT 1 FROM playbook_versions
    WHERE status <> 'draft' AND id IN (OLD.playbook_version_id, NEW.playbook_version_id))
BEGIN SELECT RAISE(ABORT, 'parol: the rules of an approved playbook version are immutable'); END;

CREATE TRIGGER playbook_rules_frozen_delete BEFORE DELETE ON playbook_rules
WHEN EXISTS (
    SELECT 1 FROM playbook_versions WHERE id = OLD.playbook_version_id AND status <> 'draft')
BEGIN SELECT RAISE(ABORT, 'parol: the rules of an approved playbook version are immutable'); END;

-- Prompts and workflow versions. ----------------------------------------------------------------
CREATE TRIGGER prompt_versions_no_replace BEFORE INSERT ON prompt_versions
WHEN NEW.id IS NULL OR EXISTS (
  SELECT 1 FROM prompt_versions WHERE id = NEW.id OR sha256 = NEW.sha256)
BEGIN SELECT RAISE(ABORT, 'parol: prompt versions are immutable'); END;

CREATE TRIGGER prompt_versions_immutable BEFORE UPDATE ON prompt_versions
BEGIN SELECT RAISE(ABORT, 'parol: prompt versions are immutable'); END;

CREATE TRIGGER prompt_versions_no_delete BEFORE DELETE ON prompt_versions
BEGIN SELECT RAISE(ABORT, 'parol: prompt versions are immutable'); END;

CREATE TRIGGER workflow_versions_insert_as_candidate BEFORE INSERT ON workflow_versions
WHEN NEW.id IS NULL OR NEW.status IS NOT 'candidate'
  OR NEW.promoted_by IS NOT NULL OR NEW.promoted_at IS NOT NULL OR NEW.promotion_record IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'parol: a workflow version is created as a candidate'); END;

CREATE TRIGGER workflow_versions_no_replace BEFORE INSERT ON workflow_versions
WHEN EXISTS (SELECT 1 FROM workflow_versions WHERE id = NEW.id OR label = NEW.label)
BEGIN SELECT RAISE(ABORT, 'parol: workflow version manifests are immutable'); END;

CREATE TRIGGER workflow_versions_manifest_immutable BEFORE UPDATE ON workflow_versions
WHEN NEW.id IS NOT OLD.id OR NEW.label IS NOT OLD.label
  OR NEW.manifest_json IS NOT OLD.manifest_json OR NEW.sha256 IS NOT OLD.sha256
BEGIN SELECT RAISE(ABORT, 'parol: workflow version manifests are immutable'); END;

CREATE TRIGGER workflow_versions_status_forward BEFORE UPDATE ON workflow_versions
WHEN NEW.status IS NOT OLD.status AND NOT (
  (OLD.status = 'candidate' AND NEW.status IN ('pilot', 'retired'))
  OR (OLD.status = 'pilot' AND NEW.status = 'retired'))
BEGIN SELECT RAISE(ABORT, 'parol: a workflow version only moves candidate, pilot, retired'); END;

CREATE TRIGGER workflow_versions_promotion_record BEFORE UPDATE ON workflow_versions
WHEN NEW.status = 'pilot' AND OLD.status IS NOT 'pilot'
  AND (NEW.promotion_record IS NULL OR trim(NEW.promotion_record) = ''
       OR NEW.promoted_by IS NULL OR NEW.promoted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'parol: promotion to pilot needs a promotion record, a promoter and a time'); END;

CREATE TRIGGER workflow_versions_no_delete BEFORE DELETE ON workflow_versions
BEGIN SELECT RAISE(ABORT, 'parol: workflow version manifests are immutable'); END;

-- Runs: the provenance columns never change, only progress does. -------------------------------
CREATE TRIGGER runs_need_inputs_digest BEFORE INSERT ON runs
WHEN NEW.inputs_sha256 IS NULL OR length(NEW.inputs_sha256) <> 64
BEGIN SELECT RAISE(ABORT, 'parol: a run records the inputs digest it was started on'); END;

-- INSERT OR REPLACE on the active-run index would delete the run that is in flight.
CREATE TRIGGER runs_no_replace BEFORE INSERT ON runs
WHEN NEW.id IS NULL OR EXISTS (SELECT 1 FROM runs WHERE id = NEW.id)
  OR (NEW.status IN ('queued','ingesting','extracting','retrieving','analyzing','verifying')
      AND EXISTS (
        SELECT 1 FROM runs
        WHERE matter_id = NEW.matter_id
          AND status IN ('queued','ingesting','extracting','retrieving','analyzing','verifying')))
BEGIN SELECT RAISE(ABORT, 'parol: runs are never replaced and a matter has one active run'); END;

CREATE TRIGGER runs_provenance_immutable BEFORE UPDATE ON runs
WHEN NEW.id IS NOT OLD.id OR NEW.matter_id IS NOT OLD.matter_id
  OR NEW.workflow_version_id IS NOT OLD.workflow_version_id
  OR NEW.playbook_version_id IS NOT OLD.playbook_version_id
  OR NEW.model_provider IS NOT OLD.model_provider OR NEW.model_requested IS NOT OLD.model_requested
  OR NEW.input_manifest_json IS NOT OLD.input_manifest_json
  OR NEW.input_manifest_sha256 IS NOT OLD.input_manifest_sha256
  OR NEW.inputs_sha256 IS NOT OLD.inputs_sha256 OR NEW.purpose IS NOT OLD.purpose
  OR NEW.started_by IS NOT OLD.started_by OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT, 'parol: run provenance is immutable'); END;

CREATE TRIGGER runs_active_slot_update BEFORE UPDATE OF status ON runs
WHEN NEW.status IN ('queued','ingesting','extracting','retrieving','analyzing','verifying')
  AND EXISTS (
    SELECT 1 FROM runs
    WHERE matter_id = NEW.matter_id AND id IS NOT NEW.id
      AND status IN ('queued','ingesting','extracting','retrieving','analyzing','verifying'))
BEGIN SELECT RAISE(ABORT, 'parol: a matter has one active run'); END;

-- Findings: content is immutable; validity moves current to stale and never back. --------------
CREATE TRIGGER findings_no_replace BEFORE INSERT ON findings
WHEN NEW.id IS NULL OR EXISTS (
  SELECT 1 FROM findings WHERE id = NEW.id OR (run_id = NEW.run_id AND rule_key = NEW.rule_key))
BEGIN SELECT RAISE(ABORT, 'parol: findings are never replaced'); END;

CREATE TRIGGER findings_same_matter BEFORE INSERT ON findings
WHEN NOT EXISTS (SELECT 1 FROM runs WHERE id = NEW.run_id AND matter_id = NEW.matter_id)
  OR NOT EXISTS (
    SELECT 1 FROM playbook_rules r JOIN runs u ON u.playbook_version_id = r.playbook_version_id
    WHERE r.id = NEW.playbook_rule_id AND u.id = NEW.run_id
      AND r.rule_key = NEW.rule_key AND r.category = NEW.category AND r.severity = NEW.severity)
BEGIN SELECT RAISE(ABORT, 'parol: finding must match its run, matter and playbook rule'); END;

CREATE TRIGGER findings_start_current BEFORE INSERT ON findings
WHEN NEW.validity IS NOT 'current' OR NEW.stale_reason IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'parol: a finding is created current'); END;

CREATE TRIGGER findings_content_immutable BEFORE UPDATE ON findings
WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.matter_id IS NOT OLD.matter_id
  OR NEW.playbook_rule_id IS NOT OLD.playbook_rule_id OR NEW.rule_key IS NOT OLD.rule_key
  OR NEW.category IS NOT OLD.category OR NEW.severity IS NOT OLD.severity
  OR NEW.status IS NOT OLD.status OR NEW.discrepancy IS NOT OLD.discrepancy
  OR NEW.explanation IS NOT OLD.explanation OR NEW.fallback_language IS NOT OLD.fallback_language
  OR NEW.fallback_basis IS NOT OLD.fallback_basis OR NEW.escalations_json IS NOT OLD.escalations_json
  OR NEW.verification_state IS NOT OLD.verification_state
  OR NEW.content_sha256 IS NOT OLD.content_sha256
  OR NEW.conflict IS NOT OLD.conflict OR NEW.abstain_reason IS NOT OLD.abstain_reason
BEGIN SELECT RAISE(ABORT, 'parol: finding content is immutable'); END;

CREATE TRIGGER findings_validity_forward BEFORE UPDATE ON findings
WHEN (OLD.validity = 'stale'
      AND (NEW.validity IS NOT 'stale' OR NEW.stale_reason IS NOT OLD.stale_reason))
  OR (NEW.validity = 'stale' AND (NEW.stale_reason IS NULL OR trim(NEW.stale_reason) = ''))
  OR (NEW.validity = 'current' AND NEW.stale_reason IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'parol: a stale finding stays stale, and says why'); END;

CREATE TRIGGER finding_evidence_no_replace BEFORE INSERT ON finding_evidence
WHEN NEW.id IS NULL OR EXISTS (SELECT 1 FROM finding_evidence WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'parol: finding evidence is never replaced'); END;

-- Evidence may only cite a span of the same matter that belongs to a document version in the
-- run's manifest. The manifest is the whole corpus a run may see.
CREATE TRIGGER finding_evidence_in_manifest BEFORE INSERT ON finding_evidence
WHEN NOT EXISTS (
  SELECT 1
  FROM findings f
  JOIN runs r ON r.id = f.run_id
  JOIN source_spans s ON s.id = NEW.span_id AND s.matter_id = f.matter_id
  JOIN json_each(r.input_manifest_json, '$.documents') d
    ON json_extract(d.value, '$.documentVersionId') = s.document_version_id
  WHERE f.id = NEW.finding_id)
BEGIN SELECT RAISE(ABORT, 'parol: evidence must cite a span in the run manifest'); END;

CREATE TRIGGER finding_evidence_immutable BEFORE UPDATE ON finding_evidence
BEGIN SELECT RAISE(ABORT, 'parol: finding evidence is immutable'); END;

CREATE TRIGGER verification_results_no_replace BEFORE INSERT ON verification_results
WHEN EXISTS (
  SELECT 1 FROM verification_results WHERE finding_id = NEW.finding_id AND check_id = NEW.check_id)
BEGIN SELECT RAISE(ABORT, 'parol: verification results are never replaced'); END;

CREATE TRIGGER verification_results_immutable BEFORE UPDATE ON verification_results
BEGIN SELECT RAISE(ABORT, 'parol: verification results are immutable'); END;

-- Reviews: immutable except that a current review can become stale. ----------------------------
CREATE TRIGGER reviews_no_replace BEFORE INSERT ON reviews
WHEN NEW.id IS NULL OR EXISTS (SELECT 1 FROM reviews WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'parol: reviews are never replaced'); END;

CREATE TRIGGER reviews_same_matter BEFORE INSERT ON reviews
WHEN NOT EXISTS (SELECT 1 FROM findings WHERE id = NEW.finding_id AND matter_id = NEW.matter_id)
  OR (NEW.supersedes_review_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM reviews WHERE id = NEW.supersedes_review_id AND finding_id = NEW.finding_id))
BEGIN SELECT RAISE(ABORT, 'parol: review must belong to the matter of its finding'); END;

CREATE TRIGGER reviews_start_current BEFORE INSERT ON reviews
WHEN NEW.validity IS NOT 'current'
BEGIN SELECT RAISE(ABORT, 'parol: a review is created current'); END;

CREATE TRIGGER reviews_content_immutable BEFORE UPDATE ON reviews
WHEN NEW.id IS NOT OLD.id OR NEW.finding_id IS NOT OLD.finding_id
  OR NEW.matter_id IS NOT OLD.matter_id OR NEW.reviewer_id IS NOT OLD.reviewer_id
  OR NEW.decision IS NOT OLD.decision OR NEW.edited_json IS NOT OLD.edited_json
  OR NEW.reason IS NOT OLD.reason
  OR NEW.finding_content_sha256 IS NOT OLD.finding_content_sha256
  OR NEW.supersedes_review_id IS NOT OLD.supersedes_review_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'parol: reviews are immutable except for validity'); END;

CREATE TRIGGER reviews_validity_forward BEFORE UPDATE ON reviews
WHEN OLD.validity = 'stale' AND NEW.validity IS NOT 'stale'
BEGIN SELECT RAISE(ABORT, 'parol: a stale review stays stale'); END;

-- Memos ---------------------------------------------------------------------------------------
CREATE TRIGGER memos_no_replace BEFORE INSERT ON memos
WHEN NEW.id IS NULL OR EXISTS (SELECT 1 FROM memos WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'parol: memos are never replaced'); END;

CREATE TRIGGER memos_same_matter BEFORE INSERT ON memos
WHEN NOT EXISTS (SELECT 1 FROM runs WHERE id = NEW.run_id AND matter_id = NEW.matter_id)
  OR substr(NEW.storage_path, 1, length(NEW.matter_id) + 1) IS NOT NEW.matter_id || '/'
BEGIN SELECT RAISE(ABORT, 'parol: memo must belong to the matter of its run and sit in its folder'); END;

CREATE TRIGGER memos_immutable BEFORE UPDATE ON memos
WHEN NEW.id IS NOT OLD.id OR NEW.matter_id IS NOT OLD.matter_id OR NEW.run_id IS NOT OLD.run_id
  OR NEW.review_ids_json IS NOT OLD.review_ids_json OR NEW.file_sha256 IS NOT OLD.file_sha256
  OR NEW.storage_path IS NOT OLD.storage_path OR NEW.exported_by IS NOT OLD.exported_by
  OR NEW.exported_at IS NOT OLD.exported_at
  OR (OLD.status = 'superseded' AND NEW.status IS NOT 'superseded')
BEGIN SELECT RAISE(ABORT, 'parol: memos are immutable except for being superseded'); END;

-- Feedback and evaluation ----------------------------------------------------------------------
CREATE TRIGGER feedback_same_matter BEFORE INSERT ON feedback
WHEN (NEW.run_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM runs WHERE id = NEW.run_id AND matter_id = NEW.matter_id))
  OR (NEW.finding_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM findings WHERE id = NEW.finding_id AND matter_id = NEW.matter_id))
BEGIN SELECT RAISE(ABORT, 'parol: feedback must refer to its own matter'); END;

-- Evaluation results are for synthetic matters only (docs/parol/06).
CREATE TRIGGER eval_slot_results_synthetic_only BEFORE INSERT ON eval_slot_results
WHEN NOT EXISTS (
  SELECT 1 FROM runs r JOIN matters m ON m.id = r.matter_id
  WHERE r.id = NEW.run_id AND m.synthetic = 1)
BEGIN SELECT RAISE(ABORT, 'parol: evaluation results come from synthetic matters only'); END;
