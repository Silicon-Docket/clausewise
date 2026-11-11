-- Parol schema, version 4: usage recorded by the application, the spend ledger, settled statuses.
--
-- Additive to 001 to 003, so their checksums stay valid, apart from one trigger that is dropped
-- and created again under the same name, because SQLite cannot alter a trigger. The file is one
-- migration with one part for each of three pieces of work; each part is complete on its own.
--
-- Part 1 (settled statuses). The verify stage settles the model's status against the rule's
-- flags (apps/parol/src/settlement.ts): a missing clause on a rule that is not required is not
-- applicable, and a required rule that no clause covers is missing. The status the model stated
-- is kept next to the settled one, so a reviewer can see that code changed it, and it is part of
-- the finding's content hash whenever it is set.
--
-- Part 2 (usage on a call). The application records, for every model call, the token counts the
-- provider reported and an estimated cost, and for every run the model(s) the provider named. The
-- columns exist since 001 and nothing wrote them; these triggers say what a written row may hold
-- (counts and a hash, never text) and that a recorded call is never edited.
--
-- Part 3 (the spend ledger). The application's spend guard keeps the day's total in a table of its
-- own, so that deleting a matter, which deletes its model calls, cannot lower a limit that was
-- reached. It holds a date and numbers and nothing that names a matter, a run, a person or text.

-- 1. The model's own status, kept when code settled it to another one.
--    NULL means the status is the one the model stated (or that no status was stated). It is never
--    backfilled: no finding stored before this migration was settled.
ALTER TABLE findings ADD COLUMN model_status TEXT
  CHECK (model_status IS NULL
         OR model_status IN ('compliant','deviation','missing','not_applicable'));

-- A model status is kept only when code changed the status, so it is never equal to the status.
-- (A forcing escalation that turns a settled status into undetermined leaves it different too.)
CREATE TRIGGER findings_model_status_differs BEFORE INSERT ON findings
WHEN NEW.model_status IS NOT NULL AND NEW.model_status = NEW.status
BEGIN SELECT RAISE(ABORT, 'parol: a model status is kept only when code changed the status'); END;

-- The content trigger of 002 lists every immutable column; model_status joins it. It is replaced
-- under the same name and is otherwise the trigger of 002, word for word.
DROP TRIGGER findings_content_immutable;
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
  OR NEW.model_status IS NOT OLD.model_status
BEGIN SELECT RAISE(ABORT, 'parol: finding content is immutable'); END;

-- 2. Usage on a call: all four counts or none, never negative; a cost needs tokens and a price table.
CREATE TRIGGER model_calls_usage_shape BEFORE INSERT ON model_calls
WHEN ((NEW.input_tokens IS NULL) + (NEW.output_tokens IS NULL)
      + (NEW.cache_read_tokens IS NULL) + (NEW.cache_write_tokens IS NULL)) NOT IN (0, 4)
  OR COALESCE(NEW.input_tokens, 0) < 0 OR COALESCE(NEW.output_tokens, 0) < 0
  OR COALESCE(NEW.cache_read_tokens, 0) < 0 OR COALESCE(NEW.cache_write_tokens, 0) < 0
  OR (NEW.cost_usd_estimate IS NOT NULL
      AND (NEW.input_tokens IS NULL OR NEW.cost_usd_estimate < 0
           OR NEW.price_table_sha256 IS NULL OR length(NEW.price_table_sha256) <> 64))
  OR (NEW.cost_usd_estimate IS NULL AND NEW.price_table_sha256 IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'parol: call usage is all reported or all absent, and a cost needs tokens and a price table'); END;

CREATE TRIGGER model_calls_immutable BEFORE UPDATE ON model_calls
BEGIN SELECT RAISE(ABORT, 'parol: model calls are never edited'); END;

-- The model(s) the provider named: plain printable text, one line, at most 300 characters.
CREATE TRIGGER runs_model_reported_shape BEFORE UPDATE OF model_reported ON runs
WHEN NEW.model_reported IS NOT NULL
 AND (length(NEW.model_reported) > 300 OR NEW.model_reported GLOB '*[^ -~]*')
BEGIN SELECT RAISE(ABORT, 'parol: a reported model is plain text of at most 300 characters'); END;

-- 4. The day's spend, kept apart from matter data so that deleting a matter cannot lower it.
--    One row per UTC day. It holds counts and a total and nothing that names a matter, a run or a
--    person. The retention job and the deletion of a matter leave it alone, on purpose.
CREATE TABLE spend_ledger (
  day                 TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  responses           INTEGER NOT NULL DEFAULT 0 CHECK (responses >= 0),
  input_tokens        INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens       INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  cost_usd            REAL    NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  unpriced_responses  INTEGER NOT NULL DEFAULT 0 CHECK (unpriced_responses >= 0),
  updated_at          TEXT    NOT NULL
);

CREATE TRIGGER spend_ledger_only_grows BEFORE UPDATE ON spend_ledger
WHEN NEW.day IS NOT OLD.day OR NEW.responses < OLD.responses
  OR NEW.input_tokens < OLD.input_tokens OR NEW.output_tokens < OLD.output_tokens
  OR NEW.cache_read_tokens < OLD.cache_read_tokens OR NEW.cache_write_tokens < OLD.cache_write_tokens
  OR NEW.cost_usd < OLD.cost_usd OR NEW.unpriced_responses < OLD.unpriced_responses
BEGIN SELECT RAISE(ABORT, 'parol: the spend ledger only grows'); END;

CREATE TRIGGER spend_ledger_never_emptied BEFORE DELETE ON spend_ledger
BEGIN SELECT RAISE(ABORT, 'parol: the spend ledger is never emptied'); END;
