-- Parol schema, version 6: feedback capture (reason code, minor-edit mark, missed issue, rating, notes).
--
-- Additive to 001 to 005, so their checksums stay valid, apart from one trigger that is dropped and
-- created again under the same name, because SQLite cannot alter a trigger. The file is one
-- migration with one part for each slice of the package; each part is complete on its own and the
-- part of a later slice is written below the part of the one before it.
--
-- Part 1 (slice A, reason code and minor edit): a decision carries why it was an edit or a reject,
-- and whether an edit was minor. The code and the mark are columns of the decision row and not rows
-- of `feedback`, so that a decision, its code and its mark are committed together, are bound to the
-- same finding content hash (`finding_content_sha256`), go stale together, and can be required by
-- the database and not only by the application.
--
-- Part 2 (slice B, missed issue, with the guards of the other kinds): a missed issue names the rule
-- of its run's playbook that should have applied, and says where, in two new columns of `feedback`.
-- The same part gives every kind of feedback its shape, makes a rating one per person and matter,
-- and makes the table append-only. The rating and the note are written by the slices that follow,
-- but their shape is held here with the others, so the table never has a window in which a kind can
-- be written in a shape that no slice means.

-- 1. Decisions -------------------------------------------------------------------------------------
-- NULL means: not an edit or a reject (a code), not an edit (a mark), or a decision made before this
-- migration. The shape trigger below holds on insert only, so decisions made before it keep NULL.
ALTER TABLE reviews ADD COLUMN reason_code TEXT
  CHECK (reason_code IS NULL OR reason_code IN
    ('wrong_status','wrong_evidence','missed_context','bad_fallback','unclear','other'));
ALTER TABLE reviews ADD COLUMN minor_edit INTEGER
  CHECK (minor_edit IS NULL OR minor_edit IN (0, 1));

-- A new decision records a code exactly when it is an edit or a reject, and a minor-edit mark
-- exactly when it is an edit.
CREATE TRIGGER reviews_feedback_shape BEFORE INSERT ON reviews
WHEN (NEW.decision IN ('edit','reject')) <> (NEW.reason_code IS NOT NULL)
  OR (NEW.decision = 'edit') <> (NEW.minor_edit IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'parol: an edit or reject carries a reason code, and an edit a minor-edit mark'); END;

-- A change of status is never a minor edit.
CREATE TRIGGER reviews_minor_edit_not_status BEFORE INSERT ON reviews
WHEN NEW.minor_edit = 1 AND json_extract(NEW.edited_json, '$.status') IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'parol: an edit that changes the status is not a minor edit'); END;

-- The two new columns are as immutable as the others. The trigger of 002 is replaced under the same
-- name and is otherwise that trigger, word for word.
DROP TRIGGER reviews_content_immutable;
CREATE TRIGGER reviews_content_immutable BEFORE UPDATE ON reviews
WHEN NEW.id IS NOT OLD.id OR NEW.finding_id IS NOT OLD.finding_id
  OR NEW.matter_id IS NOT OLD.matter_id OR NEW.reviewer_id IS NOT OLD.reviewer_id
  OR NEW.decision IS NOT OLD.decision OR NEW.edited_json IS NOT OLD.edited_json
  OR NEW.reason IS NOT OLD.reason
  OR NEW.reason_code IS NOT OLD.reason_code OR NEW.minor_edit IS NOT OLD.minor_edit
  OR NEW.finding_content_sha256 IS NOT OLD.finding_content_sha256
  OR NEW.supersedes_review_id IS NOT OLD.supersedes_review_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'parol: reviews are immutable except for validity'); END;

-- 2. Feedback --------------------------------------------------------------------------------------
-- `rule_key` is NULL for a missed issue reported as "not covered by any rule"; the application never
-- lets a person leave the choice blank, so a NULL is a choice and not an omission. `location` is
-- free text typed by a person, and is as sensitive as `text`: it goes with the matter.
ALTER TABLE feedback ADD COLUMN rule_key TEXT
  CHECK (rule_key IS NULL OR length(rule_key) BETWEEN 1 AND 64);
ALTER TABLE feedback ADD COLUMN location TEXT
  CHECK (location IS NULL OR length(location) BETWEEN 1 AND 200);

-- One rating per person per matter.
CREATE UNIQUE INDEX feedback_one_rating_per_user ON feedback (matter_id, user_id) WHERE kind = 'rating';
-- The child sides of the two foreign keys, so that deleting a run or a finding does not scan the
-- table (as 002 does for the others).
CREATE INDEX feedback_by_run ON feedback (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX feedback_by_finding ON feedback (finding_id) WHERE finding_id IS NOT NULL;

-- The shape of each kind. `finding_reason` (reserved, unused by the application) and `comment` (the
-- note on a finding, and the comments the store tests make) keep the shape they had, apart from the
-- fields that belong to other kinds. A missed issue needs a run, text, and a rule that belongs to
-- the playbook of that run, or no rule at all.
CREATE TRIGGER feedback_shape BEFORE INSERT ON feedback
WHEN (NEW.text IS NOT NULL AND length(NEW.text) > 4000)
  OR (NEW.kind <> 'missed_issue' AND (NEW.rule_key IS NOT NULL OR NEW.location IS NOT NULL))
  OR (NEW.kind <> 'rating' AND NEW.rating IS NOT NULL)
  OR (NEW.kind = 'rating'
      AND (NEW.rating IS NULL OR NEW.finding_id IS NOT NULL OR NEW.reason_code IS NOT NULL))
  OR (NEW.kind = 'missed_issue'
      AND (NEW.run_id IS NULL OR NEW.finding_id IS NOT NULL OR NEW.reason_code IS NOT NULL
           OR NEW.text IS NULL OR trim(NEW.text) = ''))
  OR (NEW.kind = 'missed_issue' AND NEW.rule_key IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM runs r JOIN playbook_rules p ON p.playbook_version_id = r.playbook_version_id
        WHERE r.id = NEW.run_id AND p.rule_key = NEW.rule_key))
BEGIN SELECT RAISE(ABORT, 'parol: feedback does not have the shape of its kind'); END;

-- Feedback is written once. Deleting a matter removes its rows with DELETE, which these two do not
-- touch.
CREATE TRIGGER feedback_immutable BEFORE UPDATE ON feedback
BEGIN SELECT RAISE(ABORT, 'parol: feedback is never edited'); END;
CREATE TRIGGER feedback_no_replace BEFORE INSERT ON feedback
WHEN NEW.id IS NULL OR EXISTS (SELECT 1 FROM feedback WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'parol: feedback is never replaced'); END;
