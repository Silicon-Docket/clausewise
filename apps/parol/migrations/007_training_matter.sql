-- Parol schema, version 7: the training matter.
--
-- Additive to the migrations before it; their checksums stay valid. No table is created or rebuilt.
--
-- A matter made for the training exercise carries a key. The key is set when the matter is created,
-- never changes, is held by one matter per creator, and belongs to a synthetic matter only. A
-- training matter is never used in evaluation: no evaluation run is made on it and no result is
-- stored for it. Every matter that exists before this migration has no key.
--
-- Messages start with "parol:" so that the store can tell a trigger from other constraint errors.

ALTER TABLE matters ADD COLUMN training_key TEXT
  CHECK (training_key IS NULL OR training_key GLOB 'T[0-9][0-9]');

-- At most one training matter of a given key per creator. Deleting the matter removes the row and
-- frees the key, so starting again is deleting and starting. An ordinary matter has no key and the
-- partial index leaves it alone.
CREATE UNIQUE INDEX matters_one_training_key_per_creator ON matters (created_by, training_key)
  WHERE training_key IS NOT NULL;

-- The key is a fact about how the matter was made. It is not edited, and it is not cleared to take
-- the matter out of a measure that excludes training matters. (matters_identity_immutable, in
-- migration 2, is not edited: the new rule is a trigger of its own.)
CREATE TRIGGER matters_training_key_immutable BEFORE UPDATE OF training_key ON matters
WHEN NEW.training_key IS NOT OLD.training_key
BEGIN SELECT RAISE(ABORT, 'parol: the training key of a matter is set when it is created and never changes'); END;

CREATE TRIGGER matters_training_is_synthetic BEFORE INSERT ON matters
WHEN NEW.training_key IS NOT NULL AND NEW.synthetic IS NOT 1
BEGIN SELECT RAISE(ABORT, 'parol: a training matter is synthetic'); END;

-- Evaluation never touches a training matter: no run for evaluation is made on one, and no result
-- of an evaluation run is stored for one.
CREATE TRIGGER runs_not_eval_on_training BEFORE INSERT ON runs
WHEN NEW.purpose = 'eval' AND EXISTS (
  SELECT 1 FROM matters WHERE id = NEW.matter_id AND training_key IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'parol: training matters are never used in evaluation'); END;

CREATE TRIGGER eval_slot_results_not_training BEFORE INSERT ON eval_slot_results
WHEN EXISTS (
  SELECT 1 FROM runs r JOIN matters m ON m.id = r.matter_id
  WHERE r.id = NEW.run_id AND m.training_key IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'parol: training matters are never used in evaluation'); END;
