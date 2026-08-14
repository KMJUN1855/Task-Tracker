-- Task Tracker schema.
-- SQLite / libSQL compatible: identical DDL runs on Turso (Phase A) and on a
-- local .db file (Phase B). All timestamps are ISO-8601 UTC strings
-- ("2026-08-14T09:30:00.000Z") so they sort lexicographically and never carry
-- a timezone; conversion to local time happens at display time only.
-- All durations are stored in whole seconds.

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  hue         INTEGER NOT NULL,               -- fixed hue 0-359 for this category
  is_exercise INTEGER NOT NULL DEFAULT 0,     -- 1 = drives the special Exercise page
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT                            -- NULL = active
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL,             -- UTC
  due_date      TEXT,                         -- UTC, nullable
  expected_time INTEGER,                      -- seconds, estimated duration
  max_time      INTEGER,                      -- seconds, maximum allowed duration
  status        TEXT    NOT NULL DEFAULT 'upcoming'
                CHECK (status IN ('upcoming', 'in_progress', 'paused', 'finished')),
  finish_note   TEXT,                         -- what was done / how / special reason
  finished_at   TEXT                          -- UTC completion timestamp
);

CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due      ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category_id);

-- One row per start/stop interval. Elapsed time is ALWAYS recomputed from these
-- absolute timestamps - no accumulated counter is ever stored anywhere.
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  start_time TEXT    NOT NULL,                -- UTC
  end_time   TEXT                             -- UTC, NULL = currently running
);

CREATE INDEX IF NOT EXISTS idx_sessions_task  ON sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start_time);

-- A task may have many sessions, but at most one open (running) session.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_single_open
  ON sessions(task_id) WHERE end_time IS NULL;

-- Exercise detail. A workout is an ordinary task in the Exercise category; its
-- session is the "Total time", and each set hangs off that session so the
-- generic elapsed-time rules keep working untouched.
--
-- Rest after a set is NOT stored: it is the gap to the next set's start (or to
-- the end of the session for the last set), so it is derived on read like every
-- other duration in this schema. Storing it would drift the moment a timestamp
-- was corrected.
-- Deliberately no inline comments inside this CREATE TABLE. SQLite's DROP
-- COLUMN rewrites the stored DDL text by excising the column's tokens, and a
-- trailing `--` comment on the last column leaves a dangling comma behind,
-- reported as "incomplete input". Column notes live here instead:
--   start_time / end_time : UTC; end_time NULL = the set is running
--   type_name             : which exercise this set belongs to ("Squat"),
--                           NULL = untyped. Carried forward from the previous
--                           set unless the user starts a new type.
CREATE TABLE IF NOT EXISTS exercise_sets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  set_index  INTEGER NOT NULL,
  start_time TEXT    NOT NULL,
  end_time   TEXT,
  type_name  TEXT
);

CREATE INDEX IF NOT EXISTS idx_exercise_sets_session ON exercise_sets(session_id);
