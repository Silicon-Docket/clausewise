-- Parol schema, version 3: upload warnings.
--
-- What ingest and the upload service tell a person about a document version: text that reads like
-- an instruction, content the review never shows the model, a file with no reviewable text, and a
-- re-saved file whose text matches an earlier version. They belong to a version and are shown with
-- the matter, so they are stored. Additive to 001 and 002, so their checksums stay valid.
--
-- A detail holds ids, counts and pattern names and never document text. The length limit is a
-- backstop for that rule: a pasted clause would not fit.

CREATE TABLE ingest_warnings (
  seq                  INTEGER PRIMARY KEY AUTOINCREMENT,
  matter_id            TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  document_version_id  TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  span_id              TEXT REFERENCES source_spans(id) ON DELETE CASCADE,
  code                 TEXT NOT NULL CHECK (code IN
                         ('instruction_like_text','duplicate_document','near_duplicate_version',
                          'unreviewed_content','no_reviewable_text')),
  detail               TEXT NOT NULL CHECK (length(detail) <= 300),
  created_at           TEXT NOT NULL
);

CREATE INDEX ingest_warnings_by_matter ON ingest_warnings (matter_id, document_version_id);

-- A warning about a version sits inside the version's own matter, as every other row does.
CREATE TRIGGER ingest_warnings_same_matter BEFORE INSERT ON ingest_warnings
WHEN NOT EXISTS (
  SELECT 1 FROM document_versions v
  WHERE v.id = NEW.document_version_id AND v.matter_id = NEW.matter_id)
BEGIN SELECT RAISE(ABORT, 'parol: a warning must belong to a version of its own matter'); END;

CREATE TRIGGER ingest_warnings_immutable BEFORE UPDATE ON ingest_warnings
BEGIN SELECT RAISE(ABORT, 'parol: warnings are replaced, never edited'); END;
