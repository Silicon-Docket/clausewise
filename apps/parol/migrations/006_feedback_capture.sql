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
