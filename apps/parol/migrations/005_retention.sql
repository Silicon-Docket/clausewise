-- Parol schema, version 5: retention.
--
-- Additive to the migrations before it; their checksums stay valid. No table is created or rebuilt.
--
-- The retention command finds the matters to delete by comparing retain_until with the clock as
-- text. That is only right when the text has the one shape that sorts like time, the shape that
-- Date.toISOString() writes. A value in another shape (a date alone, an offset) would sort wrongly
-- and a matter would be deleted early or kept for good. A matter is also never made already expired.
--
-- The ceiling on how many days a matter may be kept is not here: a second copy of the number in the
-- database would drift from the one in the code (MAX_RETAIN_DAYS), which the form, the schema and
-- the store all read.
--
-- Messages start with "parol:" so that the store can tell a trigger from other constraint errors.

CREATE INDEX matters_by_retain_until ON matters (retain_until, id);

CREATE TRIGGER matters_retention_date_insert BEFORE INSERT ON matters
WHEN NEW.retain_until NOT GLOB
       '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  OR julianday(NEW.retain_until) IS NULL
  OR julianday(NEW.created_at) IS NULL
  OR julianday(NEW.retain_until) <= julianday(NEW.created_at)
BEGIN SELECT RAISE(ABORT, 'parol: a retention date is an ISO time after the matter was created'); END;

CREATE TRIGGER matters_retention_date_update BEFORE UPDATE OF retain_until ON matters
WHEN NEW.retain_until NOT GLOB
       '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  OR julianday(NEW.retain_until) IS NULL
  OR julianday(NEW.retain_until) <= julianday(OLD.created_at)
BEGIN SELECT RAISE(ABORT, 'parol: a retention date is an ISO time after the matter was created'); END;
