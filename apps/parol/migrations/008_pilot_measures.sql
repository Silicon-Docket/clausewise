-- Parol schema, version 8: the pilot measures (package W2.6b).
--
-- Additive to 001 to 007, so their checksums stay valid. Four small tables and nothing rebuilt.
--
-- The measures themselves are computed from rows that already exist (runs, findings, decisions, memos,
-- feedback) and from the four tables below, which hold what those rows cannot say:
--
--   pilot_calendar      the start date of the pilot, so that a record falls in a week (append-only);
--   pilot_participants  the people the trainer says were trained (the denominator of repeat usage);
--   time_entries        the timers: a person presses Start and Stop, and the server's clock writes both;
--   reference_issues    the shadow-mode reference list: the issues a reviewing attorney found by hand
--                       before Parol read the matter. It is closed once a review has started.
--
-- None of the four holds text. A timer is two timestamps and a role; a reference issue is a rule key
-- of the matter's playbook (or none) and a severity; the calendar is a date; the roster is a list of
-- user ids. So nothing here needs the secure-delete handling that columns of text do, and the audit
-- events for them (time.start, time.stop, reference.save, pilot.calendar, pilot.participants) carry
-- ids, codes and counts only.
--
-- Messages start with "parol:" so that the store can tell a trigger from other constraint errors.
--
-- INSERT OR REPLACE deletes the row that holds a key and then inserts, with no UPDATE and no DELETE
-- trigger to see it. So the insert guard of every table below names every key its table can collide
-- on, and not only its id: the sequence number of the calendar; the user of the roster; the id and
-- the one open timer of a person for the timers; the id, the place in the list and the rule for the
-- reference issues. Each guard runs before the key's own index, which stays as the second line.

-- The pilot calendar: append-only, the newest row is in force. -------------------------------------
-- The CHECK fixes the shape of the date. That it is a real date is checked in code, because SQL has
-- no date type.
CREATE TABLE pilot_calendar (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  start_date  TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  set_by      TEXT NOT NULL REFERENCES users(id),
  set_at      TEXT NOT NULL
);
CREATE TRIGGER pilot_calendar_no_update BEFORE UPDATE ON pilot_calendar
BEGIN SELECT RAISE(ABORT, 'parol: the pilot calendar is append-only'); END;
CREATE TRIGGER pilot_calendar_no_delete BEFORE DELETE ON pilot_calendar
BEGIN SELECT RAISE(ABORT, 'parol: the pilot calendar is append-only'); END;
-- INSERT OR REPLACE with the number of an existing row would delete that row without a delete trigger.
-- The sequence number is the only key of this table.
CREATE TRIGGER pilot_calendar_no_replace BEFORE INSERT ON pilot_calendar
WHEN NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM pilot_calendar WHERE seq = NEW.seq)
BEGIN SELECT RAISE(ABORT, 'parol: the pilot calendar is append-only'); END;

-- The people the trainer says were trained. Not matter data: deleting a matter does not touch it. --
CREATE TABLE pilot_participants (
  user_id      TEXT PRIMARY KEY REFERENCES users(id),
  recorded_by  TEXT NOT NULL REFERENCES users(id),
  recorded_at  TEXT NOT NULL
);
-- A person is on the roster once. The roster is replaced by deleting the people who were taken off
-- and adding the ones who were put on, never by writing a person again, which would overwrite who
-- recorded them and when. The user is the only key of this table.
CREATE TRIGGER pilot_participants_no_replace BEFORE INSERT ON pilot_participants
WHEN NEW.user_id IS NULL OR EXISTS (SELECT 1 FROM pilot_participants WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'parol: a roster entry is never replaced'); END;

-- Timers. The server's clock writes both ends; a stopped entry is final. ---------------------------
CREATE TABLE time_entries (
  id          TEXT PRIMARY KEY,
  matter_id   TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL CHECK (role IN ('associate','reviewer')),
  started_at  TEXT NOT NULL,
  stopped_at  TEXT,
  CHECK (stopped_at IS NULL OR stopped_at >= started_at)
);
-- A person times one thing at a time.
CREATE UNIQUE INDEX time_entries_one_open_per_user ON time_entries (user_id) WHERE stopped_at IS NULL;
CREATE INDEX time_entries_by_matter ON time_entries (matter_id, started_at);

-- Two keys: the id, and the one open timer of a person (the index above). A replace over the second
-- would delete the timer that is running, under a new id, and call it a start.
CREATE TRIGGER time_entries_no_replace BEFORE INSERT ON time_entries
WHEN NEW.id IS NULL OR EXISTS (SELECT 1 FROM time_entries WHERE id = NEW.id)
  OR (NEW.stopped_at IS NULL
      AND EXISTS (SELECT 1 FROM time_entries WHERE user_id = NEW.user_id AND stopped_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'parol: time entries are never replaced'); END;
CREATE TRIGGER time_entries_member BEFORE INSERT ON time_entries
WHEN NOT EXISTS (SELECT 1 FROM matter_members
                 WHERE matter_id = NEW.matter_id AND user_id = NEW.user_id AND role = NEW.role)
BEGIN SELECT RAISE(ABORT, 'parol: a time entry belongs to a member of the matter in the role held'); END;
CREATE TRIGGER time_entries_start_open BEFORE INSERT ON time_entries
WHEN NEW.stopped_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'parol: a timer starts open'); END;
-- The only change an entry takes is its stop, once.
CREATE TRIGGER time_entries_stop_once BEFORE UPDATE ON time_entries
WHEN NEW.id IS NOT OLD.id OR NEW.matter_id IS NOT OLD.matter_id OR NEW.user_id IS NOT OLD.user_id
  OR NEW.role IS NOT OLD.role OR NEW.started_at IS NOT OLD.started_at
  OR OLD.stopped_at IS NOT NULL OR NEW.stopped_at IS NULL
BEGIN SELECT RAISE(ABORT, 'parol: a time entry can only be stopped, once'); END;

-- The shadow-mode reference list. A row is a rule slot, or an issue no rule covers (NULL rule key). --
CREATE TABLE reference_issues (
  id           TEXT PRIMARY KEY,
  matter_id    TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  rule_key     TEXT CHECK (rule_key IS NULL OR length(rule_key) BETWEEN 1 AND 64),
  severity     TEXT NOT NULL CHECK (severity IN ('high','medium','low')),
  ordinal      INTEGER NOT NULL CHECK (ordinal >= 0),
  recorded_by  TEXT NOT NULL REFERENCES users(id),
  recorded_at  TEXT NOT NULL,
  UNIQUE (matter_id, ordinal)
);
-- At most one issue per rule in a matter.
CREATE UNIQUE INDEX reference_issues_one_per_rule ON reference_issues (matter_id, rule_key)
  WHERE rule_key IS NOT NULL;
CREATE INDEX reference_issues_by_matter ON reference_issues (matter_id);

-- Three keys: the id, the place in the list of a matter, and the rule of a matter (the index above).
CREATE TRIGGER reference_issues_no_replace BEFORE INSERT ON reference_issues
WHEN NEW.id IS NULL OR EXISTS (SELECT 1 FROM reference_issues WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM reference_issues WHERE matter_id = NEW.matter_id AND ordinal = NEW.ordinal)
  OR (NEW.rule_key IS NOT NULL
      AND EXISTS (SELECT 1 FROM reference_issues WHERE matter_id = NEW.matter_id AND rule_key = NEW.rule_key))
BEGIN SELECT RAISE(ABORT, 'parol: reference issues are never replaced'); END;
CREATE TRIGGER reference_issues_reviewer BEFORE INSERT ON reference_issues
WHEN NOT EXISTS (SELECT 1 FROM matter_members
                 WHERE matter_id = NEW.matter_id AND user_id = NEW.recorded_by AND role = 'reviewer')
BEGIN SELECT RAISE(ABORT, 'parol: a reference list is recorded by a reviewer of the matter'); END;
-- The list is recorded before Parol has read the matter, so it cannot be fitted to Parol's answer.
-- Deleting a matter deletes its runs before its reference issues, so this does not stand in its way.
CREATE TRIGGER reference_issues_closed_insert BEFORE INSERT ON reference_issues
WHEN EXISTS (SELECT 1 FROM runs WHERE matter_id = NEW.matter_id AND purpose = 'matter')
BEGIN SELECT RAISE(ABORT, 'parol: a reference list is closed once a review has started'); END;
CREATE TRIGGER reference_issues_closed_delete BEFORE DELETE ON reference_issues
WHEN EXISTS (SELECT 1 FROM runs WHERE matter_id = OLD.matter_id AND purpose = 'matter')
BEGIN SELECT RAISE(ABORT, 'parol: a reference list is closed once a review has started'); END;
CREATE TRIGGER reference_issues_immutable BEFORE UPDATE ON reference_issues
BEGIN SELECT RAISE(ABORT, 'parol: reference issues are replaced, never edited'); END;
